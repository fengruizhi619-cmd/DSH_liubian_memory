---
name: liubian-memory
description: 流变·记忆系统（DSH 版）。实时写日记已退役，长期记忆新形态是 wiki 条目（家族树 + 条目五要件 + 梯度稀释检查点），新内容由便签升格流入；每轮自动注入 wiki 条目命中与技能命中。当用户提到"记忆""wiki 条目""升格""检索记忆""流变""#m""语义检索"，或需要跨会话查历史结论、把技能加入检索库、做 wiki 条目 create/update/get/move、查贡献者归因时使用。含归因二分规则、标签策略、向量契约要点与通路二校验。
---

# 流变·记忆（DSH 版）

> **2026-10-01 换血**：实时写日记（auto-diary、`write` / `diary` 工具）**已退役**。
> 长期记忆的新形态是 **wiki 条目**（家族树 + 条目五要件 + 梯度稀释检查点），
> 新内容由 **便签升格** 流进来。
>
> 后端数据仍与 Codex 侧 `memory-skill` 同源：`E:\DSH_data\.memory_registry\liubian.db`
> （旧日记表 + 标签索引 + wiki 表同库）。本文件描述 **DSH 侧现状**；
> 架构与来龙去脉见 wiki 条目〈记忆系统架构〉〈wiki 化改造〉〈升格流落树约定〉。

## 触发与开关
中文／英文／日语对话或 `#m` 触发（问候闲聊也触发）。
- `#m` / `#m -o` —— 开启完整流程
- `#m -c` —— 关闭，本轮不触发任何记忆行为

## 自动上下文插入（插件已启用，先看这里）
每轮**新的人类输入**到达时，插件自动检索并注入，**你不需要自己去取**：

| 注入块 | 内容 | 频率 |
|---|---|---|
| `<liubian-wiki hits="N">` | **wiki 条目**：slug／标题／家族全路径／简介锚（语义匹配 top 8） | 每个新人类输入 |
| `<liubian-skills>` | 语义命中的**技能**（只给名字 + 摘要 + 相似度） | 同上 |
| `<liubian-lessons>` | 通用教训清单（全局 + 当前工作区） | 会话开始；每 10 轮重注 |
| `<liubian-capabilities>` | 能力卡（已装插件/MCP 的「什么时候用什么」） | 周期性 |
| 技能全文 | 语义命中超阈值的技能，**直接注入 SKILL.md 全文**并提示按它执行 | 命中时 |

- **不要再找 `<liubian-memory>` 日记注入块**——日记注入**已整体摘除**。
- 旧日记仍可**显式**检索（见「旧日记」一节），但它不再是每轮自动注入的主线。
- 同一轮内的工具往返不重复注入；插件不会把自己的注入块当查询（避免越滚越多）。

## 工具面（当前 10 个）

| 目的 | 工具 | 关键参数 |
|---|---|---|
| **wiki 条目**（长期记忆主体） | `_dsh_external_dsh_liubian_wiki` | `action` = create／update／get／tree／list／move／rollback／search |
| 旧日记检索 | `_dsh_external_dsh_liubian_search` | `tags`（≥4，逗号分隔）+ 可选 `query`／`workspace` |
| 读旧日记正文 | `_dsh_external_dsh_liubian_read` | `diary_ids`（`D0932` 或 `D0932@工作区`） |
| 标签字典 | `_dsh_external_dsh_liubian_tags` | `workspace`（可省） |
| 规模统计 | `_dsh_external_dsh_liubian_info` | `workspace`（可省） |
| 技能入检索库 | `_dsh_external_dsh_liubian_skill_index` | `action` = index／all／status／prune + `root` = codex／dsh |
| 通路二校验 | `_dsh_external_dsh_liubian_path2` | `question` |
| 通用教训 | `_dsh_external_dsh_liubian_lessons` | `action` = list／add／remove／generate + `scope` |
| 系统总览 | `_dsh_external_dsh_liubian_status` | — |
| 管理面板 | `_dsh_external_dsh_liubian_panel` | `target=admin` |

**已退役、不要再调**（调了是 `unknown tool`）：
`write`（写日记）、`diary`（自动日记运维）、`account`（免密账号）、`update`（技能快照）、
`embed`（向量控制面——**已划归流变·基建**，过渡期旧名 `_dsh_external_dsh_liubian_embed` 仍可用，
正式入口是 `_dsh_external_dsh_liubian_infra` 的 `embed-status／embed-ensure／embed-stop／embed-restart`）。

## wiki 条目（长期记忆主形态）

### 归因规则（二分，2026-10-01 定稿）
- **执行者（executor）**：永远由**调用会话的绑定身份**派生（会话哈希 → 注册中心 `registry.db` 的
  bindings），**不可由参数覆盖**——冒名在结构上不可能。返回里带 `executorResolved`
  （`binding` / `workspace-fallback`）。
