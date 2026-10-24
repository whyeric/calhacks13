# Errand Line

A phone assistant for everyday errands, company and family protection. Product requirements and architecture: [SPEC.md](SPEC.md).

This branch implements **GitHub milestone 1: Phase 0 · Foundations**. It includes the self-hosted Cartesia Line agent, direct Claude streaming, authenticated Convex HTTP actions, the nine-table schema, repeatable demo seed, alert-call transport, tests, container configuration and wireframes. The Next.js application is a later milestone (#86).

Prototype notifications use voice calls and the dashboard. Approvals use spoken responses or dashboard buttons.

**Start here: [setup and deployment](docs/setup.md).** The current completion evidence and remaining account/phone checks are in [milestone status](docs/milestone-1.md). No real payment implementation is enabled in this phase.

For the Cal Hacks demo, run the voice agent on your laptop through an HTTPS tunnel; no Fly.io account is required. With the saved local service configuration and `cloudflared` installed:

```sh
agent/.venv/bin/python harness/local_demo.py
```

Keep the laptop awake and this command running. It starts the agent and tunnel, updates the existing Cartesia agent URL, and assigns the existing demo number. Restarting it refreshes the temporary hostname automatically; Ctrl+C stops both processes.

```text
agent/              Python voice service; managed with uv
  prompts/          Static prompt text
  tools/            Next milestone's model-called tools
  context.py        Foundation caller notes and cache breakpoints
  convex_api.py     Pooled authenticated Convex HTTP client
dashboard/convex/   Schema, internal functions, family queries and HTTP actions
fixtures/          Fictional demo household and evidence
harness/           Agent tests, live provider probe and HTTP acceptance smoke test
docs/              Setup, acceptance evidence and importable SVG wireframes
```

## Local checks

Install [uv](https://docs.astral.sh/uv/getting-started/installation/) and Node.js 22.12 or later.

```sh
cd agent
uv sync --frozen
uv run pytest
uv run ruff check --config pyproject.toml . ../harness
```

```sh
cd dashboard
npm ci
npm run typecheck
npm test
```

Run the dashboard locally with `cd dashboard && npm install && npm run dev` (and `npm run dev:convex`), then open `/live#key=<DASHBOARD_ACCESS_KEY>`. Milestone 2 status: [docs/milestone-2.md](docs/milestone-2.md).

These checks need no service credentials and never make live phone calls. `harness/provider_spike.py` is an explicit live Claude probe; it consumes a small amount of API credit and outputs token counts only. Real-phone acceptance remains mandatory for #121.
