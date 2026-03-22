#!/usr/bin/env bun
/**
 * claude-swarm-mcp broker daemon
 *
 * A singleton HTTP + WebSocket server on localhost:7899 backed by SQLite.
 * Tracks all registered Claude Code peers and routes messages, tasks,
 * and snippets between them.
 *
 * Features over claude-peers:
 *   - WebSocket support for real-time push
 *   - Broadcast messages
 *   - Task delegation and tracking
 *   - Shared code snippets
 *   - Peer tags/groups
 *   - Rate limiting
 *   - Message TTL (auto-cleanup after 24h)
 *   - Dashboard endpoint
 *
 * Auto-launched by the MCP server if not already running.
 * Run directly: bun broker.ts
 */

import { Database } from "bun:sqlite";
import type {
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
  SetSummaryRequest,
  SetTagsRequest,
  ListPeersRequest,
  SendMessageRequest,
  BroadcastMessageRequest,
  PollMessagesRequest,
  PollMessagesResponse,
  MessageHistoryRequest,
  DelegateTaskRequest,
  ListTasksRequest,
  CompleteTaskRequest,
  UpdateTaskStateRequest,
  ShareSnippetRequest,
  ListSnippetsRequest,
  GetSnippetRequest,
  Peer,
  Message,
  Task,
  Snippet,
  WsEvent,
  RateLimitEntry,
} from "./shared/types.ts";

const PORT = parseInt(process.env.CLAUDE_SWARM_PORT ?? process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const DB_PATH = process.env.CLAUDE_SWARM_DB ?? `${process.env.HOME}/.claude-swarm.db`;
const MESSAGE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = 60; // max messages per minute per peer

// --- Database setup ---

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 3000");

db.run(`
  CREATE TABLE IF NOT EXISTS peers (
    id TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    cwd TEXT NOT NULL,
    git_root TEXT,
    tty TEXT,
    summary TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    text TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    description TEXT NOT NULL,
    deadline TEXT,
    state TEXT NOT NULL DEFAULT 'pending',
    result TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS snippets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    author_id TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    language TEXT NOT NULL DEFAULT 'text',
    created_at TEXT NOT NULL
  )
`);

// Create indexes for performance
db.run("CREATE INDEX IF NOT EXISTS idx_messages_to_delivered ON messages(to_id, delivered)");
db.run("CREATE INDEX IF NOT EXISTS idx_messages_sent_at ON messages(sent_at)");
db.run("CREATE INDEX IF NOT EXISTS idx_tasks_to_id ON tasks(to_id)");
db.run("CREATE INDEX IF NOT EXISTS idx_tasks_from_id ON tasks(from_id)");

// --- Rate limiting (in-memory) ---

const rateLimits = new Map<string, RateLimitEntry>();

function checkRateLimit(peerId: string): boolean {
  const now = Date.now();
  const entry = rateLimits.get(peerId);

  if (!entry || now > entry.reset_at) {
    rateLimits.set(peerId, { count: 1, reset_at: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return false;
  }

  entry.count++;
  return true;
}

// --- WebSocket connections ---

const wsConnections = new Map<string, Set<WebSocket>>(); // peer_id -> sockets

function notifyPeer(peerId: string, event: WsEvent): void {
  const sockets = wsConnections.get(peerId);
  if (!sockets) return;

  const payload = JSON.stringify(event);
  for (const ws of sockets) {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    } catch {
      // Socket died, will be cleaned on close
    }
  }
}

function broadcastToAll(event: WsEvent, excludeId?: string): void {
  for (const [peerId, sockets] of wsConnections) {
    if (peerId === excludeId) continue;
    const payload = JSON.stringify(event);
    for (const ws of sockets) {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(payload);
        }
      } catch {
        // ignore
      }
    }
  }
}

// --- Clean up stale peers ---

