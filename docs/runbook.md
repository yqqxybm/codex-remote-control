# Runbook

## Deploy Relay On Your Server

The production relay is private to the server on `127.0.0.1:8787` and is exposed through the existing Nginx TLS site:

```text
wss://your-domain.example/codex-remote/ws
https://your-domain.example/codex-remote/health
```

1. Copy the project to `/home/jms/codex-remote-console`.
2. Install Node.js 22 or newer.
3. Install dependencies and build:

   ```bash
   npm ci
   npm run build
   ```

4. Write `/home/jms/.config/codex-remote-console/relay.env`:

   ```bash
   CRC_RELAY_HOST=127.0.0.1
   CRC_RELAY_PORT=8787
   CRC_RELAY_ACCESS_TOKEN=<long-random-token>
   ```

5. Run it with systemd as user `jms`:

   ```ini
   [Service]
   User=jms
   WorkingDirectory=/home/jms/codex-remote-console
   EnvironmentFile=/home/jms/.config/codex-remote-console/relay.env
   ExecStart=/usr/bin/npm start -w @crc/relay
   Restart=always
   RestartSec=3
   ```

6. Add an Nginx location inside your HTTPS server:

   ```nginx
   location /codex-remote/ {
       proxy_pass http://127.0.0.1:8787/;
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection "upgrade";
       proxy_set_header Host $host;
       proxy_read_timeout 1d;
   }
   ```

Direct public `:8787` exposure is not needed.

## Run Mac Agent

```bash
CRC_RELAY_URL=wss://your-domain.example/codex-remote/ws \
CRC_RELAY_ACCESS_TOKEN=<long-random-token> \
CRC_DEVICE_NAME="Mac mini" \
CRC_CODEX_HOME=/Users/you/.codex \
CRC_CODEX_BIN=/Users/you/.codex/packages/standalone/current/codex \
CRC_WRITE_MODE=app-server \
CRC_AGENT_RECONNECT_MS=3000 \
npm start -w @crc/agent
```

The agent prints a pairing URI. Paste it into the Android app. The Android app stores the last pairing URI and reconnects on app launch.

For writes, the agent runs the Codex app-server over stdio. `CRC_CODEX_BIN` is optional; when unset, the agent tries `~/.codex/packages/standalone/current/codex`, then `/Applications/Codex.app/Contents/Resources/codex`, then `codex` from `PATH`.

The agent persists recent write request ids in the same config file to reject
replayed mobile write envelopes. Removing the config file resets both pairing
and replay history.

## Local Development

```bash
CRC_RELAY_HOST=0.0.0.0 \
CRC_RELAY_PORT=8787 \
CRC_RELAY_ACCESS_TOKEN=dev-token \
npm start -w @crc/relay
```

Use local LAN only for development smoke checks, not as the remote-control path.

## Re-pair A Phone

Stop the agent, edit `~/.codex-remote-console/agent.json`, remove `trustedAndroid`, and start the agent again. It prints a new pairing URI.

## Troubleshooting

- Relay health: `curl https://your-domain.example/codex-remote/health`
- Agent read-only works but writes fail: verify `codex app-server proxy` works on the Mac.
- No sessions appear: verify `CRC_CODEX_HOME` points to the same Codex home used by the desktop app.
- Send stays pending on Android: verify the Mac agent is online and check its logs for app-server or replay-window errors.
