const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8(value: string): Uint8Array {
  return encoder.encode(value);
}

export function fromUtf8(value: Uint8Array): string {
  return decoder.decode(value);
}

export function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function toBase64Url(value: Uint8Array | ArrayBuffer): string {
  return Buffer.from(value instanceof Uint8Array ? value : new Uint8Array(value)).toString("base64url");
}

export function fromBase64Url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

export function jsonBytes(value: unknown): Uint8Array {
  return utf8(JSON.stringify(value));
}

export function parseJsonBytes<T>(value: Uint8Array): T {
  return JSON.parse(fromUtf8(value)) as T;
}

export function randomId(prefix: string): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `${prefix}_${toBase64Url(bytes)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
