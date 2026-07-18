import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { buildClassifierPayload } from "./codex-runner.js";
import { CLASSIFIER_SCHEMA, validateClassifierResult } from "./schema.js";

export const DEFAULT_OLLAMA_MODEL = "qwen3:4b-instruct";
const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
const DEFAULT_TIMEOUT_MS = 30000;
const LARGE_REPO_FILES = 500;
const VERY_LARGE_REPO_FILES = 2000;
const LARGE_REPO_BYTES = 10 * 1024 * 1024;
const VERY_LARGE_REPO_BYTES = 50 * 1024 * 1024;
const LOCAL_CLASSIFIER_GUIDANCE = [
  "You are a conservative routing classifier for coding tasks. Judge the work needed to complete the user's request, not whether the prompt is short.",
  "Choose routeId for model capacity and reasoningLevel independently. routeId reflects repository size, implementation scope, and verification burden only; reasoningLevel reflects ambiguity, diagnostic difficulty, planning, and conceptual complexity only. Do not let ambiguity alone raise routeId or repository size alone raise reasoningLevel. The caller derives a summary route from both results.",
  "Choose the least expensive model and reasoning combination that is likely to succeed. Economy is only for a clearly specified, localized, low-risk edit with an obvious target and little or no verification.",
  "Use balanced for a bug fix with no diagnosed cause or named target, work that needs repository inspection or related tests, several plausible files, or authentication, authorization, sessions, credentials, tokens, permissions, payments, or data handling.",
  "Use advanced for a security vulnerability or incident, credential exposure, broad identity redesign, migration, concurrency, architecture, data loss risk, or likely cross-cutting debugging. Do not make ordinary auth bug fixes advanced by default.",
  "Treat repository size as a complexity multiplier. A precise one-file edit may stay economy in a large repository, but vague, investigative, or broad work in a large repository should be advanced.",
  "The user message includes separate local model and reasoning assessments. Treat each as an independent minimum floor; select a higher option only when the full task warrants it. Advanced may use medium reasoning, and balanced may use high reasoning.",
  "For an unspecified bug fix, assume the cause and affected files are unknown: use at least balanced, ambiguity at least 2, targeted repository inspection, related-suite testing, medium risk and effort, a 15-60 minute estimate, and complexity of at least reasoning 2, repositoryContext 3, implementation 2, verification 3, scope 2.",
  "For an unspecified authentication, authorization, session, credential, token, or permission bug, use the same balanced baseline with ambiguity at least 3 and complexity of at least reasoning 3, repositoryContext 3, implementation 3, verification 3, scope 2.",
  "Candidate files must be supported by the file manifest. If repo.match is empty, return [] unless a file path itself contains a strong subsystem term from the prompt, such as auth, login, session, token, credential, or permission. Never invent a file's responsibility from a generic name.",
  "Use low reasoning for obvious work, medium for bounded planning or ambiguity, high for difficult diagnosis or conceptual work, and xhigh only for multiple compounding reasoning risks. Do not infer reasoning from routeId.",
  "Keep values concise. Return only an object matching the supplied JSON schema."
].join(" ");

export class OllamaInvocationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "OllamaInvocationError";
    Object.assign(this, details);
  }
}

