import readline from "node:readline";
import { createStyler } from "./render.js";
import { FALLBACK_ROUTE, modelForRoute } from "./router.js";
import { APPROVAL_PRESETS, findModel, loadCodexModels } from "./menu.js";

const CLOSED = Symbol("closed");

export const INIT_PROMPT = [
  "Generate a file named AGENTS.md that serves as a contributor guide for this repository.",
  "Cover: how to build and test, code style and conventions, repository layout, and anything",
  "an agent should know before making changes. Keep it concise and specific to this repo."
].join(" ");

export function createSessionState(options = {}) {
  return {
    auto: Boolean(options.auto),
    model: options.model || null,
    reasoningEffort: options.reasoningEffort || null,
    sandbox: options.sandbox || null,
    fullAuto: Boolean(options.fullAuto),
    fresh: true,
    threadId: null,
    dryRun: Boolean(options.dryRun),
    codexBin: options.codexBin || "codex",
    lastClassification: null,
    // codex reports token usage cumulatively; we subtract this to get per-message cost.
    sessionTokens: 0,
    // When set, the next input line is a picker selection, not a prompt/command.
    pending: null
  };
}

export async function handleCommand(line, state, io, deps) {
  const [command, ...rest] = line.split(/\s+/);

  switch (command) {
    case "/help":
      io.stdout.write(helpText());
      return { action: "none" };

    case "/auto": {
      const arg = rest[0];
      if (arg === "on") {
        state.auto = true;
      } else if (arg === "off") {
        state.auto = false;
      } else if (arg === undefined) {
        state.auto = !state.auto;
      } else {
        io.stdout.write("usage: /auto [on|off]\n");
        return { action: "none" };
      }
      io.stdout.write(state.auto
        ? "auto mode ON — classifier picks the model per prompt\n"
        : "auto mode OFF — using manual model selection\n");
      return { action: "none" };
    }

    case "/model": {
      const arg = rest.join(" ").trim();
      if (arg) {
        applyModel(state, arg, io);
        return { action: "none" };
      }
      openModelPicker(state, io);
      return { action: "none" };
    }

    case "/approvals":
    case "/permission":
    case "/permissions": {
      const arg = rest[0];
      if (arg) {
        applyApproval(state, arg, io);
        return { action: "none" };
      }
      openApprovalPicker(state, io);
      return { action: "none" };
    }

    case "/new":
      state.fresh = true;
      state.threadId = null;
      // A fresh codex session restarts codex's cumulative token counter.
      state.sessionTokens = 0;
      io.stdout.write("next prompt starts a fresh codex session\n");
      return { action: "none" };

    case "/init":
      io.stdout.write("sending codex the AGENTS.md instruction…\n");
      return { action: "turn", prompt: INIT_PROMPT };

    case "/diff":
      await deps.runSub("git", ["--no-pager", "diff"]);
      return { action: "none" };

    case "/status":
      io.stdout.write(statusText(state));
      return { action: "none" };

    case "/mcp":
      await deps.runSub("codex", ["mcp", "list"]);
      return { action: "none" };

    case "/login":
      await deps.runSub("codex", ["login"]);
      return { action: "none" };

    case "/logout":
      await deps.runSub("codex", ["logout"]);
      return { action: "none" };

    case "/quit":
    case "/exit":
      return { action: "quit" };

    case "/compact":
      io.stdout.write([
        "/compact is a codex TUI feature that smartcodex cannot trigger in exec mode.",
        "codex compacts the conversation automatically when the context fills up;",
        "use /new if you want to start over with a clean session."
      ].join("\n") + "\n");
      return { action: "none" };

    case "/mention":
      io.stdout.write("/mention is a codex TUI feature; just type the file path in your prompt instead.\n");
      return { action: "none" };

    default:
      io.stdout.write(`unknown command: ${command} — type /help for available commands\n`);
      return { action: "none" };
  }
}

// ---- Model picker ---------------------------------------------------------

function applyModel(state, model, io) {
  state.model = model;
  if (state.auto) {
    state.auto = false;
    io.stdout.write(`model set to ${model}; auto mode turned OFF\n`);
  } else {
    io.stdout.write(`model set to ${model}\n`);
  }
}

function openModelPicker(state, io) {
  const { models, source } = loadCodexModels(io.env);
  io.stdout.write(source === "codex-cache"
    ? "Select a model (from codex):\n"
    : "Select a model (codex cache unavailable — showing built-in list):\n");
  models.forEach((model, index) => {
    const current = model.slug === state.model ? " (current)" : "";
    io.stdout.write(`  ${index + 1}. ${model.slug}${current} — ${model.displayName}\n`);
  });
  io.stdout.write("Type a number, a model name, or press Enter to cancel.\n");
  state.pending = { kind: "model", models };
}

