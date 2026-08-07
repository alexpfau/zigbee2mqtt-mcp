#!/usr/bin/env node
/**
 * Mutation check for the unit suite.
 *
 * A passing test suite only proves the tests ran. This deliberately breaks the
 * source one change at a time and asserts the suite notices each one. A mutant
 * that survives marks behaviour nothing actually tests.
 *
 *   node scripts/mutate.mjs            # every mutant
 *   node scripts/mutate.mjs redact     # only mutants whose name matches
 *
 * Exits non-zero if any mutant survives. Source files are always restored,
 * including on Ctrl-C.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Each entry replaces `from` with `to` in `file`; `from` must appear exactly once. */
const MUTANTS = [
  {
    name: "coordinator_check gated on vendor again",
    file: "src/devices.ts",
    from: "const BACKUP_CAPABLE = /^(zStack|znp|ember)/i;",
    to: "const BACKUP_CAPABLE = /^z(Stack|np)/i;",
  },
  {
    name: "weak-link boundary off-by-one",
    file: "src/devices.ts",
    from: "device.linkquality < config.weakLinkThreshold",
    to: "device.linkquality <= config.weakLinkThreshold",
  },
  {
    name: "low-battery boundary off-by-one",
    file: "src/devices.ts",
    from: "device.battery < config.lowBatteryThreshold",
    to: "device.battery <= config.lowBatteryThreshold",
  },
  {
    name: "disabled devices no longer short-circuit",
    file: "src/devices.ts",
    from: "continue; // disabled devices produce no traffic, so other checks are noise",
    to: "",
  },
  {
    name: "staleness ignores the capability gate",
    file: "src/devices.ts",
    from: "if (capabilities.last_seen && device.last_seen) {",
    to: "if (device.last_seen) {",
  },
  {
    name: "availability name split on the first slash",
    file: "src/topics.ts",
    from: 'return { kind: "availability", device: rest.slice(0, -AVAILABILITY_SUFFIX.length) };',
    to: 'return { kind: "availability", device: rest.split("/")[0]! };',
  },
  {
    name: "command topics fall through to state",
    file: "src/topics.ts",
    from: 'if (COMMAND.test(rest)) return { kind: "command" };',
    to: "",
  },
  {
    name: "base topic prefix matched loosely",
    file: "src/topics.ts",
    from: "const prefix = `${baseTopic}/`;",
    to: "const prefix = baseTopic;",
  },
  {
    name: "broker password no longer redacted",
    file: "src/redact.ts",
    from: 'if (parsed.password) parsed.password = "***";',
    to: "",
  },
  {
    name: "schemeless URL echoed verbatim",
    file: "src/redact.ts",
    from: 'if (!BROKER_SCHEME.test(url)) return "<malformed broker URL>";',
    to: "",
  },
  {
    name: "query-string token survives redaction",
    file: "src/redact.ts",
    from: 'parsed.search = "";',
    to: "",
  },
  {
    name: "userinfo scrubbing removed",
    file: "src/redact.ts",
    from: 'let out = text.replace(USERINFO, "$1***@");',
    to: "let out = text;",
  },
  {
    name: "bare password no longer scrubbed",
    file: "src/redact.ts",
    from: 'if (password && password.length >= 6) out = out.split(password).join("***");',
    to: "",
  },
  {
    name: "status reports the raw broker URL",
    file: "src/client.ts",
    from: "broker_url: this.safeUrl,",
    to: "broker_url: this.config.mqttUrl,",
  },
  {
    name: "response correlation ignores the sub-topic",
    file: "src/client.ts",
    from: "const waiter = this.waiters.get(waiterKey(subTopic, response.transaction));",
    to: 'const waiter = this.waiters.get(waiterKey("", response.transaction));',
  },
  {
    name: "malformed response still invokes the waiter",
    file: "src/client.ts",
    from: 'if (!parsed || typeof parsed !== "object") return;\n    const response = parsed as BridgeResponse;',
    to: "const response = (parsed ?? {}) as BridgeResponse;",
  },
  {
    name: "own request echo cached again",
    file: "src/client.ts",
    from: 'if (route.name.startsWith("request/")) return;',
    to: "",
  },
  {
    name: "relayed bridge logs no longer scrubbed",
    file: "src/client.ts",
    from: "message: scrubSecrets(String(entry.message ?? raw), this.config),",
    to: "message: String(entry.message ?? raw),",
  },
  {
    name: "log buffer unbounded",
    file: "src/client.ts",
    from: "if (buffer.length > max) buffer.splice(0, buffer.length - max);",
    to: "",
  },
  {
    name: "write tiers collapse",
    file: "src/tools.ts",
    from: "const TIER_RANK: Record<Tier, number> = { read: 0, safe: 1, full: 2 };",
    to: "const TIER_RANK: Record<Tier, number> = { read: 0, safe: 1, full: 1 };",
  },
  {
    name: "bind clear no longer confirmed",
    file: "src/tools.ts",
    from: "requireConfirm(args, `Clearing every binding from '${String(args.from)}'`);",
    to: "",
  },
  {
    name: "group removal no longer confirmed",
    file: "src/tools.ts",
    from: "requireConfirm(args, `Removing group '${group}'`);",
    to: "",
  },
  {
    name: "confirmation check inverted",
    file: "src/tools.ts",
    from: "if (args.confirm !== true) {",
    to: "if (args.confirm === true && false) {",
  },
  {
    name: "empty device identifier matches anything",
    file: "src/tools.ts",
    from: 'if (!needle) throw new Error("A device friendly_name or ieee_address is required.");',
    to: "",
  },
  {
    name: "connection status blocked when unconfigured",
    file: "src/tools.ts",
    from: "runsUnconfigured: true,",
    to: "",
  },
  {
    name: "broker handshake ignored",
    file: "src/tools.ts",
    from: "brokerReachable = ctx.client.status().broker_handshake || e instanceof NoBridgeDataError;",
    to: "brokerReachable = e instanceof NoBridgeDataError;",
  },
  {
    name: "write mode defaults to full",
    file: "src/config.ts",
    from: '"off", "safe", "full"] as const, "safe")',
    to: '"off", "safe", "full"] as const, "full")',
  },
  {
    name: "logger writes to stdout",
    file: "src/config.ts",
    from: "console.error(`[zigbee2mqtt-mcp] [${at}]`, ...args);",
    to: "console.log(`[zigbee2mqtt-mcp] [${at}]`, ...args);",
  },
  {
    name: "int accepts trailing junk",
    file: "src/config.ts",
    from: "if (!/^-?\\d+$/.test(raw.trim())) {",
    to: "if (false) {",
  },
  {
    name: "negative timeouts accepted",
    file: "src/config.ts",
    from: "if (parsed < 0) {",
    to: "if (false) {",
  },
  {
    name: "binds/clear reverts to the id key",
    file: "src/tools.ts",
    from: 'const clear: Record<string, unknown> = { target: String(args.from) };',
    to: "const clear: Record<string, unknown> = { id: String(args.from) };",
  },
  {
    name: "rename sends from and to swapped",
    file: "src/tools.ts",
    from: "        from: target.friendly_name,",
    to: "        from: String(args.new_name),",
  },
  {
    name: "touchlink accepts a half-specified target",
    file: "src/tools.ts",
    from: "if (hasAddress !== hasChannel) {",
    to: "if (false) {",
  },
  {
    name: "touchlink resets the nearest device unasked",
    file: "src/tools.ts",
    from: '} else if (action !== "scan" && args.nearest !== true) {',
    to: "} else if (false) {",
  },
  {
    name: "bind endpoints dropped",
    file: "src/tools.ts",
    from: "if (args.from_endpoint !== undefined) payload.from_endpoint = args.from_endpoint;",
    to: "",
  },
  {
    name: "group member endpoint dropped",
    file: "src/tools.ts",
    from: "            ...(args.endpoint !== undefined ? { endpoint: args.endpoint } : {}),\n          });\n        case \"remove_member\":",
    to: "          });\n        case \"remove_member\":",
  },
  {
    name: "numeric arguments unvalidated again",
    file: "src/tools.ts",
    from: "  if (!Number.isFinite(value)) {",
    to: "  if (false) {",
  },
  {
    name: "permit_join_end scaled by 1000 again",
    file: "src/tools.ts",
    from: "? new Date(Number(info.permit_join_end)).toISOString()",
    to: "? new Date(Number(info.permit_join_end) * 1000).toISOString()",
  },
  {
    name: "outbound errors no longer scrubbed",
    file: "src/render.ts",
    from: "return `${toolName} failed: ${scrubSecrets((error as Error).message, config)}`;",
    to: "return `${toolName} failed: ${(error as Error).message}`;",
  },
  {
    name: "oversized results no longer truncated",
    file: "src/render.ts",
    from: "if (text.length <= MAX_RESULT_BYTES) return text;",
    to: "return text;",
  },
  {
    name: "capped network map hides the real size",
    file: "src/tools.ts",
    from: "        total_nodes: allNodes.length,",
    to: "        total_nodes: nodes.length,",
  },
  {
    name: "network map picks the worst parent",
    file: "src/tools.ts",
    from: "const best = inbound.sort((a, b) => (b.linkquality ?? 0) - (a.linkquality ?? 0))[0];",
    to: "const best = inbound.sort((a, b) => (a.linkquality ?? 0) - (b.linkquality ?? 0))[0];",
  },
];

