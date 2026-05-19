import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RpcRequest } from "../packages/protocol/src/index.js";
import { CodexStore } from "../apps/agent/src/codexStore.js";
import type { LoadedConfig } from "../apps/agent/src/config.js";
import { reserveWriteRequest } from "../apps/agent/src/replayGuard.js";

function loadedConfig(path: string): LoadedConfig {
  return {
    path,
    config: {
      deviceId: "agent-test",
      deviceName: "Agent Test",
      relayUrl: "ws://127.0.0.1:8787/ws",
      codexHome: "/tmp/codex-test",
      writeMode: "app-server",
      keyPair: {
        publicKeyB64: "public",
        privateKeyJwk: {} as JsonWebKey
      }
    }
  };
}

describe("agent replay guard", () => {
  it("persists and rejects duplicate write request ids", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crc-agent-"));
    try {
      const configPath = join(dir, "agent.json");
      const loaded = loadedConfig(configPath);
      const request: RpcRequest = {
        type: "rpc_request",
        requestId: "write-1",
        createdAtMs: 1_000,
        method: "sessions.send",
        params: { sessionId: "s1", text: "hello" }
      };

      await reserveWriteRequest(loaded, request, 1_000);
      await expect(reserveWriteRequest(loaded, request, 1_000)).rejects.toThrow(/Duplicate/);

      const saved = JSON.parse(await readFile(configPath, "utf8")) as LoadedConfig["config"];
      expect(saved.recentWriteRequestIds).toEqual([{ requestId: "write-1", createdAtMs: 1_000 }]);

      await expect(reserveWriteRequest({ path: configPath, config: saved }, request, 1_000)).rejects.toThrow(
        /Duplicate/
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects stale write requests", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crc-agent-"));
    try {
      const request: RpcRequest = {
        type: "rpc_request",
        requestId: "stale",
        createdAtMs: 1_000,
        method: "turn.interrupt",
        params: { sessionId: "s1", turnId: "t1" }
      };
      await expect(reserveWriteRequest(loadedConfig(join(dir, "agent.json")), request, 1_000 + 600_000)).rejects.toThrow(
        /replay window/
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("CodexStore fallback session index", () => {
  it("resolves rollout paths and active turn state without sqlite", async () => {
    const home = await mkdtemp(join(tmpdir(), "crc-store-"));
    try {
      const id = "019e3f5d-666c-74c1-bf7c-32105460a8d5";
      const sessionDir = join(home, "sessions", "2026", "05", "19");
      const rolloutPath = join(sessionDir, `rollout-2026-05-19T08-32-26-${id}.jsonl`);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        join(home, "session_index.jsonl"),
        `${JSON.stringify({ id, thread_name: "Active thread", updated_at: "2026-05-19T08:32:26.000Z" })}\n`
      );
      await writeFile(
        rolloutPath,
        [
          JSON.stringify({ timestamp: "2026-05-19T08:32:26.000Z", type: "session_meta", payload: { id } }),
          JSON.stringify({ timestamp: "2026-05-19T08:32:26.100Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } }),
          JSON.stringify({ timestamp: "2026-05-19T08:32:26.200Z", type: "event_msg", payload: { type: "user_message", message: "hi" } }),
          JSON.stringify({ timestamp: "2026-05-19T08:32:26.300Z", type: "event_msg", payload: { type: "agent_message", message: "second" } }),
          JSON.stringify({ timestamp: "2026-05-19T08:32:26.400Z", type: "event_msg", payload: { type: "agent_message", message: "third" } })
        ].join("\n")
      );

      const store = new CodexStore(home);
      const sessions = await store.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].rolloutPath).toBe(rolloutPath);

      const read = await store.readSession(id);
      expect(read.session.status).toBe("running");
      expect(read.session.activeTurnId).toBe("turn-1");
      expect(read.messages[0]).toMatchObject({ role: "user", text: "hi" });

      const limited = await store.readSession(id, 2);
      expect(limited.messages.map((message) => message.text)).toEqual(["second", "third"]);
      expect(limited.session.activeTurnId).toBe("turn-1");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