function resolveModelSelection(line, state, io) {
  const choice = line.trim();
  if (!choice) {
    io.stdout.write("model unchanged\n");
    state.pending = null;
    return;
  }

  const { models } = state.pending;
  let model = null;
  if (/^\d+$/.test(choice)) {
    const picked = models[Number.parseInt(choice, 10) - 1];
    if (!picked) {
      io.stdout.write(`no model numbered ${choice}; model unchanged\n`);
      state.pending = null;
      return;
    }
    model = picked;
  } else {
    model = findModel(models, choice) || { slug: choice, reasoningLevels: [], defaultReasoning: null };
  }

  applyModel(state, model.slug, io);

  if (model.reasoningLevels && model.reasoningLevels.length > 0) {
    io.stdout.write(`Select a reasoning level for ${model.slug}:\n`);
    model.reasoningLevels.forEach((level, index) => {
      const isDefault = level === model.defaultReasoning ? " (default)" : "";
      io.stdout.write(`  ${index + 1}. ${level}${isDefault}\n`);
    });
    io.stdout.write("Type a number, a level, or press Enter for codex's default.\n");
    state.pending = { kind: "reasoning", model };
  } else {
    state.pending = null;
  }
}

function resolveReasoningSelection(line, state, io) {
  const choice = line.trim();
  const { model } = state.pending;
  state.pending = null;

  if (!choice) {
    state.reasoningEffort = null;
    io.stdout.write(`reasoning level: codex default for ${model.slug}\n`);
    return;
  }

  let level = null;
  if (/^\d+$/.test(choice)) {
    level = model.reasoningLevels[Number.parseInt(choice, 10) - 1] || null;
  } else if (model.reasoningLevels.includes(choice)) {
    level = choice;
  }

  if (!level) {
    state.reasoningEffort = null;
    io.stdout.write(`unrecognized level; using codex's default for ${model.slug}\n`);
    return;
  }

  state.reasoningEffort = level;
  io.stdout.write(`reasoning level set to ${level}\n`);
}

// ---- Approval picker ------------------------------------------------------

function applyApproval(state, key, io) {
  const preset = APPROVAL_PRESETS.find((p) => p.key === key);
  if (!preset) {
    io.stdout.write(`usage: /approvals <${APPROVAL_PRESETS.map((p) => p.key).join(" | ")}>\n`);
    return;
  }
  state.sandbox = preset.sandbox;
  state.fullAuto = preset.fullAuto;
  io.stdout.write(`approvals: ${preset.label} (${approvalsDisplay(state)})\n`);
}

function openApprovalPicker(state, io) {
  io.stdout.write("Select an approval / sandbox mode (from codex):\n");
  APPROVAL_PRESETS.forEach((preset, index) => {
    const current = isCurrentApproval(state, preset) ? " (current)" : "";
    io.stdout.write(`  ${index + 1}. ${preset.label}${current} — ${preset.description}\n`);
  });
  io.stdout.write("Type a number, a mode name, or press Enter to cancel.\n");
  state.pending = { kind: "approvals" };
}

function isCurrentApproval(state, preset) {
  return state.fullAuto === preset.fullAuto && state.sandbox === preset.sandbox;
}

function resolveApprovalSelection(line, state, io) {
  const choice = line.trim();
  state.pending = null;
  if (!choice) {
    io.stdout.write("approvals unchanged\n");
    return;
  }

  let preset = null;
  if (/^\d+$/.test(choice)) {
    preset = APPROVAL_PRESETS[Number.parseInt(choice, 10) - 1] || null;
  } else {
    preset = APPROVAL_PRESETS.find((p) => p.key === choice || p.label.toLowerCase() === choice.toLowerCase()) || null;
  }

  if (!preset) {
    io.stdout.write(`unrecognized mode; approvals unchanged\n`);
    return;
  }
  applyApproval(state, preset.key, io);
}

export function resolveSelection(line, state, io) {
  switch (state.pending?.kind) {
    case "model":
      return resolveModelSelection(line, state, io);
    case "reasoning":
      return resolveReasoningSelection(line, state, io);
    case "approvals":
      return resolveApprovalSelection(line, state, io);
    default:
      state.pending = null;
  }
}

export async function executeTurn(prompt, state, io, deps) {
  const style = createStyler(io, io.env);
  let model = state.model;
  let reasoningEffort = state.reasoningEffort;

  if (state.auto) {
    const result = await deps.classify(prompt, { cwd: io.cwd, env: io.env });
    if (result.ok) {
      model = result.model;
      reasoningEffort = result.reasoningLevel || null;
      state.lastClassification = result;
      io.stdout.write(`${style.dim(formatAutoLine(result))}\n`);
    } else {
      model = state.model || modelForRoute(FALLBACK_ROUTE, io.env);
      io.stderr.write(`[auto] warning: ${result.warning}; falling back to ${model}\n`);
    }
  }

  const spec = {
    prompt,
    model,
    reasoningEffort,
    sandbox: state.sandbox,
    fullAuto: state.fullAuto,
    fresh: state.fresh,
    threadId: state.threadId
  };

  const result = await deps.runTurn(spec, {
    codexBin: state.codexBin,
    env: io.env,
    dryRun: state.dryRun,
    io
  });

  if (result.exitCode === 0) {
    state.fresh = false;
    if (result.threadId) {
      state.threadId = result.threadId;
    }
    reportTokens(result.cumulativeTokens, state, io, style);
  } else if (!result.startError) {
    io.stderr.write(`codex exited with status ${result.exitCode}\n`);
  }
  return result;
}

