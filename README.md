# zigbee2mqtt-mcp

[![CI](https://github.com/alexpfau/zigbee2mqtt-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/alexpfau/zigbee2mqtt-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/zigbee2mqtt-mcp.svg)](https://www.npmjs.com/package/zigbee2mqtt-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![zigbee2mqtt-mcp MCP server](https://glama.ai/mcp/servers/alexpfau/zigbee2mqtt-mcp/badges/score.svg)](https://glama.ai/mcp/servers/alexpfau/zigbee2mqtt-mcp)

A [Model Context Protocol](https://modelcontextprotocol.io) server for **administering** a Zigbee2MQTT estate.

Most Zigbee integrations already let an assistant turn a light on. This one is for the layer underneath: mesh health, weak links, devices that keep rejoining, stale batteries, firmware updates, pairing, binding, reporting intervals and device options — the things you normally open the Zigbee2MQTT frontend for.

It talks directly to the Zigbee2MQTT [MQTT bridge API](https://www.zigbee2mqtt.io/guide/usage/mqtt_topics_and_messages.html), so it works regardless of whether you use Home Assistant, Node-RED, openHAB or nothing at all. Tested against Zigbee2MQTT 2.x; several tools depend on bridge endpoints that only exist there, including `bridge/health`, `device/binds/clear` and the OTA scheduling topics.

## Why this exists

If you already run Home Assistant, your Zigbee devices are exposed there and an assistant can control them. What Home Assistant does *not* expose is the bridge itself: link quality, mesh topology, interview state, OTA availability, `permit_join`, device options, bindings and reporting configuration. This server fills exactly that gap.

## Design

- **No database.** Zigbee2MQTT publishes its bridge topics as retained messages, so a fresh subscription yields a complete picture in a few hundred milliseconds. The server keeps only the latest payload per topic in memory.
- **No daemon.** Pure stdio. It starts and dies with the MCP session.
- **Correlated requests.** Every `bridge/request/*` carries a `transaction` id and is matched to its `bridge/response/*`, so concurrent calls cannot cross wires.
- **Tiered writes.** Destructive operations are gated behind a write mode *and* an explicit `confirm` argument.

## Install

Requires Node.js 22 or newer and network access to the MQTT broker that Zigbee2MQTT uses.

```bash
npx zigbee2mqtt-mcp
```

### VS Code / GitHub Copilot

Add to your MCP configuration:

```jsonc
{
  "servers": {
    "zigbee2mqtt": {
      "command": "npx",
      "args": ["-y", "zigbee2mqtt-mcp"],
      "env": {
        "Z2M_MQTT_URL": "mqtt://192.168.1.10:1883",
        "Z2M_MQTT_USERNAME": "mqtt",
        "Z2M_MQTT_PASSWORD": "${input:z2mPassword}"
      }
    }
  }
}
```

### Claude Desktop

```json
{
  "mcpServers": {
    "zigbee2mqtt": {
      "command": "npx",
      "args": ["-y", "zigbee2mqtt-mcp"],
      "env": {
        "Z2M_MQTT_URL": "mqtt://192.168.1.10:1883"
      }
    }
  }
}
```

> Point `Z2M_MQTT_URL` at your **MQTT broker**, not at the Zigbee2MQTT frontend port. If Zigbee2MQTT's `configuration.yaml` says `mqtt.server: mqtt://192.168.1.10:1883`, use that value verbatim.

> Behind a corporate npm proxy? If `npm config get registry` is not `https://registry.npmjs.org/`, your proxy's upstream feed may not carry this package. Add an explicit override to the args rather than changing your global registry:
> `"args": ["-y", "--registry", "https://registry.npmjs.org/", "zigbee2mqtt-mcp"]`

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `Z2M_MQTT_URL` | *required* | Broker URL. `mqtt://`, `mqtts://`, `ws://`, `wss://` |
| `Z2M_MQTT_USERNAME` / `Z2M_MQTT_PASSWORD` | – | Broker credentials |
| `Z2M_BASE_TOPIC` | `zigbee2mqtt` | Must match `mqtt.base_topic` |
| `Z2M_MQTT_CLIENT_ID` | `zigbee2mqtt-mcp-<pid>` | Override if your broker requires a fixed client ID |
| `Z2M_WRITE_MODE` | `safe` | `off`, `safe` or `full` |
| `Z2M_LOG_LEVEL` | `error` | Diagnostics on stderr |
| `Z2M_WEAK_LINK_THRESHOLD` | `30` | Link quality below this is flagged |
| `Z2M_LOW_BATTERY_THRESHOLD` | `20` | Battery percentage below this is flagged |
| `Z2M_STALE_HOURS` | `24` | Hours of silence before a device is stale |
| `Z2M_CONNECT_TIMEOUT_MS` | `10000` | Broker connect timeout |
| `Z2M_REQUEST_TIMEOUT_MS` | `15000` | Default bridge request timeout |
| `Z2M_MQTT_REJECT_UNAUTHORIZED` | `true` | Set `false` for self-signed TLS |
| `Z2M_MQTT_CA` / `_CERT` / `_KEY` | – | Paths to TLS material |

## Write modes

Tools above the active tier are not registered at all, so a model cannot reach for them.

| Mode | Exposes |
| --- | --- |
| `off` | Read-only tools |
| `safe` | **Default.** Read plus non-destructive writes: pairing, options, rename, configure, interview, binding, reporting, groups, state |
| `full` | Everything, including device removal, OTA flashing, Touchlink and bridge restart |

Irreversible tools (`z2m_remove_device`, `z2m_ota_update`, `z2m_touchlink`, `z2m_restart_bridge`, `z2m_set_bridge_options`) additionally require `confirm: true` on every call. Three `safe` tools reduce state rather than only adding to it, so they are annotated destructive: `z2m_rename_device`, `z2m_manage_group` and `z2m_bind`. Their reducing actions also require `confirm: true` — `z2m_manage_group` (`remove`, `remove_all_members`) and `z2m_bind` (`clear`). `z2m_rename_device` is annotated destructive because it breaks anything referencing the old name, but stays unconfirmed since renaming back restores it.

Every tool also advertises MCP [tool annotations](https://modelcontextprotocol.io/specification/server/tools) so a client can decide what may run without prompting:

| Annotation | Meaning here |
| --- | --- |
| `readOnlyHint: true` | The nine read tools. They never change the network. |
| `destructiveHint: true` | `z2m_remove_device`, `z2m_ota_update`, `z2m_touchlink`, `z2m_restart_bridge`, `z2m_set_bridge_options`, plus `z2m_rename_device`, `z2m_manage_group` and `z2m_bind` |
| `idempotentHint` | True where repeating the call has no additional effect |
| `openWorldHint: true` | Always — every tool reaches a live Zigbee network |

Annotations describe the tool, not the tier: a `safe` tool can still be destructive. The tier decides what is registered, the annotation tells the client what to ask about.

Opt in to the destructive tier only when you want it:

```jsonc
"env": { "Z2M_WRITE_MODE": "full" }
```

## Tools

### Read

| Tool | Purpose |
| --- | --- |
| `z2m_connection_status` | Broker reachability, TLS posture and cached message counts — reports instead of throwing, even when nothing is configured yet |
| `z2m_bridge_info` | Version, coordinator, channel, PAN ID, permit_join, restart_required, runtime stats |
| `z2m_list_devices` | Filter and sort devices by type, availability, link quality, battery, pending update |
| `z2m_get_device` | Exposes, settable options, endpoints, bindings, configured reportings, current state |
| `z2m_health_report` | Whole-estate audit in one call |
| `z2m_network_map` | Mesh topology with parent, depth, link quality, orphan detection |
| `z2m_list_groups` | Groups, members and scenes |
| `z2m_get_logs` | Bridge logs and lifecycle events, buffered or watched live |
| `z2m_coordinator_check` | Routers missing from the coordinator's memory (Texas Instruments adapters only) |

### Safe writes

`z2m_check_updates`, `z2m_permit_join`, `z2m_set_device_options`, `z2m_rename_device`, `z2m_configure_device`, `z2m_interview_device`, `z2m_set_state`, `z2m_manage_group`, `z2m_bind`, `z2m_configure_reporting`

### Full writes

`z2m_remove_device`, `z2m_ota_update`, `z2m_restart_bridge`, `z2m_set_bridge_options`, `z2m_touchlink`

## Data availability caveats

Some fields depend on your Zigbee2MQTT configuration. The server detects what is available and tells you rather than silently returning nothing.

| Field | Requires | If missing |
| --- | --- | --- |
| `last_seen` | `advanced.last_seen` set to e.g. `ISO_8601` (default is `disable`) | Staleness checks are skipped and a hint is returned |
| `availability` | `availability.enabled: true` | Offline detection is skipped and a hint is returned |
| `linkquality`, `battery`, `update` | Live device traffic — Zigbee2MQTT does not retain device state topics | Pass `collect_seconds` to listen briefly, or use `z2m_network_map` for authoritative link quality |
| `z2m_coordinator_check` | A Texas Instruments adapter (CC2652/CC1352) | Returns an error on other adapters; `z2m_bridge_info` reports whether it is supported |

## Security notes

- The broker URL may carry credentials (`mqtt://user:pass@host`). They are redacted everywhere the URL is echoed back to a model or written to a log, and error text from the MQTT client is scrubbed before it leaves the process. Zigbee2MQTT logs its own broker URL at startup, so lines relayed by `z2m_get_logs` are scrubbed too.
- `safe` mode can actuate anything on the mesh via `z2m_set_state`, including locks, valves and sirens. Use `off` if that matters.
- `z2m_permit_join` opens the network to any nearby Zigbee device for the duration of the window. It is in `safe` because it is routine and reversible, but it is a security boundary.

## Example prompts

- "Is my Zigbee network healthy?"
- "Which devices have the weakest signal?"
- "Which batteries need replacing?"
- "Any firmware updates available?"
- "Open the network for pairing via the kitchen router for two minutes."
- "This sensor stopped reporting temperature — fix it."
- "Bind the hallway remote to the hallway light so it works if the bridge is down."

## Development

```bash
npm install
npm run build
npm run watch

# Unit tests. No broker required; they run on every push across Node 22 and 24.
npm test

# Manual smoke test against a real instance
Z2M_MQTT_URL=mqtt://192.168.1.10:1883 node scripts/smoke.mjs
Z2M_MQTT_URL=mqtt://192.168.1.10:1883 node scripts/smoke.mjs z2m_list_devices '{"only_problems":true}'

# Sequential read-after-write test. Renames a device and creates a group, then
# restores both, including on failure. Set Z2M_TEST_DEVICE to pick the device,
# or ROUNDTRIP_GROUPS_ONLY=1 to skip the rename.
Z2M_MQTT_URL=mqtt://192.168.1.10:1883 node scripts/roundtrip.mjs
```

Note that an MCP server may receive requests concurrently. When testing ordering,
await each response before sending the next, as `roundtrip.mjs` does — piping
several requests at once will produce misleading results.

The unit tests cover health classification, capability detection, topic routing,
write-mode gating and configuration parsing. They are broker-free by design, so
anything that needs a live mesh belongs in `scripts/` instead.

A passing suite only proves the tests ran, so `scripts/mutate.mjs` breaks the
source one change at a time and checks the suite notices each one:

```bash
node scripts/mutate.mjs          # every mutant
node scripts/mutate.mjs redact   # only mutants whose name matches
```

A surviving mutant marks behaviour nothing actually tests, and exits non-zero.
Add a mutant alongside any fix worth keeping fixed.

Releases are tag-driven: `npm version <patch|minor|major>` then
`git push --follow-tags`. CI publishes to npm with provenance, rewrites
`server.json`'s version from the tag and publishes to the MCP Registry, then
creates the GitHub release. The `version` committed in `server.json` is therefore
not authoritative — the tag is.

## Safety

This server can remove devices from your network and flash firmware. Both are irreversible and OTA failures can brick hardware. Those tools live in the `full` tier, which is **not** enabled by default — you must opt in with `Z2M_WRITE_MODE=full`. Broker credentials are read from the environment and never logged.

## Status

Early release. Developed and tested against a 50-device EmberZNet estate on Zigbee2MQTT 2.12.x. Other adapters (Texas Instruments, deCONZ/ConBee, zStack), TLS and WebSocket brokers, and large estates are unverified. Bug reports and pull requests are very welcome — please include your adapter type and Zigbee2MQTT version from `z2m_bridge_info`.

## License

MIT
