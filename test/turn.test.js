import test from "node:test";
import assert from "node:assert/strict";
import { buildTurnArgs, formatCommandDisplay, runTurn } from "../src/turn.js";

test("first turn uses codex exec with model and prompt last", () => {
  const args = buildTurnArgs({ prompt: "fix the bug", model: "gpt-5.4", fresh: true });
  assert.deepEqual(args, ["exec", "--model", "gpt-5.4", "fix the bug"]);
});

test("later turns resume the last session", () => {
  const args = buildTurnArgs({ prompt: "continue", model: "gpt-5.4-mini", fresh: false });
  assert.deepEqual(args, ["exec", "resume", "--last", "--model", "gpt-5.4-mini", "continue"]);
});

test("model flag omitted when no model chosen", () => {
  const args = buildTurnArgs({ prompt: "hello", model: null, fresh: true });
  assert.deepEqual(args, ["exec", "hello"]);
});

test("sandbox and full-auto are forwarded as flags on fresh turns", () => {
  const args = buildTurnArgs({
    prompt: "p",
    model: "m",
    sandbox: "workspace-write",
    fullAuto: true,
    fresh: true
  });
  assert.deepEqual(args, ["exec", "--model", "m", "--sandbox", "workspace-write", "--full-auto", "p"]);
});

test("sandbox and full-auto become -c overrides on resumed turns", () => {
  const sandboxArgs = buildTurnArgs({ prompt: "p", model: "m", sandbox: "read-only", fresh: false });
  assert.deepEqual(sandboxArgs, [
    "exec", "resume", "--last", "--model", "m", "-c", 'sandbox_mode="read-only"', "p"
  ]);

  const fullAutoArgs = buildTurnArgs({ prompt: "p", model: "m", fullAuto: true, fresh: false });
  assert.deepEqual(fullAutoArgs, [
    "exec", "resume", "--last", "--model", "m",
    "-c", 'approval_policy="on-failure"', "-c", 'sandbox_mode="workspace-write"', "p"
  ]);
});

test("display formatting quotes arguments with spaces", () => {
  const display = formatCommandDisplay("codex", ["exec", "--model", "m", "two words"]);
  assert.equal(display, 'codex exec --model m "two words"');
});

test("dry-run prints the command instead of spawning", async () => {
  let out = "";
  const io = { stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} } };
  const result = await runTurn(
    { prompt: "hello there", model: "m1", fresh: true },
    { codexBin: "codex", dryRun: true, io }
  );
  assert.equal(result.exitCode, 0);
  assert.ok(out.includes('[dry-run] codex exec --model m1 "hello there"'));
});
