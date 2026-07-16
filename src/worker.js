import {
  buildConfig,
  parseMentionRequest,
  postSlackMessage,
  summarizeTopic,
  validateConfig,
  verifySlackSignature
} from "./agent.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true });
    }

    if (request.method !== "POST" || url.pathname !== "/slack/events") {
      return json({ ok: false, error: "not_found" }, 404);
    }

    const config = buildConfig(env);
    validateConfig(config, "server");

    const rawBody = await request.text();
    const isVerified = await verifySlackSignature({
      signingSecret: config.slackSigningSecret,
      rawBody,
      timestamp: request.headers.get("x-slack-request-timestamp"),
      signature: request.headers.get("x-slack-signature")
    });

    if (!isVerified) {
      return json({ ok: false, error: "invalid_signature" }, 401);
    }

    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return json({ ok: false, error: "invalid_json" }, 400);
    }

    if (body.type === "url_verification") {
      return json({ challenge: body.challenge });
    }

    if (body.type === "event_callback" && body.event?.type === "app_mention") {
      ctx.waitUntil(handleAppMention(config, body.event));
    }

    return json({ ok: true });
  }
};

async function handleAppMention(config, event) {
  const request = await parseMentionRequest(event.text || "", config);
  const threadTs = event.thread_ts || event.ts;
  const loadingMessage = await postSlackMessage(config, {
    channel: event.channel,
    thread_ts: threadTs,
    text: `Looking up Hacker News stories for "${request.topic}"...`
  });

  try {
    const result = await summarizeTopic(config, request);
    await postSlackMessage(config, {
      channel: event.channel,
      thread_ts: threadTs || loadingMessage.ts,
      ...result.payload
    });
  } catch (error) {
    await postSlackMessage(config, {
      channel: event.channel,
      thread_ts: threadTs || loadingMessage.ts,
      text: `I could not summarize that topic: ${error.message}`
    });
    throw error;
  }
}

function json(payload, status = 200) {
  return Response.json(payload, {
    status,
    headers: {
      "Cache-Control": "no-store"
    }
  });
}
