import { getRun, invoke } from "@flue/runtime";
import { createSlackChannel } from "@flue/slack";
import { WebClient } from "@slack/web-api";
import hnSummary from "../workflows/hn-summary.js";

export const client = new WebClient(process.env.SLACK_BOT_TOKEN);

export const channel = createSlackChannel({
  signingSecret: process.env.SLACK_SIGNING_SECRET!,

  async events({ c, payload }) {
    if (payload.type !== "event_callback") {
      return;
    }

    if (payload.event.type !== "app_mention") {
      return;
    }

    const event = payload.event;
    const task = handleAppMention({
      text: event.text,
      channelId: event.channel,
      threadTs: event.thread_ts ?? event.ts
    });

    const executionCtx = c.executionCtx;
    if (executionCtx) {
      executionCtx.waitUntil(task);
      return;
    }

    await task;
  }
});

async function handleAppMention(input: { text: string; channelId: string; threadTs: string }) {
  await client.chat.postMessage({
    channel: input.channelId,
    thread_ts: input.threadTs,
    text: "Looking up Hacker News stories..."
  });

  try {
    const { runId } = await invoke(hnSummary, {
      input: {
        text: input.text
      }
    });
    const result = await waitForWorkflowResult(runId);

    await client.chat.postMessage({
      channel: input.channelId,
      thread_ts: input.threadTs,
      text: slackTextFromResult(result)
    });
  } catch (error) {
    await client.chat.postMessage({
      channel: input.channelId,
      thread_ts: input.threadTs,
      text: `I could not summarize that topic: ${error instanceof Error ? error.message : String(error)}`
    });
  }
}

async function waitForWorkflowResult(runId: string) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const run = await getRun(runId);
    if (run?.status === "completed") {
      return run.result;
    }

    if (run?.status === "errored") {
      throw new Error(formatRunError(run.error));
    }

    await sleep(500);
  }

  throw new Error(`Workflow ${runId} did not finish before the Slack reply timeout.`);
}

function slackTextFromResult(result: unknown) {
  if (!isSummaryResult(result)) {
    return "The summary workflow finished, but returned an unexpected result.";
  }

  const topLinks = result.topStories
    .slice(0, 3)
    .map((story, index) => `${index + 1}. <${story.url}|${escapeSlackText(story.title)}>`)
    .join("\n");

  return [
    `*HN summary: ${escapeSlackText(result.topic)}*`,
    `${result.storyCount} ${result.storyCount === 1 ? "story" : "stories"} from the last ${formatLookback(result.lookbackHours)}`,
    "",
    result.summary,
    topLinks ? `\n*Top links*\n${topLinks}` : ""
  ].join("\n");
}

function isSummaryResult(value: unknown): value is {
  topic: string;
  lookbackHours: number;
  storyCount: number;
  summary: string;
  topStories: Array<{ title: string; url: string }>;
} {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.topic === "string" &&
    typeof record.lookbackHours === "number" &&
    typeof record.storyCount === "number" &&
    typeof record.summary === "string" &&
    Array.isArray(record.topStories)
  );
}

function formatRunError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return JSON.stringify(error);
}

function formatLookback(hours: number) {
  if (hours % (24 * 7) === 0) {
    const weeks = hours / (24 * 7);
    return `${weeks} ${weeks === 1 ? "week" : "weeks"}`;
  }

  if (hours % 24 === 0) {
    const days = hours / 24;
    return `${days} ${days === 1 ? "day" : "days"}`;
  }

  return `${hours} ${hours === 1 ? "hour" : "hours"}`;
}

function escapeSlackText(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
