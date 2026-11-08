#!/usr/bin/env node
"use strict";

/*
 * Stops the servers started from this folder.
 *
 * proxy.js and serve.js write their process id into .jev-proxy.pid and
 * .jev-app.pid when they start. This script reads those files, verifies the
 * pids still belong to node processes, stops them (with their child tree),
 * and removes the pid files. Processes not started from this folder are
 * never touched.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = __dirname;

const TARGETS = [
  { file: ".jev-proxy.pid", label: "proxy", port: 8787 },
  { file: ".jev-app.pid", label: "app", port: 8080 },
];

const IS_WINDOWS = process.platform === "win32";

function isNodeProcess(pid) {
  if (!IS_WINDOWS) {
    try {
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
      return cmdline.includes("node");
    } catch {
      try {
        const out = execSync(`ps -p ${pid} -o comm=`, {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        return /node/i.test(out);
      } catch {
        return false;
      }
    }
  }
  try {
    const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return /node\.exe/i.test(out);
  } catch {
    return false;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

let stopped = 0;

for (const target of TARGETS) {
  const pidFile = path.join(ROOT, target.file);

  if (!fs.existsSync(pidFile)) {
    console.log(`  ${target.label}: not tracked (no ${target.file}), leaving port ${target.port} alone`);
    continue;
  }

  const raw = fs.readFileSync(pidFile, "utf8").trim();
  fs.rmSync(pidFile, { force: true });
  const pid = Number(raw);

  if (!Number.isInteger(pid) || pid <= 0) {
    console.log(`  ${target.label}: removed an invalid pid file`);
    continue;
  }

  if (!isAlive(pid)) {
    console.log(`  ${target.label}: already stopped, removed a stale pid file`);
    continue;
  }

  if (!isNodeProcess(pid)) {
    console.log(`  ${target.label}: pid ${pid} is not a node process, leaving it alone`);
    continue;
  }

  try {
    if (IS_WINDOWS) {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
    } else {
      process.kill(pid, "SIGTERM");
    }
    console.log(`  ${target.label}: stopped (node pid ${pid}, port ${target.port})`);
    stopped += 1;
  } catch {
    console.log(`  ${target.label}: could not stop node pid ${pid}`);
  }
}

if (stopped === 0) console.log("  nothing was stopped");
console.log("Done.");
