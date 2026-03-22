#!/usr/bin/env bun
/**
 * claude-swarm-mcp CLI
 *
 * Utility commands for managing the broker and inspecting peers.
 *
 * Usage:
 *   bun cli.ts status              — Show broker status and all peers
 *   bun cli.ts peers [--tag X]     — List all peers (optional tag filter)
 *   bun cli.ts send <id> <msg>     — Send a message to a peer
 *   bun cli.ts broadcast <msg>     — Broadcast to all peers
 *   bun cli.ts history [peer-id]   — View message history
 *   bun cli.ts tasks               — List all tasks
 *   bun cli.ts snippets            — List shared snippets
 *   bun cli.ts dashboard           — Open dashboard in browser
 *   bun cli.ts kill-broker         — Stop the broker daemon
 */

// --- ANSI color helpers ---

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
};

function colorize(text: string, color: string): string {
  return `${color}${text}${c.reset}`;
}

// --- Config ---

const BROKER_PORT = parseInt(process.env.CLAUDE_SWARM_PORT ?? process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;

// --- Broker fetch ---

async function brokerFetch<T>(path: string, body?: unknown): Promise<T> {
  const opts: RequestInit = body
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    : {};
  const res = await fetch(`${BROKER_URL}${path}`, { ...opts, signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

// --- Types for display ---

interface PeerInfo {
  id: string;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  tags: string;
  last_seen: string;
}

interface MessageInfo {
  id: number;
  from_id: string;
  to_id: string;
  text: string;
  sent_at: string;
  delivered: number;
}

interface TaskInfo {
  id: number;
  from_id: string;
  to_id: string;
  description: string;
  deadline: string | null;
  state: string;
  result: string | null;
  created_at: string;
  updated_at: string;
}

interface SnippetInfo {
  id: number;
  author_id: string;
  title: string;
  content: string;
  language: string;
  created_at: string;
}

// --- Commands ---

const cmd = process.argv[2];

switch (cmd) {
  case "status": {
    try {
      const health = await brokerFetch<{ status: string; peers: number; ws_connections: number }>("/health");
      console.log(`${colorize("Broker:", c.bold)} ${colorize(health.status, c.green)} (${health.peers} peer(s), ${health.ws_connections} WebSocket connection(s))`);
      console.log(`${colorize("URL:", c.bold)} ${BROKER_URL}`);
      console.log(`${colorize("Dashboard:", c.bold)} ${BROKER_URL}/dashboard`);

      if (health.peers > 0) {
        const peers = await brokerFetch<PeerInfo[]>("/list-peers", { scope: "machine", cwd: "/", git_root: null });
        console.log(`\n${colorize("Active Peers:", c.bold)}`);
        for (const p of peers) {
          const tags = (() => { try { return JSON.parse(p.tags) as string[]; } catch { return []; } })();
          const tagStr = tags.length > 0 ? ` ${colorize(`[${tags.join(", ")}]`, c.cyan)}` : "";
          console.log(`  ${colorize(p.id, c.yellow)}  PID:${p.pid}  ${colorize(p.cwd, c.blue)}${tagStr}`);
          if (p.summary) console.log(`         ${colorize(p.summary, c.dim)}`);
          if (p.tty) console.log(`         TTY: ${p.tty}`);
          console.log(`         ${colorize(`Last seen: ${p.last_seen}`, c.gray)}`);
        }
      }
    } catch {
      console.log(colorize("Broker is not running.", c.red));
    }
    break;
  }

  case "peers": {
    try {
      const tagFlag = process.argv.indexOf("--tag");
      const tag = tagFlag !== -1 ? process.argv[tagFlag + 1] : undefined;

      const peers = await brokerFetch<PeerInfo[]>("/list-peers", {
        scope: "machine", cwd: "/", git_root: null, tag,
      });

      if (peers.length === 0) {
        console.log(colorize("No peers registered.", c.yellow));
      } else {
        console.log(colorize(`${peers.length} peer(s):`, c.bold));
        for (const p of peers) {
          const tags = (() => { try { return JSON.parse(p.tags) as string[]; } catch { return []; } })();
          const tagStr = tags.length > 0 ? ` ${colorize(`[${tags.join(", ")}]`, c.cyan)}` : "";
          console.log(`  ${colorize(p.id, c.yellow)}  PID:${p.pid}  ${colorize(p.cwd, c.blue)}${tagStr}`);
          if (p.summary) console.log(`         ${colorize(p.summary, c.dim)}`);
        }
      }
    } catch {
      console.log(colorize("Broker is not running.", c.red));
    }
    break;
  }

  case "send": {
    const toId = process.argv[3];
    const msg = process.argv.slice(4).join(" ");
    if (!toId || !msg) {
      console.error(colorize("Usage: bun cli.ts send <peer-id> <message>", c.red));
      process.exit(1);
    }
    try {
      const result = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", {
        from_id: "cli", to_id: toId, text: msg,
      });
      if (result.ok) {
        console.log(colorize(`Message sent to ${toId}`, c.green));
      } else {
        console.error(colorize(`Failed: ${result.error}`, c.red));
      }
    } catch (e) {
      console.error(colorize(`Error: ${e instanceof Error ? e.message : String(e)}`, c.red));
    }
    break;
  }

  case "broadcast": {
    const msg = process.argv.slice(3).join(" ");
    if (!msg) {
      console.error(colorize("Usage: bun cli.ts broadcast <message>", c.red));
      process.exit(1);
    }
    try {
      const result = await brokerFetch<{ ok: boolean; count: number }>("/broadcast-message", {
        from_id: "cli", text: msg, scope: "machine", cwd: "/", git_root: null,
      });
      console.log(colorize(`Broadcast sent to ${result.count} peer(s)`, c.green));
    } catch (e) {
      console.error(colorize(`Error: ${e instanceof Error ? e.message : String(e)}`, c.red));
    }
    break;
  }

  case "history": {
    try {
      const peerId = process.argv[3];
      const messages = await brokerFetch<MessageInfo[]>("/message-history", {
        peer_id: peerId, limit: 20,
      });
      if (messages.length === 0) {
        console.log(colorize("No message history.", c.yellow));
      } else {
        console.log(colorize(`Message history (${messages.length}):`, c.bold));
        for (const m of messages) {
          const dir = colorize(m.from_id, c.cyan) + " -> " + colorize(m.to_id, c.magenta);
          const status = m.delivered ? colorize("delivered", c.green) : colorize("pending", c.yellow);
          console.log(`  ${colorize(m.sent_at, c.gray)} ${dir} [${status}]`);
          console.log(`    ${m.text}`);
        }
      }
    } catch {
      console.log(colorize("Broker is not running.", c.red));
    }
    break;
  }

  case "tasks": {
    try {
      // Show all tasks (no peer filter from CLI since CLI isn't a peer)
      const tasks = await brokerFetch<TaskInfo[]>("/list-tasks", {
        peer_id: "cli", role: "all",
      });
      if (tasks.length === 0) {
        console.log(colorize("No tasks found.", c.yellow));
      } else {
        console.log(colorize(`Tasks (${tasks.length}):`, c.bold));
        for (const t of tasks) {
          const stateColor = t.state === "completed" ? c.green : t.state === "pending" ? c.yellow : t.state === "rejected" ? c.red : c.blue;
          console.log(`  ${colorize(`#${t.id}`, c.bold)} [${colorize(t.state.toUpperCase(), stateColor)}] ${t.from_id} -> ${t.to_id}`);
          console.log(`    ${t.description}`);
          if (t.deadline) console.log(`    ${colorize(`Deadline: ${t.deadline}`, c.gray)}`);
          if (t.result) console.log(`    ${colorize(`Result: ${t.result}`, c.dim)}`);
        }
      }
    } catch {
      console.log(colorize("Broker is not running.", c.red));
    }
    break;
  }

  case "snippets": {
    try {
      const snippets = await brokerFetch<SnippetInfo[]>("/list-snippets", { limit: 20 });
      if (snippets.length === 0) {
        console.log(colorize("No shared snippets.", c.yellow));
      } else {
        console.log(colorize(`Shared snippets (${snippets.length}):`, c.bold));
        for (const s of snippets) {
          console.log(`  ${colorize(`#${s.id}`, c.bold)} ${colorize(`"${s.title}"`, c.cyan)} (${s.language}) by ${colorize(s.author_id, c.yellow)}`);
          console.log(`    ${colorize(s.created_at, c.gray)}`);
          // Show first 2 lines of content
          const preview = s.content.split("\n").slice(0, 2).join("\n    ");
          console.log(`    ${colorize(preview, c.dim)}`);
        }
      }
    } catch {
      console.log(colorize("Broker is not running.", c.red));
    }
    break;
  }

  case "dashboard": {
    const url = `${BROKER_URL}/dashboard`;
    console.log(colorize(`Opening dashboard: ${url}`, c.blue));
    Bun.spawn(["open", url]);
    break;
  }

  case "kill-broker": {
    try {
      const health = await brokerFetch<{ status: string; peers: number }>("/health");
      console.log(`Broker has ${health.peers} peer(s). Shutting down...`);
      const proc = Bun.spawnSync(["lsof", "-ti", `:${BROKER_PORT}`]);
      const pids = new TextDecoder().decode(proc.stdout).trim().split("\n").filter((p) => p);
      for (const pid of pids) {
        process.kill(parseInt(pid), "SIGTERM");
      }
      console.log(colorize("Broker stopped.", c.green));
    } catch {
      console.log(colorize("Broker is not running.", c.yellow));
    }
    break;
  }

  default:
    console.log(`${colorize("claude-swarm-mcp CLI", c.bold)}

${colorize("Usage:", c.yellow)}
  bun cli.ts status              Show broker status and all peers
  bun cli.ts peers [--tag X]     List all peers (optional tag filter)
  bun cli.ts send <id> <msg>     Send a message to a peer
  bun cli.ts broadcast <msg>     Broadcast to all peers
  bun cli.ts history [peer-id]   View message history
  bun cli.ts tasks               List all tasks
  bun cli.ts snippets            List shared snippets
  bun cli.ts dashboard           Open dashboard in browser
  bun cli.ts kill-broker         Stop the broker daemon`);
}
