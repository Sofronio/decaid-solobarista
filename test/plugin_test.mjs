import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pluginSource = readFileSync(
  join(root, "solobarista.reaplugin/plugin.js"),
  "utf8"
);
const manifest = JSON.parse(
  readFileSync(join(root, "solobarista.reaplugin/manifest.json"), "utf8")
);

const SERVICE = "0000fff0-0000-1000-8000-00805f9b34fb";
const DATA_CHARACTERISTIC = "0000fff1-0000-1000-8000-00805f9b34fb";
const COMMAND_CHARACTERISTIC = "0000fff2-0000-1000-8000-00805f9b34fb";

const commands = {
  tare: [0xaa, 0x02, 0x31, 0x31],
  startTimer: [0xaa, 0x02, 0x33, 0x33],
  stopTimer: [0xaa, 0x02, 0x34, 0x34],
  resetTimer: [0xaa, 0x02, 0x35, 0x35],
  unitGram: [0xaa, 0x03, 0x36, 0x00, 0x36]
};

function loadPlugin() {
  const context = vm.createContext({ btoa, setTimeout, clearTimeout, console });
  vm.runInContext(pluginSource, context, { filename: "plugin.js" });
  assert.equal(typeof context.createPlugin, "function");
  return context.createPlugin;
}

class FakeSession {
  constructor() {
    this.subscribers = new Map();
    this.writes = [];
    this.published = [];
    this.disconnectHandlers = [];
    this.reportDisconnectedCalls = 0;
    this.subscribed = new Promise((resolve) => {
      this.markSubscribed = resolve;
    });
    this.gatt = {
      discoverServices: async () => [SERVICE],
      onDisconnect: (callback) => this.disconnectHandlers.push(callback),
      subscribe: async (service, characteristic, callback) => {
        assert.equal(service, SERVICE);
        assert.equal(characteristic, DATA_CHARACTERISTIC);
        this.subscribers.set(characteristic, callback);
        this.markSubscribed();
      },
      writeWithResponse: async (service, characteristic, data) => {
        assert.equal(service, SERVICE);
        assert.equal(characteristic, COMMAND_CHARACTERISTIC);
        this.writes.push([...Buffer.from(data, "base64")]);
      },
      writeWithoutResponse: async () => {
        throw new Error("Solobarista commands must use writeWithResponse");
      }
    };
  }

  async emit(frame, sample = "sample") {
    await this.subscribed;
    const callback = this.subscribers.get(DATA_CHARACTERISTIC);
    assert.ok(callback, "the driver has not subscribed to FFF1");
    await callback(Buffer.from(frame).toString("base64"), sample);
  }

  publish(snapshot, sample) {
    this.published.push({ snapshot, sample });
    return Promise.resolve();
  }

  reportDisconnected() {
    this.reportDisconnectedCalls++;
    return Promise.resolve();
  }
}

function setup() {
  let binding = null;
  const host = {
    devices: {
      bindDriver(id, driver) {
        binding = { id, driver };
        return Promise.resolve();
      }
    }
  };
  const plugin = loadPlugin()(host);
  assert.equal(plugin.id, "solobarista.reaplugin");
  plugin.onLoad();
  assert.equal(binding.id, "solobarista");
  return { driver: binding.driver.create(), session: new FakeSession() };
}

function packet({
  weight = 0,
  timerSeconds = 0,
  unit = 0,
  negative = false,
  command = 0x41
} = {}) {
  const magnitude = Math.round(Math.abs(weight) * 10);
  const frame = [
    0xaa,
    0x09,
    command,
    timerSeconds > 0 ? 0x01 : 0x00,
    timerSeconds & 0xff,
    Math.floor(timerSeconds / 60) & 0xff,
    negative ? 0x01 : 0x00,
    magnitude & 0xff,
    (magnitude >> 8) & 0xff,
    unit
  ];
  frame.push(frame.slice(2).reduce((sum, byte) => (sum + byte) & 0xff, 0));
  return frame;
}

function snapshots(session) {
  return session.published.map((entry) =>
    JSON.parse(JSON.stringify(entry.snapshot))
  );
}

