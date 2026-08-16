/**
 * Prime Agent Vis — extension entry point.
 *
 * Registers the `/vis` slash command. When run, it:
 *   1. Starts the local HTTP server (in-process, non-blocking) on first use
 *   2. Resolves the target (an explicit session id, or the current session)
 *   3. Opens the visualizer in the system browser
 *
 * The server keeps running in the Prime Agent process until the process exits.
 * Calling /vis again reuses the existing server instead of starting a new one.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { startVisServer } from "./src/server.js";

// Cached across /vis invocations so we never start a second server.
let visServerUrl: string | null = null;

async function ensureServer(): Promise<string> {
  if (!visServerUrl) {
    visServerUrl = await startVisServer();
  }
  return visServerUrl;
}

/** Open a URL in the user's default browser (best-effort, never blocks). */
async function openInBrowser(pi: ExtensionAPI, url: string): Promise<void> {
  const platform = process.platform;
  if (platform === "darwin") {
    await pi.exec("open", [url]);
  } else if (platform === "win32") {
    await pi.exec("cmd", ["/c", "start", "", url]);
  } else {
    await pi.exec("xdg-open", [url]);
  }
}

export default function (pi: ExtensionAPI) {
  // The system prompt is assembled at runtime and not otherwise persisted.
  // Capture it once per session as a `custom` entry so the visualizer can show it.
  let systemPromptCaptured = false;
  pi.on("session_start", async () => {
    systemPromptCaptured = false;
  });
  pi.on("before_agent_start", async (event) => {
    if (systemPromptCaptured) return;
    systemPromptCaptured = true;
    pi.appendEntry("system_prompt", { prompt: event.systemPrompt });
  });

  pi.registerCommand("vis", {
    description: "Open the Prime Agent session visualizer in your browser",
    handler: async (args, ctx) => {
      try {
        const baseUrl = await ensureServer();

        // Resolve the target URL:
        //   1. `/vis <sessionId>`  → open that specific session
        //   2. `/vis`              → open the current session (if persisted), else the list
        const requested = args.trim();
        let target = baseUrl;

        if (requested) {
          const id = requested.replace(/\.jsonl$/, "");
          target = `${baseUrl}/?session=${encodeURIComponent(id)}`;
        } else {
          const sessionFile = ctx.sessionManager.getSessionFile();
          const sessionId = ctx.sessionManager.getSessionId();
          if (sessionFile && existsSync(sessionFile)) {
            target = `${baseUrl}/?session=${encodeURIComponent(sessionId)}`;
          }
        }

        await openInBrowser(pi, target);
        ctx.ui.notify(`Visualizer opened: ${target}`, "info");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Failed to open visualizer: ${message}`, "error");
      }
    },
  });
}
