# Codex Remote Console Project Instructions

This project is a three-part product:

- `apps/relay`: blind WebSocket relay. It routes encrypted envelopes only.
- `apps/agent`: macOS-side Codex bridge. It reads local Codex sessions and sends whitelisted write requests to Codex.
- `apps/android`: Android client. It is the only intended user-facing client.
- `packages/protocol`: shared TypeScript protocol and crypto implementation for Node services.

Keep the product intentionally small. The goal is to view Codex sessions, send simple messages, append guidance to a running turn, and stop a turn. Do not expand it into a general remote shell, file manager, or admin console.

Security boundaries:

- The relay must never receive plaintext Codex session content.
- The relay must not implement Codex actions.
- The Mac agent must not expose arbitrary app-server JSON-RPC passthrough.
- Android write actions must target one known Mac and one known session.
- Avoid adding long-lived broad approvals such as `acceptForSession`.

Verification:

- Run `npm test`, `npm run typecheck`, and `npm run smoke` for Node-side changes.
- Android builds require a local JDK and Android SDK; run `./gradlew assembleDebug` from `apps/android` when those are installed.
