import type { Z2MClient } from "./client.js";
import { NoBridgeDataError } from "./client.js";
import { scrubSecrets } from "./redact.js";
import type { Config } from "./config.js";
import {
  buildHealthReport,
  detectCapabilities,
  isCoordinator,
  normalize,
  type Device,
  type RawDevice,
} from "./devices.js";

export type Tier = "read" | "safe" | "full";

/**
 * MCP behavioural hints. Clients use these to decide whether a tool may run
 * without asking the user, so they must be accurate rather than optimistic.
 */
export interface ToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolContext {
  client: Z2MClient;
  config: Config;
  /** Set when the server started without a usable configuration. */
  configError?: string;
}

export interface ToolDef {
  name: string;
  tier: Tier;
  description: string;
  annotations: ToolAnnotations;
  /** Allows the tool to run when configuration is missing, to report on it. */
  runsUnconfigured?: boolean;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler: (args: Record<string, any>, ctx: ToolContext) => Promise<unknown>;
}

/** Every tool reaches a live Zigbee network, so openWorldHint is always true. */
const readOnly = (title: string): ToolAnnotations => ({
  title,
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
});

const mutating = (
  title: string,
  { destructive = false, idempotent = false } = {},
): ToolAnnotations => ({
  title,
  readOnlyHint: false,
  destructiveHint: destructive,
  idempotentHint: idempotent,
  openWorldHint: true,
});

const EMPTY = { type: "object" as const, properties: {} };

const DEVICE_ID = {
  type: "string",
  description: "Device friendly_name or ieee_address.",
};

// --------------------------------------------------------------------- helpers

async function loadDevices(ctx: ToolContext, collectSeconds?: number) {
  if (collectSeconds) {
    await ctx.client.collectState(num({ collect_seconds: collectSeconds }, "collect_seconds", { min: 1, max: 120 }) * 1000);
  }
  const snap = await ctx.client.snapshot();
  const raw = (snap.devices as RawDevice[]).filter((d) => !isCoordinator(d));
  const devices = raw.map((d) => normalize(d, snap.deviceState, snap.availability));
  const capabilities = detectCapabilities(snap.info, snap.availability);
  return { snap, raw, devices, capabilities };
}

const COLLECT_SECONDS = {
  type: "number",
  description:
    "Listen for live device traffic for this many seconds before answering, to populate linkquality, " +
    "battery and OTA fields that Zigbee2MQTT does not publish as retained messages. Max 120.",
};

/** Exported for tests; disambiguation rules are easy to regress. */
export function findRaw(raw: RawDevice[], id: string): RawDevice {
  const needle = id.trim().toLowerCase();
  // Every name contains the empty string, so an unguarded blank would match the
  // first device on a single-device estate.
  if (!needle) throw new Error("A device friendly_name or ieee_address is required.");
  const match = raw.find(
    (d) => d.friendly_name.toLowerCase() === needle || d.ieee_address.toLowerCase() === needle,
  );
  if (match) return match;

  const partial = raw.filter((d) => d.friendly_name.toLowerCase().includes(needle));
  if (partial.length === 1) return partial[0]!;
  if (partial.length > 1) {
    throw new Error(
      `'${id}' matches ${partial.length} devices: ${partial
        .slice(0, 10)
        .map((d) => d.friendly_name)
        .join(", ")}. Use an exact friendly_name or ieee_address.`,
    );
  }
  throw new Error(`No device matches '${id}'. Use z2m_list_devices to see available devices.`);
}

/**
 * Number("ten") is NaN, which silently becomes slice(0, NaN) or setTimeout(0)
 * rather than an error a model can correct.
 */
function num(
  args: Record<string, any>,
  name: string,
  { min = 0, max = Number.MAX_SAFE_INTEGER, fallback }: { min?: number; max?: number; fallback?: number } = {},
): number {
  const raw = args[name];
  if (raw === undefined || raw === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`${name} is required.`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a number, got ${JSON.stringify(raw)}.`);
  }
  if (value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}, got ${value}.`);
  }
  return value;
}

function requireConfirm(args: Record<string, any>, action: string): void {
  if (args.confirm !== true) {
    throw new Error(`${action} is irreversible or disruptive. Re-run with confirm=true to proceed.`);
  }
}

function summariseExposes(exposes: unknown[] | undefined): string[] {
  const out: string[] = [];
  const walk = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node.features)) {
      for (const feature of node.features) walk(feature);
      if (node.type && !node.property) out.push(`${node.type}`);
      return;
    }
    if (node.property) {
      // The description tells the model to use this to discover valid
      // values, so a bare type is not enough.
      const bounds =
        node.type === "enum" && Array.isArray(node.values)
          ? ` [${node.values.join("|")}]`
          : node.value_min !== undefined || node.value_max !== undefined
            ? ` [${node.value_min ?? "?"}..${node.value_max ?? "?"}${node.unit ? " " + node.unit : ""}]`
            : "";
      out.push(`${node.property}:${node.type ?? "unknown"}${bounds}`);
    }
  };
  for (const expose of exposes ?? []) walk(expose);
  return [...new Set(out)];
}

// ----------------------------------------------------------------- read tools

