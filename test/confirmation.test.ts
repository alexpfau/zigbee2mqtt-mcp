import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Z2MClient } from "../src/client.js";
import { selectTools, type ToolDef } from "../src/tools.js";
import { config } from "./helpers.js";

const ALL = selectTools("full");
const byName = (name: string): ToolDef => ALL.find((t) => t.name === name)!;

const REACHED = "handler reached the client";

/** Any call through to the network fails loudly, so a missing guard is visible. */
function forbiddenClient(): Z2MClient {
  const reject = () => {
    throw new Error(REACHED);
  };
  return { request: reject, publish: reject, snapshot: reject, connect: reject } as unknown as Z2MClient;
}

/** True when the handler let the call through to the client. */
async function reachedNetwork(tool: ToolDef, args: Record<string, unknown>): Promise<boolean> {
  try {
    await tool.handler(args, { client: forbiddenClient(), config: config() });
    return true;
  } catch (error) {
    return (error as Error).message === REACHED;
  }
}

describe("confirmation gates", () => {
  // Schema `required` is advisory: a client may ignore it, so the handler must
  // enforce confirmation itself. These tests fail if only the schema is updated.
  const fullTier = ALL.filter((t) => t.tier === "full");

  it("covers every full-tier tool", () => {
    assert.deepEqual(
      fullTier.map((t) => t.name).sort(),
      [
        "z2m_ota_update",
        "z2m_remove_device",
        "z2m_restart_bridge",
        "z2m_set_bridge_options",
        "z2m_touchlink",
      ],
      "the full tier changed; review the confirmation gates",
    );
  });

  for (const tool of ALL.filter((t) => t.annotations.destructiveHint && t.tier === "full")) {
    it(`${tool.name} refuses to act without confirm=true`, async () => {
      const args: Record<string, unknown> = { confirm: false };
      // Populate required fields so the confirm check is what stops it.
      for (const field of tool.inputSchema.required ?? []) {
        if (field === "confirm") continue;
        const schema = tool.inputSchema.properties[field] as { type?: string; enum?: string[] };
        args[field] = schema?.enum?.[0] ?? (schema?.type === "number" ? 1 : "placeholder");
      }
      assert.equal(await reachedNetwork(tool, args), false, `${tool.name} acted without confirmation`);
    });
  }

  it("z2m_manage_group refuses to remove a group without confirm", async () => {
    assert.equal(await reachedNetwork(byName("z2m_manage_group"), { action: "remove", group: "kitchen" }), false);
  });

  it("z2m_manage_group refuses to empty a group without confirm", async () => {
    const args = { action: "remove_all_members", group: "kitchen" };
    assert.equal(await reachedNetwork(byName("z2m_manage_group"), args), false);
  });

  it("z2m_manage_group still allows additive actions without confirm", async () => {
    const tool = byName("z2m_manage_group");
    assert.equal(await reachedNetwork(tool, { action: "add", group: "kitchen" }), true);
    assert.equal(await reachedNetwork(tool, { action: "add_member", group: "kitchen", device: "lamp" }), true);
  });

  it("z2m_bind refuses to clear all bindings without confirm", async () => {
    assert.equal(await reachedNetwork(byName("z2m_bind"), { action: "clear", from: "remote" }), false);
  });

  it("z2m_bind still allows bind and unbind without confirm", async () => {
    const tool = byName("z2m_bind");
    assert.equal(await reachedNetwork(tool, { action: "bind", from: "remote", to: "lamp" }), true);
    assert.equal(await reachedNetwork(tool, { action: "unbind", from: "remote", to: "lamp" }), true);
  });

  it("names the tool and the remedy when refusing", async () => {
    await assert.rejects(
      () => byName("z2m_bind").handler({ action: "clear", from: "remote" }, { client: forbiddenClient(), config: config() }),
      /confirm=true/,
    );
  });
});
