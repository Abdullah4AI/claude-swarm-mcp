/**
 * claude-swarm-mcp — Shared type definitions
 *
 * All interfaces for broker API requests/responses, peers, messages,
 * tasks, snippets, and WebSocket events.
 */

// --- Core types ---

export type PeerId = string;

export interface Peer {
  id: PeerId;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  tags: string; // JSON array string, e.g. '["frontend","backend"]'
  registered_at: string;
  last_seen: string;
}

export interface Message {
  id: number;
  from_id: PeerId;
  to_id: PeerId; // "*" for broadcast
  text: string;
  sent_at: string;
  delivered: number; // 0 or 1 (SQLite boolean)
}

export type TaskState = "pending" | "in_progress" | "completed" | "rejected";

export interface Task {
  id: number;
  from_id: PeerId;
  to_id: PeerId;
  description: string;
  deadline: string | null;
  state: TaskState;
  result: string | null;
  created_at: string;
  updated_at: string;
}

export interface Snippet {
  id: number;
  author_id: PeerId;
  title: string;
  content: string;
  language: string;
  created_at: string;
}

// --- Broker API request/response types ---

export interface RegisterRequest {
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  tags?: string[];
}

export interface RegisterResponse {
  id: PeerId;
}

export interface HeartbeatRequest {
  id: PeerId;
}

export interface SetSummaryRequest {
  id: PeerId;
  summary: string;
}

export interface SetTagsRequest {
  id: PeerId;
  tags: string[];
}

export interface ListPeersRequest {
  scope: "machine" | "directory" | "repo";
  cwd: string;
  git_root: string | null;
  exclude_id?: PeerId;
  tag?: string;
}

export interface SendMessageRequest {
  from_id: PeerId;
  to_id: PeerId;
  text: string;
}

export interface BroadcastMessageRequest {
  from_id: PeerId;
  text: string;
  scope?: "machine" | "directory" | "repo";
  cwd?: string;
  git_root?: string | null;
}

export interface PollMessagesRequest {
  id: PeerId;
}

export interface PollMessagesResponse {
  messages: Message[];
}

export interface MessageHistoryRequest {
  peer_id?: PeerId;
  limit?: number;
}

export interface DelegateTaskRequest {
  from_id: PeerId;
  to_id: PeerId;
  description: string;
  deadline?: string | null;
}

export interface ListTasksRequest {
  peer_id: PeerId;
  role?: "assignee" | "assigner" | "all";
}

export interface CompleteTaskRequest {
  task_id: number;
  peer_id: PeerId;
  result?: string;
}

export interface UpdateTaskStateRequest {
  task_id: number;
  peer_id: PeerId;
  state: TaskState;
  result?: string;
}

export interface ShareSnippetRequest {
  author_id: PeerId;
  title: string;
  content: string;
  language?: string;
}

export interface ListSnippetsRequest {
  limit?: number;
}

export interface GetSnippetRequest {
  id: number;
}

// --- WebSocket event types ---

export type WsEventType = "message" | "broadcast" | "task" | "snippet" | "peer_joined" | "peer_left";

export interface WsEvent {
  type: WsEventType;
  data: unknown;
  timestamp: string;
}

// --- Rate limit ---

export interface RateLimitEntry {
  count: number;
  reset_at: number;
}
