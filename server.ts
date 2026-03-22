#!/usr/bin/env bun
/**
 * claude-swarm-mcp MCP server
 *
 * Spawned by Claude Code as a stdio MCP server (one per instance).
 * Connects to the shared broker daemon for peer discovery, messaging,
 * task delegation, and shared snippets.
 *
 * Declares claude/channel capability to push inbound messages immediately.
 *
 * Features over claude-peers:
 *   - WebSocket real-time push (with HTTP polling fallback)
 *   - Broadcast messages
 *   - Task delegation (delegate, list, complete)
 *   - Shared code snippets
 *   - Peer tags/groups
 *   - Message history
 *   - Auto-reconnect
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  PeerId,
  Peer,
  Task,
  Snippet,
  SharedFile,
  Alert,
  Pin,
  PeerAnalytics,
  RegisterResponse,
  PollMessagesResponse,
  WsEvent,
} from "./shared/types.ts";
import {
  generateSummary,
  getGitBranch,
  getRecentFiles,
} from "./shared/summarize.ts";

// --- Configuration ---

const BROKER_PORT = parseInt(process.env.CLAUDE_SWARM_PORT ?? process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const WS_URL = `ws://127.0.0.1:${BROKER_PORT}/ws`;
const POLL_INTERVAL_MS = 2000; // Fallback poll interval (WebSocket is primary)
const HEARTBEAT_INTERVAL_MS = 15_000;
const WS_RECONNECT_DELAY_MS = 3000;
const BROKER_SCRIPT = new URL("./broker.ts", import.meta.url).pathname;

// --- Broker communication ---

async function brokerFetch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Broker error (${path}): ${res.status} ${err}`);
  }
  return res.json() as Promise<T>;
}

async function isBrokerAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${BROKER_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureBroker(): Promise<void> {
  if (await isBrokerAlive()) {
    log("Broker already running");
    return;
  }

  log("Starting broker daemon...");
  const proc = Bun.spawn(["bun", BROKER_SCRIPT], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  proc.unref();

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await isBrokerAlive()) {
      log("Broker started");
      return;
    }
  }
  throw new Error("Failed to start broker daemon after 6 seconds");
}

// --- Utility ---

function log(msg: string) {
  console.error(`[claude-swarm] ${msg}`);
}

async function getGitRoot(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
      cwd, stdout: "pipe", stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code === 0) return text.trim();
  } catch { /* not a git repo */ }
  return null;
}

function getTty(): string | null {
  try {
    const ppid = process.ppid;
    if (ppid) {
      const proc = Bun.spawnSync(["ps", "-o", "tty=", "-p", String(ppid)]);
      const tty = new TextDecoder().decode(proc.stdout).trim();
      if (tty && tty !== "?" && tty !== "??") return tty;
    }
  } catch { /* ignore */ }
  return null;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) };
}

// --- State ---

let myId: PeerId | null = null;
let myCwd = process.cwd();
let myGitRoot: string | null = null;
let wsSocket: WebSocket | null = null;
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let usePolling = false; // Fall back to polling if WS fails

// --- MCP Server ---

