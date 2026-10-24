import 'package:flutter_test/flutter_test.dart';
import 'package:reaprime/src/controllers/scale_controller.dart';
import 'package:reaprime/src/models/device/device.dart';
import 'package:reaprime/src/models/device/scale.dart';
import 'package:reaprime/src/plugins/plugin_ble_registry.dart';
import 'package:reaprime/src/plugins/plugin_manifest.dart';
import 'package:reaprime/src/plugins/plugin_manager.dart';

import '../helpers/solobarista_plugin_fixture.dart';
import 'plugin_test_helpers.dart';

BleAdvertisementEvidence solobaristaEvidence() => BleAdvertisementEvidence(
  name: 'LSJ-001',
  serviceUuids: const [],
);

Future<Scale> createScale(
  PluginManager manager,
  SolobaristaPluginTransport transport,
  BleAdvertisementEvidence evidence,
) async {
  return await manager.bleService.createCandidate(
        driver: manager.bleService.registry.decide(evidence).drivers.single,
        physicalId: 'AA:BB',
        evidence: evidence,
        admit: () => true,
        createTransport: () => transport,
      )
      as Scale;
}

void main() {
  test('manifest declares the Solobarista driver and capabilities', () {
    final driver = solobaristaManifest().drivers.single;
    expect(driver.id, 'solobarista');
    expect(driver.type, PluginDriverType.scale);
    expect(driver.capabilities.map((capability) => capability.name).toSet(), {
      'tare',
      'timerControl',
      'timerTelemetry',
      'disconnectToSleep',
    });
  });

  test('connects and publishes weight and scale timer', () async {
    final manager = PluginManager(kvStore: FakeKeyValueStoreService());
    final controller = ScaleController();
    addTearDown(() async {
      controller.dispose();
      await manager.dispose();
    });
    await loadSolobaristaPlugin(manager);
    final transport = SolobaristaPluginTransport('AA:BB');
    final scale = await createScale(
      manager,
      transport,
      solobaristaEvidence(),
    );

    final connect = controller.connectToScale(scale);
    await transport.subscribed.future;
    transport.emit(solobaristaPacket(12.3, timerSeconds: 65));
    await connect;

    final first = await controller.weightSnapshot.first;
    expect(first.weight, 12.3);
    expect(first.timerValue, const Duration(seconds: 65));
    await scale.disconnect();
  });

  test('maps tare and timer controls to the official frames', () async {
    final manager = PluginManager(kvStore: FakeKeyValueStoreService());
    final controller = ScaleController();
    addTearDown(() async {
      controller.dispose();
      await manager.dispose();
    });
    await loadSolobaristaPlugin(manager);
    final transport = SolobaristaPluginTransport('AA:BB');
    final scale = await createScale(
      manager,
      transport,
      solobaristaEvidence(),
    );

    final connect = controller.connectToScale(scale);
    await transport.subscribed.future;
    transport.emit(solobaristaPacket(1));
    await connect;
    transport.writes.clear();

    await scale.tare();
    await scale.startTimer();
    await scale.stopTimer();
    await scale.resetTimer();

    expect(
      transport.writes.map((write) => write.data.toList()),
      solobaristaCommands,
    );
    expect(transport.writes.every((write) => write.withResponse), isTrue);
    expect(
      transport.writes.every(
        (write) =>
            write.characteristicUUID == solobaristaCommandCharacteristicUuid,
      ),
      isTrue,
    );
    await scale.disconnect();
  });

  test('ignores a frame with a bad checksum', () async {
    final manager = PluginManager(kvStore: FakeKeyValueStoreService());
    final controller = ScaleController();
    addTearDown(() async {
      controller.dispose();
      await manager.dispose();
    });
    await loadSolobaristaPlugin(manager);
    final transport = SolobaristaPluginTransport('AA:BB');
    final scale = await createScale(
      manager,
      transport,
      solobaristaEvidence(),
    );
    final samples = <WeightSnapshot>[];
    final subscription = controller.weightSnapshot.listen(samples.add);
    addTearDown(subscription.cancel);

    final connect = controller.connectToScale(scale);
    await transport.subscribed.future;
    transport.emit(solobaristaPacket(1));
    await connect;
    await pumpEventQueue();
    final baseline = samples.length;

    final bad = solobaristaPacket(99);
    bad[bad.length - 1] ^= 0xff;
    transport.emit(bad);
    await pumpEventQueue();
    expect(samples.length, baseline);

    transport.emit(solobaristaPacket(2));
    await pumpEventQueue();
    expect(samples.last.weight, 2);
    await scale.disconnect();
  });

  test('display sleep disconnects the scale', () async {
    final manager = PluginManager(kvStore: FakeKeyValueStoreService());
    final controller = ScaleController();
    addTearDown(() async {
      controller.dispose();
      await manager.dispose();
    });
    await loadSolobaristaPlugin(manager);
    final transport = SolobaristaPluginTransport('AA:BB');
    final scale = await createScale(
      manager,
      transport,
      solobaristaEvidence(),
    );

    final connect = controller.connectToScale(scale);
    await transport.subscribed.future;
    transport.emit(solobaristaPacket(1));
    await connect;

    await scale.sleepDisplay();
    expect(transport.disconnectCalls, greaterThan(0));
  });
}