export async function runOllamaClassifier({
  prompt,
  repoProfile,
  routeModels = {},
  routeCandidates = null,
  classifierModel = DEFAULT_OLLAMA_MODEL,
  ollamaUrl = DEFAULT_OLLAMA_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  think = true,
  fetchImpl = fetch
}) {
  const routingAssessment = assessRouting(prompt, repoProfile);
  const payload = `${buildClassifierPayload({ prompt, repoProfile, routeModels, routeCandidates })}\nroutingAssessment:${JSON.stringify(routingAssessment)}`;
  const payloadBytes = Buffer.byteLength(payload, "utf8");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();

  try {
    let response;
    try {
      response = await fetchImpl(`${ollamaUrl.replace(/\/$/, "")}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: classifierModel,
          messages: [
            { role: "system", content: LOCAL_CLASSIFIER_GUIDANCE },
            { role: "user", content: payload }
          ],
          format: CLASSIFIER_SCHEMA,
          stream: false,
          think,
          keep_alive: "10m",
          options: {
            temperature: 0,
            num_ctx: 4096,
            num_predict: 1024
          }
        })
      });
    } catch (error) {
      if (error.name === "AbortError") {
        throw new OllamaInvocationError(`Ollama classifier timed out after ${timeoutMs}ms`, {
          code: "OLLAMA_TIMEOUT"
        });
      }
      throw new OllamaInvocationError(
        `Could not reach Ollama at ${ollamaUrl}. Install and start Ollama, then run smartcodex-classify --setup-ollama.`,
        { code: "OLLAMA_UNAVAILABLE", cause: error }
      );
    }

    const body = await readJson(response);
    if (!response.ok) {
      throw new OllamaInvocationError(body?.error || `Ollama returned HTTP ${response.status}`, {
        code: "OLLAMA_HTTP_ERROR",
        statusCode: response.status
      });
    }

    let classification;
    try {
      classification = parseJsonObject(body?.message?.content);
    } catch (error) {
      throw new OllamaInvocationError("Ollama did not return valid classifier JSON", {
        code: "OLLAMA_INVALID_JSON",
        cause: error,
        responsePreview: responsePreview(body)
      });
    }

    classification = constrainCandidateFiles(classification, repoProfile);
    classification = applyRoutingFloor(classification, routingAssessment);
    const validation = validateClassifierResult(classification);
    const inputTokens = numberOrNull(body.prompt_eval_count);
    const outputTokens = numberOrNull(body.eval_count);
    return {
      classification,
      routingAssessment,
      validation,
      metrics: {
        inputTokens,
        cachedTokens: 0,
        outputTokens,
        reasoningTokens: 0,
        totalTokens: inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens,
        latencyMs: Math.round(performance.now() - startedAt),
        payloadBytes,
        schemaValid: validation.valid
      }
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function pullOllamaModel({
  model = DEFAULT_OLLAMA_MODEL,
  ollamaBin = "ollama",
  env = process.env,
  spawnImpl = spawn
}) {
  const command = resolveOllamaBin(ollamaBin, env);
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, ["pull", model], {
      shell: false,
      windowsHide: true,
      stdio: "inherit",
      env
    });
    child.on("error", (error) => reject(new OllamaInvocationError(
      `Failed to start Ollama: ${error.message}. Install Ollama from https://ollama.com/download and ensure "ollama" is on PATH.`,
      { code: "OLLAMA_START_FAILED", cause: error }
    )));
    child.on("close", (exitCode) => {
      if (exitCode === 0) {
        resolve();
        return;
      }
      reject(new OllamaInvocationError(`Ollama model download exited with status ${exitCode}`, {
        code: "OLLAMA_PULL_FAILED",
        exitCode
      }));
    });
  });
}

export function localClassifierModel(env = process.env) {
  return env.SMARTCODEX_OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL;
}

export function localClassifierThinking(env = process.env) {
  return env.SMARTCODEX_OLLAMA_THINK !== "false";
}

export { LOCAL_CLASSIFIER_GUIDANCE };

export function resolveOllamaBin(ollamaBin = "ollama", env = process.env) {
  if (ollamaBin.includes("/") || ollamaBin.includes("\\") || path.isAbsolute(ollamaBin)) {
    return ollamaBin;
  }

  if (process.platform !== "win32") {
    return ollamaBin;
  }

  const result = spawnSync("where.exe", [ollamaBin], {
    encoding: "utf8",
    env,
    shell: false,
    windowsHide: true
  });
  const matches = result.status === 0
    ? result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    : [];
  return matches.find((candidate) => path.extname(candidate).toLowerCase() === ".exe") || matches[0] || ollamaBin;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseJsonObject(content) {
  if (typeof content !== "string") {
    throw new Error("Ollama response did not include message.content");
  }

  try {
    return JSON.parse(content);
  } catch {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start === -1 || end <= start) {
      throw new Error("Ollama response did not contain a complete JSON object");
    }
    return JSON.parse(content.slice(start, end + 1));
  }
}

