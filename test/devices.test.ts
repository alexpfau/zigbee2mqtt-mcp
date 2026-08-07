import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildHealthReport, detectCapabilities, isCoordinator, normalize } from "../src/devices.js";
import type { Capabilities, Device } from "../src/devices.js";
import { config, device, hoursAgo, rawDevice } from "./helpers.js";

const CAPS: Capabilities = {
  last_seen: true,
  availability: true,
  coordinator_check: true,
  coordinator_type: "zStack3x0",
};

function report(devices: Device[], overrides: Partial<Parameters<typeof buildHealthReport>[5]> = {}) {
  return buildHealthReport(devices, undefined, undefined, undefined, CAPS, config(overrides));
}

describe("isCoordinator", () => {
  it("identifies the coordinator by type", () => {
    assert.equal(isCoordinator(rawDevice({ type: "Coordinator" })), true);
    assert.equal(isCoordinator(rawDevice({ type: "Router" })), false);
  });
});

describe("detectCapabilities", () => {
  const noAvailability = new Map<string, string>();

  it("treats last_seen 'disable' as unavailable", () => {
    const caps = detectCapabilities({ config: { advanced: { last_seen: "disable" } } }, noAvailability);
    assert.equal(caps.last_seen, false);
  });

  it("treats any other last_seen format as available", () => {
    const caps = detectCapabilities({ config: { advanced: { last_seen: "ISO_8601" } } }, noAvailability);
    assert.equal(caps.last_seen, true);
  });

  it("degrades gracefully when bridge info is missing entirely", () => {
    const caps = detectCapabilities(undefined, noAvailability);
    assert.deepEqual(caps, {
      last_seen: false,
      availability: false,
      coordinator_check: false,
      coordinator_type: undefined,
    });
  });

  it("infers availability from observed retained topics", () => {
    const caps = detectCapabilities({}, new Map([["lamp", "online"]]));
    assert.equal(caps.availability, true);
  });

  it("accepts availability configured as either true or an options object", () => {
    assert.equal(detectCapabilities({ config: { availability: true } }, noAvailability).availability, true);
    assert.equal(
      detectCapabilities({ config: { availability: { active: { timeout: 10 } } } }, noAvailability).availability,
      true,
    );
    assert.equal(detectCapabilities({ config: { availability: false } }, noAvailability).availability, false);
  });

  it("offers coordinator_check only for Texas Instruments adapters", () => {
    const caps = (type: string) => detectCapabilities({ coordinator: { type } }, noAvailability);
    assert.equal(caps("zStack3x0").coordinator_check, true);
    assert.equal(caps("znp").coordinator_check, true);
    assert.equal(caps("EmberZNet").coordinator_check, false);
    assert.equal(caps("ConBee").coordinator_check, false);
    assert.equal(caps("EmberZNet").coordinator_type, "EmberZNet");
  });
});

describe("normalize", () => {
  const noState = new Map<string, Record<string, unknown>>();
  const noAvailability = new Map<string, string>();

  it("marks a device without published state", () => {
    const out = normalize(rawDevice(), noState, noAvailability);
    assert.equal(out.has_state, false);
    assert.equal(out.linkquality, undefined);
  });

  it("merges live state in by friendly name", () => {
    const state = new Map([["lamp", { linkquality: 42, battery: 88, last_seen: "2026-01-01T00:00:00Z" }]]);
    const out = normalize(rawDevice(), state, new Map([["lamp", "online"]]));
    assert.equal(out.has_state, true);
    assert.equal(out.linkquality, 42);
    assert.equal(out.battery, 88);
    assert.equal(out.last_seen, "2026-01-01T00:00:00Z");
    assert.equal(out.availability, "online");
  });

  it("ignores non-numeric linkquality and battery", () => {
    const state = new Map([["lamp", { linkquality: "42", battery: null }]]);
    const out = normalize(rawDevice(), state as never, noAvailability);
    assert.equal(out.linkquality, undefined);
    assert.equal(out.battery, undefined);
  });

  it("derives interview_state from the legacy interview_completed flag", () => {
    assert.equal(normalize(rawDevice({ interview_completed: true }), noState, noAvailability).interview_state, "SUCCESSFUL");
    assert.equal(normalize(rawDevice({ interview_completed: false }), noState, noAvailability).interview_state, "PENDING");
  });

  it("prefers an explicit interview_state over the legacy flag", () => {
    const out = normalize(
      rawDevice({ interview_state: "IN_PROGRESS", interview_completed: true }),
      noState,
      noAvailability,
    );
    assert.equal(out.interview_state, "IN_PROGRESS");
  });

  it("defaults supported to true and disabled to false when absent", () => {
    const out = normalize(rawDevice(), noState, noAvailability);
    assert.equal(out.supported, true);
    assert.equal(out.disabled, false);
    assert.equal(normalize(rawDevice({ supported: false }), noState, noAvailability).supported, false);
  });

  it("prefers a user description over the definition description", () => {
    const out = normalize(
      rawDevice({ description: "Reading lamp", definition: { description: "Smart bulb" } }),
      noState,
      noAvailability,
    );
    assert.equal(out.description, "Reading lamp");
  });

  it("falls back to the definition description and copies model and vendor", () => {
    const out = normalize(
      rawDevice({ definition: { description: "Smart bulb", model: "LED1836G9", vendor: "IKEA" } }),
      noState,
      noAvailability,
    );
    assert.equal(out.description, "Smart bulb");
    assert.equal(out.model, "LED1836G9");
    assert.equal(out.vendor, "IKEA");
  });

  it("counts endpoints", () => {
    assert.equal(normalize(rawDevice({ endpoints: { 1: {}, 2: {} } }), noState, noAvailability).endpoint_count, 2);
    assert.equal(normalize(rawDevice(), noState, noAvailability).endpoint_count, 0);
  });
});

