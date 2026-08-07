import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Z2MClient } from "../src/client.js";
import type { RawDevice } from "../src/devices.js";
import { selectTools, type ToolDef } from "../src/tools.js";
import { config } from "./helpers.js";

/**
 * Asserts the wire format we send to Zigbee2MQTT. Nothing else in the suite
 * covers this layer, and a wrong payload key is invisible to every other test:
 * the bridge simply answers "Invalid payload".
 */

const ALL = selectTools("full");
const byName = (name: string): ToolDef => ALL.find((t) => t.name === name)!;

interface Sent {
  subTopic: string;
  payload: Record<string, unknown>;
  timeoutMs?: number;
}

const DEVICES: RawDevice[] = [
  { ieee_address: "0x00158d0000000001", type: "Router", friendly_name: "Kitchen Lamp" },
  { ieee_address: "0x00158d0000000002", type: "EndDevice", friendly_name: "Hallway Sensor" },
];

/** Records what a handler would have sent instead of reaching a broker. */
function recorder(response: unknown = { status: "ok" }) {
  const sent: Sent[] = [];
  const published: { topic: string; payload: unknown }[] = [];
  const client = {
    request: async (subTopic: string, payload: Record<string, unknown>, timeoutMs?: number) => {
      sent.push({ subTopic, payload, timeoutMs });
      return response;
    },
    publish: async (topic: string, payload: unknown) => {
      published.push({ topic, payload });
    },
    snapshot: async () => ({
      info: { version: "2.12.1" },
      state: { state: "online" },
      health: undefined,
      devices: DEVICES,
      groups: [],
      deviceState: new Map(),
      availability: new Map(),
    }),
    collectState: async () => undefined,
  } as unknown as Z2MClient;
  return { client, sent, published };
}

async function callWith(tool: ToolDef, args: Record<string, unknown>, response: unknown) {
  const rec = recorder(response);
  const result = await tool.handler(args, { client: rec.client, config: config() });
  return { rec, result: result as any };
}

async function call(tool: ToolDef, args: Record<string, unknown>) {
  const rec = recorder();
  await tool.handler(args, { client: rec.client, config: config() });
  return rec;
}

/** The single request a handler made. */
async function sends(name: string, args: Record<string, unknown>): Promise<Sent> {
  const rec = await call(byName(name), args);
  assert.equal(rec.sent.length, 1, `${name} made ${rec.sent.length} requests, expected 1`);
  return rec.sent[0]!;
}

