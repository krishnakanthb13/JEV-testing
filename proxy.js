#!/usr/bin/env node
"use strict";

/*
 * Local CORS proxy for the Jev Test Console.
 *
 * The OpenCode Console and TypeSafe API refuse direct browser (CORS) calls.
 * This proxy runs on your machine only (127.0.0.1), forwards requests to a
 * fixed set of upstreams, and adds CORS headers so the web page can call it.
 *
 * Usage:  node proxy.js            (optional: PORT=9000 node proxy.js)
 * Routes: http://localhost:8787/opencode/v1/systemone
 *         http://localhost:8787/opencode/v1/models
 *         http://localhost:8787/typesafe/v1/systemone
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 8787;
const PID_FILE = path.join(__dirname, ".jev-proxy.pid");

const ROUTES = {
  "/opencode/v1/systemone": "https://opencode.ai/inference/systemone/v1/systemone",
  "/opencode/v1/models": "https://opencode.ai/inference/v1/models",
  "/typesafe/v1/systemone": "https://api.typesafe.ai/v1/systemone",
};

const FORWARD_HEADERS = ["authorization", "content-type", "accept", "typesafe-danger-zone-images"];
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 30 * 1000;

function applyCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", FORWARD_HEADERS.join(", "));
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader("Cache-Control", "no-store");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;

    function fail(err) {
      if (done) return;
      done = true;
      reject(err);
    }

    req.on("data", (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        chunks.length = 0;
        fail(Object.assign(new Error("Request body too large"), { code: "BODY_TOO_LARGE" }));
        // Keep draining so the client can read the 413 response instead of
        // seeing a connection reset. The handler no longer stores the data.
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", fail);
  });
}

const server = http.createServer(async (req, res) => {
  applyCors(res);
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (!["GET", "POST", "HEAD"].includes(req.method)) {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed." }));
    return;
  }

  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const upstream = ROUTES[url.pathname];
  if (!upstream) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "Unknown route.",
        routes: Object.keys(ROUTES),
      })
    );
    return;
  }

  const headers = {};
  for (const name of FORWARD_HEADERS) {
    if (req.headers[name]) headers[name] = req.headers[name];
  }

  try {
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
    const upstreamRes = await fetch(upstream, {
      method: req.method,
      headers,
      body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    const text = await upstreamRes.text();
    res.writeHead(upstreamRes.status, {
      "Content-Type": upstreamRes.headers.get("content-type") || "application/json",
    });
    res.end(text);
  } catch (err) {
    if (err && err.code === "BODY_TOO_LARGE") {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Request body is too large." }));
      return;
    }
    const timedOut = err && (err.name === "TimeoutError" || err.name === "AbortError");
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: timedOut
          ? "The upstream API did not respond in time."
          : "Proxy could not reach the upstream API: " + String(err),
      })
    );
  }
});

server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Stop the other process or set PORT.`);
  } else {
    console.error("Server error:", err);
  }
  process.exitCode = 1;
});

server.on("clientError", (err, socket) => {
  if (socket && socket.writable) {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  try {
    fs.writeFileSync(PID_FILE, String(process.pid));
  } catch {
    /* pid tracking is best effort */
  }
  console.log(`Jev proxy listening on http://localhost:${PORT} (loopback only)`);
  console.log(`Process id ${process.pid} written to ${path.basename(PID_FILE)}`);
  for (const [route, target] of Object.entries(ROUTES)) {
    console.log(`  ${route}  ->  ${target}`);
  }
  console.log("Point the Jev Test Console at a Local proxy endpoint while this runs.");
});

function cleanupPidFile() {
  try {
    fs.rmSync(PID_FILE, { force: true });
  } catch {
    /* ignore */
  }
}

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  cleanupPidFile();
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
  cleanupPidFile();
  process.exit(1);
});
process.on("SIGINT", () => {
  cleanupPidFile();
  process.exit(0);
});
process.on("SIGTERM", () => {
  cleanupPidFile();
  process.exit(0);
});
process.on("exit", cleanupPidFile);
