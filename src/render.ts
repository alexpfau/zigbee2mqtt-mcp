import type { Config } from "./config.js";
import { scrubSecrets } from "./redact.js";

/** A large estate can otherwise return more JSON than a model can read. */
export const MAX_RESULT_BYTES = 100_000;

/** Maps are used for the internal caches; render them as plain objects. */
function replacer(_key: string, value: unknown): unknown {
  return value instanceof Map ? Object.fromEntries(value) : value;
}

export function render(result: unknown): string {
  // JSON.stringify(undefined) is undefined, which is not valid tool content.
  const text = JSON.stringify(result, replacer, 2) ?? "null";
  if (text.length <= MAX_RESULT_BYTES) return text;
  return (
    `${text.slice(0, MAX_RESULT_BYTES)}\n\n... truncated at ${MAX_RESULT_BYTES} characters of ` +
    `${text.length}. Narrow the query: pass a limit, a specific device, or fewer fields.`
  );
}

/**
 * Every tool failure reaches the model through here, and mqtt.js quotes back
 * whatever URL it was given, so this is the last place to remove credentials.
 */
export function toolErrorText(toolName: string, error: unknown, config: Pick<Config, "password">): string {
  return `${toolName} failed: ${scrubSecrets((error as Error).message, config)}`;
}
