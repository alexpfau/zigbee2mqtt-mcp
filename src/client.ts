import mqtt, { type IClientOptions, type MqttClient } from "mqtt";
import type { Config, Logger } from "./config.js";

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

  private readonly bridge = new Map<string, unknown>();
  private readonly deviceState = new Map<string, Record<string, unknown>>();
  private readonly availability = new Map<string, string>();
  private readonly logs: LogEntry[] = [];
  private readonly events: BridgeEvent[] = [];
  private readonly waiters = new Map<string, (response: BridgeResponse) => void>();

  constructor(
    private readonly config: Config,
    private readonly log: Logger,
  ) {}

  // ---------------------------------------------------------------- lifecycle

  async connect(): Promise<void> {
    if (this.client?.connected) return;
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
      this.log.debug(`connecting to ${config.mqttUrl}`);
      const client = mqtt.connect(config.mqttUrl, options);
      this.client = client;

      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        client.end(true);
        this.client = null;
        reject(error);
      };

      const timer = setTimeout(
        () => fail(new Error(`Timed out connecting to ${config.mqttUrl} after ${config.connectTimeoutMs}ms`)),
        config.connectTimeoutMs,
      );

      client.on("error", (error) => {
        this.log.error("mqtt error:", error.message);
        fail(new Error(`MQTT connection to ${config.mqttUrl} failed: ${error.message}`));
      });

      client.on("message", (topic, payload) => this.handleMessage(topic, payload));

      client.on("connect", () => {
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

  private async waitForBridgeData(timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !(this.bridge.has("devices") && this.bridge.has("info"))) {
      await sleep(25);
    }
    if (!this.bridge.has("devices")) {
      throw new Error(
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

  private handleMessage(topic: string, payload: Buffer): void {
    const prefix = `${this.config.baseTopic}/`;
    if (!topic.startsWith(prefix)) return;
    this.lastMessageAt = Date.now();
    const rest = topic.slice(prefix.length);
    const raw = payload.toString();
    const parsed = safeParse(raw);

    if (rest.startsWith("bridge/response/")) {
      this.resolveWaiter(rest.slice("bridge/response/".length), parsed);
      return;
    }
    if (rest === "bridge/logging") {
      const entry = parsed as Partial<LogEntry> | null;
      if (entry && typeof entry === "object") {
        push(this.logs, LOG_BUFFER, {
          received_at: new Date().toISOString(),
          level: String(entry.level ?? "info"),
          message: String(entry.message ?? raw),
          namespace: entry.namespace,
        });
      }
      return;
    }
    if (rest === "bridge/event") {
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
    if (rest.startsWith("bridge/")) {
      this.bridge.set(rest.slice("bridge/".length), parsed ?? raw);
      this.bridgeRevision++;
      return;
    }

    // Friendly names may contain '/', so match on the suffix rather than splitting.
    if (rest.endsWith("/availability")) {
      const name = rest.slice(0, -"/availability".length);
      const state = typeof parsed === "object" && parsed !== null
        ? String((parsed as { state?: unknown }).state ?? raw)
        : raw;
      this.availability.set(name, state);
      return;
    }
    if (/\/(set|get)(\/|$)/.test(rest)) return; // commands, not state

    if (parsed && typeof parsed === "object") {
      this.deviceState.set(rest, parsed as Record<string, unknown>);
    }
  }

  private resolveWaiter(subTopic: string, parsed: unknown): void {
    if (!parsed || typeof parsed !== "object") return;
    const response = parsed as BridgeResponse;
    const key = `${subTopic}|${response.transaction ?? ""}`;
    const waiter = this.waiters.get(key);
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
    const key = `${subTopic}|${transaction}`;
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
      client.publish(topic, body, { qos: 1 }, (error) =>
        error ? reject(new Error(`Failed to publish to ${topic}: ${error.message}`)) : resolve(),
      );
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
