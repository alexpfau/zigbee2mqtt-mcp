import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redactUrl, scrubSecrets } from "../src/redact.js";

const SECRET = "hunter2secret";

describe("redactUrl", () => {
  it("leaves credential-free URLs untouched", () => {
    assert.equal(redactUrl("mqtt://broker.invalid:1883"), "mqtt://broker.invalid:1883");
  });

  it("redacts an embedded username and password", () => {
    const out = redactUrl(`mqtt://alice:${SECRET}@broker.invalid:1883`);
    assert.ok(!out.includes(SECRET), out);
    assert.ok(!out.includes("alice"), out);
    assert.ok(out.includes("broker.invalid"), "host should stay visible for diagnosis");
  });

  it("handles a password containing an at sign", () => {
    assert.ok(!redactUrl("mqtt://user:p@ssword@host:1883").includes("ssword"));
  });

  it("handles a username with no password", () => {
    assert.ok(!redactUrl("mqtt://alice@broker.invalid").includes("alice"));
  });

  it("keeps an IPv6 literal host readable", () => {
    const out = redactUrl(`mqtt://alice:${SECRET}@[::1]:1883`);
    assert.ok(!out.includes(SECRET), out);
    assert.ok(out.includes("[::1]"), out);
  });

  it("redacts percent-encoded credentials", () => {
    assert.ok(!redactUrl("mqtt://us%40er:p%40ss@host:1883").includes("p%40ss"));
  });

  it("refuses to echo a schemeless value", () => {
    // new URL('user:pass@host') parses 'user:' as the scheme, leaving username
    // and password empty, so this would otherwise pass through verbatim.
    assert.equal(redactUrl(`alice:${SECRET}@broker.invalid:1883`), "<malformed broker URL>");
    assert.equal(redactUrl("broker.invalid:1883"), "<malformed broker URL>");
  });

  it("strips a query string, which ws brokers use to carry tokens", () => {
    assert.ok(!redactUrl("ws://host:9001/mqtt?token=SUPERSECRET").includes("SUPERSECRET"));
    assert.ok(!redactUrl("mqtt://host:1883/?pw=SUPERSECRET").includes("SUPERSECRET"));
  });

  it("strips a fragment", () => {
    assert.ok(!redactUrl("ws://host:9001/mqtt#SUPERSECRET").includes("SUPERSECRET"));
  });

  it("redacts credentials even when the URL will not parse", () => {
    const out = redactUrl(`mqtt://alice:${SECRET}@@broker::invalid`);
    assert.ok(!out.includes(SECRET), out);
    assert.ok(out.startsWith("mqtt://"), "scheme should survive for diagnosis");
  });

  it("accepts every scheme mqtt.js supports", () => {
    for (const scheme of ["mqtt", "mqtts", "tcp", "tls", "ssl", "ws", "wss"]) {
      assert.notEqual(redactUrl(`${scheme}://broker.invalid:1883`), "<malformed broker URL>", scheme);
    }
  });
});

describe("scrubSecrets", () => {
  it("removes userinfo from any URL in the text", () => {
    const out = scrubSecrets(`MQTT connection to mqtt://alice:${SECRET}@host:1 failed`, { password: SECRET });
    assert.ok(!out.includes(SECRET), out);
    assert.ok(out.includes("host:1"), out);
  });

  it("removes userinfo even for a credential it was not given", () => {
    // The configured password is not the only secret that can appear: mqtt.js
    // quotes back whatever URL it was handed.
    const out = scrubSecrets("connection to mqtt://bob:different@host:1 failed", { password: SECRET });
    assert.ok(!out.includes("different"), out);
    assert.ok(!out.includes("bob"), out);
  });

  it("removes a bare password quoted back by the broker", () => {
    const out = scrubSecrets(`Connection refused: bad credentials for ${SECRET}`, { password: SECRET });
    assert.ok(!out.includes(SECRET), out);
  });

  it("leaves innocuous text alone", () => {
    const text = "Timed out after 15000ms waiting for zigbee2mqtt/bridge/response/device/rename";
    assert.equal(scrubSecrets(text, { password: SECRET }), text);
  });

  it("does not mangle a message when the password is short and common", () => {
    // Substring-replacing 'mqtt' would corrupt topics and URLs throughout.
    const text = "MQTT connection to mqtt://host:1883 failed";
    assert.equal(scrubSecrets(text, { password: "mqtt" }), text);
  });

  it("copes with no password configured", () => {
    const text = "something went wrong";
    assert.equal(scrubSecrets(text, { password: undefined }), text);
  });
});