function reportTokens(cumulative, state, io, style) {
  if (cumulative == null) {
    return;
  }
  // Guard against codex resetting its counter mid-session (e.g. compaction): never
  // show a negative per-message figure.
  const message = cumulative >= state.sessionTokens ? cumulative - state.sessionTokens : cumulative;
  state.sessionTokens = cumulative;
  const fmt = (n) => n.toLocaleString("en-US");
  io.stdout.write(`${style.dim(`  · ${fmt(message)} tokens · ${fmt(cumulative)} session`)}\n`);
}

export function formatAutoLine(result) {
  const reasoning = result.reasoningLevel ? ` · reasoning ${result.reasoningLevel}` : "";
  return `[auto] ${result.model}${reasoning}`;
}

export async function runRepl(state, io, deps) {
  const style = createStyler(io, io.env);
  const isTerminal = Boolean(io.stdin.isTTY);
  const rl = readline.createInterface({
    input: io.stdin,
    output: io.stdout,
    terminal: isTerminal
  });

  // A permanent line listener with a queue: piped input can deliver many lines while
  // a turn is still running, and none of them may be dropped.
  const pending = [];
  let waiting = null;
  let ended = false;
  rl.on("line", (line) => {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(line);
    } else {
      pending.push(line);
    }
  });
  rl.on("close", () => {
    ended = true;
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(CLOSED);
    }
  });
  rl.on("SIGINT", () => {
    io.stdout.write("^C\n");
    rl.close();
  });

  function nextLine() {
    if (pending.length > 0) {
      return Promise.resolve(pending.shift());
    }
    if (ended) {
      return Promise.resolve(CLOSED);
    }
    if (isTerminal) {
      const marker = state.pending ? style.cyan(style.bold("select› ")) : `\n${style.cyan(style.bold("› "))}`;
      rl.setPrompt(marker);
      rl.prompt();
    }
    return new Promise((resolve) => {
      waiting = resolve;
    });
  }

  io.stdout.write(`${style.bold("smartcodex")} ${style.dim(`(auto: ${state.auto ? "on" : "off"}, model: ${state.model || "codex default"}) — /help for commands`)}\n`);

  while (true) {
    const line = await nextLine();
    if (line === CLOSED) {
      break;
    }
    // A picker is open: this line is the selection (blank = cancel), not a prompt.
    if (state.pending) {
      resolveSelection(line, state, io);
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    if (trimmed.startsWith("/")) {
      const result = await handleCommand(trimmed, state, io, deps);
      if (result.action === "quit") {
        break;
      }
      if (result.action === "turn") {
        await executeTurn(result.prompt, state, io, deps);
      }
      continue;
    }

    await executeTurn(trimmed, state, io, deps);
  }

  rl.close();
  return 0;
}

function approvalsDisplay(state) {
  if (state.fullAuto) {
    return "full-auto";
  }
  if (state.sandbox) {
    return `sandbox=${state.sandbox}`;
  }
  return "codex default";
}

function statusText(state) {
  const classification = state.lastClassification;
  return [
    `auto mode: ${state.auto ? "on" : "off"}`,
    `model: ${state.model || "codex default"}${state.reasoningEffort ? ` (reasoning ${state.reasoningEffort})` : ""}`,
    `approvals: ${approvalsDisplay(state)}`,
    `session: ${state.fresh
      ? "fresh (next prompt starts a new codex session)"
      : `continuing codex session${state.threadId ? ` ${state.threadId}` : ""}`}`,
    `last classification: ${classification
      ? `route=${classification.routeId} model=${classification.model}`
        + `${classification.reasoningLevel ? ` reasoning=${classification.reasoningLevel}` : ""}`
        + `${classification.confidence != null ? ` confidence=${classification.confidence}` : ""}`
        + `${classification.reason ? ` — "${classification.reason}"` : ""}`
      : "none"}`,
    `codex bin: ${state.codexBin}`
  ].join("\n") + "\n";
}

function helpText() {
  return [
    "commands:",
    "  /auto [on|off]      toggle classifier-driven model selection (smartcodex)",
    "  /model [name]       pick a model from codex's list (or name one); turns auto off",
    "  /approvals [mode]   pick an approval/sandbox mode (alias: /permissions)",
    "  /new                next prompt starts a fresh codex session",
    "  /init               ask codex to generate AGENTS.md",
    "  /diff               show the working-tree diff",
    "  /status             show mode, model, approvals, session state",
    "  /mcp                list configured MCP servers (codex mcp list)",
    "  /login /logout      codex authentication",
    "  /compact /mention   TUI-only in codex; explained when used",
    "  /quit or /exit      leave smartcodex",
    "anything else is sent to codex verbatim.",
    ""
  ].join("\n");
}
