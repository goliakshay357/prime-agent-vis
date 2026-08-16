#!/usr/bin/env python3
"""
Prime Agent Vis — quick-test server (pure Python, standard library only).

Runs the exact same visualizer frontend with no Node.js required:

    python3 run.py          # serves on http://localhost:8765
    python3 run.py 9000     # use a custom port

API (identical to src/server.ts):
    GET /api/sessions               -> list all sessions
    GET /api/sessions/<id>          -> parsed timeline for one session
    GET /api/sessions/<id>/summary  -> aggregate stats for one session
    GET /*                          -> static files from static/

Data source: ~/.prime/agent/sessions/*.jsonl
"""

import json
import os
import re
import sys
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
SESSIONS_DIR = Path.home() / ".prime" / "agent" / "sessions"
DEFAULT_PORT = 8765
LIVE_SESSION_ID = os.environ.get("PRIME_VIS_LIVE_SESSION", "01a00950-b7dc-76e2-8f8d-5c2f99191da9")
JUPYTER_URL = os.environ.get("PRIME_VIS_JUPYTER_URL", "http://localhost:8890/lab/tree/kernel-live.ipynb?token=kimi")

MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
}


# ─── Parser (mirrors src/parser.ts) ──────────────────────────────────────

def _extract_text(content):
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "\n".join(
        b["text"]
        for b in content
        if isinstance(b, dict) and b.get("type") == "text" and isinstance(b.get("text"), str)
    )


def _extract_thinking(content):
    if not isinstance(content, list):
        return None
    for b in content:
        if isinstance(b, dict) and b.get("type") == "thinking":
            t = b.get("thinking") or b.get("text")  # 'thinking' is the real field
            if isinstance(t, str) and t:
                return t
    return None


def _extract_tool_calls(content):
    if not isinstance(content, list):
        return []
    calls = []
    for b in content:
        if isinstance(b, dict) and b.get("type") == "toolCall":
            calls.append(
                {
                    "id": b.get("id", "unknown"),
                    "name": b.get("name", "unknown"),
                    "arguments": b.get("arguments") or {},
                }
            )
    return calls


def _extract_tool_result_text(content):
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts = []
    for b in content:
        if isinstance(b, dict):
            if b.get("type") == "text" and isinstance(b.get("text"), str):
                parts.append(b["text"])
            elif b.get("type") == "image":
                parts.append("[image: %s]" % b.get("mimeType", "unknown"))
    return "\n".join(parts)


