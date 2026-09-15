---
name: liubian
description: 流变系统总纲（DSH 版）。统合 记忆 / 更新 / 通路 三个子系统与本地管理面板。当用户提到"流变""记忆系统""技能装载/更新快照""通路二/双通路校验"，或需要跨会话查历史、把技能加入检索库、拉起本地管理面板时使用。日常记忆流程细节见 liubian-memory 技能。
---

# 流变系统（DSH 版）

> 流变系统 = 智能体基础设施集合体。本技能是 Codex 侧 `liubian` + `memory-skill` 两个技能
> 连同它们 9 个 MCP 服务器在 DSH 上的移植版，由插件 `dsh-liubian` 承载。
> 「流变」取义：记忆会流动、系统持续演化。

## 三个子系统

| 子系统 | 内部名 | 职责 |
|---|---|---|
| 流变·记忆 | liubian-memory | 日记 / 标签 / 共现 / 检索 / 用户 |
| 流变·通路 | liubian-path | 双通路问答：分解 → tag 检索 → 通路二外部校验 → 汇聚 |

## 工具清单（11 个原生 DSH 工具）

| 工具 | 作用 |
|---|---|
| `_dsh_external_dsh_liubian_write` | 写日记或工作流日志 |
| `_dsh_external_dsh_liubian_diary` | 自动日记运维：status / preview / run / retry / enable / disable |
| `_dsh_external_dsh_liubian_search` | 全局检索（tag + 语义 1:1 融合，含技能总揽命中） |
| `_dsh_external_dsh_liubian_read` | 读日记正文（`D0932` / `D0932@工作区`） |
| `_dsh_external_dsh_liubian_tags` | 标签字典（写日记前先查，优先复用细小标签） |
| `_dsh_external_dsh_liubian_info` | 工作区记忆统计 |
| `_dsh_external_dsh_liubian_lessons` | 通用教训管理（list / add / remove / generate） |
| `_dsh_external_dsh_liubian_skill_index` | 技能 SKILL.md 入语义检索库（index / all / status / prune） |
| `_dsh_external_dsh_liubian_path2` | 通路二：无上下文双 API 校验，返回 `{initial_answer, problems[]}` |
| `_dsh_external_dsh_liubian_status` | 系统总览（注册表统计 + 统一 CLI status） |
| `_dsh_external_dsh_liubian_panel` | 打开本地管理面板（仅本机真人） |
| `_dsh_external_dsh_liubian_embed` | 向量服务（8082）：status / ensure / stop / restart（由独立插件 `dsh-liubian-embed` 提供） |

## 流变·通路（双通路问答，所有问题都触发）
复杂问题在单轮对话内完成：**分解 → 检索 → 通路二工具 → 汇聚**，每轮一篇日记。

1. **通路一（主智能体）**：把问题分解成若干小问题 → 逐子问题用 tag 组检索记忆
   （tag 必须来自 tag 字典）→ 产出结构化记忆总结（子问题 / tag 组 / 命中日记 ID / 要点）
2. **通路二（外部工具，无上下文）**：`_dsh_external_dsh_liubian_path2`
   - API-A 生成初始回答，API-B 按五维度校验：**逻辑断裂 / 未回答问题 / 证据缺失 / 过度声称 / 答非所问**
   - 出参 `{initial_answer, problems[]}`；每次用量写入 `usage_log.jsonl`
   - 一次性无状态：不检索记忆、不写日记、不继承上下文
3. **汇聚（主智能体）**：结合通路一的记忆总结 + 通路二的初始回答与问题清单 → 输出最终回答。
   **检验只负责提问题，事实核对由主智能体对照记忆总结裁决。**

## 数据位置
| 内容 | 路径 |
|---|---|
| 全局注册表（用户 / 日记索引 / 标签） | `E:\DSH_data\.memory_registry\liubian.db`（SQLite） |
| 通路二配置/密钥 | `C:\Users\Feng\.codex\skills\liubian\scripts\通路2\config.json`（勿外传） |
| 插件配置 | `C:\Users\Feng\.dsh\liubian\config.json` |

## DSH 侧没有身份
**不要向用户索要密码、KEY 或花名。** 写日记是**匿名写入**（不带 `-u`，既不鉴权也不受工作区
归属限制）；检索走 helper 直连 SQLite。所有工具的参数里都没有 `username` / `password` / `key`。

## 本地管理面板
`_dsh_external_dsh_liubian_panel target=admin` —— 用户 / 记忆 / Skill 管理（PyQt，绑定本机）

## 对话定义
一段对话 = 用户一句 + 模型一句。**每轮写一篇独立日记。**