describe("bridge request payloads", () => {
  it("z2m_permit_join", async () => {
    const out = await sends("z2m_permit_join", { time: 120 });
    assert.equal(out.subTopic, "permit_join");
    assert.equal(out.payload.time, 120);
  });

  it("z2m_set_device_options", async () => {
    const out = await sends("z2m_set_device_options", {
      device: "Kitchen Lamp",
      options: { transition: 2 },
    });
    assert.equal(out.subTopic, "device/options");
    assert.equal(out.payload.id, "Kitchen Lamp");
    assert.deepEqual(out.payload.options, { transition: 2 });
  });

  it("z2m_rename_device sends from and to the right way round", async () => {
    const out = await sends("z2m_rename_device", { device: "Kitchen Lamp", new_name: "Kitchen Light" });
    assert.equal(out.subTopic, "device/rename");
    assert.equal(out.payload.from, "Kitchen Lamp", "renamed from the wrong name");
    assert.equal(out.payload.to, "Kitchen Light", "renamed to the wrong name");
  });

  it("z2m_configure_device", async () => {
    const out = await sends("z2m_configure_device", { device: "Kitchen Lamp" });
    assert.equal(out.subTopic, "device/configure");
    assert.equal(out.payload.id, "Kitchen Lamp");
  });

  it("z2m_interview_device", async () => {
    const out = await sends("z2m_interview_device", { device: "Kitchen Lamp" });
    assert.equal(out.subTopic, "device/interview");
    assert.equal(out.payload.id, "Kitchen Lamp");
  });

  it("z2m_coordinator_check", async () => {
    const out = await sends("z2m_coordinator_check", {});
    assert.equal(out.subTopic, "coordinator_check");
  });

  it("z2m_restart_bridge", async () => {
    const out = await sends("z2m_restart_bridge", { confirm: true });
    assert.equal(out.subTopic, "restart");
  });

  it("z2m_set_bridge_options", async () => {
    const out = await sends("z2m_set_bridge_options", {
      options: { advanced: { last_seen: "ISO_8601" } },
      confirm: true,
    });
    assert.equal(out.subTopic, "options");
    assert.deepEqual(out.payload.options, { advanced: { last_seen: "ISO_8601" } });
  });

  it("z2m_remove_device", async () => {
    const out = await sends("z2m_remove_device", { device: "Kitchen Lamp", confirm: true });
    assert.equal(out.subTopic, "device/remove");
    assert.equal(out.payload.id, "Kitchen Lamp");
  });

  describe("z2m_manage_group", () => {
    it("add", async () => {
      const out = await sends("z2m_manage_group", { action: "add", group: "kitchen" });
      assert.equal(out.subTopic, "group/add");
      assert.equal(out.payload.friendly_name, "kitchen");
    });

    it("remove", async () => {
      const out = await sends("z2m_manage_group", { action: "remove", group: "kitchen", confirm: true });
      assert.equal(out.subTopic, "group/remove");
      assert.equal(out.payload.id, "kitchen");
    });

    it("rename", async () => {
      const out = await sends("z2m_manage_group", { action: "rename", group: "kitchen", new_name: "cook" });
      assert.equal(out.subTopic, "group/rename");
      assert.equal(out.payload.from, "kitchen");
      assert.equal(out.payload.to, "cook");
    });

    it("add_member", async () => {
      const out = await sends("z2m_manage_group", {
        action: "add_member",
        group: "kitchen",
        device: "Kitchen Lamp",
      });
      assert.equal(out.subTopic, "group/members/add");
      assert.equal(out.payload.group, "kitchen");
      assert.equal(out.payload.device, "Kitchen Lamp");
    });

    it("add_member with an endpoint", async () => {
      // Zigbee2MQTT reads a separate `endpoint` key; there is no name suffix syntax.
      const out = await sends("z2m_manage_group", {
        action: "add_member",
        group: "kitchen",
        device: "Kitchen Lamp",
        endpoint: "l1",
      });
      assert.equal(out.payload.endpoint, "l1");
    });

    it("remove_all_members", async () => {
      const out = await sends("z2m_manage_group", {
        action: "remove_all_members",
        group: "kitchen",
        confirm: true,
      });
      assert.equal(out.subTopic, "group/members/remove_all");
      assert.equal(out.payload.group, "kitchen");
    });
  });

  describe("z2m_bind", () => {
    it("bind", async () => {
      const out = await sends("z2m_bind", { action: "bind", from: "Kitchen Lamp", to: "Hallway Sensor" });
      assert.equal(out.subTopic, "device/bind");
      assert.equal(out.payload.from, "Kitchen Lamp");
      assert.equal(out.payload.to, "Hallway Sensor");
    });

    it("unbind", async () => {
      const out = await sends("z2m_bind", { action: "unbind", from: "Kitchen Lamp", to: "Hallway Sensor" });
      assert.equal(out.subTopic, "device/unbind");
    });

    it("carries endpoints as separate keys", async () => {
      const out = await sends("z2m_bind", {
        action: "bind",
        from: "Kitchen Lamp",
        to: "Hallway Sensor",
        from_endpoint: "left",
        to_endpoint: 1,
      });
      assert.equal(out.payload.from_endpoint, "left");
      assert.equal(out.payload.to_endpoint, 1);
    });

    it("passes clusters through when given", async () => {
      const out = await sends("z2m_bind", {
        action: "bind",
        from: "Kitchen Lamp",
        to: "Hallway Sensor",
        clusters: ["genOnOff"],
      });
      assert.deepEqual(out.payload.clusters, ["genOnOff"]);
    });

    it("clear uses the target key Zigbee2MQTT requires", async () => {
      // bind.js rejects anything without a string `target` as "Invalid payload".
      const out = await sends("z2m_bind", { action: "clear", from: "Kitchen Lamp", confirm: true });
      assert.equal(out.subTopic, "device/binds/clear");
      assert.equal(out.payload.target, "Kitchen Lamp", "binds/clear must send `target`, not `id`");
      assert.equal(out.payload.id, undefined, "`id` is not a key binds/clear understands");
    });
  });

  describe("z2m_touchlink", () => {
    it("sends a fully specified target", async () => {
      const out = await sends("z2m_touchlink", {
        action: "factory_reset",
        ieee_address: "0x00158d0000000001",
        channel: 11,
        confirm: true,
      });
      assert.equal(out.subTopic, "touchlink/factory_reset");
      assert.equal(out.payload.ieee_address, "0x00158d0000000001");
      assert.equal(out.payload.channel, 11);
    });

    it("refuses a half-specified target instead of resetting the nearest device", async () => {
      // An empty payload makes Zigbee2MQTT factory-reset the first device it finds.
      await assert.rejects(
        () =>
          byName("z2m_touchlink").handler(
            { action: "factory_reset", ieee_address: "0x00158d0000000001", confirm: true },
            { client: recorder().client, config: config() },
          ),
        /channel/i,
      );
    });

    it("requires an explicit opt-in for the untargeted reset", async () => {
      await assert.rejects(
        () =>
          byName("z2m_touchlink").handler(
            { action: "factory_reset", confirm: true },
            { client: recorder().client, config: config() },
          ),
        /nearest/i,
      );
    });

    it("allows scan without a target", async () => {
      const out = await sends("z2m_touchlink", { action: "scan", confirm: true });
      assert.equal(out.subTopic, "touchlink/scan");
    });
  });

  describe("z2m_set_state", () => {
    it("publishes to the device set topic", async () => {
      const rec = await call(byName("z2m_set_state"), {
        device: "Kitchen Lamp",
        payload: { state: "ON" },
      });
      assert.equal(rec.published.length, 1);
      assert.equal(rec.published[0]!.topic, "zigbee2mqtt/Kitchen Lamp/set");
      assert.deepEqual(rec.published[0]!.payload, { state: "ON" });
    });

    it("uses the get topic when reading", async () => {
      const rec = await call(byName("z2m_set_state"), {
        device: "Kitchen Lamp",
        payload: { state: "" },
        mode: "get",
      });
      assert.equal(rec.published[0]!.topic, "zigbee2mqtt/Kitchen Lamp/get");
    });
  });

  it("z2m_ota_update targets the right sub-topic per action", async () => {
    const cases: Record<string, string> = {
      update: "device/ota_update/update",
      schedule: "device/ota_update/schedule",
      unschedule: "device/ota_update/unschedule",
      abort: "device/ota_update/update/abort",
    };
    for (const [action, subTopic] of Object.entries(cases)) {
      const out = await sends("z2m_ota_update", { device: "Kitchen Lamp", action, confirm: true });
      assert.equal(out.subTopic, subTopic, `action=${action}`);
      assert.equal(out.payload.id, "Kitchen Lamp");
    }
  });

  it("z2m_configure_reporting", async () => {
    const out = await sends("z2m_configure_reporting", {
      device: "Kitchen Lamp",
      cluster: "genOnOff",
      attribute: "onOff",
      minimum_report_interval: 1,
      maximum_report_interval: 300,
      reportable_change: 0,
    });
    assert.equal(out.subTopic, "device/reporting/configure");
    assert.equal(out.payload.id, "Kitchen Lamp");
    assert.equal(out.payload.cluster, "genOnOff");
    assert.equal(out.payload.attribute, "onOff");
    assert.equal(out.payload.minimum_report_interval, 1);
    assert.equal(out.payload.maximum_report_interval, 300);
  });

  it("resolves a friendly name from a partial match before sending", async () => {
    const out = await sends("z2m_configure_device", { device: "Hallway" });
    assert.equal(out.payload.id, "Hallway Sensor");
  });

  it("never sends an unresolved identifier", async () => {
    await assert.rejects(
      () => byName("z2m_configure_device").handler({ device: "Nonexistent" }, { client: recorder().client, config: config() }),
      /No device matches/,
    );
  });
});

