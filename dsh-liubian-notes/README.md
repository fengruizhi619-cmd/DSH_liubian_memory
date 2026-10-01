# dsh-liubian-notes（流变·便签）

流变系统的短期记忆子系统，与流变·记忆（dsh-liubian）互补。方案：`E:\DSH_data\流变系统\docs\便签系统_DSH实施方案.md`（v2.1）。

- **便签 = 头 + 正文**：头是一句话简介，也是唯一向量来源（8082 本地 embedding）；检索只用向量，不用 tag。
- **双来源**：每 R 轮自动聚合一篇（默认 R=5，待实测调）；智能体用 `stick` 主动挂起（与自动便签同规则）。
- **注入**：每轮取「该轮对话 + 上一轮完整问答」作查询向量，与便签头余弦最近 n=3 篇注入 `<liubian-notes>` 块（≤2KB）。
- **热度**：每被注入一次记 1 条、独立存活 m=R 回合；热度分 = l/m。
- **赛马**：池满 10 篇踢热度最低者（并列踢最旧）入回收站；头向量相似度 >0.90 判重拒收（回收站也参与判重）。
- **固化**：`promote` 把便签写进流变记忆（kind=log，标签含 便签归档），拿到 D 编号后受保护不再参与赛马。自动送审（热度最高者、通路二审核）为 P2。

## 存储

`~/.dsh/liubian-notes/pools/<会话8位>.json`（池）+ `<会话8位>.retired.jsonl`（回收站）。会话键 = SHA256(sessionId) 前 8 位（与被炉房间 ID 同源）。不碰 `~/.dsh/liubian/` 与 liubian.db。

## 工具

`_dsh_external_dsh_liubian_note`：action = `list` / `show` / `stick` / `promote` / `drop` / `restore`。

## 配置

`~/.dsh/liubian-notes/config.json`：`enabled / poolSize=10 / injectTop=3 / aggregateRounds=5 / dedupThreshold=0.90 / embedUrl …`（全量见 impl.mjs DEFAULTS）。

**记忆侧 5 键不在本插件配置里**：`python / memoryScript / liubianRoot / workspace / memoryTimeoutMs` 的单一来源是 `~/.dsh/liubian/config.json`（记忆向量维护，2026-10-01 交接收口）；此处只在缺键时用内置兜底值。

## 与流变记忆的交接（2026-10-01 与记忆向量对齐）

- **固化写入**：promote 同步调 memory.py CLI（公开命令面），D 号同步回传；配置走上述单一来源。
- **升格标签**：`便签升格 + 会话工作区名 + 2~3 个内容关键词`（不足以「待整理」补位）；弃用固定五连水泥标签（防长尾污染）。
- **P2 目标（管理员钉）**：记忆系统停用实时记录后，信息主来源 = 便签升格进 wiki 条目——promote 的调用目标将从 memory.py write 切到记忆侧 S3 wiki 提交入口（就绪后切换）。
- **向量服务 8082**：共享基础设施，双方 HTTP 直连，维持现状。

## 形态

与 dsh-liubian 同款两层：`lib/main.mjs` 入口壳（缓存戳动态导入）+ `lib/impl.mjs` 全部实现；`node_modules/@deepseek-ai/dsh-tools` 为 junction（指向 profile node_modules，构建/注入前确认存在）。改 impl.mjs 重新注入即热生效。
