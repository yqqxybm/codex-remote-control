import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { DeliveryErrorFrame, HelloFrame, RelayFrame } from "@crc/protocol";

const host = process.env.CRC_RELAY_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.CRC_RELAY_PORT ?? "8787", 10);
const accessToken = process.env.CRC_RELAY_ACCESS_TOKEN;
const allowUnauthenticated = process.env.CRC_RELAY_ALLOW_UNAUTHENTICATED === "1";
const helloTimeoutMs = Math.max(1000, Number.parseInt(process.env.CRC_RELAY_HELLO_TIMEOUT_MS ?? "5000", 10) || 5000);
const maxPayloadBytes = Math.max(
  1024,
  Number.parseInt(process.env.CRC_RELAY_MAX_PAYLOAD_BYTES ?? String(64 * 1024), 10) || 64 * 1024
);

if (!accessToken && !allowUnauthenticated) {
  console.error("[relay] CRC_RELAY_ACCESS_TOKEN is required unless CRC_RELAY_ALLOW_UNAUTHENTICATED=1.");
  process.exit(1);
}

interface Client {
  hello: HelloFrame;
  socket: WebSocket;
}

const clients = new Map<string, Client>();

const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, clients: clients.size }));
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: maxPayloadBytes });

function send(socket: WebSocket, frame: RelayFrame): void {
  socket.send(JSON.stringify(frame));
}

function deliveryError(socket: WebSocket, frame: RelayFrame, message: string): void {
  const error: DeliveryErrorFrame = {
    kind: "delivery_error",
    from: "relay",
    to: "from" in frame ? frame.from : "unknown",
    message
  };
  send(socket, error);
}

wss.on("connection", (socket) => {
  let registeredDeviceId: string | undefined;
  const helloTimer = setTimeout(() => {
    if (!registeredDeviceId) {
      socket.close(1008, "hello timeout");
    }
  }, helloTimeoutMs);

  socket.on("message", (raw) => {
    let frame: RelayFrame;
    try {
      frame = JSON.parse(raw.toString()) as RelayFrame;
    } catch {
      if (!registeredDeviceId) {
        socket.close(1008, "invalid json");
        return;
      }
      deliveryError(socket, { kind: "hello", deviceId: "unknown", deviceName: "unknown", role: "agent" }, "invalid json");
      return;
    }

    if (frame.kind === "hello") {
      clearTimeout(helloTimer);
      if (accessToken && frame.accessToken !== accessToken) {
        socket.close(1008, "invalid relay token");
        return;
      }
      const previous = clients.get(frame.deviceId);
      if (previous && previous.socket !== socket) {
        previous.socket.close(1008, "device reconnected");
      }
      registeredDeviceId = frame.deviceId;
      clients.set(frame.deviceId, { hello: frame, socket });
      console.log(`[relay] online ${frame.role} ${frame.deviceName} ${frame.deviceId}`);
      return;
    }

    if (!registeredDeviceId) {
      socket.close(1008, "hello required");
      return;
    }

    if ("from" in frame && frame.from !== registeredDeviceId) {
      socket.close(1008, "frame from mismatch");
      return;
    }

    const target = "to" in frame ? clients.get(frame.to) : undefined;
    if (!target || target.socket.readyState !== target.socket.OPEN) {
      deliveryError(socket, frame, `target offline: ${"to" in frame ? frame.to : "unknown"}`);
      return;
    }
    target.socket.send(raw.toString());
  });

  socket.on("close", () => {
    clearTimeout(helloTimer);
    if (registeredDeviceId && clients.get(registeredDeviceId)?.socket === socket) {
      clients.delete(registeredDeviceId);
      console.log(`[relay] offline ${registeredDeviceId}`);
    }
  });
});

server.listen(port, host, () => {
  console.log(`[relay] listening on ${host}:${port}`);
});
