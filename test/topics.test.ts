import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyTopic } from "../src/topics.js";

const BASE = "zigbee2mqtt";

describe("classifyTopic", () => {
  it("ignores topics outside the base topic", () => {
    assert.deepEqual(classifyTopic(BASE, "homeassistant/status"), { kind: "foreign" });
    assert.deepEqual(classifyTopic(BASE, "zigbee2mqtt"), { kind: "foreign" });
  });

  it("does not treat a longer sibling base topic as ours", () => {
    // 'zigbee2mqtt-test/...' must not be mistaken for 'zigbee2mqtt/...'.
    assert.deepEqual(classifyTopic(BASE, "zigbee2mqtt-test/bridge/info"), { kind: "foreign" });
  });

  it("routes bridge responses and keeps the full sub-topic", () => {
    assert.deepEqual(classifyTopic(BASE, "zigbee2mqtt/bridge/response/device/rename"), {
      kind: "response",
      subTopic: "device/rename",
    });
  });

  it("routes logging and events before generic bridge topics", () => {
    assert.deepEqual(classifyTopic(BASE, "zigbee2mqtt/bridge/logging"), { kind: "logging" });
    assert.deepEqual(classifyTopic(BASE, "zigbee2mqtt/bridge/event"), { kind: "event" });
  });

  it("routes remaining bridge topics by name", () => {
    assert.deepEqual(classifyTopic(BASE, "zigbee2mqtt/bridge/devices"), {
      kind: "bridge",
      name: "devices",
    });
    assert.deepEqual(classifyTopic(BASE, "zigbee2mqtt/bridge/info"), { kind: "bridge", name: "info" });
  });

  it("extracts availability for friendly names containing a slash", () => {
    assert.deepEqual(classifyTopic(BASE, "zigbee2mqtt/kitchen/lamp/availability"), {
      kind: "availability",
      device: "kitchen/lamp",
    });
  });

  it("ignores set and get command topics", () => {
    assert.deepEqual(classifyTopic(BASE, "zigbee2mqtt/lamp/set"), { kind: "command" });
    assert.deepEqual(classifyTopic(BASE, "zigbee2mqtt/lamp/get"), { kind: "command" });
    assert.deepEqual(classifyTopic(BASE, "zigbee2mqtt/lamp/set/brightness"), { kind: "command" });
    assert.deepEqual(classifyTopic(BASE, "zigbee2mqtt/kitchen/lamp/set"), { kind: "command" });
  });

  it("does not mistake a device whose name merely contains set or get", () => {
    assert.deepEqual(classifyTopic(BASE, "zigbee2mqtt/sunset"), { kind: "state", device: "sunset" });
    assert.deepEqual(classifyTopic(BASE, "zigbee2mqtt/gadget/lamp"), {
      kind: "state",
      device: "gadget/lamp",
    });
  });

  it("treats anything else as device state, slashes included", () => {
    assert.deepEqual(classifyTopic(BASE, "zigbee2mqtt/lamp"), { kind: "state", device: "lamp" });
    assert.deepEqual(classifyTopic(BASE, "zigbee2mqtt/kitchen/lamp"), {
      kind: "state",
      device: "kitchen/lamp",
    });
  });

  it("honours a custom base topic", () => {
    assert.deepEqual(classifyTopic("z2m/prod", "z2m/prod/bridge/info"), {
      kind: "bridge",
      name: "info",
    });
    assert.deepEqual(classifyTopic("z2m/prod", "zigbee2mqtt/bridge/info"), { kind: "foreign" });
  });
});
