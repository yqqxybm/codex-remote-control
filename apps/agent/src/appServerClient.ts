import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export interface UserTextInput {
  type: "text";
  text: string;
}

export class AppServerClient {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  async start(): Promise<void> {
    if (this.child) return;
    this.child = spawn("codex", ["app-server", "proxy"], { stdio: "pipe" });
    this.child.on("exit", (code) => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error(`codex app-server proxy exited with code ${code ?? "unknown"}`));
      }
      this.pending.clear();
      this.child = undefined;
    });
    const rl = createInterface({ input: this.child.stdout });
    rl.on("line", (line) => this.onLine(line));
    await this.request("initialize", {
      clientInfo: { name: "codex-remote-console", version: "0.1.0" },
      capabilities: { experimentalApi: true }
    });
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
      this.pending.set(id, { resolve, reject });
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
    if (message.error) {
      pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      return;
    }
    pending.resolve(message.result);
  }
}
