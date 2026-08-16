/**
 * Session parser — reads a Prime Agent session .jsonl file and produces
 * a flat timeline of blocks for the visualizer.
 *
 * Block types:
 *   - user_input:  what the user typed (goes INTO the LLM)
 *   - llm_output:  what the LLM produced (comes OUT of the LLM)
 *   - tool_result: what a tool returned (goes INTO the LLM on next call)
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

// ─── Types ───────────────────────────────────────────────────────────

export interface SessionHeader {
  id: string;
  cwd: string;
  git?: { repoUrl?: string; commit?: string; branch?: string };
  rlmDepth?: number;
  timestamp: string;
}

export interface ToolCallInfo {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface UsageInfo {
  input: number;
  output: number;
  totalTokens: number;
  cost?: { input?: number; output?: number; total?: number };
}

export type TimelineBlock =
  | {
      type: "user_input";
      timestamp: string;
      text: string;
      index: number;
    }
  | {
      type: "llm_output";
      timestamp: string;
      model: string;
      thinking?: string;
      text?: string;
      tool_calls: ToolCallInfo[];
      usage?: UsageInfo;
      stop_reason?: string;
      index: number;
    }
  | {
      type: "tool_result";
      timestamp: string;
      tool_call_id: string;
      tool_name: string;
      output: string;
      details?: Record<string, unknown>;
      is_error: boolean;
      index: number;
    }
  | {
      type: "custom_message";
      timestamp: string;
      custom_type: string;
      text: string;
      index: number;
    }
  | {
      type: "compaction";
      timestamp: string;
      summary: string;
      tokens_before: number;
      index: number;
    }
  | {
      type: "branch_summary";
      timestamp: string;
      from_id: string;
      summary: string;
      index: number;
    };

export interface SessionTimeline {
  header: SessionHeader;
  model: string;
  thinking_level: string;
  system_prompt?: string;
  blocks: TimelineBlock[];
}

export interface SessionListItem {
  id: string;
  filename: string;
  cwd: string;
  timestamp: string;
  message_count: number;
  first_message: string;
  file_size: number;
  modified: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────

/** Extract text from message content (array of blocks or plain string). */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text)
    .join("\n");
}

/** Extract thinking text from assistant message content. */
function extractThinking(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const block of content as any[]) {
    if (block?.type === "thinking") {
      const t = block.thinking ?? block.text; // 'thinking' is the real field; 'text' as fallback
      if (typeof t === "string" && t.length > 0) return t;
    }
  }
  return undefined;
}

/** Extract tool calls from assistant message content. */
function extractToolCalls(content: unknown): ToolCallInfo[] {
  if (!Array.isArray(content)) return [];
  return (content as any[])
    .filter((block: any) => block?.type === "toolCall")
    .map((block: any) => ({
      id: block.id ?? "unknown",
      name: block.name ?? "unknown",
      arguments: (block.arguments ?? {}) as Record<string, unknown>,
    }));
}

/** Extract text from a tool result message. */
function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as any[])
    .map((block: any) => {
      if (block?.type === "text" && typeof block.text === "string") return block.text;
      if (block?.type === "image") return `[image: ${block.mimeType ?? "unknown"}]`;
      return "";
    })
    .join("\n");
}

// ─── Parse Session File ───────────────────────────────────────────────

export function parseSession(filePath: string): SessionTimeline | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  const lines = raw.split("\n").filter((l) => l.trim().length > 0);

  let header: SessionHeader | null = null;
  let model = "unknown";
  let thinkingLevel = "off";
  let systemPrompt: string | undefined;
  const blocks: TimelineBlock[] = [];
  let blockIndex = 0;

  for (const line of lines) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const type: string = entry?.type ?? "";

    // Session header (first line)
    if (type === "session") {
      header = {
        id: entry.id ?? "",
        cwd: entry.cwd ?? "",
        git: entry.git,
        rlmDepth: entry.rlmDepth,
        timestamp: entry.timestamp ?? "",
      };
      continue;
    }

    // Model change
    if (type === "model_change") {
      model = entry.modelId ?? "unknown";
      continue;
    }

    // Thinking level change
    if (type === "thinking_level_change") {
      thinkingLevel = entry.thinkingLevel ?? "off";
      continue;
    }

    // Messages
    if (type === "message") {
      const msg = entry.message;
      if (!msg) continue;

      const role: string = msg.role ?? "";
      const ts: string = entry.timestamp ?? "";

      if (role === "user") {
        blocks.push({
          type: "user_input",
          timestamp: ts,
          text: extractText(msg.content),
          index: blockIndex++,
        });
      } else if (role === "assistant") {
        const content = msg.content;
        blocks.push({
          type: "llm_output",
          timestamp: ts,
          model: msg.model ?? model,
          thinking: extractThinking(content),
          text: extractText(content),
          tool_calls: extractToolCalls(content),
          usage: msg.usage
            ? {
                input: msg.usage.input ?? 0,
                output: msg.usage.output ?? 0,
                totalTokens: msg.usage.totalTokens ?? 0,
                cost: msg.usage.cost,
              }
            : undefined,
          stop_reason: msg.stopReason,
          index: blockIndex++,
        });

        // If the assistant message itself has a model set, update current model
        if (msg.model) {
          model = msg.model;
        }
      } else if (role === "toolResult") {
        blocks.push({
          type: "tool_result",
          timestamp: ts,
          tool_call_id: msg.toolCallId ?? "",
          tool_name: msg.toolName ?? "unknown",
          output: extractToolResultText(msg.content),
          details: msg.details as Record<string, unknown> | undefined,
          is_error: msg.isError === true,
          index: blockIndex++,
        });
      }
    }

    // System prompt (captured by the extension at runtime)
    if (type === "custom" && entry.customType === "system_prompt" && entry.data?.prompt) {
      systemPrompt = entry.data.prompt;
      continue;
    }

    // Custom message (extension-injected input sent to the LLM)
    if (type === "custom_message") {
      blocks.push({
        type: "custom_message",
        timestamp: entry.timestamp ?? "",
        custom_type: entry.customType ?? "custom",
        text: extractText(entry.content),
        index: blockIndex++,
      });
      continue;
    }

    // Context compaction (history replaced by a summary)
    if (type === "compaction") {
      blocks.push({
        type: "compaction",
        timestamp: entry.timestamp ?? "",
        summary: entry.summary ?? "",
        tokens_before: entry.tokensBefore ?? 0,
        index: blockIndex++,
      });
      continue;
    }

    // Branch summary (tree navigation)
    if (type === "branch_summary") {
      blocks.push({
        type: "branch_summary",
        timestamp: entry.timestamp ?? "",
        from_id: entry.fromId ?? "",
        summary: entry.summary ?? "",
        index: blockIndex++,
      });
      continue;
    }

    // Skip: agent_status, git_state, session_state, custom, label,
    // session_info, child_usage_attributed
  }

  if (!header) return null;

  return {
    header,
    model,
    thinking_level: thinkingLevel,
    system_prompt: systemPrompt,
    blocks,
  };
}

