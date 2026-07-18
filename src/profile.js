import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_MAX_MANIFEST_FILES = 2000;
const DEFAULT_MAX_MATCHED_FILES = 200;
const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;

const EXCLUDED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "bower_components",
  "jspm_packages",
  "vendor",
  ".venv",
  "venv",
  "env",
  ".tox",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".cache",
  ".parcel-cache",
  ".turbo",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".angular",
  ".gradle",
  ".idea",
  ".vscode",
  "coverage",
  "dist",
  "build",
  "out",
  "target",
  "tmp",
  "temp"
]);

const BINARY_EXTENSIONS = new Set([
  ".7z",
  ".a",
  ".avi",
  ".bin",
  ".bmp",
  ".class",
  ".dll",
  ".dmg",
  ".doc",
  ".docx",
  ".DS_Store",
  ".exe",
  ".gif",
  ".gz",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".lockb",
  ".mov",
  ".mp3",
  ".mp4",
  ".o",
  ".obj",
  ".pdf",
  ".png",
  ".pyc",
  ".pyd",
  ".pyo",
  ".so",
  ".sqlite",
  ".tar",
  ".tgz",
  ".ttf",
  ".wasm",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".zip"
]);

const CONFIG_FILENAMES = new Set([
  ".babelrc",
  ".dockerignore",
  ".editorconfig",
  ".env.example",
  ".eslintrc",
  ".gitattributes",
  ".gitignore",
  ".npmrc",
  ".prettierrc",
  "babel.config.js",
  "commitlint.config.js",
  "docker-compose.yml",
  "Dockerfile",
  "eslint.config.js",
  "jest.config.js",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "pyproject.toml",
  "requirements.txt",
  "rollup.config.js",
  "tsconfig.json",
  "vite.config.js",
  "webpack.config.js",
  "yarn.lock"
]);

const LANGUAGE_BY_EXTENSION = new Map([
  [".c", "C"],
  [".cc", "C++"],
  [".cpp", "C++"],
  [".cs", "C#"],
  [".css", "CSS"],
  [".go", "Go"],
  [".h", "C/C++ Header"],
  [".hpp", "C++ Header"],
  [".html", "HTML"],
  [".java", "Java"],
  [".js", "JavaScript"],
  [".jsx", "JavaScript JSX"],
  [".json", "JSON"],
  [".kt", "Kotlin"],
  [".lua", "Lua"],
  [".md", "Markdown"],
  [".mjs", "JavaScript"],
  [".php", "PHP"],
  [".ps1", "PowerShell"],
  [".py", "Python"],
  [".rb", "Ruby"],
  [".rs", "Rust"],
  [".scss", "SCSS"],
  [".sh", "Shell"],
  [".sql", "SQL"],
  [".swift", "Swift"],
  [".toml", "TOML"],
  [".ts", "TypeScript"],
  [".tsx", "TypeScript JSX"],
  [".vue", "Vue"],
  [".xml", "XML"],
  [".yaml", "YAML"],
  [".yml", "YAML"]
]);

