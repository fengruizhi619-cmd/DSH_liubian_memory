# 流变系统 · Liubian

> 给 AI 智能体用的**持久记忆与协作底座**：把每一轮对话沉淀成可检索的日记，让多个智能体互相留言、实时会诊，并让技能在它们之间自动分发与同步。

流变系统（Liubian）统合四个子系统：

| 子系统 | 作用 | 主要文件 |
|---|---|---|
| **流变·记忆** memory | 日记写入、标签索引、跨会话检索、语义向量召回 | `memory/scripts/memory.py`、`memory_db.py`、`semantic_search.py` |
| **流变·被炉** kotatsu | 多智能体实时房间：收发、待办、挂机监听 | `memory/mcp/mcp_kotatsu.py`、`memory/scripts/kotatsu_ui.py` |
| **流变·更新** update | 技能装载 / 快照 / 哈希同步 / 订阅广播 | `memory/mcp/mcp_update.py`、`liubian/scripts/liubian.py` |
| **流变·通路** path | 无上下文双 API 交叉校验（生成 → 五维度挑错） | `liubian/scripts/通路2/liubian_path2.py` |

本仓库同时提供**两套接入方式**：

- **`memory/` + `liubian/`** —— 原始的 **Codex / MCP** 接入：9 个 MCP 服务器 + 一个统一 CLI + 本地管理面板（PyQt / Web）。
- **`dsh-plugin/`** —— **DeepSeek Harness (DSH)** 原生插件，把同一套后端以原生工具形式接进 DSH，并额外实现：
  - **自动日记**：每轮对话结束后，由外部 API 把「上一轮完整对话」写成日记（标签候选用本地向量模型选前 100 个），下一轮自动落库；
  - **联合检索注入**：查询 = 上一轮回答 + 本轮问题 → ①嵌入成向量与全库日记算余弦 ②同一段文本 + 标签候选送外部 API 挑 5 个标签做字面检索 ③两路融合取前 10 篇**全文**注入上下文。

---

## 设计要点

**1. 记忆的粒度是"日记"，不是"消息"。**
不把原始对话灌进索引（那只会污染检索），而是每轮沉淀一条带**细小标签**的摘要式日记。检索靠标签命中 + 语义向量双路。

**2. 标签是检索的主键。**
标签必须"细、具体、可复用"（例如 `注入消息缺id` 而不是 `bug`）。系统会维护一张全局标签字典，写日记时优先复用已有标签。

**3. 检索是双路的。**
字面（标签）与语义（向量）各有盲区：前者漏同义表达，后者被泛化词淹没。两路融合后取交集附近的结果最稳。

**4. 多智能体靠"被炉"协作。**
被炉（Kotatsu）是给智能体用的群聊房间：留言、待办、挂机监听。不同会话/不同机器的智能体通过它交接任务。

**5. 技能即资产，可分发。**
技能（SKILL.md）有独立版本与哈希快照，`update` 子系统负责装载、比对、同步与广播。

---

## 快速开始

### A. 作为 DSH 插件（推荐）

```bash
# 1) 放到 DSH 插件目录
git clone https://github.com/<you>/liubian.git
# 把 dsh-plugin/ 链接或复制到你的插件目录，例如 ~/.dsh/plugins/dsh-liubian

# 2) 配置（可选，默认值见插件内 DEFAULTS）
#    ~/.dsh/liubian/config.json      —— 后端路径、默认工作区等
#    ~/.dsh/liubian/diary.json       —— 自动日记的开关与 API key（写日记用）

# 3) 注入
#    DSH 里用插件加载器加载该目录，或使用 super-injector：
#    dev_inject_plugin <插件目录>
```

插件会自动注册 16 个工具（写日记 / 检索 / 读日记 / 标签 / 留言板 / 被炉 / 更新 / 通路二 / 面板 / 自动日记运维 …），并在每轮对话前把最相关的 10 篇记忆全文注入上下文。

**自动日记需要一个 OpenAI 兼容的 chat completions 端点**（默认 DeepSeek）：

```jsonc
// ~/.dsh/liubian/diary.json
{
  "enabled": true,
  "url": "https://api.deepseek.com/chat/completions",
  "apiKey": "sk-...",
  "model": "deepseek-chat"
}
```

