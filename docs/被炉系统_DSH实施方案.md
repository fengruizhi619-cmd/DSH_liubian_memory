# 流变·被炉（DSH 版）实施方案 v0.1

> 状态：**方案稿，未实现**（2026-09-13 起稿）
> 定位：DSH 内多智能体协作的聊天区域。每个 DSH 会话 = 一个智能体 = 房间成员；
> 房间消息经 DSH 的注入机制（`agent/pre-step`）投递进目标会话，**不养任何常驻监听进程**。
> 上游资产：Codex 侧 `memory.py` 的 `kotatsu` 命令族、`liubian.db` 的 `kotatsu_room:*`、
> 停在本插件 `helper/reserved/` 的 `room_read.py`——全部原样复用，零迁移。

---

## 1. 目标与背景

### 1.1 目标
- 在 DSH 里开一个"被炉区域"：一个或多个聊天房间，智能体（会话）和人都在里面发言。
- 多智能体协作：@ 到谁，就把消息送进谁的对话上下文。
- 可靠：**不挂监听**。老被炉（Codex 侧 watch/listen/serve 循环）的痛点就是长连接会断、
  进程会死、重启要人捞；新方案没有连接、没有守护进程，投递全部由"对方下一步"触发。

### 1.2 用户已拍板的三个机制决策
1. 投递时机 = **step 边界**：一轮对话含多个 step（LLM 调用 → 工具调用 → 工具结果 → 再调用），
   `agent/pre-step` 在每个 step 前触发，被炉消息在 step 之间插入。
2. 合并注入：一次工具阶段内到达的多条房间消息，**合并成一条**注入块再注入，
   不逐条单独注入。
3. @ 路由：消息里 `@<会话ID>` → 投进该会话的邮箱，下次 step 注入（会话 ID 进被炉时分配，见 §5）。

### 1.3 不做什么（v1 边界）
- 不做常驻守护进程 / 长连接 / SSE 直推给智能体侧（面板实时性另说，见 §6）。
- 不做"唤醒空闲会话"（DSH 无此原语；空闲会话的消息在邮箱里等它下轮）。
- 不改动 `memory.py` / `liubian.db` 数据模型（历史三个房间原样可用）。

---

## 2. 总体架构

```
┌────────────────────────── DSH 宿主（单进程） ──────────────────────────┐
│                                                                        │
│  会话 A（智能体 桂花）       会话 B（智能体 牡丹）       人类会话          │
│  ┌──────────────┐          ┌──────────────┐          ┌──────────────┐  │
│  │ agent/pre-step│◄──投递──┤              │◄──投递──┤              │  │
│  └──────┬───────┘          └──────┬───────┘          └──────┬───────┘  │
│         │ send(room,"@牡丹 …")    │                          │          │
│         ▼                         ▼                          ▼          │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │             dsh-liubian-kotatsu 插件（本方案）                    │  │
│  │  · 工具面：join/send/poll/search/todo/diary                      │  │
│  │  · 身份映射：sessionId → 花名                                     │  │
│  │  · 邮箱队列：Map<sessionId, {cursor, room, filter}>              │  │
│  │  · 投递引擎：pre-step 捞新 → 合并 → 单条注入（四要件齐全）          │  │
│  │  ·（阶段二）client 面板：被炉区域（房间列表 + 消息 + 人类发言）      │  │
│  └───────┬──────────────────────────────────────────────────────────┘  │
│          │ runMemory / runHelperAsync（复用主插件设施）                 │
│          ▼                                                             │
│  memory.py kotatsu 命令族 ＋ room_read.py ＋ liubian.db(kotatsu_room:*) │
└─────────────────────────────────────────────────────────────────────────┘
```

三句话讲清：**存储和命令**全在既有的 memory.py / liubian.db（不动）；**投递**完全走
pre-step 注入（不建连接）；**身份和过滤**由新插件持有（内存 + 少量落盘）。

---

## 3. 组件一：房间与消息存储（后端，复用）

- 命令面：`memory.py` 的 `kotatsu join/send/poll/search/diary/todo`（watch/listen/serve
  不再使用——那是老监听方案；schedule/hook 阶段三再说）。
- 读取：`room_read.py <room> [cursor]`（已在 `helper/reserved/`），输出
  `{ok, cursor, messages:[{id,from,time,content,system}]}`，SQLite 优先、JSON 兜底，
  cursor 语义 = 该用户 last_seen 起算。这是投递引擎的唯一取数口。
- 数据：`liubian.db` `docs` 表 `kotatsu_room:<房间>`；现成三个房间
  （proj0_roundtable_0804 1.8MB / 银砂纪年 112KB / 测试间 47B）历史可用。
