import mqtt, { type IClientOptions, type MqttClient } from "mqtt";
import type { Config, Logger } from "./config.js";
import { redactUrl, scrubSecrets } from "./redact.js";
import { classifyTopic } from "./topics.js";

export interface BridgeResponse<T = unknown> {
  status: "ok" | "error";
  data?: T;
  error?: string;
  transaction?: string | number;
}

export interface LogEntry {
  received_at: string;
  level: string;
  message: string;
  namespace?: string;
}

export interface BridgeEvent {
  received_at: string;
  type: string;
  data: Record<string, unknown>;
}

/**
 * Correlates bridge/request with bridge/response. Both sides must build the key
 * identically or every write tool times out, so it lives in one place.
 */
export function waiterKey(subTopic: string, transaction: string | number | undefined): string {
  return `${subTopic}|${transaction ?? ""}`;
}

/**
 * The broker accepted the connection but published no Zigbee2MQTT bridge data.
 * Distinguished from a connection failure because the remedy is different: the
 * base topic is wrong, or Zigbee2MQTT is not running against this broker.
 */
export class NoBridgeDataError extends Error {
  readonly name = "NoBridgeDataError";
}

export interface ConnectionStatus {
  connected: boolean;
  broker_url: string;
  base_topic: string;
  client_id: string;
  write_mode: string;
  tls: {
    enabled: boolean;
    reject_unauthorized: boolean;
    custom_ca: boolean;
    client_certificate: boolean;
  };
  authenticated: boolean;
  /** True once the broker completed a CONNACK, even if the session later failed. */
  broker_handshake: boolean;
  cached: {
    bridge_topics: number;
    device_state: number;
    availability: number;
    logs: number;
    events: number;
  };
  last_message_at: string | null;
}

const LOG_BUFFER = 1000;
const EVENT_BUFFER = 200;

/**
 * Requests that do not change bridge state, so callers need not wait for a
 * retained republish. `restart` is included because the bridge goes away rather
 * than republishing.
 */
const NON_MUTATING = new Set([
  "networkmap",
  "health_check",
  "coordinator_check",
  "backup",
  "restart",
  "device/ota_update/check",
  "device/ota_update/check/downgrade",
  "device/reporting/read",
]);

/**
 * Zigbee2MQTT publishes its bridge topics as retained messages, so a fresh
 * subscription yields a complete picture within milliseconds. This client keeps
 * only the latest payload per topic in memory - there is deliberately no
 * database and no message history.
 */
export class Z2MClient {
  private client: MqttClient | null = null;
  private connectPromise: Promise<void> | null = null;
  private transactionCounter = 0;
  private lastMessageAt = 0;
  private bridgeRevision = 0;
  private brokerHandshake = false;

  private readonly bridge = new Map<string, unknown>();
  private readonly deviceState = new Map<string, Record<string, unknown>>();
  private readonly availability = new Map<string, string>();
  private readonly logs: LogEntry[] = [];
  private readonly events: BridgeEvent[] = [];
  private readonly waiters = new Map<string, (response: BridgeResponse) => void>();

  /** Never interpolate config.mqttUrl into a message; it may carry credentials. */
  private readonly safeUrl: string;

  constructor(
    private readonly config: Config,
    private readonly log: Logger,
  ) {
    this.safeUrl = redactUrl(config.mqttUrl);
  }

  // ---------------------------------------------------------------- lifecycle

  async connect(): Promise<void> {
    if (this.client?.connected) return;
    // A client that exists but is not connected is mid-reconnect. Dialling
    // again would orphan it and flap the shared client ID on the broker.
    if (this.client && !this.connectPromise) {
      await this.awaitReconnect();
      return;
    }
    if (!this.connectPromise) {
      this.connectPromise = this.doConnect().finally(() => {
        this.connectPromise = null;
      });
    }
    return this.connectPromise;
  }