function cleanStalePeers(): void {
  const peers = db.query("SELECT id, pid FROM peers").all() as { id: string; pid: number }[];
  for (const peer of peers) {
    try {
      process.kill(peer.pid, 0);
    } catch {
      db.run("DELETE FROM peers WHERE id = ?", [peer.id]);
      db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [peer.id]);
      wsConnections.delete(peer.id);
    }
  }
}

// --- Clean up expired messages (TTL) ---

function cleanExpiredMessages(): void {
  const cutoff = new Date(Date.now() - MESSAGE_TTL_MS).toISOString();
  db.run("DELETE FROM messages WHERE sent_at < ? AND delivered = 1", [cutoff]);
}

cleanStalePeers();
cleanExpiredMessages();

// Periodic cleanup
setInterval(cleanStalePeers, 30_000);
setInterval(cleanExpiredMessages, 60_000 * 15); // every 15 minutes

// --- Prepared statements ---

const insertPeer = db.prepare(`
  INSERT INTO peers (id, pid, cwd, git_root, tty, summary, tags, registered_at, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateLastSeen = db.prepare("UPDATE peers SET last_seen = ? WHERE id = ?");
const updateSummary = db.prepare("UPDATE peers SET summary = ? WHERE id = ?");
const updateTags = db.prepare("UPDATE peers SET tags = ? WHERE id = ?");
const deletePeer = db.prepare("DELETE FROM peers WHERE id = ?");
const selectAllPeers = db.prepare("SELECT * FROM peers");
const selectPeersByDirectory = db.prepare("SELECT * FROM peers WHERE cwd = ?");
const selectPeersByGitRoot = db.prepare("SELECT * FROM peers WHERE git_root = ?");

const insertMessage = db.prepare(`
  INSERT INTO messages (from_id, to_id, text, sent_at, delivered) VALUES (?, ?, ?, ?, 0)
`);
const selectUndelivered = db.prepare(
  "SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY sent_at ASC"
);
const markDelivered = db.prepare("UPDATE messages SET delivered = 1 WHERE id = ?");
const selectMessageHistory = db.prepare(
  "SELECT * FROM messages WHERE from_id = ? OR to_id = ? ORDER BY sent_at DESC LIMIT ?"
);
const selectMessageHistoryAll = db.prepare(
  "SELECT * FROM messages ORDER BY sent_at DESC LIMIT ?"
);

const insertTask = db.prepare(`
  INSERT INTO tasks (from_id, to_id, description, deadline, state, result, created_at, updated_at)
  VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?)
`);
const selectTasksForPeer = db.prepare(
  "SELECT * FROM tasks WHERE to_id = ? OR from_id = ? ORDER BY updated_at DESC"
);
const selectTasksAssignedTo = db.prepare(
  "SELECT * FROM tasks WHERE to_id = ? ORDER BY updated_at DESC"
);
const selectTasksAssignedBy = db.prepare(
  "SELECT * FROM tasks WHERE from_id = ? ORDER BY updated_at DESC"
);
const updateTaskState = db.prepare(
  "UPDATE tasks SET state = ?, result = ?, updated_at = ? WHERE id = ?"
);
const selectTaskById = db.prepare("SELECT * FROM tasks WHERE id = ?");

const insertSnippet = db.prepare(`
  INSERT INTO snippets (author_id, title, content, language, created_at) VALUES (?, ?, ?, ?, ?)
