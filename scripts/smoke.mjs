#!/usr/bin/env node
// Manual smoke test against a real Zigbee2MQTT instance.
//
//   Z2M_MQTT_URL=mqtt://host:1883 Z2M_MQTT_USERNAME=... Z2M_MQTT_PASSWORD=... \
//     node scripts/smoke.mjs [tool] [jsonArgs]
//
// With no arguments it runs the read-only tools. Passing a tool name calls just
// that tool, e.g.  node scripts/smoke.mjs z2m_list_devices '{"only_problems":true}'

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const [, , toolArg, argsArg] = process.argv;

const calls = toolArg
  ? [{ name: toolArg, arguments: argsArg ? JSON.parse(argsArg) : {} }]
  : [
      { name: "z2m_bridge_info", arguments: {} },
      { name: "z2m_health_report", arguments: {} },
      { name: "z2m_list_devices", arguments: { only_problems: true, limit: 5 } },
      { name: "z2m_list_groups", arguments: {} },
    ];

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

const send = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });

const notify = (method) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);

let failures = 0;

await send("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "smoke", version: "1" },
});
notify("notifications/initialized");

const listed = await send("tools/list", {});
console.log(`tools exposed: ${listed.result.tools.length}`);
console.log(listed.result.tools.map((t) => `  - ${t.name}`).join("\n"));

for (const call of calls) {
  const started = Date.now();
  const response = await send("tools/call", { name: call.name, arguments: call.arguments });
  const ms = Date.now() - started;
  const text = response.result?.content?.[0]?.text ?? JSON.stringify(response.error);
  const failed = response.result?.isError || response.error;
  if (failed) failures++;
  console.log(`\n=== ${call.name} (${ms}ms) ${failed ? "FAILED" : "ok"} ===`);
  const max = Number(process.env.SMOKE_MAX ?? 4000);
  console.log(text.length > max ? `${text.slice(0, max)}\n... [truncated]` : text);
}

child.stdin.end();
child.kill();
process.exit(failures > 0 ? 1 : 0);
