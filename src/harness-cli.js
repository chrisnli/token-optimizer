import { spawn } from "node:child_process";
import { classifyPrompt } from "./classifier-bridge.js";
import { codexBinExists, codexStartMessage, resolveCodexCommand } from "./codex-command.js";
import { createSessionState, executeTurn, runRepl } from "./repl.js";
import { runTurn } from "./turn.js";

export async function runHarness(argv, io, deps = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    io.stderr.write(`${error.message}\n\n${helpText()}`);
    return 2;
  }

  if (options.help) {
    io.stdout.write(helpText());
    return 0;
  }

  const codexBin = options.codexBin || io.env.SMARTCODEX_CODEX_BIN || "codex";

  if (!options.dryRun && !codexBinExists(codexBin, io.env)) {
    io.stderr.write([
      `codex not found: "${codexBin}" does not resolve to an executable.`,
      "Install the Codex CLI, or point SMARTCODEX_CODEX_BIN / --codex-bin at it."
    ].join(" ") + "\n");
    return 2;
  }

  const state = createSessionState({
    auto: options.auto,
    model: options.model,
    sandbox: options.sandbox,
    fullAuto: options.fullAuto,
    dryRun: options.dryRun,
    codexBin
  });

  const effectiveDeps = {
    classify: deps.classify || classifyPrompt,
    runTurn: deps.runTurn || runTurn,
    runSub: deps.runSub || makeRunSub(codexBin, io)
  };

  const initialPrompt = options.promptParts.join(" ").trim();
  if (initialPrompt) {
    await executeTurn(initialPrompt, state, io, effectiveDeps);
  }

  return runRepl(state, io, effectiveDeps);
}

function makeRunSub(codexBin, io) {
  return (bin, args) => new Promise((resolve) => {
    let command = bin;
    let argsPrefix = [];
    let resolvedDisplay = bin;
    if (bin === "codex") {
      const codexCommand = resolveCodexCommand(codexBin, io.env);
      command = codexCommand.command;
      argsPrefix = codexCommand.argsPrefix;
      resolvedDisplay = codexCommand.resolvedCodexBin;
    }

    const child = spawn(command, [...argsPrefix, ...args], {
      env: io.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "inherit", "inherit"]
    });

    child.on("error", (error) => {
      io.stderr.write(`${codexStartMessage(error, bin, resolvedDisplay)}\n`);
      resolve(1);
    });
    child.on("close", (exitCode) => resolve(exitCode ?? 1));
  });
}

function parseArgs(argv) {
  const options = {
    help: false,
    auto: false,
    model: null,
    codexBin: null,
    sandbox: null,
    fullAuto: false,
    dryRun: false,
    promptParts: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--auto") {
      options.auto = true;
      continue;
    }
    if (arg === "--model" || arg === "-m") {
      options.model = requireValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--codex-bin") {
      options.codexBin = requireValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--sandbox") {
      options.sandbox = requireValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--full-auto") {
      options.fullAuto = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    options.promptParts.push(arg);
  }

  return options;
}

function requireValue(argv, index, option) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function helpText() {
  return [
    "Usage:",
    "  smartcodex [options] [\"initial prompt\"]",
    "",
    "An interactive codex session where /auto lets a classifier pick the model per prompt.",
    "",
    "Options:",
    "  --auto              start with auto mode on",
    "  --model, -m <m>     start with a manually selected model",
    "  --codex-bin <path>  codex executable (default: codex on PATH, or SMARTCODEX_CODEX_BIN)",
    "  --sandbox <mode>    forwarded to codex (read-only | workspace-write | danger-full-access)",
    "  --full-auto         forwarded to codex",
    "  --dry-run           print the codex command for each turn instead of running it",
    "  --help, -h          show this help",
    "",
    "Inside the session type /help for slash commands.",
    ""
  ].join("\n");
}
