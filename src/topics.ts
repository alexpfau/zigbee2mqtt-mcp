/**
 * Topic routing for the Zigbee2MQTT base topic tree.
 *
 * Kept separate from the MQTT client so the rules can be exercised without a
 * broker. The subtle cases are friendly names containing '/' and the fact that
 * a device's command topics look almost exactly like its state topic.
 */
export type TopicRoute =
  /** Outside our base topic; not ours to interpret. */
  | { kind: "foreign" }
  | { kind: "response"; subTopic: string }
  | { kind: "logging" }
  | { kind: "event" }
  | { kind: "bridge"; name: string }
  | { kind: "availability"; device: string }
  /** A `set`/`get` command we or another client published, not device state. */
  | { kind: "command" }
  | { kind: "state"; device: string };

const AVAILABILITY_SUFFIX = "/availability";
const RESPONSE_PREFIX = "bridge/response/";
const COMMAND = /\/(set|get)(\/|$)/;

export function classifyTopic(baseTopic: string, topic: string): TopicRoute {
  const prefix = `${baseTopic}/`;
  if (!topic.startsWith(prefix)) return { kind: "foreign" };
  const rest = topic.slice(prefix.length);

  if (rest.startsWith(RESPONSE_PREFIX)) {
    return { kind: "response", subTopic: rest.slice(RESPONSE_PREFIX.length) };
  }
  if (rest === "bridge/logging") return { kind: "logging" };
  if (rest === "bridge/event") return { kind: "event" };
  if (rest.startsWith("bridge/")) return { kind: "bridge", name: rest.slice("bridge/".length) };

  // Friendly names may contain '/', so match on the suffix rather than splitting.
  if (rest.endsWith(AVAILABILITY_SUFFIX)) {
    return { kind: "availability", device: rest.slice(0, -AVAILABILITY_SUFFIX.length) };
  }
  if (COMMAND.test(rest)) return { kind: "command" };

  return { kind: "state", device: rest };
}
