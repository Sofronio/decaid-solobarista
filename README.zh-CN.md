# Solobarista Scale for Decaid（中文说明）

Decaid 的 SOLO Barista **LSJ-001** BLE 秤插件。向 Decaid 提供重量和秤端计时
遥测，并通过 FFF2 发送去皮、计时开始/停止/清零命令。

英文说明见 [README.md](README.md)。

## 安装

仓库发布 release 后，可通过 Decaid 的插件 API 安装：

```bash
curl -X POST http://localhost:8080/api/v1/plugins/install/github-release \
  -H 'content-type: application/json' \
  -d '{"repo": "Sofronio/decaid-solobarista"}'
```

然后在 Decaid 里启用插件。设备 ID 为
`plugin:solobarista.reaplugin:solobarista:<physical id>`。

## 匹配规则

LSJ-001 **只广播设备名**，不广播任何 service UUID。因此插件只按名字匹配：

```json
{"name": {"contains": "lsj-001"}}
```

不要把 FFF0 加进广告匹配条件；FFF0 只能在连接后通过 GATT 发现。启用插件后，
后续扫描会由插件接管 LSJ-001；禁用后恢复 Decaid 原生处理。

## GATT

| 项 | UUID | 属性 |
| --- | --- | --- |
| Service | `0000fff0-0000-1000-8000-00805f9b34fb` | 厂商自定义 |
| 数据 | `0000fff1-0000-1000-8000-00805f9b34fb` | notify |
| 命令 | `0000fff2-0000-1000-8000-00805f9b34fb` | write / write-without-response |

插件订阅 FFF1，命令写入 FFF2 并等待响应；首包前和运行中都有 2 秒静默看门狗。

## 帧格式

```
AA | 长度 | 命令 + 数据 | 校验和
```

- 长度 = 命令 + 数据 + 校验和的字节数
- 校验和 = 命令 + 数据逐字节相加后的低 8 位

### 上行 `0x41`（11 字节）

```
AA 09 41 [计时状态] [秒] [分] [符号] [重量低] [重量高] [单位] [校验和]
```

- 计时状态：0 停止，1 运行
- 第 4 字节是秒（可能超过 59），第 5 字节是分；**设备实际是秒在前、分在后**，
  与厂商 CSV 的顺序相反
- 时间：`(分 * 60 + 秒 % 60)`
- 符号：`00` 正，`01` 负
- 重量：`(高 << 8 | 低) / 10`
- 单位：`00` 克，`01` 盎司，`02` 毫升

连接时插件会发送「单位→克」。如果收到盎司帧，插件会换算成克；毫升按水的克数
处理，保证 Decaid 的重量字段统一为克。

### 命令

| 操作 | 帧 |
| --- | --- |
| 去皮 | `AA 02 31 31` |
| 开始计时 | `AA 02 33 33` |
| 停止计时 | `AA 02 34 34` |
| 计时清零 | `AA 02 35 35` |
| 单位→克 | `AA 03 36 00 36` |

协议还定义了关机、单位切换、提示音命令；本驱动没有暴露它们。显示休眠走
Decaid 的 `disconnectToSleep`，不主动关秤。

## 能力

- `tare`
- `timerControl`
- `timerTelemetry`
- `disconnectToSleep`

LSJ-001 的上行帧没有电量和流量，因此不声明 `battery` / `flow`。

## 测试

Node 协议测试不需要 Decaid 检出：

```bash
node --test test/plugin_test.mjs
```

Decaid 集成测试需要把本仓库放在 Decaid 检出旁边，然后复制测试文件：

```bash
cp test/decaid/helpers/solobarista_plugin_fixture.dart <decaid>/test/helpers/
cp test/decaid/plugins/solobarista_plugin_test.dart    <decaid>/test/plugins/
cd <decaid> && flutter test test/plugins/solobarista_plugin_test.dart
```

## 验证

### 自动化测试

- `node --test test/plugin_test.mjs`：8/8 通过
- Decaid 集成测试：5/5 通过（name-only 匹配、连接、重量/计时、命令、
  坏校验、显示休眠断开）

### 真机 BLE 协议探针（2026-10-24）

实体 LSJ-001，macOS 上的独立 bleak 探针：

- 扫描：`LSJ-001`，广播 services `[]`，确认只能按名字匹配
- GATT：FFF0；FFF1 notify；FFF2 write / write-without-response
- 初始单位是 `02`（ml）；发送 `AA 03 36 00 36` 后，帧变成 `00`（g）
- 去皮 `AA 02 31 31`、计时清零 `AA 02 35 35` 正常
- 开始 `AA 02 33 33`：`running=1`，计时从 00:00 到 00:02
- 停止 `AA 02 34 34`：`running=0`，计时冻结在 00:02，连续读数不变
- 清零：计时回到 00:00
- 当时秤是空的（0.0 g），这一轮重点验证单位、命令和计时

### Decaid 端到端（2026-10-24）

三星 SM-X210（Galaxy Tab A9+），Android 16，Decaid 0.9.0：

- 插件 v0.1.0 已安装、启用、loaded
- 设备发现为
  `plugin:solobarista.reaplugin:solobarista:bc:a6:30:23:13:8e`，作为主秤连接
- 实时重量：**97.6 g**（97.5–97.6 g 波动），battery `null`（帧里没有电量），
  计时 0
- 通过 Decaid 触发计时：开始 → 2 秒后 2000 ms；停止 → 冻结在 6000 ms；
  清零 → 0 ms
- 没有发去皮命令，所以 97.6 g 的负载保留在秤上

## 发布

`scripts/package.sh` 生成 `dist/solobarista.reaplugin-<version>.zip`。推送
`vX.Y.Z` tag 后 CI 会执行同一脚本并发布 release。tag 必须等于
`manifest.version`。

## 许可证

尚未选择。
