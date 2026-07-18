import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { CODEX_OUTPUT_SCHEMA, ROUTES, validateClassifierResult } from "./schema.js";

const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_CLASSIFIER_MODEL = "gpt-5.4-mini";

export class CodexInvocationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "CodexInvocationError";
    Object.assign(this, details);
  }
}

export function buildClassifierPayload({ prompt, repoProfile, routeModels = {}, routeCandidates = null }) {
  const compactProfile = compactRepositoryProfile(repoProfile);
  return `Classify. Determine routeId and reasoningLevel independently, then report both. routeId selects model capacity from repository size, implementation scope, and verification burden only. reasoningLevel selects thinking effort from ambiguity, diagnostic difficulty, and conceptual complexity only. Do not let ambiguity alone raise routeId or repository size alone raise reasoningLevel. The caller derives the summary route from both results. Choose the lowest expected total token use that is still likely to finish correctly. Do not execute or inspect files. Return only JSON. Keep strings terse, use at most 6 candidate files, and use labels such as "targeted" or "related_suite" where appropriate.\n${JSON.stringify({
    prompt,
    repo: compactProfile,
    routes: routeRows(routeModels, routeCandidates)
  })}`;
}

function routeRows(routeModels, routeCandidates) {
  const candidateByRoute = new Map((routeCandidates || []).map((candidate) => [candidate.routeId, candidate]));
  return ROUTES.map((route) => {
    const candidate = candidateByRoute.get(route.routeId);
    return [
      route.routeId,
      candidate?.model || routeModels[route.routeId] || "",
      candidate?.reasoningLevels || [],
      route.description
    ];
  });
}

export function compactRepositoryProfile(repoProfile) {
  return {
    n: repoProfile.rootName,
    tf: repoProfile.totalFiles,
    tb: repoProfile.totalBytes,
    c: repoProfile.fileCounts,
    test: repoProfile.testsExist,
    ci: repoProfile.ciExists,
    trunc: Boolean(repoProfile.manifest?.truncated),
    omitted: repoProfile.manifest?.omittedFiles || 0,
    match: repoProfile.promptMatchedFiles || [],
    files: (repoProfile.files || []).map((file) => [file.path, file.bytes])
  };
}

export async function runCodexClassifier({
  prompt,
  repoProfile,
  classifierModel = DEFAULT_CLASSIFIER_MODEL,
  routeModels = {},
  routeCandidates = null,
  codexBin = "codex",
  timeoutMs = DEFAULT_TIMEOUT_MS,
  env = process.env,
  spawnImpl = spawn
}) {
  const payload = buildClassifierPayload({ prompt, repoProfile, routeModels, routeCandidates });
  const payloadBytes = Buffer.byteLength(payload, "utf8");
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "smartcodex-classify-"));
  const schemaPath = path.join(tempDir, "classifier-output.schema.json");
  await fs.writeFile(schemaPath, JSON.stringify(CODEX_OUTPUT_SCHEMA), "utf8");
  const childEnv = sanitizeCodexEnv(env);
  const codexCommand = resolveCodexCommand(codexBin, childEnv);
  const args = [
    "exec",
    "--model",
    classifierModel,
    "--sandbox",
    "read-only",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--json",
    "--output-schema",
    schemaPath,
    "-c",
    "model_reasoning_effort=\"low\"",
    "-"
  ];

  const startedAt = performance.now();

  try {
    const invocation = await spawnCodex({
      codexBin,
      command: codexCommand.command,
      args: [...codexCommand.argsPrefix, ...args],
      cwd: tempDir,
      payload,
      timeoutMs,
      env: childEnv,
      spawnImpl
    });
    const latencyMs = Math.round(performance.now() - startedAt);
    const parsed = parseCodexJsonl(invocation.stdout);
    const classification = extractClassification(parsed.completedEvent, parsed.events, invocation.stdout);
    const validation = validateClassifierResult(classification);
    const usage = extractUsage(parsed.completedEvent, parsed.events);

    return {
      classification,
      validation,
      metrics: {
        inputTokens: usage.inputTokens,
        cachedTokens: usage.cachedTokens,
        outputTokens: usage.outputTokens,
        reasoningTokens: usage.reasoningTokens,
        totalTokens: usage.totalTokens,
        latencyMs,
        payloadBytes,
        schemaValid: validation.valid
      },
      codex: {
        args,
        cwd: tempDir,
        command: codexCommand.command,
        argsPrefix: codexCommand.argsPrefix,
        exitCode: invocation.exitCode
      }
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function spawnCodex({ codexBin, command, args, cwd, payload, timeoutMs, env, spawnImpl }) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env
    });

    let stdout = "";
    let stderr = "";
    let finished = false;
    const timeout = setTimeout(() => {
      if (finished) {
        return;
      }
      finished = true;
      child.kill("SIGTERM");
      reject(new CodexInvocationError(`Codex classifier timed out after ${timeoutMs}ms`, {
        code: "CODEX_TIMEOUT",
        stdout,
        stderr
      }));
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timeout);
      reject(new CodexInvocationError(codexStartMessage(error, codexBin, command), {
        code: "CODEX_START_FAILED",
        cause: error,
        command,
        stdout,
        stderr
      }));
    });
    child.on("close", (exitCode) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timeout);
      if (exitCode !== 0) {
        reject(new CodexInvocationError(`Codex exited with status ${exitCode}`, {
          code: "CODEX_EXIT_NONZERO",
          exitCode,
          command,
          stdout,
          stderr
        }));
        return;
      }
      resolve({ stdout, stderr, exitCode });
    });

    child.stdin.end(payload);
  });
}