export function profileRepository(repoRoot, prompt, options = {}) {
  const maxManifestFiles = options.maxManifestFiles ?? parsePositiveInteger(process.env.SMARTCODEX_MAX_MANIFEST_FILES, DEFAULT_MAX_MANIFEST_FILES);
  const maxMatchedFiles = options.maxMatchedFiles ?? DEFAULT_MAX_MATCHED_FILES;
  const root = path.resolve(repoRoot);
  const promptWords = promptNameWords(prompt);
  const candidatePaths = listCandidatePaths(root);
  const files = [];
  const languageTotals = {};
  let sourceFileCount = 0;
  let testFileCount = 0;
  let configFileCount = 0;
  let totalLines = 0;
  let totalBytes = 0;
  let testsExist = false;
  let ciExists = false;
  const promptMatchedFiles = [];

  for (const relativePath of candidatePaths) {
    const absolutePath = path.join(root, relativePath);
    const eligibility = inspectEligibleFile(absolutePath, relativePath);
    if (!eligibility.eligible) {
      continue;
    }

    const lineCount = countLines(absolutePath);
    const language = languageForFile(relativePath);
    const kind = classifyFile(relativePath);
    const entry = {
      path: normalizePath(relativePath),
      lines: lineCount,
      bytes: eligibility.bytes
    };

    files.push(entry);
    totalLines += lineCount;
    totalBytes += eligibility.bytes;

    if (!languageTotals[language]) {
      languageTotals[language] = { files: 0, lines: 0 };
    }
    languageTotals[language].files += 1;
    languageTotals[language].lines += lineCount;

    if (kind === "test") {
      testFileCount += 1;
      testsExist = true;
    } else if (kind === "config") {
      configFileCount += 1;
    } else {
      sourceFileCount += 1;
    }

    if (isCiPath(relativePath)) {
      ciExists = true;
    }

    if (matchesPromptWords(relativePath, promptWords) && promptMatchedFiles.length < maxMatchedFiles) {
      promptMatchedFiles.push(entry.path);
    }
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  const truncated = files.length > maxManifestFiles;
  const manifestFiles = truncated ? files.slice(0, maxManifestFiles) : files;

  return {
    rootName: path.basename(root),
    totalFiles: files.length,
    totalLines,
    totalBytes,
    languageTotals: sortObject(languageTotals),
    fileCounts: {
      source: sourceFileCount,
      test: testFileCount,
      config: configFileCount
    },
    testsExist,
    ciExists,
    files: manifestFiles,
    promptMatchedFiles,
    manifest: {
      truncated,
      includedFiles: manifestFiles.length,
      omittedFiles: truncated ? files.length - manifestFiles.length : 0,
      maxFiles: maxManifestFiles
    }
  };
}

function listCandidatePaths(root) {
  const gitPaths = listGitTrackedAndUntracked(root);
  if (gitPaths) {
    return gitPaths.filter((relativePath) => !isExcludedPath(relativePath)).sort();
  }

  const gitIgnoreRules = readGitIgnoreRules(root);
  const paths = [];
  walk(root, root, gitIgnoreRules, paths);
  return paths.sort();
}

function listGitTrackedAndUntracked(root) {
  const result = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
    shell: false,
    windowsHide: true
  });

  if (result.status !== 0) {
    return null;
  }

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(normalizePath);
}

function walk(root, current, gitIgnoreRules, paths) {
  const entries = fs.readdirSync(current, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(current, entry.name);
    const relativePath = normalizePath(path.relative(root, absolutePath));

    if (entry.isDirectory()) {
      if (isExcludedPath(relativePath) || isIgnored(relativePath, true, gitIgnoreRules)) {
        continue;
      }
      walk(root, absolutePath, gitIgnoreRules, paths);
      continue;
    }

    if (entry.isFile() && !isExcludedPath(relativePath) && !isIgnored(relativePath, false, gitIgnoreRules)) {
      paths.push(relativePath);
    }
  }
}