def _iter_entries(file_path):
    with open(file_path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def _parse_ts(ts):
    """Match JS `new Date(x).getTime()`; return epoch ms or None if unparseable."""
    if ts is None or ts == "":
        return None
    if isinstance(ts, (int, float)):
        return float(ts)
    s = str(ts)
    try:
        return float(s)  # epoch-millis numeric string
    except ValueError:
        pass
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000.0
    except ValueError:
        return None


def parse_session(file_path):
    header = None
    model = "unknown"
    thinking_level = "off"
    blocks = []
    index = 0

    for entry in _iter_entries(file_path):
        etype = entry.get("type", "")

        if etype == "session":
            header = {
                "id": entry.get("id", ""),
                "cwd": entry.get("cwd", ""),
                "git": entry.get("git"),
                "rlmDepth": entry.get("rlmDepth"),
                "timestamp": entry.get("timestamp", ""),
            }
        elif etype == "model_change":
            model = entry.get("modelId", "unknown")
        elif etype == "thinking_level_change":
            thinking_level = entry.get("thinkingLevel", "off")
        elif etype == "message":
            msg = entry.get("message") or {}
            role = msg.get("role", "")
            ts = entry.get("timestamp", "")

            if role == "user":
                blocks.append(
                    {
                        "type": "user_input",
                        "timestamp": ts,
                        "text": _extract_text(msg.get("content")),
                        "index": index,
                    }
                )
                index += 1
            elif role == "assistant":
                content = msg.get("content")
                block = {
                    "type": "llm_output",
                    "timestamp": ts,
                    "model": msg.get("model", model),
                    "thinking": _extract_thinking(content),
                    "text": _extract_text(content),
                    "tool_calls": _extract_tool_calls(content),
                    "stop_reason": msg.get("stopReason"),
                    "index": index,
                }
                usage = msg.get("usage")
                if usage:
                    block["usage"] = {
                        "input": usage.get("input", 0),
                        "output": usage.get("output", 0),
                        "totalTokens": usage.get("totalTokens", 0),
                        "cost": usage.get("cost"),
                    }
                blocks.append(block)
                index += 1
                if msg.get("model"):
                    model = msg["model"]
            elif role == "toolResult":
                blocks.append(
                    {
                        "type": "tool_result",
                        "timestamp": ts,
                        "tool_call_id": msg.get("toolCallId", ""),
                        "tool_name": msg.get("toolName", "unknown"),
                        "output": _extract_tool_result_text(msg.get("content")),
                        "details": msg.get("details"),
                        "is_error": msg.get("isError") is True,
                        "index": index,
                    }
                )
                index += 1
        elif etype == "custom_message":
            blocks.append(
                {
                    "type": "custom_message",
                    "timestamp": entry.get("timestamp", ""),
                    "custom_type": entry.get("customType", "custom"),
                    "text": _extract_text(entry.get("content")),
                    "index": index,
                }
            )
            index += 1
        elif etype == "compaction":
            blocks.append(
                {
                    "type": "compaction",
                    "timestamp": entry.get("timestamp", ""),
                    "summary": entry.get("summary", ""),
                    "tokens_before": entry.get("tokensBefore", 0),
                    "index": index,
                }
            )
            index += 1
        elif etype == "branch_summary":
            blocks.append(
                {
                    "type": "branch_summary",
                    "timestamp": entry.get("timestamp", ""),
                    "from_id": entry.get("fromId", ""),
                    "summary": entry.get("summary", ""),
                    "index": index,
                }
            )
            index += 1

    if header is None:
        return None
    return {"header": header, "model": model, "thinking_level": thinking_level, "blocks": blocks}


def list_sessions():
    items = []
    if not SESSIONS_DIR.is_dir():
        return items

    for file_path in SESSIONS_DIR.glob("*.jsonl"):
        try:
            stat = file_path.stat()
            entries = list(_iter_entries(file_path))
            header = entries[0] if entries else {}

            message_count = 0
            first_message = ""
            for entry in entries:
                if entry.get("type") == "message":
                    message_count += 1
                    msg = entry.get("message") or {}
                    if not first_message and msg.get("role") == "user":
                        first_message = _extract_text(msg.get("content"))[:100]

            items.append(
                {
                    "id": header.get("id", file_path.stem),
                    "filename": file_path.name,
                    "cwd": header.get("cwd", ""),
                    "timestamp": header.get("timestamp", ""),
                    "message_count": message_count,
                    "first_message": first_message or "(no messages)",
                    "file_size": stat.st_size,
                    "modified": stat.st_mtime * 1000.0,  # ms, matches JS mtimeMs
                }
            )
        except Exception:
            continue

    items.sort(key=lambda x: x["modified"], reverse=True)
    return items


def compute_summary(timeline):
    turns = 0
    llm_calls = 0
    tool_calls = 0
    errors = 0
    compactions = 0
    input_tokens = 0
    output_tokens = 0
    total_tokens = 0
    total_cost = 0.0
    tools_used = {}

    first_ts = None
    last_ts = None

    for block in timeline["blocks"]:
        ts = _parse_ts(block.get("timestamp"))
        if ts is not None:
            if first_ts is None:
                first_ts = ts
            last_ts = ts

        btype = block["type"]
        if btype == "user_input":
            turns += 1
        elif btype == "llm_output":
            llm_calls += 1
            calls = block.get("tool_calls") or []
            tool_calls += len(calls)
            for tc in calls:
                name = tc.get("name", "unknown")
                tools_used[name] = tools_used.get(name, 0) + 1
            usage = block.get("usage")
            if usage:
                input_tokens += usage.get("input", 0)
                output_tokens += usage.get("output", 0)
                total_tokens += usage.get("totalTokens", 0)
                cost = usage.get("cost") or {}
                if cost.get("total"):
                    total_cost += cost["total"]
        elif btype == "tool_result":
            if block.get("is_error"):
                errors += 1
        elif btype == "compaction":
            compactions += 1

    duration_sec = (last_ts - first_ts) / 1000.0 if first_ts is not None and last_ts is not None else 0.0

    return {
        "session_id": timeline["header"]["id"],
        "turns": turns,
        "llm_calls": llm_calls,
        "tool_calls": tool_calls,
        "errors": errors,
        "compactions": compactions,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": total_tokens,
        "total_cost": total_cost,
        "duration_sec": duration_sec,
        "tools_used": tools_used,
    }


# ─── HTTP handler ────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    def _send_json(self, data, status=200):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_error(self, message, status=404):
        self._send_json({"error": message}, status)

    def _send_static(self, path):
        if path == "/":
            path = "/index.html"
        static_root = STATIC_DIR.resolve()
        file_path = (static_root / path.lstrip("/")).resolve()
        if not str(file_path).startswith(str(static_root) + "/") or not file_path.is_file():
            self._send_error("Not found", 404)
            return
        body = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", MIME_TYPES.get(file_path.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _handle_get_session(self, session_id):
        file_path = SESSIONS_DIR / ("%s.jsonl" % session_id)
        if not file_path.is_file():
            self._send_error("Session not found: %s" % session_id, 404)
            return
        timeline = parse_session(file_path)
        if timeline is None:
            self._send_error("Failed to parse session: %s" % session_id, 500)
            return
        self._send_json(timeline)

    def _handle_get_summary(self, session_id):
        file_path = SESSIONS_DIR / ("%s.jsonl" % session_id)
        if not file_path.is_file():
            self._send_error("Session not found: %s" % session_id, 404)
            return
        timeline = parse_session(file_path)
        if timeline is None:
            self._send_error("Failed to parse session: %s" % session_id, 500)
            return
        self._send_json(compute_summary(timeline))

    def do_GET(self):
        path = self.path.split("?", 1)[0]

        if path == "/api/live":
            self._send_json({"live_session_id": LIVE_SESSION_ID, "jupyter_url": JUPYTER_URL})
            return

        if path == "/api/sessions":
            self._send_json({"sessions": list_sessions()})
            return

        m = re.match(r"^/api/sessions/([^/]+)$", path)
        if m:
            self._handle_get_session(unquote(m.group(1)))
            return

        m = re.match(r"^/api/sessions/([^/]+)/summary$", path)
        if m:
            self._handle_get_summary(unquote(m.group(1)))
            return

        if not path.startswith("/api/"):
            self._send_static(path)
            return

        self._send_error("Not found", 404)

    def log_message(self, fmt, *args):  # quiet by default
        pass


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print("Prime Agent Vis server running at http://localhost:%d" % port)
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
