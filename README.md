# Solobarista Scale for Decaid

A Decaid plugin for the SOLO Barista **LSJ-001** BLE scale. It publishes the
scale's weight and its own timer to Decaid, and sends tare and timer commands
over the command characteristic.

## Install

Once this repository is published as a release, install it through Decaid's
plugin API:

```bash
curl -X POST http://localhost:8080/api/v1/plugins/install/github-release \
  -H 'content-type: application/json' \
  -d '{"repo": "Sofronio/decaid-solobarista"}'
```

Then enable the plugin in Decaid. The device ID is
`plugin:solobarista.reaplugin:solobarista:<physical id>`.

## Matching

The LSJ-001 advertises **only its name** (`LSJ-001`) and no service UUIDs. The
driver therefore matches advertisements with `name.contains("lsj-001")` only.
Do not add FFF0 to the advertisement match: Decaid will never see it there.
FFF0 is discovered after connecting.

When enabled, the plugin claims the scale on subsequent discovery and overrides
Decaid's native LSJ-001 handling. Disabling it restores native discovery.

## GATT

| Item | UUID | Properties |
| --- | --- | --- |
| Service | `0000fff0-0000-1000-8000-00805f9b34fb` | vendor specific |
| Data | `0000fff1-0000-1000-8000-00805f9b34fb` | notify |
| Commands | `0000fff2-0000-1000-8000-00805f9b34fb` | write, write-without-response |

The plugin subscribes to FFF1 and writes commands to FFF2 with response, as the
scale's reference client does. A 2-second silence watchdog guards readiness and
the live session.

## Frames

```
AA | length | command + data | checksum
```

- `length` is the number of bytes in `command + data + checksum`.
- `checksum` is the low byte of the sum of `command + data`.

### Uplink: command `0x41` (11 bytes)

```
AA 09 41 [running] [seconds] [minutes] [sign] [weight lo] [weight hi] [unit] [sum]
```

| Byte | Meaning |
| --- | --- |
| 3 | timer running: `0` stopped, `1` running |
| 4 | seconds component (can exceed 59 on the wire) |
| 5 | minutes |
| 6 | sign: `00` positive, `01` negative |
| 7-8 | weight magnitude, little-endian |
| 9 | unit: `00` g, `01` oz, `02` ml |
| 10 | checksum |

The device sends seconds before minutes, despite the manufacturer CSV listing
minutes first. The plugin computes:

```
timerMs = (minutes * 60 + seconds % 60) * 1000
weight  = (weightHi << 8 | weightLo) / 10
```

On connect the plugin writes unit = gram. If a frame reports ounces, the value
is converted to grams; millilitres are treated as water grams for Decaid's
weight field.

### Commands

| Operation | Frame |
| --- | --- |
| Tare | `AA 02 31 31` |
| Timer start | `AA 02 33 33` |
| Timer stop | `AA 02 34 34` |
| Timer reset | `AA 02 35 35` |
| Set unit to gram | `AA 03 36 00 36` |

The reference protocol also defines power off, unit selection, and sound
commands. They are not exposed by this driver; display sleep uses Decaid's
`disconnectToSleep` path instead of powering the scale off.

## Capabilities

- `tare`
- `timerControl`
- `timerTelemetry`
- `disconnectToSleep`

Battery and flow are not present in the LSJ-001 uplink frame, so the driver does
not declare those capabilities.

## Testing

Node protocol tests do not need a Decaid checkout:

```bash
node --test test/plugin_test.mjs
```

The Decaid integration suite uses Decaid's plugin loader, JavaScript runtime,
`PluginManager`, `ScaleController` and BLE fixture. Keep this repository as a
sibling of the Decaid checkout, copy the two test files in, and run:

```bash
cp test/decaid/helpers/solobarista_plugin_fixture.dart <decaid>/test/helpers/
cp test/decaid/plugins/solobarista_plugin_test.dart    <decaid>/test/plugins/
cd <decaid> && flutter test test/plugins/solobarista_plugin_test.dart
```

## Verification

### Automated tests

- `node --test test/plugin_test.mjs`: 8/8 passing.
- Decaid integration tests: 5/5 passing (name-only advertisement match,
  connect, weight/timer, commands, bad checksum, display-sleep disconnect).

### Hardware protocol probe (2026-10-24)

Physical LSJ-001, standalone bleak probe on macOS:

- Scan: `LSJ-001`, advertised services `[]` (name-only match confirmed).
- GATT: FFF0; FFF1 notify; FFF2 write / write-without-response.
- Initial unit was `02` (ml). After `AA 03 36 00 36`, frames reported unit
  `00` (g).
- Tare `AA 02 31 31` and timer reset `AA 02 35 35` completed.
- Start `AA 02 33 33`: `running=1`; timer advanced 00:00 → 00:02.
- Stop `AA 02 34 34`: `running=0`; timer froze at 00:02 across repeated reads.
- Reset: timer returned to 00:00.
- The scale was empty (0.0 g); this probe focused on unit, command and timer
  behavior.

### Decaid end-to-end (2026-10-24)

Samsung SM-X210 (Galaxy Tab A9+), Android 16, Decaid 0.9.0:

- Plugin v0.1.0 installed, enabled, and loaded.
- Device discovered as
  `plugin:solobarista.reaplugin:solobarista:bc:a6:30:23:13:8e` and connected as
  the primary scale.
- Live weight: **97.6 g** (97.5–97.6 g variation), battery `null` (the frame
  has no battery field), timer 0.
- Timer through Decaid: start → 2000 ms after 2 s; stop → frozen at 6000 ms;
  reset → 0 ms.
- Tare was intentionally not sent, so the 97.6 g load remained on the scale.

## Releasing

`scripts/package.sh` builds `dist/solobarista.reaplugin-<version>.zip`. Pushing a
`vX.Y.Z` tag runs the same script in CI and publishes the release. The tag must
equal `manifest.version`; the archive contains one top-level
`solobarista.reaplugin/` directory with `manifest.json` and `plugin.js`.

## License

[MIT](LICENSE). Copyright (c) 2026 Sofronio.
