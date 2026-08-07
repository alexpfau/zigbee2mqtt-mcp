import type { Config } from "./config.js";

export interface RawDevice {
  ieee_address: string;
  type: string;
  network_address?: number;
  supported?: boolean;
  disabled?: boolean;
  friendly_name: string;
  description?: string;
  power_source?: string | null;
  date_code?: string | null;
  model_id?: string | null;
  software_build_id?: string | null;
  interview_state?: string;
  interview_completed?: boolean;
  interviewing?: boolean;
  endpoints?: Record<string, unknown>;
  definition?: {
    model?: string;
    vendor?: string;
    description?: string;
    source?: string;
    exposes?: unknown[];
    options?: unknown[];
  } | null;
}

export interface Device {
  friendly_name: string;
  ieee_address: string;
  type: string;
  network_address?: number;
  model?: string;
  vendor?: string;
  description?: string;
  power_source?: string;
  supported: boolean;
  disabled: boolean;
  interview_state: string;
  software_build_id?: string;
  date_code?: string;
  linkquality?: number;
  battery?: number;
  battery_low?: boolean;
  availability?: string;
  last_seen?: string;
  update?: { state?: string; installed_version?: unknown; latest_version?: unknown };
  endpoint_count: number;
  /** Whether this device has published state during the current session. */
  has_state: boolean;
}

export interface Capabilities {
  /** advanced.last_seen is 'disable' by default, so timestamps are often absent. */
  last_seen: boolean;
  availability: boolean;
  /**
   * coordinator_check needs an adapter that supports coordinator backups,
   * not a particular vendor. Verified working on EmberZNet.
   */
  coordinator_check: boolean;
  coordinator_type?: string;
}

/**
 * Adapters whose backup support makes coordinator_check work. Zigbee2MQTT
 * gates it on adapter.supportsBackup(), which deCONZ and ZiGate do not have.
 */
const BACKUP_CAPABLE = /^(zStack|znp|ember)/i;

export function detectCapabilities(
  info: Record<string, unknown> | undefined,
  availability: Map<string, string>,
): Capabilities {
  const config = (info?.config ?? {}) as Record<string, any>;
  const lastSeenSetting = config?.advanced?.last_seen;
  const availabilitySetting = config?.availability;
  const coordinatorType = (info?.coordinator as Record<string, any> | undefined)?.type;

  return {
    last_seen: typeof lastSeenSetting === "string" && lastSeenSetting !== "disable",
    availability:
      availability.size > 0 ||
      availabilitySetting === true ||
      (typeof availabilitySetting === "object" && availabilitySetting !== null),
    coordinator_check: typeof coordinatorType === "string" && BACKUP_CAPABLE.test(coordinatorType),
    coordinator_type: typeof coordinatorType === "string" ? coordinatorType : undefined,
  };
}

export function normalize(
  raw: RawDevice,
  deviceState: Map<string, Record<string, unknown>>,
  availability: Map<string, string>,
): Device {
  const state = deviceState.get(raw.friendly_name) ?? {};
  const update = state.update as Device["update"] | undefined;

  const device: Device = {
    friendly_name: raw.friendly_name,
    ieee_address: raw.ieee_address,
    type: raw.type,
    supported: raw.supported !== false,
    disabled: raw.disabled === true,
    interview_state: raw.interview_state ?? (raw.interview_completed ? "SUCCESSFUL" : "PENDING"),
    endpoint_count: Object.keys(raw.endpoints ?? {}).length,
    has_state: deviceState.has(raw.friendly_name),
  };

  if (raw.network_address !== undefined) device.network_address = raw.network_address;
  if (raw.definition?.model) device.model = raw.definition.model;
  if (raw.definition?.vendor) device.vendor = raw.definition.vendor;
  if (raw.description || raw.definition?.description) {
    device.description = raw.description || raw.definition?.description;
  }
  if (raw.power_source) device.power_source = raw.power_source;
  if (raw.software_build_id) device.software_build_id = raw.software_build_id;
  if (raw.date_code) device.date_code = raw.date_code;

  if (typeof state.linkquality === "number") device.linkquality = state.linkquality;
  if (typeof state.battery === "number") device.battery = state.battery;
  if (typeof state.battery_low === "boolean") device.battery_low = state.battery_low;
  if (state.last_seen !== undefined) device.last_seen = String(state.last_seen);
  if (update && typeof update === "object") device.update = update;

  const avail = availability.get(raw.friendly_name);
  if (avail) device.availability = avail;

  return device;
}

export function isCoordinator(raw: RawDevice): boolean {
  return raw.type === "Coordinator";
}

export interface HealthIssue {
  friendly_name: string;
  ieee_address: string;
  detail: string;
}

export interface HealthReport {
  bridge: Record<string, unknown>;
  totals: Record<string, number>;
  capabilities: Capabilities;
  issues: Record<string, HealthIssue[]>;
  hints: string[];
}

