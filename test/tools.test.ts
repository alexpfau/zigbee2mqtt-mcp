import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Z2MClient } from "../src/client.js";
import { findRaw, selectTools, type ToolDef } from "../src/tools.js";
import { config, rawDevice } from "./helpers.js";

const ALL = selectTools("full");

/** Fails the test if a handler reaches the network before its safety check. */
function forbiddenClient(): Z2MClient {
  const reject = () => {
    throw new Error("handler reached the client without confirmation");
  };
  return { request: reject, publish: reject, snapshot: reject, connect: reject } as unknown as Z2MClient;
}

async function callsThrough(tool: ToolDef, args: Record<string, unknown>): Promise<boolean> {
  try {
    await tool.handler(args, { client: forbiddenClient(), config: config() });
  } catch (error) {
    return (error as Error).message === "handler reached the client without confirmation";
  }
  return true;
}

describe("selectTools", () => {
  it("exposes only read-only tools when writes are off", () => {
    const tools = selectTools("off");
    assert.ok(tools.length > 0);
    assert.ok(tools.every((t) => t.tier === "read"));
  });

  it("adds reversible tools in safe mode but withholds the destructive tier", () => {
    const tools = selectTools("safe");
    assert.ok(tools.some((t) => t.tier === "safe"));
    assert.ok(!tools.some((t) => t.tier === "full"));
  });

  it("exposes every tier in full mode", () => {
    assert.ok(ALL.some((t) => t.tier === "full"));
  });

  it("widens monotonically as the write mode is raised", () => {
    const off = selectTools("off").map((t) => t.name);
    const safe = selectTools("safe").map((t) => t.name);
    const full = ALL.map((t) => t.name);
    assert.ok(off.every((n) => safe.includes(n)), "safe mode dropped a read tool");
    assert.ok(safe.every((n) => full.includes(n)), "full mode dropped a safe tool");
    assert.ok(off.length < safe.length && safe.length < full.length);
  });

  it("never returns duplicate tool names", () => {
    assert.equal(new Set(ALL.map((t) => t.name)).size, ALL.length);
  });
});

describe("tool definitions", () => {
  it("namespaces every tool", () => {
    for (const tool of ALL) assert.ok(tool.name.startsWith("z2m_"), `${tool.name} is not namespaced`);
  });

  it("gives every tool a description and an annotation title", () => {
    for (const tool of ALL) {
      assert.ok(tool.description.length > 40, `${tool.name} has a thin description`);
      assert.ok(tool.annotations.title.length > 0, `${tool.name} has no title`);
    }
  });

  it("marks read-tier tools read-only and every other tier not", () => {
    for (const tool of ALL) {
      assert.equal(
        tool.annotations.readOnlyHint,
        tool.tier === "read",
        `${tool.name} readOnlyHint disagrees with its '${tool.tier}' tier`,
      );
    }
  });

  it("never marks a read-only tool destructive", () => {
    for (const tool of ALL.filter((t) => t.annotations.readOnlyHint)) {
      assert.equal(tool.annotations.destructiveHint, false, `${tool.name} is both read-only and destructive`);
    }
  });

  it("marks every full-tier tool destructive", () => {
    for (const tool of ALL.filter((t) => t.tier === "full")) {
      assert.equal(tool.annotations.destructiveHint, true, `${tool.name} is in the full tier but not destructive`);
    }
  });

  it("requires explicit confirmation for every full-tier tool", () => {
    for (const tool of ALL.filter((t) => t.tier === "full")) {
      assert.ok(
        tool.inputSchema.required?.includes("confirm"),
        `${tool.name} is in the full tier but does not require confirm`,
      );
    }
  });

  it("offers a confirm flag on every destructive tool that stays in safe mode", () => {
    // These reduce state, so they are honestly annotated destructive even though
    // the tier keeps them available without opting into full write mode.
    const safeButDestructive = selectTools("safe").filter((t) => t.annotations.destructiveHint);
    assert.ok(safeButDestructive.length > 0, "expected some safe-tier destructive tools");
    for (const tool of safeButDestructive) {
      if (tool.name === "z2m_rename_device") continue; // reversible by renaming back
      assert.ok(
        Object.hasOwn(tool.inputSchema.properties, "confirm"),
        `${tool.name} can reduce state but offers no confirm flag`,
      );
    }
  });

  it("declares every tool as reaching the open world", () => {
    for (const tool of ALL) assert.equal(tool.annotations.openWorldHint, true, tool.name);
  });

  it("only requires input fields it also declares", () => {
    for (const tool of ALL) {
      for (const field of tool.inputSchema.required ?? []) {
        assert.ok(
          Object.hasOwn(tool.inputSchema.properties, field),
          `${tool.name} requires '${field}' but does not declare it`,
        );
      }
    }
  });

  it("describes every input property", () => {
    for (const tool of ALL) {
      for (const [name, schema] of Object.entries(tool.inputSchema.properties)) {
        const s = schema as { type?: unknown; description?: unknown; enum?: unknown };
        assert.ok(s.type !== undefined, `${tool.name}.${name} has no type`);
        assert.ok(
          s.description !== undefined || s.enum !== undefined,
          `${tool.name}.${name} has neither a description nor an enum`,
        );
      }
    }
  });

  it("exposes a connection diagnostic in the most restrictive mode", () => {
    // Diagnosing a broken connection must not require enabling writes.
    assert.ok(selectTools("off").some((t) => t.name === "z2m_connection_status"));
  });
});