export function resolveCodexCommand(codexBin = "codex", env = process.env) {
  const resolvedCodexBin = resolveCodexBin(codexBin, env);
  const npmEntrypoint = findNpmCodexEntrypoint(resolvedCodexBin);
  if (npmEntrypoint) {
    return {
      command: process.execPath,
      argsPrefix: [npmEntrypoint],
      resolvedCodexBin
    };
  }

  if (resolvedCodexBin.toLowerCase().endsWith(".js")) {
    return {
      command: process.execPath,
      argsPrefix: [resolvedCodexBin],
      resolvedCodexBin
    };
  }

  return {
    command: resolvedCodexBin,
    argsPrefix: [],
    resolvedCodexBin
  };
}

export function resolveCodexBin(codexBin = "codex", env = process.env) {
  if (hasPathSeparator(codexBin) || path.isAbsolute(codexBin)) {
    return codexBin;
  }

  const whereMatches = process.platform === "win32" ? findWithWhere(codexBin, env) : [];
  const pathMatches = findOnPath(codexBin, env);
  const matches = [...whereMatches, ...pathMatches];
  const unique = [...new Set(matches)];
  return bestWindowsCommandMatch(unique) || unique[0] || codexBin;
}

function findNpmCodexEntrypoint(resolvedCodexBin) {
  if (process.platform !== "win32") {
    return null;
  }

  const basename = path.basename(resolvedCodexBin).toLowerCase();
  if (!["codex", "codex.cmd", "codex.ps1"].includes(basename)) {
    return null;
  }

  const candidate = path.join(
    path.dirname(resolvedCodexBin),
    "node_modules",
    "@openai",
    "codex",
    "bin",
    "codex.js"
  );

  return fsSync.existsSync(candidate) ? candidate : null;
}

function bestWindowsCommandMatch(matches) {
  if (process.platform !== "win32") {
    return null;
  }

  const preference = [".exe", ".cmd", ".bat", ".com"];
  return [...matches]
    .sort((a, b) => {
      const aScore = extensionPreferenceScore(a, preference);
      const bScore = extensionPreferenceScore(b, preference);
      return aScore - bScore || a.localeCompare(b);
    })[0] || null;
}

function extensionPreferenceScore(filePath, preference) {
  const extension = path.extname(filePath).toLowerCase();
  const index = preference.indexOf(extension);
  return index === -1 ? preference.length : index;
}

function findWithWhere(command, env) {
  const result = spawnSync("where.exe", [command], {
    encoding: "utf8",
    env,
    shell: false,
    windowsHide: true
  });

  if (result.status !== 0 || !result.stdout) {
    return [];
  }

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function findOnPath(command, env) {
  const pathValue = env.PATH || env.Path || env.path || "";
  const extensions = process.platform === "win32"
    ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];
  const names = path.extname(command)
    ? [command]
    : ["", ...extensions].map((extension) => `${command}${extension.toLowerCase()}`);

  const matches = [];
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (fsSync.existsSync(candidate)) {
        matches.push(candidate);
      }
    }
  }
  return matches;
}

function hasPathSeparator(value) {
  return value.includes("/") || value.includes("\\");
}

function codexStartMessage(error, codexBin, resolvedCodexBin) {
  if (error.code === "ENOENT") {
    return [
      `Failed to start Codex: ${error.message}.`,
      `Could not find "${codexBin}" on PATH.`,
      "Install or expose the Codex CLI, or set SMARTCODEX_CODEX_BIN to the full codex executable path."
    ].join(" ");
  }

  if (error.code === "EPERM" || error.code === "EACCES") {
    return [
      `Failed to start Codex: ${error.message}.`,
      `Resolved command was "${resolvedCodexBin}".`,
      "That path may be a Windows packaged-app alias that cannot be spawned directly.",
      "Set SMARTCODEX_CODEX_BIN to a spawnable Codex CLI executable."
    ].join(" ");
  }

  return `Failed to start Codex: ${error.message}`;
}

export function sanitizeCodexEnv(env) {
  const sanitized = { ...env };
  for (const key of Object.keys(sanitized)) {
    if (isApiKeyEnvName(key)) {
      delete sanitized[key];
    }
  }
  return sanitized;
}