test("manifest declares the Solobarista driver and name-only match", () => {
  assert.equal(manifest.id, "solobarista.reaplugin");
  const driver = manifest.drivers[0];
  assert.equal(driver.id, "solobarista");
  assert.equal(driver.type, "scale");
  assert.deepEqual(
    new Set(driver.capabilities),
    new Set(["tare", "timerControl", "timerTelemetry", "disconnectToSleep"])
  );
  assert.deepEqual(driver.ble.match, { name: { contains: "lsj-001" } });
});

test("publishes weight, sign and scale-side timer", async () => {
  const { driver, session } = setup();
  const connecting = driver.connect(session);
  await session.emit(packet({ weight: 12.3 }));
  await connecting;

  assert.deepEqual(snapshots(session), [{ weight: 12.3, timerMs: 0 }]);

  await session.emit(packet({ weight: 5, timerSeconds: 65, negative: true }));
  assert.deepEqual(snapshots(session).at(-1), { weight: -5, timerMs: 65000 });

  driver.disconnect();
});

test("parses cumulative seconds and long timers", async () => {
  const { driver, session } = setup();
  const connecting = driver.connect(session);
  await session.emit(packet({ weight: 0, timerSeconds: 223 }));
  await connecting;
  // byte[4] is the seconds component and byte[5] the minute count, so
  // 3:43 is encoded with seconds=223 and minutes=3.
  assert.equal(snapshots(session).at(-1).timerMs, 223000);
  driver.disconnect();
});

test("converts ounces to grams and keeps millilitres as grams", async () => {
  const { driver, session } = setup();
  const connecting = driver.connect(session);
  await session.emit(packet({ weight: 1, unit: 1 }));
  await connecting;
  const ounces = snapshots(session).at(-1).weight;
  assert.ok(Math.abs(ounces - 28.349523125) < 1e-9);

  await session.emit(packet({ weight: 1, unit: 2 }));
  assert.ok(Math.abs(snapshots(session).at(-1).weight - 1) < 1e-9);
  driver.disconnect();
});

test("initializes the scale to grams and sends the official commands", async () => {
  const { driver, session } = setup();
  const connecting = driver.connect(session);
  await session.emit(packet({ weight: 1 }));
  await connecting;

  assert.deepEqual(session.writes, [commands.unitGram]);
  session.writes.length = 0;

  await driver.tare();
  await driver.startTimer();
  await driver.stopTimer();
  await driver.resetTimer();

  assert.deepEqual(session.writes, [
    commands.tare,
    commands.startTimer,
    commands.stopTimer,
    commands.resetTimer
  ]);
  driver.disconnect();
});

test("buffers fragmented frames and resynchronizes on bad checksums", async () => {
  const { driver, session } = setup();
  const connecting = driver.connect(session);
  const frame = packet({ weight: 8.4, timerSeconds: 2 });
  await session.emit(frame.slice(0, 5));
  assert.equal(session.published.length, 0);
  await session.emit(frame.slice(5));
  await connecting;
  assert.deepEqual(snapshots(session), [{ weight: 8.4, timerMs: 2000 }]);

  const corrupted = packet({ weight: 99 });
  corrupted[corrupted.length - 1] ^= 0xff;
  await session.emit(corrupted);
  assert.equal(session.published.length, 1);
  await session.emit(packet({ weight: 3.2 }));
  assert.deepEqual(snapshots(session).at(-1), { weight: 3.2, timerMs: 0 });
  driver.disconnect();
});

test("parses coalesced frames and ignores non-weight commands", async () => {
  const { driver, session } = setup();
  const connecting = driver.connect(session);
  const first = packet({ weight: 1.1 });
  const second = packet({ weight: 2.2, timerSeconds: 3 });
  await session.emit([...first, ...second]);
  await connecting;
  assert.deepEqual(snapshots(session), [
    { weight: 1.1, timerMs: 0 },
    { weight: 2.2, timerMs: 3000 }
  ]);

  await session.emit(packet({ weight: 9, command: 0x42 }));
  assert.equal(session.published.length, 2);
  driver.disconnect();
});

test("a disconnected session publishes nothing further", async () => {
  const { driver, session } = setup();
  const connecting = driver.connect(session);
  await session.emit(packet({ weight: 1 }));
  await connecting;
  driver.disconnect();
  await session.emit(packet({ weight: 2 }));
  assert.equal(session.published.length, 1);
});
