import { defineAgent, defineWorkflow, type WorkflowRouteHandler } from "@flue/runtime";
import * as v from "valibot";
import { fetchHackerNewsStories, formatLookback, parseRequestLocally } from "../hn.js";

const inputSchema = v.object({
  text: v.optional(v.string()),
  topic: v.optional(v.string()),
  lookbackHours: v.optional(v.number())
});

const storySchema = v.object({
  title: v.string(),
  url: v.string(),
  hnUrl: v.string(),
  author: v.optional(v.string()),
  points: v.number(),
  comments: v.number(),
  createdAt: v.optional(v.string())
});

const outputSchema = v.object({
  topic: v.string(),
  lookbackHours: v.number(),
  storyCount: v.number(),
  summary: v.string(),
  topStories: v.array(storySchema)
});

const summarizer = defineAgent(() => ({
  model: process.env.FLUE_MODEL || "openai/gpt-4.1-mini",
  thinkingLevel: "low"
}));

export const route: WorkflowRouteHandler = async (_c, next) => next();

export default defineWorkflow({
  agent: summarizer,
  input: inputSchema,
  output: outputSchema,

  async run({ harness, input }) {
    const defaults = {
      defaultTopic: process.env.DEFAULT_TOPIC || "san francisco",
      defaultLookbackHours: Number(process.env.DEFAULT_LOOKBACK_HOURS || 24),
      maxStories: Number(process.env.MAX_STORIES || 12)
    };

    const session = await harness.session();
    const parsed = input.topic
      ? {
          topic: input.topic,
          lookbackHours: input.lookbackHours || defaults.defaultLookbackHours
        }
      : await extractRequest(session, input.text || defaults.defaultTopic, defaults);

    const stories = await fetchHackerNewsStories({
      topic: parsed.topic,
      lookbackHours: parsed.lookbackHours,
      maxStories: defaults.maxStories
    });

    if (stories.length === 0) {
      return {
        topic: parsed.topic,
        lookbackHours: parsed.lookbackHours,
        storyCount: 0,
        summary: `No recent Hacker News stories matched "${parsed.topic}" in the last ${formatLookback(parsed.lookbackHours)}.`,
        topStories: []
      };
    }

    const response = await session.prompt(
      [
        "You are summarizing Hacker News search results for a Slack reply.",
        "Summarize only the provided stories. Do not infer broader Hacker News trends.",
        "If results are sparse or weakly related, say that directly.",
        "",
        `Topic: ${parsed.topic}`,
        `Window: last ${formatLookback(parsed.lookbackHours)}`,
        "",
        "Stories:",
        ...stories.map((story, index) => {
          return `${index + 1}. ${story.title} (${story.points} points, ${story.comments} comments) URL: ${story.url} HN: ${story.hnUrl}`;
        })
      ].join("\n"),
      {
        result: v.object({
          summary: v.string()
        })
      }
    );

    return {
      topic: parsed.topic,
      lookbackHours: parsed.lookbackHours,
      storyCount: stories.length,
      summary: response.data.summary,
      topStories: stories.slice(0, 5)
    };
  }
});

type PromptSession = {
  prompt(text: string, options: { result: v.GenericSchema }): Promise<{ data: unknown }>;
};

async function extractRequest(session: PromptSession, text: string, defaults: {
  defaultTopic: string;
  defaultLookbackHours: number;
}) {
  const fallback = parseRequestLocally(text, defaults);

  try {
    const response = await session.prompt(
      [
        "Extract a Hacker News summary request from this user text.",
        "Return the actual topic to search for and the lookback window in hours.",
        "Do not include command words such as summarize, topics, about, past, or for in the topic.",
        "",
        `Default topic: ${defaults.defaultTopic}`,
        `Default lookback hours: ${defaults.defaultLookbackHours}`,
        "",
        "Examples:",
        "summarise topics about cars for the past 10 days -> topic=cars, lookbackHours=240",
        "cloudflare workers past 7 days -> topic=cloudflare workers, lookbackHours=168",
        "",
        `User text: ${text}`
      ].join("\n"),
      {
        result: v.object({
          topic: v.string(),
          lookbackHours: v.number()
        })
      }
    );

    const data = response.data as { topic: string; lookbackHours: number };

    if (!data.topic || !Number.isFinite(data.lookbackHours) || data.lookbackHours <= 0) {
      return fallback;
    }

    return data;
  } catch {
    return fallback;
  }
}
