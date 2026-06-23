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

The relay only routes encrypted envelopes by device id and rejects frames whose `from` metadata does not match the socket's registered device id. It does not see Codex session content and does not call Codex. The production route is through `user-owned relay server` at `wss://your-domain.example/codex-remote/ws`; LAN relay runs are only for development smoke tests.

The relay refuses to start unless `CRC_RELAY_ACCESS_TOKEN` is set. It also closes sockets that do not send `hello` promptly and caps WebSocket payload size high enough for encrypted session reads. For isolated local experiments only, set `CRC_RELAY_ALLOW_UNAUTHENTICATED=1` explicitly. Android waits for a Mac-side pairing acknowledgement before it marks a Mac online and loads sessions.

Write requests include a creation timestamp and are replay-checked by the Mac agent. The agent stores a small recent write-request cache in `~/.codex-remote-console/agent.json` so a relay cannot repeat a captured write envelope during the accepted window.

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

This requires a working Codex app-server proxy on the Mac. If the local Codex installation cannot start `codex app-server` or stops answering, reads still work and writes return a clear error. App-server requests time out after 60 seconds by default; override with `CRC_APP_SERVER_REQUEST_TIMEOUT_MS` if needed. After a remote write starts or steers a Codex turn, the agent keeps its app-server child alive while that session still reports an active turn, then stops the child after 10 idle minutes by default. The active-turn monitor waits up to 2 minutes for a newly started turn to appear in local Codex session state before treating the write as idle; override with `CRC_REMOTE_TURN_START_GRACE_MS` or `CRC_REMOTE_TURN_MONITOR_POLL_MS` when needed. Set `CRC_APP_SERVER_IDLE_TIMEOUT_MS=0` to disable idle shutdown, or set a larger millisecond value for warmer follow-up writes.

The Android composer switches to `Steer` when the selected session has an active Codex turn, and shows a `Stop` action for that turn. The app refreshes the selected session after write actions, when `Refresh` is tapped, and every few seconds while an active turn is running. Session reads return the latest 300 parsed messages by default so long Codex rollouts stay fast on mobile.

## Android Build

Install a JDK and Android SDK with platform 36 and Build Tools 35.0.1, then:

```bash
cd apps/android
gradle assembleDebug
```

On this workstation, the debug APK was built with a user-local JDK, Gradle, and Android SDK under `~/.codex-remote-console/toolchains`.

The generated debug APK path is:

```text
apps/android/app/build/outputs/apk/debug/app-debug.apk
```

When rolling out protocol changes, install the newest APK before restarting the updated Mac agent. Current agents reject write requests from old APKs that do not include the replay timestamp; reads still work, but sends fail with a missing creation timestamp error.
