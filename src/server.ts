/**
 * HTTP server for the Prime Agent visualizer.
 *
 * Serves:
 *   GET /api/sessions              → list all sessions
 *   GET /api/sessions/:id          → parsed timeline for one session
 *   GET /api/sessions/:id/summary  → aggregate stats for one session
 *   GET /*                         → static files from static/
 *
 * Uses only Node built-in modules — no Express, no dependencies.
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, basename, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { parseSession, listSessions, computeSummary, type SessionTimeline, type SessionListItem } from "./parser.js";

// ─── Config ──────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = join(__dirname, "..", "static");
const DEFAULT_PORT = 8765;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

// ─── Helpers ─────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function sendError(res: ServerResponse, message: string, status = 404): void {
  sendJson(res, { error: message }, status);
}

function findAvailablePort(start: number): number {
  // Simple check — try the default port, if it fails the caller can retry
  return start;
}

function serveStatic(path: string, res: ServerResponse): void {
  if (path === "/") path = "/index.html";

  const filePath = join(STATIC_DIR, path);
  const resolved = resolve(filePath);

  // Security: prevent path traversal
  if (!resolved.startsWith(STATIC_DIR)) {
    sendError(res, "Not found", 404);
    return;
  }

  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    sendError(res, "Not found", 404);
    return;
  }

  const ext = extname(resolved);
  const mime = MIME_TYPES[ext] ?? "application/octet-stream";

  try {
    const content = readFileSync(resolved);
    res.writeHead(200, { "Content-Type": mime });
    res.end(content);
  } catch {
    sendError(res, "Failed to read file", 500);
  }
}

// ─── API Handlers ────────────────────────────────────────────────────

function handleListSessions(res: ServerResponse): void {
  try {
    const sessions: SessionListItem[] = listSessions();
    sendJson(res, { sessions });
  } catch (err) {
    sendError(res, `Failed to list sessions: ${String(err)}`, 500);
  }
}

function handleGetSession(res: ServerResponse, sessionId: string): void {
  // Find the session file
  const sessionsDir = join(homedir(), ".prime", "agent", "sessions");
  const sessionPath = join(sessionsDir, `${sessionId}.jsonl`);

  if (!existsSync(sessionPath)) {
    sendError(res, `Session not found: ${sessionId}`, 404);
    return;
  }

  const timeline: SessionTimeline | null = parseSession(sessionPath);
  if (!timeline) {
    sendError(res, `Failed to parse session: ${sessionId}`, 500);
    return;
  }

  sendJson(res, timeline);
}

function handleGetSummary(res: ServerResponse, sessionId: string): void {
  const sessionsDir = join(homedir(), ".prime", "agent", "sessions");
  const sessionPath = join(sessionsDir, `${sessionId}.jsonl`);

  if (!existsSync(sessionPath)) {
    sendError(res, `Session not found: ${sessionId}`, 404);
    return;
  }

  const timeline = parseSession(sessionPath);
  if (!timeline) {
    sendError(res, `Failed to parse session: ${sessionId}`, 500);
    return;
  }

  const summary = computeSummary(timeline);
  sendJson(res, summary);
}

// ─── Router ──────────────────────────────────────────────────────────

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const rawUrl = req.url ?? "/";
  const method = req.method ?? "GET";
  // Strip the query string so deep links like /?session=abc route correctly.
  const url = rawUrl.split("?")[0];

  if (method !== "GET") {
    sendError(res, "Method not allowed", 405);
    return;
  }

  // API routes
  if (url === "/api/sessions") {
    handleListSessions(res);
    return;
  }

  const sessionMatch = url.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionMatch) {
    handleGetSession(res, decodeURIComponent(sessionMatch[1]));
    return;
  }

  const summaryMatch = url.match(/^\/api\/sessions\/([^/]+)\/summary$/);
  if (summaryMatch) {
    handleGetSummary(res, decodeURIComponent(summaryMatch[1]));
    return;
  }

  // Static files
  if (!url.startsWith("/api/")) {
    serveStatic(url, res);
    return;
  }

  sendError(res, "Not found", 404);
}

// ─── Start Server ────────────────────────────────────────────────────

export function startVisServer(port: number = DEFAULT_PORT): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer(handleRequest);

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        // Try next port
        const nextPort = port + 1;
        if (nextPort <= port + 10) {
          startVisServer(nextPort).then(resolve).catch(reject);
          return;
        }
      }
      reject(err);
    });

    server.listen(port, "127.0.0.1", () => {
      const url = `http://localhost:${port}`;
      resolve(url);
    });
  });
}

// ─── CLI entry point (for standalone testing) ────────────────────────

// If run directly (not imported as a module), start the server
if (import.meta.url === `file://${process.argv[1]}`) {
  startVisServer()
    .then((url) => {
      console.log(`\nPrime Agent Vis server running at ${url}\n`);
      console.log("Press Ctrl+C to stop.\n");
    })
    .catch((err) => {
      console.error("Failed to start server:", err);
      process.exit(1);
    });
}
