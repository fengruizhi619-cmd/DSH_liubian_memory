# dsh-liubian-notes（流变·便签）

流变系统的短期记忆子系统，与流变·记忆（dsh-liubian）互补。方案：`E:\DSH_data\流变系统\docs\便签系统_DSH实施方案.md`（v2.3）。

- **便签 = 头 + 正文**：头是一句话简介，也是唯一向量来源（8082 本地 embedding）；检索只用向量，不用 tag。
- **双来源**：每 R 轮自动聚合一篇（默认 R=5，待实测调）——**LLM 生成头+正文**（与自动日记同通道 diary.json，失败回退拼接）；智能体用 `stick` 主动挂起（与自动便签同规则）。
- **注入**：每轮取「该轮对话 + 上一轮完整问答」作查询向量，与便签头余弦最近 n=3 篇注入 `<liubian-notes>` 块；**无预算上限**（整头整正文，管理员 2026-10-01 指示）。
- **热度**：每被注入一次记 1 条、独立存活 m=R 回合；热度分 = l/m。
- **赛马**：池满 10 篇踢热度最低者（并列踢最旧）入回收站；头向量相似度 >0.90 判重拒收（回收站也参与判重）。
- **晋级 = 缓存制**：`promote` 把便签存入 `pending_promotions.jsonl` 待固化队列（status=queued，受保护不再参与赛马）——固化通道暂缓，**将来经被炉 P2P + 独特名系统提交 wiki**（memory.py 写入路径已于 v0.3.0 移除）。自动送审为 P2。

## 存储

`~/.dsh/liubian-notes/pools/<会话8位>.json`（池，**含封存窗口与进行中轮次——持久化，热更/重启不丢**）+ `<会话8位>.retired.jsonl`（回收站）+ `pending_promotions.jsonl`（待固化队列）。会话键 = SHA256(sessionId) 前 8 位（与被炉房间 ID 同源）。不碰 `~/.dsh/liubian/` 与 liubian.db。

## 工具

`_dsh_external_dsh_liubian_note`：action = `list` / `show` / `stick` / `promote` / `drop` / `restore`。

## 配置

`~/.dsh/liubian-notes/config.json`：`enabled / poolSize=10 / injectTop=3 / aggregateRounds=5 / dedupThreshold=0.90 / noteLlmGen / embedUrl …`（全量见 impl.mjs DEFAULTS）。

- **聚合 LLM 通道**（v0.3.3 收敛）：读取顺序 = `~/.dsh/liubian/config.json` 的 `llmApiUrl` / `llmApiKey` / `llmApiModel`（家族共享键单一来源，记忆向量名下）→ `~/.dsh/liubian/diary.json`（过渡期兜底；其属主 auto-diary 子系统已于 2026-10-01 退役 `d3c1d50`）→ 内置默认（deepseek）。
- **记忆侧 5 键**（python/memoryScript/liubianRoot/workspace/memoryTimeoutMs）：单一来源 `~/.dsh/liubian/config.json`（P2 wiki 提交通道使用；缺键回落内置兜底）。

## 与流变记忆的交接（2026-10-01 与记忆向量对齐，v0.3.0 更新）

- **固化**：管理员指示暂缓——promote 只做本地缓存，不再调 memory.py（写入路径已移除）；通道就绪（被炉 P2P + 独特名系统）后切 wiki 提交。
- **升格标签**：`便签升格 + 会话工作区名 + 2~3 个内容关键词`（不足以「待整理/短期记忆/流变便签」补位去重）；弃用固定五连水泥标签。
- **向量服务 8082**：共享基础设施，双方 HTTP 直连，维持现状。

## 形态

与 dsh-liubian 同款两层：`lib/main.mjs` 入口壳（缓存戳动态导入）+ `lib/impl.mjs` 全部实现；`node_modules/@deepseek-ai/dsh-tools` 为 junction（指向 checkout：`E:\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh-tools`，与运行中宿主同源）。改 impl.mjs 重新注入即热生效。
