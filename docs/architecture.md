# Architecture

## Product Boundary

This is not a general remote control system. It is a fixed-device Codex mobile mirror:

- list Codex sessions from two Macs,
- view a session message stream,
- send a simple message,
- append guidance to a running turn,
- stop a running turn.

## Trust Model

The Android phone and each Mac are trusted endpoints. `user-owned relay server` is trusted for availability but not for confidentiality. The relay receives device ids and envelope metadata, but not plaintext session content.

Remote access uses `wss://your-domain.example/codex-remote/ws` on the existing `user-owned relay server` Nginx TLS site. The relay process itself binds only to `127.0.0.1:8787`, so there is no separate public relay port to manage.

## Protocol

All application payloads are encrypted with ECDH P-256 and AES-256-GCM:

1. Each endpoint has a device key pair.
2. Pairing exchanges public keys.
3. For each envelope, the sender derives a shared secret with the recipient public key.
4. The shared secret, salt, and context string derive a per-message AES key.
5. The relay forwards the encrypted envelope unchanged.

Write RPCs also carry a client creation timestamp. The Mac agent accepts write
requests only inside a short replay window and persists recent write request ids
before executing them. This keeps a relay replay from duplicating mobile write
actions.

## Mac Agent Boundary

The Mac agent reads Codex sessions from local disk and uses Codex app-server for writes when available. It exposes a small RPC surface to the Android client:

- `sessions.list`
- `sessions.read`
- `sessions.send`
- `turn.interrupt`
- `ping`

It must not expose arbitrary filesystem, shell, process, config, account, or app-server passthrough methods.

The agent derives active-turn state from Codex rollout events. When a selected
session has a `task_started` event without a matching completion event, Android
can steer that turn or send `turn.interrupt`.

## Relay Boundary

The relay only:

- accepts device `hello` frames,
- tracks online sockets,
- forwards frames with `to`,
- reports simple delivery errors to the sender.

It does not parse encrypted payloads.
