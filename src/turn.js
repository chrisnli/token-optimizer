import { spawn } from "node:child_process";
import { codexStartMessage, resolveCodexCommand } from "./codex-command.js";

export function buildTurnArgs(spec) {
  const args = ["exec"];
  if (!spec.fresh) {
    args.push("resume", "--last");
  }
  if (spec.model) {
    args.push("--model", spec.model);
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
  return new Promise((resolve) => {
    const child = spawnImpl(codexCommand.command, [...codexCommand.argsPrefix, ...args], {
      env,
      shell: false,
      windowsHide: true,
      // codex gets the terminal for output; stdin stays ours so the REPL keeps the line.
      stdio: ["ignore", "inherit", "inherit"]
    });

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
      if (signal) {
        io.stderr.write(`codex turn interrupted (${signal})\n`);
        resolve({ exitCode: 130, interrupted: true });
        return;
      }
      resolve({ exitCode: exitCode ?? 1 });
    });
  });
}