const mcp = new Server(
  { name: "claude-swarm", version: "1.0.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: `You are connected to the claude-swarm network. Other Claude Code instances on this machine can see you and send you messages, delegate tasks, and share code snippets.

IMPORTANT: When you receive a <channel source="claude-swarm" ...> message, RESPOND IMMEDIATELY. Pause what you are doing, handle the message (reply, accept task, etc.), then resume your work. Treat incoming peer messages like a coworker tapping you on the shoulder.

Available tools:
- list_peers: Discover other Claude Code instances (scope: machine/directory/repo, optional tag filter)
- send_message: Send a message to another instance by ID
- broadcast_message: Send a message to ALL peers (or filtered by scope)
- message_history: View past sent/received messages
- set_summary: Set a summary of what you're working on
- set_tags: Tag yourself with labels (e.g. "frontend", "backend", "devops")
- set_status: Set your status (active/busy/away/dnd)
- check_messages: Manually check for new messages
- delegate_task: Assign a task to another peer
- list_tasks: See pending/completed tasks
- complete_task: Mark a task as done with an optional result
- share_snippet: Share a code snippet with all peers
- list_snippets: See all shared snippets
- get_snippet: Get a specific snippet by ID
- share_file: Share a file with peers (max 1MB)
- list_shared_files: List shared files
- get_shared_file: Get a shared file by ID
- alert_peer: Send an urgent alert to a specific peer (info/warning/critical)
- alert_all: Send an urgent alert to all peers
- pin_message: Pin an important message for all peers
- list_pins: See all pinned messages
- unpin_message: Remove a pin
- peer_stats: Get analytics for yourself or another peer
- request_review: Ask a peer to review your git changes
- sync_status: Broadcast your git status to all peers

When you start, proactively call set_summary, set_tags, and set_status to help other instances understand your context.`,
  }
);

// --- Tool definitions ---

const TOOLS = [
  {
    name: "list_peers",
    description: "List other Claude Code instances. Returns their ID, directory, git repo, summary, and tags.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scope: {
          type: "string" as const,
          enum: ["machine", "directory", "repo"],
          description: '"machine" = all instances. "directory" = same cwd. "repo" = same git repo.',
        },
        tag: {
          type: "string" as const,
          description: 'Optional: filter peers by tag (e.g. "frontend").',
        },
      },
      required: ["scope"],
    },
  },
  {
    name: "send_message",
    description: "Send a message to another Claude Code instance by peer ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to_id: { type: "string" as const, description: "Target peer ID (from list_peers)" },
        message: { type: "string" as const, description: "The message to send" },
      },
      required: ["to_id", "message"],
    },
  },
  {
    name: "broadcast_message",
    description: "Send a message to ALL peers at once. Useful for announcements like 'I just pushed changes, please pull'.",
    inputSchema: {
      type: "object" as const,
      properties: {
        message: { type: "string" as const, description: "The message to broadcast" },
        scope: {
          type: "string" as const,
          enum: ["machine", "directory", "repo"],
          description: 'Scope of broadcast. Default: "machine" (all peers).',
        },
      },
      required: ["message"],
    },
  },
  {
    name: "message_history",
    description: "View past messages (sent and received). Shows timestamp, from, to, text, and delivered status.",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: { type: "number" as const, description: "Max messages to return (default: 20)" },
      },
    },
  },
  {
    name: "set_summary",
    description: "Set a brief summary (1-2 sentences) of what you're currently working on. Visible to other peers.",
    inputSchema: {
      type: "object" as const,
      properties: {
        summary: { type: "string" as const, description: "A 1-2 sentence summary of your current work" },
      },
      required: ["summary"],
    },
  },
  {
    name: "set_tags",
    description: 'Tag yourself with labels like "frontend", "backend", "devops". Visible in list_peers and can be used to filter.',
    inputSchema: {
      type: "object" as const,
      properties: {
        tags: {
          type: "array" as const,
          items: { type: "string" as const },
          description: 'Array of tag labels, e.g. ["frontend", "react", "testing"]',
        },
      },
      required: ["tags"],
    },
  },
  {
    name: "check_messages",
    description: "Manually check for new messages. Messages are normally pushed automatically via WebSocket/channel notifications.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "delegate_task",
    description: "Send a task request to another peer with a description and optional deadline.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to_id: { type: "string" as const, description: "Target peer ID" },
        description: { type: "string" as const, description: "Task description" },
        deadline: { type: "string" as const, description: "Optional deadline (ISO timestamp or human-readable)" },
      },
      required: ["to_id", "description"],
    },
  },
  {
    name: "list_tasks",
    description: "See pending/completed tasks assigned to you or by you.",
    inputSchema: {
      type: "object" as const,
      properties: {
        role: {
          type: "string" as const,
          enum: ["assignee", "assigner", "all"],
          description: '"assignee" = tasks assigned to me. "assigner" = tasks I assigned. "all" = both. Default: "all".',
        },
      },
    },
  },
  {
    name: "complete_task",
    description: "Mark a task as done with an optional result message.",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: { type: "number" as const, description: "Task ID to complete" },
        result: { type: "string" as const, description: "Optional result/summary of what was done" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "share_snippet",
    description: "Share a code snippet or text with a title (visible to all peers).",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: { type: "string" as const, description: "Title for the snippet" },
        content: { type: "string" as const, description: "The code or text content" },
        language: { type: "string" as const, description: 'Language identifier (e.g. "typescript", "python"). Default: "text"' },
      },
      required: ["title", "content"],
    },
  },
  {
    name: "list_snippets",
    description: "See all shared code snippets.",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: { type: "number" as const, description: "Max snippets to return (default: 20)" },
      },
    },
  },
  {
    name: "get_snippet",
    description: "Get a specific shared snippet by ID, including its full content.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "number" as const, description: "Snippet ID" },
      },
      required: ["id"],
    },
  },
  // --- New tools ---
  {
    name: "set_status",
    description: 'Set your status: "active", "busy", "away", or "dnd" (do not disturb). Visible to all peers.',
    inputSchema: {
      type: "object" as const,
      properties: {
        status: {
          type: "string" as const,
          enum: ["active", "busy", "away", "dnd"],
          description: "Your status",
        },
      },
      required: ["status"],
    },
  },
  {
    name: "share_file",
    description: "Share a file with all peers. Reads the file content and stores it (max 1MB).",
    inputSchema: {
      type: "object" as const,
      properties: {
        file_path: { type: "string" as const, description: "Absolute path to the file to share" },
      },
      required: ["file_path"],
    },
  },
  {
    name: "list_shared_files",
    description: "List all shared files (without content). Use get_shared_file to retrieve content.",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: { type: "number" as const, description: "Max files to return (default: 20)" },
      },
    },
  },
  {
    name: "get_shared_file",
    description: "Get a shared file by ID, including its content.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "number" as const, description: "File ID" },
      },
      required: ["id"],
    },
  },
  {
    name: "alert_peer",
    description: "Send an urgent alert to a specific peer. Different from regular messages - shows with priority flag.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to_id: { type: "string" as const, description: "Target peer ID" },
        message: { type: "string" as const, description: "Alert message" },
        priority: {
          type: "string" as const,
          enum: ["info", "warning", "critical"],
          description: "Alert priority level",
        },
      },
      required: ["to_id", "message", "priority"],
    },
  },
  {
    name: "alert_all",
    description: "Send an urgent alert to ALL peers. Use for critical announcements.",
    inputSchema: {
      type: "object" as const,
      properties: {
        message: { type: "string" as const, description: "Alert message" },
        priority: {
          type: "string" as const,
          enum: ["info", "warning", "critical"],
          description: "Alert priority level",
        },
      },
      required: ["message", "priority"],
    },
  },
  {
    name: "pin_message",
    description: "Pin an important message visible to all peers. Persists until unpinned.",
    inputSchema: {
      type: "object" as const,
      properties: {
        content: { type: "string" as const, description: "Message to pin" },
      },
      required: ["content"],
    },
  },
  {
    name: "list_pins",
    description: "See all pinned messages.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "unpin_message",
    description: "Remove a pinned message by ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        pin_id: { type: "number" as const, description: "Pin ID to remove" },
      },
      required: ["pin_id"],
    },
  },
  {
    name: "peer_stats",
    description: "Get analytics for yourself or another peer: messages sent/received, tasks, snippets, etc.",
    inputSchema: {
      type: "object" as const,
      properties: {
        target_id: { type: "string" as const, description: "Peer ID to get stats for (default: yourself)" },
      },
    },
  },
  {
    name: "request_review",
    description: "Ask a peer to review your recent git changes. Sends git diff summary to the peer.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to_id: { type: "string" as const, description: "Target peer ID" },
      },
      required: ["to_id"],
    },
  },
  {
    name: "sync_status",
    description: "Broadcast your git status (branch, uncommitted changes, last commit) to all peers.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scope: {
          type: "string" as const,
          enum: ["machine", "directory", "repo"],
          description: 'Scope of broadcast. Default: "machine".',
        },
      },
    },
  },
];

// --- Tool handlers ---

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (!myId && name !== "check_messages") {
    // Allow check_messages to work regardless, but others need registration
    if (!["list_peers"].includes(name)) {
      return textResult("Not registered with broker yet", true);
    }
  }

  try {
    switch (name) {
      case "list_peers": {
        const { scope, tag } = args as { scope: string; tag?: string };
        const peers = await brokerFetch<Peer[]>("/list-peers", {
          scope, cwd: myCwd, git_root: myGitRoot, exclude_id: myId, tag,
        });

        if (peers.length === 0) {
          return textResult(`No other Claude Code instances found (scope: ${scope}${tag ? `, tag: ${tag}` : ""}).`);
        }

        const lines = peers.map((p) => {
          const tags = (() => { try { return JSON.parse(p.tags) as string[]; } catch { return []; } })();
          const statusIcon = { active: "🟢", busy: "🟡", away: "⚪", dnd: "🔴" }[p.status ?? "active"] ?? "🟢";
          const parts = [`${statusIcon} ID: ${p.id}`, `PID: ${p.pid}`, `Status: ${p.status ?? "active"}`, `CWD: ${p.cwd}`];
          if (p.git_root) parts.push(`Repo: ${p.git_root}`);
          if (p.tty) parts.push(`TTY: ${p.tty}`);
          if (p.summary) parts.push(`Summary: ${p.summary}`);
          if (tags.length > 0) parts.push(`Tags: ${tags.join(", ")}`);
          parts.push(`Last seen: ${p.last_seen}`);
          return parts.join("\n  ");
        });

        return textResult(`Found ${peers.length} peer(s) (scope: ${scope}):\n\n${lines.join("\n\n")}`);
      }

      case "send_message": {
        const { to_id, message } = args as { to_id: string; message: string };
        const result = await brokerFetch<{ ok: boolean; error?: string; warning?: string }>("/send-message", {
          from_id: myId, to_id, text: message,
        });
        if (!result.ok) return textResult(`Failed to send: ${result.error}`, true);
        const warn = result.warning ? `\n${result.warning}` : "";
        return textResult(`Message sent to peer ${to_id}${warn}`);
      }

      case "broadcast_message": {
        const { message, scope } = args as { message: string; scope?: string };
        const result = await brokerFetch<{ ok: boolean; count: number }>("/broadcast-message", {
          from_id: myId, text: message, scope: scope ?? "machine", cwd: myCwd, git_root: myGitRoot,
        });
        return textResult(`Broadcast sent to ${result.count} peer(s)`);
      }

      case "message_history": {
        const { limit } = args as { limit?: number };
        const messages = await brokerFetch<Array<{ id: number; from_id: string; to_id: string; text: string; sent_at: string; delivered: number }>>("/message-history", {
          peer_id: myId, limit: limit ?? 20,
        });
        if (messages.length === 0) return textResult("No message history.");

        const lines = messages.map((m) => {
          const dir = m.from_id === myId ? `-> ${m.to_id}` : `<- ${m.from_id}`;
          const status = m.delivered ? "delivered" : "pending";
          return `[${m.sent_at}] ${dir} (${status})\n  ${m.text}`;
        });
        return textResult(`Message history (${messages.length}):\n\n${lines.join("\n\n")}`);
      }

      case "set_summary": {
        const { summary } = args as { summary: string };
        await brokerFetch("/set-summary", { id: myId, summary });
        return textResult(`Summary updated: "${summary}"`);
      }

      case "set_tags": {
        const { tags } = args as { tags: string[] };
        await brokerFetch("/set-tags", { id: myId, tags });
        return textResult(`Tags updated: [${tags.join(", ")}]`);
      }

      case "check_messages": {
        if (!myId) return textResult("Not registered with broker yet", true);
        const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });
        if (result.messages.length === 0) return textResult("No new messages.");
        const lines = result.messages.map((m) => `From ${m.from_id} (${m.sent_at}):\n${m.text}`);
        return textResult(`${result.messages.length} new message(s):\n\n${lines.join("\n\n---\n\n")}`);
      }

      case "delegate_task": {
        const { to_id, description, deadline } = args as { to_id: string; description: string; deadline?: string };
        const result = await brokerFetch<{ ok: boolean; task_id: number }>("/delegate-task", {
          from_id: myId, to_id, description, deadline: deadline ?? null,
        });
        return textResult(`Task #${result.task_id} delegated to peer ${to_id}`);
      }

      case "list_tasks": {
        const { role } = args as { role?: string };
        const tasks = await brokerFetch<Task[]>("/list-tasks", {
          peer_id: myId, role: role ?? "all",
        });
        if (tasks.length === 0) return textResult("No tasks found.");

        const lines = tasks.map((t) => {
          const dir = t.from_id === myId ? `Assigned to: ${t.to_id}` : `From: ${t.from_id}`;
          const parts = [`Task #${t.id} [${t.state.toUpperCase()}]`, dir, `Description: ${t.description}`];
          if (t.deadline) parts.push(`Deadline: ${t.deadline}`);
          if (t.result) parts.push(`Result: ${t.result}`);
          parts.push(`Updated: ${t.updated_at}`);
          return parts.join("\n  ");
        });
        return textResult(`Tasks (${tasks.length}):\n\n${lines.join("\n\n")}`);
      }

      case "complete_task": {
        const { task_id, result: taskResult } = args as { task_id: number; result?: string };
        const res = await brokerFetch<{ ok: boolean; error?: string }>("/update-task", {
          task_id, peer_id: myId, state: "completed", result: taskResult,
        });
        if (!res.ok) return textResult(`Failed: ${res.error}`, true);
        return textResult(`Task #${task_id} marked as completed`);
      }

      case "share_snippet": {
        const { title, content, language } = args as { title: string; content: string; language?: string };
        const result = await brokerFetch<{ ok: boolean; snippet_id: number }>("/share-snippet", {
          author_id: myId, title, content, language: language ?? "text",
        });
        return textResult(`Snippet #${result.snippet_id} shared: "${title}"`);
      }

      case "list_snippets": {
        const { limit } = args as { limit?: number };
        const snippets = await brokerFetch<Snippet[]>("/list-snippets", { limit: limit ?? 20 });
        if (snippets.length === 0) return textResult("No shared snippets.");

        const lines = snippets.map((s) =>
          `#${s.id} "${s.title}" (${s.language}) by ${s.author_id} at ${s.created_at}`
        );
        return textResult(`Shared snippets (${snippets.length}):\n\n${lines.join("\n")}`);
      }

      case "get_snippet": {
        const { id } = args as { id: number };
        const snippet = await brokerFetch<Snippet | null>("/get-snippet", { id });
        if (!snippet) return textResult(`Snippet #${id} not found`, true);

        return textResult(
          `Snippet #${snippet.id}: "${snippet.title}"\nAuthor: ${snippet.author_id}\nLanguage: ${snippet.language}\nCreated: ${snippet.created_at}\n\n\`\`\`${snippet.language}\n${snippet.content}\n\`\`\``
        );
      }

      // --- New tool handlers ---

      case "set_status": {
        const { status } = args as { status: string };
        await brokerFetch("/set-status", { id: myId, status });
        return textResult(`Status updated to: ${status}`);
      }

      case "share_file": {
        const { file_path } = args as { file_path: string };
        const result = await brokerFetch<{ ok: boolean; file_id?: number; error?: string }>("/share-file", {
          author_id: myId, file_path,
        });
        if (!result.ok) return textResult(`Failed to share file: ${result.error}`, true);
        return textResult(`File shared as #${result.file_id}: ${file_path}`);
      }

      case "list_shared_files": {
        const { limit } = args as { limit?: number };
        const files = await brokerFetch<Array<{ id: number; author_id: string; filename: string; size_bytes: number; mime_type: string; created_at: string }>>("/list-shared-files", { limit: limit ?? 20 });
        if (files.length === 0) return textResult("No shared files.");
        const lines = files.map((f) =>
          `#${f.id} "${f.filename}" (${f.mime_type}, ${f.size_bytes} bytes) by ${f.author_id} at ${f.created_at}`
        );
        return textResult(`Shared files (${files.length}):\n\n${lines.join("\n")}`);
      }

      case "get_shared_file": {
        const { id } = args as { id: number };
        const file = await brokerFetch<SharedFile | null>("/get-shared-file", { id });
        if (!file) return textResult(`File #${id} not found`, true);
        return textResult(
          `File #${file.id}: "${file.filename}"\nAuthor: ${file.author_id}\nSize: ${file.size_bytes} bytes\nType: ${file.mime_type}\nCreated: ${file.created_at}\n\nContent:\n${file.content}`
        );
      }

      case "alert_peer": {
        const { to_id, message, priority } = args as { to_id: string; message: string; priority: string };
        const result = await brokerFetch<{ ok: boolean; alert_id?: number; error?: string }>("/alert-peer", {
          from_id: myId, to_id, message, priority,
        });
        if (!result.ok) return textResult(`Failed: ${result.error}`, true);
        return textResult(`Alert #${result.alert_id} sent to ${to_id} [${priority.toUpperCase()}]`);
      }

      case "alert_all": {
        const { message, priority } = args as { message: string; priority: string };
        const result = await brokerFetch<{ ok: boolean; count: number }>("/alert-all", {
          from_id: myId, message, priority, scope: "machine", cwd: myCwd, git_root: myGitRoot,
        });
        return textResult(`Alert broadcast to ${result.count} peer(s) [${priority.toUpperCase()}]`);
      }

      case "pin_message": {
        const { content } = args as { content: string };
        const result = await brokerFetch<{ ok: boolean; pin_id: number }>("/pin-message", {
          author_id: myId, content,
        });
        return textResult(`Message pinned as #${result.pin_id}`);
      }

      case "list_pins": {
        const pins = await brokerFetch<Array<{ id: number; author_id: string; content: string; created_at: string }>>("/list-pins", {});
        if (pins.length === 0) return textResult("No pinned messages.");
        const lines = pins.map((p) =>
          `📌 #${p.id} by ${p.author_id} (${p.created_at}):\n  ${p.content}`
        );
        return textResult(`Pinned messages (${pins.length}):\n\n${lines.join("\n\n")}`);
      }

      case "unpin_message": {
        const { pin_id } = args as { pin_id: number };
        const result = await brokerFetch<{ ok: boolean; error?: string }>("/unpin-message", {
          pin_id, peer_id: myId,
        });
        if (!result.ok) return textResult(`Failed: ${result.error}`, true);
        return textResult(`Pin #${pin_id} removed`);
      }

      case "peer_stats": {
        const { target_id } = args as { target_id?: string };
        const stats = await brokerFetch<PeerAnalytics>("/peer-stats", {
          peer_id: myId, target_id,
        });
        const lines = [
          `Peer: ${stats.peer_id}`,
          `Messages sent: ${stats.messages_sent}`,
          `Messages received: ${stats.messages_received}`,
          `Tasks assigned: ${stats.tasks_assigned}`,
          `Tasks completed: ${stats.tasks_completed}`,
          `Snippets shared: ${stats.snippets_shared}`,
          `Alerts sent: ${stats.alerts_sent}`,
          `Files shared: ${stats.files_shared}`,
        ];
        return textResult(lines.join("\n"));
      }

      case "request_review": {
        const { to_id } = args as { to_id: string };
        const result = await brokerFetch<{ ok: boolean; error?: string }>("/request-review", {
          from_id: myId, to_id, cwd: myCwd,
        });
        if (!result.ok) return textResult(`Failed: ${result.error}`, true);
        return textResult(`Review request sent to ${to_id}`);
      }

      case "sync_status": {
        const { scope } = args as { scope?: string };
        const result = await brokerFetch<{ ok: boolean; count: number }>("/sync-status", {
          from_id: myId, cwd: myCwd, scope: scope ?? "machine", git_root: myGitRoot,
        });
        return textResult(`Git status broadcast to ${result.count} peer(s)`);
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (e) {
    return textResult(`Error: ${e instanceof Error ? e.message : String(e)}`, true);
  }
});