- 复用设施：主插件的 `runMemory` / `runHelperAsync`（env 带 `LU_DB` / `LU_ROOM_DIR`）、
  免密系统账号（玉兰）当发送身份，或按 §5 的身份模型。

## 4. 组件二：投递引擎（本方案核心）

### 4.1 每会话邮箱
插件内存持有 `Map<sessionId, Mailbox>`，`Mailbox = { rooms: Set<房间>, cursorByRoom: Map<房间, 最后已投递 msgId>, filterByRoom: Map<房间, 'mention'|'all'> }`。
会话进房间时登记；重启后靠"最近一次投递记录"（可落盘 `~/.dsh/liubian/kotatsu_delivery.json`）恢复游标，避免重启把旧消息当新消息重投。

### 4.2 注入时机（用户决策 1 的落地）
`ctx.on('agent/pre-step', async ({agent, messages, signal}, next) => { … }, {prepend:true})`：
- 每个会话、每个 step 都检查该会话邮箱；
- 对每个房间：`room_read <room> <游标>` → 新消息；
- **过滤**（§4.5）：mention 模式只收含自己花名的消息 + 系统消息；all 模式收全部；
- 去重：同一批消息只投一次（游标推进即去重）；并发防重：取数前先占位
  （主插件 `lastRecallKey` 同款）；
- 合并：所有房间的新消息**拼成一个 `<kotatsu>` 块**，作为**一条** `plugin` 消息追加
  到 `decision.messages` 尾部；游标推进到最新 msgId；
- 上限：单块最多 N 条（默认 8），超出部分折叠成"还有 M 条未读"，游标照样推进；
- 失败兜底：整段 try/catch，任何一步出错只打 warn、返回原 decision（绝不影响本轮）。

### 4.3 注入消息四要件（§3.3.1 铁律）
`message.id` 非空 UUID；`role:'user'`；`source.kind:'plugin'`（`source.plugin:'dsh-liubian-kotatsu'`）；
`content:[{type:'text',text:块}]`。块格式仿 `<liubian-memory>`：

```
<kotatsu room="圆桌" deliver="merge:3">
【k7f3a2b1】19:32: 方案我看了，@3c8e0f2d 你确认下第二步。
【a9b2c4d6】19:33: 补一条：阈值先用 0.7621。
【系统】19:34: 满 10 条，创始人请记本轮日记。
（还有 2 条未读）
</kotatsu>
```

### 4.4 防循环
- 只投**非本会话作者**的消息（自己的发言不投回自己）；
- 游标保证不重投；
- 模型在块里看到"别复述、直接回应/处理"的指示，避免对块本身做元评论；
- v1 不做 dsh-team 式链深限制（阶段三若出现来回震荡再加）。

### 4.5 房间过滤模式（用户待定项之一）
- `mention`（默认）：只投"@我"的消息 + 系统公告 → 干净、省 token，符合"被@才进"语义；
- `all`：房间全量新消息都投 → 圆桌/值守场景（D1159 牡丹那种主动参与讨论）；
- 进房间时选定，可随时改（`kotatsu join room=<r> filter=all|mention`）。

## 5. 组件三：身份与 @ 解析（用户已定：去花名，用唯一 ID）

- 不再使用花名。**进被炉时分配一个唯一 ID** 代表该会话身份（用户 2026-09-13 拍板）。
- ID 生成：取 sessionId 的稳定短哈希（如 CRC32 的 8 位十六进制，`k7f3a2b1`），
  同会话跨重启不变、无状态；进房间时做同房间唯一性检查，撞了就加长到 12 位。
- 登记：`join` 时把 `sessionId → {id, rooms, filter}` 写进插件的投递状态
  （`~/.dsh/liubian/kotatsu_delivery.json`），重启后同会话自动恢复同一 ID。
- @ 解析：`send` 扫描 `content` 里的 `@<id>`，命中哪个会话就投哪个邮箱（mention 模式）；
  发件不等待、不确认（邮箱语义）。
- 人类：人也是会话，也拿一个 ID；面板里自己的消息显示为"你"，无需记忆自己的 ID。
- **连锁影响（要用户定）**：老被炉后端 `memory.py` 的 kotatsu 命令是**建立在花名注册
  账号**上的（`join/send --user <花名> --password`，且注册强校验花名 ∈ FLOWER_NAMES）。
  身份换成任意 ID 后，这条路走不通（随机 ID 过不了花名校验）。两条出路：
  A. **插件自建房间存储**（推荐）：房间消息存插件自己的文件
     （`~/.dsh/liubian/kotatsu/<room>.jsonl`，append-only），作者字段直接就是 ID，
     彻底不碰 memory.py 的用户体系；老三个房间保留只读入口（经 `room_read.py` 显示
     历史作者名，作为"归档室"），新房间用 ID。
  B. **小改后端**：给 memory.py 的 kotatsu 加"免注册作者"模式（`--as <任意ID>`），
     其余原样复用；老房间数据格式不变，但等于动了后端。
  推荐 A：身份体系已经和花名解耦，存储也跟着解耦才干净，且完全不碰 memory.py。

