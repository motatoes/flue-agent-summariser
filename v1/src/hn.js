const HN_SEARCH_URL = "https://hn.algolia.com/api/v1/search_by_date";

export function buildConfig(env = process.env) {
  return {
    defaultTopic: env.DEFAULT_TOPIC || "san francisco",
    defaultLookbackHours: Number(env.DEFAULT_LOOKBACK_HOURS || 24),
    maxStories: Number(env.MAX_STORIES || 12),
    openAiApiKey: env.OPENAI_API_KEY,
    openAiModel: env.OPENAI_MODEL || "gpt-4.1-mini"
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

export function parseRequestLocally(text, defaults) {
  let cleaned = text
    .replace(/<@[A-Z0-9]+>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  const interval = extractLookbackHours(cleaned, defaults.defaultLookbackHours);
  cleaned = interval.text.replace(/\s+/g, " ").trim();

  return {
    topic: normalizeTopic(cleaned, defaults.defaultTopic),
    lookbackHours: interval.lookbackHours
  };
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
