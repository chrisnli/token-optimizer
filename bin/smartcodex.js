#!/usr/bin/env node
import { runHarness } from "../src/harness-cli.js";

const exitCode = await runHarness(process.argv.slice(2), {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
  cwd: process.cwd()
});

process.exitCode = exitCode;
