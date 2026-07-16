import { buildConfig, fetchHackerNewsStories, formatLookback, parseRequestLocally } from "./hn.js";

const requestText = process.argv.slice(2).join(" ") || "san francisco last 24h";
const config = buildConfig();
const request = parseRequestLocally(requestText, config);
const stories = await fetchHackerNewsStories({
  topic: request.topic,
  lookbackHours: request.lookbackHours,
  maxStories: config.maxStories
});

console.log(JSON.stringify({
  request,
  storyCount: stories.length,
  window: formatLookback(request.lookbackHours),
  stories: stories.slice(0, 5)
}, null, 2));
