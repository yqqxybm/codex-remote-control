import { describe, expect, it } from "vitest";
import {
  generateDeviceKeyPair,
  openMessage,
  openPairingRequest,
  sealMessage,
  sealPairingRequest
} from "../packages/protocol/src/index.js";

describe("protocol crypto", () => {
  it("round-trips encrypted app messages", async () => {
    const android = await generateDeviceKeyPair();
    const agent = await generateDeviceKeyPair();
    const frame = await sealMessage({
      from: "android",
      to: "agent",
      seq: 1,
      privateKeyJwk: android.privateKeyJwk,
      peerPublicKeyB64: agent.publicKeyB64,
      message: {
        type: "rpc_request",
        requestId: "r1",
        method: "ping"
      }
    });
    expect(frame.payload).not.toContain("ping");
    const opened = await openMessage({
      frame,
      privateKeyJwk: agent.privateKeyJwk,
      peerPublicKeyB64: android.publicKeyB64
    });
    expect(opened).toEqual({ type: "rpc_request", requestId: "r1", method: "ping" });
  });

  it("round-trips pairing requests", async () => {
    const android = await generateDeviceKeyPair();
    const agent = await generateDeviceKeyPair();
    const frame = await sealPairingRequest({
      from: "android",
      to: "agent",
      seq: 1,
      androidPublicKeyB64: android.publicKeyB64,
      androidPrivateKeyJwk: android.privateKeyJwk,
      agentPublicKeyB64: agent.publicKeyB64,
      payload: {
        androidName: "Pixel",
        pairingSecret: "secret"
      }
    });
    const opened = await openPairingRequest({ frame, agentPrivateKeyJwk: agent.privateKeyJwk });
    expect(opened).toEqual({ androidName: "Pixel", pairingSecret: "secret" });
  });
});
