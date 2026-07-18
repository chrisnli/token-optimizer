import readline from "node:readline";
import { FALLBACK_ROUTE, modelForRoute } from "./router.js";

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
    sandbox: options.sandbox || null,
    fullAuto: Boolean(options.fullAuto),
    fresh: true,
    dryRun: Boolean(options.dryRun),
    codexBin: options.codexBin || "codex",
    lastClassification: null
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
      const model = rest.join(" ").trim();
      if (!model) {
        io.stdout.write(`model: ${state.model || "codex default"} (auto mode ${state.auto ? "on" : "off"})\n`);
        return { action: "none" };
      }
      state.model = model;
      if (state.auto) {
        state.auto = false;
        io.stdout.write(`model set to ${model}; auto mode turned OFF\n`);
      } else {
        io.stdout.write(`model set to ${model}\n`);
      }
      return { action: "none" };
    }

    case "/approvals": {
      const mode = rest[0];
      if (mode === "read-only" || mode === "workspace-write" || mode === "danger-full-access") {
        state.sandbox = mode;
        state.fullAuto = false;
        io.stdout.write(`approvals: sandbox=${mode}\n`);
      } else if (mode === "full-auto") {
        state.fullAuto = true;
        state.sandbox = null;
        io.stdout.write("approvals: full-auto\n");
      } else if (mode === undefined) {
        io.stdout.write(`approvals: ${approvalsDisplay(state)}\n`);
        io.stdout.write("usage: /approvals <read-only|workspace-write|danger-full-access|full-auto>\n");
      } else {
        io.stdout.write("usage: /approvals <read-only|workspace-write|danger-full-access|full-auto>\n");
      }
      return { action: "none" };
    }

    case "/new":
      state.fresh = true;
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

export async function executeTurn(prompt, state, io, deps) {
  let model = state.model;
  let reasoningEffort = null;

  if (state.auto) {
    const result = await deps.classify(prompt, { cwd: io.cwd, env: io.env });
    if (result.ok) {
      model = result.model;
      reasoningEffort = result.reasoningLevel || null;
      state.lastClassification = result;
      io.stdout.write(formatAutoLine(result));
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
    fresh: state.fresh
  };

  const result = await deps.runTurn(spec, {
    codexBin: state.codexBin,
    env: io.env,
    dryRun: state.dryRun,
    io
  });

  if (result.exitCode === 0) {
    state.fresh = false;
  } else if (!result.startError) {
    io.stderr.write(`codex exited with status ${result.exitCode}\n`);
  }
  return result;
}

export function formatAutoLine(result) {
  const details = [];
  if (result.reasoningLevel) {
    details.push(`reasoning ${result.reasoningLevel}`);
  }
  if (result.confidence != null) {
    details.push(`confidence ${result.confidence}`);
  }
  const detailText = details.length > 0 ? ` (${details.join(", ")})` : "";
  const reason = result.reason ? ` — "${result.reason}"` : "";
  return `[auto] route=${result.routeId} → ${result.model}${detailText}${reason}\n`;
}

export async function runRepl(state, io, deps) {
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
      rl.setPrompt("> ");
      rl.prompt();
    }
    return new Promise((resolve) => {
      waiting = resolve;
    });
  }

  io.stdout.write(`smartcodex (auto: ${state.auto ? "on" : "off"}, model: ${state.model || "codex default"}) — /help for commands\n`);

  while (true) {
    const line = await nextLine();
    if (line === CLOSED) {
      break;
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
    `model: ${state.model || "codex default"}`,
    `approvals: ${approvalsDisplay(state)}`,
    `session: ${state.fresh ? "fresh (next prompt starts a new codex session)" : "continuing last codex session"}`,
    `last classification: ${classification ? `route=${classification.routeId} model=${classification.model}` : "none"}`,
    `codex bin: ${state.codexBin}`
  ].join("\n") + "\n";
}

function helpText() {
  return [
    "commands:",
    "  /auto [on|off]      toggle classifier-driven model selection (smartcodex)",
    "  /model [name]       show or set the model (setting turns auto off)",
    "  /approvals <mode>   read-only | workspace-write | danger-full-access | full-auto",
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
