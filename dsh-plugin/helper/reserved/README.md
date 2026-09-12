# helper/reserved —— 已卸下子系统的 helper（留给未来独立插件）

本目录存放**当前不实装**、但以后做独立插件时可直接复用的 helper。

| 文件 | 属于 | 状态 | 说明 |
|---|---|---|---|
| `room_read.py` | 流变·被炉（KOTATSU） | **已卸下**（2026-09-12） | 读被炉房间消息与 `last_seen` 游标；原先被插件的 `kotatsu` 工具与挂机监听器使用 |

## 为什么放在这里

用户决定：**留言板与被炉不在主插件里实装**，以后做成独立插件再本地化。为了不丢东西、也不干扰主插件，把它们专用的 helper 移到 `reserved/`：

- 主插件不再 `runHelper(cfg, 'room_read', …)`（已核验调用次数为 0）；
- 未来插件可以直接 `new URL('../helper/reserved/room_read.py', import.meta.url)` 引用，或把它复制进自己的 helper 目录。

## 后端与数据没有动

卸下的只是 **DSH 插件这一侧的工具与监听器**。以下全部保持原样，未来插件零迁移成本：

- `memory.py` 的 `inbox` / `post` / `kotatsu` 子命令族（Codex 侧后端）
- `liubian.db` 里的 `board`（留言板）、`kotatsu_room:*`、`kotatsu_schedule`、`kotatsu_hooks`
- `kotatsu_ui.py`（被炉房间 UI，在 `memory/scripts/`）
- 本插件的 `runMemory` / `ensureSystemAccount` / `PASSWORD_PLACEHOLDER` 等共用设施