describe("argument validation", () => {
  const reject = (name: string, args: Record<string, unknown>, pattern: RegExp) =>
    assert.rejects(
      () => byName(name).handler(args, { client: recorder().client, config: config() }),
      pattern,
      `${name} accepted ${JSON.stringify(args)}`,
    );

  it("rejects a non-numeric limit instead of returning an empty estate", async () => {
    // Number("ten") is NaN, and slice(0, NaN) silently returns nothing.
    await reject("z2m_list_devices", { limit: "ten" }, /limit must be a number/);
  });

  it("rejects a non-numeric timeout instead of timing out instantly", async () => {
    await reject("z2m_check_updates", { timeout_ms: "fast" }, /timeout_ms must be a number/);
  });

  it("enforces the documented permit_join ceiling", async () => {
    await reject("z2m_permit_join", { time: 999 }, /between 0 and 254/);
    await reject("z2m_permit_join", { time: "soon" }, /time must be a number/);
  });

  it("still accepts valid values at the boundary", async () => {
    const out = await sends("z2m_permit_join", { time: 254 });
    assert.equal(out.payload.time, 254);
  });

  it("explains which touchlink argument is missing rather than falling back", async () => {
    // Without both, Zigbee2MQTT resets the nearest device it can find.
    await reject(
      "z2m_touchlink",
      { action: "factory_reset", ieee_address: "0x1", confirm: true },
      /both ieee_address and channel/,
    );
    await reject(
      "z2m_touchlink",
      { action: "factory_reset", channel: 11, confirm: true },
      /both ieee_address and channel/,
    );
  });
});

