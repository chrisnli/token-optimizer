import { spawnSync } from "node:child_process";
import fsSync from "node:fs";
import path from "node:path";

// Command resolution mirrors the classifier's codex-runner so both halves of the
// package spawn codex the same way, especially around Windows npm shims.

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

  const matches = findExecutableMatches(codexBin, env);
  return bestWindowsCommandMatch(matches) || matches[0] || codexBin;
}

export function codexBinExists(codexBin = "codex", env = process.env) {
  if (hasPathSeparator(codexBin) || path.isAbsolute(codexBin)) {
    return fsSync.existsSync(codexBin);
  }
  return findExecutableMatches(codexBin, env).length > 0;
}

export function findExecutableMatches(command, env = process.env) {
  const whereMatches = process.platform === "win32" ? findWithWhere(command, env) : [];
  const pathMatches = findOnPath(command, env);
  return [...new Set([...whereMatches, ...pathMatches])];
}

export function codexStartMessage(error, codexBin, resolvedCodexBin) {
  if (error.code === "ENOENT") {
    return [
      `Failed to start Codex: ${error.message}.`,
      `Could not find "${codexBin}" on PATH.`,
      "Install or expose the Codex CLI, or set SMARTCODEX_CODEX_BIN / --codex-bin to the full codex executable path."
    ].join(" ");
  }

  if (error.code === "EPERM" || error.code === "EACCES" || error.code === "EINVAL") {
    return [
      `Failed to start Codex: ${error.message}.`,
      `Resolved command was "${resolvedCodexBin}".`,
      "That path may be a Windows shim that cannot be spawned directly.",
      "Set SMARTCODEX_CODEX_BIN / --codex-bin to a spawnable Codex CLI executable."
    ].join(" ");
  }

  return `Failed to start Codex: ${error.message}`;
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
