import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const defaultRequestTimeoutMs = Math.max(
  1000,
  Number.parseInt(process.env.CRC_APP_SERVER_REQUEST_TIMEOUT_MS ?? "60000", 10) || 60000
);

export interface UserTextInput {
  type: "text";
  text: string;
}

interface PendingRequest {
  timer: ReturnType<typeof setTimeout>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class AppServerClient {
  private child?: ChildProcessWithoutNullStreams;
  private startPromise?: Promise<void>;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();

  constructor(
    private readonly codexBin = resolveCodexBin(),
    private readonly requestTimeoutMs = defaultRequestTimeoutMs
  ) {}

  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (this.child) return;
    this.child = spawn(this.codexBin, ["app-server", "--listen", "stdio://"], { stdio: "pipe" });
    this.child.on("error", (error) => {
      this.rejectAll(new Error(`failed to start codex app-server: ${error.message}`));
      this.startPromise = undefined;
      this.child = undefined;
    });
    this.child.on("exit", (code) => {
      this.rejectAll(new Error(`codex app-server exited with code ${code ?? "unknown"}`));
      this.startPromise = undefined;
      this.child = undefined;
    });
    const rl = createInterface({ input: this.child.stdout });
    rl.on("line", (line) => this.onLine(line));
    this.startPromise = this.request("initialize", {
      clientInfo: { name: "codex-remote-console", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false }
    })
      .then(() => {
        this.startPromise = undefined;
      })
      .catch((error) => {
        this.child?.kill();
        this.startPromise = undefined;
        this.child = undefined;
        throw error;
      });
    return this.startPromise;
  }

  async sendMessage(threadId: string, text: string): Promise<unknown> {
    await this.start();
    await this.request("thread/resume", { threadId, excludeTurns: true });
    return this.request("turn/start", {
      threadId,
      input: [{ type: "text", text } satisfies UserTextInput]
    });
  }

  async steer(threadId: string, expectedTurnId: string, text: string): Promise<unknown> {
    await this.start();
    return this.request("turn/steer", {
      threadId,
      expectedTurnId,
      input: [{ type: "text", text } satisfies UserTextInput]
    });
  }

  async interrupt(threadId: string, turnId: string): Promise<unknown> {
    await this.start();
    return this.request("turn/interrupt", { threadId, turnId });
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (!this.child) {
      throw new Error("app-server proxy is not started");
    }
    const id = this.nextId++;
    const message = { id, method, params };
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(`codex app-server request timed out: ${method}`);
        this.pending.delete(id);
        reject(error);
        this.child?.kill();
        this.startPromise = undefined;
        this.child = undefined;
        this.rejectAll(error);
      }, this.requestTimeoutMs);
      this.pending.set(id, { timer, resolve, reject });
    });
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
    return promise;
  }

  private onLine(line: string): void {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message.id !== "number") {
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      return;
    }
    pending.resolve(message.result);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function resolveCodexBin(): string {
  const candidates = [
    process.env.CRC_CODEX_BIN,
    join(homedir(), ".codex/packages/standalone/current/codex"),
    "/Applications/Codex.app/Contents/Resources/codex",
    "codex"
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    if (candidate === "codex" || existsSync(candidate)) {
      return candidate;
    }
  }
  return "codex";
}