describe("response shaping", () => {
  it("reports permit_join_end as a plausible date", async () => {
    // zigbee-herdsman stores milliseconds since the epoch already.
    const endsAt = Date.now() + 120_000;
    const rec = recorder();
    (rec.client as any).snapshot = async () => ({
      info: { version: "2.12.1", permit_join: true, permit_join_end: endsAt },
      state: { state: "online" },
      health: undefined,
      devices: DEVICES,
      groups: [],
      deviceState: new Map(),
      availability: new Map(),
    });
    const out = (await byName("z2m_bridge_info").handler({}, { client: rec.client, config: config() })) as any;
    const reported = Date.parse(out.permit_join_end);
    assert.ok(Math.abs(reported - endsAt) < 1000, `expected ~${new Date(endsAt).toISOString()}, got ${out.permit_join_end}`);
  });

  it("names the strongest neighbour as the parent in a network map", async () => {
    const response = {
      value: {
        nodes: [
          { ieeeAddr: "0xAAA", friendlyName: "Coordinator", type: "Coordinator" },
          { ieeeAddr: "0xBBB", friendlyName: "Near Router", type: "Router" },
          { ieeeAddr: "0xCCC", friendlyName: "Leaf", type: "EndDevice" },
        ],
        links: [
          { sourceIeeeAddr: "0xAAA", targetIeeeAddr: "0xCCC", linkquality: 20, depth: 2 },
          { sourceIeeeAddr: "0xBBB", targetIeeeAddr: "0xCCC", linkquality: 180, depth: 1 },
        ],
      },
    };
    const { result } = await callWith(byName("z2m_network_map"), {}, response);
    const leaf = result.nodes.find((n: any) => n.friendly_name === "Leaf");
    assert.equal(leaf.parent, "Near Router", "the weakest neighbour was reported as the parent");
    assert.equal(leaf.linkquality, 180);
    assert.equal(result.total_nodes, 3);
    assert.equal(result.truncated, undefined, "nothing was capped, so no notice belongs here");
  });

  it("says so when the node list is capped", async () => {
    // Otherwise a capped map reads as a smaller mesh than the user actually has.
    const response = {
      value: {
        nodes: Array.from({ length: 6 }, (_, i) => ({
          ieeeAddr: `0x${i}`,
          friendlyName: `n${i}`,
          type: "Router",
        })),
        links: [],
      },
    };
    const { result } = await callWith(byName("z2m_network_map"), { max_nodes: 2 }, response);
    assert.equal(result.total_nodes, 6);
    assert.equal(result.node_count, 2);
    assert.match(result.truncated, /2 of 6 nodes/);
  });
});
