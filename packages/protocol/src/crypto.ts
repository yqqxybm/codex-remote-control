import {
  concatBytes,
  fromBase64Url,
  jsonBytes,
  parseJsonBytes,
  toBase64Url,
  utf8
} from "./encoding.js";
import type {
  AppMessage,
  DeviceKeyPair,
  EncryptedFrame,
  PairingPayload,
  PairingRequestFrame
} from "./types.js";

const curve = "P-256";
const context = "codex-remote-console-v1";

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function requireCrypto(): Crypto {
  if (!globalThis.crypto?.subtle) {
    throw new Error("WebCrypto is required. Use Node.js 20+ or a modern browser runtime.");
  }
  return globalThis.crypto;
}

export async function generateDeviceKeyPair(): Promise<DeviceKeyPair> {
  const subtle = requireCrypto().subtle;
  const pair = await subtle.generateKey({ name: "ECDH", namedCurve: curve }, true, ["deriveBits"]);
  if (!("publicKey" in pair) || !("privateKey" in pair)) {
    throw new Error("Failed to generate ECDH key pair.");
  }
  const publicKey = new Uint8Array(await subtle.exportKey("spki", pair.publicKey));
  const privateKeyJwk = await subtle.exportKey("jwk", pair.privateKey);
  return {
    publicKeyB64: toBase64Url(publicKey),
    privateKeyJwk
  };
}

export async function importPrivateKey(privateKeyJwk: JsonWebKey): Promise<CryptoKey> {
  return requireCrypto().subtle.importKey("jwk", privateKeyJwk, { name: "ECDH", namedCurve: curve }, false, [
    "deriveBits"
  ]);
}

export async function importPublicKey(publicKeyB64: string): Promise<CryptoKey> {
  return requireCrypto().subtle.importKey(
    "spki",
    arrayBuffer(fromBase64Url(publicKeyB64)),
    { name: "ECDH", namedCurve: curve },
    false,
    []
  );
}

async function deriveAesKey(args: {
  privateKeyJwk: JsonWebKey;
  peerPublicKeyB64: string;
  salt: Uint8Array;
  from: string;
  to: string;
  seq: number;
}): Promise<CryptoKey> {
  const subtle = requireCrypto().subtle;
  const privateKey = await importPrivateKey(args.privateKeyJwk);
  const peerPublicKey = await importPublicKey(args.peerPublicKeyB64);
  const shared = new Uint8Array(
    await subtle.deriveBits({ name: "ECDH", public: peerPublicKey }, privateKey, 256)
  );
  const material = concatBytes(
    utf8(context),
    utf8(`${args.from}:${args.to}:${args.seq}`),
    args.salt,
    shared
  );
  const digest = await subtle.digest("SHA-256", arrayBuffer(material));
  return subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function aad(from: string, to: string, seq: number): Uint8Array {
  return utf8(`${context}:${from}:${to}:${seq}`);
}

export async function sealMessage(args: {
  from: string;
  to: string;
  seq: number;
  privateKeyJwk: JsonWebKey;
  peerPublicKeyB64: string;
  message: AppMessage;
}): Promise<EncryptedFrame> {
  const salt = new Uint8Array(16);
  const nonce = new Uint8Array(12);
  const crypto = requireCrypto();
  crypto.getRandomValues(salt);
  crypto.getRandomValues(nonce);
  const key = await deriveAesKey({ ...args, salt });
  const payload = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: arrayBuffer(nonce),
      additionalData: arrayBuffer(aad(args.from, args.to, args.seq))
    },
    key,
    arrayBuffer(jsonBytes(args.message))
  );
  return {
    kind: "encrypted",
    version: 1,
    from: args.from,
    to: args.to,
    seq: args.seq,
    salt: toBase64Url(salt),
    nonce: toBase64Url(nonce),
    payload: toBase64Url(payload)
  };
}

export async function openMessage(args: {
  frame: EncryptedFrame;
  privateKeyJwk: JsonWebKey;
  peerPublicKeyB64: string;
}): Promise<AppMessage> {
  const salt = fromBase64Url(args.frame.salt);
  const nonce = fromBase64Url(args.frame.nonce);
  const key = await deriveAesKey({
    privateKeyJwk: args.privateKeyJwk,
    peerPublicKeyB64: args.peerPublicKeyB64,
    salt,
    from: args.frame.from,
    to: args.frame.to,
    seq: args.frame.seq
  });
  const plaintext = await requireCrypto().subtle.decrypt(
    {
      name: "AES-GCM",
      iv: arrayBuffer(nonce),
      additionalData: arrayBuffer(aad(args.frame.from, args.frame.to, args.frame.seq))
    },
    key,
    arrayBuffer(fromBase64Url(args.frame.payload))
  );
  return parseJsonBytes<AppMessage>(new Uint8Array(plaintext));
}

export async function sealPairingRequest(args: {
  from: string;
  to: string;
  seq: number;
  androidPublicKeyB64: string;
  androidPrivateKeyJwk: JsonWebKey;
  agentPublicKeyB64: string;
  payload: PairingPayload;
}): Promise<PairingRequestFrame> {
  const message = {
    type: "event" as const,
    topic: "pairing.request",
    body: args.payload
  };
  const encrypted = await sealMessage({
    from: args.from,
    to: args.to,
    seq: args.seq,
    privateKeyJwk: args.androidPrivateKeyJwk,
    peerPublicKeyB64: args.agentPublicKeyB64,
    message
  });
  return {
    kind: "pairing_request",
    version: 1,
    from: args.from,
    to: args.to,
    seq: args.seq,
    androidPublicKeyB64: args.androidPublicKeyB64,
    salt: encrypted.salt,
    nonce: encrypted.nonce,
    payload: encrypted.payload
  };
}

export async function openPairingRequest(args: {
  frame: PairingRequestFrame;
  agentPrivateKeyJwk: JsonWebKey;
}): Promise<PairingPayload> {
  const message = await openMessage({
    frame: {
      kind: "encrypted",
      version: 1,
      from: args.frame.from,
      to: args.frame.to,
      seq: args.frame.seq,
      salt: args.frame.salt,
      nonce: args.frame.nonce,
      payload: args.frame.payload
    },
    privateKeyJwk: args.agentPrivateKeyJwk,
    peerPublicKeyB64: args.frame.androidPublicKeyB64
  });
  if (message.type !== "event" || message.topic !== "pairing.request") {
    throw new Error("Unexpected pairing payload.");
  }
  return message.body as PairingPayload;
}
