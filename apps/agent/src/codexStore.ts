import { open, readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SessionMessage, SessionReadResult, SessionSummary } from "@crc/protocol";

const execFileAsync = promisify(execFile);
const defaultMessageLimit = 300;
const maxMessageLimit = 1000;
const rolloutThreadIdPattern = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

interface ThreadRow {
  id: string;
  title: string;
  preview: string;
  cwd: string;
  rolloutPath: string;
  createdAt: number | null;
  updatedAt: number | null;
  source?: unknown;
  threadSource?: unknown;
}

interface IndexRow {
  id: string;
  thread_name?: string;
  updated_at?: string;
  source?: unknown;
  thread_source?: unknown;
}

export class CodexStore {
  constructor(private readonly codexHome: string) {}

  async listSessions(limit = 100): Promise<SessionSummary[]> {
    const dbPath = join(this.codexHome, "state_5.sqlite");
    const safeLimit = this.boundedLimit(limit);
    try {
      const sql = [
        "select id, title, preview, cwd, rollout_path as rolloutPath,",
        "created_at_ms as createdAt, updated_at_ms as updatedAt, source, thread_source as threadSource",
        "from threads",
        "where archived = 0",
        "and lower(coalesce(source, '')) not like '%subagent%'",
        "and lower(coalesce(thread_source, '')) != 'subagent'",
        `order by updated_at_ms desc limit ${safeLimit};`
      ].join(" ");
      const { stdout } = await execFileAsync("sqlite3", ["-json", dbPath, sql], { maxBuffer: 8 * 1024 * 1024 });
      const rows = JSON.parse(stdout || "[]") as ThreadRow[];
      return rows.filter((row) => this.isVisibleThread(row)).map((row) => this.normalizeThread(row));
    } catch {
      return this.listFromIndex(safeLimit);
    }
  }

  async readSession(threadId: string, messageLimit = defaultMessageLimit): Promise<SessionReadResult> {
    const sessions = await this.listSessions(500);
    const session = sessions.find((item) => item.id === threadId);
    if (!session) {
      throw new Error(`Unknown Codex session: ${threadId}`);
    }
    this.assertRolloutPath(session.rolloutPath);
    const text = await readFile(session.rolloutPath, "utf8");
    const lines = text.split("\n").filter(Boolean);
    const runtime = this.readRuntimeState(lines);
    const messages = this.latestMessages(lines, messageLimit);
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
    const safeLimit = this.boundedLimit(limit);
    const text = await readFile(indexPath, "utf8");
    const rows = text
      .split("\n")
      .filter(Boolean)
      .reverse()
      .map((line) => JSON.parse(line) as IndexRow)
      .filter((row) => this.isVisibleThread({ source: row.source, threadSource: row.thread_source }));
    const rolloutPaths = await this.rolloutPathsFor(new Set(rows.map((row) => row.id)));
    const sessions: SessionSummary[] = [];
    for (const row of rows) {
      if (sessions.length >= safeLimit) break;
      const rolloutPath = rolloutPaths.get(row.id) ?? "";
      if (!rolloutPath || (await this.rolloutLooksLikeSubagent(rolloutPath))) {
        continue;
      }
      sessions.push({
        id: row.id,
        title: row.thread_name || row.id,
        preview: "",
        cwd: "",
        rolloutPath,
        createdAt: 0,
        updatedAt: row.updated_at ? Date.parse(row.updated_at) : 0,
        status: "unknown" as const
      });
    }
    return sessions;
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
        const match = entry.name.match(rolloutThreadIdPattern);
        const id = match?.[1];
        if (id && ids.has(id)) {
          paths.set(id, fullPath);
        }
      }
    }

    await visit(root);
    return paths;
  }

  private boundedLimit(limit: number): number {
    return Math.max(1, Math.min(1_000, Math.floor(Number(limit)) || 100));
  }

  private isVisibleThread(row: Pick<ThreadRow, "source" | "threadSource">): boolean {
    return !this.isSubagentSource(row.source) && !this.isSubagentSource(row.threadSource);
  }

  private isSubagentSource(source: unknown): boolean {
    if (source == null) return false;
    if (typeof source === "object") {
      return this.objectHasSubagentMarker(source);
    }
    const value = String(source).trim();
    if (!value) return false;
    const lower = value.toLowerCase();
    if (lower === "subagent" || lower.startsWith("subagent:") || lower.includes('"subagent"')) {
      return true;
    }
    try {
      return this.objectHasSubagentMarker(JSON.parse(value));
    } catch {
      return lower.includes("subagent");
    }
  }

  private objectHasSubagentMarker(value: unknown): boolean {
    if (!value || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(record, "subagent")) return true;
    return Object.values(record).some((child) => this.objectHasSubagentMarker(child));
  }

  private async rolloutLooksLikeSubagent(path: string): Promise<boolean> {
    let handle;
    try {
      handle = await open(path, "r");
      const buffer = Buffer.alloc(256 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const header = buffer.subarray(0, bytesRead).toString("utf8");
      return /"thread_source"\s*:\s*"subagent"/.test(header) || /"source"\s*:\s*\{[\s\S]{0,4096}"subagent"\s*:/.test(header);
    } catch {
      return false;
    } finally {
      await handle?.close();
    }
  }

  private latestMessages(lines: string[], messageLimit: number): SessionMessage[] {
    const limit = Math.max(1, Math.min(maxMessageLimit, Math.floor(messageLimit) || defaultMessageLimit));
    const messages: SessionMessage[] = [];
    for (let index = lines.length - 1; index >= 0 && messages.length < limit; index -= 1) {
      const message = this.toMessage(lines[index], index);
      if (message) {
        messages.push(message);
      }
    }
    return messages.reverse();
  }

  private readRuntimeState(lines: string[]): Pick<SessionSummary, "status" | "activeTurnId"> {
    let activeTurnId: string | undefined;
    for (const line of lines) {
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