const filter = process.argv[2];
const selected = filter ? MUTANTS.filter((m) => m.name.includes(filter)) : MUTANTS;
if (selected.length === 0) {
  console.error(`No mutant matches ${JSON.stringify(filter)}.`);
  process.exit(2);
}

// An inherited Z2M_* variable would change what the config tests observe.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("Z2M_")));

/** Set while a file is mutated, so an interrupt cannot leave the tree broken. */
let pending = null;
const restore = () => {
  if (pending) {
    writeFileSync(pending.path, pending.original);
    pending = null;
  }
};
process.on("exit", restore);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    restore();
    process.exit(130);
  });
}

const killed = [];
const survived = [];

for (const mutant of selected) {
  const path = join(ROOT, mutant.file);
  const original = readFileSync(path, "utf8");
  const occurrences = original.split(mutant.from).length - 1;

  if (occurrences !== 1) {
    // The code moved on without the mutant being updated, so it proves nothing.
    console.log(`STALE     ${mutant.name} (anchor appears ${occurrences}x in ${mutant.file})`);
    survived.push(`${mutant.name} — stale anchor`);
    continue;
  }

  pending = { path, original };
  writeFileSync(path, original.replace(mutant.from, mutant.to));

  let detail = "";
  let detected = false;
  try {
    execFileSync("npm", ["test"], { cwd: ROOT, env, stdio: "pipe" });
  } catch (error) {
    detected = true;
    const out = String(error.stdout ?? "");
    const failures = out.split("\n").find((line) => line.trim().startsWith("\u2139 fail"));
    detail = failures ? failures.trim() : "did not compile";
  } finally {
    restore();
  }

  if (detected) {
    console.log(`killed    ${mutant.name}  (${detail})`);
    killed.push(mutant.name);
  } else {
    console.log(`SURVIVED  ${mutant.name}`);
    survived.push(mutant.name);
  }
}

console.log(`\nkilled ${killed.length}/${selected.length}`);
if (survived.length > 0) {
  console.log("\nsurviving mutants — this behaviour is not covered by a test:");
  for (const name of survived) console.log(`  - ${name}`);
  process.exit(1);
}
console.log("every mutant was detected");
