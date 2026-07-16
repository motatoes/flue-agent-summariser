import {
  bash,
  defineAgent,
  defineAgentProfile,
  defineTool,
  type BashLike,
  type SandboxFactory
} from "@flue/runtime";
import { DEFAULT_MODEL, route, useOcGateway } from "@opencomputer/flue";
import * as v from "valibot";

export { route };

const DEFAULT_TOPIC = "san francisco";
const DEFAULT_LOOKBACK_HOURS = 24;
const MAX_STORIES = 12;
const HN_SEARCH_URL = "https://hn.algolia.com/api/v1/search_by_date";
const WORKSPACE_CWD = "/workspace";

type HnHit = {
  objectID: string;
  title?: string | null;
  story_title?: string | null;
  url?: string | null;
  story_url?: string | null;
  points?: number | null;
  num_comments?: number | null;
  created_at?: string | null;
  author?: string | null;
};

type HnSearchResponse = {
  hits?: HnHit[];
};

const emptySandbox: SandboxFactory = {
  ...bash(() => createEmptyBash()),
  tools: () => []
};

function createEmptyBash(): BashLike {
  const files = new Map<string, string | Uint8Array>();
  const directories = new Set<string>([WORKSPACE_CWD]);

  const resolvePath = (base: string, path: string) => {
    if (path.startsWith("/")) {
      return normalizePath(path);
    }

    return normalizePath(`${base}/${path}`);
  };

  return {
    async exec() {
      return {
        stdout: "",
        stderr: "Shell access is disabled for this agent. Use search_hacker_news.",
        exitCode: 127
      };
    },
    getCwd() {
      return WORKSPACE_CWD;
    },
    fs: {
      async readFile(path) {
        const content = files.get(normalizePath(path));

        if (typeof content === "string") {
          return content;
        }

        if (content instanceof Uint8Array) {
          return new TextDecoder().decode(content);
        }

        throw new Error(`File not found: ${path}`);
      },
      async readFileBuffer(path) {
        const content = files.get(normalizePath(path));

        if (content instanceof Uint8Array) {
          return content;
        }

        if (typeof content === "string") {
          return new TextEncoder().encode(content);
        }

        throw new Error(`File not found: ${path}`);
      },
      async writeFile(path, content) {
        files.set(normalizePath(path), content);
      },
      async stat(path) {
        const normalized = normalizePath(path);

        if (directories.has(normalized)) {
          return { isFile: false, isDirectory: true };
        }

        if (files.has(normalized)) {
          return { isFile: true, isDirectory: false };
        }

        throw new Error(`Path not found: ${path}`);
      },
      async readdir(path) {
        const normalized = normalizePath(path);

        if (!directories.has(normalized)) {
          throw new Error(`Directory not found: ${path}`);
        }

        return [];
      },
      async exists(path) {
        const normalized = normalizePath(path);
        return files.has(normalized) || directories.has(normalized);
      },
      async mkdir(path) {
        directories.add(normalizePath(path));
      },
      async rm(path) {
        const normalized = normalizePath(path);
        files.delete(normalized);
        directories.delete(normalized);
      },
      resolvePath
    }
  };
}

function normalizePath(path: string) {
  const parts = path.split("/");
  const stack: string[] = [];

  for (const part of parts) {
    if (!part || part === ".") {
      continue;
    }

    if (part === "..") {
      stack.pop();
      continue;
    }

    stack.push(part);
  }

  return `/${stack.join("/")}`;
}

const storySchema = v.object({
  id: v.string(),
  title: v.string(),
  url: v.nullable(v.string()),
  hnUrl: v.string(),
  points: v.number(),
  comments: v.number(),
  createdAt: v.nullable(v.string()),
  author: v.nullable(v.string())
});