export function buildHealthReport(
  devices: Device[],
  info: Record<string, unknown> | undefined,
  bridgeState: Record<string, unknown> | undefined,
  bridgeHealth: Record<string, any> | undefined,
  capabilities: Capabilities,
  config: Config,
): HealthReport {
  const issues: Record<string, HealthIssue[]> = {
    offline: [],
    stale: [],
    weak_link: [],
    low_battery: [],
    interview_incomplete: [],
    unsupported: [],
    disabled: [],
    update_available: [],
    rejoining: [],
    address_changing: [],
    silent: [],
  };

  const staleCutoff = Date.now() - config.staleHours * 3_600_000;
  const deviceHealth = (bridgeHealth?.devices ?? {}) as Record<string, any>;

  for (const device of devices) {
    const ref = { friendly_name: device.friendly_name, ieee_address: device.ieee_address };

    if (device.disabled) {
      issues.disabled!.push({ ...ref, detail: "Device is disabled in Zigbee2MQTT" });
      continue; // disabled devices produce no traffic, so other checks are noise
    }
    if (device.availability === "offline") {
      issues.offline!.push({ ...ref, detail: "Availability reports offline" });
    }
    if (device.interview_state !== "SUCCESSFUL") {
      issues.interview_incomplete!.push({ ...ref, detail: `interview_state=${device.interview_state}` });
    }
    if (!device.supported) {
      issues.unsupported!.push({
        ...ref,
        detail: `No converter for model_id; exposed generically${device.model ? ` (${device.model})` : ""}`,
      });
    }
    if (device.linkquality !== undefined && device.linkquality < config.weakLinkThreshold) {
      issues.weak_link!.push({ ...ref, detail: `linkquality=${device.linkquality} (< ${config.weakLinkThreshold})` });
    }
    if (device.battery !== undefined && device.battery < config.lowBatteryThreshold) {
      issues.low_battery!.push({ ...ref, detail: `battery=${device.battery}% (< ${config.lowBatteryThreshold}%)` });
    } else if (device.battery_low) {
      issues.low_battery!.push({ ...ref, detail: "Device reports battery_low" });
    }
    if (device.update?.state === "available") {
      const from = device.update.installed_version;
      const to = device.update.latest_version;
      issues.update_available!.push({
        ...ref,
        detail: from && to ? `OTA update available: ${from} -> ${to}` : "OTA update available",
      });
    }
    // A missing last_seen is not a finding: Zigbee2MQTT only publishes it when a
    // device reports, so absence means no data yet. The authoritative signal for
    // a device that has never reported is bridge/health messages === 0, below.
    if (capabilities.last_seen && device.last_seen) {
      const seen = Date.parse(device.last_seen);
      if (!Number.isNaN(seen) && seen < staleCutoff) {
        const hours = Math.round((Date.now() - seen) / 3_600_000);
        issues.stale!.push({ ...ref, detail: `Last seen ${hours}h ago (> ${config.staleHours}h)` });
      }
    }

    // bridge/health counters are cumulative since the bridge started and are
    // available immediately, unlike anything derived from device state topics.
    const stats = deviceHealth[device.ieee_address];
    if (stats) {
      if (stats.leave_count > 0) {
        issues.rejoining!.push({
          ...ref,
          detail: `Left and rejoined the network ${stats.leave_count} time(s) since bridge start`,
        });
      }
      if (stats.network_address_changes > 0) {
        issues.address_changing!.push({
          ...ref,
          detail: `Network address changed ${stats.network_address_changes} time(s), which suggests an unstable route`,
        });
      }
      if (stats.messages === 0) {
        issues.silent!.push({ ...ref, detail: "No messages received since bridge start" });
      }
    }
  }

  const hints: string[] = [];
  if (!capabilities.last_seen) {
    hints.push(
      "Staleness checks are unavailable because advanced.last_seen is 'disable' in your Zigbee2MQTT " +
        "configuration. Set it to 'ISO_8601' to enable them.",
    );
  }
  if (!capabilities.availability) {
    hints.push(
      "Offline detection is unavailable because device availability is not enabled. " +
        "Set availability.enabled to true in your Zigbee2MQTT configuration.",
    );
  }
  if (capabilities.last_seen && devices.some((d) => d.has_state && !d.last_seen)) {
    hints.push(
      "Staleness coverage is partial: some devices last reported before advanced.last_seen was enabled, " +
        "so they carry no timestamp yet. Coverage completes as each device next reports.",
    );
  }
  if (devices.every((d) => d.linkquality === undefined)) {
    hints.push(
      "No link quality data yet. Zigbee2MQTT does not retain device state topics, so these values only " +
        "appear as devices report in. Pass collect_seconds to listen for live traffic, or use " +
        "z2m_network_map for an authoritative mesh-wide reading.",
    );
  }
  if (info?.restart_required === true) {
    hints.push("Zigbee2MQTT reports restart_required=true; pending option changes are not active yet.");
  }
  if (bridgeState && bridgeState.state !== "online") {
    hints.push(`Bridge state is '${String(bridgeState.state)}'.`);
  }

  const nonEmpty = Object.fromEntries(Object.entries(issues).filter(([, list]) => list.length > 0));

  return {
    bridge: {
      state: bridgeState?.state ?? "unknown",
      version: info?.version,
      coordinator_type: capabilities.coordinator_type,
      permit_join: info?.permit_join,
      restart_required: info?.restart_required,
    },
    totals: {
      devices: devices.length,
      routers: devices.filter((d) => d.type === "Router").length,
      end_devices: devices.filter((d) => d.type === "EndDevice").length,
      issue_count: Object.values(nonEmpty).reduce((sum, list) => sum + list.length, 0),
    },
    capabilities,
    issues: nonEmpty,
    hints,
  };
}
