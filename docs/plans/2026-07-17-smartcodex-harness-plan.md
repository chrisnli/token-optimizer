# SmartCodex Harness — Implementation Plan

**Design:** [2026-07-17-smartcodex-harness-design.md](./2026-07-17-smartcodex-harness-design.md)
**Branch:** `cli-harness`

Environment facts verified 2026-07-17:
- `codex-cli 0.142.3` installed; `codex exec resume` supports `--last`, `[SESSION_ID]`,
  `[PROMPT]`, and `-m/--model` per invocation (assumption #1 of the design holds at the
  flag level).
- Language is Node ≥20 (Rust was considered; no toolchain installed, user chose Node).

Each step ends with a verification. Do them in order; commit after each green step.

## Step 0 — Toolchain check
**Verify:** `node --version` ≥ 20 and `codex --version` works.

## Step 1 — Scaffold
Root `package.json` (ESM, `bin: { smartcodex: ./bin/smartcodex.js }`, scripts `test` =
`node --test`, engines node ≥20, zero deps — mirroring the classifier branches so they
merge into one package). Thin `bin/smartcodex.js`.
**Verify:** `node bin/smartcodex.js --help` prints usage.

## Step 2 — `src/router.js`
`ROUTE_MODELS` defaults (economy → `gpt-5.4-mini`, balanced → `gpt-5.4`, advanced →
`gpt-5.6-sol`); `modelForRoute(routeId, env)` honoring
`SMARTCODEX_ROUTE_<ROUTE>_MODEL` overrides; unknown route → null.
**Verify:** unit tests — default mapping, env override, unknown route.

## Step 3 — `src/classifier-bridge.js`
`classifyPrompt(prompt, { cwd, env, timeoutMs }) -> { ok, classification?, model?,
warning? }`. Resolution order for the classify command: `SMARTCODEX_CLASSIFY_BIN` env →
in-package `bin/smartcodex-classify.js` (exists after branches merge) → bare
`smartcodex-classify` on PATH. Parses the classify CLI's JSON report (uses
`classification.routeId` / `confidence` / `reason` and `recommendedModel`; ignores the
rest). Timeout default 120s. Any failure returns `ok: false` + warning; caller falls
back to the balanced route.
**Verify:** unit tests with stub scripts (good JSON, bad JSON, nonzero exit, timeout).

## Step 4 — `src/turn.js`
`buildTurnArgs(spec)` pure: `{ prompt, model, sandbox, fullAuto, fresh }` →
`exec …` (fresh) or `exec resume --last …`; `--model` only when set; sandbox /
full-auto forwarding. `runTurn` spawns codex with inherited stdio (Windows `.cmd`
resolution handled like the classifier's codex-runner does); dry-run prints the command
instead. Ctrl+C during a turn kills the child, not the REPL.
**Verify:** unit tests on `buildTurnArgs` — first turn, resume, no-model, sandbox,
full-auto, dry-run formatting.

## Step 5 — `src/repl.js`
Session state `{ auto, model, sandbox, fullAuto, fresh, lastClassification }`.
`node:readline` loop. Dispatch table exactly per the design's slash-command table
(`/auto`, `/model`, `/approvals`, `/new`, `/init`, `/diff`, `/status`, `/mcp`,
`/login`, `/logout`, `/quit`, `/exit`, `/help`, `/compact` + `/mention` explanations,
unknown-command error). Prompt path: auto on → classify → print
`[auto] route=… → model (confidence …) — "…"` → run turn.
**Verify:** unit tests on `handleCommand` (parsing + state transitions), one per
mapping.

## Step 6 — `src/harness-cli.js`
Args: `--auto`, `--model`, `--codex-bin`, `--sandbox`, `--full-auto`, `--dry-run`,
`--help`, optional initial prompt. Startup check that the codex binary resolves. Wire
into session state, run initial prompt if given, enter loop.
**Verify:** `node bin/smartcodex.js --dry-run "hello"` prints a `codex exec …` command;
with `--auto` + stub classifier it also prints the `[auto]` line.

## Step 7 — E2E dry-run test
Integration test driving the bin with scripted stdin: `/model x` → prompt → `/new` →
prompt → `/auto on` (stub classifier) → prompt; assert printed dry-run commands and
`[auto]` lines. No codex needed.
**Verify:** `node --test` green.

## Step 8 — Live smoke test (needs user OK — spends codex tokens)
Tiny real session: prompt on model A, `/model` switch, second prompt resumes on model B;
confirm codex reports the switched model and remembers turn-1 context. Confirm Ctrl+C
kills a turn without killing the REPL.

## Step 9 — Docs
README section: install, usage, `/auto`, env vars, how the classifier is discovered,
known v1 limitations (`resume --last` concurrency, `/compact`, `/mention`).
