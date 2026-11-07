#!/usr/bin/env node
"use strict";

/*
 * Zero-dependency static server for the Jev Test Console PWA.
 * A service worker needs http(s), so the app cannot run from file://.
 *
 * Usage: node serve.js            (optional: PORT=9000 node serve.js)
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 8080;
const ROOT = __dirname;
const PID_FILE = path.join(ROOT, ".jev-app.pid");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

function send(res, status, body, type) {
  res.writeHead(status, {
    "Content-Type": type || "text/plain; charset=utf-8",
    "Cache-Control": "no-cache",
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, "Method not allowed");
    return;
  }

  const pathname = decodeURIComponent(new URL(req.url, `http://127.0.0.1:${PORT}`).pathname);
  const relative = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(ROOT, "." + relative);

  // Refuse anything that escapes the app directory.
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    send(res, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // Unknown path: fall back to the app shell.
      fs.readFile(path.join(ROOT, "index.html"), (err2, shell) => {
        if (err2) {
          send(res, 500, "index.html is missing");
          return;
        }
        send(res, 200, req.method === "HEAD" ? "" : shell, MIME[".html"]);
      });
      return;
    }
    const type = MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    send(res, 200, req.method === "HEAD" ? "" : data, type);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  try {
    fs.writeFileSync(PID_FILE, String(process.pid));
  } catch {
    /* pid tracking is best effort */
  }
  console.log(`Jev Test Console served at http://localhost:${PORT} (loopback only)`);
  console.log(`Process id ${process.pid} written to ${path.basename(PID_FILE)}`);
  console.log("Open that URL in your browser. Press Ctrl+C to stop, or run stop.bat.");
});

function cleanupPidFile() {
  try {
    fs.rmSync(PID_FILE, { force: true });
  } catch {
    /* ignore */
  }
}

process.on("SIGINT", () => {
  cleanupPidFile();
  process.exit(0);
});
process.on("SIGTERM", () => {
  cleanupPidFile();
  process.exit(0);
});
process.on("exit", cleanupPidFile);