const searchHackerNews = defineTool({
  name: "search_hacker_news",
  description:
    "Search recent Hacker News stories for a topic. Use this before writing any Hacker News summary.",
  input: v.object({
    topic: v.pipe(
      v.optional(v.string(), DEFAULT_TOPIC),
      v.description(`Topic to search for. Defaults to ${DEFAULT_TOPIC}.`)
    ),
    lookbackHours: v.pipe(
      v.optional(v.number(), DEFAULT_LOOKBACK_HOURS),
      v.integer(),
      v.minValue(1),
      v.maxValue(24 * 90),
      v.description(
        "How many hours back to search. Convert days/weeks/months to hours before calling."
      )
    )
  }),
  output: v.object({
    topic: v.string(),
    lookbackHours: v.number(),
    sinceUnix: v.number(),
    searchedAt: v.string(),
    totalReturned: v.number(),
    stories: v.array(storySchema)
  }),
  async run({ input, signal }) {
    const topic = input.topic.trim() || DEFAULT_TOPIC;
    const lookbackHours = Math.max(
      1,
      Math.min(24 * 90, Math.round(input.lookbackHours))
    );
    const searchedAt = new Date();
    const sinceUnix = Math.floor(
      (searchedAt.getTime() - lookbackHours * 60 * 60 * 1000) / 1000
    );

    const url = new URL(HN_SEARCH_URL);
    url.searchParams.set("tags", "story");
    url.searchParams.set("query", topic);
    url.searchParams.set("numericFilters", `created_at_i>${sinceUnix}`);
    url.searchParams.set("hitsPerPage", String(MAX_STORIES));

    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal
    });

    if (!response.ok) {
      throw new Error(
        `HN Algolia search failed: ${response.status} ${response.statusText}`
      );
    }

    const body = (await response.json()) as HnSearchResponse;
    const stories = (body.hits ?? [])
      .map((hit) => {
        const title = hit.title ?? hit.story_title ?? "";
        const id = hit.objectID;

        if (!id || !title) {
          return null;
        }

        return {
          id,
          title,
          url: hit.url ?? hit.story_url ?? null,
          hnUrl: `https://news.ycombinator.com/item?id=${id}`,
          points: hit.points ?? 0,
          comments: hit.num_comments ?? 0,
          createdAt: hit.created_at ?? null,
          author: hit.author ?? null
        };
      })
      .filter((story): story is NonNullable<typeof story> => story !== null);

    return {
      topic,
      lookbackHours,
      sinceUnix,
      searchedAt: searchedAt.toISOString(),
      totalReturned: stories.length,
      stories
    };
  }
});

export default defineAgent((ctx) => {
  useOcGateway(ctx);

  return {
    profile: defineAgentProfile({
      instructions: [
        "You are an on-demand Hacker News topic summarizer.",
        "The user will send plain text such as 'harvard', 'summarise topics about cars for the past 10 days', or 'cloudflare workers last 7 days'.",
        `Always call search_hacker_news before answering. Do not try to fetch Hacker News with shell commands or by constructing URLs yourself.`,
        `Extract only the topic and lookback window for the tool call. If the topic is missing, use "${DEFAULT_TOPIC}". If the window is missing, use ${DEFAULT_LOOKBACK_HOURS} hours.`,
        "Convert intervals before calling the tool: 1 day = 24 hours, 1 week = 168 hours, 1 month = 720 hours.",
        "Summarize only the stories returned by search_hacker_news. If results are sparse, weakly related, or empty, say that directly.",
        "Format the final answer for Slack mrkdwn, not GitHub Markdown.",
        "Use *single asterisks* for bold. Never use **double asterisks** or Markdown headings like ##.",
        "Use compact bullet lines with •. Avoid numbered lists unless the ranking matters.",
        "Format links as <url|title>. Prefer each story's URL when present, otherwise use its HN discussion URL.",
        "Keep the answer scannable: title line, one short summary paragraph, then up to three linked story bullets with points/comments."
      ].join("\n")
    }),
    model: DEFAULT_MODEL,
    sandbox: emptySandbox,
    tools: [searchHackerNews]
  };
});
