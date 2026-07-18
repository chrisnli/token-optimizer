import test from "node:test";
import assert from "node:assert/strict";
import { INIT_PROMPT, createSessionState, executeTurn, formatAutoLine, handleCommand, resolveSelection } from "../src/repl.js";

function fakeIo(env = {}) {
  const out = [];
  const err = [];
  return {
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
    env,
    cwd: ".",
    out: () => out.join(""),
    err: () => err.join("")
  };
}

function fakeDeps() {
  const calls = { runSub: [], runTurn: [], classify: [] };
  return {
    calls,
    runSub: async (bin, args) => {
      calls.runSub.push([bin, ...args]);
      return 0;
    },
    runTurn: async (spec) => {
      calls.runTurn.push(spec);
      return { exitCode: 0 };
    },
    classify: async (prompt) => {
      calls.classify.push(prompt);
      return { ok: true, routeId: "economy", confidence: 0.9, reason: "simple", model: "auto-model" };
    }
  };
}

test("/auto toggles and accepts on/off", async () => {
  const state = createSessionState();
  const io = fakeIo();
  await handleCommand("/auto", state, io, fakeDeps());
  assert.equal(state.auto, true);
  await handleCommand("/auto", state, io, fakeDeps());
  assert.equal(state.auto, false);
  await handleCommand("/auto on", state, io, fakeDeps());
  assert.equal(state.auto, true);
  await handleCommand("/auto off", state, io, fakeDeps());
  assert.equal(state.auto, false);
  await handleCommand("/auto sideways", state, io, fakeDeps());
  assert.ok(io.out().includes("usage: /auto"));
});

test("bare /model opens the picker rather than just printing state", async () => {
  const state = createSessionState();
  const io = fakeIo();
  await handleCommand("/model", state, io, fakeDeps());
  assert.equal(state.pending.kind, "model");
});

test("/model <name> sets the model and turns auto off", async () => {
  const state = createSessionState({ auto: true });
  const io = fakeIo();
  await handleCommand("/model gpt-5.4", state, io, fakeDeps());
  assert.equal(state.model, "gpt-5.4");
  assert.equal(state.auto, false);
  assert.ok(io.out().includes("auto mode turned OFF"));
});

test("/approvals with a direct arg maps to sandbox and full-auto", async () => {
  const state = createSessionState();
  const io = fakeIo();
  await handleCommand("/approvals read-only", state, io, fakeDeps());
  assert.equal(state.sandbox, "read-only");
  assert.equal(state.fullAuto, false);
  await handleCommand("/approvals full-auto", state, io, fakeDeps());
  assert.equal(state.fullAuto, true);
  assert.equal(state.sandbox, null);
  await handleCommand("/approvals nonsense", state, io, fakeDeps());
  assert.ok(io.out().includes("usage: /approvals"));
});

test("bare /model opens a picker listing codex models", async () => {
  const state = createSessionState();
  const io = fakeIo();
  await handleCommand("/model", state, io, fakeDeps());
  assert.equal(state.pending.kind, "model");
  assert.ok(io.out().includes("Select a model"));
  assert.ok(io.out().includes("gpt-5.4"));
});

test("picking a model by number sets it, turns auto off, then asks reasoning", () => {
  const state = createSessionState({ auto: true });
  const io = fakeIo();
  state.pending = {
    kind: "model",
    models: [
      { slug: "gpt-5.5", reasoningLevels: ["low", "high"], defaultReasoning: "medium" },
      { slug: "gpt-5.4", reasoningLevels: ["low", "high"], defaultReasoning: "medium" }
    ]
  };
  resolveSelection("2", state, io);
  assert.equal(state.model, "gpt-5.4");
  assert.equal(state.auto, false);
  assert.equal(state.pending.kind, "reasoning");

  resolveSelection("high", state, io);
  assert.equal(state.reasoningEffort, "high");
  assert.equal(state.pending, null);
});

test("blank selection cancels the model picker", () => {
  const state = createSessionState({ model: "keep-me" });
  const io = fakeIo();
  state.pending = { kind: "model", models: [{ slug: "gpt-5.4", reasoningLevels: [] }] };
  resolveSelection("", state, io);
  assert.equal(state.model, "keep-me");
  assert.equal(state.pending, null);
  assert.ok(io.out().includes("unchanged"));
});

