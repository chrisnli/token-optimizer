import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

// Models codex falls back to if its own cache can't be read. These are the slugs a
// current codex CLI ships with; the live cache (when present) overrides this entirely.
export const FALLBACK_MODELS = [
  { slug: "gpt-5.5", displayName: "GPT-5.5", description: "Frontier model for complex work.", reasoningLevels: ["low", "medium", "high", "xhigh"], defaultReasoning: "medium" },
  { slug: "gpt-5.4", displayName: "GPT-5.4", description: "Balanced everyday coding model.", reasoningLevels: ["low", "medium", "high", "xhigh"], defaultReasoning: "medium" },
  { slug: "gpt-5.4-mini", displayName: "GPT-5.4 mini", description: "Fast, cheap model for simple tasks.", reasoningLevels: ["low", "medium", "high", "xhigh"], defaultReasoning: "medium" }
];

// Approval presets mirror codex's own /approvals choices, expressed in the sandbox /
// full-auto terms smartcodex forwards to `codex exec`.
export const APPROVAL_PRESETS = [
  { key: "read-only", label: "Read Only", description: "codex can read files but asks before editing or running commands", sandbox: "read-only", fullAuto: false },
  { key: "workspace-write", label: "Workspace Write", description: "codex can edit files in the workspace; asks to touch anything outside", sandbox: "workspace-write", fullAuto: false },
  { key: "full-auto", label: "Full Auto", description: "workspace-write with minimal prompts (codex --full-auto)", sandbox: null, fullAuto: true },
  { key: "danger-full-access", label: "Full Access", description: "no sandbox — codex can run anything, including network access", sandbox: "danger-full-access", fullAuto: false }
];

export function codexModelsCachePath(env = process.env) {
  const home = env.CODEX_HOME || path.join(env.USERPROFILE || env.HOME || os.homedir(), ".codex");
  return path.join(home, "models_cache.json");
}

export function loadCodexModels(env = process.env) {
  const cachePath = codexModelsCachePath(env);
  let raw;
  try {
    raw = fsSync.readFileSync(cachePath, "utf8");
  } catch {
    return { models: FALLBACK_MODELS, source: "fallback" };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { models: FALLBACK_MODELS, source: "fallback" };
  }

  const models = normalizeCacheModels(parsed.models);
  if (models.length === 0) {
    return { models: FALLBACK_MODELS, source: "fallback" };
  }
  return { models, source: "codex-cache" };
}

export function normalizeCacheModels(cacheModels) {
  if (!Array.isArray(cacheModels)) {
    return [];
  }
  return cacheModels
    // Only models codex would actually list and that the API accepts.
    .filter((model) => model && model.visibility === "list" && model.supported_in_api !== false && typeof model.slug === "string")
    .map((model) => ({
      slug: model.slug,
      displayName: model.display_name || model.slug,
      description: model.description || "",
      reasoningLevels: Array.isArray(model.supported_reasoning_levels)
        ? model.supported_reasoning_levels.map((level) => level.effort).filter(Boolean)
        : [],
      defaultReasoning: model.default_reasoning_level || null
    }));
}

export function findModel(models, slug) {
  return models.find((model) => model.slug === slug) || null;
}
