import test from "node:test";
import assert from "node:assert/strict";
import { createLineSplitter, createStyler, createTurnRenderer, usageTotalTokens } from "../src/render.js";

function fakeIo() {
  const out = [];
  const err = [];
  return {
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
    out: () => out.join(""),
    err: () => err.join("")
  };
}

function plainRenderer() {
  const io = fakeIo();
  const style = createStyler(io, {});
  return { io, renderer: createTurnRenderer(io, style) };
}

// Event lines captured from a real `codex exec --json` run on codex-cli 0.142.3.
const REAL_EVENTS = [
  '{"type":"thread.started","thread_id":"019f733c-4b72-7c32-8ac7-8af5a2b05b51"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I’m checking the latest commit hash first."}}',
  '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"git log --oneline -1","aggregated_output":"","exit_code":null,"status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"git log --oneline -1","aggregated_output":"abc123 x\\n","exit_code":0,"status":"completed"}}',
  '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"OK"}}',
  '{"type":"turn.completed","usage":{"input_tokens":30788,"cached_input_tokens":19712,"output_tokens":99,"reasoning_output_tokens":19}}'
];

test("renders a real event stream without user/codex labels", () => {
  const { io, renderer } = plainRenderer();
  for (const line of REAL_EVENTS) {
    renderer.handleLine(line);
  }
  assert.equal(io.out(), [
    "I’m checking the latest commit hash first.",
    "  $ git log --oneline -1",
    "",
    "OK",
    ""
  ].join("\n"));
  assert.ok(!io.out().includes("user"));
  // The renderer no longer prints the token line itself — the session layer does.
  assert.ok(!io.out().includes("tokens"));
  const result = renderer.result();
  assert.equal(result.threadId, "019f733c-4b72-7c32-8ac7-8af5a2b05b51");
  assert.equal(result.failed, false);
  assert.equal(result.usage.output_tokens, 99);
  assert.equal(usageTotalTokens(result.usage), 30788 + 99);
});

test("usageTotalTokens sums input and output, handling null", () => {
  assert.equal(usageTotalTokens(null), null);
  assert.equal(usageTotalTokens({ input_tokens: 100, output_tokens: 5 }), 105);
  assert.equal(usageTotalTokens({ input_tokens: 100 }), 100);
});

test("a command completing without a started event is still shown once", () => {
  const { io, renderer } = plainRenderer();
  renderer.handleLine('{"type":"item.completed","item":{"id":"c1","type":"command_execution","command":"npm test","exit_code":1,"status":"failed"}}');
  assert.equal(io.out(), "  $ npm test\n  (exit 1)\n");
});

test("turn.failed and error events render as errors and mark failure", () => {
  const { io, renderer } = plainRenderer();
  renderer.handleLine('{"type":"turn.failed","error":{"message":"model overloaded"}}');
  assert.ok(io.out().includes("error: model overloaded"));
  assert.equal(renderer.result().failed, true);
});

test("model-switch notice on resume is a quiet note, not an error", () => {
  const { io, renderer } = plainRenderer();
  renderer.handleLine('{"type":"item.completed","item":{"id":"e1","type":"error","message":"This session was recorded with model `a` but is resuming with `b`. Consider switching back."}}');
  assert.ok(!io.out().includes("error:"));
  assert.ok(io.out().includes("resuming with"));
  assert.equal(renderer.result().failed, false);
});

test("non-JSON stdout lines pass through untouched", () => {
  const { io, renderer } = plainRenderer();
  renderer.handleLine("some raw codex notice");
  assert.equal(io.out(), "some raw codex notice\n");
});

test("stderr noise about stdin is filtered, other stderr kept", () => {
  const { io, renderer } = plainRenderer();
  renderer.handleStderrLine("Reading additional input from stdin...");
  renderer.handleStderrLine("warning: resuming with a different model");
  assert.equal(io.err(), "warning: resuming with a different model\n");
});

test("reasoning items stay quiet", () => {
  const { io, renderer } = plainRenderer();
  renderer.handleLine('{"type":"item.completed","item":{"id":"r1","type":"reasoning","text":"thinking..."}}');
  assert.equal(io.out(), "");
});

test("line splitter reassembles chunked lines", () => {
  const seen = [];
  const splitter = createLineSplitter((line) => seen.push(line));
  splitter.push('{"a":');
  splitter.push('1}\n{"b":2}\n{"c"');
  splitter.push(":3}");
  splitter.flush();
  assert.deepEqual(seen, ['{"a":1}', '{"b":2}', '{"c":3}']);
});