// ─── List Sessions ───────────────────────────────────────────────────

function getSessionsDir(): string {
  const agentDir = join(homedir(), ".prime", "agent");
  return join(agentDir, "sessions");
}

export function listSessions(): SessionListItem[] {
  const sessionsDir = getSessionsDir();
  let files: string[];
  try {
    files = readdirSync(sessionsDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => join(sessionsDir, f));
  } catch {
    return [];
  }

  const items: SessionListItem[] = [];

  for (const filePath of files) {
    try {
      const stats = statSync(filePath);
      // Read first line for header
      const content = readFileSync(filePath, "utf8");
      const firstLine = content.split("\n")[0];
      const header = JSON.parse(firstLine);

      // Count messages and find first user message
      let messageCount = 0;
      let firstMessage = "";
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.type === "message") {
            messageCount++;
            if (!firstMessage && entry.message?.role === "user") {
              firstMessage = extractText(entry.message.content).slice(0, 100);
            }
          }
        } catch {
          continue;
        }
      }

      items.push({
        id: header.id ?? basename(filePath, ".jsonl"),
        filename: basename(filePath),
        cwd: header.cwd ?? "",
        timestamp: header.timestamp ?? "",
        message_count: messageCount,
        first_message: firstMessage || "(no messages)",
        file_size: stats.size,
        modified: stats.mtimeMs,
      });
    } catch {
      continue;
    }
  }

  // Sort by most recently modified
  items.sort((a, b) => b.modified - a.modified);

  return items;
}

// ─── Summary Stats ───────────────────────────────────────────────────

export interface SessionSummary {
  session_id: string;
  turns: number;
  llm_calls: number;
  tool_calls: number;
  errors: number;
  compactions: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  total_cost: number;
  duration_sec: number;
  tools_used: Record<string, number>;
}

export function computeSummary(timeline: SessionTimeline): SessionSummary {
  let turns = 0;
  let llmCalls = 0;
  let toolCalls = 0;
  let errors = 0;
  let compactions = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let totalCost = 0;
  const toolsUsed: Record<string, number> = {};

  let firstTs: number | null = null;
  let lastTs: number | null = null;

  for (const block of timeline.blocks) {
    // Track timestamps for duration
    const ts = new Date(block.timestamp).getTime();
    if (!isNaN(ts)) {
      if (firstTs === null) firstTs = ts;
      lastTs = ts;
    }

    if (block.type === "user_input") {
      turns++;
    } else if (block.type === "llm_output") {
      llmCalls++;
      toolCalls += block.tool_calls.length;
      for (const tc of block.tool_calls) {
        toolsUsed[tc.name] = (toolsUsed[tc.name] ?? 0) + 1;
      }
      if (block.usage) {
        inputTokens += block.usage.input;
        outputTokens += block.usage.output;
        totalTokens += block.usage.totalTokens;
        if (block.usage.cost?.total) {
          totalCost += block.usage.cost.total;
        }
      }
    } else if (block.type === "tool_result") {
      if (block.is_error) errors++;
    } else if (block.type === "compaction") {
      compactions++;
    }
  }

  const durationSec = firstTs !== null && lastTs !== null ? (lastTs - firstTs) / 1000 : 0;

  return {
    session_id: timeline.header.id,
    turns,
    llm_calls: llmCalls,
    tool_calls: toolCalls,
    errors,
    compactions,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    total_cost: totalCost,
    duration_sec: durationSec,
    tools_used: toolsUsed,
  };
}
