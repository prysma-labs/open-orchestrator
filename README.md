# open-orchestrator

A tiny Pi-based poster demo: **researcher → interviewer → artist**, compared with one general-purpose Claude agent using the same tools. No agent framework, server, database, or UI to maintain.

## Reproducible demo (no credentials)

Node **22.19+**. From the repository root:

```sh
npm run demo
```

This runs both arms with one brief and recorded answers. It requires **no install**, because fixture mode never imports Pi. Inspect `runs/<timestamp>/{specialized,baseline}/poster.svg`, `result.json`, `trace.jsonl`, and the root `comparison.json` and replayable `answers.json`.

**FIXTURE MODE IS SCRIPTED, NOT AI.** Research posts are synthetic, agent decisions are deterministic replays, and posters are labeled SVG placeholders. Both arms deliberately use the same placeholder renderer. This validates wiring and observability, not creative quality, X trends, Pi execution, or superiority over Claude. There is no silent fallback from live to fixture behavior.

## Live setup

```sh
npm install
export ANTHROPIC_API_KEY=...
export OPENAI_API_KEY=...
export X_BEARER_TOKEN=...
npm start -- specialized --brief "Create a poster for an offline creative night"
```

The CLI asks questions in your terminal. Answers must include audience, mood/style, and exact poster text. Supply `--answers fixtures/answers.json` for unattended runs. Environment variables must be exported; `.env` is not auto-loaded. Image calls incur provider charges; there is at most one successful image per arm. A compare run generates two images.

| Agent | Responsibility | Only tools | Model setting |
|---|---|---|---|
| researcher | Find concepts supported by recent X posts | `search_concepts` | `RESEARCHER_MODEL` |
| interviewer | Establish creative direction with the user | `ask_user` | `INTERVIEWER_MODEL` |
| artist | Compose the image prompt and render poster | `generate_image` | `ARTIST_MODEL` |
| baseline | Complete the whole task in one conversation | All three | `BASELINE_MODEL` |

Each model defaults to `anthropic/claude-sonnet-4-6`. Set `openai/gpt-4.1-mini` for a faster interviewer, for example. Supported model providers: Anthropic and OpenAI, using their exported API keys. Each role also accepts `--researcher-model`, `--interviewer-model`, `--artist-model`, or `--baseline-model`. The image renderer is separate: `IMAGE_MODEL` defaults to `gpt-image-1` using OpenAI's Images API and a portrait 1024×1536 PNG. Model availability depends on your account and Pi's pinned catalog.

Live agents use Pi's `Agent`, model registry, tool validation and execution loop. They receive only the declared tools, with no shell, file access, coding tools, extensions, or ambient project instructions. Each specialist starts with fresh memory. The host passes explicit textual handoffs. Runs have an eight-turn cap and a three-minute agent abort timer; HTTP requests have a three-minute timeout. Terminal input time is included in wall time. Failure aborts the run and persists available traces; it never substitutes a fixture image.

## Compare

```sh
npm start -- compare --brief "Create a poster for an offline creative night" --answers fixtures/answers.json
```

The baseline is a single Pi-hosted Claude conversation with the union of tools. It is **not Claude Code**. Both arms receive the same brief, identical cached research snapshot, same answers keyed by audience/mood/text, same image provider, and same one-image limit. The baseline must collect the required inputs but chooses its own design. Live comparison is sequential; recorded answers eliminate unequal user effort. Prompt differences and aggregate model calls are intentional. Choose all four models identically to isolate workflow effects, then change models to explore speed/cost tradeoffs.

Judge posters blind on relevance, distinctive concept, hierarchy, readability, and adherence to exact copy. Compare execution time and model usage in traces; image-provider cost/usage is not estimated. Different image draws remain stochastic. No automatic quality score or claim of outperformance is included.

## Replace research / partial fixtures

Built-in X adapter uses `GET https://api.x.com/2/tweets/search/recent`, retaining source URLs, timestamps, and metrics. Your X account must have API access. Use `--query 'your X search query'`; default query targets analog/offline design discussion. It reads one page of 20 recent posts, not a statistically verified trend feed. Empty results remain explicit. Source content is treated as untrusted data in agent instructions.

For another service, create a local ES module exporting:

```js
export async function search({ brief, query }) {
  return { fixture: false, posts: [{ text: 'Actual source text', url: 'https://example.com/source' }] };
}
```

Run with `--research-adapter ./my-research.mjs`. This explicitly selected adapter takes priority over fixtures; do not combine it with `--fixture` if you want a strictly offline run. The returned object is cached across comparison arms. Keep credentials in the adapter environment, not results. Adapter code is trusted local code.

Use `--fixture-research` to keep Pi agents and live image generation without X credentials, or `--fixture-image` to keep live agents/research but render labeled SVG placeholders without image credentials. These flags do **not** mock the agents. `--fixture` mocks agents, research, and images. `result.json` records provenance; custom adapters should set `fixture` honestly.

## Observability and validation

Console events show agent execution, tools, and elapsed milliseconds. JSONL traces include role/model/tool allowlists, tool arguments, tool duration/errors, completed assistant messages/usage, and handoff output. Traces contain your brief and answers: treat them as private. Credentials and raw provider error bodies are not logged. Output directories default to unique timestamps; `--out` can intentionally overwrite an existing run.

```sh
npm test
```

Tests cover role tool boundaries, answer handoff, identical comparison inputs, fixture output/traces, missing required actions, exact-copy enforcement, and the OpenAI request/response contract using a mocked HTTP response. They need no credentials or dependencies.

Validated here: credential-free demo, test suite, and JavaScript syntax checks. Pi 1.4.0 API signatures were checked against its release source. **Not validated here:** installed Pi execution, real X retrieval, or paid OpenAI image generation. This environment could not resolve npm's registry; live dependencies could not be installed, so no lockfile is fabricated. Direct Pi dependencies are pinned; run `npm install` and commit its generated lockfile when registry access is available.

Sources: [Pi agent core](https://github.com/earendil-works/pi/tree/v1.4.0/packages/agent), [Pi models/providers](https://github.com/earendil-works/pi/tree/v1.4.0/packages/ai), [X recent search](https://docs.x.com/x-api/posts/search-recent-posts), [OpenAI Images](https://developers.openai.com/api/reference/resources/images).
