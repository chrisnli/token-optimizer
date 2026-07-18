import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  CLASSIFIER_MODEL,
  CLASSIFIER_REASONING_EFFORT,
  buildClassifierPayload,
  compactRepositoryProfile,
  extractUsage,
  parseCodexJsonl,
  resolveCodexCommand,
  resolveCodexBin,
  runCodexClassifier
} from "../src/codex-runner.js";

const validClassification = {
  routeId: "balanced",
  reasoningLevel: "medium",
  confidence: 0.86,
  taskType: "bug_fix",
  userIntent: "modify_and_test",
  likelyFilesTouched: 3,
  candidateFiles: ["src/auth.ts"],
  ambiguity: 2,
  repoInspection: "targeted",
  testing: "related_suite",
  risk: "high",
  effort: "medium",
  estimatedMinutes: { minimum: 20, maximum: 90 },
  complexity: {
    reasoning: 4,
    repositoryContext: 3,
    implementation: 3,
    verification: 3,
    scope: 3
  },
  reason: "Short explanation"
};

test("builds payload without file contents", () => {
  const profile = {
    totalFiles: 1,
    totalBytes: 123,
    files: [{ path: "src/auth.ts", lines: 12, bytes: 123 }]
  };

  const payload = buildClassifierPayload({
    prompt: "Fix auth",
    repoProfile: profile,
    routeCandidates: [
      { routeId: "economy", model: "gpt-5.4-mini", reasoningLevels: ["low"] },
      { routeId: "balanced", model: "gpt-5.4", reasoningLevels: ["low", "medium"] },
      { routeId: "advanced", model: "gpt-5.6-sol", reasoningLevels: ["low", "medium", "high", "xhigh"] }
    ]
  });

  assert.match(payload, /Fix auth/);
  assert.match(payload, /src\/auth\.ts/);
  assert.match(payload, /reasoning/);
  assert.match(payload, /gpt-5\.4-mini/);
  assert.match(payload, /xhigh/);
  assert.match(payload, /\["src\/auth\.ts",123\]/);
  assert.doesNotMatch(payload, /"lines":12/);
  assert.doesNotMatch(payload, /actual source code/);
});

test("compacts repository profile to path and bytes manifest for the classifier", () => {
  const compact = compactRepositoryProfile({
    rootName: "repo",
    totalFiles: 1,
    totalLines: 12,
    totalBytes: 123,
    languageTotals: { TypeScript: { files: 1, lines: 12 } },
    fileCounts: { source: 1, test: 0, config: 0 },
    testsExist: false,
    ciExists: false,
    manifest: { truncated: false, includedFiles: 1, omittedFiles: 0, maxFiles: 2000 },
    promptMatchedFiles: ["src/auth.ts"],
    files: [{ path: "src/auth.ts", lines: 12, bytes: 123 }]
  });

  assert.deepEqual(compact.files, [["src/auth.ts", 123]]);
  assert.equal("totalLines" in compact, false);
  assert.equal("languageTotals" in compact, false);
  assert.equal(compact.tf, 1);
  assert.equal(compact.tb, 123);
});

test("parses turn.completed event and extracts token usage", () => {
  const stdout = [
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 30 },
        output_tokens: 40,
        output_tokens_details: { reasoning_tokens: 10 },
        total_tokens: 140
      },
      output: validClassification
    })
  ].join("\n");

  const parsed = parseCodexJsonl(stdout);
  const usage = extractUsage(parsed.completedEvent, parsed.events);

  assert.equal(parsed.completedEvent.type, "turn.completed");
  assert.deepEqual(usage, {
    inputTokens: 100,
    cachedTokens: 30,
    outputTokens: 40,
    reasoningTokens: 10,
    totalTokens: 140
  });
});