`);
const selectSnippets = db.prepare("SELECT * FROM snippets ORDER BY created_at DESC LIMIT ?");
const selectSnippetById = db.prepare("SELECT * FROM snippets WHERE id = ?");

// --- Generate peer ID ---

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// --- Request handlers ---

function handleRegister(body: RegisterRequest): RegisterResponse {
  const id = generateId();
  const now = new Date().toISOString();

  // Remove any existing registration for this PID
  const existing = db.query("SELECT id FROM peers WHERE pid = ?").get(body.pid) as { id: string } | null;
  if (existing) {
    deletePeer.run(existing.id);
    wsConnections.delete(existing.id);
  }

  const tags = JSON.stringify(body.tags ?? []);
  insertPeer.run(id, body.pid, body.cwd, body.git_root, body.tty, body.summary, tags, now, now);

  // Notify all peers about new peer
  broadcastToAll({
    type: "peer_joined",
    data: { id, cwd: body.cwd, summary: body.summary },
    timestamp: now,
  });

  return { id };
}

function handleHeartbeat(body: HeartbeatRequest): void {
  updateLastSeen.run(new Date().toISOString(), body.id);
}

function handleSetSummary(body: SetSummaryRequest): void {
  updateSummary.run(body.summary, body.id);
}

function handleSetTags(body: SetTagsRequest): void {
  updateTags.run(JSON.stringify(body.tags), body.id);
}

function handleListPeers(body: ListPeersRequest): Peer[] {
  let peers: Peer[];

  switch (body.scope) {
    case "machine":
      peers = selectAllPeers.all() as Peer[];
      break;
    case "directory":
      peers = selectPeersByDirectory.all(body.cwd) as Peer[];
      break;
    case "repo":
      if (body.git_root) {
        peers = selectPeersByGitRoot.all(body.git_root) as Peer[];
      } else {
        peers = selectPeersByDirectory.all(body.cwd) as Peer[];
      }
      break;
    default:
      peers = selectAllPeers.all() as Peer[];
  }

  // Exclude the requesting peer
  if (body.exclude_id) {
    peers = peers.filter((p) => p.id !== body.exclude_id);
  }

  // Filter by tag if specified
  if (body.tag) {
    peers = peers.filter((p) => {
      try {
        const tags = JSON.parse(p.tags) as string[];
        return tags.includes(body.tag!);
      } catch {
        return false;
      }
    });
  }

  // Verify each peer's process is still alive
  return peers.filter((p) => {
    try {
      process.kill(p.pid, 0);
      return true;
    } catch {
      deletePeer.run(p.id);
      wsConnections.delete(p.id);
      return false;
    }
  });
}

function handleSendMessage(body: SendMessageRequest): { ok: boolean; error?: string } {
  // Rate limit check
  if (!checkRateLimit(body.from_id)) {
    return { ok: false, error: "Rate limit exceeded (max 60 messages/minute)" };
  }

  // Verify target exists
  const target = db.query("SELECT id FROM peers WHERE id = ?").get(body.to_id) as { id: string } | null;
  if (!target) {
    return { ok: false, error: `Peer ${body.to_id} not found` };
  }

  const now = new Date().toISOString();
  insertMessage.run(body.from_id, body.to_id, body.text, now);

  // Push via WebSocket if connected
  notifyPeer(body.to_id, {
    type: "message",
    data: { from_id: body.from_id, text: body.text, sent_at: now },
    timestamp: now,
  });

  return { ok: true };
}

function handleBroadcastMessage(body: BroadcastMessageRequest): { ok: boolean; count: number } {
  if (!checkRateLimit(body.from_id)) {
    return { ok: false, count: 0 };
  }

  // Get target peers based on scope
  const listReq: ListPeersRequest = {
    scope: body.scope ?? "machine",
    cwd: body.cwd ?? "/",
    git_root: body.git_root ?? null,
    exclude_id: body.from_id,
  };
  const peers = handleListPeers(listReq);
  const now = new Date().toISOString();

  for (const peer of peers) {
    insertMessage.run(body.from_id, peer.id, body.text, now);
    notifyPeer(peer.id, {
      type: "broadcast",
      data: { from_id: body.from_id, text: body.text, sent_at: now },
      timestamp: now,
    });
  }

  return { ok: true, count: peers.length };
}

function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  const messages = selectUndelivered.all(body.id) as Message[];
  for (const msg of messages) {
    markDelivered.run(msg.id);
  }
  return { messages };
}

function handleMessageHistory(body: MessageHistoryRequest): Message[] {
  const limit = body.limit ?? 20;
  if (body.peer_id) {
    return selectMessageHistory.all(body.peer_id, body.peer_id, limit) as Message[];
  }
  return selectMessageHistoryAll.all(limit) as Message[];
}

function handleDelegateTask(body: DelegateTaskRequest): { ok: boolean; task_id: number } {
  const now = new Date().toISOString();
  const result = insertTask.run(
    body.from_id, body.to_id, body.description, body.deadline ?? null, now, now
  );

  const taskId = Number(result.lastInsertRowid);

  // Notify assignee via WebSocket
  notifyPeer(body.to_id, {
    type: "task",
    data: {
      action: "assigned",
      task_id: taskId,
      from_id: body.from_id,
      description: body.description,
      deadline: body.deadline,
    },
    timestamp: now,
  });

  return { ok: true, task_id: taskId };
}

function handleListTasks(body: ListTasksRequest): Task[] {
  switch (body.role) {
    case "assignee":
      return selectTasksAssignedTo.all(body.peer_id) as Task[];
    case "assigner":
      return selectTasksAssignedBy.all(body.peer_id) as Task[];
    default:
      return selectTasksForPeer.all(body.peer_id, body.peer_id) as Task[];
  }
}

function handleUpdateTaskState(body: UpdateTaskStateRequest): { ok: boolean; error?: string } {
  const task = selectTaskById.get(body.task_id) as Task | null;
  if (!task) {
    return { ok: false, error: `Task ${body.task_id} not found` };
  }

  // Only assignee can update task state
  if (task.to_id !== body.peer_id && task.from_id !== body.peer_id) {
    return { ok: false, error: "Not authorized to update this task" };
  }

  const now = new Date().toISOString();
  updateTaskState.run(body.state, body.result ?? null, now, body.task_id);

  // Notify the other party
  const notifyId = task.from_id === body.peer_id ? task.to_id : task.from_id;
  notifyPeer(notifyId, {
    type: "task",
    data: {
      action: "updated",
      task_id: body.task_id,
      state: body.state,
      result: body.result,
    },
    timestamp: now,
  });

  return { ok: true };
}

function handleShareSnippet(body: ShareSnippetRequest): { ok: boolean; snippet_id: number } {
  const now = new Date().toISOString();
  const result = insertSnippet.run(
    body.author_id, body.title, body.content, body.language ?? "text", now
  );

  const snippetId = Number(result.lastInsertRowid);

  // Notify all peers about new snippet
  broadcastToAll({
    type: "snippet",
    data: {
      id: snippetId,
      author_id: body.author_id,
      title: body.title,
      language: body.language ?? "text",
    },
    timestamp: now,
  });

  return { ok: true, snippet_id: snippetId };
}

function handleListSnippets(body: ListSnippetsRequest): Snippet[] {
  return selectSnippets.all(body.limit ?? 20) as Snippet[];
}

function handleGetSnippet(body: GetSnippetRequest): Snippet | null {
  return (selectSnippetById.get(body.id) as Snippet) ?? null;
}

function handleUnregister(body: { id: string }): void {
  const now = new Date().toISOString();
  deletePeer.run(body.id);
  wsConnections.delete(body.id);

  broadcastToAll({
    type: "peer_left",
    data: { id: body.id },
    timestamp: now,
  });
}

// --- Dashboard HTML ---

function generateDashboard(): string {
  const peers = selectAllPeers.all() as Peer[];
  const alivePeers = peers.filter((p) => {
    try {
      process.kill(p.pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  const totalMessages = (db.query("SELECT COUNT(*) as c FROM messages").get() as { c: number }).c;
  const pendingTasks = (db.query("SELECT COUNT(*) as c FROM tasks WHERE state = 'pending'").get() as { c: number }).c;
  const totalSnippets = (db.query("SELECT COUNT(*) as c FROM snippets").get() as { c: number }).c;

  const peerRows = alivePeers.map((p) => {
    const tags = (() => { try { return JSON.parse(p.tags) as string[]; } catch { return []; } })();
    const tagBadges = tags.map((t: string) => `<span class="tag">${escapeHtml(t)}</span>`).join(" ");
    return `
      <tr>
        <td><code>${escapeHtml(p.id)}</code></td>
        <td>${p.pid}</td>
        <td title="${escapeHtml(p.cwd)}">${escapeHtml(truncatePath(p.cwd))}</td>
        <td>${escapeHtml(p.summary || "(none)")}</td>
        <td>${tagBadges || "(none)"}</td>
        <td>${timeAgo(p.last_seen)}</td>
      </tr>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Claude Swarm Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d1117; color: #c9d1d9; padding: 2rem; }
    h1 { color: #58a6ff; margin-bottom: 0.5rem; font-size: 1.8rem; }
    .subtitle { color: #8b949e; margin-bottom: 2rem; }
    .stats { display: flex; gap: 1.5rem; margin-bottom: 2rem; flex-wrap: wrap; }
    .stat { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 1rem 1.5rem; min-width: 140px; }
    .stat-value { font-size: 2rem; font-weight: 700; color: #58a6ff; }
    .stat-label { color: #8b949e; font-size: 0.85rem; }
    table { width: 100%; border-collapse: collapse; background: #161b22; border-radius: 8px; overflow: hidden; border: 1px solid #30363d; }
    th { background: #21262d; color: #8b949e; text-align: left; padding: 0.75rem 1rem; font-weight: 600; font-size: 0.85rem; text-transform: uppercase; }
    td { padding: 0.75rem 1rem; border-top: 1px solid #21262d; }
    tr:hover td { background: #1c2128; }
    code { background: #21262d; padding: 0.15rem 0.4rem; border-radius: 4px; font-size: 0.9rem; color: #f0883e; }
    .tag { display: inline-block; background: #1f6feb33; color: #58a6ff; padding: 0.1rem 0.5rem; border-radius: 10px; font-size: 0.8rem; margin: 0.1rem; }
    .empty { text-align: center; padding: 2rem; color: #8b949e; }
    .refresh { margin-top: 1rem; color: #8b949e; font-size: 0.85rem; }
  </style>
</head>
<body>
  <h1>🐝 Claude Swarm Dashboard</h1>
  <p class="subtitle">Your Claude Code instances, working as a swarm</p>
  <div class="stats">
    <div class="stat"><div class="stat-value">${alivePeers.length}</div><div class="stat-label">Active Peers</div></div>
    <div class="stat"><div class="stat-value">${totalMessages}</div><div class="stat-label">Total Messages</div></div>
    <div class="stat"><div class="stat-value">${pendingTasks}</div><div class="stat-label">Pending Tasks</div></div>
    <div class="stat"><div class="stat-value">${totalSnippets}</div><div class="stat-label">Shared Snippets</div></div>
  </div>
  <h2 style="color: #c9d1d9; margin-bottom: 1rem;">Active Peers</h2>
  ${alivePeers.length > 0 ? `
  <table>
    <thead><tr><th>ID</th><th>PID</th><th>Directory</th><th>Summary</th><th>Tags</th><th>Last Seen</th></tr></thead>
    <tbody>${peerRows}</tbody>
  </table>` : '<div class="empty">No active peers. Start a Claude Code instance with claude-swarm-mcp configured.</div>'}
  <p class="refresh">Auto-refreshes every 10s</p>
  <script>setTimeout(() => location.reload(), 10000);</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function truncatePath(p: string, maxLen = 40): string {
  if (p.length <= maxLen) return p;
  return "..." + p.slice(-(maxLen - 3));
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

// --- HTTP + WebSocket Server ---

Bun.serve<{ peerId: string }>({
  port: PORT,
  hostname: "127.0.0.1",

  fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname;

    // WebSocket upgrade
    if (path === "/ws") {
      const peerId = url.searchParams.get("peer_id");
      if (!peerId) {
        return new Response("Missing peer_id parameter", { status: 400 });
      }
      const upgraded = server.upgrade(req, { data: { peerId } });
      if (!upgraded) {
        return new Response("WebSocket upgrade failed", { status: 500 });
      }
      return undefined;
    }

    // Dashboard
    if (path === "/dashboard") {
      return new Response(generateDashboard(), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // Health check (GET)
    if (req.method !== "POST") {
      if (path === "/health") {
        return Response.json({
          status: "ok",
          name: "claude-swarm",
          peers: (selectAllPeers.all() as Peer[]).length,
          ws_connections: wsConnections.size,
        });
      }
      return new Response("claude-swarm-mcp broker", { status: 200 });
    }

    // POST endpoints
    return (async () => {
      try {
        const body = await req.json();

        switch (path) {
          case "/register":
            return Response.json(handleRegister(body as RegisterRequest));
          case "/heartbeat":
            handleHeartbeat(body as HeartbeatRequest);
            return Response.json({ ok: true });
          case "/set-summary":
            handleSetSummary(body as SetSummaryRequest);
            return Response.json({ ok: true });
          case "/set-tags":
            handleSetTags(body as SetTagsRequest);
            return Response.json({ ok: true });
          case "/list-peers":
            return Response.json(handleListPeers(body as ListPeersRequest));
          case "/send-message":
            return Response.json(handleSendMessage(body as SendMessageRequest));
          case "/broadcast-message":
            return Response.json(handleBroadcastMessage(body as BroadcastMessageRequest));
          case "/poll-messages":
            return Response.json(handlePollMessages(body as PollMessagesRequest));
          case "/message-history":
            return Response.json(handleMessageHistory(body as MessageHistoryRequest));
          case "/delegate-task":
            return Response.json(handleDelegateTask(body as DelegateTaskRequest));
          case "/list-tasks":
            return Response.json(handleListTasks(body as ListTasksRequest));
          case "/update-task":
            return Response.json(handleUpdateTaskState(body as UpdateTaskStateRequest));
          case "/share-snippet":
            return Response.json(handleShareSnippet(body as ShareSnippetRequest));
          case "/list-snippets":
            return Response.json(handleListSnippets(body as ListSnippetsRequest));
          case "/get-snippet":
            return Response.json(handleGetSnippet(body as GetSnippetRequest));
          case "/unregister":
            handleUnregister(body as { id: string });
            return Response.json({ ok: true });
          default:
            return Response.json({ error: "not found" }, { status: 404 });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return Response.json({ error: msg }, { status: 500 });
      }
    })();
  },

  websocket: {
    open(ws) {
      const peerId = ws.data.peerId;
      if (!wsConnections.has(peerId)) {
        wsConnections.set(peerId, new Set());
      }
      wsConnections.get(peerId)!.add(ws as unknown as WebSocket);
      console.error(`[claude-swarm] WebSocket connected: ${peerId}`);
    },
    message(_ws, _message) {
      // Client-to-server WS messages not used currently; reserved for future use
    },
    close(ws) {
      const peerId = ws.data.peerId;
      const sockets = wsConnections.get(peerId);
      if (sockets) {
        sockets.delete(ws as unknown as WebSocket);
        if (sockets.size === 0) {
          wsConnections.delete(peerId);
        }
      }
      console.error(`[claude-swarm] WebSocket disconnected: ${peerId}`);
    },
  },
});

console.error(`[claude-swarm broker] listening on 127.0.0.1:${PORT} (db: ${DB_PATH})`);
console.error(`[claude-swarm broker] dashboard: http://127.0.0.1:${PORT}/dashboard`);