**语义检索 / 语义选标签需要一个本地嵌入服务**（llama.cpp + 任意 1024 维嵌入模型，默认 Qwen3-Embedding-0.6B，端口 8082）。服务不可用时全部功能自动退化为纯标签检索，不会报错。

### B. 作为 MCP 服务（Codex / Claude Code 等）

`memory/mcp/` 下有 9 个 MCP 服务器，逐个接进你的 MCP 客户端即可：

```
mcp_memory.py        写日记 / 读日记
mcp_search.py        标签 + 语义检索
mcp_write.py         写入
mcp_kotatsu.py       被炉房间
mcp_update.py        技能装载 / 快照 / 同步
mcp_skill_index.py   技能文档语义索引
mcp_validate.py      通路二校验
mcp_panel.py         打开本地管理面板
mcp_embed.py         本地嵌入服务生命周期
mcp_guard.py         身份 / 权限守卫
```

### C. 只用 CLI

```bash
# 记忆：写日记 / 检索 / 标签 / 留言板
python memory/scripts/memory.py write -t "标签1,标签2,标签3,标签4,标签5" -s "摘要" --content "正文"
python memory/scripts/memory.py search --tags "标签1,标签2,标签3,标签4"
python memory/scripts/memory.py tags
python memory/scripts/memory.py info

# 流变总纲：状态 / 面板 / 通路二
python liubian/scripts/liubian.py status
python liubian/scripts/liubian_panel_qt.py          # PyQt 管理面板
python liubian/scripts/通路2/liubian_path2.py "你的问题"
```

---

## 数据与存储

所有数据默认落在**单个 SQLite 库**里（`liubian.db`，路径由 `LU_DB` 环境变量指定）：

| 表 / 文档键 | 内容 |
|---|---|
| `docs`（键值） | 用户、工作区标签索引 `index:<工作区>`、留言板 `board`、被炉房间、技能快照 …… |
| `diary_content` | 日记正文 |
| `embeddings` | 每篇日记的 1024 维向量（float32 BLOB） |
| `skill_docs` | 技能文档的向量索引 |

**注意**：日志、向量、个人记忆内容**不在本仓库内**。仓库只含代码、技能定义与设计文档。

---

## 目录结构

```
liubian/
├── memory/                     流变·记忆（Codex/MCP 侧）
│   ├── SKILL.md                技能说明书（给智能体读的协议）
│   ├── scripts/
│   │   ├── memory.py           统一 CLI（日记 / 检索 / 用户 / 被炉 / 更新）
│   │   ├── memory_db.py        SQLite 访问层
│   │   ├── semantic_search.py  语义向量检索（llama.cpp 嵌入服务）
│   │   └── kotatsu_ui.py       被炉房间 UI
│   ├── mcp/                    9 个 MCP 服务器
│   └── agents/                 智能体侧配置
├── liubian/                    流变总纲（CLI + 面板 + 通路二）
│   ├── SKILL.md
│   ├── scripts/
│   │   ├── liubian.py          四子系统统一入口
│   │   ├── liubian_panel.py    本地 Web 管理面板
│   │   ├── liubian_panel_qt.py PyQt 管理面板
│   │   └── 通路2/              双 API 交叉校验
│   ├── icons/
│   └── 设计/                   设计文档
├── dsh-plugin/                 DeepSeek Harness 原生插件
│   ├── lib/main.mjs            入口壳（带缓存击穿的动态 import）
│   ├── lib/impl.mjs            单文件实现（工具面 + 上下文注入 + 自动日记 + 联合检索）
│   ├── helper/                 检索 / 统计 helper（Python）
│   └── skills/                 随插件分发的技能
└── docs/
```

---

## 环境要求

- Python 3.10+（标准库为主；语义检索有 numpy 更快，缺了会自动退化为纯 Python 余弦）
- 可选：本地嵌入服务（llama.cpp `--embeddings`，默认 `http://127.0.0.1:8082`，1024 维）
- 可选：任意 OpenAI 兼容 API（自动日记 / 通路二校验）
- DSH 插件部分：DeepSeek Harness，Node 20+

---

## 许可

MIT，见 [LICENSE](LICENSE)。
