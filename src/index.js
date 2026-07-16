import http from "node:http";
import {
  buildConfig,
  parseMentionRequest,
  postSlackMessage,
  summarizeTopic,
  validateConfig,
  verifySlackSignature
} from "./agent.js";

const args = process.argv.slice(2);
const argSet = new Set(args);
const config = buildConfig();

async function main() {
  if (argSet.has("--dry-run")) {
    validateConfig(config, "dry-run");
    const text = args.filter((arg) => !arg.startsWith("--")).join(" ");
    const request = await parseMentionRequest(text, config);
    const result = await summarizeTopic(config, request);
    console.log(JSON.stringify(result.payload, null, 2));
    return;
  }

  validateConfig(config, "server");
  startSlackEventsServer(config);
}

function startSlackEventsServer(currentConfig) {
  const processedEventIds = new Set();

  const server = http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method !== "POST" || request.url !== "/slack/events") {
      sendJson(response, 404, { ok: false, error: "not_found" });
      return;
    }

    const rawBody = await readRequestBody(request);
    const isVerified = verifySlackSignature({
      signingSecret: currentConfig.slackSigningSecret,
      rawBody,
      timestamp: request.headers["x-slack-request-timestamp"],
      signature: request.headers["x-slack-signature"]
    });

    if (!isVerified) {
      sendJson(response, 401, { ok: false, error: "invalid_signature" });
      return;
    }

    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      sendJson(response, 400, { ok: false, error: "invalid_json" });
      return;
    }

    if (body.type === "url_verification") {
      sendJson(response, 200, { challenge: body.challenge });
      return;
    }

    sendJson(response, 200, { ok: true });

    if (body.type !== "event_callback" || body.event?.type !== "app_mention") {
      return;
    }

    if (body.event_id && processedEventIds.has(body.event_id)) {
      return;
    }
    if (body.event_id) {
      processedEventIds.add(body.event_id);
    }

    handleAppMention(currentConfig, body.event).catch((error) => {
      console.error(error);
    });
  });

  server.listen(currentConfig.port, () => {
    console.log(`HN Slack mention summarizer listening on http://localhost:${currentConfig.port}/slack/events`);
  });
}

async function handleAppMention(currentConfig, event) {
  const request = await parseMentionRequest(event.text || "", currentConfig);
  const loadingMessage = await postSlackMessage(currentConfig, {
    channel: event.channel,
    thread_ts: event.thread_ts || event.ts,
    text: `Looking up Hacker News stories for "${request.topic}"...`
  });

  try {
    const result = await summarizeTopic(currentConfig, request);
    await postSlackMessage(currentConfig, {
      channel: event.channel,
      thread_ts: event.thread_ts || event.ts || loadingMessage.ts,
      ...result.payload
    });
  } catch (error) {
    await postSlackMessage(currentConfig, {
      channel: event.channel,
      thread_ts: event.thread_ts || event.ts || loadingMessage.ts,
      text: `I could not summarize that topic: ${error.message}`
    });
    throw error;
  }
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";

    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      resolve(body);
    });
    request.on("error", reject);
  });
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json"
  });
  response.end(JSON.stringify(payload));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
