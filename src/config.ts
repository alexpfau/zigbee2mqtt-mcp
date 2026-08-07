import { readFileSync } from "node:fs";

export type WriteMode = "off" | "safe" | "full";
export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

export interface Config {
  mqttUrl: string;
  username?: string;
  password?: string;
  baseTopic: string;
  clientId: string;
  rejectUnauthorized: boolean;
  ca?: Buffer;
  cert?: Buffer;
  key?: Buffer;
  connectTimeoutMs: number;
  requestTimeoutMs: number;
  writeMode: WriteMode;
  logLevel: LogLevel;
  /** Link quality below this is reported as a weak link. */
  weakLinkThreshold: number;
  /** Battery percentage below this is reported as low. */
  lowBatteryThreshold: number;
  /** Hours without a message before a device is reported as stale. */
  staleHours: number;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  // parseInt would accept '12abc' as 12, which hides a typo in a timeout.
  if (!/^-?\d+$/.test(raw.trim())) {
    throw new Error(`${name} must be an integer, got ${JSON.stringify(raw)}`);
  }
  const parsed = Number.parseInt(raw, 10);
  if (parsed < 0) {
    throw new Error(`${name} must not be negative, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return !["0", "false", "no", "off"].includes(raw.toLowerCase());
}

function file(name: string): Buffer | undefined {
  const path = process.env[name];
  if (!path) return undefined;
  try {
    return readFileSync(path);
  } catch (error) {
    throw new Error(`${name}: cannot read ${path}: ${(error as Error).message}`);
  }
}

function oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = raw.toLowerCase() as T;
  if (!allowed.includes(value)) {
    throw new Error(`${name} must be one of ${allowed.join(", ")}, got ${JSON.stringify(raw)}`);
  }
  return value;
}

export const MISSING_MQTT_URL =
  "Z2M_MQTT_URL is not set, e.g. mqtt://192.168.1.10:1883 " +
  "(mqtt://, mqtts://, ws:// and wss:// are supported). " +
  "Point it at the MQTT broker Zigbee2MQTT uses, not the Zigbee2MQTT frontend port.";

/**
 * `requireMqttUrl: false` lets the server start unconfigured so clients and
 * directory scanners can still enumerate tools; calls then fail with a clear
 * message rather than the process refusing to start.
 */
export function loadConfig({ requireMqttUrl = true } = {}): Config {
  const mqttUrl = process.env.Z2M_MQTT_URL;
  if (!mqttUrl && requireMqttUrl) {
    throw new Error(MISSING_MQTT_URL);
  }

  return {
    mqttUrl: mqttUrl || "mqtt://unconfigured.invalid:1883",
    username: process.env.Z2M_MQTT_USERNAME || undefined,
    password: process.env.Z2M_MQTT_PASSWORD || undefined,
    baseTopic: (process.env.Z2M_BASE_TOPIC || "zigbee2mqtt").replace(/\/+$/, ""),
    clientId: process.env.Z2M_MQTT_CLIENT_ID || `zigbee2mqtt-mcp-${process.pid}`,
    rejectUnauthorized: bool("Z2M_MQTT_REJECT_UNAUTHORIZED", true),
    ca: file("Z2M_MQTT_CA"),
    cert: file("Z2M_MQTT_CERT"),
    key: file("Z2M_MQTT_KEY"),
    connectTimeoutMs: int("Z2M_CONNECT_TIMEOUT_MS", 10_000),
    requestTimeoutMs: int("Z2M_REQUEST_TIMEOUT_MS", 15_000),
    writeMode: oneOf("Z2M_WRITE_MODE", ["off", "safe", "full"] as const, "safe"),
    logLevel: oneOf("Z2M_LOG_LEVEL", ["silent", "error", "warn", "info", "debug"] as const, "error"),
    weakLinkThreshold: int("Z2M_WEAK_LINK_THRESHOLD", 30),
    lowBatteryThreshold: int("Z2M_LOW_BATTERY_THRESHOLD", 20),
    staleHours: int("Z2M_STALE_HOURS", 24),
  };
}

const LEVELS: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

/**
 * stdio transport owns stdout, so every diagnostic must go to stderr.
 */
export function createLogger(level: LogLevel) {
  const emit = (at: LogLevel, args: unknown[]) => {
    if (LEVELS[level] >= LEVELS[at]) {
      console.error(`[zigbee2mqtt-mcp] [${at}]`, ...args);
    }
  };
  return {
    error: (...args: unknown[]) => emit("error", args),
    warn: (...args: unknown[]) => emit("warn", args),
    info: (...args: unknown[]) => emit("info", args),
    debug: (...args: unknown[]) => emit("debug", args),
  };
}

export type Logger = ReturnType<typeof createLogger>;
