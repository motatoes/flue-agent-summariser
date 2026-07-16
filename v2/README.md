# V2 OpenComputer Flue Agent

This version targets OpenComputer's current Flue runtime profile.

It is intentionally different from `v1`:

- `v1` is a Flue Cloudflare Worker with a Flue Slack channel.
- `v2` is a direct text Flue agent for OpenComputer managed sessions.

OpenComputer can attach its own channels to the deployed agent. The current OC Flue profile does not connect Flue channels or workflows directly, so Slack ingress should be handled by OpenComputer channels rather than `@flue/slack`.

## Local Setup

```bash
npm install
```

## Validate

```bash
npm run oc:check
```

## Deploy

```bash
npm run oc:deploy
```

## Agent

Agent manifest:

```text
agent.toml
```

Flue agent:

```text
src/agents/hn-summariser.ts
```

The agent uses OpenComputer's managed model gateway and an optional OpenComputer sandbox for live Hacker News API requests.
