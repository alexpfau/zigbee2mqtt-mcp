import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { MISSING_MQTT_URL, createLogger, loadConfig } from "../src/config.js";
import { withEnv } from "./helpers.js";

const URL_ONLY = { Z2M_MQTT_URL: "mqtt://broker.invalid:1883" };

describe("loadConfig", () => {
  it("refuses to start configured without a broker URL", () => {
    withEnv({}, () => {
      assert.throws(() => loadConfig(), new RegExp(MISSING_MQTT_URL.slice(0, 30)));
    });
  });

  it("names both the variable and the common frontend-port mistake", () => {
    assert.match(MISSING_MQTT_URL, /Z2M_MQTT_URL is not set/);
    assert.match(MISSING_MQTT_URL, /not the Zigbee2MQTT frontend port/);
  });

  it("starts unconfigured with a placeholder so tools can still be listed", () => {
    withEnv({}, () => {
      const config = loadConfig({ requireMqttUrl: false });
      assert.match(config.mqttUrl, /unconfigured\.invalid/);
    });
  });

  it("defaults to the safe write mode rather than full", () => {
    withEnv(URL_ONLY, () => assert.equal(loadConfig().writeMode, "safe"));
  });

  it("defaults to quiet logging and verifying TLS", () => {
    withEnv(URL_ONLY, () => {
      const config = loadConfig();
      assert.equal(config.logLevel, "error");
      assert.equal(config.rejectUnauthorized, true);
    });
  });

  it("applies the documented threshold defaults", () => {
    withEnv(URL_ONLY, () => {
      const config = loadConfig();
      assert.equal(config.weakLinkThreshold, 30);
      assert.equal(config.lowBatteryThreshold, 20);
      assert.equal(config.staleHours, 24);
      assert.equal(config.baseTopic, "zigbee2mqtt");
    });
  });

  it("strips trailing slashes from the base topic", () => {
    withEnv({ ...URL_ONLY, Z2M_BASE_TOPIC: "z2m///" }, () => assert.equal(loadConfig().baseTopic, "z2m"));
  });

  it("treats an empty variable as unset", () => {
    withEnv({ ...URL_ONLY, Z2M_BASE_TOPIC: "", Z2M_STALE_HOURS: "" }, () => {
      const config = loadConfig();
      assert.equal(config.baseTopic, "zigbee2mqtt");
      assert.equal(config.staleHours, 24);
    });
  });

  it("does not turn empty credentials into empty strings", () => {
    withEnv({ ...URL_ONLY, Z2M_MQTT_USERNAME: "", Z2M_MQTT_PASSWORD: "" }, () => {
      const config = loadConfig();
      assert.equal(config.username, undefined);
      assert.equal(config.password, undefined);
    });
  });

  it("accepts the documented write modes case-insensitively", () => {
    for (const mode of ["off", "safe", "full", "FULL"]) {
      withEnv({ ...URL_ONLY, Z2M_WRITE_MODE: mode }, () =>
        assert.equal(loadConfig().writeMode, mode.toLowerCase()),
      );
    }
  });

  it("rejects an unknown write mode instead of silently downgrading", () => {
    withEnv({ ...URL_ONLY, Z2M_WRITE_MODE: "readonly" }, () => {
      assert.throws(() => loadConfig(), /must be one of off, safe, full/);
    });
  });

  it("rejects a non-numeric threshold instead of coercing it to NaN", () => {
    withEnv({ ...URL_ONLY, Z2M_STALE_HOURS: "soon" }, () => {
      assert.throws(() => loadConfig(), /must be an integer/);
    });
  });

  it("parses the documented falsey spellings for booleans", () => {
    for (const value of ["0", "false", "no", "off", "OFF"]) {
      withEnv({ ...URL_ONLY, Z2M_MQTT_REJECT_UNAUTHORIZED: value }, () =>
        assert.equal(loadConfig().rejectUnauthorized, false, value),
      );
    }
    for (const value of ["1", "true", "yes"]) {
      withEnv({ ...URL_ONLY, Z2M_MQTT_REJECT_UNAUTHORIZED: value }, () =>
        assert.equal(loadConfig().rejectUnauthorized, true, value),
      );
    }
  });

  it("explains which certificate file it could not read", () => {
    withEnv({ ...URL_ONLY, Z2M_MQTT_CA: "/nonexistent/ca.pem" }, () => {
      assert.throws(() => loadConfig(), /Z2M_MQTT_CA: cannot read \/nonexistent\/ca\.pem/);
    });
  });

  it("derives a unique client id but honours an explicit one", () => {
    withEnv(URL_ONLY, () => assert.match(loadConfig().clientId, /^zigbee2mqtt-mcp-\d+$/));
    withEnv({ ...URL_ONLY, Z2M_MQTT_CLIENT_ID: "fixed" }, () => assert.equal(loadConfig().clientId, "fixed"));
  });
});

describe("createLogger", () => {
  it("writes diagnostics to stderr, never stdout", () => {
    // The stdio transport owns stdout; anything written there corrupts the protocol.
    const stdout = mock.method(process.stdout, "write", () => true);
    const stderr = mock.method(process.stderr, "write", () => true);
    try {
      createLogger("debug").info("hello");
    } finally {
      stdout.mock.restore();
      stderr.mock.restore();
    }
    assert.equal(stdout.mock.callCount(), 0, "logger wrote to stdout");
    assert.ok(stderr.mock.callCount() > 0, "logger wrote nothing to stderr");
  });

  it("suppresses everything at the silent level", () => {
    const stderr = mock.method(process.stderr, "write", () => true);
    try {
      const log = createLogger("silent");
      log.error("e");
      log.warn("w");
      log.info("i");
      log.debug("d");
    } finally {
      stderr.mock.restore();
    }
    assert.equal(stderr.mock.callCount(), 0);
  });

  it("emits at and above the configured level only", () => {
    const stderr = mock.method(process.stderr, "write", () => true);
    try {
      const log = createLogger("warn");
      log.error("e");
      log.warn("w");
      log.info("i");
      log.debug("d");
    } finally {
      stderr.mock.restore();
    }
    assert.equal(stderr.mock.callCount(), 2);
  });

  it("tags output so it is attributable in a shared log", () => {
    const lines: string[] = [];
    const stderr = mock.method(process.stderr, "write", (chunk: string) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      createLogger("error").error("boom");
    } finally {
      stderr.mock.restore();
    }
    assert.match(lines.join(""), /\[zigbee2mqtt-mcp\] \[error\] boom/);
  });
});
