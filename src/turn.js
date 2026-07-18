import { spawn } from "node:child_process";
import { codexStartMessage, resolveCodexCommand } from "./codex-command.js";
import { createLineSplitter, createStyler, createTurnRenderer, usageTotalTokens } from "./render.js";

export function buildTurnArgs(spec) {
  const args = ["exec"];
  if (!spec.fresh) {
    args.push("resume", spec.threadId || "--last");
  }
  if (spec.model) {
    args.push("--model", spec.model);
  }
  if (spec.reasoningEffort) {
    args.push("-c", `model_reasoning_effort="${spec.reasoningEffort}"`);
  }
  // `exec resume` has no --sandbox/--full-auto flags (verified on codex-cli 0.142.3);
  // resumed turns get the equivalent -c config overrides instead.
  if (spec.sandbox) {
    if (spec.fresh) {
      args.push("--sandbox", spec.sandbox);
    } else {
      args.push("-c", `sandbox_mode="${spec.sandbox}"`);
    }
  }
  if (spec.fullAuto) {
    if (spec.fresh) {
      args.push("--full-auto");
    } else {
      args.push("-c", 'approval_policy="on-failure"', "-c", 'sandbox_mode="workspace-write"');
    }
  }
  args.push(spec.prompt);
  return args;
}

export function formatCommandDisplay(codexBin, args) {
  return [codexBin, ...args]
    .map((part) => (/[\s"]/.test(part) ? `"${part.replaceAll('"', '\\"')}"` : part))
    .join(" ");
}

export async function runTurn(spec, { codexBin = "codex", env = process.env, dryRun = false, io, spawnImpl = spawn } = {}) {
  const args = buildTurnArgs(spec);

  if (dryRun) {
    io.stdout.write(`[dry-run] ${formatCommandDisplay(codexBin, args)}\n`);
    return { exitCode: 0, dryRun: true };
  }

  const codexCommand = resolveCodexCommand(codexBin, env);
  const style = createStyler(io, env);
  const renderer = createTurnRenderer(io, style);
  // --json goes after `exec`/`exec resume` but is rendering plumbing, not part of the
  // logical command, so dry-run output stays free of it.
  const fullArgs = [...codexCommand.argsPrefix, ...args.slice(0, -1), "--json", args[args.length - 1]];

  return new Promise((resolve) => {
    const child = spawnImpl(codexCommand.command, fullArgs, {
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const stdoutLines = createLineSplitter((line) => renderer.handleLine(line));
    const stderrLines = createLineSplitter((line) => renderer.handleStderrLine(line));
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => stdoutLines.push(chunk));
    child.stderr?.on("data", (chunk) => stderrLines.push(chunk));

    const onSigint = () => {
      child.kill("SIGTERM");
    };
    process.on("SIGINT", onSigint);

    child.on("error", (error) => {
      process.removeListener("SIGINT", onSigint);
      io.stderr.write(`${codexStartMessage(error, codexBin, codexCommand.resolvedCodexBin)}\n`);
      resolve({ exitCode: 1, startError: true });
    });

    child.on("close", (exitCode, signal) => {
      process.removeListener("SIGINT", onSigint);
      stdoutLines.flush();
      stderrLines.flush();
      const rendered = renderer.result();
      if (signal) {
        io.stderr.write(`codex turn interrupted (${signal})\n`);
        resolve({ exitCode: 130, interrupted: true, threadId: rendered.threadId });
        return;
      }
      resolve({
        exitCode: exitCode ?? 1,
        threadId: rendered.threadId,
        usage: rendered.usage,
        cumulativeTokens: usageTotalTokens(rendered.usage),
        failed: rendered.failed
      });
    });
  });
}
