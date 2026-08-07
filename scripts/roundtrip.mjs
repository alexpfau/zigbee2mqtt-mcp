#!/usr/bin/env node
// Sequential regression test for read-after-write consistency.
//
// Zigbee2MQTT acknowledges a mutation before republishing its retained bridge
// topics. If the server returns too early, a follow-up call operates on a stale
// cache and cannot see what was just changed. This exercises that path strictly
// sequentially, awaiting each response before sending the next.
//
//   Z2M_MQTT_URL=mqtt://host:1883 node scripts/roundtrip.mjs
//
// Set Z2M_TEST_DEVICE to choose the device; otherwise the first end device is
// used. The original name is always restored, including on failure.
// Set ROUNDTRIP_GROUPS_ONLY=1 to skip the rename section: group operations do
// not resolve names through the cache, so their cleanup is safe even when the
// read-after-write fix is absent.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const SUFFIX = " zzz-mcp-roundtrip";
const GROUP = "zzz-mcp-roundtrip-group";

const child = spawn("node", ["dist/index.js"], { stdio: ["pipe", "pipe", "inherit"] });
const pending = new Map();
let nextId = 1;

createInterface({ input: child.stdout }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const resolve = pending.get(message.id);
  if (resolve) {
    pending.delete(message.id);
    resolve(message);
  }
});

const rpc = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });

async function call(name, args = {}) {
  const response = await rpc("tools/call", { name, arguments: args });
  const text = response.result?.content?.[0]?.text ?? "";
  if (response.result?.isError) throw new Error(`${name}: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

let passed = 0;
let failed = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? ` -> ${detail}` : ""}`);
  ok ? passed++ : failed++;
};

await rpc("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "roundtrip", version: "1" },
});
child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

const { devices } = await call("z2m_list_devices", {});
const original =
  process.env.Z2M_TEST_DEVICE ||
  devices.find((d) => d.type === "EndDevice" && !d.disabled)?.friendly_name;
if (!original) throw new Error("No suitable test device found");
const renamed = original + SUFFIX;

console.log(`\ndevice under test: ${original}\n`);
let isRenamed = false;

try {
  if (process.env.ROUNDTRIP_GROUPS_ONLY !== "1") {
    console.log("read-after-write: device rename");
    await call("z2m_rename_device", { device: original, new_name: renamed });
    isRenamed = true;

    const afterRename = await call("z2m_get_device", { device: renamed });
    check("new name visible immediately", afterRename.friendly_name === renamed, afterRename.friendly_name);

    const stale = await call("z2m_list_devices", { search: SUFFIX.trim() });
    check("list_devices reflects rename", stale.devices.length === 1, `${stale.devices.length} match(es)`);

    await call("z2m_rename_device", { device: renamed, new_name: original });
    isRenamed = false;

    const afterRevert = await call("z2m_get_device", { device: original });
    check("original name visible immediately", afterRevert.friendly_name === original, afterRevert.friendly_name);
  }

  console.log("\nread-after-write: group lifecycle");
  await call("z2m_manage_group", { action: "add", group: GROUP });
  const withGroup = await call("z2m_list_groups", {});
  const present = withGroup.groups.some((g) => g.friendly_name === GROUP);
  check("new group visible immediately", present);

  await call("z2m_manage_group", { action: "remove", group: GROUP, confirm: true });
  const withoutGroup = await call("z2m_list_groups", {});
  const gone = !withoutGroup.groups.some((g) => g.friendly_name === GROUP);
  check("group removal visible immediately", gone);
} catch (error) {
  check("unexpected error", false, error.message);
} finally {
  if (isRenamed) {
    console.log("\ncleanup: restoring original device name");
    await call("z2m_rename_device", { device: renamed, new_name: original }).catch((e) =>
      console.error(`  CLEANUP FAILED, device may still be named "${renamed}": ${e.message}`),
    );
  }
  await call("z2m_manage_group", { action: "remove", group: GROUP, confirm: true }).catch(() => undefined);
}

console.log(`\n${passed} passed, ${failed} failed`);
child.stdin.end();
child.kill();
process.exit(failed > 0 ? 1 : 0);