  private doConnect(): Promise<void> {
    const { config } = this;
    const options: IClientOptions = {
      username: config.username,
      password: config.password,
      clientId: config.clientId,
      // A clean session avoids leaving orphaned subscriptions on the broker
      // every time the MCP server restarts. Retained messages arrive regardless.
      clean: true,
      reconnectPeriod: 5_000,
      connectTimeout: config.connectTimeoutMs,
      rejectUnauthorized: config.rejectUnauthorized,
      ca: config.ca,
      cert: config.cert,
      key: config.key,
    };

    return new Promise((resolve, reject) => {
      this.log.debug(`connecting to ${this.safeUrl}`);
      const client = mqtt.connect(config.mqttUrl, options);
      this.client = client;

      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        client.end(true);
        this.client = null;
        reject(error);
      };

      const timer = setTimeout(
        () => fail(new Error(`Timed out connecting to ${this.safeUrl} after ${config.connectTimeoutMs}ms`)),
        config.connectTimeoutMs,
      );

      client.on("error", (error) => {
        this.log.error("mqtt error:", scrubSecrets(error.message, config));
        fail(new Error(`MQTT connection to ${this.safeUrl} failed: ${scrubSecrets(error.message, config)}`));
      });

      client.on("message", (topic, payload) => this.handleMessage(topic, payload));
      client.on("close", () => this.log.debug("mqtt connection closed"));
      client.on("reconnect", () => this.log.debug("mqtt reconnecting"));

      client.once("connect", () => {
        this.brokerHandshake = true;
        // `once`: mqtt.js re-emits this on every reconnect, and a second
        // waitForBridgeData poll would be pure dead work.
        this.log.debug("connected, subscribing");
        client.subscribe(`${config.baseTopic}/#`, { qos: 1 }, (error) => {
          if (error) {
            fail(new Error(`Failed to subscribe to ${config.baseTopic}/#: ${error.message}`));
            return;
          }
          // Give retained bridge topics a moment to land before the first read.
          this.waitForBridgeData()
            .then(() => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              resolve();
            })
            .catch(fail);
        });
      });
    });
  }

  /** Lets mqtt.js finish its own reconnect instead of opening a rival client. */
  private async awaitReconnect(): Promise<void> {
    const deadline = Date.now() + this.config.connectTimeoutMs;
    while (Date.now() < deadline) {
      if (this.client?.connected) return;
      if (!this.client) break;
      await sleep(100);
    }
    if (!this.client?.connected) {
      throw new Error(
        `Lost the connection to ${this.safeUrl} and it has not come back within ` +
          `${this.config.connectTimeoutMs}ms. Check that the broker is reachable.`,
      );
    }
  }

  private async waitForBridgeData(timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !(this.bridge.has("devices") && this.bridge.has("info"))) {
      await sleep(25);
    }
    if (!this.bridge.has("devices")) {
      throw new NoBridgeDataError(
        `Connected to the broker but received no retained '${this.config.baseTopic}/bridge/devices' ` +
          `message within ${timeoutMs}ms. Check that Zigbee2MQTT is running and that Z2M_BASE_TOPIC ` +
          `(currently '${this.config.baseTopic}') matches its mqtt.base_topic setting.`,
      );
    }
    // Retained per-device availability topics arrive in a burst just after the
    // bridge topics. Resolving too early loses them, so wait for a quiet period.
    await this.settle(250, 2_000);
  }

  /** Wait until no message has arrived for `quietMs`, capped at `maxMs`. */
  async settle(quietMs: number, maxMs: number): Promise<void> {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline && Date.now() - this.lastMessageAt < quietMs) {
      await sleep(25);
    }
  }

  async disconnect(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (!client) return;
    // Drop the error handler first: a reconnect attempt racing the close would
    // otherwise surface a spurious 'write after end'.
    client.removeAllListeners("error");
    client.on("error", () => undefined);
    await new Promise<void>((resolve) => client.end(false, {}, () => resolve()));
  }

  // ----------------------------------------------------------------- messages

  /** Exposed for tests; the live path is the client's 'message' event. */
  handleMessage(topic: string, payload: Buffer): void {
    const route = classifyTopic(this.config.baseTopic, topic);
    if (route.kind === "foreign") return;
    this.lastMessageAt = Date.now();
    const raw = payload.toString();
    const parsed = safeParse(raw);

    switch (route.kind) {
      case "response":
        this.resolveWaiter(route.subTopic, parsed);
        return;

      case "logging": {
        const entry = parsed as Partial<LogEntry> | null;
        if (entry && typeof entry === "object") {
          push(this.logs, LOG_BUFFER, {
            received_at: new Date().toISOString(),
            level: String(entry.level ?? "info"),
            // Zigbee2MQTT logs its own broker URL at startup, credentials included.
            message: scrubSecrets(String(entry.message ?? raw), this.config),
            namespace: entry.namespace,
          });
        }
        return;
      }

      case "event": {
        const event = parsed as { type?: string; data?: Record<string, unknown> } | null;
        if (event && typeof event === "object") {
          push(this.events, EVENT_BUFFER, {
            received_at: new Date().toISOString(),
            type: String(event.type ?? "unknown"),
            data: event.data ?? {},
          });
        }
        return;
      }

      case "bridge":
        // We subscribe to the whole base topic, so our own publishes to
        // bridge/request/* come straight back. Caching them would inflate the
        // topic count and, worse, satisfy awaitBridgeRefresh before
        // Zigbee2MQTT has republished anything.
        if (route.name.startsWith("request/")) return;
        this.bridge.set(route.name, parsed ?? raw);
        this.bridgeRevision++;
        if (route.name === "devices") this.pruneStaleState();
        return;

      case "availability": {
        const state =
          typeof parsed === "object" && parsed !== null
            ? String((parsed as { state?: unknown }).state ?? raw)
            : raw;
        this.availability.set(route.device, state);
        return;
      }

      case "command":
        return;

      case "state":
        if (parsed && typeof parsed === "object") {
          this.deviceState.set(route.device, parsed as Record<string, unknown>);
        }
        return;

      default: {
        // Adding a TopicRoute variant without handling it is a compile error,
        // rather than messages being silently dropped.
        const unhandled: never = route;
        void unhandled;
      }
    }
  }

  /**
   * Renames and removals would otherwise leave their old keys behind forever,
   * and these two maps are the only caches without a bound.
   */
  private pruneStaleState(): void {
    const devices = this.bridge.get("devices") as { friendly_name?: string }[] | undefined;
    if (!Array.isArray(devices) || devices.length === 0) return;
    const known = new Set(devices.map((d) => d.friendly_name).filter((n): n is string => typeof n === "string"));
    for (const name of this.deviceState.keys()) if (!known.has(name)) this.deviceState.delete(name);
    for (const name of this.availability.keys()) if (!known.has(name)) this.availability.delete(name);
  }

  private resolveWaiter(subTopic: string, parsed: unknown): void {
    if (!parsed || typeof parsed !== "object") return;
    const response = parsed as BridgeResponse;
    const waiter = this.waiters.get(waiterKey(subTopic, response.transaction));
    if (waiter) waiter(response);
  }

  // ----------------------------------------------------------------- requests

  /**
   * Publish to bridge/request/<subTopic> and await the matching
   * bridge/response/<subTopic>, correlated via the `transaction` property.
   */
  async request<T = unknown>(
    subTopic: string,
    payload: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<T> {
    await this.connect();
    const client = this.client;
    if (!client) throw new Error("MQTT client is not connected");

    const timeout = timeoutMs ?? this.config.requestTimeoutMs;
    const transaction = `mcp-${++this.transactionCounter}`;
    const key = waiterKey(subTopic, transaction);
    const revisionBefore = this.bridgeRevision;

    const result = await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(key);
        reject(
          new Error(
            `Timed out after ${timeout}ms waiting for ${this.config.baseTopic}/bridge/response/${subTopic}. ` +
              `The request may still be running on the bridge.`,
          ),
        );
      }, timeout);

      this.waiters.set(key, (response) => {
        clearTimeout(timer);
        this.waiters.delete(key);
        if (response.status === "error") {
          reject(new Error(response.error ?? `Zigbee2MQTT returned an error for ${subTopic}`));
        } else {
          resolve(response.data as T);
        }
      });

      const topic = `${this.config.baseTopic}/bridge/request/${subTopic}`;
      this.log.debug(`-> ${topic}`, JSON.stringify(payload));
      client.publish(topic, JSON.stringify({ ...payload, transaction }), { qos: 1 }, (error) => {
        if (error) {
          clearTimeout(timer);
          this.waiters.delete(key);
          reject(new Error(`Failed to publish to ${topic}: ${error.message}`));
        }
      });
    });

    // Zigbee2MQTT acknowledges a request before republishing its retained bridge
    // topics, so a caller could in principle read a stale cache immediately
    // afterwards. Not reproducible against a local broker, where the republish
    // always wins the race, but the ordering is not guaranteed. Bounded guard.
    if (!NON_MUTATING.has(subTopic)) {
      await this.awaitBridgeRefresh(revisionBefore);
    }
    return result;
  }

  private async awaitBridgeRefresh(since: number, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && this.bridgeRevision === since) {
      await sleep(25);
    }
  }

  /** Fire-and-forget publish, used for device `set` and `get` commands. */
  async publish(topic: string, payload: unknown): Promise<void> {
    await this.connect();
    const client = this.client;
    if (!client) throw new Error("MQTT client is not connected");
    const body = typeof payload === "string" ? payload : JSON.stringify(payload);
    return new Promise((resolve, reject) => {
      // Settles only on the QoS 1 acknowledgement, which never arrives if the
      // broker drops mid-publish, so bound it like request() does.
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `Timed out after ${this.config.requestTimeoutMs}ms publishing to ${topic}. ` +
                "The message may still be queued for delivery.",
            ),
          ),
        this.config.requestTimeoutMs,
      );
      client.publish(topic, body, { qos: 1 }, (error) => {
        clearTimeout(timer);
        if (error) reject(new Error(`Failed to publish to ${topic}: ${error.message}`));
        else resolve();
      });
    });
  }

  // ----------------------------------------------------------------- accessors

  async bridgeTopic<T = unknown>(name: string): Promise<T | undefined> {
    await this.connect();
    return this.bridge.get(name) as T | undefined;
  }

  async snapshot() {
    await this.connect();
    return {
      info: this.bridge.get("info") as Record<string, unknown> | undefined,
      state: this.bridge.get("state") as Record<string, unknown> | undefined,
      health: this.bridge.get("health") as Record<string, unknown> | undefined,
      devices: (this.bridge.get("devices") as unknown[] | undefined) ?? [],
      groups: (this.bridge.get("groups") as unknown[] | undefined) ?? [],
      deviceState: this.deviceState,
      availability: this.availability,
    };
  }

  /**
   * Deliberately does not connect: this is what a caller reaches for when the
   * connection is the thing under suspicion.
   */
  status(): ConnectionStatus {
    return {
      connected: this.client?.connected === true,
      broker_url: this.safeUrl,
      base_topic: this.config.baseTopic,
      client_id: this.config.clientId,
      write_mode: this.config.writeMode,
      tls: {
        enabled: /^(mqtts|wss):/.test(this.config.mqttUrl),
        reject_unauthorized: this.config.rejectUnauthorized,
        custom_ca: this.config.ca !== undefined,
        client_certificate: this.config.cert !== undefined,
      },
      authenticated: this.config.username !== undefined,
      broker_handshake: this.brokerHandshake,
      cached: {
        bridge_topics: this.bridge.size,
        device_state: this.deviceState.size,
        availability: this.availability.size,
        logs: this.logs.length,
        events: this.events.length,
      },
      last_message_at: this.lastMessageAt ? new Date(this.lastMessageAt).toISOString() : null,
    };
  }

  recentLogs(): readonly LogEntry[] {
    return this.logs;
  }

  recentEvents(): readonly BridgeEvent[] {
    return this.events;
  }

  /** Collect log lines produced from now until the window elapses. */
  async collectLogs(windowMs: number): Promise<LogEntry[]> {
    await this.connect();
    const from = this.logs.length;
    await sleep(windowMs);
    return this.logs.slice(from);
  }

  /** Listen for live device traffic, which is how linkquality and battery arrive. */
  async collectState(windowMs: number): Promise<void> {
    await this.connect();
    await sleep(windowMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function push<T>(buffer: T[], max: number, item: T): void {
  buffer.push(item);
  if (buffer.length > max) buffer.splice(0, buffer.length - max);
}
