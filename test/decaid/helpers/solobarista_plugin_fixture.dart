import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:reaprime/src/plugins/plugin_manifest.dart';
import 'package:reaprime/src/plugins/plugin_manager.dart';

import 'plugin_ble_fixture.dart';

const solobaristaPluginPath = '../decaid-solobarista/solobarista.reaplugin';
const solobaristaServiceUuid = '0000fff0-0000-1000-8000-00805f9b34fb';
const solobaristaDataCharacteristicUuid =
    '0000fff1-0000-1000-8000-00805f9b34fb';
const solobaristaCommandCharacteristicUuid =
    '0000fff2-0000-1000-8000-00805f9b34fb';

PluginManifest solobaristaManifest() => PluginManifest.fromJson(
  jsonDecode(
    File('$solobaristaPluginPath/manifest.json').readAsStringSync(),
  ),
);

Future<void> loadSolobaristaPlugin(PluginManager manager) =>
    manager.loadPlugin(
      id: solobaristaManifest().id,
      manifest: solobaristaManifest(),
      settings: {},
      jsCode: File('$solobaristaPluginPath/plugin.js').readAsStringSync(),
    );

/// A 0x41 weight frame. The scale reports seconds before minutes, despite the
/// manufacturer CSV listing minutes first.
List<int> solobaristaPacket(
  double grams, {
  int timerSeconds = 0,
  int unit = 0,
}) {
  final magnitude = (grams.abs() * 10).round();
  final packet = <int>[
    0xaa,
    0x09,
    0x41,
    timerSeconds > 0 ? 0x01 : 0x00,
    timerSeconds & 0xff,
    timerSeconds ~/ 60,
    grams < 0 ? 0x01 : 0x00,
    magnitude & 0xff,
    (magnitude >> 8) & 0xff,
    unit,
  ];
  packet.add(packet.skip(2).fold(0, (sum, byte) => sum + byte) & 0xff);
  return packet;
}

const solobaristaCommands = <List<int>>[
  [0xaa, 0x02, 0x31, 0x31],
  [0xaa, 0x02, 0x33, 0x33],
  [0xaa, 0x02, 0x34, 0x34],
  [0xaa, 0x02, 0x35, 0x35],
];

const solobaristaInitUnit = [0xaa, 0x03, 0x36, 0x00, 0x36];

class SolobaristaPluginTransport extends PluginBleFixtureTransport {
  SolobaristaPluginTransport(super.physicalId);

  final subscribed = Completer<void>();

  @override
  Future<List<String>> discoverServices() async => [solobaristaServiceUuid];

  @override
  Future<void> subscribe(
    String service,
    String characteristic,
    void Function(Uint8List) callback,
  ) async {
    if (service != solobaristaServiceUuid ||
        characteristic != solobaristaDataCharacteristicUuid) {
      throw StateError(
        'Unexpected Solobarista subscription $service/$characteristic',
      );
    }
    subscribers[characteristic] = callback;
    if (!subscribed.isCompleted) subscribed.complete();
  }

  @override
  Future<void> write(
    String serviceUUID,
    String characteristicUUID,
    Uint8List data, {
    bool withResponse = true,
    Duration? timeout,
  }) async {
    if (serviceUUID != solobaristaServiceUuid ||
        characteristicUUID != solobaristaCommandCharacteristicUuid) {
      throw StateError(
        'Unexpected Solobarista write $serviceUUID/$characteristicUUID',
      );
    }
    await super.write(
      serviceUUID,
      characteristicUUID,
      data,
      withResponse: withResponse,
      timeout: timeout,
    );
  }

  void emit(List<int> packet) => subscribers[solobaristaDataCharacteristicUuid]!(
    Uint8List.fromList(packet),
  );
}
