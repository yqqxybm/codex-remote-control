# Runbook

## Deploy Relay On Your Server

1. Copy the project to the server.
2. Install Node.js 22 or newer.
3. Install dependencies:

   ```bash
   npm install
   npm run build
   ```

4. Start relay:

   ```bash
   CRC_RELAY_HOST=0.0.0.0 \
   CRC_RELAY_PORT=8787 \
   CRC_RELAY_ACCESS_TOKEN=<long-random-token> \
   npm start -w @crc/relay
   ```

5. Put a TLS reverse proxy in front of it and expose `wss://your-domain/ws`.

## Run Mac Agent

```bash
CRC_RELAY_URL=wss://your-domain/ws \
CRC_RELAY_ACCESS_TOKEN=<long-random-token> \
CRC_DEVICE_NAME="Mac mini" \
npm start -w @crc/agent
```

The agent prints a pairing URI. Scan or paste it into the Android app.

## Re-pair A Phone

Stop the agent, edit `~/.codex-remote-console/agent.json`, remove `trustedAndroid`, and start the agent again. It prints a new pairing URI.

## Troubleshooting

- Relay health: `curl https://your-domain/health`
- Agent read-only works but writes fail: verify `codex app-server proxy` works on the Mac.
- No sessions appear: verify `CRC_CODEX_HOME` points to the same Codex home used by the desktop app.
