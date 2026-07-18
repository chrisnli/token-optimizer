import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { runCli } from "../src/cli.js";

test("CLI repeat mode records one Codex request per run, saves results, and leaves repo files unchanged", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "smartcodex-cli-test-"));
  const resultsPath = path.join(repo, "results.jsonl");
  const sourcePath = path.join(repo, "src", "app.js");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, "console.log('before');\n");
  const before = fs.readFileSync(sourcePath, "utf8");
  const calls = [];
  const stdout = makeWritableCapture();
  const stderr = makeWritableCapture();
  const stdin = new PassThrough();
  stdin.end();

  const exitCode = await runCli([
    "--model",
    "mock-model",
    "--repeat",
    "2",
    "--save-results",
    resultsPath,
    "Fix app"
  ], {
    cwd: repo,
    env: {
      SMARTCODEX_CLASSIFIER_MODEL: "cheap-fixed-classifier",
      SMARTCODEX_TIMEOUT_MS: "10000"
    },
    stdin,
    stdout,
    stderr
  }, {
    runCodexClassifier: async (request) => {
      calls.push(request);
      return {
        classification: validClassification(),
        metrics: {
          inputTokens: 10,
          cachedTokens: 1,
          outputTokens: 5,
          reasoningTokens: 2,
          totalTokens: 15,
          latencyMs: 20,
          payloadBytes: 200,
          schemaValid: true
        },
        validation: { valid: true, errors: [] }
      };
    }
  });

  assert.equal(exitCode, 0, stderr.text);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].classifierModel, "cheap-fixed-classifier");
  assert.deepEqual(calls[0].routeModels, {
    economy: "gpt-5.4-mini",
    balanced: "gpt-5.4",
    advanced: "gpt-5.6-sol"
  });
  assert.deepEqual(calls[0].routeCandidates, [
    { routeId: "economy", model: "gpt-5.4-mini", reasoningLevels: ["low"] },
    { routeId: "balanced", model: "gpt-5.4", reasoningLevels: ["low", "medium"] },
    { routeId: "advanced", model: "gpt-5.6-sol", reasoningLevels: ["low", "medium", "high", "xhigh"] }
  ]);
  assert.equal(fs.readFileSync(sourcePath, "utf8"), before);

  const report = JSON.parse(stdout.text);
  assert.equal(report.runs.length, 2);
  assert.equal(report.runs[0].classifierModel, "cheap-fixed-classifier");
  assert.equal(report.runs[0].requestedModel, "mock-model");
  assert.equal(report.runs[0].recommendedModel, "gpt-5.4");
  assert.equal(report.runs[0].recommendedReasoningLevel, "medium");
  assert.equal(report.runs[0].summaryRoute, "balanced");
  assert.equal(report.runs[0].recommendedReasoningLevel, "medium");
  assert.equal(report.summary.repeat, 2);
  assert.equal(report.summary.averageTokens.totalTokens, 15);
  assert.equal(report.summary.routeAgreement.routeId, "balanced");
  assert.equal(report.summary.routeAgreement.count, 2);

  const saved = fs.readFileSync(resultsPath, "utf8").trim().split(/\r?\n/);
  assert.equal(saved.length, 2);
});

test("CLI selects the local Ollama classifier without invoking Codex", async () => {
  const stdout = makeWritableCapture();
  const stderr = makeWritableCapture();
  const stdin = new PassThrough();
  stdin.end();
  let codexCalls = 0;
  let ollamaCalls = 0;

  const exitCode = await runCli(["--classifier", "ollama", "Fix auth"], {
    cwd: process.cwd(),
    env: {},
    stdin,
    stdout,
    stderr
  }, {
    runCodexClassifier: async () => {
      codexCalls += 1;
      throw new Error("Codex must not run");
    },
    runOllamaClassifier: async (request) => {
      ollamaCalls += 1;
      assert.equal(request.classifierModel, "qwen3:4b-instruct");
      assert.equal(request.think, true);
      return {
        classification: validClassification(),
        metrics: { inputTokens: 10, cachedTokens: 0, outputTokens: 5, reasoningTokens: 0, totalTokens: 15, latencyMs: 5, payloadBytes: 100, schemaValid: true },
        validation: { valid: true, errors: [] }
      };
    }
  });

  assert.equal(exitCode, 0, stderr.text);
  assert.equal(codexCalls, 0);
  assert.equal(ollamaCalls, 1);
  const report = JSON.parse(stdout.text);
  assert.equal(report.classifier, "ollama");
  assert.equal(report.classifierModel, "qwen3:4b-instruct");
});

function validClassification() {
  return {
    routeId: "balanced",
    reasoningLevel: "medium",
    confidence: 0.86,
    taskType: "bug_fix",
    userIntent: "modify_and_test",
    likelyFilesTouched: 1,
    candidateFiles: ["src/app.js"],
    ambiguity: 1,
    repoInspection: "targeted",
    testing: "related_suite",
    risk: "medium",
    effort: "medium",
    estimatedMinutes: { minimum: 10, maximum: 30 },
    complexity: {
      reasoning: 3,
      repositoryContext: 2,
      implementation: 2,
      verification: 2,
      scope: 2
    },
    reason: "Small app change"
  };
}

function makeWritableCapture() {
  const chunks = [];
  const writable = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    }
  });

  Object.defineProperty(writable, "text", {
    get() {
      return Buffer.concat(chunks).toString("utf8");
    }
  });

  return writable;
}
