import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { classifyPrompt, resolveClassifyCommand } from "../src/classifier-bridge.js";

async function withStub(script, run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "smartcodex-stub-"));
  const stubPath = path.join(dir, "stub-classify.js");
  await fs.writeFile(stubPath, script, "utf8");
  try {
    return await run(stubPath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const GOOD_REPORT = {
  recommendedModel: "stub-model",
  recommendedReasoningLevel: "low",
  classification: { routeId: "economy", confidence: 0.88, reason: "tiny change" }
};

test("valid classifier report is parsed", async () => {
  const script = `process.stdout.write(${JSON.stringify(JSON.stringify(GOOD_REPORT))});`;
  await withStub(script, async (stubPath) => {
    const result = await classifyPrompt("prompt", { env: { SMARTCODEX_CLASSIFY_BIN: stubPath } });
    assert.equal(result.ok, true);
    assert.equal(result.routeId, "economy");
    assert.equal(result.model, "stub-model");
    assert.equal(result.confidence, 0.88);
    assert.equal(result.reason, "tiny change");
    assert.equal(result.reasoningLevel, "low");
  });
});

test("malformed reasoning level is dropped", async () => {
  const report = {
    recommendedModel: "m",
    recommendedReasoningLevel: 'weird"; injection',
    classification: { routeId: "economy", confidence: 0.5, reason: "x" }
  };
  const script = `process.stdout.write(${JSON.stringify(JSON.stringify(report))});`;
  await withStub(script, async (stubPath) => {
    const result = await classifyPrompt("prompt", { env: { SMARTCODEX_CLASSIFY_BIN: stubPath } });
    assert.equal(result.ok, true);
    assert.equal(result.reasoningLevel, null);
  });
});

test("missing recommendedModel falls back to the route map", async () => {
  const report = { classification: { routeId: "advanced", confidence: 0.7, reason: "hard" } };
  const script = `process.stdout.write(${JSON.stringify(JSON.stringify(report))});`;
  await withStub(script, async (stubPath) => {
    const result = await classifyPrompt("prompt", { env: { SMARTCODEX_CLASSIFY_BIN: stubPath } });
    assert.equal(result.ok, true);
    assert.equal(result.model, "gpt-5.6-sol");
  });
});

test("prompt travels over stdin", async () => {
  const script = [
    "let data = \"\";",
    "process.stdin.setEncoding(\"utf8\");",
    "process.stdin.on(\"data\", (c) => { data += c; });",
    "process.stdin.on(\"end\", () => {",
    `  const report = ${JSON.stringify(GOOD_REPORT)};`,
    "  report.classification.reason = data;",
    "  process.stdout.write(JSON.stringify(report));",
    "});"
  ].join("\n");
  await withStub(script, async (stubPath) => {
    const result = await classifyPrompt("the exact prompt", { env: { SMARTCODEX_CLASSIFY_BIN: stubPath } });
    assert.equal(result.reason, "the exact prompt");
  });
});

test("invalid JSON output is a warning, not a crash", async () => {
  const script = "process.stdout.write(\"this is not json\");";
  await withStub(script, async (stubPath) => {
    const result = await classifyPrompt("prompt", { env: { SMARTCODEX_CLASSIFY_BIN: stubPath } });
    assert.equal(result.ok, false);
    assert.ok(result.warning.includes("not valid JSON"));
  });
});

test("unknown route is rejected", async () => {
  const report = { classification: { routeId: "luxury", confidence: 1, reason: "?" } };
  const script = `process.stdout.write(${JSON.stringify(JSON.stringify(report))});`;
  await withStub(script, async (stubPath) => {
    const result = await classifyPrompt("prompt", { env: { SMARTCODEX_CLASSIFY_BIN: stubPath } });
    assert.equal(result.ok, false);
    assert.ok(result.warning.includes("unknown route"));
  });
});

test("nonzero exit is a warning", async () => {
  const script = "process.stderr.write(\"kaboom\"); process.exit(1);";
  await withStub(script, async (stubPath) => {
    const result = await classifyPrompt("prompt", { env: { SMARTCODEX_CLASSIFY_BIN: stubPath } });
    assert.equal(result.ok, false);
    assert.ok(result.warning.includes("status 1"));
  });
});

test("slow classifier hits the timeout", async () => {
  const script = "setTimeout(() => {}, 30000);";
  await withStub(script, async (stubPath) => {
    const result = await classifyPrompt("prompt", {
      env: { SMARTCODEX_CLASSIFY_BIN: stubPath, SMARTCODEX_CLASSIFY_TIMEOUT_MS: "300" }
    });
    assert.equal(result.ok, false);
    assert.ok(result.warning.includes("timed out"));
  });
});

test("in-package classifier is discovered without env override or PATH", () => {
  const resolved = resolveClassifyCommand({ PATH: "", Path: "", PATHEXT: ".EXE" });
  assert.ok(resolved);
  assert.equal(resolved.command, process.execPath);
  assert.ok(resolved.args[0].endsWith("smartcodex-classify.js"));
});
