import type { Config } from "./config.js";

/** Schemes mqtt.js accepts. Anything else is not a broker URL we should echo. */
const BROKER_SCHEME = /^(mqtt|mqtts|tcp|tls|ssl|ws|wss):\/\//i;

/** Any URL userinfo, whatever the scheme. */
const USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi;

/**
 * Broker URLs may carry credentials as `mqtt://user:pass@host`, and ws/wss
 * brokers accept tokens in the query string. Anything echoed back to a model
 * or written to a log must go through here first.
 */
export function redactUrl(url: string): string {
  // A schemeless value still parses: new URL('user:pass@host') reads 'user:' as
  // the scheme, leaving username and password empty, so it would pass through
  // untouched. Refuse to echo anything that is not recognisably a broker URL.
  if (!BROKER_SCHEME.test(url)) return "<malformed broker URL>";
  try {
    const parsed = new URL(url);
    if (parsed.username) parsed.username = "***";
    if (parsed.password) parsed.password = "***";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    // The scheme is known-good here, so this keeps the transport diagnosable.
    return `${url.slice(0, url.indexOf("://") + 3)}***`;
  }
}

/**
 * Last line of defence for text that leaves the process: errors bubbling up
 * from mqtt.js quote whatever URL they were given.
 */
export function scrubSecrets(text: string, config: Pick<Config, "password">): string {
  let out = text.replace(USERINFO, "$1***@");
  const password = config.password;
  // A short password would match innocuous substrings and mangle the message;
  // userinfo in a URL is already covered above.
  if (password && password.length >= 6) out = out.split(password).join("***");
  return out;
}
