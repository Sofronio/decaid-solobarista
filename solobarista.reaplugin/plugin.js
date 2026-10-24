function createPlugin(host) {
  const service = "0000fff0-0000-1000-8000-00805f9b34fb";
  const dataCharacteristic = "0000fff1-0000-1000-8000-00805f9b34fb";
  const commandCharacteristic = "0000fff2-0000-1000-8000-00805f9b34fb";
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  const header = 0xaa;
  const weightCommand = 0x41;
  const weightFrameLength = 9;
  const maxFrameLength = 64;
  const maxBufferBytes = 256;
  const graceMilliseconds = 2000;

  function decodeBase64(data) {
    if (typeof data !== "string" || data.length % 4 !== 0) return null;
    const bytes = [];
    for (let i = 0; i < data.length; i += 4) {
      const a = alphabet.indexOf(data[i]);
      const b = alphabet.indexOf(data[i + 1]);
      const c = data[i + 2] === "=" ? 0 : alphabet.indexOf(data[i + 2]);
      const d = data[i + 3] === "=" ? 0 : alphabet.indexOf(data[i + 3]);
      if (a < 0 || b < 0 || c < 0 || d < 0) return null;
      bytes.push((a << 2) | (b >> 4));
      if (data[i + 2] !== "=") bytes.push(((b & 15) << 4) | (c >> 2));
      if (data[i + 3] !== "=") bytes.push(((c & 3) << 6) | d);
    }
    return bytes;
  }

  function buildCommand(command, data = []) {
    // AA | length | command + data | checksum. The length covers command,
    // data and checksum; the checksum is the low byte of their sum.
    const bytes = [header, data.length + 2, command, ...data];
    bytes.push(bytes.slice(2).reduce((sum, byte) => (sum + byte) & 0xff, 0));
    return bytes;
  }

  const commands = {
    tare: buildCommand(0x31),
    timerStart: buildCommand(0x33),
    timerStop: buildCommand(0x34),
    timerReset: buildCommand(0x35),
    unitGram: buildCommand(0x36, [0x00])
  };

  return {
    id: "solobarista.reaplugin",
    onLoad() {
      return host.devices.bindDriver("solobarista", {
        create() {
          let active = null;

          function stop(state) {
            if (!state || state.stopped) return;
            state.stopped = true;
            clearTimeout(state.timer);
          }

          function writeCommand(state, frame) {
            return state.session.gatt.writeWithResponse(
              service,
              commandCharacteristic,
              btoa(String.fromCharCode(...frame))
            );
          }

          function userCommand(frame) {
            const state = active;
            if (!state || state.stopped) {
              return Promise.reject(new Error("Solobarista session is not connected"));
            }
            return writeCommand(state, frame);
          }

          async function handleFrame(state, frame, sample) {
            if (frame[2] !== weightCommand || frame[1] !== weightFrameLength) {
              return false;
            }
            const timerSeconds = (frame[5] * 60) + (frame[4] % 60);
            const magnitude = (frame[8] << 8) | frame[7];
            let weight = magnitude / 10;
            if (frame[6] === 0x01) weight = -weight;
            // The scale can display grams, ounces or millilitres. It is put
            // into gram mode on connect; ounces are converted defensively and
            // millilitres are treated as water grams.
            if (frame[9] === 1) weight *= 28.349523125;

            await state.session.publish(
              {weight, timerMs: timerSeconds * 1000},
              sample
            );
            return true;
          }

          async function drain(state, sample) {
            let published = false;
            while (state.buffer.length >= 2) {
              if (state.buffer[0] !== header) {
                state.buffer.shift();
                continue;
              }
              const length = state.buffer[1];
              if (length < 2 || length > maxFrameLength) {
                state.buffer.shift();
                continue;
              }
              const total = length + 2;
              if (state.buffer.length < total) return published;
              const frame = state.buffer.slice(0, total);
              let checksum = 0;
              for (let i = 2; i < total - 1; i++) {
                checksum = (checksum + frame[i]) & 0xff;
              }
              if (checksum !== frame[total - 1]) {
                state.buffer.shift();
                continue;
              }
              state.buffer.splice(0, total);
              if (await handleFrame(state, frame, sample)) published = true;
            }
            return published;
          }

          function watchPackets(state, fail) {
            clearTimeout(state.timer);
            state.timer = setTimeout(() => {
              stop(state);
              fail(new Error("Solobarista protocol silence"));
              state.session.reportDisconnected().catch(() => {});
            }, graceMilliseconds);
          }

          return {
            async connect(session) {
              const state = {session, stopped: false, timer: null, buffer: []};
              active = state;
              let ready;
              let failed;
              let settled = false;
              const firstWeight = new Promise((resolve, reject) => {
                ready = resolve;
                failed = reject;
              });
              firstWeight.catch(() => {});
              function succeed() {
                if (!settled) {
                  settled = true;
                  ready();
                }
              }
              function fail(error) {
                if (!settled) {
                  settled = true;
                  failed(error);
                }
              }
              async function accept(data, sample) {
                if (state.stopped) return;
                const bytes = decodeBase64(data);
                if (!bytes) return;
                state.buffer.push(...bytes);
                if (state.buffer.length > maxBufferBytes) {
                  state.buffer.splice(0, state.buffer.length - maxBufferBytes);
                }
                let published = false;
                try {
                  published = await drain(state, sample);
                } catch (error) {
                  return;
                }
                if (!published || state.stopped) return;
                watchPackets(state, fail);
                succeed();
              }
              try {
                const services = await session.gatt.discoverServices();
                if (!services.includes(service)) {
                  throw new Error("Solobarista service unavailable");
                }
                session.gatt.onDisconnect(() => {
                  stop(state);
                  fail(new Error("Solobarista disconnected before readiness"));
                });
                await session.gatt.subscribe(service, dataCharacteristic, accept);
                // LSJ-001 does not advertise service UUIDs, so discovery is
                // name-based. FFF0 is only discovered after connecting.
                writeCommand(state, commands.unitGram).catch(() => {});
                if (!state.stopped && state.timer === null) watchPackets(state, fail);
                await firstWeight;
              } catch (error) {
                stop(state);
                fail(error);
                throw error;
              }
            },
            disconnect() {
              stop(active);
            },
            tare() { return userCommand(commands.tare); },
            startTimer() { return userCommand(commands.timerStart); },
            stopTimer() { return userCommand(commands.timerStop); },
            resetTimer() { return userCommand(commands.timerReset); }
          };
        }
      });
    }
  };
}
