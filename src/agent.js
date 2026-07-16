import crypto from "node:crypto";

const HN_SEARCH_URL = "https://hn.algolia.com/api/v1/search_by_date";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const SLACK_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";

export function buildConfig(env = process.env) {
  return {
    defaultTopic: env.DEFAULT_TOPIC || env.TOPIC || "san francisco",
    defaultLookbackHours: Number(env.DEFAULT_LOOKBACK_HOURS || env.LOOKBACK_HOURS || 24),
    maxStories: Number(env.MAX_STORIES || 12),
    port: Number(env.PORT || 3000),
    slackBotToken: env.SLACK_BOT_TOKEN,
    slackSigningSecret: env.SLACK_SIGNING_SECRET,
    openAiApiKey: env.OPENAI_API_KEY,
    openAiModel: env.OPENAI_MODEL || "gpt-4.1-mini",
    useOpenAiParsing: env.OPENAI_PARSE_REQUESTS !== "false"
  };
}

export function validateConfig(config, mode) {
  if (!Number.isFinite(config.defaultLookbackHours) || config.defaultLookbackHours <= 0) {
    throw new Error("DEFAULT_LOOKBACK_HOURS must be a positive number.");
  }

  if (!Number.isFinite(config.maxStories) || config.maxStories <= 0) {
    throw new Error("MAX_STORIES must be a positive number.");
  }

  if (mode === "server") {
    if (!config.slackBotToken) {
      throw new Error("SLACK_BOT_TOKEN is required to post mention replies.");
    }

    if (!config.slackSigningSecret) {
      throw new Error("SLACK_SIGNING_SECRET is required to verify Slack Events requests.");
    }
  }
}

export async function summarizeTopic(config, request) {
  const stories = await fetchHackerNewsStories({
    topic: request.topic,
    lookbackHours: request.lookbackHours,
    maxStories: config.maxStories
  });

  const summary = config.openAiApiKey
    ? await summarizeWithOpenAI(config, request, stories)
    : buildExtractiveSummary(request, stories);

  return {
    stories,
    summary,
    payload: buildSlackPayload(request, stories, summary)
  };
}