const readTools: ToolDef[] = [
  {
    name: "z2m_connection_status",
    tier: "read",
    annotations: readOnly("Check MQTT connection"),
    runsUnconfigured: true,
    description:
      "Check whether this server can reach the MQTT broker and whether Zigbee2MQTT is publishing to it. " +
      "Read-only, and the only tool that reports rather than throws when the connection is down or not " +
      "configured at all, so call it first when any other tool fails with a connection or timeout error. " +
      "Distinguishes an unreachable broker from a reachable broker carrying no Zigbee2MQTT data, which " +
      "usually means Z2M_BASE_TOPIC does not match the mqtt.base_topic setting in Zigbee2MQTT. Reports " +
      "the broker URL with credentials redacted, TLS settings, cached message counts and the write mode.",
    inputSchema: EMPTY,
    handler: async (_args, ctx) => {
      if (ctx.configError) {
        return {
          configured: false,
          broker_reachable: false,
          zigbee2mqtt_responding: false,
          error: ctx.configError,
          hints: ["Set Z2M_MQTT_URL in the server's environment, then call this tool again."],
        };
      }

      let brokerReachable = true;
      let zigbee2mqttResponding = true;
      let error: string | undefined;
      try {
        await ctx.client.connect();
      } catch (e) {
        error = scrubSecrets((e as Error).message, ctx.config);
        zigbee2mqttResponding = false;
        // Whether the broker answered is a fact the client observed, not
        // something to infer from which error happened to surface.
        brokerReachable = ctx.client.status().broker_handshake || e instanceof NoBridgeDataError;
      }

      const status = ctx.client.status();
      const hints: string[] = [];
      if (!brokerReachable) {
        hints.push(
          "Could not reach the broker. Check that Z2M_MQTT_URL points at the MQTT broker Zigbee2MQTT " +
            "uses rather than the Zigbee2MQTT frontend port, and that any credentials are correct.",
        );
      } else if (!zigbee2mqttResponding || status.cached.bridge_topics === 0) {
        hints.push(
          `The broker is reachable, but nothing was published under '${status.base_topic}/bridge/'. ` +
            "Either Zigbee2MQTT is not running against this broker, or Z2M_BASE_TOPIC does not match " +
            "its mqtt.base_topic setting.",
        );
      }
      if (status.tls.enabled && !status.tls.reject_unauthorized) {
        hints.push("TLS certificate verification is disabled, so the broker's identity is not checked.");
      }

      return {
        configured: true,
        broker_reachable: brokerReachable,
        zigbee2mqtt_responding: zigbee2mqttResponding,
        ...status,
        error,
        hints,
      };
    },
  },
  {
    name: "z2m_bridge_info",
    tier: "read",
    annotations: readOnly("Get bridge status"),
    description:
      "Get Zigbee2MQTT bridge status: version, coordinator type and firmware, Zigbee channel and PAN ID, " +
      "permit_join state, log level, whether a restart is required, and host OS/memory. Read-only. " +
      "Start here to understand the estate, then use z2m_health_report for problems or z2m_list_devices " +
      "for individual devices. Returns a JSON object; set include_config only if you need the full " +
      "Zigbee2MQTT configuration, which is large.",
    inputSchema: {
      type: "object",
      properties: {
        include_config: {
          type: "boolean",
          description: "Include the full Zigbee2MQTT configuration (large). Default false.",
        },
      },
    },
    handler: async (args, ctx) => {
      const snap = await ctx.client.snapshot();
      const info = (snap.info ?? {}) as Record<string, any>;
      const health = snap.health as Record<string, any> | undefined;
      const capabilities = detectCapabilities(snap.info, snap.availability);
      const result: Record<string, unknown> = {
        bridge_state: snap.state?.state ?? "unknown",
        version: info.version,
        commit: info.commit,
        coordinator: info.coordinator,
        network: info.network,
        permit_join: info.permit_join,
        permit_join_end: info.permit_join_end
          ? new Date(Number(info.permit_join_end)).toISOString()
          : undefined,
        log_level: info.log_level,
        restart_required: info.restart_required,
        os: info.os,
        mqtt: info.mqtt,
        zigbee_herdsman: info.zigbee_herdsman,
        zigbee_herdsman_converters: info.zigbee_herdsman_converters,
        device_count: (snap.devices as RawDevice[]).filter((d) => !isCoordinator(d)).length,
        group_count: snap.groups.length,
        capabilities,
        runtime: health
          ? {
              uptime_hours: health.process?.uptime_sec
                ? Math.round(Number(health.process.uptime_sec) / 360) / 10
                : undefined,
              process_memory_mb: health.process?.memory_used_mb,
              os_load_average: health.os?.load_average,
              mqtt_connected: health.mqtt?.connected,
              mqtt_queued: health.mqtt?.queued,
              mqtt_published: health.mqtt?.published,
              mqtt_received: health.mqtt?.received,
            }
          : undefined,
      };
      if (args.include_config) result.config = info.config;
      return result;
    },
  },

  {
    name: "z2m_list_devices",
    tier: "read",
    annotations: readOnly("List devices"),
    description:
      "List Zigbee devices with administrative detail: type, model, vendor, power source, link quality, " +
      "battery, availability, last_seen, interview state and pending OTA updates. Read-only, though " +
      "collect_seconds will wait before answering. Use this to answer 'which devices are offline' or " +
      "'which have the weakest signal'. Prefer z2m_health_report for a prioritised summary of everything " +
      "wrong at once, and z2m_get_device when you need one device's exposes, options or bindings. " +
      "Returns {total, returned, capabilities, devices[]}.",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Case-insensitive substring match on name, model, vendor or description." },
        type: { type: "string", enum: ["Router", "EndDevice"], description: "Filter by Zigbee device type." },
        availability: { type: "string", enum: ["online", "offline", "unknown"] },
        only_problems: {
          type: "boolean",
          description: "Only devices that are offline, disabled, unsupported, mid-interview, weak-signal or low-battery.",
        },
        has_update: { type: "boolean", description: "Only devices with a pending OTA firmware update." },
        sort_by: {
          type: "string",
          enum: ["friendly_name", "linkquality", "battery", "last_seen", "model", "vendor"],
          description: "Default friendly_name. Numeric sorts are ascending, so weakest/lowest first.",
        },
        collect_seconds: COLLECT_SECONDS,
        limit: { type: "number", description: "Maximum number of devices to return." },
      },
    },
    handler: async (args, ctx) => {
      const { devices, capabilities } = await loadDevices(ctx, args.collect_seconds);
      let list = devices;

      if (args.search) {
        const needle = String(args.search).toLowerCase();
        list = list.filter((d) =>
          [d.friendly_name, d.model, d.vendor, d.description]
            .filter(Boolean)
            .some((field) => String(field).toLowerCase().includes(needle)),
        );
      }
      if (args.type) list = list.filter((d) => d.type === args.type);
      if (args.availability) {
        list = list.filter((d) => (d.availability ?? "unknown") === args.availability);
      }
      if (args.has_update) list = list.filter((d) => d.update?.state === "available");
      if (args.only_problems) {
        list = list.filter(
          (d) =>
            d.availability === "offline" ||
            d.disabled ||
            !d.supported ||
            d.interview_state !== "SUCCESSFUL" ||
            (d.linkquality !== undefined && d.linkquality < ctx.config.weakLinkThreshold) ||
            (d.battery !== undefined && d.battery < ctx.config.lowBatteryThreshold) ||
            d.battery_low === true,
        );
      }

      const sortBy = (args.sort_by as keyof Device | undefined) ?? "friendly_name";
      list = [...list].sort((a, b) => {
        const av = a[sortBy];
        const bv = b[sortBy];
        if (av === undefined && bv === undefined) return 0;
        if (av === undefined) return 1;
        if (bv === undefined) return -1;
        if (typeof av === "number" && typeof bv === "number") return av - bv;
        return String(av).localeCompare(String(bv));
      });

      const total = list.length;
      list = list.slice(0, num(args, "limit", { min: 1, max: 1000, fallback: 100 }));

      return { total, returned: list.length, capabilities, devices: list };
    },
  },

  {
    name: "z2m_get_device",
    tier: "read",
    annotations: readOnly("Get device detail"),
    description:
      "Get full detail for one device: current state, exposed properties, configurable device options with " +
      "their schema, endpoints, bindings and configured reportings. Read-only. Call this before " +
      "z2m_set_device_options, z2m_bind or z2m_configure_reporting to discover valid values. " +
      "Use z2m_list_devices instead when you want many devices or do not know the exact name.",
    inputSchema: {
      type: "object",
      properties: {
        device: DEVICE_ID,
        include_raw: {
          type: "boolean",
          description: "Include the raw exposes/options definitions (verbose). Default false.",
        },
      },
      required: ["device"],
    },
    handler: async (args, ctx) => {
      const { snap, raw } = await loadDevices(ctx);
      const target = findRaw(raw, String(args.device));
      const device = normalize(target, snap.deviceState, snap.availability);

      const result: Record<string, unknown> = {
        ...device,
        definition_source: target.definition?.source,
        model_id: target.model_id,
        exposes: summariseExposes(target.definition?.exposes),
        settable_options: (target.definition?.options ?? []).map((o: any) => ({
          property: o?.property,
          type: o?.type,
          description: o?.description,
          value_min: o?.value_min,
          value_max: o?.value_max,
          values: o?.values,
        })),
        endpoints: target.endpoints,
        current_state: snap.deviceState.get(target.friendly_name) ?? null,
      };
      if (args.include_raw) {
        result.raw_exposes = target.definition?.exposes;
        result.raw_options = target.definition?.options;
      }
      return result;
    },
  },

  {
    name: "z2m_health_report",
    tier: "read",
    annotations: readOnly("Audit estate health"),
    description:
      "Audit the whole Zigbee estate in one call and return everything that needs attention: offline devices, " +
      "weak links, stale devices, low batteries, failed or pending interviews, unsupported devices, disabled " +
      "devices, pending OTA updates, and devices that keep rejoining or changing network address. " +
      "Read-only and generates no Zigbee traffic, so prefer it over z2m_check_updates and z2m_network_map " +
      "for routine checks. Use this to answer 'is my Zigbee network healthy?'. " +
      "Returns {bridge, totals, capabilities, issues, hints}; an empty issues object means nothing is wrong. " +
      "Note that collect_seconds makes the call wait for that many seconds before answering.",
    inputSchema: {
      type: "object",
      properties: { collect_seconds: COLLECT_SECONDS },
    },
    handler: async (args, ctx) => {
      const { snap, devices, capabilities } = await loadDevices(ctx, args.collect_seconds);
      return buildHealthReport(
        devices,
        snap.info,
        snap.state,
        snap.health as Record<string, any> | undefined,
        capabilities,
        ctx.config,
      );
    },
  },

  {
    name: "z2m_network_map",
    tier: "read",
    annotations: readOnly("Scan mesh topology"),
    description:
      "Scan the Zigbee mesh topology and return per-device parent, depth, link quality and route count, plus " +
      "orphaned or weakly-attached devices. WARNING: the scan makes the network less responsive and can take " +
      "10 seconds to several minutes depending on estate size. Run it deliberately, not routinely, and prefer " +
      "z2m_health_report or z2m_list_devices when you only need per-device link quality. " +
      "Returns {node_count, link_count, orphans, weak, nodes[]} unless raw is set.",
    inputSchema: {
      type: "object",
      properties: {
        include_routes: { type: "boolean", description: "Include active routes. Slower. Default false." },
        raw: { type: "boolean", description: "Return the unsummarised graph. Default false." },
        timeout_ms: { type: "number", description: "Scan timeout. Default 180000." },
        max_nodes: { type: "number", description: "Cap the nodes returned. Default 200." },
      },
    },
    handler: async (args, ctx) => {
      const data = await ctx.client.request<any>(
        "networkmap",
        { type: "raw", routes: args.include_routes === true },
        num(args, "timeout_ms", { min: 1_000, max: 600_000, fallback: 180_000 }),
      );
      const value = data?.value ?? data;
      if (args.raw) return value;

      const allNodes: any[] = value?.nodes ?? [];
      const maxNodes = num(args, "max_nodes", { min: 1, max: 1000, fallback: 200 });
      const nodes = allNodes.slice(0, maxNodes);
      const links: any[] = value?.links ?? [];
      const byAddress = new Map<string, any>(nodes.map((n) => [n.ieeeAddr, n]));

      const summary = nodes.map((node) => {
        const inbound = links.filter((l) => l.targetIeeeAddr === node.ieeeAddr);
        const best = inbound.sort((a, b) => (b.linkquality ?? 0) - (a.linkquality ?? 0))[0];
        return {
          friendly_name: node.friendlyName,
          ieee_address: node.ieeeAddr,
          type: node.type,
          parent: best ? byAddress.get(best.sourceIeeeAddr)?.friendlyName ?? best.sourceIeeeAddr : null,
          linkquality: best?.linkquality,
          depth: best?.depth,
          relationship: best?.relationship,
          neighbour_count: inbound.length,
          route_count: best?.routes?.length ?? 0,
        };
      });

      return {
        node_count: nodes.length,
        link_count: links.length,
        orphans: summary.filter((n) => n.parent === null && n.type !== "Coordinator"),
        weak: summary.filter(
          (n) => n.linkquality !== undefined && n.linkquality < ctx.config.weakLinkThreshold,
        ),
        nodes: summary,
      };
    },
  },

  {
    name: "z2m_list_groups",
    tier: "read",
    annotations: readOnly("List groups"),
    description:
      "List Zigbee groups with their members and scenes. Read-only. " +
      "Use z2m_manage_group to change groups, and z2m_list_devices for individual devices. " +
      "Returns {total, groups[]}; an empty list means no groups are defined.",
    inputSchema: EMPTY,
    handler: async (_args, ctx) => {
      const snap = await ctx.client.snapshot();
      return { total: snap.groups.length, groups: snap.groups };
    },
  },

  {
    name: "z2m_get_logs",
    tier: "read",
    annotations: readOnly("Read bridge logs"),
    description:
      "Read Zigbee2MQTT bridge logs and lifecycle events (device_joined, device_interview, device_leave, " +
      "device_announce). Read-only. Returns buffered history by default; watch_seconds instead blocks for " +
      "that many seconds collecting new lines. Logs are only captured while this server is connected, so " +
      "history may be empty on a fresh start — use watch_seconds then. Use to diagnose pairing failures and " +
      "rejoin loops; prefer z2m_health_report to find which devices are affected in the first place.",
    inputSchema: {
      type: "object",
      properties: {
        level: {
          type: "string",
          enum: ["error", "warning", "info"],
          description: "Minimum severity. Note: Zigbee2MQTT never publishes debug lines to MQTT.",
        },
        contains: { type: "string", description: "Only lines containing this substring (case-insensitive)." },
        watch_seconds: {
          type: "number",
          description: "Collect new lines live for this many seconds instead of returning buffered history. Max 120.",
        },
        limit: { type: "number", description: "Maximum lines to return. Default 100." },
        include_events: { type: "boolean", description: "Include bridge lifecycle events. Default true." },
      },
    },
    handler: async (args, ctx) => {
      const rank: Record<string, number> = { error: 3, warning: 2, warn: 2, info: 1 };
      const min = args.level ? rank[String(args.level)] ?? 0 : 0;

      let lines = args.watch_seconds
        ? await ctx.client.collectLogs(num(args, "watch_seconds", { min: 1, max: 120 }) * 1000)
        : [...ctx.client.recentLogs()];

      lines = lines.filter((l) => (rank[l.level] ?? 1) >= min);
      if (args.contains) {
        const needle = String(args.contains).toLowerCase();
        lines = lines.filter((l) => l.message.toLowerCase().includes(needle));
      }
      const limit = num(args, "limit", { min: 1, max: 1000, fallback: 100 });

      return {
        note: ctx.client.recentLogs().length === 0 && !args.watch_seconds
          ? "No logs buffered yet. Logs are captured only while this server is connected; use watch_seconds to collect live."
          : undefined,
        logs: lines.slice(-limit),
        events: args.include_events === false ? undefined : ctx.client.recentEvents().slice(-limit),
      };
    },
  },
  {
    name: "z2m_coordinator_check",
    tier: "read",
    annotations: readOnly("Check coordinator memory"),
    description:
      "Check whether any routers are missing from the coordinator's memory, which causes pairing failures and " +
      "devices dropping off. Changes nothing, but queries the coordinator directly. Only supported on Texas " +
      "Instruments adapters (CC2652/CC1352); other adapters return an error — z2m_bridge_info reports whether " +
      "yours qualifies under capabilities.coordinator_check. Returns {missing_routers[]}; an empty list is " +
      "healthy. Use z2m_network_map for a topology view on any adapter.",
    inputSchema: EMPTY,
    handler: async (_args, ctx) => ctx.client.request("coordinator_check", {}, 60_000),
  },
];