function readGitIgnoreRules(root) {
  const ignorePath = path.join(root, ".gitignore");
  if (!fs.existsSync(ignorePath)) {
    return [];
  }

  return fs.readFileSync(ignorePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map(parseIgnoreRule);
}

function parseIgnoreRule(rawPattern) {
  let pattern = rawPattern;
  let negated = false;
  if (pattern.startsWith("!")) {
    negated = true;
    pattern = pattern.slice(1);
  }

  const directoryOnly = pattern.endsWith("/");
  pattern = pattern.replace(/\/+$/u, "");
  const anchored = pattern.startsWith("/");
  pattern = pattern.replace(/^\/+/u, "");
  const regex = ignorePatternToRegex(pattern, anchored);

  return {
    rawPattern,
    negated,
    directoryOnly,
    anchored,
    regex
  };
}

function ignorePatternToRegex(pattern, anchored) {
  const escaped = pattern
    .split("")
    .map((char) => {
      if (char === "*") {
        return "[^/]*";
      }
      if (char === "?") {
        return "[^/]";
      }
      return escapeRegex(char);
    })
    .join("");

  const prefix = anchored || pattern.includes("/") ? "^" : "(^|.*/)";
  return new RegExp(`${prefix}${escaped}(/.*)?$`);
}

function isIgnored(relativePath, isDirectory, rules) {
  let ignored = false;
  for (const rule of rules) {
    if (rule.directoryOnly && !isDirectory && !relativePath.startsWith(`${rule.rawPattern.replace(/\/+$/u, "")}/`)) {
      continue;
    }
    if (rule.regex.test(relativePath)) {
      ignored = !rule.negated;
    }
  }
  return ignored;
}

function isExcludedPath(relativePath) {
  const normalized = normalizePath(relativePath);
  const parts = normalized.split("/");
  if (parts.some((part) => EXCLUDED_DIRS.has(part))) {
    return true;
  }

  const basename = path.posix.basename(normalized);
  const lower = basename.toLowerCase();
  if (lower.endsWith(".min.js") || lower.endsWith(".min.css") || lower.endsWith(".bundle.js")) {
    return true;
  }

  if (isGeneratedPath(normalized)) {
    return true;
  }

  const extension = path.posix.extname(lower);
  return BINARY_EXTENSIONS.has(extension);
}

function inspectEligibleFile(absolutePath, relativePath) {
  const stat = fs.statSync(absolutePath);
  if (stat.size > MAX_TEXT_FILE_BYTES) {
    return { eligible: false, reason: "too_large" };
  }

  const lower = relativePath.toLowerCase();
  const extension = path.posix.extname(lower);
  if (BINARY_EXTENSIONS.has(extension)) {
    return { eligible: false, reason: "binary_extension" };
  }

  const fd = fs.openSync(absolutePath, "r");
  try {
    const sample = Buffer.alloc(Math.min(4096, stat.size));
    fs.readSync(fd, sample, 0, sample.length, 0);
    if (sample.includes(0)) {
      return { eligible: false, reason: "binary_content" };
    }
  } finally {
    fs.closeSync(fd);
  }

  return { eligible: true, bytes: stat.size };
}

function countLines(absolutePath) {
  const buffer = fs.readFileSync(absolutePath);
  if (buffer.length === 0) {
    return 0;
  }

  let lines = 0;
  for (const byte of buffer) {
    if (byte === 10) {
      lines += 1;
    }
  }
  return buffer[buffer.length - 1] === 10 ? lines : lines + 1;
}

function languageForFile(relativePath) {
  const basename = path.posix.basename(normalizePath(relativePath));
  if (basename === "Dockerfile") {
    return "Dockerfile";
  }
  return LANGUAGE_BY_EXTENSION.get(path.posix.extname(basename.toLowerCase())) || "Other";
}

function classifyFile(relativePath) {
  const normalized = normalizePath(relativePath);
  const basename = path.posix.basename(normalized);
  const lower = normalized.toLowerCase();

  if (CONFIG_FILENAMES.has(basename) || CONFIG_FILENAMES.has(basename.toLowerCase()) || isCiPath(normalized)) {
    return "config";
  }

  if (
    lower.includes("/test/") ||
    lower.includes("/tests/") ||
    lower.includes("/__tests__/") ||
    lower.endsWith(".test.js") ||
    lower.endsWith(".test.ts") ||
    lower.endsWith(".spec.js") ||
    lower.endsWith(".spec.ts") ||
    lower.endsWith("_test.go") ||
    lower.endsWith("_test.py") ||
    lower.startsWith("test_")
  ) {
    return "test";
  }

  return "source";
}

function isCiPath(relativePath) {
  const normalized = normalizePath(relativePath);
  const basename = path.posix.basename(normalized);
  return normalized.startsWith(".github/workflows/") ||
    basename === ".gitlab-ci.yml" ||
    basename === "azure-pipelines.yml" ||
    basename === "bitbucket-pipelines.yml" ||
    basename === "Jenkinsfile";
}

function isGeneratedPath(relativePath) {
  const normalized = normalizePath(relativePath).toLowerCase();
  const basename = path.posix.basename(normalized);
  return normalized.includes("/generated/") ||
    normalized.includes("/gen/") ||
    basename.includes(".generated.") ||
    basename.includes(".gen.") ||
    basename.endsWith("_generated.go") ||
    basename.endsWith(".pb.go") ||
    basename.endsWith("_pb2.py") ||
    basename.endsWith(".d.ts.map") ||
    basename === "package-lock.json" ||
    basename === "yarn.lock" ||
    basename === "pnpm-lock.yaml";
}

function promptNameWords(prompt) {
  return [...new Set(
    String(prompt)
      .toLowerCase()
      .match(/[a-z0-9]+/g)
      ?.filter((word) => word.length >= 3) || []
  )];
}

function matchesPromptWords(relativePath, words) {
  if (words.length === 0) {
    return false;
  }
  const filename = path.posix.basename(normalizePath(relativePath)).toLowerCase();
  return words.some((word) => filename.includes(word));
}

function sortObject(object) {
  return Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));
}

function normalizePath(value) {
  return value.replace(/\\/g, "/");
}

function escapeRegex(char) {
  return /[|\\{}()[\]^$+*?.]/u.test(char) ? `\\${char}` : char;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