export async function fetchHackerNewsStories({ topic, lookbackHours, maxStories }) {
  const sinceUnixSeconds = Math.floor(Date.now() / 1000) - lookbackHours * 60 * 60;
  const searchParams = new URLSearchParams({
    query: topic,
    tags: "story",
    numericFilters: `created_at_i>${sinceUnixSeconds}`,
    hitsPerPage: String(maxStories)
  });

  const response = await fetch(`${HN_SEARCH_URL}?${searchParams}`);
  if (!response.ok) {
    throw new Error(`Hacker News search failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data.hits
    .map(normalizeStory)
    .filter((story) => story.title && story.url)
    .sort((a, b) => b.points + b.comments - (a.points + a.comments));
}

function normalizeStory(hit) {
  return {
    title: hit.title || hit.story_title,
    url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
    hnUrl: `https://news.ycombinator.com/item?id=${hit.objectID}`,
    author: hit.author,
    points: hit.points || 0,
    comments: hit.num_comments || 0,
    createdAt: hit.created_at
  };
}

async function summarizeWithOpenAI(config, request, stories) {
  if (stories.length === 0) {
    return noStoriesMessage(request);
  }

  const input = [
    {
      role: "system",
      content: [
        {
          type: "input_text",
          text: "You write concise Hacker News briefings for Slack. Summarize only the provided HN search results for the requested topic. Be specific, neutral, and link to notable stories. Do not make claims about broader Hacker News discussion outside the provided stories."
        }
      ]
    },
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: [
            `Topic: ${request.topic}`,
            `Window: last ${formatLookback(request.lookbackHours)}`,
            "Stories:",
            ...stories.map(
              (story, index) =>
                `${index + 1}. ${story.title} (${story.points} points, ${story.comments} comments) URL: ${story.url} HN: ${story.hnUrl}`
            ),
            "",
            "Return 3-5 Slack-friendly bullets. If the results are sparse or weakly related, say that directly. End with 'Top links' containing up to 3 links from the provided stories."
          ].join("\n")
        }
      ]
    }
  ];

  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.openAiApiKey}`
    },
    body: JSON.stringify({
      model: config.openAiModel,
      input,
      max_output_tokens: 700
    })
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`OpenAI summary failed: ${response.status} ${response.statusText} ${errorBody}`);
  }

  const data = await response.json();
  return extractResponseText(data);
}

function extractResponseText(data) {
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const text = data.output
    ?.flatMap((item) => item.content || [])
    .filter((content) => content.type === "output_text" && content.text)
    .map((content) => content.text)
    .join("\n")
    .trim();

  if (!text) {
    throw new Error("OpenAI response did not include summary text.");
  }

  return text;
}

function buildExtractiveSummary(request, stories) {
  if (stories.length === 0) {
    return noStoriesMessage(request);
  }

  const bullets = stories.slice(0, 5).map((story) => {
    return `- <${story.url}|${escapeSlackText(story.title)}> (${story.points} points, ${story.comments} comments)`;
  });

  return [
    `Top Hacker News matches for *${escapeSlackText(request.topic)}* in the last ${formatLookback(request.lookbackHours)}:`,
    ...bullets
  ].join("\n");
}

function noStoriesMessage(request) {
  return `No recent Hacker News stories matched *${escapeSlackText(request.topic)}* in the last ${formatLookback(request.lookbackHours)}.`;
}

export function buildSlackPayload(request, stories, summary) {
  const title = `HN summary: ${request.topic}`;
  const storyCount = `${stories.length} ${stories.length === 1 ? "story" : "stories"}`;

  return {
    text: `${title}\n${summary}`,
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: title.slice(0, 150),
          emoji: false
        }
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `${storyCount} from the last ${formatLookback(request.lookbackHours)}`
          }
        ]
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: summary.slice(0, 2900)
        }
      }
    ]
  };
}

export async function postSlackMessage(config, message) {
  const response = await fetch(SLACK_POST_MESSAGE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${config.slackBotToken}`
    },
    body: JSON.stringify(message)
  });

  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(`Slack chat.postMessage failed: ${response.status} ${data.error || response.statusText}`);
  }

  return data;
}

export async function parseMentionRequest(text, defaults) {
  if (!defaults.openAiApiKey || !defaults.useOpenAiParsing) {
    return parseMentionText(text, defaults);
  }

  try {
    return await parseMentionWithOpenAI(text, defaults);
  } catch (error) {
    console.warn(`OpenAI request parsing failed, falling back to local parser: ${error.message}`);
    return parseMentionText(text, defaults);
  }
}

async function parseMentionWithOpenAI(text, defaults) {
  const cleaned = cleanMentionText(text);
  const fallback = parseMentionText(text, defaults);
  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${defaults.openAiApiKey}`
    },
    body: JSON.stringify({
      model: defaults.openAiModel,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: [
                "Extract a Hacker News summary request from a Slack mention.",
                "Return only compact JSON with keys topic and lookbackHours.",
                "topic should be the actual subject to search HN for, not command words like summarize, topics, about, past, or for.",
                "lookbackHours should convert intervals to hours. If no interval is present, use the provided default.",
                "If the topic is missing, use the provided default topic."
              ].join(" ")
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify({
                text: cleaned,
                defaultTopic: defaults.defaultTopic,
                defaultLookbackHours: defaults.defaultLookbackHours,
                examples: [
                  {
                    text: "summarise topics about cars for the past 10 days",
                    result: { topic: "cars", lookbackHours: 240 }
                  },
                  {
                    text: "cloudflare workers past 7 days",
                    result: { topic: "cloudflare workers", lookbackHours: 168 }
                  },
                  {
                    text: "what is happening with postgres today",
                    result: { topic: "postgres", lookbackHours: 12 }
                  }
                ]
              })
            }
          ]
        }
      ],
      max_output_tokens: 120
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI request parsing failed: ${response.status} ${response.statusText} ${await response.text()}`);
  }

  const data = await response.json();
  const parsed = JSON.parse(stripJsonFence(extractResponseText(data)));
  const topic = normalizeTopic(String(parsed.topic || fallback.topic), defaults.defaultTopic);
  const lookbackHours = Number(parsed.lookbackHours || fallback.lookbackHours);

  if (!Number.isFinite(lookbackHours) || lookbackHours <= 0) {
    return fallback;
  }

  return {
    topic,
    lookbackHours
  };
}