// --- WebSocket connection with auto-reconnect ---

function connectWebSocket(): void {
  if (!myId) return;

  try {
    const ws = new WebSocket(`${WS_URL}?peer_id=${myId}`);

    ws.onopen = () => {
      log("WebSocket connected");
      usePolling = false;
      wsSocket = ws;
    };

    ws.onmessage = async (event) => {
      try {
        const wsEvent = JSON.parse(String(event.data)) as WsEvent;
        await handleWsEvent(wsEvent);
      } catch (e) {
        log(`WebSocket message parse error: ${e instanceof Error ? e.message : String(e)}`);
      }
    };

    ws.onclose = () => {
      log("WebSocket disconnected, will reconnect...");
      wsSocket = null;
      usePolling = true;
      scheduleReconnect();
    };

    ws.onerror = (err) => {
      log(`WebSocket error: ${err}`);
      ws.close();
    };
  } catch (e) {
    log(`WebSocket connection failed: ${e instanceof Error ? e.message : String(e)}`);
    usePolling = true;
    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (wsReconnectTimer) return;
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    connectWebSocket();
  }, WS_RECONNECT_DELAY_MS);
}

async function handleWsEvent(event: WsEvent): Promise<void> {
  switch (event.type) {
    case "message":
    case "broadcast": {
      const data = event.data as { from_id: string; text: string; sent_at: string };
      // Look up sender info for context
      let fromSummary = "";
      let fromCwd = "";
      try {
        const peers = await brokerFetch<Peer[]>("/list-peers", {
          scope: "machine", cwd: myCwd, git_root: myGitRoot,
        });
        const sender = peers.find((p) => p.id === data.from_id);
        if (sender) {
          fromSummary = sender.summary;
          fromCwd = sender.cwd;
        }
      } catch { /* Non-critical */ }

      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: data.text,
          meta: {
            type: event.type,
            from_id: data.from_id,
            from_summary: fromSummary,
            from_cwd: fromCwd,
            sent_at: data.sent_at,
          },
        },
      });
      log(`Pushed ${event.type} from ${data.from_id}: ${data.text.slice(0, 80)}`);
      break;
    }

    case "task": {
      const data = event.data as { action: string; task_id: number; from_id?: string; description?: string; state?: string; result?: string };
      const content = data.action === "assigned"
        ? `New task assigned by ${data.from_id}: ${data.description} (Task #${data.task_id})`
        : `Task #${data.task_id} updated: ${data.state}${data.result ? ` - ${data.result}` : ""}`;

      await mcp.notification({
        method: "notifications/claude/channel",
        params: { content, meta: { type: "task", ...data } },
      });
      log(`Pushed task notification: ${content.slice(0, 80)}`);
      break;
    }

    case "snippet": {
      const data = event.data as { id: number; author_id: string; title: string };
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: `New snippet shared by ${data.author_id}: "${data.title}" (Snippet #${data.id})`,
          meta: { type: "snippet", ...data },
        },
      });
      break;
    }

    case "alert": {
      const data = event.data as { id?: number; from_id: string; message: string; priority: string };
      const priorityIcon = { info: "ℹ️", warning: "⚠️", critical: "🚨" }[data.priority] ?? "ℹ️";
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: `${priorityIcon} ALERT [${data.priority.toUpperCase()}] from ${data.from_id}: ${data.message}`,
          meta: { type: "alert", ...data },
        },
      });
      log(`Pushed alert from ${data.from_id}: ${data.message.slice(0, 80)}`);
      break;
    }

    case "pin": {
      const data = event.data as { id: number; author_id: string; content: string };
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: `📌 New pin by ${data.author_id}: ${data.content}`,
          meta: { type: "pin", ...data },
        },
      });
      break;
    }

    case "file_shared": {
      const data = event.data as { id: number; author_id: string; filename: string; size_bytes: number };
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: `📎 File shared by ${data.author_id}: "${data.filename}" (${data.size_bytes} bytes) - File #${data.id}`,
          meta: { type: "file_shared", ...data },
        },
      });
      break;
    }

    case "review_request": {
      const data = event.data as { from_id: string; branch: string; diff_stat: string };
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: `🔍 Review requested by ${data.from_id} on branch "${data.branch}":\n${data.diff_stat}`,
          meta: { type: "review_request", ...data },
        },
      });
      break;
    }

    case "sync_status": {
      const data = event.data as { from_id: string; branch: string; last_commit: string; uncommitted_changes: number };
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: `📊 Git sync from ${data.from_id}: branch=${data.branch}, last commit="${data.last_commit}", ${data.uncommitted_changes} uncommitted change(s)`,
          meta: { type: "sync_status", ...data },
        },
      });
      break;
    }

    case "peer_joined":
    case "peer_left": {
      const data = event.data as { id: string; cwd?: string; summary?: string };
      const action = event.type === "peer_joined" ? "joined" : "left";
      log(`Peer ${data.id} ${action} the swarm`);
      break;
    }
  }
}

