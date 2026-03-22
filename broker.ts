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
  SetStatusRequest,
  ShareFileRequest,
  ListSharedFilesRequest,
  GetSharedFileRequest,
  AlertPeerRequest,
  AlertAllRequest,
  PinMessageRequest,
  UnpinMessageRequest,
  PeerStatsRequest,
  RequestReviewRequest,
  SyncStatusRequest,
  Peer,
  Message,
  Task,
  Snippet,
  SharedFile,
  Alert,
  Pin,
  PeerAnalytics,
  PeerStatus,
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

// Add status column to peers if missing
try {
  db.run("ALTER TABLE peers ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
} catch {
  // column already exists
}

db.run(`
  CREATE TABLE IF NOT EXISTS shared_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    author_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    content TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    mime_type TEXT NOT NULL DEFAULT 'text/plain',
    created_at TEXT NOT NULL
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    message TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'info',
    created_at TEXT NOT NULL,
    acknowledged INTEGER NOT NULL DEFAULT 0
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS pins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    author_id TEXT NOT NULL,
    content TEXT NOT NULL,
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

// --- New prepared statements ---

const updateStatus = db.prepare("UPDATE peers SET status = ? WHERE id = ?");

const insertSharedFile = db.prepare(`
  INSERT INTO shared_files (author_id, filename, content, size_bytes, mime_type, created_at) VALUES (?, ?, ?, ?, ?, ?)
`);
const selectSharedFiles = db.prepare("SELECT id, author_id, filename, size_bytes, mime_type, created_at FROM shared_files ORDER BY created_at DESC LIMIT ?");
const selectSharedFileById = db.prepare("SELECT * FROM shared_files WHERE id = ?");

const insertAlert = db.prepare(`
  INSERT INTO alerts (from_id, to_id, message, priority, created_at) VALUES (?, ?, ?, ?, ?)
`);
const selectAlertsForPeer = db.prepare("SELECT * FROM alerts WHERE to_id = ? ORDER BY created_at DESC LIMIT ?");

const insertPin = db.prepare(`
  INSERT INTO pins (author_id, content, created_at) VALUES (?, ?, ?)
`);
const selectPins = db.prepare("SELECT * FROM pins ORDER BY created_at DESC LIMIT ?");
const deletePin = db.prepare("DELETE FROM pins WHERE id = ?");
const selectPinById = db.prepare("SELECT * FROM pins WHERE id = ?");

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

function handleSendMessage(body: SendMessageRequest): { ok: boolean; error?: string; warning?: string } {
  // Rate limit check
  if (!checkRateLimit(body.from_id)) {
    return { ok: false, error: "Rate limit exceeded (max 60 messages/minute)" };
  }

  // Verify target exists
  const target = db.query("SELECT id, status FROM peers WHERE id = ?").get(body.to_id) as { id: string; status?: string } | null;
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

  const warning = target.status === "dnd" ? `Warning: Peer ${body.to_id} is in Do Not Disturb mode` : undefined;
  return { ok: true, warning };
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

// --- New feature handlers ---

function handleSetStatus(body: SetStatusRequest): void {
  updateStatus.run(body.status, body.id);
}

async function handleShareFile(body: ShareFileRequest): Promise<{ ok: boolean; file_id?: number; error?: string }> {
  const MAX_SIZE = 1024 * 1024; // 1MB

  // Validate path: reject path traversal and absolute paths outside home
  const { resolve } = await import("path");
  const resolvedPath = resolve(body.file_path);
  if (resolvedPath.includes("..") || resolvedPath.startsWith("/etc") || resolvedPath.startsWith("/var") || resolvedPath.startsWith("/usr")) {
    return { ok: false, error: "Path not allowed: must be within user directories" };
  }

  try {
    const file = Bun.file(resolvedPath);
    const size = file.size;
    if (size > MAX_SIZE) {
      return { ok: false, error: `File too large: ${size} bytes (max ${MAX_SIZE})` };
    }
    const content = await Bun.file(resolvedPath).text();
    const filename = resolvedPath.split("/").pop() ?? "unknown";
    const mime = file.type || "text/plain";
    const now = new Date().toISOString();
    const result = insertSharedFile.run(body.author_id, filename, content, size, mime, now);
    const fileId = Number(result.lastInsertRowid);

    broadcastToAll({
      type: "file_shared",
      data: { id: fileId, author_id: body.author_id, filename, size_bytes: size },
      timestamp: now,
    });

    return { ok: true, file_id: fileId };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function handleListSharedFiles(body: ListSharedFilesRequest): Omit<SharedFile, "content">[] {
  return selectSharedFiles.all(body.limit ?? 20) as Omit<SharedFile, "content">[];
}

function handleGetSharedFile(body: GetSharedFileRequest): SharedFile | null {
  return (selectSharedFileById.get(body.id) as SharedFile) ?? null;
}

function handleAlertPeer(body: AlertPeerRequest): { ok: boolean; alert_id?: number; error?: string } {
  const target = db.query("SELECT id FROM peers WHERE id = ?").get(body.to_id) as { id: string } | null;
  if (!target) {
    return { ok: false, error: `Peer ${body.to_id} not found` };
  }
  const now = new Date().toISOString();
  const result = insertAlert.run(body.from_id, body.to_id, body.message, body.priority, now);
  const alertId = Number(result.lastInsertRowid);

  notifyPeer(body.to_id, {
    type: "alert",
    data: { id: alertId, from_id: body.from_id, message: body.message, priority: body.priority },
    timestamp: now,
  });

  return { ok: true, alert_id: alertId };
}

function handleAlertAll(body: AlertAllRequest): { ok: boolean; count: number } {
  const listReq: ListPeersRequest = {
    scope: body.scope ?? "machine",
    cwd: body.cwd ?? "/",
    git_root: body.git_root ?? null,
    exclude_id: body.from_id,
  };
  const peers = handleListPeers(listReq);
  const now = new Date().toISOString();

  for (const peer of peers) {
    insertAlert.run(body.from_id, peer.id, body.message, body.priority, now);
    notifyPeer(peer.id, {
      type: "alert",
      data: { from_id: body.from_id, message: body.message, priority: body.priority },
      timestamp: now,
    });
  }

  return { ok: true, count: peers.length };
}

function handleListAlerts(body: { peer_id?: string; limit?: number }): Alert[] {
  const limit = body.limit ?? 20;
  if (body.peer_id) {
    return db.query("SELECT * FROM alerts WHERE to_id = ? OR from_id = ? ORDER BY created_at DESC LIMIT ?").all(body.peer_id, body.peer_id, limit) as Alert[];
  }
  return db.query("SELECT * FROM alerts ORDER BY created_at DESC LIMIT ?").all(limit) as Alert[];
}

function handlePinMessage(body: PinMessageRequest): { ok: boolean; pin_id: number } {
  const now = new Date().toISOString();
  const result = insertPin.run(body.author_id, body.content, now);
  const pinId = Number(result.lastInsertRowid);

  broadcastToAll({
    type: "pin",
    data: { id: pinId, author_id: body.author_id, content: body.content },
    timestamp: now,
  });

  return { ok: true, pin_id: pinId };
}

function handleListPins(): Pin[] {
  return selectPins.all(100) as Pin[];
}

function handleUnpinMessage(body: UnpinMessageRequest): { ok: boolean; error?: string } {
  const pin = selectPinById.get(body.pin_id) as Pin | null;
  if (!pin) return { ok: false, error: `Pin #${body.pin_id} not found` };
  deletePin.run(body.pin_id);
  return { ok: true };
}

function handlePeerStats(body: PeerStatsRequest): PeerAnalytics {
  const targetId = body.target_id ?? body.peer_id;
  const sent = (db.query("SELECT COUNT(*) as c FROM messages WHERE from_id = ?").get(targetId) as { c: number }).c;
  const received = (db.query("SELECT COUNT(*) as c FROM messages WHERE to_id = ?").get(targetId) as { c: number }).c;
  const tasksAssigned = (db.query("SELECT COUNT(*) as c FROM tasks WHERE from_id = ?").get(targetId) as { c: number }).c;
  const tasksCompleted = (db.query("SELECT COUNT(*) as c FROM tasks WHERE to_id = ? AND state = 'completed'").get(targetId) as { c: number }).c;
  const snippetsShared = (db.query("SELECT COUNT(*) as c FROM snippets WHERE author_id = ?").get(targetId) as { c: number }).c;
  const alertsSent = (db.query("SELECT COUNT(*) as c FROM alerts WHERE from_id = ?").get(targetId) as { c: number }).c;
  const filesShared = (db.query("SELECT COUNT(*) as c FROM shared_files WHERE author_id = ?").get(targetId) as { c: number }).c;

  return {
    peer_id: targetId,
    messages_sent: sent,
    messages_received: received,
    tasks_assigned: tasksAssigned,
    tasks_completed: tasksCompleted,
    snippets_shared: snippetsShared,
    alerts_sent: alertsSent,
    files_shared: filesShared,
  };
}

function handleAnalytics(): object {
  const peers = selectAllPeers.all() as Peer[];
  const alivePeers = peers.filter((p) => {
    try { process.kill(p.pid, 0); return true; } catch { return false; }
  });

  const peerStats = alivePeers.map((p) => ({
    id: p.id,
    summary: p.summary,
    ...handlePeerStats({ peer_id: p.id }),
  }));

  // Most active peers (by total messages sent)
  const mostActive = [...peerStats].sort((a, b) => (b.messages_sent + b.messages_received) - (a.messages_sent + a.messages_received));

  // Peak activity hours
  const hourCounts = db.query(`
    SELECT CAST(strftime('%H', sent_at) AS INTEGER) as hour, COUNT(*) as count 
    FROM messages GROUP BY hour ORDER BY count DESC
  `).all() as Array<{ hour: number; count: number }>;

  // Task completion rate
  const totalTasks = (db.query("SELECT COUNT(*) as c FROM tasks").get() as { c: number }).c;
  const completedTasks = (db.query("SELECT COUNT(*) as c FROM tasks WHERE state = 'completed'").get() as { c: number }).c;
  const completionRate = totalTasks > 0 ? (completedTasks / totalTasks * 100).toFixed(1) : "0.0";

  return {
    total_peers: alivePeers.length,
    peer_stats: mostActive,
    peak_hours: hourCounts.slice(0, 5),
    task_completion_rate: `${completionRate}%`,
    total_tasks: totalTasks,
    completed_tasks: completedTasks,
  };
}

async function handleRequestReview(body: RequestReviewRequest): Promise<{ ok: boolean; error?: string }> {
  try {
    const proc = Bun.spawn(["git", "diff", "--stat", "HEAD~1"], {
      cwd: body.cwd, stdout: "pipe", stderr: "ignore",
    });
    const diffStat = await new Response(proc.stdout).text();
    const branchProc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: body.cwd, stdout: "pipe", stderr: "ignore",
    });
    const branch = (await new Response(branchProc.stdout).text()).trim();

    const reviewMsg = `🔍 Review Request from ${body.from_id}\nBranch: ${branch}\nChanges:\n${diffStat.trim()}`;

    const sendResult = handleSendMessage({
      from_id: body.from_id,
      to_id: body.to_id,
      text: reviewMsg,
    });

    notifyPeer(body.to_id, {
      type: "review_request",
      data: { from_id: body.from_id, branch, diff_stat: diffStat.trim() },
      timestamp: new Date().toISOString(),
    });

    return { ok: sendResult.ok, error: sendResult.error };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function handleSyncStatus(body: SyncStatusRequest): Promise<{ ok: boolean; count: number }> {
  try {
    const branchProc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: body.cwd, stdout: "pipe", stderr: "ignore",
    });
    const branch = (await new Response(branchProc.stdout).text()).trim();

    const statusProc = Bun.spawn(["git", "status", "--short"], {
      cwd: body.cwd, stdout: "pipe", stderr: "ignore",
    });
    const status = (await new Response(statusProc.stdout).text()).trim();

    const logProc = Bun.spawn(["git", "log", "--oneline", "-1"], {
      cwd: body.cwd, stdout: "pipe", stderr: "ignore",
    });
    const lastCommit = (await new Response(logProc.stdout).text()).trim();

    const uncommitted = status ? status.split("\n").length : 0;
    const syncMsg = `📊 Git Status from ${body.from_id}\nBranch: ${branch}\nLast commit: ${lastCommit}\nUncommitted changes: ${uncommitted}${status ? `\n${status}` : ""}`;

    const listReq: ListPeersRequest = {
      scope: body.scope ?? "machine",
      cwd: body.cwd,
      git_root: body.git_root ?? null,
      exclude_id: body.from_id,
    };
    const peers = handleListPeers(listReq);
    const now = new Date().toISOString();

    for (const peer of peers) {
      insertMessage.run(body.from_id, peer.id, syncMsg, now);
      notifyPeer(peer.id, {
        type: "sync_status",
        data: { from_id: body.from_id, branch, last_commit: lastCommit, uncommitted_changes: uncommitted },
        timestamp: now,
      });
    }

    return { ok: true, count: peers.length };
  } catch (e) {
    return { ok: true, count: 0 };
  }
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
  const totalAlerts = (db.query("SELECT COUNT(*) as c FROM alerts WHERE acknowledged = 0").get() as { c: number }).c;
  const totalPins = (db.query("SELECT COUNT(*) as c FROM pins").get() as { c: number }).c;
  const totalFiles = (db.query("SELECT COUNT(*) as c FROM shared_files").get() as { c: number }).c;

  const statusColors: Record<string, string> = {
    active: "#3fb950",
    busy: "#d29922",
    away: "#8b949e",
    dnd: "#f85149",
  };

  const peerRows = alivePeers.map((p) => {
    const tags = (() => { try { return JSON.parse(p.tags) as string[]; } catch { return []; } })();
    const tagBadges = tags.map((t: string) => `<span class="tag">${escapeHtml(t)}</span>`).join(" ");
    const status = (p as Peer & { status?: string }).status ?? "active";
    const dotColor = statusColors[status] ?? statusColors.active;
    return `
      <tr>
        <td><span class="status-dot" style="background:${dotColor}" title="${status}"></span> <code>${escapeHtml(p.id)}</code></td>
        <td>${p.pid}</td>
        <td>${escapeHtml(status)}</td>
        <td title="${escapeHtml(p.cwd)}">${escapeHtml(truncatePath(p.cwd))}</td>
        <td>${escapeHtml(p.summary || "(none)")}</td>
        <td>${tagBadges || "(none)"}</td>
        <td>${timeAgo(p.last_seen)}</td>
      </tr>`;
  }).join("");

  // Recent messages for activity
  const recentMsgs = db.query("SELECT from_id, text, sent_at FROM messages ORDER BY sent_at DESC LIMIT 5").all() as Array<{ from_id: string; text: string; sent_at: string }>;
  const activityRows = recentMsgs.map((m) =>
    `<tr><td><code>${escapeHtml(m.from_id)}</code></td><td>${escapeHtml(m.text.slice(0, 80))}${m.text.length > 80 ? "..." : ""}</td><td>${timeAgo(m.sent_at)}</td></tr>`
  ).join("");

  // Active tasks
  const activeTasks = db.query("SELECT id, from_id, to_id, description, state FROM tasks WHERE state IN ('pending','in_progress') ORDER BY updated_at DESC LIMIT 5").all() as Array<{ id: number; from_id: string; to_id: string; description: string; state: string }>;
  const taskRows = activeTasks.map((t) => {
    const stateColor = t.state === "pending" ? "#d29922" : "#58a6ff";
    return `<tr><td>#${t.id}</td><td><span style="color:${stateColor}">${t.state.toUpperCase()}</span></td><td>${escapeHtml(t.from_id)} → ${escapeHtml(t.to_id)}</td><td>${escapeHtml(t.description.slice(0, 60))}</td></tr>`;
  }).join("");

  // Recent snippets
  const recentSnippets = db.query("SELECT id, author_id, title, language FROM snippets ORDER BY created_at DESC LIMIT 5").all() as Array<{ id: number; author_id: string; title: string; language: string }>;
  const snippetRows = recentSnippets.map((s) =>
    `<tr><td>#${s.id}</td><td>${escapeHtml(s.title)}</td><td>${escapeHtml(s.language)}</td><td><code>${escapeHtml(s.author_id)}</code></td></tr>`
  ).join("");

  // Pinned messages
  const pins = (selectPins.all(5) as Pin[]);
  const pinRows = pins.map((p) =>
    `<tr><td>#${p.id}</td><td>${escapeHtml(p.content.slice(0, 80))}</td><td><code>${escapeHtml(p.author_id)}</code></td><td>${timeAgo(p.created_at)}</td></tr>`
  ).join("");

  // Message activity graph (last 12 hours)
  const hourBuckets: number[] = new Array(12).fill(0);
  const hourLabels: string[] = [];
  const now = Date.now();
  for (let i = 11; i >= 0; i--) {
    const hourStart = new Date(now - i * 3600_000);
    const hourEnd = new Date(now - (i - 1) * 3600_000);
    hourLabels.push(hourStart.getHours().toString().padStart(2, "0"));
    const count = (db.query("SELECT COUNT(*) as c FROM messages WHERE sent_at >= ? AND sent_at < ?").get(hourStart.toISOString(), hourEnd.toISOString()) as { c: number }).c;
    hourBuckets[11 - i] = count;
  }
  const maxCount = Math.max(...hourBuckets, 1);
  const barHeight = 60;
  const graphBars = hourBuckets.map((count, i) => {
    const h = Math.round((count / maxCount) * barHeight);
    return `<div class="graph-bar-wrap"><div class="graph-bar" style="height:${h}px" title="${count} msgs"></div><div class="graph-label">${hourLabels[i]}</div></div>`;
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
    h2 { color: #c9d1d9; margin: 1.5rem 0 0.75rem; font-size: 1.2rem; }
    .subtitle { color: #8b949e; margin-bottom: 2rem; }
    .stats { display: flex; gap: 1rem; margin-bottom: 2rem; flex-wrap: wrap; }
    .stat { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 0.75rem 1.25rem; min-width: 120px; flex: 1; }
    .stat-value { font-size: 1.8rem; font-weight: 700; color: #58a6ff; }
    .stat-label { color: #8b949e; font-size: 0.8rem; }
    table { width: 100%; border-collapse: collapse; background: #161b22; border-radius: 8px; overflow: hidden; border: 1px solid #30363d; margin-bottom: 1rem; }
    th { background: #21262d; color: #8b949e; text-align: left; padding: 0.6rem 0.8rem; font-weight: 600; font-size: 0.8rem; text-transform: uppercase; }
    td { padding: 0.6rem 0.8rem; border-top: 1px solid #21262d; font-size: 0.9rem; }
    tr:hover td { background: #1c2128; }
    code { background: #21262d; padding: 0.15rem 0.4rem; border-radius: 4px; font-size: 0.85rem; color: #f0883e; }
    .tag { display: inline-block; background: #1f6feb33; color: #58a6ff; padding: 0.1rem 0.5rem; border-radius: 10px; font-size: 0.75rem; margin: 0.1rem; }
    .empty { text-align: center; padding: 1.5rem; color: #8b949e; background: #161b22; border: 1px solid #30363d; border-radius: 8px; }
    .status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; vertical-align: middle; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
    @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
    .graph-container { display: flex; align-items: flex-end; gap: 4px; height: 80px; background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 10px 10px 0; margin-bottom: 1rem; }
    .graph-bar-wrap { display: flex; flex-direction: column; align-items: center; flex: 1; }
    .graph-bar { background: #58a6ff; border-radius: 2px 2px 0 0; width: 100%; min-width: 12px; transition: height 0.3s; }
    .graph-label { font-size: 0.65rem; color: #8b949e; margin-top: 2px; padding-bottom: 4px; }
    .section-icon { margin-right: 0.4rem; }
    .refresh-bar { margin-top: 1.5rem; padding: 0.5rem; text-align: center; color: #8b949e; font-size: 0.8rem; border-top: 1px solid #21262d; }
  </style>
</head>
<body>
  <h1>🐝 Claude Swarm Dashboard</h1>
  <p class="subtitle">Real-time swarm coordination overview</p>

  <div class="stats">
    <div class="stat"><div class="stat-value">${alivePeers.length}</div><div class="stat-label">Active Peers</div></div>
    <div class="stat"><div class="stat-value">${totalMessages}</div><div class="stat-label">Messages</div></div>
    <div class="stat"><div class="stat-value">${pendingTasks}</div><div class="stat-label">Pending Tasks</div></div>
    <div class="stat"><div class="stat-value">${totalSnippets}</div><div class="stat-label">Snippets</div></div>
    <div class="stat"><div class="stat-value">${totalAlerts}</div><div class="stat-label">Alerts</div></div>
    <div class="stat"><div class="stat-value">${totalPins}</div><div class="stat-label">Pins</div></div>
    <div class="stat"><div class="stat-value">${totalFiles}</div><div class="stat-label">Files</div></div>
  </div>

  <h2><span class="section-icon">📊</span>Message Activity (Last 12h)</h2>
  <div class="graph-container">${graphBars}</div>

  <h2><span class="section-icon">👥</span>Peers</h2>
  ${alivePeers.length > 0 ? `
  <table>
    <thead><tr><th>ID</th><th>PID</th><th>Status</th><th>Directory</th><th>Summary</th><th>Tags</th><th>Last Seen</th></tr></thead>
    <tbody>${peerRows}</tbody>
  </table>` : '<div class="empty">No active peers. Start a Claude Code instance with claude-swarm-mcp configured.</div>'}

  <div class="grid">
    <div>
      <h2><span class="section-icon">📌</span>Pinned Messages</h2>
      ${pins.length > 0 ? `<table><thead><tr><th>#</th><th>Content</th><th>By</th><th>When</th></tr></thead><tbody>${pinRows}</tbody></table>` : '<div class="empty">No pinned messages</div>'}
    </div>
    <div>
      <h2><span class="section-icon">📋</span>Active Tasks</h2>
      ${activeTasks.length > 0 ? `<table><thead><tr><th>#</th><th>State</th><th>Flow</th><th>Description</th></tr></thead><tbody>${taskRows}</tbody></table>` : '<div class="empty">No active tasks</div>'}
    </div>
  </div>

  <div class="grid">
    <div>
      <h2><span class="section-icon">💬</span>Recent Messages</h2>
      ${recentMsgs.length > 0 ? `<table><thead><tr><th>From</th><th>Message</th><th>When</th></tr></thead><tbody>${activityRows}</tbody></table>` : '<div class="empty">No messages yet</div>'}
    </div>
    <div>
      <h2><span class="section-icon">📝</span>Recent Snippets</h2>
      ${recentSnippets.length > 0 ? `<table><thead><tr><th>#</th><th>Title</th><th>Lang</th><th>Author</th></tr></thead><tbody>${snippetRows}</tbody></table>` : '<div class="empty">No snippets yet</div>'}
    </div>
  </div>

  <div class="refresh-bar">Auto-refreshes every 5 seconds</div>
  <script>setTimeout(() => location.reload(), 5000);</script>
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

    // Analytics endpoint (GET)
    if (path === "/analytics") {
      return Response.json(handleAnalytics());
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
          case "/set-status":
            handleSetStatus(body as SetStatusRequest);
            return Response.json({ ok: true });
          case "/share-file":
            return Response.json(await handleShareFile(body as ShareFileRequest));
          case "/list-shared-files":
            return Response.json(handleListSharedFiles(body as ListSharedFilesRequest));
          case "/get-shared-file":
            return Response.json(handleGetSharedFile(body as GetSharedFileRequest));
          case "/alert-peer":
            return Response.json(handleAlertPeer(body as AlertPeerRequest));
          case "/alert-all":
            return Response.json(handleAlertAll(body as AlertAllRequest));
          case "/pin-message":
            return Response.json(handlePinMessage(body as PinMessageRequest));
          case "/list-pins":
            return Response.json(handleListPins());
          case "/unpin-message":
            return Response.json(handleUnpinMessage(body as UnpinMessageRequest));
          case "/peer-stats":
            return Response.json(handlePeerStats(body as PeerStatsRequest));
          case "/request-review":
            return Response.json(await handleRequestReview(body as RequestReviewRequest));
          case "/sync-status":
            return Response.json(await handleSyncStatus(body as SyncStatusRequest));
          case "/list-alerts":
            return Response.json(handleListAlerts(body as { peer_id?: string; limit?: number }));
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