test("a typed unknown model name is accepted as-is with no reasoning step", () => {
  const state = createSessionState();
  const io = fakeIo();
  state.pending = { kind: "model", models: [{ slug: "gpt-5.4", reasoningLevels: ["low"] }] };
  resolveSelection("some-custom-model", state, io);
  assert.equal(state.model, "some-custom-model");
  assert.equal(state.pending, null);
});

test("/permissions is an alias that opens the approval picker", async () => {
  const state = createSessionState();
  const io = fakeIo();
  await handleCommand("/permissions", state, io, fakeDeps());
  assert.equal(state.pending.kind, "approvals");
  assert.ok(io.out().includes("approval / sandbox"));
  assert.ok(io.out().includes("Read Only"));
});

test("picking an approval preset by number applies sandbox + full-auto", () => {
  const state = createSessionState();
  const io = fakeIo();
  state.pending = { kind: "approvals" };
  resolveSelection("3", state, io); // full-auto
  assert.equal(state.fullAuto, true);
  assert.equal(state.sandbox, null);
  assert.ok(io.out().includes("Full Auto"));
});

test("approval picker accepts a mode name and blank cancels", () => {
  const state = createSessionState();
  const io = fakeIo();
  state.pending = { kind: "approvals" };
  resolveSelection("read-only", state, io);
  assert.equal(state.sandbox, "read-only");

  state.pending = { kind: "approvals" };
  resolveSelection("", state, io);
  assert.ok(io.out().includes("unchanged"));
  assert.equal(state.pending, null);
});

test("/new marks the session fresh and forgets the thread id", async () => {
  const state = createSessionState();
  state.fresh = false;
  state.threadId = "t-old";
  const io = fakeIo();
  await handleCommand("/new", state, io, fakeDeps());
  assert.equal(state.fresh, true);
  assert.equal(state.threadId, null);
});

test("/init returns a turn with the AGENTS.md instruction", async () => {
  const state = createSessionState();
  const result = await handleCommand("/init", state, fakeIo(), fakeDeps());
  assert.equal(result.action, "turn");
  assert.equal(result.prompt, INIT_PROMPT);
  assert.ok(INIT_PROMPT.includes("AGENTS.md"));
});

test("/diff shells out to git", async () => {
  const deps = fakeDeps();
  await handleCommand("/diff", createSessionState(), fakeIo(), deps);
  assert.deepEqual(deps.calls.runSub, [["git", "--no-pager", "diff"]]);
});

test("/status reports state", async () => {
  const state = createSessionState({ auto: true, model: "m1" });
  const io = fakeIo();
  await handleCommand("/status", state, io, fakeDeps());
  assert.ok(io.out().includes("auto mode: on"));
  assert.ok(io.out().includes("model: m1"));
  assert.ok(io.out().includes("session: fresh"));
});

test("/mcp, /login, /logout shell out to codex", async () => {
  const deps = fakeDeps();
  const state = createSessionState();
  await handleCommand("/mcp", state, fakeIo(), deps);
  await handleCommand("/login", state, fakeIo(), deps);
  await handleCommand("/logout", state, fakeIo(), deps);
  assert.deepEqual(deps.calls.runSub, [
    ["codex", "mcp", "list"],
    ["codex", "login"],
    ["codex", "logout"]
  ]);
});

test("/quit and /exit end the session", async () => {
  const state = createSessionState();
  assert.equal((await handleCommand("/quit", state, fakeIo(), fakeDeps())).action, "quit");
  assert.equal((await handleCommand("/exit", state, fakeIo(), fakeDeps())).action, "quit");
});

test("/compact and /mention explain themselves", async () => {
  const io = fakeIo();
  await handleCommand("/compact", createSessionState(), io, fakeDeps());
  assert.ok(io.out().includes("automatically"));
  await handleCommand("/mention", createSessionState(), io, fakeDeps());
  assert.ok(io.out().includes("file path"));
});

