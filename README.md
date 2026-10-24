# Errand Line

A phone assistant for everyday errands, company and family protection. Product requirements and architecture: [SPEC.md](SPEC.md).

This branch implements **GitHub milestone 1: Phase 0 · Foundations**. It includes the self-hosted Cartesia Line agent, direct Claude streaming, authenticated Convex HTTP actions, the nine-table schema, repeatable demo seed, alert-call transport, tests, container configuration and wireframes. The Next.js application is a later milestone (#86).

**Start here: [setup and deployment](docs/setup.md).** The current completion evidence and remaining account/phone checks are in [milestone status](docs/milestone-1.md). No real payment implementation is enabled in this phase.

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

These checks need no service credentials and never make live phone calls. `harness/provider_spike.py` is an explicit live Claude probe; it consumes a small amount of API credit and outputs token counts only. Real-phone acceptance remains mandatory for #121.
