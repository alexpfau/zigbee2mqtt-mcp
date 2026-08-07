#!/usr/bin/env node
import { createRequire } from "node:module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Z2MClient } from "./client.js";
import { createLogger, loadConfig, type Config } from "./config.js";
import { selectTools, type ToolContext } from "./tools.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

async function main(): Promise<void> {
  let config: Config;
  let configError: string | undefined;
  try {
    config = loadConfig();
  } catch (error) {
    configError = (error as Error).message;
    config = loadConfig({ requireMqttUrl: false });
  }

  const log = createLogger(config.logLevel);
  if (configError) log.error(configError);
  const client = new Z2MClient(config, log);
  const ctx: ToolContext = { client, config };

  const tools = selectTools(config.writeMode);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  log.info(
    `write mode '${config.writeMode}' exposes ${tools.length} tools against ` +
      `${config.mqttUrl} (base topic '${config.baseTopic}')`,
  );

  const server = new Server(
    { name: "zigbee2mqtt-mcp", version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (configError) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: configError }],
      };
    }

    const tool = byName.get(request.params.name);
    if (!tool) {
      const known = [...byName.keys()].join(", ");
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text:
              `Unknown tool '${request.params.name}'. Available tools: ${known}. ` +
              `Write mode is '${config.writeMode}'; raise Z2M_WRITE_MODE to expose more.`,
          },
        ],
      };
    }

    try {
      const result = await tool.handler(request.params.arguments ?? {}, ctx);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, replacer, 2) }],
      };
    } catch (error) {
      log.error(`${tool.name} failed:`, (error as Error).message);
      return {
        isError: true,
        content: [{ type: "text" as const, text: `${tool.name} failed: ${(error as Error).message}` }],
      };
    }
  });

  const shutdown = async () => {
    await client.disconnect().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // The open MQTT socket keeps the event loop alive, so the process would
  // otherwise outlive the client that spawned it.
  server.onclose = shutdown;

  await server.connect(new StdioServerTransport());
  log.info("ready on stdio");
}

/** Maps are used for the internal caches; render them as plain objects. */
function replacer(_key: string, value: unknown): unknown {
  return value instanceof Map ? Object.fromEntries(value) : value;
}

main().catch((error) => {
  console.error(`[zigbee2mqtt-mcp] fatal: ${(error as Error).message}`);
  process.exit(1);
});