export function parseMentionText(text, defaults) {
  let cleaned = cleanMentionText(text);

  const interval = extractLookbackHours(cleaned, defaults.defaultLookbackHours);
  cleaned = interval.text.replace(/\s+/g, " ").trim();

  const topic = normalizeTopic(cleaned, defaults.defaultTopic);

  return {
    topic,
    lookbackHours: interval.lookbackHours
  };
}

function cleanMentionText(text) {
  return text
    .replace(/<@[A-Z0-9]+>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTopic(text, defaultTopic) {
  const topic = text
    .replace(/^(please\s+)?(?:can you\s+|could you\s+)?(?:summari[sz]e|summary|find|show|hn|hacker news)\b\s*/i, "")
    .replace(/^(?:me\s+)?(?:topics?|stories|posts|news|discussion|discussions)\s+(?:about|on|regarding|for)\s+/i, "")
    .replace(/^(?:about|on|regarding)\s+/i, "")
    .replace(/\b(?:on|from)\s+(?:hn|hacker news)$/i, "")
    .replace(/\s+(?:summari[sz]e|summary)$/i, "")
    .trim();

  return topic || defaultTopic;
}

function extractLookbackHours(text, fallbackHours) {
  const patterns = [
    /\b(?:for|over)\s+(?:the\s+)?(?:last|past|previous)\s+(\d+)\s*(hours?|hrs?|h|days?|d|weeks?|w)\b/i,
    /\b(?:last|past|previous)\s+(\d+)\s*(hours?|hrs?|h|days?|d|weeks?|w)\b/i,
    /\b(\d+)\s*(hours?|hrs?|h|days?|d|weeks?|w)\b/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return {
        lookbackHours: unitToHours(Number(match[1]), match[2]),
        text: `${text.slice(0, match.index)} ${text.slice(match.index + match[0].length)}`
      };
    }
  }

  if (/\b(?:today|since morning)\b/i.test(text)) {
    return {
      lookbackHours: 12,
      text: text.replace(/\b(?:today|since morning)\b/gi, " ")
    };
  }

  if (/\b(?:yesterday|since yesterday)\b/i.test(text)) {
    return {
      lookbackHours: 48,
      text: text.replace(/\b(?:yesterday|since yesterday)\b/gi, " ")
    };
  }

  return {
    lookbackHours: fallbackHours,
    text
  };
}

function stripJsonFence(text) {
  return text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function unitToHours(value, unit) {
  const normalized = unit.toLowerCase();
  if (normalized.startsWith("d")) {
    return value * 24;
  }
  if (normalized.startsWith("w")) {
    return value * 24 * 7;
  }
  return value;
}

export function verifySlackSignature({ signingSecret, rawBody, timestamp, signature, nowSeconds = Date.now() / 1000 }) {
  if (!signingSecret || !timestamp || !signature) {
    return false;
  }

  if (Math.abs(nowSeconds - Number(timestamp)) > 60 * 5) {
    return false;
  }

  const base = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${crypto.createHmac("sha256", signingSecret).update(base).digest("hex")}`;
  if (expected.length !== signature.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export function formatLookback(hours) {
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

function escapeSlackText(text) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
