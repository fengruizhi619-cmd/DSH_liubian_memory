# dsh-liubian-infra · 流变基建

> 流变家族的共享底座：**独特名注册中心** + **会话↔身份独热绑定** + **向量服务所有权**。
> 管理员 2026-10-01 钉：核心功能 = 向量化服务（v0.2.0 起所有权归基建）+ 独特名注册机制 + 会话绑定。
> 契约：`docs/流变独特名注册契约_v1.md`（本插件是参考实现）｜标准：`docs/流变插件族接口与构造标准_v0.1.md`

## 独特名注册中心

每个智能体一个**全局独热唯一**的名字；注册时自动从名字派生 SHA-256 哈希作为身份唯一标识符。

| 概念 | 规则 |
|---|---|
| 名字规范化 | 去首尾空白 → NFC → 非空、≤64 字符、无控制字符、不以 `@`/`#` 开头 |
| 身份哈希 | `SHA-256(UTF-8(NFC(name)))` 十六进制小写 64 位 —— **全局唯一标识符** |
| 短 ID | git 式最短唯一前缀，**≥8 位**（无碰撞时恰为 8，兼容被炉「SHA256 前 8 位」惯例）；碰撞时自动扩位 |
| 独热 | 名字一经注册**永久保留**——`retire` 只停用不回收，不可被再次注册 |
| 大小写 | 不敏感（`Alice` 与 `alice` 同一身份） |

### 工具 `_dsh_external_dsh_liubian_infra`

| action | 作用 |
|---|---|
| `register` | 注册（name 必填，note 可选）→ 返回名字 + 短 ID + 全 hash |
| `verify` | 唯一性校验（无副作用）→ 可用 / 被谁占用 |
| `lookup` | 按 `name` 或 `id`（短/全 hash，≥8 位 hex）查询 |
| `list` | 全表 |
| `retire` | 停用（独热保留） |
| `bind` | **会话绑定**：以会话哈希（8 位 hex，注入提示里给）绑定已注册身份，独热配对 |
| `unbind` | 释放绑定（按 session 或 name） |
| `binding` / `bindings` | 查绑定 / 全部绑定 |
| `status` | 总览 |
| `embed-status` / `embed-ensure` / `embed-stop` / `embed-restart` | 向量服务控制面（v0.2.0 起所有权归基建） |

## 会话↔身份独热绑定（v0.2.0）

- 会话哈希 = `SHA256(sessionId)` 前 8 位（与被炉房间 ID 同源同配方）。
- 未绑定会话在每个新人类回合收到**一条**注册提示（含本会话哈希）；已绑定会话不注入；注册中心不可用静默降级。总开关 `bindNag`（默认开）。
- 独热配对双向强制：会话侧主键 + 身份侧唯一索引。旧会话终结 → `unbind` 释放 → 重绑。
- 绑定即归因：该会话的署名/贡献者行为归因到绑定身份。

## 注册表存储（其他插件怎么统一查询）

- 文件：`~/.dsh/liubian-infra/registry.db`（SQLite，WAL 模式，busy_timeout 5s）
- **单写多读**：只有本插件写；其他插件**只读**——
  - Python：`sqlite3.connect('file:.../registry.db?mode=ro', uri=True)`
  - Node：`node:sqlite` 的 `new DatabaseSync(path, { readOnly: true })`（或直接 SQL 查询）
- 表结构（契约 v1 §4，改结构 = 契约 major 变更）：

```sql
identities(name TEXT PRIMARY KEY, name_key TEXT UNIQUE, hash TEXT UNIQUE,
           short_id TEXT, status TEXT DEFAULT 'active', note TEXT,
           created_at TEXT, retired_at TEXT, retired_note TEXT)
```

- **降级链（白泽门禁③）**：注册中心不可用时，消费方按各自契约降级到本地命名
  （如被炉用本地 members 缓存继续收发），不阻塞业务。
- 派生函数必须与契约一致：消费方自算 hash 时用
  `sha256(utf8(NFC(name)))`（§8 同源派生函数纪律：禁止一边字面量一边哈希）。

## 向量服务所有权（v0.2.0 挂牌迁移）

`dsh-liubian-embed` 已退役（patch disabled 阻断自装配）。本插件接管服务所有权：

- **加载自动带起**：`autoEnsureOnLoad=true`（探活离线 → 后台直起 exe，无窗）
- **内存看门狗**：`watchdogEnabled=true`，私有提交 >`watchdogLimitMb`(4096MB) 自动重启，每 `watchdogIntervalSec`(300s) 检查
- **过渡期别名**：`_dsh_external_dsh_liubian_embed` 由本插件承载（动作与 infra 同；家属迁移窗口结束、全部换用 infra 后删）
- 配置源不变：`~/.dsh/liubian/embed.json`（共享键同名，标准 §5）

## 配置

`~/.dsh/liubian-infra/config.json`（剥 BOM）：

| 键 | 默认 | 说明 |
|---|---|---|
| `dbPath` | `~/.dsh/liubian-infra/registry.db` | 注册表 DB |
| （embed 系键） | 同 embed 插件 | 从 `~/.dsh/liubian/embed.json` 读，共享键同名（标准 §5） |

## 测试

```
node.cmd _dev/stub_test.mjs   # 31 项纯函数+真库桩测（临时 DB，不碰生产表）
```

## 安装期注意

1. 插件目录内 junction `node_modules/@deepseek-ai/dsh-tools` → 宿主 checkout
   （`E:\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh-tools`；勿指 profile 旧路径，v4 已移除）。
2. `main.mjs` 是壳，实现在 `impl.mjs`（`?t=` 缓存戳）——改 impl 后 uninject+inject 即热生效。