- **内容来源者（source_contributor）**：显式可选，工具参数名 `contributor`
  （升格流的原作者/被引用贡献者落这一列）。
- 兜底时（无绑定 / 注册中心离线）执行者回退**工作区名**，且修订 summary 会自动附
  「贡献者按工作区兜底」——可疑归因必须自己标出来。

### 升格流（新内容进来的通道）
便签晋级 → 留言板送审 → wiki 建条目（`draft`）→ 银杏审（简介锚 / 家族归属 / 状态）→ `stable`。
五条约定见 wiki 条目〈升格流落树约定〉：**语义 slug 必备**（禁 `promote-NT-x` 这类池 ID 作永久 slug）、
**落树前三段提炼**（结论 / 机制 / 终态，被推翻的方案要标终态与防回归）、**同主题多切片归并**、
贡献者署名、**intro 即检索主通道**。

## 旧日记（只读历史）
- 数据（1 万余篇）仍在 `liubian.db`，`search` / `read` / `tags` 保留为**只读查询**。
- **不要**再指望它自动进上下文；要查就显式调 `search` 再 `read`。

## 语义向量
- 本地嵌入服务：llama.cpp `qwen3-emb`，`http://127.0.0.1:8082/v1/embeddings`，**1024 维**（已钉死；
  换模型 = 全量重嵌 + 表重建，慎行）。
- **服务所有权归流变·基建**：控制面见 `_dsh_external_dsh_liubian_infra` 的 `embed-*` 动作。
- 调用约定以仓库 `docs/流变向量服务调用契约_v1.md` 为准（**消费方必须声明降级链**）。要点：
  按返回的 `index` 排序取向量、按 **token 预算**（不是字符数）切块、4xx 不重试、断连带一次重试。
- 服务不可用 → 检索**静默回退纯 tag**，不阻塞对话。

## 检索配方（旧日记，显式 `search` 时）
两级：①**语义一路**——查询文本嵌入后与库里日记向量算余弦；②**tag 一路**——查询文本 + 标签候选表
送外部 API 挑 5 个标签做字面检索；③融合取前 5 篇作**主线**（综合分 = 语义余弦 + 0.5 × 命中标签数/5）；
④沿每条主线的向量各扩 5 篇**关联**，合并去重后至多 30 篇。
> 为什么是「余弦 + 标签加成封顶 0.5」而不是线性加权：线性加权下「命中 1/5」等于 cos 意义上的 0.2，
> 比两个平庸语义分之差还大，只蹭到一个跨领域同名标签的无关日记会被顶进前三（实测过）。
> IDF 加权 / IDF 求和 / 平方 / 1.5 次方四种补丁都试过：前两种没治住，后两种把 tag 一路压死。

## 标签规则（写旧日记与检索都用）
- 禁止宽泛：`技能`、`规则`、`经验`、`讨论`、`实现`、`设计`、`测试`、`配置`
- 推荐：`记忆skill-标签优化`、`token消耗分析`
- 每次至少 5 个标签，优先复用已有标签库（先 `_dsh_external_dsh_liubian_tags` 看一眼），禁止 `#` 前缀
- **自检：只看标签能猜到你写了什么内容吗？**

## 通路二校验（按需）
`_dsh_external_dsh_liubian_path2`：无上下文外部双 API——API-A 出初始回答，API-B 按五维度
（逻辑断裂 / 未回答问题 / 证据缺失 / 过度声称 / 答非所问）列问题清单。重大结论想要独立复核时用，
不必在回答里声明用没用。

## 强制规则
- 每轮强制触发；搜索失败 → 换 tag 组重搜或补写后再搜，禁止跳过
- **不要向用户索要任何凭据**：DSH 侧无身份、无密码；wiki 归因由会话绑定自动完成
- 禁止擅自改记忆文件（`liubian.db` 只由本插件与基建写）
- **三次造假规则**：每次回答前必须真实执行检索或明确判断跳过；写假标签＝流程违规

## 维护者须知（2026-10-01 起：守夜人）
- 代码：live `C:\Users\Feng\.dsh\plugins\dsh-liubian`（纯 bundle 装配）
- **唯一版本库** = `E:\DSH_data\流变系统`，插件镜像在 `dsh-plugin/`（改完 live 要同步镜像再提交；
  live 目录里**没有** git 仓，历史那个停摆仓已备份移除，避免 `git status` 给假信号）
- 自测：`_dev/stub_test.mjs`（纯函数桩测，不依赖宿主）+ helper 端到端脚本；
  **helper 改即生效**（每次新起进程），**impl.mjs 改动要重装/重启才生效**
- 热更姿势：bundle 归属插件**别用 uninject + inject**（会删 junction、写伪残渣）；
  走 touch profile patch 触发重装配，或等重启窗口一次收全
