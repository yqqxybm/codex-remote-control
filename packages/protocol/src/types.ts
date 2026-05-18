export type DeviceRole = "android" | "agent";

export interface DeviceKeyPair {
  publicKeyB64: string;
  privateKeyJwk: JsonWebKey;
}

export interface HelloFrame {
  kind: "hello";
  deviceId: string;
  deviceName: string;
  role: DeviceRole;
  accessToken?: string;
}

export interface DeliveryErrorFrame {
  kind: "delivery_error";
  to: string;
  from: string;
  message: string;
}

export interface EncryptedFrame {
  kind: "encrypted";
  version: 1;
  from: string;
  to: string;
  seq: number;
  salt: string;
  nonce: string;
  payload: string;
}

export interface PairingRequestFrame {
  kind: "pairing_request";
  version: 1;
  from: string;
  to: string;
  seq: number;
  androidPublicKeyB64: string;
  salt: string;
  nonce: string;
  payload: string;
}

export type RelayFrame = HelloFrame | DeliveryErrorFrame | EncryptedFrame | PairingRequestFrame;

export interface PairingPayload {
  pairingSecret: string;
  androidName: string;
}

export interface PairingUriPayload {
  relayUrl: string;
  relayAccessToken?: string;
  agentId: string;
  agentName: string;
  agentPublicKeyB64: string;
  pairingSecret: string;
}

export interface RpcRequest {
  type: "rpc_request";
  requestId: string;
  method: RpcMethod;
  params?: unknown;
}

export interface RpcResponse {
  type: "rpc_response";
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface EventMessage {
  type: "event";
  topic: string;
  body: unknown;
}

export type AppMessage = RpcRequest | RpcResponse | EventMessage;

export type RpcMethod =
  | "ping"
  | "sessions.list"
  | "sessions.read"
  | "sessions.send"
  | "turn.interrupt";

export interface SessionSummary {
  id: string;
  title: string;
  preview: string;
  cwd: string;
  rolloutPath: string;
  createdAt: number;
  updatedAt: number;
  status: "idle" | "running" | "unknown";
}

export interface SessionMessage {
  id: string;
  timestamp?: string;
  role: "user" | "assistant" | "tool" | "system" | "event" | "reasoning";
  text: string;
  name?: string;
}

export interface SessionReadResult {
  session: SessionSummary;
  messages: SessionMessage[];
}
