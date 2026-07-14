import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { profileRepository } from "../src/profile.js";

test("profiles repository counts, languages, tests, ci, and prompt filename matches", () => {
  const repo = makeTempRepo();
  write(repo, "src/auth.ts", "export const auth = true;\n");
  write(repo, "src/index.ts", "import './auth';\nconsole.log('hi');\n");
  write(repo, "test/auth.test.ts", "test('auth', () => {});\n");
  write(repo, ".github/workflows/ci.yml", "name: ci\n");
  write(repo, "package.json", "{\"scripts\":{\"test\":\"node --test\"}}\n");

  const profile = profileRepository(repo, "Fix auth login");

  assert.equal(profile.totalFiles, 5);
  assert.equal(profile.totalLines, 6);
  assert(profile.totalBytes > 0);
  assert.deepEqual(profile.fileCounts, { source: 2, test: 1, config: 2 });
  assert.equal(profile.testsExist, true);
  assert.equal(profile.ciExists, true);
  assert.equal(profile.languageTotals.TypeScript.files, 3);
  assert.equal(profile.languageTotals.TypeScript.lines, 4);
  assert.equal(typeof profile.files.find((file) => file.path === "src/auth.ts").bytes, "number");
  assert.deepEqual(profile.files.map((file) => file.path), [
    ".github/workflows/ci.yml",
    "package.json",
    "src/auth.ts",
    "src/index.ts",
    "test/auth.test.ts"
  ]);
  assert.deepEqual(profile.promptMatchedFiles.sort(), ["src/auth.ts", "test/auth.test.ts"]);
});

test("respects .gitignore and excludes dependencies, build outputs, caches, binaries, generated, and minified files", () => {
  const repo = makeTempRepo();
  write(repo, ".gitignore", "ignored.txt\nsecret/\n");
  write(repo, "src/app.js", "console.log('app');\n");
  write(repo, "ignored.txt", "ignored\n");
  write(repo, "secret/hidden.js", "hidden\n");
  write(repo, "node_modules/pkg/index.js", "module.exports = 1;\n");
  write(repo, "dist/bundle.js", "built\n");
  write(repo, ".cache/data.txt", "cache\n");
  write(repo, "src/generated/client.ts", "generated\n");
  write(repo, "src/app.min.js", "minified\n");
  write(repo, "image.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const profile = profileRepository(repo, "change app");

  assert.deepEqual(profile.files.map((file) => file.path), [".gitignore", "src/app.js"]);
  assert.equal(profile.totalFiles, 2);
});

test("truncates large manifests and records omitted files", () => {
  const repo = makeTempRepo();
  write(repo, "a.js", "a\n");
  write(repo, "b.js", "b\n");
  write(repo, "c.js", "c\n");

  const profile = profileRepository(repo, "change", { maxManifestFiles: 2 });

  assert.equal(profile.totalFiles, 3);
  assert.equal(profile.files.length, 2);
  assert.deepEqual(profile.manifest, {
    truncated: true,
    includedFiles: 2,
    omittedFiles: 1,
    maxFiles: 2
  });
});

function makeTempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "smartcodex-profile-test-"));
}

function write(root, relativePath, contents) {
  const absolutePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, contents);
}