function isApiKeyEnvName(key) {
  const upper = key.toUpperCase();
  return upper === "OPENAI_API_KEY" ||
    upper.endsWith("_OPENAI_API_KEY") ||
    upper === "AZURE_OPENAI_API_KEY" ||
    upper === "ANTHROPIC_API_KEY";
}

export function parseCodexJsonl(stdout) {
  const events = [];
  const parseErrors = [];

  for (const [index, line] of stdout.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      events.push(JSON.parse(trimmed));
    } catch (error) {
      parseErrors.push({ line: index + 1, message: error.message });
    }
  }

  const completedEvent = events.findLast((event) => eventType(event) === "turn.completed");
  if (!completedEvent) {
    throw new CodexInvocationError("Codex JSONL did not contain a turn.completed event", {
      code: "CODEX_MISSING_TURN_COMPLETED",
      parseErrors,
      stdout
    });
  }

  return {
    events,
    completedEvent,
    parseErrors
  };
}

export function extractUsage(completedEvent, events = []) {
  const usageSource = findUsage(completedEvent) || events.findLast((event) => findUsage(event));
  const usage = usageSource ? findUsage(usageSource) : {};
  const inputTokens = firstNumber(
    usage.input_tokens,
    usage.inputTokens,
    usage.prompt_tokens,
    usage.promptTokens
  );
  const cachedTokens = firstNumber(
    usage.cached_tokens,
    usage.cachedTokens,
    usage.cached_input_tokens,
    usage.cachedInputTokens,
    usage.input_tokens_details?.cached_tokens,
    usage.prompt_tokens_details?.cached_tokens
  );
  const outputTokens = firstNumber(
    usage.output_tokens,
    usage.outputTokens,
    usage.completion_tokens,
    usage.completionTokens
  );
  const reasoningTokens = firstNumber(
    usage.reasoning_tokens,
    usage.reasoningTokens,
    usage.reasoning_output_tokens,
    usage.reasoningOutputTokens,
    usage.output_tokens_details?.reasoning_tokens,
    usage.completion_tokens_details?.reasoning_tokens
  );
  const totalTokens = firstNumber(
    usage.total_tokens,
    usage.totalTokens,
    inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null
  );

  return {
    inputTokens,
    cachedTokens,
    outputTokens,
    reasoningTokens,
    totalTokens
  };
}

export function extractClassification(completedEvent, events = [], stdout = "") {
  const direct = findClassifierObject(completedEvent);
  if (direct) {
    return direct;
  }

  for (const event of events.toReversed()) {
    const found = findClassifierObject(event);
    if (found) {
      return found;
    }
  }

  const stringCandidate = findJsonString(completedEvent) || findJsonString(events.toReversed()) || stdout;
  const parsed = parseJsonObjectFromText(stringCandidate);
  if (parsed) {
    const found = findClassifierObject(parsed);
    if (found) {
      return found;
    }
  }

  throw new CodexInvocationError("Unable to extract classifier JSON from Codex output", {
    code: "CODEX_CLASSIFIER_JSON_MISSING",
    stdout
  });
}

function eventType(event) {
  return event?.type || event?.event || event?.name || event?.msg?.type || event?.message?.type;
}

function findUsage(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) {
    return null;
  }
  seen.add(value);

  if (value.usage && typeof value.usage === "object") {
    return value.usage;
  }
  if (
    hasAnyKey(value, [
      "input_tokens",
      "inputTokens",
      "prompt_tokens",
      "output_tokens",
      "outputTokens",
      "completion_tokens",
      "total_tokens",
      "totalTokens"
    ])
  ) {
    return value;
  }

  for (const child of Object.values(value)) {
    const found = findUsage(child, seen);
    if (found) {
      return found;
    }
  }
  return null;
}

function findClassifierObject(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) {
    return null;
  }
  seen.add(value);

  if (!Array.isArray(value) && typeof value.routeId === "string" && "confidence" in value) {
    return value;
  }

  for (const child of Object.values(value)) {
    if (typeof child === "string") {
      const parsed = parseJsonObjectFromText(child);
      if (parsed) {
        const found = findClassifierObject(parsed, seen);
        if (found) {
          return found;
        }
      }
      continue;
    }
    const found = findClassifierObject(child, seen);
    if (found) {
      return found;
    }
  }

  return null;
}

function findJsonString(value, seen = new Set()) {
  if (typeof value === "string" && value.includes("{")) {
    return value;
  }
  if (!value || typeof value !== "object" || seen.has(value)) {
    return null;
  }
  seen.add(value);

  for (const child of Object.values(value)) {
    const found = findJsonString(child, seen);
    if (found) {
      return found;
    }
  }
  return null;
}

function parseJsonObjectFromText(text) {
  if (typeof text !== "string") {
    return null;
  }

  const trimmed = text.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  } catch {
    // Continue with substring extraction below.
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function hasAnyKey(value, keys) {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function firstNumber(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

export function fixedClassifierModel(env = process.env) {
  return env.SMARTCODEX_CLASSIFIER_MODEL || DEFAULT_CLASSIFIER_MODEL;
}