describe("findRaw", () => {
  const devices = [
    rawDevice({ friendly_name: "Kitchen Lamp", ieee_address: "0x00158d0000000001" }),
    rawDevice({ friendly_name: "Kitchen Lamp Left", ieee_address: "0x00158d0000000002" }),
    rawDevice({ friendly_name: "Hallway Sensor", ieee_address: "0x00158d0000000003" }),
  ];

  it("matches an exact friendly name", () => {
    assert.equal(findRaw(devices, "Hallway Sensor").ieee_address, "0x00158d0000000003");
  });

  it("matches an exact ieee address", () => {
    assert.equal(findRaw(devices, "0x00158d0000000002").friendly_name, "Kitchen Lamp Left");
  });

  it("ignores case in both forms", () => {
    assert.equal(findRaw(devices, "hallway sensor").friendly_name, "Hallway Sensor");
    assert.equal(findRaw(devices, "0X00158D0000000003").friendly_name, "Hallway Sensor");
  });

  it("prefers an exact match over an ambiguous prefix", () => {
    // 'Kitchen Lamp' is also a prefix of 'Kitchen Lamp Left'.
    assert.equal(findRaw(devices, "Kitchen Lamp").ieee_address, "0x00158d0000000001");
  });

  it("accepts an unambiguous partial name", () => {
    assert.equal(findRaw(devices, "Hallway").friendly_name, "Hallway Sensor");
  });

  it("refuses an ambiguous partial name and lists the candidates", () => {
    assert.throws(() => findRaw(devices, "Kitchen"), (error: Error) => {
      assert.match(error.message, /matches 2 devices/);
      assert.match(error.message, /Kitchen Lamp Left/);
      return true;
    });
  });

  it("reports an unknown device with a next step", () => {
    assert.throws(() => findRaw(devices, "Bathroom"), /No device matches 'Bathroom'.*z2m_list_devices/s);
  });

  it("refuses an empty identifier instead of matching an arbitrary device", () => {
    // Every name contains the empty string, so this would otherwise resolve.
    assert.throws(() => findRaw([devices[0]!], ""), /required/);
    assert.throws(() => findRaw([devices[0]!], "   "), /required/);
  });

  it("does not fall back to a substring of an ieee address", () => {
    assert.throws(() => findRaw(devices, "0x00158d00000000"), /No device matches/);
  });
});
