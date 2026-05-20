import WebSocket from "ws";
import {
  openMessage,
  openPairingRequest,
  sealMessage,
  type AppMessage,
  type EncryptedFrame,
  type PairingRequestFrame,
  type RelayFrame,
  type RpcRequest,
  type RpcResponse
} from "@crc/protocol";
import { AppServerClient } from "./appServerClient.js";
import { loadConfig, saveConfig, type LoadedConfig } from "./config.js";
import { CodexStore } from "./codexStore.js";
import { reserveWriteRequest } from "./replayGuard.js";

let seq = 1;
const reconnectMs = Math.max(1000, Number.parseInt(process.env.CRC_AGENT_RECONNECT_MS ?? "3000", 10) || 3000);

function isRpcRequest(message: AppMessage): message is RpcRequest {
  return message.type === "rpc_request";
}

function response(requestId: string, result: unknown): RpcResponse {
  return { type: "rpc_response", requestId, ok: true, result };
}

function errorResponse(requestId: string, error: unknown): RpcResponse {
  return {
    type: "rpc_response",
    requestId,
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  };
}

function pairingAck(config: LoadedConfig["config"]): AppMessage {
  return {
    type: "event",
    topic: "pairing.ack",
    body: {
      agentId: config.deviceId,
      agentName: config.deviceName
    }
  };
}

async function sendEncrypted(
  ws: WebSocket,
  loaded: LoadedConfig,
  peer: { deviceId: string; publicKeyB64: string },
  message: AppMessage
): Promise<void> {
  const envelope = await sealMessage({
    from: loaded.config.deviceId,
    to: peer.deviceId,
    seq: seq++,
    privateKeyJwk: loaded.config.keyPair.privateKeyJwk,
    peerPublicKeyB64: peer.publicKeyB64,
    message
  });
  ws.send(JSON.stringify(envelope));
}

async function main(): Promise<void> {
  const loaded = await loadConfig();
  const { config } = loaded;
  const store = new CodexStore(config.codexHome);
  const appServer = new AppServerClient();

  if (loaded.pairingUri) {
    console.log("[agent] no Android device paired yet. Pairing URI:");
    console.log(loaded.pairingUri);
  }

  connectRelay(loaded, store, appServer);
}

function connectRelay(loaded: LoadedConfig, store: CodexStore, appServer: AppServerClient): void {
  const { config } = loaded;
  const ws = new WebSocket(config.relayUrl);
  ws.on("open", () => {
    ws.send(
      JSON.stringify({
        kind: "hello",
        deviceId: config.deviceId,
        deviceName: config.deviceName,
        role: "agent",
        accessToken: config.relayAccessToken
      })
    );
    console.log(`[agent] connected to relay as ${config.deviceName} (${config.deviceId})`);
  });

  let messageQueue = Promise.resolve();
  ws.on("message", (raw) => {
    messageQueue = messageQueue
      .then(async () => {
        let frame: RelayFrame;
        try {
          frame = JSON.parse(raw.toString()) as RelayFrame;
        } catch {
          return;
        }
        if (frame.kind === "pairing_request") {
          await handlePairing(loaded, ws, frame);
          return;
        }
        if (frame.kind === "encrypted") {
          await handleEncrypted(loaded, store, appServer, ws, frame);
        }
      })
      .catch((error) => {
        console.error("[agent] message handling failed", error);
      });
  });

  ws.on("error", (error) => {
    console.error(`[agent] relay connection error: ${error.message}`);
  });

  ws.on("close", () => {
    console.error(`[agent] relay connection closed; reconnecting in ${reconnectMs}ms`);
    setTimeout(() => connectRelay(loaded, store, appServer), reconnectMs);
  });
}

async function handlePairing(loaded: LoadedConfig, ws: WebSocket, frame: PairingRequestFrame): Promise<void> {
  const trustedAndroid = loaded.config.trustedAndroid;
  if (trustedAndroid) {
    if (frame.from === trustedAndroid.deviceId && frame.androidPublicKeyB64 === trustedAndroid.publicKeyB64) {
      await sendEncrypted(ws, loaded, trustedAndroid, pairingAck(loaded.config));
    }
    return;
  }
  if (!loaded.pairingSecret) {
    return;
  }
  const payload = await openPairingRequest({
    frame,
    agentPrivateKeyJwk: loaded.config.keyPair.privateKeyJwk
  });
  if (payload.pairingSecret !== loaded.pairingSecret) {
    throw new Error("Invalid pairing secret.");
  }
  loaded.config.trustedAndroid = {
    deviceId: frame.from,
    deviceName: payload.androidName,
    publicKeyB64: frame.androidPublicKeyB64
  };
  delete loaded.config.pairingSecret;
  delete loaded.pairingSecret;
  await saveConfig(loaded.path, loaded.config);
  console.log(`[agent] paired Android ${payload.androidName} (${frame.from})`);
  await sendEncrypted(ws, loaded, loaded.config.trustedAndroid, pairingAck(loaded.config));
}

async function handleEncrypted(
  loaded: LoadedConfig,
  store: CodexStore,
  appServer: AppServerClient,
  ws: WebSocket,
  frame: EncryptedFrame
): Promise<void> {
  const peer = loaded.config.trustedAndroid;
  if (!peer || frame.from !== peer.deviceId) {
    throw new Error("Encrypted message from untrusted peer.");
  }
  const message = await openMessage({
    frame,
    privateKeyJwk: loaded.config.keyPair.privateKeyJwk,
    peerPublicKeyB64: peer.publicKeyB64
  });
  if (!isRpcRequest(message)) {
    return;
  }

  let reply: RpcResponse;
  try {
    await reserveWriteRequest(loaded, message);
    reply = response(message.requestId, await handleRpc(message, store, appServer, loaded.config.writeMode));
  } catch (error) {
    reply = errorResponse(message.requestId, error);
  }
  await sendEncrypted(ws, loaded, peer, reply);
}

async function handleRpc(
  request: RpcRequest,
  store: CodexStore,
  appServer: AppServerClient,
  writeMode: "app-server" | "read-only"
): Promise<unknown> {
  switch (request.method) {
    case "ping":
      return { ok: true };
    case "sessions.list":
      return store.listSessions();
    case "sessions.read": {
      const { sessionId, messageLimit } = request.params as { sessionId: string; messageLimit?: number };
      return store.readSession(sessionId, messageLimit);
    }
    case "sessions.send": {
      if (writeMode !== "app-server") {
        throw new Error("Agent is running in read-only mode.");
      }
      const { sessionId, text, activeTurnId } = request.params as {
        sessionId: string;
        text: string;
        activeTurnId?: string;
      };
      if (activeTurnId) {
        return appServer.steer(sessionId, activeTurnId, text);
      }
      return appServer.sendMessage(sessionId, text);
    }
    case "turn.interrupt": {
      if (writeMode !== "app-server") {
        throw new Error("Agent is running in read-only mode.");
      }
      const { sessionId, turnId } = request.params as { sessionId: string; turnId: string };
      return appServer.interrupt(sessionId, turnId);
    }
  }
  throw new Error(`Unsupported RPC method: ${String((request as { method: string }).method)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
