# Prime Agent Vis — Build Plan

## What we're building

A visualizer for Prime Agent sessions that shows the full LLM call timeline: what goes into the LLM, what comes out, what tools were called with what arguments, and what those tools returned.

Inspired by Kimi CLI's `kimi vis` — but for Prime Agent's session format.

## The data source

Every Prime Agent session is a single JSONL file at `~/.prime/agent/sessions/<uuid>.jsonl`.

Each line is one event. The events form a tree (each entry has `id` and `parentId`).

### Event types in the file

| Event type | What it is | Example fields |
|-----------|-----------|----------------|
| `session` | First line — the header | `id`, `cwd`, `git`, `rlmDepth` |
| `model_change` | Which model is active | `modelId`, `provider` |
| `thinking_level_change` | Thinking level set | `thinkingLevel` |
| `session_state` | Lifecycle state | `state.status` |
| `message` (role=`user`) | User input — goes INTO the LLM | `content[].text` |
| `message` (role=`assistant`) | LLM output — comes OUT of the LLM | `content[]` (thinking, text, toolCall), `usage`, `model` |
| `message` (role=`toolResult`) | Tool result — goes INTO the LLM on next call | `toolCallId`, `toolName`, `content[].text`, `details`, `isError` |
| `agent_status` | Agent status update | `status.summary` |
| `git_state` | Git state snapshot | `git.repoUrl`, `git.commit` |
| `custom` | Extension data (not sent to LLM) | `customType`, `data` |
| `custom_message` | Extension message (sent to LLM) | `customType`, `content` |
| `compaction` | Context compaction event | `summary`, `tokensBefore` |

### The timeline pattern

```
session header → model_change → thinking_level → session_state

👤 USER: "help me with kimi vis"                    ← goes INTO LLM #1

🤖 LLM #1 OUTPUT:
  💭 thinking: "Let me search for..."
  🔧 tool call: ipython({"code": "..."})
  📊 usage: input=12941, output=172, cost=$0.02

📤 TOOL RESULT: ipython returned "src/kimi_cli/..."  ← goes INTO LLM #2

🤖 LLM #2 OUTPUT:
  💭 thinking: "Found vis.py, let me..."
  🔧 tool call: ipython({"code": "..."})

📤 TOOL RESULT: ipython returned "import typer..."

🤖 LLM #3 OUTPUT:
  💭 thinking: "Now I understand..."
  ✅ text: "Here's what kimi vis is..."              ← final answer, no more tools

👤 USER: "next question..."                         ← goes INTO LLM #4
```

### Exact JSON structure of each block

**Assistant message (LLM output):**
```json
{
  "type": "message",
  "id": "abc123",
  "parentId": "prev123",
  "timestamp": "2026-08-16T05:09:40.668Z",
  "message": {
    "role": "assistant",
    "content": [
      {"type": "thinking", "text": "Let me search for..."},
      {"type": "text", "text": "Found it. Here's what..."},
      {"type": "toolCall", "id": "call_f49a", "name": "ipython",
       "arguments": {"code": "import subprocess
..."}}
    ],
    "model": "glm-5.2",
    "provider": "opencode-go",
    "usage": {
      "input": 12941,
      "output": 172,
      "totalTokens": 13113,
      "cost": {"input": 0.018, "output": 0.0008, "total": 0.019}
    },
    "stopReason": "tool_use",
    "timestamp": 1786857049345
  }
}
```

**Tool result message:**
```json
{
  "type": "message",
  "id": "def456",
  "parentId": "abc123",
  "timestamp": "2026-08-16T05:09:41.000Z",
  "message": {
    "role": "toolResult",
    "toolCallId": "call_f49a",
    "toolName": "ipython",
    "content": [{"type": "text", "text": "src/kimi_cli/cli/vis.py:11:..."}],
    "details": {"durationMs": 30, "status": "ok", "stdout": "...", "stderr": ""},
    "isError": false,
    "timestamp": 1786857049345
  }
}
```

## Package approach

Build it as a **Prime Agent extension + package** so colleagues can install it with one command.

### Install command (for colleagues)
```bash
# From npm (once published)
prime-agent package install npm:prime-agent-vis

# From git
prime-agent package install git:github.com/yourname/prime-agent-vis

# From local path (for testing)
prime-agent -e ./prime-agent-vis
```

### Then users type `/vis` inside Prime Agent → browser opens with the timeline.

## Package structure

```
prime-agent-vis/
├── package.json           ← declares the pi extension
├── index.ts               ← extension entry point (registers /vis command)
├── run.py                 ← Python quick-test server (pure stdlib, no Node needed)
├── src/
│   ├── parser.ts          ← parse session JSONL → timeline
│   └── server.ts          ← HTTP server (Node built-in http module)
├── static/
│   ├── index.html         ← frontend (single file, no React, no build step)
│   ├── app.js             ← timeline rendering logic
│   └── style.css          ← dark theme styles
└── PLANNING.md            ← this file
```

