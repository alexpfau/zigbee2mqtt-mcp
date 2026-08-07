#!/usr/bin/env node
import { createRequire } from "node:module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Z2MClient } from "./client.js";
import { createLogger, loadConfig, type Config } from "./config.js";
import { redactUrl } from "./redact.js";
import { render, toolErrorText } from "./render.js";
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
  const ctx: ToolContext = { client, config, configError };

  const tools = selectTools(config.writeMode);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  log.info(
    `write mode '${config.writeMode}' exposes ${tools.length} tools against ` +
      `${redactUrl(config.mqttUrl)} (base topic '${config.baseTopic}')`,
  );

  const server = new Server(
    { name: "zigbee2mqtt-mcp", version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, description, inputSchema, annotations }) => ({
      name,
      description,
      inputSchema,
      annotations,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byName.get(request.params.name);

    // The connection diagnostic has to survive a missing URL: that is the most
    // common misconfiguration, and it is the tool a user reaches for.
    if (configError && !tool?.runsUnconfigured) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: configError }],
      };
    }

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
        content: [{ type: "text" as const, text: render(result) }],
      };
    } catch (error) {
      const text = toolErrorText(tool.name, error, config);
      log.error(text);
      return { isError: true, content: [{ type: "text" as const, text }] };
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

// A throw inside an event listener would otherwise kill the session with no
// diagnostic on stderr, which is indistinguishable from a clean exit.
process.on("unhandledRejection", (reason) => {
  console.error(`[zigbee2mqtt-mcp] unhandled rejection: ${String(reason)}`);
});
process.on("uncaughtException", (error) => {
  console.error(`[zigbee2mqtt-mcp] uncaught exception: ${error.message}`);
  process.exit(1);
});

main().catch((error) => {
  console.error(`[zigbee2mqtt-mcp] fatal: ${(error as Error).message}`);
  process.exit(1);
});
