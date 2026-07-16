# Flue Agent Summariser

This repo now has two versions:

- `v0/`: the original plain Cloudflare Worker Slack bot. It is intentionally preserved for reference.
- `v1/`: the Flue-native rewrite. It uses a real Flue workflow, harness, and Cloudflare Durable Objects.
- `v2/`: the OpenComputer-compatible Flue agent. It uses direct text sessions and OpenComputer's managed Flue deployment path.

Use `v1/` for the standalone Slack Worker. Use `v2/` for OpenComputer-hosted agents and OC-managed channels.
