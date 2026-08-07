# Security Policy

## Reporting a vulnerability

Please report security issues privately through GitHub's
[private vulnerability reporting](https://github.com/alexpfau/zigbee2mqtt-mcp/security/advisories/new)
rather than opening a public issue.

I maintain this in my own time, so I cannot promise a fixed response window, but
I will acknowledge a report as soon as I see it and keep you updated. Please
include the version, your `Z2M_WRITE_MODE`, and enough detail to reproduce.

## Supported versions

Fixes land on the latest released version only. This is a pre-1.0 project, so
please upgrade before reporting.

| Version | Supported |
| --- | --- |
| 0.6.x | yes |
| < 0.6 | no |

## What this server can do

Worth understanding before deciding what counts as a vulnerability. The server
holds MQTT broker credentials and, depending on `Z2M_WRITE_MODE`, exposes tools
that can rename and reconfigure devices, remove them from the network, flash
firmware, open the network for pairing, restart the bridge and actuate anything
on the mesh, including locks and valves.

It runs as a stdio subprocess of whichever MCP client starts it. It opens no
listening port, stores nothing on disk, and keeps only the latest retained
message per topic in memory.

## Threat model

In scope, and treated as vulnerabilities:

- MQTT credentials reaching the model, the transcript, logs, or any tool output.
  The broker URL may contain them (`mqtt://user:pass@host`), as may error text
  from the MQTT client and log lines relayed from Zigbee2MQTT itself.
- A tool causing an irreversible or destructive change without the confirmation
  its schema and annotations advertise.
- A tool above the configured `Z2M_WRITE_MODE` tier being reachable.
- An MCP annotation that misrepresents what a tool does. Clients use
  `readOnlyHint` and `destructiveHint` to decide what may run without asking the
  user, so an inaccurate one is a safety bug, not a documentation bug.
- Supply-chain problems in what is published: the npm tarball, the container
  image, or the release workflow.

Out of scope:

- An unauthenticated or unencrypted MQTT broker. Securing the broker is the
  operator's responsibility; use `mqtts://` and credentials.
- A model choosing to call a destructive tool that you enabled. Set
  `Z2M_WRITE_MODE=off` or `safe` if that matters, and note that `safe` still
  actuates devices.
- Vulnerabilities in Zigbee2MQTT itself. Report those to
  [Koenkk/zigbee2mqtt](https://github.com/Koenkk/zigbee2mqtt/security).

## Hardening notes

- `Z2M_WRITE_MODE` defaults to `safe`. Tools above the active tier are never
  registered, so a model cannot reach for them.
- Prefer `mqtts://` and a broker account scoped to the Zigbee2MQTT base topic
  rather than a full-access one.
- Credentials belong in your MCP client's secret handling, not in a committed
  config file.
