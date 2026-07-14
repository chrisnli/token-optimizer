import fs from "node:fs";
import { profileRepository as defaultProfileRepository } from "./profile.js";
import { fixedClassifierModel, runCodexClassifier as defaultRunCodexClassifier } from "./codex-runner.js";

const DEFAULT_ROUTE_MODELS = {
  economy: "gpt-5.4-mini",
  balanced: "gpt-5.4",
  advanced: "gpt-5.6-sol"
};

export async function runCli(argv, io, deps = {}) {
  const profileRepository = deps.profileRepository || defaultProfileRepository;
  const runCodexClassifier = deps.runCodexClassifier || defaultRunCodexClassifier;
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

  const prompt = options.promptParts.length > 0
    ? options.promptParts.join(" ")
    : await readStdin(io.stdin);

  if (!prompt.trim()) {
    io.stderr.write("A coding prompt is required as an argument or on stdin.\n");
    return 2;
  }

  const classifierModel = fixedClassifierModel(io.env);
  const requestedModel = options.model;
  const codexBin = io.env.SMARTCODEX_CODEX_BIN || "codex";
  const timeoutMs = parsePositiveInteger(io.env.SMARTCODEX_TIMEOUT_MS, 120000);
  const maxManifestFiles = parsePositiveInteger(io.env.SMARTCODEX_MAX_MANIFEST_FILES, 2000);
  const runs = [];

  try {
    for (let index = 0; index < options.repeat; index += 1) {
      const repoProfile = profileRepository(io.cwd, prompt, { maxManifestFiles });
      const run = await runCodexClassifier({
        prompt,
        repoProfile,
        classifierModel,
        codexBin,
        timeoutMs,
        env: io.env
      });

      runs.push({
        index: index + 1,
        classifierModel,
        requestedModel,
        recommendedModel: recommendedModelForRoute(run.classification.routeId, io.env),
        classification: run.classification,
        metrics: run.metrics,
        validation: run.validation
      });

      if (!run.validation.valid) {
        const report = {
          error: "Codex classifier returned JSON that did not match the schema.",
          validation: run.validation,
          metrics: run.metrics,
          classification: run.classification
        };
        io.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
        return 1;
      }
    }

    if (options.saveResults) {
      fs.appendFileSync(options.saveResults, runs.map((run) => JSON.stringify(run)).join("\n") + "\n", "utf8");
    }

    const report = options.repeat === 1
      ? runs[0]
      : { runs, summary: summarizeRuns(runs) };

    io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`${JSON.stringify(errorReport(error), null, 2)}\n`);
    return 1;
  }
}

function recommendedModelForRoute(routeId, env = {}) {
  const key = `SMARTCODEX_ROUTE_${routeId.toUpperCase()}_MODEL`;
  return env[key] || DEFAULT_ROUTE_MODELS[routeId] || null;
}

function parseArgs(argv) {
  const options = {
    help: false,
    model: null,
    repeat: 1,
    saveResults: null,
    promptParts: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--model") {
      options.model = requireValue(argv, index, "--model");
      index += 1;
      continue;
    }
    if (arg === "--repeat") {
      options.repeat = parseRepeat(requireValue(argv, index, "--repeat"));
      index += 1;
      continue;
    }
    if (arg === "--save-results") {
      options.saveResults = requireValue(argv, index, "--save-results");
      index += 1;
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
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function parseRepeat(value) {
  const repeat = Number.parseInt(value, 10);
  if (!Number.isInteger(repeat) || repeat < 1) {
    throw new Error("--repeat must be a positive integer");
  }
  return repeat;
}

function summarizeRuns(runs) {
  const routeCounts = new Map();
  const tokenSums = {
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0
  };
  let latencySum = 0;

  for (const run of runs) {
    const routeId = run.classification.routeId;
    routeCounts.set(routeId, (routeCounts.get(routeId) || 0) + 1);
    for (const key of Object.keys(tokenSums)) {
      tokenSums[key] += run.metrics[key] ?? 0;
    }
    latencySum += run.metrics.latencyMs ?? 0;
  }

  const [routeId, count] = [...routeCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  const divisor = runs.length || 1;
  return {
    repeat: runs.length,
    averageTokens: Object.fromEntries(Object.entries(tokenSums).map(([key, value]) => [key, round(value / divisor)])),
    averageLatencyMs: round(latencySum / divisor),
    routeAgreement: {
      routeId,
      count,
      ratio: round(count / divisor)
    }
  };
}

function errorReport(error) {
  const report = {
    error: error.message,
    code: error.code || "SMARTCODEX_CLASSIFY_ERROR"
  };
  if (error.exitCode !== undefined) {
    report.exitCode = error.exitCode;
  }
  if (error.command) {
    report.command = error.command;
  }
  if (error.stderr) {
    report.stderr = error.stderr.trim();
  }
  if (error.stdout) {
    report.stdout = error.stdout.trim();
  }
  return report;
}

function helpText() {
  return [
    "Usage:",
    "  smartcodex-classify \"prompt\"",
    "  smartcodex-classify --model <model> \"prompt\"",
    "  smartcodex-classify --repeat 5 \"prompt\"",
    "  smartcodex-classify --save-results results.jsonl \"prompt\"",
    "",
    "Reads a prompt from stdin when no prompt argument is provided.",
    "",
    "The classifier always uses SMARTCODEX_CLASSIFIER_MODEL, or its built-in cheap default.",
    "--model is accepted as a downstream model preference and does not change the classifier model."
  ].join("\n") + "\n";
}

function readStdin(stdin) {
  return new Promise((resolve, reject) => {
    let data = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk) => {
      data += chunk;
    });
    stdin.on("error", reject);
    stdin.on("end", () => resolve(data));
    if (stdin.isTTY) {
      resolve("");
    }
  });
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function round(value) {
  return Math.round(value * 100) / 100;
}
