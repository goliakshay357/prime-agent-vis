# Prime Agent Vis

A visualizer + debugger for [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) sessions. Know what went into the model and what came out, turn by turn.

<img width="1425" height="733" alt="image" src="https://github.com/user-attachments/assets/caae1425-5a84-4fb1-b792-3d76bc23698b" />

### See what is running inside the iPython kernal

<img width="1426" height="735" alt="image" src="https://github.com/user-attachments/assets/d997ce29-ae35-4ea0-ad87-ebbc3ee2a37c" />

## Features

- **Session explorer** — folder-level grouping, search, sort, dark/light theme
- **Turn → Step timeline** — numbered turns and steps, clickable sidebar with scroll-spy
- **Full LLM I/O** — user input, thinking, text, tool calls, tool results (with the exact executed code), errors
- **Session constants** — system prompt + available tools (captured when run as an extension)
- **Stats** — cache hit-rate, tool latency, slowest tool, token-over-time chart
- **Live updates** — the timeline polls the session file every second
- **Live kernel** — embed a real JupyterLab attached to the running kernel (optional)

<img width="1429" height="738" alt="image" src="https://github.com/user-attachments/assets/6e9bbcc8-f09a-4cc8-bf0a-92ff1922b14f" />

## Install

```bash
prime-agent package install git:github.com/goliakshay357/prime-agent-vis
```

## Run

Start Prime Agent, then type `/vis`:

```bash
prime-agent
/vis
```

This starts the built-in server and opens the visualizer in your browser. No other process needed.

### Alternative: Python quick-test server (no extension)

```bash
python3 run.py          # serves on http://localhost:8765
```

## Capturing the system prompt + tools

Those constants are only recorded when Prime Agent runs *with* this extension (it hooks `before_agent_start` and stores them in the session). Start it with:

```bash
prime-agent -e /path/to/prime-agent-vis
```

…then the ⚙️ System prompt and 🧰 Tools blocks will populate for that session.

## Live kernel (optional)

To attach a real JupyterLab to the running kernel (the "🐍 Live Kernel" button):

```bash
# one-time setup
uv venv ~/.prime/agent/jupyter-venv --python 3.13
uv pip install --python ~/.prime/agent/jupyter-venv/bin/python jupyterlab jupyter_existing_provisioner

# launch it, pointing at the kernel's connection file
EXISTING_CONNECTION_FILE=<kernel connection.json> \
  ~/.prime/agent/jupyter-venv/bin/jupyter lab --no-browser --port 8890 \
  --KernelProvisionerFactory.default_provisioner_name=existing-provisioner
```

## How it works

The extension reads `~/.prime/agent/sessions/*.jsonl` and parses each entry (messages, tool calls, usage, compactions, custom messages, branch summaries, etc.) into a timeline. The frontend is vanilla HTML/CSS/JS — no build step, no npm dependencies.

## Structure

- `index.ts` — the Prime Agent extension (registers `/vis`, captures system prompt + tools)
- `src/parser.ts` — parses session JSONL → timeline + summary
- `src/server.ts` — Node HTTP server (API + static serving)
- `static/` — the frontend (`index.html`, `app.js`, `style.css`)
- `run.py` — Python quick-test server (same API, no Node)
