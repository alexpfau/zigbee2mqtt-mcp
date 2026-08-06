# zigbee2mqtt-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for **administering** a Zigbee2MQTT estate.

Most Zigbee integrations already let an assistant turn a light on. This one is for the layer underneath: mesh health, weak links, devices that keep rejoining, stale batteries, firmware updates, pairing, binding, reporting intervals and device options — the things you normally open the Zigbee2MQTT frontend for.

It talks directly to the Zigbee2MQTT [MQTT bridge API](https://www.zigbee2mqtt.io/guide/usage/mqtt_topics_and_messages.html), so it works with any Zigbee2MQTT 1.17+ installation regardless of whether you use Home Assistant, Node-RED, openHAB or nothing at all.

## Why this exists

If you already run Home Assistant, your Zigbee devices are exposed there and an assistant can control them. What Home Assistant does *not* expose is the bridge itself: link quality, mesh topology, interview state, OTA availability, `permit_join`, device options, bindings and reporting configuration. This server fills exactly that gap.

## Design

- **No database.** Zigbee2MQTT publishes its bridge topics as retained messages, so a fresh subscription yields a complete picture in a few hundred milliseconds. The server keeps only the latest payload per topic in memory.
- **No daemon.** Pure stdio. It starts and dies with the MCP session.
- **Correlated requests.** Every `bridge/request/*` carries a `transaction` id and is matched to its `bridge/response/*`, so concurrent calls cannot cross wires.
- **Tiered writes.** Destructive operations are gated behind a write mode *and* an explicit `confirm` argument.

## Install

Requires Node.js 20 or newer and network access to the MQTT broker that Zigbee2MQTT uses.

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
| `Z2M_WRITE_MODE` | `full` | `off`, `safe` or `full` |
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
| `safe` | Read plus non-destructive writes: pairing, options, rename, configure, interview, binding, reporting, groups, state |
| `full` | Everything, including device removal, OTA flashing, Touchlink and bridge restart |

Irreversible tools (`z2m_remove_device`, `z2m_ota_update`, `z2m_touchlink`, `z2m_restart_bridge`, `z2m_set_bridge_options`) additionally require `confirm: true` on every call.

## Tools

### Read

| Tool | Purpose |
| --- | --- |
| `z2m_bridge_info` | Version, coordinator, channel, PAN ID, permit_join, restart_required, runtime stats |
| `z2m_list_devices` | Filter and sort devices by type, availability, link quality, battery, pending update |
| `z2m_get_device` | Exposes, settable options, endpoints, bindings, configured reportings, current state |
| `z2m_health_report` | Whole-estate audit in one call |
| `z2m_network_map` | Mesh topology with parent, depth, link quality, orphan detection |
| `z2m_list_groups` | Groups, members and scenes |
| `z2m_get_logs` | Bridge logs and lifecycle events, buffered or watched live |

### Safe writes

`z2m_check_updates`, `z2m_permit_join`, `z2m_set_device_options`, `z2m_rename_device`, `z2m_configure_device`, `z2m_interview_device`, `z2m_set_state`, `z2m_manage_group`, `z2m_bind`, `z2m_configure_reporting`

### Full writes

`z2m_remove_device`, `z2m_ota_update`, `z2m_restart_bridge`, `z2m_set_bridge_options`, `z2m_coordinator_check`, `z2m_touchlink`

## Data availability caveats

Some fields depend on your Zigbee2MQTT configuration. The server detects what is available and tells you rather than silently returning nothing.

| Field | Requires | If missing |
| --- | --- | --- |
| `last_seen` | `advanced.last_seen` set to e.g. `ISO_8601` (default is `disable`) | Staleness checks are skipped and a hint is returned |
| `availability` | `availability.enabled: true` | Offline detection is skipped and a hint is returned |
| `linkquality`, `battery`, `update` | Live device traffic — Zigbee2MQTT does not retain device state topics | Pass `collect_seconds` to listen briefly, or use `z2m_network_map` for authoritative link quality |
| `z2m_coordinator_check` | A Texas Instruments adapter (CC2652/CC1352) | Returns an error on other adapters; `z2m_bridge_info` reports whether it is supported |

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

# Manual smoke test against a real instance
Z2M_MQTT_URL=mqtt://192.168.1.10:1883 node scripts/smoke.mjs
Z2M_MQTT_URL=mqtt://192.168.1.10:1883 node scripts/smoke.mjs z2m_list_devices '{"only_problems":true}'
```

## Safety

This server can remove devices from your network and flash firmware. Both are irreversible and OTA failures can brick hardware. Run with `Z2M_WRITE_MODE=safe` or `off` if you do not want an assistant able to do that. Broker credentials are read from the environment and never logged.

## License

MIT
