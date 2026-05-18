import { spawn } from "node:child_process";
import WebSocket from "ws";
import {
  generateDeviceKeyPair,
  openMessage,
  sealMessage,
  type EncryptedFrame,
  type RelayFrame
} from "../packages/protocol/src/index.js";

const port = 19000 + Math.floor(Math.random() * 1000);
const relay = spawn(process.execPath, ["--import", "tsx", "apps/relay/src/index.ts"], {
  cwd: new URL("..", import.meta.url).pathname,
  env: {
    ...process.env,
    CRC_RELAY_HOST: "127.0.0.1",
    CRC_RELAY_PORT: String(port),
    CRC_RELAY_ACCESS_TOKEN: "smoke"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function connect(deviceId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.once("open", () => {
      ws.send(
        JSON.stringify({
          kind: "hello",
          deviceId,
          deviceName: deviceId,
          role: deviceId.startsWith("android") ? "android" : "agent",
          accessToken: "smoke"
        })
      );
      resolve(ws);
    });
    ws.once("error", reject);
  });
}

async function main(): Promise<void> {
  await wait(500);
  const androidKeys = await generateDeviceKeyPair();
  const agentKeys = await generateDeviceKeyPair();
  const android = await connect("android-smoke");
  const agent = await connect("agent-smoke");

  const received = new Promise<EncryptedFrame>((resolve) => {
    agent.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as RelayFrame;
      if (frame.kind === "encrypted") resolve(frame);
    });
  });

  const envelope = await sealMessage({
    from: "android-smoke",
    to: "agent-smoke",
    seq: 1,
    privateKeyJwk: androidKeys.privateKeyJwk,
    peerPublicKeyB64: agentKeys.publicKeyB64,
    message: { type: "rpc_request", requestId: "smoke", method: "ping" }
  });
  android.send(JSON.stringify(envelope));

  const forwarded = await Promise.race([
    received,
    wait(2000).then(() => {
      throw new Error("timed out waiting for relay forward");
    })
  ]);
  const opened = await openMessage({
    frame: forwarded,
    privateKeyJwk: agentKeys.privateKeyJwk,
    peerPublicKeyB64: androidKeys.publicKeyB64
  });
  if (opened.type !== "rpc_request" || opened.method !== "ping") {
    throw new Error(`unexpected payload ${JSON.stringify(opened)}`);
  }
  android.close();
  agent.close();
  console.log("smoke ok: relay forwarded an encrypted message");
}

main()
  .finally(() => relay.kill())
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
