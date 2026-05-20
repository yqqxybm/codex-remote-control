import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { RpcRequest } from "../packages/protocol/src/index.js";
import { AppServerClient } from "../apps/agent/src/appServerClient.js";
import { CodexStore } from "../apps/agent/src/codexStore.js";
import { loadConfig, type LoadedConfig } from "../apps/agent/src/config.js";
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

describe("agent config", () => {
  it("keeps a pending pairing URI stable until the Android device pairs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crc-config-"));
    try {
      const configPath = join(dir, "agent.json");
      vi.stubEnv("CRC_AGENT_CONFIG", configPath);
      vi.stubEnv("CRC_DEVICE_NAME", "Agent Test");
      vi.stubEnv("CRC_RELAY_URL", "wss://relay.example/ws");
      vi.stubEnv("CRC_RELAY_ACCESS_TOKEN", "token");
      vi.stubEnv("CRC_CODEX_HOME", join(dir, "codex-home"));

      const first = await loadConfig();
      const second = await loadConfig();

      expect(first.pairingSecret).toBeTruthy();
      expect(second.pairingSecret).toBe(first.pairingSecret);
      expect(second.pairingUri).toBe(first.pairingUri);

      const saved = JSON.parse(await readFile(configPath, "utf8")) as LoadedConfig["config"];
      expect(saved.pairingSecret).toBe(first.pairingSecret);

      saved.trustedAndroid = {
        deviceId: "android-test",
        deviceName: "Android Test",
        publicKeyB64: "public"
      };
      await writeFile(configPath, `${JSON.stringify(saved, null, 2)}\n`);

      const trusted = await loadConfig();
      const trustedSaved = JSON.parse(await readFile(configPath, "utf8")) as LoadedConfig["config"];
      expect(trusted.pairingSecret).toBeUndefined();
      expect(trusted.pairingUri).toBeUndefined();
      expect(trustedSaved.pairingSecret).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

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

describe("AppServerClient failure handling", () => {
  it("returns a clear error when the app-server binary cannot start", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crc-app-server-"));
    try {
      const client = new AppServerClient(join(dir, "missing-codex"), 200);
      await expect(client.sendMessage("thread-1", "hello")).rejects.toThrow(/failed to start codex app-server/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("times out when app-server does not answer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crc-app-server-"));
    try {
      const bin = join(dir, "codex-hangs.js");
      await writeFile(bin, "#!/usr/bin/env node\nsetTimeout(() => {}, 10_000);\n", { mode: 0o755 });
      const client = new AppServerClient(bin, 50);
      await expect(client.sendMessage("thread-1", "hello")).rejects.toThrow(/timed out.*initialize/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("shares initialization across concurrent write requests", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crc-app-server-"));
    try {
      const bin = join(dir, "codex-delayed-init.js");
      await writeFile(
        bin,
        [
          "#!/usr/bin/env node",
          'const readline = require("node:readline");',
          "let initialized = false;",
          "const rl = readline.createInterface({ input: process.stdin });",
          'rl.on("line", (line) => {',
          "  const msg = JSON.parse(line);",
          '  if (msg.method === "initialize") {',
          "    setTimeout(() => {",
          "      initialized = true;",
          '      process.stdout.write(`${JSON.stringify({ id: msg.id, result: {} })}\\n`);',
          "    }, 100);",
          "    return;",
          "  }",
          "  if (!initialized) {",
          '    process.stdout.write(`${JSON.stringify({ id: msg.id, error: { message: "request before initialize" } })}\\n`);',
          "    return;",
          "  }",
          "  process.stdout.write(`${JSON.stringify({ id: msg.id, result: { method: msg.method } })}\\n`);",
          "});",
          ""
        ].join("\n"),
        { mode: 0o755 }
      );
      const client = new AppServerClient(bin, 2_000);
      await expect(Promise.all([client.sendMessage("thread-1", "first"), client.sendMessage("thread-2", "second")]))
        .resolves.toEqual([{ method: "turn/start" }, { method: "turn/start" }]);
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