// ----------------------------------------------------------- safe write tools

const safeTools: ToolDef[] = [
  {
    name: "z2m_check_updates",
    tier: "safe",
    annotations: mutating("Check for firmware updates", { idempotent: true }),
    description:
      "Actively query devices for available OTA firmware updates. Changes no configuration, but it does put " +
      "real traffic on the Zigbee network and can take a minute per device. Without arguments it checks every " +
      "mains-powered router. Prefer z2m_health_report for a passive answer at no network cost, and use this " +
      "only when you need a fresh check. Follow with z2m_ota_update to actually flash.",
    inputSchema: {
      type: "object",
      properties: {
        device: { ...DEVICE_ID, description: "Check a single device. Omit to check all mains-powered devices." },
        timeout_ms: { type: "number", description: "Per-device timeout. Default 60000." },
        max_devices: {
          type: "number",
          description: "Stop after this many devices so the call returns before a client times out. Default 10.",
        },
        offset: { type: "number", description: "Skip this many devices, to continue a previous sweep." },
      },
    },
    handler: async (args, ctx) => {
      const { raw } = await loadDevices(ctx);
      const timeout = num(args, "timeout_ms", { min: 1_000, max: 600_000, fallback: 60_000 });
      // Mains-powered covers routers and anything else Zigbee2MQTT reports
      // as mains powered; battery devices sleep and would just time out.
      const candidates = args.device
        ? [findRaw(raw, String(args.device))]
        : raw.filter(
            (d) =>
              d.disabled !== true &&
              (d.type === "Router" || (d.power_source ?? "").toLowerCase() === "mains (single phase)"),
          );

      const offset = num(args, "offset", { fallback: 0 });
      const maxDevices = num(args, "max_devices", { min: 1, max: 100, fallback: 10 });
      const targets = candidates.slice(offset, offset + maxDevices);
      const remaining = Math.max(0, candidates.length - (offset + targets.length));

      const results: unknown[] = [];
      for (const target of targets) {
        try {
          const data = await ctx.client.request<any>(
            "device/ota_update/check",
            { id: target.friendly_name },
            timeout,
          );
          results.push({ device: target.friendly_name, ...data });
        } catch (error) {
          results.push({ device: target.friendly_name, error: (error as Error).message });
        }
      }
      return {
        checked: results.length,
        total_candidates: candidates.length,
        remaining,
        ...(remaining > 0 ? { next_offset: offset + targets.length } : {}),
        results,
      };
    },
  },

  {
    name: "z2m_permit_join",
    tier: "safe",
    annotations: mutating("Open or close pairing", { idempotent: true }),
    description:
      "Open or close the network for new devices to join. While open, any nearby Zigbee device may join, so " +
      "keep the window short and close it with time=0 when finished. Optionally scope joining to a single " +
      "router, which is the recommended way to pair a device into a specific part of the mesh. " +
      "Use z2m_bridge_info to see whether joining is currently open.",
    inputSchema: {
      type: "object",
      properties: {
        time: {
          type: "number",
          description: "Seconds to allow joining. 0 closes the network. Maximum 254.",
        },
        device: {
          type: "string",
          description: "Restrict joining to this router's friendly_name, or 'coordinator'. Omit to allow via any router.",
        },
      },
      required: ["time"],
    },
    handler: async (args, ctx) => {
      const payload: Record<string, unknown> = { time: num(args, "time", { min: 0, max: 254 }) };
      if (args.device) payload.device = String(args.device);
      return ctx.client.request("permit_join", payload);
    },
  },

  {
    name: "z2m_set_device_options",
    tier: "safe",
    annotations: mutating("Set device options", { idempotent: true }),
    description:
      "Change Zigbee2MQTT device options such as transition, retain, debounce, temperature_precision or " +
      "calibration offsets. Options are merged, not replaced, and persist in the Zigbee2MQTT configuration. " +
      "Call z2m_get_device first to see settable_options for that device. Use z2m_set_state to change what a " +
      "device is doing, and z2m_set_bridge_options for bridge-wide settings. The response reports whether a " +
      "bridge restart is required.",
    inputSchema: {
      type: "object",
      properties: {
        device: DEVICE_ID,
        options: { type: "object", description: 'Options to merge, e.g. {"transition": 1, "retain": true}.' },
      },
      required: ["device", "options"],
    },
    handler: async (args, ctx) => {
      const { raw } = await loadDevices(ctx);
      const target = findRaw(raw, String(args.device));
      return ctx.client.request("device/options", { id: target.friendly_name, options: args.options });
    },
  },

  {
    name: "z2m_rename_device",
    tier: "safe",
    annotations: mutating("Rename device", { destructive: true }),
    description:
      "Rename a device's friendly_name. Renaming changes its MQTT topic, so anything referencing the old " +
      "name (automations, dashboards, scripts) breaks until updated — this is reversible only by renaming " +
      "back. Set homeassistant_rename to also rename the Home Assistant entity. " +
      "Use z2m_set_device_options for behaviour changes that do not affect the topic.",
    inputSchema: {
      type: "object",
      properties: {
        device: DEVICE_ID,
        new_name: { type: "string", description: "New friendly_name. '/' creates folder structure in MQTT." },
        homeassistant_rename: {
          type: "boolean",
          description: "Also update the Home Assistant entity ID. Default false.",
        },
      },
      required: ["device", "new_name"],
    },
    handler: async (args, ctx) => {
      const { raw } = await loadDevices(ctx);
      const target = findRaw(raw, String(args.device));
      return ctx.client.request("device/rename", {
        from: target.friendly_name,
        to: String(args.new_name),
        homeassistant_rename: args.homeassistant_rename === true,
      });
    },
  },

  {
    name: "z2m_configure_device",
    tier: "safe",
    annotations: mutating("Reconfigure device", { idempotent: true }),
    description:
      "Re-run a device's configuration routine (bindings and attribute reporting). Use when a device stopped " +
      "reporting values. Battery devices must be woken immediately before calling this, or it fails after a " +
      "timeout. Use z2m_interview_device instead when Zigbee2MQTT does not know the device's capabilities at " +
      "all, and z2m_configure_reporting to change one specific attribute rather than re-running everything.",
    inputSchema: { type: "object", properties: { device: DEVICE_ID }, required: ["device"] },
    handler: async (args, ctx) => {
      const { raw } = await loadDevices(ctx);
      const target = findRaw(raw, String(args.device));
      return ctx.client.request("device/configure", { id: target.friendly_name }, 60_000);
    },
  },

  {
    name: "z2m_interview_device",
    tier: "safe",
    annotations: mutating("Re-interview device", { idempotent: true }),
    description:
      "Re-interview a device so Zigbee2MQTT re-reads its endpoints, clusters and basic attributes. The device " +
      "may be briefly unavailable while this runs, and battery devices must be awake. Useful after a firmware " +
      "upgrade adds functionality, or to recover a device stuck in a failed interview — check interview_state " +
      "via z2m_get_device first. Use z2m_configure_device instead when the interview succeeded but reporting " +
      "stopped working.",
    inputSchema: { type: "object", properties: { device: DEVICE_ID }, required: ["device"] },
    handler: async (args, ctx) => {
      const { raw } = await loadDevices(ctx);
      const target = findRaw(raw, String(args.device));
      return ctx.client.request("device/interview", { id: target.friendly_name }, 120_000);
    },
  },

  {
    name: "z2m_set_state",
    tier: "safe",
    annotations: mutating("Set or read device state"),
    description:
      "Send a state command to a device or group, e.g. {\"state\":\"ON\"} or {\"brightness\":128}. " +
      "Physically changes what the device is doing, and is reversible by sending the opposite command. " +
      "mode='get' instead requests a value without changing anything. The command is published without " +
      "waiting for the device, so success here means the message was sent, not that the device acted — read " +
      "z2m_get_device afterwards to confirm. Consult z2m_get_device exposes for valid properties.",
    inputSchema: {
      type: "object",
      properties: {
        device: { type: "string", description: "Device or group friendly_name, or ieee_address." },
        payload: { type: "object", description: 'Command payload, e.g. {"state": "ON"}.' },
        mode: { type: "string", enum: ["set", "get"], description: "Default 'set'." },
      },
      required: ["device", "payload"],
    },
    handler: async (args, ctx) => {
      const snap = await ctx.client.snapshot();
      const raw = (snap.devices as RawDevice[]).filter((d) => !isCoordinator(d));
      const groupNames = (snap.groups as any[]).map((g) => String(g.friendly_name));
      const id = String(args.device);
      const name = groupNames.some((g) => g.toLowerCase() === id.toLowerCase())
        ? id
        : findRaw(raw, id).friendly_name;

      const mode = args.mode === "get" ? "get" : "set";
      await ctx.client.publish(`${ctx.config.baseTopic}/${name}/${mode}`, args.payload);
      return { published_to: `${ctx.config.baseTopic}/${name}/${mode}`, payload: args.payload };
    },
  },

  {
    name: "z2m_manage_group",
    tier: "safe",
    annotations: mutating("Manage groups", { destructive: true }),
    description:
      "Create or remove groups, rename them, and add or remove device members. Groups let a single Zigbee " +
      "multicast control many devices, which is far more responsive than commanding each device in turn. " +
      "Removing a group does not affect the devices themselves, but fails if a member is unreachable unless " +
      "force is set — with force the device keeps the group membership internally. Use z2m_list_groups to " +
      "inspect groups first, and z2m_set_state to control a group once created. The remove and " +
      "remove_all_members actions discard configuration and need confirm=true.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["add", "remove", "rename", "add_member", "remove_member", "remove_all_members"],
        },
        group: { type: "string", description: "Group friendly_name or numeric ID." },
        new_name: { type: "string", description: "Required for action=rename." },
        id: { type: "number", description: "Optional numeric ID for action=add." },
        device: { type: "string", description: "Device for member actions." },
        endpoint: {
          type: ["string", "number"],
          description: "Endpoint for member actions, e.g. 'l1' or 1. Defaults to the device's default endpoint.",
        },
        force: { type: "boolean", description: "Force removal even if a member device is unreachable." },
        confirm: { type: "boolean", description: "Required for action=remove and action=remove_all_members." },
      },
      required: ["action", "group"],
    },
    handler: async (args, ctx) => {
      const group = String(args.group);
      switch (args.action) {
        case "add":
          return ctx.client.request("group/add", {
            friendly_name: group,
            ...(args.id !== undefined ? { id: num(args, "id", { min: 1, max: 65_535 }) } : {}),
          });
        case "remove":
          requireConfirm(args, `Removing group '${group}'`);
          return ctx.client.request("group/remove", { id: group, force: args.force === true });
        case "rename":
          if (!args.new_name) throw new Error("new_name is required for action=rename");
          return ctx.client.request("group/rename", { from: group, to: String(args.new_name) });
        case "add_member":
          if (!args.device) throw new Error("device is required for action=add_member");
          return ctx.client.request("group/members/add", {
            group,
            device: String(args.device),
            ...(args.endpoint !== undefined ? { endpoint: args.endpoint } : {}),
          });
        case "remove_member":
          if (!args.device) throw new Error("device is required for action=remove_member");
          return ctx.client.request("group/members/remove", {
            group,
            device: String(args.device),
            ...(args.endpoint !== undefined ? { endpoint: args.endpoint } : {}),
          });
        case "remove_all_members":
          requireConfirm(args, `Removing every member of group '${group}'`);
          return ctx.client.request("group/members/remove_all", { group });
        default:
          throw new Error(`Unknown action '${args.action}'`);
      }
    },
  },

  {
    name: "z2m_bind",
    tier: "safe",
    annotations: mutating("Bind or unbind clusters", { destructive: true }),
    description:
      "Bind or unbind clusters between two devices, or between a device and a group. Binding lets a remote " +
      "control a light directly over Zigbee without a round trip through the coordinator, so it keeps working " +
      "even if the bridge is down. Reversible with action='unbind'; action='clear' removes all binds from the " +
      "source device at once and needs confirm=true, because the previous set cannot be recovered. " +
      "To target one button of a multi-button remote, pass from_endpoint and to_endpoint as separate " +
      "arguments — check z2m_get_device endpoints first. Both devices must be awake.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["bind", "unbind", "clear"] },
        from: { type: "string", description: "Source device friendly_name or ieee_address." },
        to: { type: "string", description: "Target device or group. Not needed for action=clear." },
        from_endpoint: {
          type: ["string", "number"],
          description: "Source endpoint, e.g. 'left' or 1. Defaults to the device's default endpoint.",
        },
        to_endpoint: {
          type: ["string", "number"],
          description: "Target endpoint. Only meaningful when the target is a device, not a group.",
        },
        clusters: {
          type: "array",
          items: { type: "string" },
          description: "Clusters to bind, e.g. ['genOnOff','genLevelCtrl']. Omit to bind all supported clusters.",
        },
        ieee_list: {
          type: "array",
          items: { type: "string" },
          description: "For action=clear: specific bind targets to remove. Omit to clear every binding.",
        },
        confirm: { type: "boolean", description: "Required for action=clear." },
      },
      required: ["action", "from"],
    },
    handler: async (args, ctx) => {
      if (args.action === "clear") {
        requireConfirm(args, `Clearing every binding from '${String(args.from)}'`);
        // Zigbee2MQTT rejects anything without a string `target` as "Invalid payload".
        const clear: Record<string, unknown> = { target: String(args.from) };
        if (Array.isArray(args.ieee_list) && args.ieee_list.length > 0) clear.ieee_list = args.ieee_list;
        return ctx.client.request("device/binds/clear", clear, 60_000);
      }
      if (!args.to) throw new Error("'to' is required for bind and unbind");
      const payload: Record<string, unknown> = { from: String(args.from), to: String(args.to) };
      if (args.from_endpoint !== undefined) payload.from_endpoint = args.from_endpoint;
      if (args.to_endpoint !== undefined) payload.to_endpoint = args.to_endpoint;
      if (Array.isArray(args.clusters) && args.clusters.length > 0) payload.clusters = args.clusters;
      return ctx.client.request(args.action === "bind" ? "device/bind" : "device/unbind", payload, 60_000);
    },
  },

  {
    name: "z2m_configure_reporting",
    tier: "safe",
    annotations: mutating("Configure attribute reporting", { idempotent: true }),
    description:
      "Configure how often a device reports an attribute. Tightening intervals improves responsiveness; " +
      "loosening them saves battery. Set maximum_report_interval to 65535 to disable reporting. " +
      "Battery devices must be woken immediately before calling this, and not all devices support the " +
      "command. Use z2m_get_device to see existing configured_reportings, and z2m_configure_device to " +
      "re-run the whole default configuration instead of one attribute.",
    inputSchema: {
      type: "object",
      properties: {
        device: DEVICE_ID,
        endpoint: { type: "number", description: "Endpoint ID. Default 1." },
        cluster: { type: "string", description: "Cluster name, e.g. 'genLevelCtrl'." },
        attribute: { type: "string", description: "Attribute name, e.g. 'currentLevel'." },
        minimum_report_interval: { type: "number", description: "Seconds. 0 means report on every change." },
        maximum_report_interval: { type: "number", description: "Seconds. 65535 disables reporting." },
        reportable_change: { type: "number", description: "Minimum change worth reporting, in the attribute's unit." },
      },
      required: ["device", "cluster", "attribute", "minimum_report_interval", "maximum_report_interval"],
    },
    handler: async (args, ctx) => {
      const { raw } = await loadDevices(ctx);
      const target = findRaw(raw, String(args.device));
      return ctx.client.request(
        "device/reporting/configure",
        {
          id: target.friendly_name,
          endpoint: num(args, "endpoint", { min: 1, max: 255, fallback: 1 }),
          cluster: String(args.cluster),
          attribute: String(args.attribute),
          minimum_report_interval: num(args, "minimum_report_interval", { max: 65_535 }),
          maximum_report_interval: num(args, "maximum_report_interval", { max: 65_535 }),
          ...(args.reportable_change !== undefined
            ? { reportable_change: num(args, "reportable_change") }
            : {}),
        },
        60_000,
      );
    },
  },
];