### package.json
```json
{
  "name": "prime-agent-vis",
  "version": "0.1.0",
  "type": "module",
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

## Build phases

### Phase 1: Parser (`src/parser.ts`)

**Goal:** Read a session `.jsonl` file and produce a flat timeline array.

**Input:** path to a session file (e.g. `~/.prime/agent/sessions/01a008f9-....jsonl`)

**Output:** a JSON object with:
```typescript
interface SessionTimeline {
  header: {
    id: string;
    cwd: string;
    git?: { repoUrl?: string; commit?: string };
    rlmDepth: number;
    timestamp: string;
  };
  model: string;
  thinkingLevel: string;
  blocks: TimelineBlock[];
}

type TimelineBlock =
  | { type: "user_input"; timestamp: string; text: string }
  | { type: "llm_output"; timestamp: string; model: string;
      thinking?: string; text?: string;
      tool_calls: { id: string; name: string; arguments: Record<string, unknown> }[];
      usage?: { input: number; output: number; totalTokens: number; cost?: { total: number } };
    }
  | { type: "tool_result"; timestamp: string;
      tool_call_id: string; tool_name: string;
      output: string; details?: Record<string, unknown>;
      is_error: boolean;
    };
```

**Logic:**
1. Read file line by line
2. Parse each line as JSON
3. First line = session header → extract id, cwd, git, rlmDepth
4. `model_change` → track current model
5. `thinking_level_change` → track thinking level
6. `message` with role=`user` → create `user_input` block
7. `message` with role=`assistant` → create `llm_output` block, extract thinking/text/toolCalls/usage
8. `message` with role=`toolResult` → create `tool_result` block, extract output/details/isError
9. Skip `agent_status`, `git_state`, `session_state` (not needed for timeline)
10. Return the assembled timeline

**Estimated size:** ~120 lines

### Phase 2: HTTP Server (`src/server.ts`)

**Goal:** Serve the static frontend + one API endpoint.

**Endpoints:**
- `GET /api/sessions` → list all sessions (scan `~/.prime/agent/sessions/*.jsonl`, return metadata)
- `GET /api/sessions/:id` → return the parsed timeline (calls parser)
- `GET /api/sessions/:id/summary` → aggregate stats (turns, tool calls, tokens, cost, duration)
- `GET /*` → serve static files from the `static/` directory

**Implementation:** Use Node's built-in `http` module. No Express, no dependencies.

**Port:** Start at 8765, find available port if in use.

**Estimated size:** ~100 lines

### Phase 3: Frontend (`static/index.html` + `app.js` + `style.css`)

**Goal:** A timeline view that looks like a logs viewer.

**Layout:**
- **Top bar:** session ID, model, thinking level, total tokens, total cost
- **Timeline:** vertical scroll of blocks, color-coded:
  - 🟦 Blue = user input
  - 🟨 Yellow = LLM output (shows thinking, text, tool calls, usage)
  - 🟧 Orange = tool call (expandable — shows exact arguments JSON)
  - 🟩 Green = tool result (expandable — shows exact output text, duration, error)
- **Click a tool call** → bottom split panel:
  - Left: input JSON (pretty-printed, copyable)
  - Right: output JSON (pretty-printed, copyable)

**No build step.** Vanilla HTML/CSS/JS. No React, no bundler, no npm install needed for the frontend.

**Estimated size:** ~400 lines total (HTML + JS + CSS)

### Phase 4: Extension wrapper (`index.ts`)

**Goal:** Register the `/vis` slash command that starts the server.

**Logic:**
1. `pi.registerCommand("vis", ...)`
2. On command: get the current session file from `ctx.sessionManager`
3. Start the HTTP server (from Phase 2)
4. Open the browser to `http://localhost:8765`
5. Notify the user with the URL

**Estimated size:** ~40 lines

### Phase 5: Testing & packaging

1. Test locally: `prime-agent -e ./prime-agent-vis`, type `/vis`
2. Verify the timeline renders correctly with real session data
3. Add `package.json` with `pi` manifest
4. Publish to git/npm
5. Test installation: `prime-agent package install git:github.com/...`

## Build order

| Step | What | Status |
|------|------|--------|
| 1 | Write `PLANNING.md` (this file) | ✅ Done |
| 2 | Create the package directory structure | ✅ Done |
| 3 | Build `src/parser.ts` — parse session JSONL → timeline | ✅ Done |
| 4 | Test parser against real session files | ✅ Done |
| 5 | Build `src/server.ts` — HTTP server + API | ✅ Done |
| 6 | Build `static/index.html` + `app.js` + `style.css` — timeline frontend | ✅ Done |
| 7 | Build `index.ts` — extension wrapper with `/vis` command | ✅ Done |
| 8 | Test end-to-end with `prime-agent -e ./prime-agent-vis` | ✅ Done |
| 9 | Package and document installation instructions | ✅ Done (git/npm publish is a manual external step) |

## Confidence level

**97%** — verified from source code (Prime Agent session format, extension API, package system) and real session data on disk.
