import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import {
  createPairingSecret,
  encodePairingUri,
  generateDeviceKeyPair,
  randomId,
  type DeviceKeyPair
} from "@crc/protocol";

export interface TrustedAndroid {
  deviceId: string;
  deviceName: string;
  publicKeyB64: string;
}

export interface AgentConfig {
  deviceId: string;
  deviceName: string;
  relayUrl: string;
  relayAccessToken?: string;
  codexHome: string;
  writeMode: "app-server" | "read-only";
  keyPair: DeviceKeyPair;
  trustedAndroid?: TrustedAndroid;
}

export interface LoadedConfig {
  path: string;
  config: AgentConfig;
  pairingSecret?: string;
  pairingUri?: string;
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function defaultConfigPath(): string {
  return expandHome(process.env.CRC_AGENT_CONFIG ?? "~/.codex-remote-console/agent.json");
}

export async function loadConfig(): Promise<LoadedConfig> {
  const path = defaultConfigPath();
  let config: AgentConfig | undefined;
  try {
    config = JSON.parse(await readFile(path, "utf8")) as AgentConfig;
  } catch {
    const keyPair = await generateDeviceKeyPair();
    config = {
      deviceId: process.env.CRC_DEVICE_ID ?? randomId("agent"),
      deviceName: process.env.CRC_DEVICE_NAME ?? hostname(),
      relayUrl: process.env.CRC_RELAY_URL ?? "ws://127.0.0.1:8787/ws",
      relayAccessToken: process.env.CRC_RELAY_ACCESS_TOKEN,
      codexHome: expandHome(process.env.CRC_CODEX_HOME ?? "~/.codex"),
      writeMode: (process.env.CRC_WRITE_MODE as AgentConfig["writeMode"]) ?? "app-server",
      keyPair
    };
    await saveConfig(path, config);
  }

  config = {
    ...config,
    relayUrl: process.env.CRC_RELAY_URL ?? config.relayUrl,
    relayAccessToken: process.env.CRC_RELAY_ACCESS_TOKEN ?? config.relayAccessToken,
    codexHome: expandHome(process.env.CRC_CODEX_HOME ?? config.codexHome),
    writeMode: (process.env.CRC_WRITE_MODE as AgentConfig["writeMode"]) ?? config.writeMode
  };

  if (config.trustedAndroid) {
    return { path, config };
  }

  const pairingSecret = createPairingSecret();
  const pairingUri = encodePairingUri({
    relayUrl: config.relayUrl,
    relayAccessToken: config.relayAccessToken,
    agentId: config.deviceId,
    agentName: config.deviceName,
    agentPublicKeyB64: config.keyPair.publicKeyB64,
    pairingSecret
  });
  return { path, config, pairingSecret, pairingUri };
}

export async function saveConfig(path: string, config: AgentConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}