// ----------------------------------------------------------- full write tools

const fullTools: ToolDef[] = [
  {
    name: "z2m_remove_device",
    tier: "full",
    annotations: mutating("Remove device from network", { destructive: true }),
    description:
      "Remove a device from the Zigbee network. IRREVERSIBLE: the device must be re-paired afterwards, and " +
      "its automations and history references break. The coordinator can only ask a device to leave, so " +
      "sleeping battery devices often fail unless woken. force=true deletes it from the database only, " +
      "leaving it holding the network key until factory reset. Requires confirm=true. " +
      "Prefer disabling a device in Zigbee2MQTT if you only want it to stop reporting.",
    inputSchema: {
      type: "object",
      properties: {
        device: DEVICE_ID,
        force: { type: "boolean", description: "Delete from the database even if the device does not respond." },
        block: { type: "boolean", description: "Prevent the device from rejoining." },
        confirm: { type: "boolean", description: "Must be true to proceed." },
      },
      required: ["device", "confirm"],
    },
    handler: async (args, ctx) => {
      requireConfirm(args, "Removing a device");
      const { raw } = await loadDevices(ctx);
      const target = findRaw(raw, String(args.device));
      return ctx.client.request(
        "device/remove",
        {
          id: target.friendly_name,
          force: args.force === true,
          block: args.block === true,
        },
        60_000,
      );
    },
  },

  {
    name: "z2m_ota_update",
    tier: "full",
    annotations: mutating("Flash device firmware", { destructive: true }),
    description:
      "Flash a device's firmware over the air. IRREVERSIBLE and high risk: it can take many minutes, must not " +
      "be interrupted, and can brick the device if it loses power. Run z2m_check_updates first to confirm an " +
      "update exists. Use action='schedule' to defer the flash until the device next checks in, which is " +
      "safer for battery devices, and action='abort' to stop one in progress. Requires confirm=true.",
    inputSchema: {
      type: "object",
      properties: {
        device: DEVICE_ID,
        action: {
          type: "string",
          enum: ["update", "abort", "schedule", "unschedule"],
          description: "Default 'update'. 'schedule' defers the flash until the device next checks in.",
        },
        timeout_ms: { type: "number", description: "Default 1800000 (30 minutes)." },
        confirm: { type: "boolean", description: "Must be true to proceed." },
      },
      required: ["device", "confirm"],
    },
    handler: async (args, ctx) => {
      requireConfirm(args, "Flashing firmware");
      const { raw } = await loadDevices(ctx);
      const target = findRaw(raw, String(args.device));
      const action = String(args.action ?? "update");
      const topic =
        action === "abort"
          ? "device/ota_update/update/abort"
          : action === "schedule"
            ? "device/ota_update/schedule"
            : action === "unschedule"
              ? "device/ota_update/unschedule"
              : "device/ota_update/update";
      const timeoutMs = num(args, "timeout_ms", { min: 1_000, max: 3_600_000, fallback: 1_800_000 });
      return ctx.client.request(topic, { id: target.friendly_name }, timeoutMs);
    },
  },

  {
    name: "z2m_restart_bridge",
    tier: "full",
    annotations: mutating("Restart Zigbee2MQTT", { destructive: true, idempotent: true }),
    description:
      "Restart Zigbee2MQTT. Briefly interrupts all Zigbee control and drops in-flight commands; the mesh " +
      "itself is unaffected and devices reconnect automatically. Needed after changing options that report " +
      "restart_required=true, which z2m_bridge_info also shows. Requires confirm=true.",
    inputSchema: {
      type: "object",
      properties: { confirm: { type: "boolean", description: "Must be true to proceed." } },
      required: ["confirm"],
    },
    handler: async (args, ctx) => {
      requireConfirm(args, "Restarting Zigbee2MQTT");
      return ctx.client.request("restart", {}, 30_000);
    },
  },

  {
    name: "z2m_set_bridge_options",
    tier: "full",
    annotations: mutating("Change bridge configuration", { destructive: true, idempotent: true }),
    description:
      "Change Zigbee2MQTT configuration at runtime, e.g. log level, availability or last_seen. Changes are " +
      "written to the Zigbee2MQTT configuration and persist across restarts, so a bad value can affect the " +
      "whole installation. Options are merged into the existing config. The config schema is available via " +
      "z2m_bridge_info with include_config=true. Some changes report restart_required, which needs " +
      "z2m_restart_bridge. Use z2m_set_device_options for a single device instead. Requires confirm=true.",
    inputSchema: {
      type: "object",
      properties: {
        options: {
          type: "object",
          description: 'Nested config fragment, e.g. {"advanced": {"last_seen": "ISO_8601"}}.',
        },
        confirm: { type: "boolean", description: "Must be true to proceed." },
      },
      required: ["options", "confirm"],
    },
    handler: async (args, ctx) => {
      requireConfirm(args, "Changing bridge configuration");
      return ctx.client.request("options", { options: args.options }, 30_000);
    },
  },

  {
    name: "z2m_touchlink",
    tier: "full",
    annotations: mutating("Touchlink scan, identify or reset", { destructive: true }),
    description:
      "Touchlink scan, identify or factory reset. action='scan' and 'identify' are harmless; " +
      "action='factory_reset' is IRREVERSIBLE. Pass both ieee_address and channel to target a device, and " +
      "run 'scan' first to discover them. Supplying only one is rejected rather than falling back. Set " +
      "nearest=true to act on whichever Touchlink device is physically closest, which may not be the one " +
      "you intend. Use z2m_remove_device for a device already paired to this network. Requires confirm=true.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["scan", "identify", "factory_reset"] },
        ieee_address: { type: "string", description: "Target address. Required together with channel." },
        channel: { type: "number", description: "Target channel. Required together with ieee_address." },
        nearest: {
          type: "boolean",
          description: "Act on the physically nearest device instead of a named target.",
        },
        confirm: { type: "boolean", description: "Must be true to proceed." },
      },
      required: ["action", "confirm"],
    },
    handler: async (args, ctx) => {
      requireConfirm(args, "Touchlink");
      const action = String(args.action);
      const hasAddress = args.ieee_address !== undefined && String(args.ieee_address) !== "";
      const hasChannel = args.channel !== undefined;

      // Zigbee2MQTT treats an empty payload as "act on the first device found",
      // so a half-specified target must never fall through to it.
      if (hasAddress !== hasChannel) {
        throw new Error(
          `Touchlink ${action} needs both ieee_address and channel, or neither. ` +
            `Run action='scan' to discover the ${hasAddress ? "channel" : "address"}.`,
        );
      }

      let payload: Record<string, unknown> = {};
      if (hasAddress) {
        if (args.nearest === true) {
          throw new Error("Pass either ieee_address with channel, or nearest=true, not both.");
        }
        payload = { ieee_address: String(args.ieee_address), channel: num(args, "channel") };
      } else if (action !== "scan" && args.nearest !== true) {
        throw new Error(
          `Touchlink ${action} without a target acts on the physically nearest device and cannot be ` +
            "undone. Pass ieee_address and channel, or set nearest=true to accept that.",
        );
      }

      return ctx.client.request(`touchlink/${action}`, payload, 120_000);
    },
  },
];

const TIER_RANK: Record<Tier, number> = { read: 0, safe: 1, full: 2 };

export function selectTools(mode: Config["writeMode"]): ToolDef[] {
  const all = [...readTools, ...safeTools, ...fullTools];
  if (mode === "off") return all.filter((t) => t.tier === "read");
  const max = TIER_RANK[mode];
  return all.filter((t) => TIER_RANK[t.tier] <= max);
}
