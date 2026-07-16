# V1 Flue HN Summarizer

This version is the Flue-native rewrite. The goal is to keep the product behavior from `v0` but move the agent reasoning into a real Flue workflow/harness.

Current local target:

```text
topic/time request -> Flue harness extraction -> HN fetch -> Flue harness summary -> local output
```

## Setup

```bash
cp .env.example .env
npm install
```

Set `OPENAI_API_KEY` in `.env`.

## Local Dry Run

```bash
npm run dry-run -- '{"text":"summarise topics about cars for the past 10 days"}'
```

This runs the discovered `hn-summary` workflow through `flue run --target node`.
The workflow uses `harness.session().prompt(...)` for both request extraction and summarization.

## Flue Cloudflare Build

```bash
npm run flue:build
```

Deploy the generated Flue Cloudflare artifact:

```bash
npm run deploy
```

Production URL:

```text
https://flue-agent-summariser-v1.ujn.workers.dev
```

Invoke the deployed workflow:

```bash
curl 'https://flue-agent-summariser-v1.ujn.workers.dev/workflows/hn-summary?wait=result' \
  -H 'Content-Type: application/json' \
  -d '{"text":"summarise topics about cars for the past 10 days"}'
```
