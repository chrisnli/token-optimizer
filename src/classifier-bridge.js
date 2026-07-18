import { spawn } from "node:child_process";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findExecutableMatches } from "./codex-command.js";
import { isKnownRoute, modelForRoute } from "./router.js";

const DEFAULT_TIMEOUT_MS = 120000;
const CLASSIFY_BIN_NAME = "smartcodex-classify";

// The prompt always travels over stdin (the classify CLI reads stdin when no prompt
// argument is given), so no argument quoting is ever needed.
export async function classifyPrompt(prompt, { cwd, env = process.env, timeoutMs, spawnImpl = spawn } = {}) {
  const resolved = resolveClassifyCommand(env);
  if (!resolved) {
    return {
      ok: false,
      warning: [
        "classifier not found: set SMARTCODEX_CLASSIFY_BIN or install the",
        `${CLASSIFY_BIN_NAME} CLI (built on the classifier branches).`
      ].join(" ")
    };
  }

  const effectiveTimeout = parsePositiveInteger(env.SMARTCODEX_CLASSIFY_TIMEOUT_MS, timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let invocation;
  try {
    invocation = await runClassifyProcess(resolved, prompt, { cwd, env, timeoutMs: effectiveTimeout, spawnImpl });
  } catch (error) {
    return { ok: false, warning: `classifier failed: ${error.message}` };
  }

  let report;
  try {
    report = JSON.parse(invocation.stdout);
  } catch {
    return { ok: false, warning: "classifier returned output that is not valid JSON" };
  }

  const classification = report && typeof report === "object" ? report.classification : null;
  const routeId = classification && typeof classification === "object" ? classification.routeId : null;
  if (!isKnownRoute(routeId)) {
    return { ok: false, warning: `classifier returned unknown route: ${JSON.stringify(routeId)}` };
  }

  return {
    ok: true,
    routeId,
    confidence: typeof classification.confidence === "number" ? classification.confidence : null,
    reason: typeof classification.reason === "string" ? classification.reason : "",
    model: typeof report.recommendedModel === "string" && report.recommendedModel
      ? report.recommendedModel
      : modelForRoute(routeId, env)
  };
}

export function resolveClassifyCommand(env = process.env) {
  const explicit = env.SMARTCODEX_CLASSIFY_BIN;
  if (explicit) {
    return commandForPath(explicit);
  }

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const sibling = path.join(moduleDir, "..", "bin", `${CLASSIFY_BIN_NAME}.js`);
  if (fsSync.existsSync(sibling)) {
    return { command: process.execPath, args: [sibling], shell: false };
  }

  const matches = findExecutableMatches(CLASSIFY_BIN_NAME, env);
  if (matches.length === 0) {
    return null;
  }
  return commandForPath(matches[0]);
}

function commandForPath(binPath) {
  const lower = binPath.toLowerCase();
  if (lower.endsWith(".js") || lower.endsWith(".mjs")) {
    return { command: process.execPath, args: [binPath], shell: false };
  }

  const npmEntry = findNpmShimEntrypoint(binPath);
  if (npmEntry) {
    return { command: process.execPath, args: [npmEntry], shell: false };
  }

  if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
    // cmd shims need a shell; safe because no arguments are passed (prompt is stdin).
    return { command: `"${binPath}"`, args: [], shell: true };
  }

  return { command: binPath, args: [], shell: false };
}

function findNpmShimEntrypoint(binPath) {
  const basename = path.basename(binPath).toLowerCase();
  if (![CLASSIFY_BIN_NAME, `${CLASSIFY_BIN_NAME}.cmd`, `${CLASSIFY_BIN_NAME}.ps1`].includes(basename)) {
    return null;
  }

  const candidate = path.join(
    path.dirname(binPath),
    "node_modules",
    CLASSIFY_BIN_NAME,
    "bin",
    `${CLASSIFY_BIN_NAME}.js`
  );
  return fsSync.existsSync(candidate) ? candidate : null;
}

function runClassifyProcess(resolved, prompt, { cwd, env, timeoutMs, spawnImpl }) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(resolved.command, resolved.args, {
      cwd,
      env,
      shell: resolved.shell,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
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
      reject(new Error(`timed out after ${timeoutMs}ms`));
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
      reject(error);
    });
    child.on("close", (exitCode) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timeout);
      if (exitCode !== 0) {
        const detail = stderr.trim() || stdout.trim();
        reject(new Error(`exited with status ${exitCode}${detail ? `: ${truncate(detail, 300)}` : ""}`));
        return;
      }
      resolve({ stdout, stderr });
    });

    child.stdin.end(prompt);
  });
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function truncate(value, maxLength) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}
