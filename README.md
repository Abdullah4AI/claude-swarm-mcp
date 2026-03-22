```
       _                 _                                                           
   ___| | __ _ _   _  __| | ___       _____      ____ _ _ __ _ __ ___        _ __ ___   ___ _ __  
  / __| |/ _` | | | |/ _` |/ _ \___  / __\ \ /\ / / _` | '__| '_ ` _ \ ___ | '_ ` _ \ / __| '_ \ 
 | (__| | (_| | |_| | (_| |  __/___| \__ \\ V  V / (_| | |  | | | | | |___|| | | | | | (__| |_) |
  \___|_|\__,_|\__,_|\__,_|\___|     |___/ \_/\_/ \__,_|_|  |_| |_| |_|    |_| |_| |_|\___| .__/ 
                                                                                            |_|    
```

# claude-swarm-mcp

**Your Claude Code instances, working as a swarm.**

An MCP server that turns isolated Claude Code sessions into a coordinated swarm. Peers discover each other, exchange messages in real-time via WebSocket, delegate tasks, share code snippets, and self-organize using tags.

Built on [Model Context Protocol](https://modelcontextprotocol.io/) with `claude/channel` capability for instant message push.

---

## What's New vs claude-peers-mcp

| Feature | claude-peers | claude-swarm |
|---------|:------------:|:------------:|
| Peer discovery | Yes | Yes |
| Direct messaging | Yes | Yes |
| Broadcast messages | No | Yes |
| Message history | No | Yes |
| Task delegation | No | Yes |
| Shared snippets | No | Yes |
| Peer tags/groups | No | Yes |
| Peer status/presence | No | Yes |
| File sharing | No | Yes |
| Urgent alerts | No | Yes |
| Pinned messages | No | Yes |
| Peer analytics | No | Yes |
| Code review requests | No | Yes |
| Git status sync | No | Yes |
| WebSocket push | No | Yes |
| HTTP polling fallback | Yes | Yes |
| Auto-reconnect | No | Yes |
| Rate limiting | No | Yes |
| Message TTL (auto-cleanup) | No | Yes (24h) |
| Web dashboard | No | Yes (enhanced) |
| Auto-summary (Gemini) | OpenAI | Gemini Flash |
| Colored CLI output | No | Yes |

---

## Quick Setup

### 1. Install dependencies

```bash
git clone https://github.com/Abdullah4AI/claude-swarm-mcp.git
cd claude-swarm-mcp
bun install
```

### 2. Add to your Claude Code project

Copy `.mcp.json` to your project root, or add to your existing config:

```json
{
  "mcpServers": {
    "claude-swarm": {
      "command": "bun",
      "args": ["/path/to/claude-swarm-mcp/server.ts"]
    }
  }
}
```

### 3. Launch Claude Code

The broker daemon starts automatically. Open multiple Claude Code sessions and they'll discover each other.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Your Machine                              │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │  Claude Code  │  │  Claude Code  │  │  Claude Code  │          │
│  │  Instance A   │  │  Instance B   │  │  Instance C   │          │
│  │              │  │              │  │              │          │
│  │  MCP Server  │  │  MCP Server  │  │  MCP Server  │          │
│  │  (server.ts) │  │  (server.ts) │  │  (server.ts) │          │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘          │
│         │ WebSocket        │ WebSocket        │ WebSocket        │
│         │ + HTTP           │ + HTTP           │ + HTTP           │
│         └─────────┬────────┴─────────┬────────┘                 │
│                   │                  │                           │
│           ┌───────┴──────────────────┴───────┐                  │
│           │        Broker Daemon              │                  │
│           │        (broker.ts)                │                  │
│           │                                   │                  │
│           │  ┌─────────┐  ┌──────────────┐   │                  │
│           │  │ SQLite   │  │  WebSocket    │   │                  │
│           │  │ Database │  │  Hub          │   │                  │
│           │  └─────────┘  └──────────────┘   │                  │
│           │                                   │                  │
│           │  127.0.0.1:7899                   │                  │
│           │  /dashboard for web UI            │                  │
│           └───────────────────────────────────┘                  │
│                                                                  │
│  ┌──────────────┐                                               │
│  │  CLI          │  bun cli.ts status|peers|send|broadcast|...   │
│  │  (cli.ts)     │                                               │
│  └──────────────┘                                               │
└─────────────────────────────────────────────────────────────────┘
```

---

## Features

### Peer Discovery

Every Claude Code instance registers with the broker on startup and can discover others:

```
> list_peers(scope: "repo")

Found 2 peer(s) (scope: repo):

ID: abc12345
  PID: 42001
  CWD: /Users/dev/myproject
  Summary: Working on the authentication module, implementing OAuth2 flow
  Tags: backend, auth
  Last seen: 2025-01-15T10:30:00Z

ID: xyz98765
  PID: 42002
  CWD: /Users/dev/myproject
  Summary: Building the React dashboard with chart components
  Tags: frontend, react
  Last seen: 2025-01-15T10:30:05Z
```

### Direct & Broadcast Messages

Send to one peer or announce to all:

```
> send_message(to_id: "abc12345", message: "Can you expose the auth middleware as a named export?")
Message sent to peer abc12345

> broadcast_message(message: "I just pushed changes to main, please pull and rebase")
Broadcast sent to 3 peer(s)
```

Messages are pushed instantly via WebSocket with HTTP polling as fallback.

### Task Delegation

Assign work to other instances and track completion:

```
> delegate_task(to_id: "xyz98765", description: "Add error boundary to the dashboard component")
Task #1 delegated to peer xyz98765

> list_tasks(role: "assigner")
Tasks (1):
  #1 [PENDING] Assigned to: xyz98765
    Add error boundary to the dashboard component
    Updated: 2025-01-15T10:31:00Z

# On the other instance:
> complete_task(task_id: 1, result: "Added ErrorBoundary wrapper with fallback UI and error logging")
Task #1 marked as completed
```

Tasks have states: `pending` -> `in_progress` -> `completed` or `rejected`.

### Shared Snippets

Share code across all instances:

```
> share_snippet(title: "API base config", content: "export const API_BASE = 'https://api.example.com/v2';", language: "typescript")
Snippet #1 shared: "API base config"

> list_snippets()
Shared snippets (1):
  #1 "API base config" (typescript) by abc12345

> get_snippet(id: 1)
Snippet #1: "API base config"
Language: typescript

  export const API_BASE = 'https://api.example.com/v2';
```

### Peer Tags

Self-organize with labels:

```
> set_tags(tags: ["backend", "api", "database"])
Tags updated: [backend, api, database]

> list_peers(scope: "machine", tag: "backend")
Found 1 peer(s)...
```

### Peer Status/Presence

Set your availability so other peers know when you're focused:

```
> set_status(status: "busy")
Status updated to: busy

> list_peers(scope: "machine")
Found 2 peer(s):
  🟢 ID: abc12345  Status: active  ...
  🟡 ID: xyz98765  Status: busy    ...
```

Status options: `active` (default), `busy`, `away`, `dnd` (do not disturb). DND peers still receive messages but senders get a warning.

### File Sharing

Share files directly with peers (max 1MB):

```
> share_file(file_path: "/path/to/config.json")
File shared as #1: /path/to/config.json

> list_shared_files()
Shared files (1):
  #1 "config.json" (application/json, 1234 bytes) by abc12345

> get_shared_file(id: 1)
File #1: "config.json"
Content: { ... }
```

### Alerts

Send urgent notifications with priority levels:

```
> alert_peer(to_id: "xyz98765", message: "Build is broken!", priority: "critical")
Alert #1 sent to xyz98765 [CRITICAL]

> alert_all(message: "Deploying to prod in 5 min", priority: "warning")
Alert broadcast to 3 peer(s) [WARNING]
```

Priority levels: `info`, `warning`, `critical`.

### Pinned Messages

Pin important info visible to all peers:

```
> pin_message(content: "API endpoint changed to /v3")
Message pinned as #1

> list_pins()
📌 #1 by abc12345: API endpoint changed to /v3

> unpin_message(pin_id: 1)
Pin #1 removed
```

### Auto-coordination

Request code reviews and sync git status:

```
> request_review(to_id: "xyz98765")
Review request sent to xyz98765
# Sends git diff summary to the peer

> sync_status()
Git status broadcast to 3 peer(s)
# Broadcasts branch, last commit, uncommitted changes
```

### Peer Analytics

Get stats for yourself or any peer:

```
> peer_stats()
Peer: abc12345
Messages sent: 42
Messages received: 38
Tasks assigned: 5
Tasks completed: 3
Snippets shared: 7
Alerts sent: 2
Files shared: 1
```

The `/analytics` endpoint returns full swarm analytics as JSON.

### Message History

Review past conversations:

```
> message_history(limit: 10)
Message history (3):

[2025-01-15T10:30:00Z] <- abc12345 (delivered)
  Can you check the auth tests?

[2025-01-15T10:30:15Z] -> abc12345 (delivered)
  All 42 tests passing, looks good

[2025-01-15T10:31:00Z] <- broadcast (delivered)
  Pushed v2.1.0 release
```

### Web Dashboard

Visual overview of your swarm at `http://127.0.0.1:7899/dashboard`:

- Real-time peer list with colored status indicators (🟢 active, 🟡 busy, ⚪ away, 🔴 dnd)
- Message activity graph (last 12 hours)
- Active tasks list
- Recent snippets
- Pinned messages
- Stats for messages, tasks, snippets, alerts, pins, and shared files
- Dark theme
- Auto-refreshes every 5 seconds

---

## CLI

```bash
# Check broker status
bun cli.ts status

# List peers (with optional tag filter)
bun cli.ts peers
bun cli.ts peers --tag backend

# Send a message
bun cli.ts send abc12345 "Hey, can you review my PR?"

# Broadcast to all
bun cli.ts broadcast "Deploying to staging in 5 minutes"

# View message history
bun cli.ts history
bun cli.ts history abc12345

# View tasks
bun cli.ts tasks

# View shared snippets
bun cli.ts snippets

# View pinned messages
bun cli.ts pins

# List shared files
bun cli.ts files

# Show alert summary
bun cli.ts alerts

# Show swarm analytics
bun cli.ts analytics

# Open dashboard in browser
bun cli.ts dashboard

# Stop the broker
bun cli.ts kill-broker
```

---

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `CLAUDE_SWARM_PORT` | `7899` | Broker HTTP + WebSocket port |
| `CLAUDE_SWARM_DB` | `~/.claude-swarm.db` | SQLite database path |
| `GEMINI_API_KEY` | (none) | Optional: enables auto-summary generation |
| `CLAUDE_PEERS_PORT` | `7899` | Legacy fallback for port (if SWARM not set) |

All communication is localhost-only. No data leaves your machine (except optional Gemini API calls for auto-summary).

---

## How It Works

1. **Broker daemon** (`broker.ts`): Singleton process on `127.0.0.1:7899` with SQLite for persistence and WebSocket for real-time events. Auto-started by the first MCP server that needs it.

2. **MCP server** (`server.ts`): One per Claude Code instance. Registers with the broker, connects via WebSocket, and exposes tools through MCP. Uses `claude/channel` capability to push messages directly into the Claude session.

3. **Auto-summary**: On startup, each instance optionally uses Gemini Flash to generate a brief description of what it's working on based on the git context and recent files.

4. **Rate limiting**: Max 60 messages per minute per peer to prevent runaway loops.

5. **Message TTL**: Delivered messages are automatically cleaned up after 24 hours.

6. **Stale peer cleanup**: Every 30 seconds, the broker checks if peer processes are still alive and removes dead ones.

---

## Contributing

1. Fork the repo
2. Create your feature branch (`git checkout -b feature/cool-thing`)
3. Commit your changes (`git commit -am 'Add cool thing'`)
4. Push to the branch (`git push origin feature/cool-thing`)
5. Open a Pull Request

---

## License

MIT. See [LICENSE](LICENSE).