describe("buildHealthReport", () => {
  it("reports no issues for a healthy estate", () => {
    const out = report([device({ linkquality: 120, battery: 90 })]);
    assert.deepEqual(out.issues, {});
    assert.equal(out.totals.issue_count, 0);
  });

  it("omits empty issue classes rather than returning empty arrays", () => {
    const out = report([device({ availability: "offline", linkquality: 100 })]);
    assert.deepEqual(Object.keys(out.issues), ["offline"]);
  });

  it("suppresses all other checks for a disabled device", () => {
    const out = report([
      device({ disabled: true, availability: "offline", battery: 1, linkquality: 1, interview_state: "PENDING" }),
    ]);
    assert.deepEqual(Object.keys(out.issues), ["disabled"]);
    assert.equal(out.totals.issue_count, 1);
  });

  it("flags an offline device", () => {
    assert.equal(report([device({ availability: "offline", linkquality: 100 })]).issues.offline?.length, 1);
    assert.equal(report([device({ availability: "online", linkquality: 100 })]).issues.offline, undefined);
  });

  it("flags an incomplete interview", () => {
    const out = report([device({ interview_state: "IN_PROGRESS", linkquality: 100 })]);
    assert.match(out.issues.interview_incomplete![0]!.detail, /IN_PROGRESS/);
  });

  it("flags an unsupported device and names the model when known", () => {
    const out = report([device({ supported: false, model: "TS0601", linkquality: 100 })]);
    assert.match(out.issues.unsupported![0]!.detail, /TS0601/);
  });

  it("applies the weak link threshold exclusively", () => {
    assert.equal(report([device({ linkquality: 29 })]).issues.weak_link?.length, 1);
    assert.equal(report([device({ linkquality: 30 })]).issues.weak_link, undefined);
  });

  it("applies the low battery threshold exclusively", () => {
    assert.equal(report([device({ battery: 19, linkquality: 100 })]).issues.low_battery?.length, 1);
    assert.equal(report([device({ battery: 20, linkquality: 100 })]).issues.low_battery, undefined);
  });

  it("honours a device-reported battery_low flag above the threshold", () => {
    const out = report([device({ battery: 80, battery_low: true, linkquality: 100 })]);
    assert.match(out.issues.low_battery![0]!.detail, /reports battery_low/);
  });

  it("does not double-report a device that is both low and flagged", () => {
    const out = report([device({ battery: 5, battery_low: true, linkquality: 100 })]);
    assert.equal(out.issues.low_battery!.length, 1);
    assert.match(out.issues.low_battery![0]!.detail, /battery=5%/);
  });

  it("reports an available OTA update with versions when present", () => {
    const withVersions = report([
      device({ linkquality: 100, update: { state: "available", installed_version: 1, latest_version: 2 } }),
    ]);
    assert.match(withVersions.issues.update_available![0]!.detail, /1 -> 2/);

    const withoutVersions = report([device({ linkquality: 100, update: { state: "available" } })]);
    assert.equal(withoutVersions.issues.update_available![0]!.detail, "OTA update available");
  });

  it("ignores an up-to-date device", () => {
    assert.equal(report([device({ linkquality: 100, update: { state: "idle" } })]).issues.update_available, undefined);
  });

  it("flags a stale device against the configured window", () => {
    assert.equal(report([device({ linkquality: 100, last_seen: hoursAgo(25) })]).issues.stale?.length, 1);
    assert.equal(report([device({ linkquality: 100, last_seen: hoursAgo(1) })]).issues.stale, undefined);
  });

  it("respects a custom stale window", () => {
    const out = report([device({ linkquality: 100, last_seen: hoursAgo(5) })], { staleHours: 4 });
    assert.equal(out.issues.stale?.length, 1);
  });

  it("never reports staleness when last_seen is unavailable", () => {
    const caps = { ...CAPS, last_seen: false };
    const out = buildHealthReport(
      [device({ linkquality: 100, last_seen: hoursAgo(500) })],
      undefined,
      undefined,
      undefined,
      caps,
      config(),
    );
    assert.equal(out.issues.stale, undefined);
  });

  it("ignores an unparseable last_seen rather than reporting nonsense", () => {
    assert.equal(report([device({ linkquality: 100, last_seen: "not a date" })]).issues.stale, undefined);
  });

  it("derives rejoining, address churn and silence from bridge health counters", () => {
    const d = device({ linkquality: 100 });
    const health = {
      devices: {
        [d.ieee_address]: { leave_count: 3, network_address_changes: 2, messages: 0 },
      },
    };
    const out = buildHealthReport([d], undefined, undefined, health, CAPS, config());
    assert.match(out.issues.rejoining![0]!.detail, /3 time\(s\)/);
    assert.match(out.issues.address_changing![0]!.detail, /2 time\(s\)/);
    assert.equal(out.issues.silent?.length, 1);
  });

  it("does not flag a device that has sent messages", () => {
    const d = device({ linkquality: 100 });
    const health = { devices: { [d.ieee_address]: { leave_count: 0, network_address_changes: 0, messages: 42 } } };
    const out = buildHealthReport([d], undefined, undefined, health, CAPS, config());
    assert.deepEqual(out.issues, {});
  });

  it("counts devices by type", () => {
    const out = report([
      device({ friendly_name: "a", type: "Router", linkquality: 100 }),
      device({ friendly_name: "b", type: "EndDevice", linkquality: 100 }),
      device({ friendly_name: "c", type: "EndDevice", linkquality: 100 }),
    ]);
    assert.equal(out.totals.devices, 3);
    assert.equal(out.totals.routers, 1);
    assert.equal(out.totals.end_devices, 2);
  });

  it("sums issue_count across every class", () => {
    const out = report([device({ availability: "offline", linkquality: 5, battery: 2 })]);
    assert.equal(out.totals.issue_count, 3);
  });

  describe("hints", () => {
    const hintsFor = (caps: Partial<Capabilities>, devices: Device[] = [device({ linkquality: 100 })]) =>
      buildHealthReport(devices, undefined, undefined, undefined, { ...CAPS, ...caps }, config()).hints.join("\n");

    it("explains why staleness checks are missing", () => {
      assert.match(hintsFor({ last_seen: false }), /advanced\.last_seen/);
      assert.doesNotMatch(hintsFor({}), /advanced\.last_seen is 'disable'/);
    });

    it("explains why offline detection is missing", () => {
      assert.match(hintsFor({ availability: false }), /availability\.enabled/);
    });

    it("warns that staleness coverage is still filling in", () => {
      const devices = [device({ linkquality: 100, has_state: true, last_seen: undefined })];
      assert.match(hintsFor({}, devices), /coverage is partial/);
    });

    it("does not warn about partial coverage once every device has a timestamp", () => {
      const devices = [device({ linkquality: 100, has_state: true, last_seen: hoursAgo(1) })];
      assert.doesNotMatch(hintsFor({}, devices), /coverage is partial/);
    });

    it("explains absent link quality data", () => {
      assert.match(hintsFor({}, [device({ linkquality: undefined })]), /No link quality data yet/);
      assert.doesNotMatch(hintsFor({}, [device({ linkquality: 100 })]), /No link quality data yet/);
    });

    it("surfaces a pending restart and a bridge that is not online", () => {
      const out = buildHealthReport(
        [device({ linkquality: 100 })],
        { restart_required: true },
        { state: "offline" },
        undefined,
        CAPS,
        config(),
      );
      assert.match(out.hints.join("\n"), /restart_required=true/);
      assert.match(out.hints.join("\n"), /Bridge state is 'offline'/);
    });
  });

  it("summarises the bridge", () => {
    const out = buildHealthReport(
      [],
      { version: "2.12.1", permit_join: false, restart_required: false },
      { state: "online" },
      undefined,
      CAPS,
      config(),
    );
    assert.equal(out.bridge.state, "online");
    assert.equal(out.bridge.version, "2.12.1");
    assert.equal(out.bridge.coordinator_type, "zStack3x0");
  });

  it("reports an unknown bridge state rather than throwing when nothing is cached", () => {
    const out = buildHealthReport([], undefined, undefined, undefined, CAPS, config());
    assert.equal(out.bridge.state, "unknown");
    assert.equal(out.totals.devices, 0);
  });
});
