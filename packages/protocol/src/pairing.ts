import { toBase64Url, utf8 } from "./encoding.js";
import type { PairingUriPayload } from "./types.js";

export function createPairingSecret(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

export function encodePairingUri(payload: PairingUriPayload): string {
  const body = toBase64Url(utf8(JSON.stringify(payload)));
  return `codexrc://pair/${body}`;
}

export function decodePairingUri(uri: string): PairingUriPayload {
  const prefix = "codexrc://pair/";
  if (!uri.startsWith(prefix)) {
    throw new Error("Invalid Codex Remote Console pairing URI.");
  }
  const raw = Buffer.from(uri.slice(prefix.length), "base64url").toString("utf8");
  return JSON.parse(raw) as PairingUriPayload;
}
