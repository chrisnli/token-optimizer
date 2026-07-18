// Codex-TUI-style rendering of `codex exec --json` event streams: no user/codex
// labels — user input sits on the `› ` prompt line, agent text is plain, everything
// mechanical (commands, file changes, token counts) is dimmed.

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  cyan: "\x1b[36m"
};

export function createStyler(io, env = {}) {
  const enabled = Boolean(io.stdout.isTTY) && !env.NO_COLOR;
  const wrap = (code) => (text) => (enabled ? `${code}${text}${ANSI.reset}` : text);
  return {
    enabled,
    bold: wrap(ANSI.bold),
    dim: wrap(ANSI.dim),
    red: wrap(ANSI.red),
    cyan: wrap(ANSI.cyan)
  };
}

export function createTurnRenderer(io, style) {
  let threadId = null;
  let usage = null;
  let failed = false;
  let lastPrinted = null;
  const startedCommands = new Set();

  function print(text) {
    io.stdout.write(text);
  }

  function handleEvent(event) {
    switch (event.type) {
      case "thread.started":
        threadId = event.thread_id || null;
        return;

      case "turn.started":
        return;

      case "item.started":
      case "item.updated":
        if (event.item?.type === "command_execution" && !startedCommands.has(event.item.id)) {
          startedCommands.add(event.item.id);
          print(`${style.dim(`  $ ${event.item.command}`)}\n`);
          lastPrinted = "command";
        }
        return;

      case "item.completed": {
        const item = event.item || {};
        if (item.type === "agent_message") {
          if (lastPrinted && lastPrinted !== "message") {
            print("\n");
          }
          print(`${item.text}\n`);
          lastPrinted = "message";
        } else if (item.type === "command_execution") {
          if (!startedCommands.has(item.id)) {
            startedCommands.add(item.id);
            print(`${style.dim(`  $ ${item.command}`)}\n`);
            lastPrinted = "command";
          }
          if (item.exit_code != null && item.exit_code !== 0) {
            print(`${style.dim(style.red(`  (exit ${item.exit_code})`))}\n`);
            lastPrinted = "command";
          }
        } else if (item.type === "file_change") {
          const changes = Array.isArray(item.changes) ? item.changes : [];
          for (const change of changes) {
            print(`${style.dim(`  ✎ ${change.path || "file"}`)}\n`);
          }
          if (changes.length === 0) {
            print(`${style.dim("  ✎ files changed")}\n`);
          }
          lastPrinted = "command";
        } else if (item.type === "error") {
          const message = item.message || "unknown error";
          if (isModelSwitchNotice(message)) {
            print(`${style.dim(`  ${message}`)}\n`);
          } else {
            print(`${style.red(`  error: ${message}`)}\n`);
            failed = true;
          }
          lastPrinted = "command";
        }
        // reasoning, todo_list, web_search, mcp_tool_call: intentionally quiet
        return;
      }

      case "turn.completed": {
        usage = event.usage || null;
        if (usage) {
          const total = (usage.input_tokens || 0) + (usage.output_tokens || 0);
          print(`${style.dim(`  · ${total.toLocaleString("en-US")} tokens`)}\n`);
        }
        return;
      }

      case "turn.failed":
        failed = true;
        print(`${style.red(`  error: ${event.error?.message || "turn failed"}`)}\n`);
        return;

      case "error":
        failed = true;
        print(`${style.red(`  error: ${event.message || "unknown error"}`)}\n`);
        return;

      default:
        return;
    }
  }

  return {
    handleLine(line) {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {
        // Not an event — codex printed something raw; pass it through.
        print(`${trimmed}\n`);
        return;
      }
      handleEvent(event);
    },
    handleStderrLine(line) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("Reading additional input from stdin")) {
        return;
      }
      io.stderr.write(`${style.dim(trimmed)}\n`);
    },
    result() {
      return { threadId, usage, failed };
    }
  };
}

// codex reports switching models on resume as an error item, but for smartcodex the
// per-turn model switch is intended behavior — show it quietly.
function isModelSwitchNotice(message) {
  return message.includes("was recorded with model") && message.includes("resuming with");
}

export function createLineSplitter(onLine) {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        onLine(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
      }
    },
    flush() {
      if (buffer) {
        onLine(buffer);
        buffer = "";
      }
    }
  };
}