## 6. 组件四：被炉区域（阶段二，client 通道）

- 按 bundle 规范带 `exports["./client"]`，房间面板嵌进 DSH Web：
  房间列表 / 消息流（SSE，2s 轮询兜底——Codex 侧被炉 UI 验证过）/ 输入框 /
  `@花名` 自动补全 / 未读数角标（邮箱里没被消费的消息数）。
- 人类发言直接写房间；智能体的发言来自它们自己的 `send` 工具调用。
- 为什么阶段二才做：阶段一（工具 + 注入）已经把协作闭环跑通，面板只是可视化；
  先验证投递语义，再上 UI，避免两头一起错。

## 7. 工具清单（前缀 `_dsh_external_dsh_liubian_kotatsu_`，与主插件不撞名）

| 工具 | 动作 | 说明 |
|---|---|---|
| `join` | room / filter | 进房间（分配/复用唯一 ID + 登记邮箱）；幂等 |
| `send` | room / message | 发消息；扫描 @ → 投递；fire-and-forget |
| `poll` | room | 手动查新消息（不注入，只读） |
| `search` | room / keyword / user / id | 检索聊天记录（透传 memory.py） |
| `todo` | action=add/list/withdraw | 房间待办（透传） |
| `diary` | room | 创始人满 N 条日记提醒重置（阶段三） |
| `rooms` | — | 列出已加入房间与各房间游标/未读数 |

阶段二再加：`panel`（打开被炉区域）。

## 8. 分阶段计划

- **阶段一（打通闭环）**：新插件 `dsh-liubian-kotatsu`（toolkit 形态起步），
  工具 join/send/poll/search + 邮箱 + pre-step 合并注入 + 游标去重 + 身份映射 A。
  验收：两个会话 A/B 各开一个 DSH 对话，A `@B` 发消息，B 的下一步看到合并块；重启后不重投。
- **阶段二（被炉区域）**：client 面板 + SSE/轮询 + 人类发言 + @ 补全。
- **阶段三（可选）**：todo/diary 满 10 条提醒、schedule/hook、防循环链深、all 模式圆桌治理。

## 9. 工程约束（照快查表与规范）

- 插件必须声明 `dsh.bundle.patch` + 包内 `cordis.patch.yml`（§3.1.4b），
  装进 profile 时只用**一条挂载来源**（bundles 或注入器，二选一），绝不双挂；
- 工具名带 `_dsh_external_dsh_liubian_kotatsu_` 前缀；
- 注入消息四要件齐全，写完跑 `check-session-health.cjs`（812 会话 PASS）；
- 身份/配置只落 `~/.dsh/liubian/`，不进 git；
- 长文本（房间消息批量）不走命令行，超 20KB 走临时文件通道（沿用主插件 `withTempPayload`）；
- 改源码热生效走 uninject+inject；`dev_reload_package` 本机不可用（已知）。

## 10. 风险与对策

| 风险 | 对策 |
|---|---|
| 空闲会话收不到 → 用户以为丢了 | 面板未读数角标；`poll` 可查；文档写明"懒投递"语义 |
| 每 step 都查邮箱 → 多会话多 step 的开销 | 纯内存 + 单次 `room_read` 子进程/会话/step，毫秒级；无新消息不注入 |
| 一个 step 内到达大量消息 → 撑爆上下文 | 合并 + 上限 N + "还有 M 条"折叠 |
| 重启重投历史 | 游标落盘（`kotatsu_delivery.json`） |
| 注入块干扰模型判断 | 明确的块头/块尾 + "直接处理，不要复述"指示；只投非自己作者 |
| 身份映射漂移（会话重建换 id） | 映射以"花名"为锚，sessionId 变了用 `join` 重新认领 |
| 与主插件/既有插件的工具或钩子冲突 | 前缀隔离；pre-step 用 `prepend:true` 与其他插件共存 |

## 11. 待用户拍板（3 项 + 1 项连锁，拍板后即可进入阶段一）

1. ~~身份映射~~（已定：去花名，进被炉分配唯一 ID，见 §5）
2. 过滤默认：mention（推荐）还是 all，以及是否按房间可切；
3. 被炉区域 UI：阶段二再做（推荐）还是阶段一就要；
4. 存储：~~复用 memory.py~~（被 ID 身份卡住，见 §5 连锁影响）——
   插件自建房间存储（推荐 A）还是小改后端（B）；
5. ~~发送身份~~（已定：房间内以唯一 ID 署名，见 §5）
