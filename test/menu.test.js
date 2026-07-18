import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  APPROVAL_PRESETS,
  FALLBACK_MODELS,
  codexModelsCachePath,
  findModel,
  loadCodexModels,
  normalizeCacheModels
} from "../src/menu.js";

const SAMPLE_CACHE_MODELS = [
  {
    slug: "gpt-5.5",
    display_name: "GPT-5.5",
    description: "Frontier model.",
    visibility: "list",
    supported_in_api: true,
    default_reasoning_level: "medium",
    supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }]
  },
  {
    slug: "gpt-5.4-mini",
    display_name: "GPT-5.4 mini",
    visibility: "list",
    supported_in_api: true,
    default_reasoning_level: "medium",
    supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }]
  },
  { slug: "codex-auto-review", display_name: "hidden", visibility: "hide", supported_in_api: true }
];

test("normalizeCacheModels keeps only listed, api-supported models", () => {
  const models = normalizeCacheModels(SAMPLE_CACHE_MODELS);
  assert.deepEqual(models.map((m) => m.slug), ["gpt-5.5", "gpt-5.4-mini"]);
});

test("normalizeCacheModels maps reasoning levels and default", () => {
  const [first] = normalizeCacheModels(SAMPLE_CACHE_MODELS);
  assert.deepEqual(first.reasoningLevels, ["low", "medium", "high", "xhigh"]);
  assert.equal(first.defaultReasoning, "medium");
  assert.equal(first.displayName, "GPT-5.5");
});

test("normalizeCacheModels tolerates junk", () => {
  assert.deepEqual(normalizeCacheModels(null), []);
  assert.deepEqual(normalizeCacheModels([{ slug: 123 }, {}]), []);
});

test("loadCodexModels reads a real cache via CODEX_HOME", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smartcodex-cache-"));
  try {
    fs.writeFileSync(path.join(dir, "models_cache.json"), JSON.stringify({ models: SAMPLE_CACHE_MODELS }), "utf8");
    const { models, source } = loadCodexModels({ CODEX_HOME: dir });
    assert.equal(source, "codex-cache");
    assert.deepEqual(models.map((m) => m.slug), ["gpt-5.5", "gpt-5.4-mini"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadCodexModels falls back when the cache is missing or broken", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smartcodex-cache-"));
  try {
    const missing = loadCodexModels({ CODEX_HOME: dir });
    assert.equal(missing.source, "fallback");
    assert.equal(missing.models, FALLBACK_MODELS);

    fs.writeFileSync(path.join(dir, "models_cache.json"), "not json", "utf8");
    const broken = loadCodexModels({ CODEX_HOME: dir });
    assert.equal(broken.source, "fallback");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("codexModelsCachePath honors CODEX_HOME then USERPROFILE/HOME", () => {
  assert.equal(codexModelsCachePath({ CODEX_HOME: "/x" }), path.join("/x", "models_cache.json"));
  assert.equal(codexModelsCachePath({ USERPROFILE: "/u" }), path.join("/u", ".codex", "models_cache.json"));
});

test("findModel locates by slug", () => {
  assert.equal(findModel(FALLBACK_MODELS, "gpt-5.4").slug, "gpt-5.4");
  assert.equal(findModel(FALLBACK_MODELS, "nope"), null);
});

test("approval presets cover codex's sandbox modes", () => {
  const keys = APPROVAL_PRESETS.map((p) => p.key);
  assert.deepEqual(keys, ["read-only", "workspace-write", "full-auto", "danger-full-access"]);
});