test("unknown command is reported", async () => {
  const io = fakeIo();
  await handleCommand("/frobnicate", createSessionState(), io, fakeDeps());
  assert.ok(io.out().includes("unknown command: /frobnicate"));
});

test("executeTurn without auto uses the manual model and marks session continuing", async () => {
  const state = createSessionState({ model: "manual-model" });
  const deps = fakeDeps();
  await executeTurn("do things", state, fakeIo(), deps);
  assert.equal(deps.calls.runTurn.length, 1);
  assert.equal(deps.calls.runTurn[0].model, "manual-model");
  assert.equal(deps.calls.runTurn[0].fresh, true);
  assert.equal(state.fresh, false);
});

test("executeTurn forwards a manually chosen reasoning level", async () => {
  const state = createSessionState({ model: "manual-model", reasoningEffort: "high" });
  const deps = fakeDeps();
  await executeTurn("do things", state, fakeIo(), deps);
  assert.equal(deps.calls.runTurn[0].reasoningEffort, "high");
});

test("executeTurn with auto uses the classifier model and prints the auto line", async () => {
  const state = createSessionState({ auto: true });
  const deps = fakeDeps();
  const io = fakeIo();
  await executeTurn("classify me", state, io, deps);
  assert.deepEqual(deps.calls.classify, ["classify me"]);
  assert.equal(deps.calls.runTurn[0].model, "auto-model");
  assert.ok(io.out().includes("[auto] auto-model"));
  assert.ok(!io.out().includes("route="));
  assert.ok(!io.out().includes("confidence"));
  assert.equal(state.lastClassification.model, "auto-model");
});

test("executeTurn remembers the codex thread id and resumes it", async () => {
  const state = createSessionState();
  const deps = fakeDeps();
  deps.runTurn = async (spec) => {
    deps.calls.runTurn.push(spec);
    return { exitCode: 0, threadId: "t-123" };
  };
  await executeTurn("first", state, fakeIo(), deps);
  assert.equal(state.threadId, "t-123");
  await executeTurn("second", state, fakeIo(), deps);
  assert.equal(deps.calls.runTurn[1].threadId, "t-123");
  assert.equal(deps.calls.runTurn[1].fresh, false);
});

test("executeTurn forwards the classifier's reasoning level", async () => {
  const state = createSessionState({ auto: true });
  const deps = fakeDeps();
  deps.classify = async () => ({
    ok: true, routeId: "advanced", confidence: 0.8, reason: "hard", model: "big", reasoningLevel: "high"
  });
  const io = fakeIo();
  await executeTurn("x", state, io, deps);
  assert.equal(deps.calls.runTurn[0].reasoningEffort, "high");
  assert.ok(io.out().includes("[auto] big · reasoning high"));
});

test("executeTurn falls back to balanced model when the classifier fails", async () => {
  const state = createSessionState({ auto: true });
  const deps = fakeDeps();
  deps.classify = async () => ({ ok: false, warning: "boom" });
  const io = fakeIo();
  await executeTurn("classify me", state, io, deps);
  assert.equal(deps.calls.runTurn[0].model, "gpt-5.4");
  assert.ok(io.err().includes("boom"));
});

test("executeTurn keeps manual model as fallback when set", async () => {
  const state = createSessionState({ auto: true, model: "pinned" });
  const deps = fakeDeps();
  deps.classify = async () => ({ ok: false, warning: "down" });
  await executeTurn("x", state, fakeIo(), deps);
  assert.equal(deps.calls.runTurn[0].model, "pinned");
});

test("executeTurn reports nonzero codex exit and keeps fresh state", async () => {
  const state = createSessionState();
  const deps = fakeDeps();
  deps.runTurn = async () => ({ exitCode: 3 });
  const io = fakeIo();
  await executeTurn("x", state, io, deps);
  assert.ok(io.err().includes("status 3"));
  assert.equal(state.fresh, true);
});

test("formatAutoLine shows only model and reasoning level", () => {
  assert.equal(formatAutoLine({ routeId: "balanced", model: "m", confidence: 0.9, reason: "why" }), "[auto] m");
  assert.equal(formatAutoLine({ model: "m", reasoningLevel: "low" }), "[auto] m · reasoning low");
});