test("runs fixed low-reasoning Codex classifier once in a fresh ephemeral task", async () => {
  const calls = [];
  const result = await runCodexClassifier({
    prompt: "Fix auth",
    repoProfile: { totalFiles: 0, files: [] },
    classifierModel: "must-be-ignored",
    codexBin: "mock-codex",
    env: {
      PATH: process.env.PATH,
      OPENAI_API_KEY: "must-not-leak"
    },
    spawnImpl: makeMockSpawn({
      calls,
      stdout: JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: 10,
          input_tokens_details: { cached_tokens: 1 },
          output_tokens: 5,
          output_tokens_details: { reasoning_tokens: 2 },
          total_tokens: 15
        },
        output: JSON.stringify(validClassification)
      }) + "\n"
    })
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "mock-codex");
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.env.OPENAI_API_KEY, undefined);
  assert.notEqual(calls[0].options.cwd, process.cwd());
  assert.match(calls[0].stdin, /Fix auth/);
  assert.equal(calls[0].args[0], "exec");
  assert.equal(calls[0].args[calls[0].args.indexOf("--model") + 1], CLASSIFIER_MODEL);
  assert(calls[0].args.includes("--ephemeral"));
  assert(calls[0].args.includes("--ignore-user-config"));
  assert(calls[0].args.includes("--ignore-rules"));
  assert(!calls[0].args.includes("resume"));
  assert(calls[0].args.includes(`model_reasoning_effort="${CLASSIFIER_REASONING_EFFORT}"`));
  assert(calls[0].args.includes('model_verbosity="low"'));
  assert(calls[0].args.includes("--output-schema"));
  assert.deepEqual(result.classification, validClassification);
  assert.equal(result.metrics.inputTokens, 10);
  assert.equal(result.metrics.cachedTokens, 1);
  assert.equal(result.metrics.outputTokens, 5);
  assert.equal(result.metrics.reasoningTokens, 2);
  assert.equal(result.metrics.totalTokens, 15);
  assert.equal(result.metrics.schemaValid, true);
});

test("resolves codex executable from PATH when available", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smartcodex-path-test-"));
  const executable = path.join(dir, process.platform === "win32" ? "codex.exe" : "codex");
  fs.writeFileSync(executable, "");

  const resolved = resolveCodexBin("codex", {
    PATH: dir,
    PATHEXT: ".EXE;.CMD"
  });

  assert.equal(resolved, executable);
});

test("prefers spawnable Windows npm command shim over extensionless shim", { skip: process.platform !== "win32" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smartcodex-path-test-"));
  const extensionless = path.join(dir, "codex");
  const cmd = path.join(dir, "codex.cmd");
  fs.writeFileSync(extensionless, "");
  fs.writeFileSync(cmd, "");

  const resolved = resolveCodexBin("codex", {
    PATH: dir,
    PATHEXT: ".EXE;.CMD"
  });

  assert.equal(resolved, cmd);
});

test("resolves Windows npm Codex shim to Node entrypoint without shell", { skip: process.platform !== "win32" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smartcodex-npm-test-"));
  const cmd = path.join(dir, "codex.cmd");
  const entrypoint = path.join(dir, "node_modules", "@openai", "codex", "bin", "codex.js");
  fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
  fs.writeFileSync(cmd, "");
  fs.writeFileSync(entrypoint, "");

  const resolved = resolveCodexCommand("codex", {
    PATH: dir,
    PATHEXT: ".EXE;.CMD"
  });

  assert.equal(resolved.command, process.execPath);
  assert.deepEqual(resolved.argsPrefix, [entrypoint]);
  assert.equal(resolved.resolvedCodexBin, cmd);
});

test("marks classifier JSON invalid when schema does not match", async () => {
  const result = await runCodexClassifier({
    prompt: "Fix auth",
    repoProfile: { totalFiles: 0, files: [] },
    spawnImpl: makeMockSpawn({
      stdout: JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 1, output_tokens: 1 },
        output: { ...validClassification, routeId: "luxury" }
      }) + "\n"
    })
  });

  assert.equal(result.validation.valid, false);
  assert.match(result.validation.errors.join("\n"), /routeId/);
  assert.equal(result.metrics.schemaValid, false);
});

test("throws on invalid JSONL without turn.completed", assert.rejects(async () => {
  parseCodexJsonl("{not json}\n");
}, /turn\.completed/));

test("times out Codex subprocess", async () => {
  await assert.rejects(() => runCodexClassifier({
    prompt: "Fix auth",
    repoProfile: { totalFiles: 0, files: [] },
    timeoutMs: 5,
    spawnImpl: makeMockSpawn({ neverClose: true })
  }), (error) => {
    assert.equal(error.code, "CODEX_TIMEOUT");
    return true;
  });
});

function makeMockSpawn({ calls = [], stdout = "", stderr = "", neverClose = false } = {}) {
  return function mockSpawn(command, args, options) {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {
      child.killed = true;
    };

    const call = { command, args, options, stdin: "" };
    calls.push(call);
    child.stdin.on("data", (chunk) => {
      call.stdin += chunk.toString("utf8");
    });

    process.nextTick(() => {
      child.stdout.end(stdout);
      child.stderr.end(stderr);
      if (!neverClose) {
        child.emit("close", 0);
      }
    });

    return child;
  };
}
