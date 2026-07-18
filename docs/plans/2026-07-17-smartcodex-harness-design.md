# SmartCodex Harness — Design

**Date:** 2026-07-17
**Branch:** `cli-harness`
**Status:** Approved

## Problem

Codex CLI always runs with whatever model the user last configured. Most prompts don't
need the most expensive model. The classifier being built on the `smartcodex-setup` /
`restore-codex-requests` branches can look at a prompt (plus a local repo profile) and
return a JSON classification with a `routeId` (`economy` | `balanced` | `advanced`) that
maps to a model. This project adds the missing half: a CLI harness that feels like using
regular codex, but with an **auto mode** where each prompt is classified first and the
turn runs on the model the classifier picked.

## Goals

- Using the harness feels like using regular codex: interactive chat session, streaming
  output, conversation context preserved across turns, codex slash commands work.
- `/auto` toggles auto mode. When on, every prompt is classified before it runs and the
  harness prints the chosen model, route, confidence, and reason.
- Manual control always available: `/model <name>` or `--model <name>` pins a model and
  turns auto off.
- The harness adds **no AI logic of its own**. Regular messages pass through to codex
  verbatim. Slash commands are one-line shims onto codex's own flags and subcommands.
  The only new feature is `/auto` + the classifier call.

## Approach (chosen: A)

The real codex TUI is a closed binary; nothing can intercept a prompt inside it. So the
harness owns the input line and delegates each turn to codex's non-interactive interface.

- **A. Custom REPL over `codex exec` / `codex exec resume` (chosen).** Own readline
  loop; turn 1 runs `codex exec --model <m> "<prompt>"`, later turns run
  `codex exec resume --last --model <m> "<prompt>"` so context carries over while the
  model can change per turn. Fastest to build; easy to test.
- **B. Frontend over `codex app-server` (JSON-RPC).** The "proper" embedding; richer
  control (approvals, events, session ids). Several times the effort. Possible later —
  the turn-runner is the only module that would change.
- **C. Launch-time wrapper around the real TUI.** Classify once, then `codex -m <m>`.
  Rejected: model is locked for the session, so no per-prompt auto mode.

## Implementation

Node ≥20, ESM, zero runtime dependencies, `node --test` — the same conventions as the
classifier branches. Same root layout (`package.json`, `bin/`, `src/`, `test/`) so the
branches merge into one npm package with two bins: `smartcodex` (this harness) and
`smartcodex-classify` (the classifier). The REPL uses `node:readline` (line editing +
in-session history, no dependency).

> Language history: Rust was chosen initially, but no Rust toolchain is installed on the
> dev machine and the user opted to stay with Node rather than install one.

### Modules

| Module | Responsibility |
|---|---|
| `bin/smartcodex.js` | thin shebang entry, calls `runHarness` |
| `src/harness-cli.js` | arg parsing, startup checks, wiring |
| `src/repl.js` | input loop, slash-command dispatch, session state (auto flag, model, approval mode, fresh-vs-resume) |
| `src/router.js` | route → model map with `SMARTCODEX_ROUTE_<ROUTE>_MODEL` env overrides (defaults: economy → `gpt-5.4-mini`, balanced → `gpt-5.4`, advanced → `gpt-5.6-sol`) |
| `src/classifier-bridge.js` | spawns the classify CLI (or its in-package `bin/` script once branches merge), parses + validates its JSON report, applies timeout and fallback |
| `src/turn.js` | builds and spawns the `codex exec` command for one turn, streams output through |

### CLI

```
smartcodex [--auto] [--model <m>] [--codex-bin <path>] [--sandbox <mode>]
           [--full-auto] [--dry-run] ["initial prompt"]
```

Starts in manual mode (codex default model) unless `--auto` / `--model` given. An initial
prompt argument runs immediately as the first turn. `--dry-run` prints the codex command
for a turn instead of executing it.

### Slash commands

Pass-through philosophy: regular messages go to codex untouched; slash commands are thin
shims onto the codex feature the TUI would invoke.

| Command | Shim |
|---|---|
| `/auto [on\|off]` | smartcodex-only: toggle classifier-driven model selection |
| `/model <m>` / `/model` | store model, forwarded as codex's `--model` flag (turns auto off); bare form shows current |
| `/approvals <mode>` | stored, forwarded as codex's `--sandbox` / `--full-auto` flags |
| `/new` | next turn runs fresh `codex exec` instead of `resume` |
| `/init` | sends codex's standard AGENTS.md instruction as a turn |
| `/diff` | runs `git diff` (what the codex TUI does) |
| `/status` | shows mode, model, approval mode, session state, last classification |
| `/mcp` | shells out to `codex mcp list` |
| `/login` / `/logout` | shell out to `codex login` / `codex logout` |
| `/quit` / `/exit` | exit |
| `/help` | lists commands, marking smartcodex-specific ones |
| `/compact` | not supported in exec mode; prints explanation (codex auto-compacts on its own when context fills) |
| `/mention` | not supported; hint says to type the file path in the prompt |

Unknown commands: codex-style "unknown command" error.

### Data flow (one turn)

1. Read a line. `/`-prefixed → local dispatch (above). Otherwise it is a prompt.
2. Auto mode on → spawn `smartcodex-classify "<prompt>"` in the project directory with a
   timeout; parse the JSON report; model = report's `recommendedModel`, else
   `router.rs` mapping of `routeId`. Print
   `[auto] route=<r> → <model> (confidence <c>) — "<reason>"`.
3. Model precedence: auto-selected (auto on) → manual (`/model` / `--model`) → none
   (codex default, flag omitted).
4. First turn: `codex exec --model <m> …args… "<prompt>"`. Later turns:
   `codex exec resume --last --model <m> …args… "<prompt>"`. stdout/stderr stream
   through untouched. `/new` resets to a fresh `exec`.

### Error handling

- `codex` not found → clear startup error (install codex or pass `--codex-bin`).
- Classifier missing / timeout / crash / invalid JSON → warn and fall back to the
  balanced-route model (or the manual model if set). A failed classifier never blocks a
  turn.
- Codex nonzero exit → show exit code, REPL stays alive.
- Ctrl+C during a turn kills the codex child and returns to the prompt; Ctrl+C at an
  idle prompt (or `/quit` / Ctrl+D) exits.

### Testing

- `node --test` units: router mapping + env overrides; slash-command dispatch (one test
  per mapping); classifier JSON parsing incl. malformed-output fallback; exact codex
  argument construction (first turn vs resume vs dry-run).
- E2E: drive the bin with scripted stdin in `--dry-run` mode; assert printed
  commands. A stub classify script stands in for the real classifier, so tests need
  no codex and no classifier branch.
- Manual smoke checklist against real codex: model switches on `resume`, streaming,
  Ctrl+C behavior.

## Risks / assumptions to verify first

1. **`codex exec resume` accepts `--model` per turn** (load-bearing). Verified against
   codex-cli 0.142.3: `exec resume` takes `-m/--model` (plus `--last`, `[SESSION_ID]`,
   `[PROMPT]`). Whether the model truly switches mid-conversation is confirmed in the
   live smoke test.
2. `resume --last` grabs the most recent codex session; running plain codex concurrently
   in another terminal could confuse continuity. Accepted for v1; later fix is capturing
   the real session id from codex output.
3. Codex's slash-command list evolves; the v1 table above is pinned, new commands get
   shims as they appear.
