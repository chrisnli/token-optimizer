# SmartCodex Harness — Implementation Plan

**Design:** [2026-07-17-smartcodex-harness-design.md](./2026-07-17-smartcodex-harness-design.md)
**Branch:** `cli-harness`

Environment facts verified 2026-07-17:
- `codex-cli 0.142.3` installed; `codex exec resume` supports `--last`, `[SESSION_ID]`,
  `[PROMPT]`, and `-m/--model` per invocation (assumption #1 of the design holds at the
  flag level).
- Rust toolchain **not installed** — installing rustup is step 0.

Each step ends with a verification. Do them in order; commit after each green step.

## Step 0 — Toolchain
Install rustup (stable toolchain, MSVC target) — requires user approval.
**Verify:** `cargo --version` works in PowerShell.

## Step 1 — Scaffold
`harness/` Cargo binary crate named `smartcodex`. Deps: `clap` (derive), `serde`
(derive), `serde_json`, `anyhow`, `rustyline`. Stub `main.rs` printing help.
**Verify:** `cargo build` succeeds; `.gitignore` covers `harness/target/`.

## Step 2 — `router.rs`
`Route` enum (`Economy`, `Balanced`, `Advanced`) with `FromStr`; `model_for_route(route,
env)` honoring `SMARTCODEX_ROUTE_<ROUTE>_MODEL` overrides; defaults economy →
`gpt-5.4-mini`, balanced → `gpt-5.4`, advanced → `gpt-5.6-sol`.
**Verify:** unit tests — default mapping, env override, unknown route string.

## Step 3 — `classifier.rs`
Serde structs for the classify CLI's report (fields used: `classification.routeId`,
`classification.confidence`, `classification.reason`, `recommendedModel`; unknown fields
ignored). `classify(prompt, cwd, cfg) -> Result<Classification>` spawning
`SMARTCODEX_CLASSIFY_BIN` (default `smartcodex-classify`) with a timeout
(`SMARTCODEX_CLASSIFY_TIMEOUT_MS`, default 120s). Errors map to a `Fallback` outcome the
caller turns into the balanced route + printed warning.
**Verify:** unit tests with a stub script (batch/sh) emitting good JSON, bad JSON,
nonzero exit, and a sleep past the timeout.

## Step 4 — `turn.rs`
`TurnSpec { prompt, model: Option<String>, sandbox: Option<String>, full_auto: bool,
fresh: bool }`. Pure `build_command(spec) -> Vec<String>`: fresh → `exec …`, else →
`exec resume --last …`; include `--model` only when set. `run_turn` spawns codex with
inherited stdio, returns exit status; `--dry-run` prints the command instead. Ctrl+C
during a turn kills the child (handler shared with the REPL).
**Verify:** unit tests on `build_command` — first turn, resume, no-model, sandbox and
full-auto forwarding, dry-run formatting.

## Step 5 — `repl.rs`
`SessionState { auto: bool, model: Option<String>, sandbox: Option<String>, full_auto:
bool, fresh: bool, last_classification: Option<Classification> }`. rustyline loop.
Dispatch table exactly per the design's slash-command table (`/auto`, `/model`,
`/approvals`, `/new`, `/init`, `/diff`, `/status`, `/mcp`, `/login`, `/logout`,
`/quit`, `/exit`, `/help`, `/compact` + `/mention` explanations, unknown-command error).
Prompt path: auto on → classify → print `[auto] route=… → model (confidence …) — "…"` →
run turn; auto off → run turn with manual model.
**Verify:** unit tests on the dispatcher (command parsing + state transitions), one per
mapping.

## Step 6 — `main.rs`
clap: `--auto`, `--model`, `--codex-bin`, `--sandbox`, `--full-auto`, `--dry-run`,
optional initial prompt. Startup check that the codex binary resolves (clear error
otherwise). Wire flags into `SessionState`, run initial prompt if given, enter loop.
**Verify:** `smartcodex --dry-run "hello"` prints a `codex exec …` command;
`smartcodex --auto --dry-run "hello"` additionally prints the classification line (stub
classifier via env var).

## Step 7 — E2E dry-run test
Integration test driving the built binary with scripted stdin: `/model x` → prompt →
`/new` → prompt → `/auto on` (stub classifier) → prompt; assert the printed dry-run
commands and `[auto]` lines. No codex, no Node needed.
**Verify:** `cargo test` green.

## Step 8 — Live smoke test (needs user OK — spends codex tokens)
Tiny real session: prompt on model A, `/model` switch, second prompt resumes on model B;
confirm codex reports the switched model and remembers turn-1 context. Confirm Ctrl+C
kills a turn without killing the REPL.

## Step 9 — Docs
README section: install, usage, `/auto`, env vars, how the classifier is discovered,
known v1 limitations (`resume --last` concurrency, `/compact`, `/mention`).
