Project to optimize token costs for LLMs.

## smartcodex — Codex harness with automatic model selection

An interactive session that feels like regular codex, plus an **auto mode**: type
`/auto` and every prompt is first sent to a cheap classifier that picks the most
token-efficient model (economy / balanced / advanced route); the turn then runs on that
model via `codex exec` / `codex exec resume`, so conversation context carries across
turns while the model can change per prompt. The classifier also recommends a reasoning
level, forwarded to codex as `model_reasoning_effort`. The chosen model and reasoning
level are printed before each turn:

```
[auto] gpt-5.4-mini · reasoning low
```

(`/status` shows the full detail: route, confidence, and the classifier's reason.)

Regular messages pass through to codex verbatim. Turn output is rendered from codex's
JSON event stream in a codex-TUI-like style: your input sits on the `› ` prompt line,
agent replies are plain text, and commands / file changes appear dimmed — no
`user`/`codex` labels or session headers. Each turn ends with a dimmed token line
showing the cost of that message and the running session total, e.g.
`· 17,071 tokens · 34,126 session`.

### Requirements

- Node ≥ 20 and the [Codex CLI](https://github.com/openai/codex) on PATH (or set
  `SMARTCODEX_CODEX_BIN`).
- The classifier (`smartcodex-classify`, in this repo under `bin/`) is found
  automatically; `SMARTCODEX_CLASSIFY_BIN` can point at a different copy. It classifies
  in a fresh ephemeral Codex task using `gpt-5.4-mini`, low reasoning, and low response
  verbosity, or locally via ollama (`SMARTCODEX_CLASSIFIER=ollama`). The Codex classifier
  model and reasoning level are fixed and cannot be overridden by environment variables.
  If classification fails, auto mode warns and falls back to the balanced-route model.

### Usage

```
node bin/smartcodex.js [--auto | --manual] [--model <m>] [--sandbox <mode>]
                       [--full-auto] [--codex-bin <path>] [--dry-run] ["initial prompt"]
```

**Auto mode is on by default** — the classifier picks the model for every prompt without
you doing anything. Turn it off with `--manual` (or `--no-auto`) to use codex's own
default model, or pin a specific model with `--model <m>` (which implies manual).

Inside the session:

| Command | Effect |
|---|---|
| `/auto [on\|off]` | toggle classifier-driven model selection |
| `/model [name]` | bare: pick from codex's own model list (then a reasoning level); or name one directly. Turns auto off. |
| `/approvals [mode]` | bare: pick an approval/sandbox mode from a menu; or name one directly. Alias: `/permissions`. |
| `/new` | next prompt starts a fresh codex session |
| `/init` | ask codex to generate AGENTS.md |
| `/diff` | show the working-tree diff |
| `/status` | mode, model, approvals, session state, last classification |
| `/mcp`, `/login`, `/logout` | forwarded to the codex CLI |
| `/quit`, `/exit` | leave |

The `/model` and `/approvals` pickers show the same options codex would. The model list
is read from codex's own cache (`~/.codex/models_cache.json`), so it always matches what
your codex/account actually supports; if that cache is missing, a built-in list is used.

`--dry-run` prints the exact `codex` command per turn instead of running it.

### Configuration (env vars)

| Variable | Purpose |
|---|---|
| `SMARTCODEX_CODEX_BIN` | path to the codex executable |
| `SMARTCODEX_CLASSIFY_BIN` | path to the classifier CLI (`.js` files run via node) |
| `SMARTCODEX_CLASSIFY_TIMEOUT_MS` | classifier timeout (default 120000) |
| `SMARTCODEX_ROUTE_ECONOMY_MODEL` | override model for the economy route (default `gpt-5.4-mini`) |
| `SMARTCODEX_ROUTE_BALANCED_MODEL` | override model for the balanced route (default `gpt-5.4`) |
| `SMARTCODEX_ROUTE_ADVANCED_MODEL` | override model for the advanced route (default `gpt-5.6-sol`) |

### Known v1 limitations

- Turns resume via `codex exec resume --last`; running plain codex concurrently in
  another terminal can confuse which session continues.
- `/compact` and `/mention` are codex-TUI-only features; smartcodex explains the
  alternative when you use them (codex auto-compacts on its own in exec mode).

### Development

`npm test` runs unit + e2e tests (no codex or classifier needed — dry-run and stubs).
`npm run lint` syntax-checks all sources. Design and plan live in `docs/plans/`.
