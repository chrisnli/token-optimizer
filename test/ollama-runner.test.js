import assert from "node:assert/strict";
import test from "node:test";
import { assessRouting, runOllamaClassifier } from "../src/ollama-runner.js";

const classification = {
  routeId: "economy",
  reasoningLevel: "low",
  confidence: 0.9,
  taskType: "bug_fix",
  userIntent: "modify_and_test",
  likelyFilesTouched: 1,
  candidateFiles: ["src/auth.js"],
  ambiguity: 1,
  repoInspection: "targeted",
  testing: "related_suite",
  risk: "low",
  effort: "low",
  estimatedMinutes: { minimum: 5, maximum: 10 },
  complexity: { reasoning: 1, repositoryContext: 1, implementation: 1, verification: 1, scope: 1 },
  reason: "A local auth fix."
};

test("runs a schema-constrained classifier locally through Ollama", async () => {
  const calls = [];
  const result = await runOllamaClassifier({
    prompt: "Fix auth",
    repoProfile: { totalFiles: 1, files: [{ path: "src/auth.js", bytes: 10 }] },
    routeModels: { economy: "gpt-5.4-mini" },
    classifierModel: "qwen3:4b-instruct",
    fetchImpl: async (url, request) => {
      calls.push({ url, request });
      return new Response(JSON.stringify({
        message: { content: JSON.stringify(classification) },
        prompt_eval_count: 42,
        eval_count: 20
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:11434/api/chat");
  const requestBody = JSON.parse(calls[0].request.body);
  assert.equal(requestBody.model, "qwen3:4b-instruct");
  assert.equal(requestBody.messages[0].role, "system");
  assert.match(requestBody.messages[0].content, /authentication, authorization, sessions/);
  assert.equal(requestBody.messages[1].role, "user");
  assert.equal(requestBody.stream, false);
  assert.equal(requestBody.think, true);
  assert.equal(requestBody.options.temperature, 0);
  assert.equal(requestBody.options.num_ctx, 4096);
  assert.equal(requestBody.options.num_predict, 1024);
  assert.deepEqual(requestBody.format.required, classificationKeys());
  assert.match(requestBody.messages[1].content, /src\/auth\.js/);
  assert.equal(result.validation.valid, true);
  assert.deepEqual(result.metrics, {
    inputTokens: 42,
    cachedTokens: 0,
    outputTokens: 20,
    reasoningTokens: 0,
    totalTokens: 62,
    latencyMs: result.metrics.latencyMs,
    payloadBytes: result.metrics.payloadBytes,
    schemaValid: true
  });
});

test("accepts classifier JSON wrapped in incidental model text", async () => {
  const result = await runOllamaClassifier({
    prompt: "Fix auth",
    repoProfile: { totalFiles: 0, files: [] },
    fetchImpl: async () => new Response(JSON.stringify({
      message: { content: `<think>briefly considered</think>\n${JSON.stringify(classification)}` }
    }), { status: 200, headers: { "content-type": "application/json" } })
  });

  assert.equal(result.classification.routeId, "balanced");
  assert.equal(result.classification.reasoningLevel, "medium");
  assert.deepEqual(result.classification.candidateFiles, []);
  assert.match(result.classification.reason, /Model floor balanced/);
  assert.equal(result.validation.valid, true);
});

test("limits local candidate files to eligible prompt-matching paths", async () => {
  const result = await runOllamaClassifier({
    prompt: "Fix auth",
    repoProfile: {
      totalFiles: 2,
      promptMatchedFiles: ["src/auth.js"],
      files: [{ path: "src/auth.js", bytes: 10 }, { path: "src/profile.js", bytes: 10 }]
    },
    fetchImpl: async () => new Response(JSON.stringify({
      message: {
        content: JSON.stringify({
          ...classification,
          candidateFiles: ["src/auth.js", "src/profile.js", "missing.js"]
        })
      }
    }), { status: 200, headers: { "content-type": "application/json" } })
  });

  assert.deepEqual(result.classification.candidateFiles, ["src/auth.js"]);
});

test("uses a non-speculative reason when no credible candidate path exists", async () => {
  const result = await runOllamaClassifier({
    prompt: "Fix auth",
    repoProfile: { totalFiles: 1, promptMatchedFiles: [], files: [{ path: "src/profile.js", bytes: 10 }] },
    fetchImpl: async () => new Response(JSON.stringify({
      message: {
        content: JSON.stringify({
          ...classification,
          routeId: "balanced",
          candidateFiles: ["src/profile.js"],
          reason: "profile.js owns authentication"
        })
      }
    }), { status: 200, headers: { "content-type": "application/json" } })
  });

  assert.deepEqual(result.classification.candidateFiles, []);
  assert.match(result.classification.reason, /reasoning floor medium/);
  assert.doesNotMatch(result.classification.reason, /profile\.js owns/);
});

test("applies an advanced floor to broad authentication migrations", async () => {
  const result = await runOllamaClassifier({
    prompt: "Migrate authentication from local sessions to OAuth with PKCE across the CLI, backend, and tests.",
    repoProfile: { totalFiles: 0, promptMatchedFiles: [], files: [] },
    fetchImpl: async () => new Response(JSON.stringify({
      message: { content: JSON.stringify({ ...classification, routeId: "balanced", reasoningLevel: "medium" }) }
    }), { status: 200, headers: { "content-type": "application/json" } })
  });

  assert.equal(result.classification.routeId, "advanced");
  assert.equal(result.classification.reasoningLevel, "high");
  assert.equal(result.classification.risk, "high");
  assert.equal(result.classification.complexity.scope, 4);
  assert.equal(result.classification.estimatedMinutes.minimum, 60);
  assert.equal(result.routingAssessment.minimumRoute, "advanced");
  assert(result.routingAssessment.signals.includes("migration_or_architecture"));
  assert(result.routingAssessment.signals.includes("broad_cross_cutting_scope"));
  assert.match(result.classification.reason, /Model floor advanced/);
});

test("uses repository size as a multiplier for vague tasks", () => {
  const assessment = assessRouting("Improve the codebase", {
    totalFiles: 1200,
    totalBytes: 20 * 1024 * 1024
  });

  assert.equal(assessment.minimumRoute, "advanced");
  assert.equal(assessment.minimumReasoningLevel, "high");
  assert(assessment.modelSignals.includes("large_repository"));
  assert(assessment.reasoningSignals.includes("very_vague_prompt"));
  assert(assessment.modelSignals.includes("repository_context_multiplier"));
});

test("does not force an exact one-file edit in a large repository to advanced", () => {
  const assessment = assessRouting("Change DEFAULT_TIMEOUT in src/config.js from 30 to 45", {
    totalFiles: 1200,
    totalBytes: 20 * 1024 * 1024
  });

  assert.equal(assessment.minimumRoute, "economy");
  assert.equal(assessment.minimumReasoningLevel, "low");
  assert(assessment.signals.includes("precise_target"));
});

test("forces high-reasoning concurrency work to advanced in a small repository", () => {
  const assessment = assessRouting("Fix a race condition causing duplicate payments during concurrent webhook delivery", {
    totalFiles: 20,
    totalBytes: 10000
  });

  assert.equal(assessment.minimumRoute, "advanced");
  assert.equal(assessment.minimumReasoningLevel, "high");
  assert(assessment.signals.includes("concurrency_or_data_integrity"));
});

test("treats a context-free prompt as very ambiguous", () => {
  const assessment = assessRouting("Fix it", { totalFiles: 20, totalBytes: 10000 });

  assert.equal(assessment.minimumRoute, "balanced");
  assert.equal(assessment.minimumReasoningLevel, "high");
  assert.equal(assessment.promptAmbiguity, "very_high");
});

test("selects an advanced model with medium reasoning for broad mechanical migration", () => {
  const assessment = assessRouting("Apply the documented API migration across all services", {
    totalFiles: 200,
    totalBytes: 2000000
  });

  assert.equal(assessment.minimumRoute, "advanced");
  assert.equal(assessment.minimumReasoningLevel, "medium");
});

test("selects a balanced model with high reasoning for a localized hard algorithm", () => {
  const assessment = assessRouting("Implement a graph algorithm for constrained shortest paths", {
    totalFiles: 20,
    totalBytes: 10000
  });

  assert.equal(assessment.minimumRoute, "balanced");
  assert.equal(assessment.minimumReasoningLevel, "high");
});

test("selects xhigh reasoning independently for zero-downtime data migration", () => {
  const assessment = assessRouting("Plan a zero-downtime database migration changing user IDs across services", {
    totalFiles: 20,
    totalBytes: 10000
  });

  assert.equal(assessment.minimumRoute, "advanced");
  assert.equal(assessment.minimumReasoningLevel, "xhigh");
});

test("reports unavailable Ollama without making a Codex request", async () => {
  await assert.rejects(() => runOllamaClassifier({
    prompt: "Fix auth",
    repoProfile: { totalFiles: 0, files: [] },
    fetchImpl: async () => {
      throw new TypeError("connection refused");
    }
  }), (error) => {
    assert.equal(error.code, "OLLAMA_UNAVAILABLE");
    return true;
  });
});

function classificationKeys() {
  return [
    "routeId", "reasoningLevel", "confidence", "taskType", "userIntent", "likelyFilesTouched",
    "candidateFiles", "ambiguity", "repoInspection", "testing", "risk", "effort", "estimatedMinutes",
    "complexity", "reason"
  ];
}
