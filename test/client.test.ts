import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Z2MClient, waiterKey, type BridgeResponse } from "../src/client.js";
import { createLogger, type Config } from "../src/config.js";
import { config } from "./helpers.js";

/** No broker involved: messages are fed straight into the routing entry point. */
function client(overrides: Partial<Config> = {}) {
  const c = new Z2MClient(config(overrides), createLogger("silent"));
  const feed = (topic: string, payload: unknown) =>
    c.handleMessage(topic, Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload)));
  // The waiter registry is private; reaching it is the only way to exercise
  // response correlation without a live broker.
  const waiters = (c as unknown as { waiters: Map<string, (r: BridgeResponse) => void> }).waiters;
  return { c, feed, waiters };
}

describe("Z2MClient message handling", () => {
  it("caches bridge topics", () => {
    const { c, feed } = client();
    feed("zigbee2mqtt/bridge/info", { version: "2.12.1" });
    feed("zigbee2mqtt/bridge/devices", []);
    assert.equal(c.status().cached.bridge_topics, 2);
  });

  it("ignores the echo of its own outbound requests", () => {
    // We subscribe to the whole base topic, so everything we publish comes
    // straight back. Caching it would inflate the diagnostic counts and
    // satisfy the post-write refresh guard before Zigbee2MQTT republishes.
    const { c, feed } = client();
    feed("zigbee2mqtt/bridge/info", { version: "2.12.1" });
    const before = c.status().cached.bridge_topics;
    feed("zigbee2mqtt/bridge/request/device/rename", { from: "a", to: "b", transaction: "mcp-1" });
    feed("zigbee2mqtt/bridge/request/health_check", { transaction: "mcp-2" });
    assert.equal(c.status().cached.bridge_topics, before, "an outbound request was cached as bridge state");
  });

  it("keeps only the latest payload per topic", () => {
    const { c, feed } = client();
    feed("zigbee2mqtt/bridge/info", { version: "1" });
    feed("zigbee2mqtt/bridge/info", { version: "2" });
    assert.equal(c.status().cached.bridge_topics, 1);
  });

  it("ignores traffic outside the base topic", () => {
    const { c, feed } = client();
    feed("homeassistant/status", "online");
    feed("zigbee2mqtt-other/bridge/info", { version: "1" });
    const status = c.status();
    assert.equal(status.cached.bridge_topics, 0);
    assert.equal(status.last_message_at, null, "a foreign topic counted as activity");
  });

  it("records device state and availability separately", () => {
    const { c, feed } = client();
    feed("zigbee2mqtt/lamp", { linkquality: 80 });
    feed("zigbee2mqtt/lamp/availability", { state: "online" });
    const status = c.status();
    assert.equal(status.cached.device_state, 1);
    assert.equal(status.cached.availability, 1);
  });

  it("does not record set and get commands as device state", () => {
    const { c, feed } = client();
    feed("zigbee2mqtt/lamp/set", { state: "ON" });
    feed("zigbee2mqtt/lamp/get", { state: "" });
    assert.equal(c.status().cached.device_state, 0);
  });

  it("ignores a state payload that is not an object", () => {
    const { c, feed } = client();
    feed("zigbee2mqtt/lamp", "ON");
    assert.equal(c.status().cached.device_state, 0);
  });

  it("accepts a plain-text availability payload", () => {
    const { c, feed } = client();
    feed("zigbee2mqtt/lamp/availability", "online");
    assert.equal(c.status().cached.availability, 1);
  });

  it("buffers bridge log lines with a timestamp", () => {
    const { c, feed } = client();
    feed("zigbee2mqtt/bridge/logging", { level: "warning", message: "slow", namespace: "z2m" });
    const [entry] = c.recentLogs();
    assert.equal(entry?.level, "warning");
    assert.equal(entry?.message, "slow");
    assert.equal(entry?.namespace, "z2m");
    assert.ok(!Number.isNaN(Date.parse(entry!.received_at)));
  });

  it("buffers bridge events", () => {
    const { c, feed } = client();
    feed("zigbee2mqtt/bridge/event", { type: "device_joined", data: { friendly_name: "lamp" } });
    const [event] = c.recentEvents();
    assert.equal(event?.type, "device_joined");
    assert.deepEqual(event?.data, { friendly_name: "lamp" });
  });

  it("scrubs credentials out of relayed bridge logs", () => {
    // Zigbee2MQTT logs its own broker URL at startup, credentials included,
    // and z2m_get_logs hands those lines to the model verbatim.
    const { c, feed } = client({ password: "hunter2secret" });
    feed("zigbee2mqtt/bridge/logging", {
      level: "info",
      message: "Connecting to MQTT server at mqtt://alice:hunter2secret@192.0.2.1:1883",
    });
    const [entry] = c.recentLogs();
    assert.ok(!entry!.message.includes("hunter2secret"), entry!.message);
    assert.ok(entry!.message.includes("192.0.2.1"), "host should stay visible");
  });

  it("defaults an event with no type rather than dropping it", () => {
    const { c, feed } = client();
    feed("zigbee2mqtt/bridge/event", { data: {} });
    assert.equal(c.recentEvents()[0]?.type, "unknown");
  });

  it("bounds the log buffer so a chatty bridge cannot exhaust memory", () => {
    const { c, feed } = client();
    for (let i = 0; i < 1_100; i++) feed("zigbee2mqtt/bridge/logging", { level: "info", message: `#${i}` });
    const logs = c.recentLogs();
    assert.equal(logs.length, 1_000);
    assert.equal(logs.at(-1)?.message, "#1099", "the newest entry was evicted instead of the oldest");
  });

  it("bounds the event buffer", () => {
    const { c, feed } = client();
    for (let i = 0; i < 250; i++) feed("zigbee2mqtt/bridge/event", { type: `e${i}`, data: {} });
    assert.equal(c.recentEvents().length, 200);
    assert.equal(c.recentEvents().at(-1)?.type, "e249");
  });

  it("survives malformed JSON on any topic", () => {
    const { c, feed } = client();
    assert.doesNotThrow(() => {
      feed("zigbee2mqtt/bridge/info", "{not json");
      feed("zigbee2mqtt/bridge/logging", "{not json");
      feed("zigbee2mqtt/bridge/event", "{not json");
      feed("zigbee2mqtt/lamp", "{not json");
    });
    assert.equal(c.status().cached.bridge_topics, 1, "a malformed bridge payload was dropped entirely");
  });

  it("honours a custom base topic", () => {
    const { c, feed } = client({ baseTopic: "z2m/prod" });
    feed("z2m/prod/bridge/info", { version: "1" });
    feed("zigbee2mqtt/bridge/info", { version: "1" });
    assert.equal(c.status().cached.bridge_topics, 1);
  });
});

