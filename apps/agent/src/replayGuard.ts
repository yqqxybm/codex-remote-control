import type { RpcRequest } from "@crc/protocol";
import { saveConfig, type LoadedConfig } from "./config.js";

const writeRequestWindowMs = 5 * 60 * 1000;
const maxRecentWriteRequests = 256;
const allowedFutureSkewMs = 60 * 1000;

function isWriteMethod(method: RpcRequest["method"]): boolean {
  return method === "sessions.send" || method === "turn.interrupt";
}

export async function reserveWriteRequest(
  loaded: LoadedConfig,
  request: RpcRequest,
  nowMs = Date.now()
): Promise<void> {
  if (!isWriteMethod(request.method)) return;

  if (typeof request.createdAtMs !== "number" || !Number.isFinite(request.createdAtMs)) {
    throw new Error("Write request is missing a valid creation timestamp.");
  }
  if (request.createdAtMs < nowMs - writeRequestWindowMs || request.createdAtMs > nowMs + allowedFutureSkewMs) {
    throw new Error("Write request is outside the accepted replay window.");
  }

  const recent = (loaded.config.recentWriteRequestIds ?? []).filter(
    (entry) => entry.createdAtMs >= nowMs - writeRequestWindowMs
  );
  if (recent.some((entry) => entry.requestId === request.requestId)) {
    throw new Error("Duplicate write request rejected.");
  }

  recent.push({ requestId: request.requestId, createdAtMs: request.createdAtMs });
  loaded.config.recentWriteRequestIds = recent.slice(-maxRecentWriteRequests);
  await saveConfig(loaded.path, loaded.config);
}
