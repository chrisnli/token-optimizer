import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const binPath = path.join(repoRoot, "bin", "smartcodex.js");

function runHarnessProcess(args, stdinText, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...extraEnv },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`harness did not exit; stdout so far:\n${stdout}\nstderr:\n${stderr}`));
    }, 15000);

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      resolve({ exitCode, stdout, stderr });
    });

    child.stdin.end(stdinText);
  });
}

test("scripted session: manual model, resume, /new, /auto, /quit", async () => {
  const stubDir = await fs.mkdtemp(path.join(os.tmpdir(), "smartcodex-e2e-"));
  const stubPath = path.join(stubDir, "stub-classify.js");
  const report = {
    recommendedModel: "stub-model",
    recommendedReasoningLevel: "low",
    classification: { routeId: "economy", confidence: 0.9, reason: "stubbed" }
  };
  await fs.writeFile(stubPath, `process.stdout.write(${JSON.stringify(JSON.stringify(report))});`, "utf8");

  try {
    const session = [
      "/model my-model",
      "hello world",
      "again",
      "/new",
      "third one",
      "/auto on",
      "auto please",
      "/quit",
      ""
    ].join("\n");

    const result = await runHarnessProcess(["--dry-run", "--manual"], session, {
      SMARTCODEX_CLASSIFY_BIN: stubPath
    });

    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes("smartcodex (auto: off"));
    assert.ok(result.stdout.includes('[dry-run] codex exec --model my-model "hello world"'));
    assert.ok(result.stdout.includes("[dry-run] codex exec resume --last --model my-model again"));
    assert.ok(result.stdout.includes('[dry-run] codex exec --model my-model "third one"'));
    assert.ok(result.stdout.includes("[auto] stub-model · reasoning low"));
    assert.ok(!result.stdout.includes("route="));
    assert.ok(!result.stdout.includes("confidence"));
    assert.ok(result.stdout.includes("model_reasoning_effort"));
    assert.ok(result.stdout.includes('"auto please"'));
    assert.ok(result.stdout.includes("codex exec resume --last --model stub-model"));
  } finally {
    await fs.rm(stubDir, { recursive: true, force: true });
  }
});

test("initial prompt argument runs as the first turn", async () => {
  const result = await runHarnessProcess(["--dry-run", "--model", "x", "hi there"], "");
  assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  assert.ok(result.stdout.includes('[dry-run] codex exec --model x "hi there"'));
});

test("auto mode is on by default and classifies the first prompt", async () => {
  const stubDir = await fs.mkdtemp(path.join(os.tmpdir(), "smartcodex-e2e-"));
  const stubPath = path.join(stubDir, "stub-classify.js");
  const report = {
    recommendedModel: "stub-model",
    recommendedReasoningLevel: "low",
    classification: { routeId: "economy", confidence: 0.9, reason: "stubbed" }
  };
  await fs.writeFile(stubPath, `process.stdout.write(${JSON.stringify(JSON.stringify(report))});`, "utf8");
  try {
    const result = await runHarnessProcess(["--dry-run"], "whats 1+1\n/quit\n", {
      SMARTCODEX_CLASSIFY_BIN: stubPath
    });
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes("smartcodex (auto: on"));
    assert.ok(result.stdout.includes("[auto] stub-model · reasoning low"));
    assert.ok(result.stdout.includes('[dry-run] codex exec --model stub-model'));
  } finally {
    await fs.rm(stubDir, { recursive: true, force: true });
  }
});

test("--manual starts in manual mode and passes no model to codex", async () => {
  const result = await runHarnessProcess(["--dry-run", "--manual"], "whats 1+1\n/quit\n");
  assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  assert.ok(result.stdout.includes("smartcodex (auto: off"));
  assert.ok(!result.stdout.includes("[auto]"));
  assert.ok(result.stdout.includes('[dry-run] codex exec "whats 1+1"'));
});

test("--model pins a model and does not auto-classify", async () => {
  const result = await runHarnessProcess(["--dry-run", "--model", "gpt-5.4", "whats 1+1"], "/quit\n");
  assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  assert.ok(result.stdout.includes("smartcodex (auto: off"));
  assert.ok(!result.stdout.includes("[auto]"));
  assert.ok(result.stdout.includes('[dry-run] codex exec --model gpt-5.4 "whats 1+1"'));
});

test("--help prints usage without starting a session", async () => {
  const result = await runHarnessProcess(["--help"], "");
  assert.equal(result.exitCode, 0);
  assert.ok(result.stdout.includes("Usage:"));
  assert.ok(result.stdout.includes("/auto"));
});

test("unknown option exits with usage error", async () => {
  const result = await runHarnessProcess(["--bogus"], "");
  assert.equal(result.exitCode, 2);
  assert.ok(result.stderr.includes("Unknown option: --bogus"));
});
