# Flue Hacker News Slack Mention Summarizer

This agent listens for Slack app mentions, searches recent Hacker News stories for the requested topic, and replies in-thread with a summary.

## Setup

```bash
cp .env.example .env
```

Edit `.env`:

- `SLACK_SIGNING_SECRET`: Slack app signing secret for Events API verification.
- `SLACK_BOT_TOKEN`: Slack bot token with `chat:write`.
- `OPENAI_API_KEY`: optional, used for higher quality summaries and better mention parsing.
- `OPENAI_PARSE_REQUESTS`: set to `false` to disable LLM-based topic/time extraction.
- `DEFAULT_TOPIC`: fallback topic when the mention does not include one.
- `DEFAULT_LOOKBACK_HOURS`: fallback interval when the mention does not include one.
- `PORT`: local HTTP server port.

## Slack App

Create a Slack app and configure:

- OAuth scopes: `app_mentions:read`, `chat:write`.
- Event subscriptions: subscribe to `app_mention`.
- Request URL: `https://<your-public-url>/slack/events`.

For local development, expose the server with a tunnel such as ngrok or Cloudflare Tunnel, then use the tunnel URL as the Slack Request URL.

## Usage

Mention the bot in Slack:

```text
@hn-summarizer san francisco
@hn-summarizer openai last 48h
@hn-summarizer cloudflare workers past 7 days
@hn-summarizer postgres 2 weeks
@hn-summarizer summarise topics about cars for the past 10 days
```

Supported intervals include hours, days, and weeks, with phrases like `last 24h`, `past 7 days`, `2 weeks`, `today`, or `yesterday`.

## Run

Test locally without Slack:

```bash
npm run dry-run -- "san francisco last 24h"
```

Start the Slack Events server:

```bash
npm start
```

Health check:

```bash
curl http://localhost:3000/health
```
