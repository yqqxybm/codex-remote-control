# Codex Remote Console

Codex Remote Console is a self-hosted Android client for two fixed Macs running Codex. It is meant to feel like a lightweight mobile mirror of the Codex desktop chat view: open a session, read messages, send a message, append to an active turn, or stop it.

## Architecture

```text
Android App
  |
  | WebSocket envelope, application-layer E2E encryption
  v
User-Owned Blind Relay
  |
  | WebSocket envelope, application-layer E2E encryption
  v
Mac Agent
  |
  | localhost / local files only
  v
Codex app-server + ~/.codex sessions
```

The relay only routes encrypted envelopes by device id. It does not see Codex session content and does not call Codex. The production route is through `user-owned relay server` at `wss://your-domain.example/codex-remote/ws`; LAN relay runs are only for development smoke tests.

## Components

- `apps/relay`: deploy this on `user-owned relay server`.
- `apps/agent`: run one copy on each Mac.
- `apps/android`: install on the fixed Android phone.
- `packages/protocol`: shared frame types and Node crypto helpers.

## Local Development

```bash
npm install
npm run build
npm test
npm run smoke
```

Run a local relay for development:

```bash
CRC_RELAY_ACCESS_TOKEN=dev-token npm run dev -w @crc/relay
```

Run a Mac agent:

```bash
CRC_RELAY_URL=ws://127.0.0.1:8787/ws \
CRC_RELAY_ACCESS_TOKEN=dev-token \
CRC_DEVICE_NAME="MacBook" \
npm run dev -w @crc/agent
```

The agent creates its config under `~/.codex-remote-console/agent.json` and prints a pairing URI for the Android app.

For remote use, run the relay on `user-owned relay server` and point Mac agents at:

```bash
CRC_RELAY_URL=wss://your-domain.example/codex-remote/ws
```

The agent reconnects automatically after relay restarts or network changes.

## Write Support

The agent has a whitelisted Codex writer. It supports:

- send to idle session: `thread/resume` + `turn/start`
- steer active turn: `turn/steer`
- stop active turn: `turn/interrupt`

This requires a working Codex app-server proxy on the Mac. If the local Codex installation cannot start `codex app-server`, reads still work and writes return a clear error.

## Android Build

Install a JDK and Android SDK, then:

```bash
cd apps/android
gradle assembleDebug
```

On this workstation, the debug APK was built with a user-local JDK, Gradle, and Android SDK under `~/.codex-remote-console/toolchains`.

The generated debug APK path is:

```text
apps/android/app/build/outputs/apk/debug/app-debug.apk
```