function responsePreview(body) {
  const content = body?.message?.content;
  const thinking = body?.message?.thinking;
  const preview = typeof content === "string" ? content : typeof thinking === "string" ? thinking : JSON.stringify(body);
  return preview.slice(0, 800);
}

function constrainCandidateFiles(classification, repoProfile) {
  if (!classification || !Array.isArray(classification.candidateFiles)) {
    return classification;
  }

  const promptMatches = new Set(repoProfile.promptMatchedFiles || []);
  const eligible = new Set((repoProfile.files || []).map((file) => file.path));
  const candidateFiles = classification.candidateFiles.filter((file) =>
    eligible.has(file) && promptMatches.has(file)
  );
  return {
    ...classification,
    candidateFiles,
    reason: candidateFiles.length === 0 && classification.routeId !== "advanced"
      ? genericReasonForRoute(classification.routeId)
      : classification.reason
  };
}

export function assessRouting(prompt, repoProfile = {}) {
  const text = prompt.toLowerCase();
  const tokens = text.match(/[a-z0-9_]+/g) || [];
  const genericWords = new Set([
    "a", "an", "and", "app", "application", "better", "bug", "change", "code", "codebase",
    "do", "fix", "improve", "issue", "it", "make", "problem", "project", "the", "this", "update"
  ]);
  const meaningfulTokens = tokens.filter((token) => !genericWords.has(token));
  const exactTarget = /(?:^|[\s"'`])[^\s"'`]+\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|cs|cpp|c|h|json|ya?ml|toml|md)(?=$|[\s"'`,:])/i.test(prompt) ||
    /\b(?:function|method|class|constant|flag|endpoint)\s+[\w.-]+/i.test(prompt) ||
    /--[a-z][\w-]*/i.test(prompt);
  const vague = !exactTarget && tokens.length <= 6;
  const veryVague = !exactTarget && tokens.length <= 4 && meaningfulTokens.length === 0;
  const security = /\b(vulnerab\w*|bypass|injection|credential\s+(?:leak|exposure)|account takeover|privilege escalation|authorization flaw|security incident)\b/.test(text);
  const identityWork = /\b(auth(?:entication|orization)?|oauth|pkce|session|identity|credential|token|permission)\b/.test(text);
  const concurrency = /\b(race condition|deadlock|concurren\w*|idempoten\w*|duplicate (?:payment|event|write)|transaction isolation|distributed lock|data consistency)\b/.test(text);
  const migration = /\b(migrat\w*|architecture|redesign|replatform|framework upgrade|split (?:the )?service|monorepo)\b/.test(text);
  const difficultDebugging = /\b(intermittent|nondeterministic|flaky|only in production|memory leak|performance regression|heisenbug|root cause|investigat\w*)\b/.test(text);
  const broadScope = /\b(across|entire codebase|system-wide|all services|backend and frontend|frontend and backend|multiple services|whole project)\b/.test(text);
  const highReasoning = /\b(algorithm|compiler|parser|distributed system|architecture|formal verification|cryptograph\w*|performance optimization)\b/.test(text);
  const operationalDataRisk = /\b(zero[- ]downtime|database migration|schema migration|backfill|user ids?|primary keys?|foreign keys?|referential integrity|dual[- ]write|data loss)\b/.test(text);
  const unspecifiedBug = !exactTarget && /\b(?:fix|debug|resolve)\b.*\b(?:bug|issue|problem)\b/.test(text);
  const unspecifiedIdentityWork = !exactTarget && identityWork && /\b(?:fix|debug|resolve|investigate)\b/.test(text);
  const totalFiles = repoProfile.totalFiles || 0;
  const totalBytes = repoProfile.totalBytes || 0;
  const veryLargeRepo = totalFiles >= VERY_LARGE_REPO_FILES || totalBytes >= VERY_LARGE_REPO_BYTES;
  const largeRepo = veryLargeRepo || totalFiles >= LARGE_REPO_FILES || totalBytes >= LARGE_REPO_BYTES;
  const modelSignals = [];
  const reasoningSignals = [];
  let modelScore = 0;
  let reasoningScore = 0;

  const addModel = (id, weight) => {
    modelSignals.push(id);
    modelScore += weight;
  };
  const addReasoning = (id, weight) => {
    reasoningSignals.push(id);
    reasoningScore += weight;
  };

  if (veryLargeRepo) addModel("very_large_repository", 4);
  else if (largeRepo) addModel("large_repository", 2);
  if (veryVague) addReasoning("very_vague_prompt", 4);
  else if (vague) addReasoning("vague_prompt", 2);
  if (unspecifiedBug) {
    addReasoning("unspecified_bug", 1);
  }
  if (unspecifiedIdentityWork && !unspecifiedBug) {
    addReasoning("unspecified_identity_work", 1);
  }
  if (security) {
    addModel("security_or_access_risk", 5);
    addReasoning("security_or_access_risk", 4);
  }
  if (concurrency) {
    addModel("concurrency_or_data_integrity", 5);
    addReasoning("concurrency_or_data_integrity", 4);
  }
  if (migration) {
    addModel("migration_or_architecture", 2);
    addReasoning("migration_or_architecture", 2);
  }
  if (identityWork && migration) {
    addModel("identity_or_access_migration", 2);
    addReasoning("identity_or_access_migration", 3);
  }
  if (operationalDataRisk) {
    addModel("operational_data_migration_risk", 3);
    addReasoning("operational_data_migration_risk", 5);
  }
  if (difficultDebugging) {
    addModel("difficult_debugging", 3);
    addReasoning("difficult_debugging", 4);
  }
  if (broadScope) {
    addModel("broad_cross_cutting_scope", 3);
    addReasoning("broad_cross_cutting_scope", 1);
  }
  if (highReasoning) {
    addModel("high_reasoning_domain", 2);
    addReasoning("high_reasoning_domain", 4);
  }
  if (largeRepo && (broadScope || migration || operationalDataRisk)) addModel("repository_context_multiplier", 2);
  if (exactTarget && !security && !concurrency) {
    modelSignals.push("precise_target");
    reasoningSignals.push("precise_target");
    modelScore = Math.max(0, modelScore - 2);
    reasoningScore = Math.max(0, reasoningScore - 1);
  }

  const minimumRoute = modelScore >= 5 ? "advanced" : modelScore >= 2 ? "balanced" : "economy";
  const minimumReasoningLevel = reasoningScore >= 7
    ? "xhigh"
    : reasoningScore >= 4 ? "high" : reasoningScore >= 2 ? "medium" : "low";
  const signals = [...new Set([...modelSignals, ...reasoningSignals])];

  return {
    modelScore,
    reasoningScore,
    minimumRoute,
    minimumReasoningLevel,
    repositoryScale: veryLargeRepo ? "very_large" : largeRepo ? "large" : "small_or_medium",
    promptAmbiguity: veryVague ? "very_high" : vague ? "high" : exactTarget ? "low" : "medium",
    modelSignals,
    reasoningSignals,
    signals
  };
}

function applyRoutingFloor(classification, assessment) {
  const routeRank = { economy: 0, balanced: 1, advanced: 2 };
  const reasoningRank = { low: 0, medium: 1, high: 2, xhigh: 3 };
  const routeRaised = routeRank[classification.routeId] < routeRank[assessment.minimumRoute];
  const reasoningRaised = reasoningRank[classification.reasoningLevel] < reasoningRank[assessment.minimumReasoningLevel];
  if (!routeRaised && !reasoningRaised) {
    return classification;
  }

  const routeId = routeRaised ? assessment.minimumRoute : classification.routeId;
  const reasoningLevel = reasoningRaised ? assessment.minimumReasoningLevel : classification.reasoningLevel;
  const modelRank = routeRank[routeId];
  const finalReasoningRank = reasoningRank[reasoningLevel];
  const advanced = modelRank === 2;
  const balanced = modelRank === 1;
  const complexityFloor = {
    reasoning: [1, 3, 4, 5][finalReasoningRank],
    repositoryContext: advanced ? 4 : balanced ? 3 : 1,
    implementation: advanced ? 4 : balanced ? 2 : 1,
    verification: Math.max(advanced ? 4 : balanced ? 3 : 1, finalReasoningRank + 1),
    scope: advanced ? 4 : balanced ? 2 : 1
  };
  const highRisk = assessment.signals.some((signal) =>
    signal === "security_or_access_risk" ||
    signal === "concurrency_or_data_integrity" ||
    signal === "identity_or_access_migration"
  );

  return {
    ...classification,
    routeId,
    reasoningLevel,
    likelyFilesTouched: Math.max(classification.likelyFilesTouched || 0, advanced ? 4 : 2),
    ambiguity: Math.max(classification.ambiguity || 0, assessment.promptAmbiguity === "very_high" ? 4 : assessment.promptAmbiguity === "high" ? 3 : 2),
    repoInspection: advanced ? "broad" : "targeted",
    testing: advanced
      ? (highRisk ? "full_suite_and_risk_regression" : "full_suite_and_targeted_regression")
      : "related_suite",
    risk: highRisk ? "high" : classification.risk === "low" ? "medium" : classification.risk,
    effort: advanced ? "high" : balanced && classification.effort === "low" ? "medium" : classification.effort,
    estimatedMinutes: {
      minimum: Math.max(classification.estimatedMinutes?.minimum || 0, reasoningLevel === "xhigh" ? 90 : advanced ? 60 : balanced ? 15 : 5),
      maximum: Math.max(classification.estimatedMinutes?.maximum || 0, reasoningLevel === "xhigh" ? 300 : advanced ? 240 : balanced ? 60 : 15)
    },
    complexity: Object.fromEntries(Object.entries(complexityFloor).map(([key, value]) => [
      key,
      Math.max(classification.complexity?.[key] || 0, value)
    ])),
    reason: routingReason(assessment)
  };
}

function routingReason(assessment) {
  const labels = {
    very_large_repository: "very large repository context",
    large_repository: "large repository context",
    very_vague_prompt: "very high prompt ambiguity",
    vague_prompt: "prompt ambiguity",
    security_or_access_risk: "security or access risk",
    concurrency_or_data_integrity: "concurrency or data-integrity risk",
    migration_or_architecture: "migration or architecture scope",
    identity_or_access_migration: "identity and access migration risk",
    difficult_debugging: "difficult debugging",
    broad_cross_cutting_scope: "cross-cutting scope",
    high_reasoning_domain: "high reasoning requirements",
    repository_context_multiplier: "repository discovery cost",
    operational_data_migration_risk: "zero-downtime or data-migration risk",
    unspecified_bug: "an undiagnosed bug",
    unspecified_identity_work: "unresolved identity or access behavior"
  };
  const modelReasons = assessment.modelSignals.filter((signal) => labels[signal]).slice(0, 3).map((signal) => labels[signal]);
  const reasoningReasons = assessment.reasoningSignals.filter((signal) => labels[signal]).slice(0, 3).map((signal) => labels[signal]);
  return `Model floor ${assessment.minimumRoute} because of ${joinReasons(modelReasons)}; reasoning floor ${assessment.minimumReasoningLevel} because of ${joinReasons(reasoningReasons)}.`;
}

function joinReasons(reasons) {
  if (reasons.length <= 1) return reasons[0] || "the required repository work";
  if (reasons.length === 2) return `${reasons[0]} and ${reasons[1]}`;
  return `${reasons.slice(0, -1).join(", ")}, and ${reasons.at(-1)}`;
}

function genericReasonForRoute(routeId) {
  if (routeId === "economy") {
    return "The request appears localized and low risk.";
  }
  if (routeId === "advanced") {
    return "The request likely needs broad investigation and careful verification.";
  }
  return "The cause and affected files are unknown, so targeted inspection and related tests are needed.";
}
