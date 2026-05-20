import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodePairingUri,
  generateDeviceKeyPair,
  openMessage,
  sealMessage,
  sealPairingRequest,
  type AppMessage,
  type EncryptedFrame,
  type PairingUriPayload,
  type RelayFrame,
  type RpcResponse
} from "../packages/protocol/src/index.js";

const repoRoot = new URL("..", import.meta.url).pathname;
const children: ChildProcessWithoutNullStreams[] = [];
const processOutput = new WeakMap<ChildProcessWithoutNullStreams, string>();

afterEach(() => {
  for (const child of children.splice(0)) {
    child.kill();
  }
});

function randomPort(): number {
  return 20000 + Math.floor(Math.random() * 20000);
}

function spawnNode(args: string[], env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: "pipe"
  });
  processOutput.set(child, "");
  const appendOutput = (chunk: Buffer) => {
    processOutput.set(child, `${processOutput.get(child) ?? ""}${chunk.toString()}`);
  };
  child.stdout.on("data", appendOutput);
  child.stderr.on("data", appendOutput);
  children.push(child);
  return child;
}

function waitForOutput(child: ChildProcessWithoutNullStreams, pattern: RegExp, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const existing = processOutput.get(child) ?? "";
    const existingMatch = existing.match(pattern);
    if (existingMatch) {
      resolve(existingMatch[0]);
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for output ${pattern}; saw ${processOutput.get(child) ?? ""}`));
    }, timeoutMs);
    const onData = (_chunk: Buffer) => {
      const output = processOutput.get(child) ?? "";
      const match = output.match(pattern);
      if (match) {
        cleanup();
        resolve(match[0]);
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`process exited with code ${code}; saw ${processOutput.get(child) ?? ""}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", onExit);
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs = 1500): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("process stayed running"));
    }, timeoutMs);
    const onExit = (code: number | null) => {
      cleanup();
      resolve(code);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
    };
    child.once("exit", onExit);
  });
}

function connectAndroid(url: string, accessToken: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => {
      ws.send(
        JSON.stringify({
          kind: "hello",
          deviceId: "android-integration",
          deviceName: "Android Integration",
          role: "android",
          accessToken
        })
      );
      resolve(ws);
    });
    ws.once("error", reject);
  });
}

async function nextEncryptedMessage(
  ws: WebSocket,
  pairing: PairingUriPayload,
  androidPrivateKeyJwk: JsonWebKey,
  timeoutMs = 5000
): Promise<AppMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for encrypted Android message"));
    }, timeoutMs);
    const onMessage = async (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString()) as RelayFrame;
      if (frame.kind !== "encrypted") return;
      cleanup();
      try {
        resolve(
          await openMessage({
            frame: frame as EncryptedFrame,
            privateKeyJwk: androidPrivateKeyJwk,
            peerPublicKeyB64: pairing.agentPublicKeyB64
          })
        );
      } catch (error) {
        reject(error);
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", onMessage);
    };
    ws.on("message", onMessage);
  });
}

describe("relay startup safety", () => {
  it("refuses to start without an access token unless unauthenticated mode is explicit", async () => {
    const relay = spawnNode(["--import", "tsx", "apps/relay/src/index.ts"], {
      CRC_RELAY_HOST: "127.0.0.1",
      CRC_RELAY_PORT: String(randomPort()),
      CRC_RELAY_ACCESS_TOKEN: ""
    });

    await expect(waitForExit(relay)).resolves.toBe(1);
  });
});

describe("agent pairing flow", () => {
  it("acknowledges pairing before Android sends reads and rejects unknown RPC methods", async () => {
    const port = randomPort();
    const relayUrl = `ws://127.0.0.1:${port}/ws`;
    const token = "integration-token";
    const home = await mkdtemp(join(tmpdir(), "crc-flow-"));
    const codexHome = join(home, "codex-home");
    await mkdir(codexHome, { recursive: true });
    await writeFile(join(codexHome, "session_index.jsonl"), "");

    const relay = spawnNode(["--import", "tsx", "apps/relay/src/index.ts"], {
      CRC_RELAY_HOST: "127.0.0.1",
      CRC_RELAY_PORT: String(port),
      CRC_RELAY_ACCESS_TOKEN: token
    });
    await waitForOutput(relay, /listening/);

    const agent = spawnNode(["--import", "tsx", "apps/agent/src/index.ts"], {
      CRC_AGENT_CONFIG: join(home, "agent.json"),
      CRC_CODEX_HOME: codexHome,
      CRC_DEVICE_ID: "agent-integration",
      CRC_DEVICE_NAME: "Agent Integration",
      CRC_RELAY_URL: relayUrl,
      CRC_RELAY_ACCESS_TOKEN: token,
      CRC_WRITE_MODE: "read-only"
    });
    const pairingUri = await waitForOutput(agent, /codexrc:\/\/pair\/[A-Za-z0-9_-]+/);
    await waitForOutput(agent, /connected to relay/);

    const pairing = decodePairingUri(pairingUri);
    const androidKeys = await generateDeviceKeyPair();
    const android = await connectAndroid(relayUrl, token);

    const pairingRequest = await sealPairingRequest({
      from: "android-integration",
      to: pairing.agentId,
      seq: 1,
      androidPublicKeyB64: androidKeys.publicKeyB64,
      androidPrivateKeyJwk: androidKeys.privateKeyJwk,
      agentPublicKeyB64: pairing.agentPublicKeyB64,
      payload: {
        pairingSecret: pairing.pairingSecret,
        androidName: "Android Integration"
      }
    });
    android.send(JSON.stringify(pairingRequest));

    await expect(nextEncryptedMessage(android, pairing, androidKeys.privateKeyJwk)).resolves.toMatchObject({
      type: "event",
      topic: "pairing.ack"
    });

    const listRequest = await sealMessage({
      from: "android-integration",
      to: pairing.agentId,
      seq: 2,
      privateKeyJwk: androidKeys.privateKeyJwk,
      peerPublicKeyB64: pairing.agentPublicKeyB64,
      message: { type: "rpc_request", requestId: "list-1", method: "sessions.list" }
    });
    android.send(JSON.stringify(listRequest));
    await expect(nextEncryptedMessage(android, pairing, androidKeys.privateKeyJwk)).resolves.toMatchObject({
      type: "rpc_response",
      requestId: "list-1",
      ok: true,
      result: []
    } satisfies Partial<RpcResponse>);

    const unknownRequest = await sealMessage({
      from: "android-integration",
      to: pairing.agentId,
      seq: 3,
      privateKeyJwk: androidKeys.privateKeyJwk,
      peerPublicKeyB64: pairing.agentPublicKeyB64,
      message: { type: "rpc_request", requestId: "unknown-1", method: "sessions.delete" as any }
    });
    android.send(JSON.stringify(unknownRequest));
    await expect(nextEncryptedMessage(android, pairing, androidKeys.privateKeyJwk)).resolves.toMatchObject({
      type: "rpc_response",
      requestId: "unknown-1",
      ok: false,
      error: expect.stringMatching(/Unsupported RPC method/)
    } satisfies Partial<RpcResponse>);

    android.close();
  }, 15000);
});
