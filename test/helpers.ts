import type { Config } from "../src/config.js";
import type { Device, RawDevice } from "../src/devices.js";

export function config(overrides: Partial<Config> = {}): Config {
  return {
    mqttUrl: "mqtt://broker.invalid:1883",
    baseTopic: "zigbee2mqtt",
    clientId: "zigbee2mqtt-mcp-test",
    rejectUnauthorized: true,
    connectTimeoutMs: 1_000,
    requestTimeoutMs: 1_000,
    writeMode: "safe",
    logLevel: "silent",
    weakLinkThreshold: 30,
    lowBatteryThreshold: 20,
    staleHours: 24,
    ...overrides,
  };
}

export function device(overrides: Partial<Device> = {}): Device {
  return {
    friendly_name: "lamp",
    ieee_address: "0x00158d0001000001",
    type: "EndDevice",
    supported: true,
    disabled: false,
    interview_state: "SUCCESSFUL",
    endpoint_count: 1,
    has_state: true,
    ...overrides,
  };
}

export function rawDevice(overrides: Partial<RawDevice> = {}): RawDevice {
  return {
    ieee_address: "0x00158d0001000001",
    type: "EndDevice",
    friendly_name: "lamp",
    ...overrides,
  };
}

/** Hours ago as an ISO timestamp, for staleness tests. */
export function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

/**
 * Runs `fn` with a clean Z2M_* environment plus `vars`. Inherited Z2M_
 * variables would otherwise silently change what loadConfig returns.
 */
export function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("Z2M_")) delete process.env[key];
  }
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}