// --- Fallback polling loop (used when WebSocket is unavailable) ---

async function pollAndPushMessages(): Promise<void> {
  if (!myId || !usePolling) return;

  try {
    const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });

    for (const msg of result.messages) {
      let fromSummary = "";
      let fromCwd = "";
      try {
        const peers = await brokerFetch<Peer[]>("/list-peers", {
          scope: "machine", cwd: myCwd, git_root: myGitRoot,
        });
        const sender = peers.find((p) => p.id === msg.from_id);
        if (sender) {
          fromSummary = sender.summary;
          fromCwd = sender.cwd;
        }
      } catch { /* Non-critical */ }

      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: msg.text,
          meta: {
            from_id: msg.from_id,
            from_summary: fromSummary,
            from_cwd: fromCwd,
            sent_at: msg.sent_at,
          },
        },
      });
      log(`Pushed message (poll) from ${msg.from_id}: ${msg.text.slice(0, 80)}`);
    }
  } catch (e) {
    log(`Poll error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// --- Startup ---

async function main(): Promise<void> {
  // 1. Ensure broker is running
  await ensureBroker();

  // 2. Gather context
  myCwd = process.cwd();
  myGitRoot = await getGitRoot(myCwd);
  const tty = getTty();

  log(`CWD: ${myCwd}`);
  log(`Git root: ${myGitRoot ?? "(none)"}`);
  log(`TTY: ${tty ?? "(unknown)"}`);

  // 3. Generate initial summary via Gemini (non-blocking, best-effort)
  let initialSummary = "";
  const summaryPromise = (async () => {
    try {
      const branch = await getGitBranch(myCwd);
      const recentFiles = await getRecentFiles(myCwd);
      const summary = await generateSummary({
        cwd: myCwd, git_root: myGitRoot, git_branch: branch, recent_files: recentFiles,
      });
      if (summary) {
        initialSummary = summary;
        log(`Auto-summary: ${summary}`);
      }
    } catch (e) {
      log(`Auto-summary failed (non-critical): ${e instanceof Error ? e.message : String(e)}`);
    }
  })();

  // Wait briefly for summary
  await Promise.race([summaryPromise, new Promise((r) => setTimeout(r, 3000))]);

  // 4. Register with broker
  const reg = await brokerFetch<RegisterResponse>("/register", {
    pid: process.pid, cwd: myCwd, git_root: myGitRoot, tty, summary: initialSummary,
  });
  myId = reg.id;
  log(`Registered as peer ${myId}`);

  // Late summary update
  if (!initialSummary) {
    summaryPromise.then(async () => {
      if (initialSummary && myId) {
        try {
          await brokerFetch("/set-summary", { id: myId, summary: initialSummary });
          log(`Late auto-summary applied: ${initialSummary}`);
        } catch { /* Non-critical */ }
      }
    });
  }

  // 5. Connect MCP over stdio
  await mcp.connect(new StdioServerTransport());
  log("MCP connected");

  // 6. Connect WebSocket for real-time push
  connectWebSocket();

  // 7. Start fallback polling
  const pollTimer = setInterval(pollAndPushMessages, POLL_INTERVAL_MS);

  // 8. Start heartbeat
  const heartbeatTimer = setInterval(async () => {
    if (myId) {
      try { await brokerFetch("/heartbeat", { id: myId }); } catch { /* Non-critical */ }
    }
  }, HEARTBEAT_INTERVAL_MS);

  // 9. Clean up on exit
  const cleanup = async () => {
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
    if (wsSocket) wsSocket.close();
    if (myId) {
      try {
        await brokerFetch("/unregister", { id: myId });
        log("Unregistered from broker");
      } catch { /* Best effort */ }
    }
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((e) => {
  log(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
