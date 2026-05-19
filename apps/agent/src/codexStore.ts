import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SessionMessage, SessionReadResult, SessionSummary } from "@crc/protocol";

const execFileAsync = promisify(execFile);

interface ThreadRow {
  id: string;
  title: string;
  preview: string;
  cwd: string;
  rolloutPath: string;
  createdAt: number | null;
  updatedAt: number | null;
}

export class CodexStore {
  constructor(private readonly codexHome: string) {}

  async listSessions(limit = 100): Promise<SessionSummary[]> {
    const dbPath = join(this.codexHome, "state_5.sqlite");
    try {
      const sql = `select id, title, preview, cwd, rollout_path as rolloutPath, created_at_ms as createdAt, updated_at_ms as updatedAt from threads where archived = 0 order by updated_at_ms desc limit ${Number(limit)};`;
      const { stdout } = await execFileAsync("sqlite3", ["-json", dbPath, sql], { maxBuffer: 8 * 1024 * 1024 });
      const rows = JSON.parse(stdout || "[]") as ThreadRow[];
      return rows.map((row) => this.normalizeThread(row));
    } catch {
      return this.listFromIndex(limit);
    }
  }

  async readSession(threadId: string): Promise<SessionReadResult> {
    const sessions = await this.listSessions(500);
    const session = sessions.find((item) => item.id === threadId);
    if (!session) {
      throw new Error(`Unknown Codex session: ${threadId}`);
    }
    this.assertRolloutPath(session.rolloutPath);
    const text = await readFile(session.rolloutPath, "utf8");
    const runtime = this.readRuntimeState(text);
    const messages = text
      .split("\n")
      .filter(Boolean)
      .map((line, index) => this.toMessage(line, index))
      .filter((message): message is SessionMessage => message !== null);
    return { session: { ...session, ...runtime }, messages };
  }

  private normalizeThread(row: ThreadRow): SessionSummary {
    return {
      id: row.id,
      title: row.title || row.preview || row.id,
      preview: row.preview || "",
      cwd: row.cwd || "",
      rolloutPath: row.rolloutPath,
      createdAt: row.createdAt ?? 0,
      updatedAt: row.updatedAt ?? 0,
      status: "unknown"
    };
  }

  private async listFromIndex(limit: number): Promise<SessionSummary[]> {
    const indexPath = join(this.codexHome, "session_index.jsonl");
    const text = await readFile(indexPath, "utf8");
    const rows = text
      .split("\n")
      .filter(Boolean)
      .slice(-limit)
      .reverse()
      .map((line) => JSON.parse(line) as { id: string; thread_name?: string; updated_at?: string });
    const rolloutPaths = await this.rolloutPathsFor(new Set(rows.map((row) => row.id)));
    return rows
      .map((row) => ({
        id: row.id,
        title: row.thread_name || row.id,
        preview: "",
        cwd: "",
        rolloutPath: rolloutPaths.get(row.id) ?? "",
        createdAt: 0,
        updatedAt: row.updated_at ? Date.parse(row.updated_at) : 0,
        status: "unknown" as const
      }))
      .filter((row) => row.rolloutPath);
  }

  private assertRolloutPath(path: string): void {
    const resolved = resolve(path);
    const sessionsRoot = resolve(this.codexHome, "sessions");
    const rel = relative(sessionsRoot, resolved);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error("Refusing to read rollout outside Codex sessions directory.");
    }
  }

  private async rolloutPathsFor(ids: Set<string>): Promise<Map<string, string>> {
    const root = join(this.codexHome, "sessions");
    const paths = new Map<string, string>();

    async function visit(dir: string): Promise<void> {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          await visit(fullPath);
          continue;
        }
        for (const id of ids) {
          if (entry.name.endsWith(`${id}.jsonl`)) {
            paths.set(id, fullPath);
          }
        }
      }
    }

    await visit(root);
    return paths;
  }

  private readRuntimeState(text: string): Pick<SessionSummary, "status" | "activeTurnId"> {
    let activeTurnId: string | undefined;
    for (const line of text.split("\n")) {
      if (!line) continue;
      let record: any;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const payload = record.payload ?? {};
      if (record.type !== "event_msg") continue;
      if (payload.type === "task_started" && typeof payload.turn_id === "string") {
        activeTurnId = payload.turn_id;
      }
      if (
        typeof payload.turn_id === "string" &&
        payload.turn_id === activeTurnId &&
        ["task_complete", "task_failed", "task_cancelled", "task_interrupted"].includes(payload.type)
      ) {
        activeTurnId = undefined;
      }
    }
    return activeTurnId ? { status: "running", activeTurnId } : { status: "idle" };
  }

  private toMessage(line: string, index: number): SessionMessage | null {
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      return null;
    }
    const timestamp = record.timestamp;
    const payload = record.payload ?? {};
    const id = `${timestamp ?? "line"}-${index}`;

    if (record.type === "event_msg" && payload.type === "user_message") {
      return { id, timestamp, role: "user", text: String(payload.message ?? "") };
    }
    if (record.type === "event_msg" && payload.type === "agent_message") {
      return { id, timestamp, role: "assistant", text: String(payload.message ?? "") };
    }
    if (record.type === "response_item" && payload.type === "message") {
      const text = Array.isArray(payload.content)
        ? payload.content.map((part: any) => part.text ?? part.content ?? "").join("")
        : String(payload.content ?? "");
      const role = payload.role === "user" ? "user" : "assistant";
      return { id, timestamp, role, text };
    }
    if (record.type === "response_item" && payload.type === "function_call") {
      return {
        id,
        timestamp,
        role: "tool",
        name: payload.name,
        text: `call ${payload.name} ${payload.arguments ?? ""}`.trim()
      };
    }
    if (record.type === "response_item" && payload.type === "function_call_output") {
      return {
        id,
        timestamp,
        role: "tool",
        name: payload.call_id,
        text: String(payload.output ?? "")
      };
    }
    if (record.type === "response_item" && payload.type === "reasoning") {
      const summary = Array.isArray(payload.summary)
        ? payload.summary.map((part: any) => part.text ?? "").join("")
        : "";
      return summary ? { id, timestamp, role: "reasoning", text: summary } : null;
    }
    return null;
  }
}
