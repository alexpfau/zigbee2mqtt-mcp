import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_RESULT_BYTES, render, toolErrorText } from "../src/render.js";

describe("render", () => {
  it("pretty-prints a result", () => {
    assert.equal(render({ a: 1 }), '{\n  "a": 1\n}');
  });

  it("renders internal Maps as plain objects", () => {
    assert.equal(render({ m: new Map([["k", "v"]]) }), '{\n  "m": {\n    "k": "v"\n  }\n}');
  });

  it("never returns undefined text", () => {
    // JSON.stringify(undefined) is undefined, which is not valid tool content.
    assert.equal(render(undefined), "null");
  });

  it("truncates an oversized payload and says how to narrow it", () => {
    const huge = render({ devices: Array.from({ length: 20_000 }, (_, i) => ({ name: `device-${i}` })) });
    assert.ok(huge.length < MAX_RESULT_BYTES + 300, "truncation did not bound the payload");
    assert.match(huge, /truncated at 100000 characters/);
    assert.match(huge, /Narrow the query/);
  });

  it("leaves a payload under the limit untouched", () => {
    const out = render({ devices: [{ name: "lamp" }] });
    assert.doesNotMatch(out, /truncated/);
  });
});

describe("toolErrorText", () => {
  const SECRET = "hunter2secret";

  it("names the tool that failed", () => {
    const out = toolErrorText("z2m_bridge_info", new Error("boom"), { password: undefined });
    assert.equal(out, "z2m_bridge_info failed: boom");
  });

  it("scrubs a credential quoted back by the MQTT client", () => {
    // Every tool failure reaches the model through here.
    const error = new Error(`MQTT connection to mqtt://alice:${SECRET}@host:1883 failed`);
    const out = toolErrorText("z2m_list_devices", error, { password: SECRET });
    assert.ok(!out.includes(SECRET), out);
    assert.ok(out.includes("host:1883"), "host should stay visible for diagnosis");
  });

  it("scrubs userinfo even for a credential it was not given", () => {
    const error = new Error("connection to mqtt://bob:different@host:1883 failed");
    const out = toolErrorText("z2m_list_devices", error, { password: SECRET });
    assert.ok(!out.includes("different"), out);
  });
});
