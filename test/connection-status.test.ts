import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NoBridgeDataError, type Z2MClient } from "../src/client.js";
import { selectTools, type ToolDef } from "../src/tools.js";
import { config } from "./helpers.js";

const tool: ToolDef = selectTools("off").find((t) => t.name === "z2m_connection_status")!;

type Status = ReturnType<Z2MClient["status"]>;

function status(overrides: Partial<Status> = {}): Status {
  return {
    connected: true,
    broker_url: "mqtt://broker.invalid:1883",
    base_topic: "zigbee2mqtt",
    client_id: "test",
    write_mode: "safe",
    tls: { enabled: false, reject_unauthorized: true, custom_ca: false, client_certificate: false },
    authenticated: false,
    broker_handshake: true,
    cached: { bridge_topics: 8, device_state: 3, availability: 3, logs: 0, events: 0 },
    last_message_at: new Date().toISOString(),
    ...overrides,
  };
}

/** Stands in for a live client so the diagnostic branches can be exercised. */
function fakeClient(connectResult: Error | null, statusOverrides: Partial<Status> = {}): Z2MClient {
  return {
    connect: async () => {
      if (connectResult) throw connectResult;
    },
    status: () => status(statusOverrides),
  } as unknown as Z2MClient;
}

async function run(client: Z2MClient, configError?: string) {
  return (await tool.handler({}, { client, config: config(), configError })) as {
    configured: boolean;
    broker_reachable: boolean;
    zigbee2mqtt_responding: boolean;
    error?: string;
    hints: string[];
  };
}

describe("z2m_connection_status", () => {
  it("is allowed to run without configuration", () => {
    // The whole point of the tool is to diagnose a broker it cannot reach,
    // and an unset URL is the most common reason for that.
    assert.equal(tool.runsUnconfigured, true);
  });

  it("reports a missing configuration instead of throwing", async () => {
    const notConfigured = { connect: async () => {}, status } as unknown as Z2MClient;
    const out = await run(notConfigured, "Z2M_MQTT_URL is not set, e.g. mqtt://192.168.1.10:1883");
    assert.equal(out.configured, false);
    assert.equal(out.broker_reachable, false);
    assert.match(out.error!, /Z2M_MQTT_URL is not set/);
    assert.match(out.hints.join("\n"), /Set Z2M_MQTT_URL/);
  });

  it("reports a healthy connection with no hints", async () => {
    const out = await run(fakeClient(null));
    assert.equal(out.configured, true);
    assert.equal(out.broker_reachable, true);
    assert.equal(out.zigbee2mqtt_responding, true);
    assert.equal(out.error, undefined);
    assert.deepEqual(out.hints, []);
  });

  it("trusts the observed handshake over the error type", async () => {
    // A subscribe failure throws a plain Error even though the broker answered.
    const out = await run(
      fakeClient(new Error("Failed to subscribe to zigbee2mqtt/#"), { broker_handshake: true }),
    );
    assert.equal(out.broker_reachable, true, "a broker that completed CONNACK was called unreachable");
    assert.equal(out.zigbee2mqtt_responding, false);
  });

  it("reports an unreachable broker without throwing", async () => {
    const out = await run(
      fakeClient(new Error("connack timeout"), { connected: false, broker_handshake: false }),
    );
    assert.equal(out.broker_reachable, false);
    assert.equal(out.zigbee2mqtt_responding, false);
    assert.match(out.error!, /connack timeout/);
    assert.match(out.hints.join("\n"), /Could not reach the broker/);
  });

  it("does not blame the broker when the broker was reachable but silent", async () => {
    // The misleading case: credentials and host are fine, the base topic is not.
    const out = await run(
      fakeClient(new NoBridgeDataError("no retained bridge/devices"), {
        connected: false,
        broker_handshake: true,
        cached: { bridge_topics: 0, device_state: 0, availability: 0, logs: 0, events: 0 },
      }),
    );
    assert.equal(out.broker_reachable, true, "a reachable broker was reported unreachable");
    assert.equal(out.zigbee2mqtt_responding, false);
    const hints = out.hints.join("\n");
    assert.doesNotMatch(hints, /Could not reach the broker/, "hint contradicts the error");
    assert.match(hints, /Z2M_BASE_TOPIC/);
  });

  it("flags a connected broker that is carrying no bridge topics", async () => {
    const out = await run(
      fakeClient(null, { cached: { bridge_topics: 0, device_state: 0, availability: 0, logs: 0, events: 0 } }),
    );
    assert.equal(out.broker_reachable, true);
    assert.match(out.hints.join("\n"), /nothing was published under 'zigbee2mqtt\/bridge\/'/);
  });

  it("warns when TLS verification is disabled", async () => {
    const out = await run(
      fakeClient(null, {
        tls: { enabled: true, reject_unauthorized: false, custom_ca: false, client_certificate: false },
      }),
    );
    assert.match(out.hints.join("\n"), /certificate verification is disabled/);
  });

  it("stays silent about TLS when verification is on", async () => {
    const out = await run(
      fakeClient(null, {
        tls: { enabled: true, reject_unauthorized: true, custom_ca: false, client_certificate: false },
      }),
    );
    assert.deepEqual(out.hints, []);
  });
});