describe("Z2MClient.status", () => {
  it("reports disconnected without attempting to connect", () => {
    const { c } = client();
    const status = c.status();
    assert.equal(status.connected, false);
    assert.equal(status.last_message_at, null);
  });

  it("redacts credentials embedded in the broker URL", () => {
    const { c } = client({ mqttUrl: "mqtt://alice:hunter2@broker.invalid:1883" });
    assert.ok(!JSON.stringify(c.status()).includes("hunter2"), "broker password leaked");
  });

  it("never includes the configured password", () => {
    const { c } = client({ username: "alice", password: "hunter2" });
    const serialised = JSON.stringify(c.status());
    assert.ok(!serialised.includes("hunter2"), "password leaked");
    assert.equal(c.status().authenticated, true);
  });

  it("describes the TLS posture", () => {
    assert.equal(client({ mqttUrl: "mqtts://broker.invalid:8883" }).c.status().tls.enabled, true);
    assert.equal(client({ mqttUrl: "wss://broker.invalid/mqtt" }).c.status().tls.enabled, true);
    assert.equal(client({ mqttUrl: "mqtt://broker.invalid:1883" }).c.status().tls.enabled, false);
    assert.equal(client({ rejectUnauthorized: false }).c.status().tls.reject_unauthorized, false);
  });

  it("timestamps the most recent message", () => {
    const { c, feed } = client();
    feed("zigbee2mqtt/bridge/info", { version: "1" });
    const at = c.status().last_message_at;
    assert.ok(at !== null && Date.now() - Date.parse(at) < 5_000);
  });
});

describe("bridge request correlation", () => {
  // A mismatch between how request() builds the waiter key and how the response
  // handler looks it up would make every write tool time out against a live
  // bridge while the rest of the suite stayed green.
  const RESPONSE = "zigbee2mqtt/bridge/response/device/rename";

  it("resolves the waiter registered for the matching transaction", () => {
    const { feed, waiters } = client();
    let seen: BridgeResponse | undefined;
    waiters.set(waiterKey("device/rename", "mcp-1"), (r) => {
      seen = r;
    });
    feed(RESPONSE, { status: "ok", data: { from: "a", to: "b" }, transaction: "mcp-1" });
    assert.deepEqual(seen?.data, { from: "a", to: "b" });
  });

  it("ignores a response for a different transaction", () => {
    const { feed, waiters } = client();
    let called = false;
    waiters.set(waiterKey("device/rename", "mcp-1"), () => {
      called = true;
    });
    feed(RESPONSE, { status: "ok", transaction: "mcp-2" });
    assert.equal(called, false, "a response was delivered to the wrong waiter");
  });

  it("ignores a response for a different sub-topic", () => {
    const { feed, waiters } = client();
    let called = false;
    waiters.set(waiterKey("device/remove", "mcp-1"), () => {
      called = true;
    });
    feed(RESPONSE, { status: "ok", transaction: "mcp-1" });
    assert.equal(called, false);
  });

  it("delivers an error response so the caller can reject", () => {
    const { feed, waiters } = client();
    let seen: BridgeResponse | undefined;
    waiters.set(waiterKey("device/rename", "mcp-1"), (r) => {
      seen = r;
    });
    feed(RESPONSE, { status: "error", error: "Device not found", transaction: "mcp-1" });
    assert.equal(seen?.status, "error");
    assert.equal(seen?.error, "Device not found");
  });

  it("matches a response that carries no transaction", () => {
    // Older Zigbee2MQTT versions omit it; the key must degrade the same way.
    const { feed, waiters } = client();
    let called = false;
    waiters.set(waiterKey("device/rename", undefined), () => {
      called = true;
    });
    feed(RESPONSE, { status: "ok" });
    assert.equal(called, true);
  });

  it("survives a malformed response without invoking the waiter", () => {
    const { feed, waiters } = client();
    let called = false;
    waiters.set(waiterKey("device/rename", "mcp-1"), () => {
      called = true;
    });
    assert.doesNotThrow(() => feed(RESPONSE, "not json"));
    assert.equal(called, false);
  });

  it("does not treat a malformed response as a transaction-less one", () => {
    // Unparseable payloads must be dropped, not coerced into an empty object
    // that would then match a waiter registered without a transaction.
    const { feed, waiters } = client();
    let called = false;
    waiters.set(waiterKey("device/rename", undefined), () => {
      called = true;
    });
    feed(RESPONSE, "not json");
    assert.equal(called, false, "a malformed payload resolved a waiter");
  });

  it("keys a numeric transaction the same way as a string", () => {
    assert.equal(waiterKey("device/rename", 7), waiterKey("device/rename", "7"));
  });
});
