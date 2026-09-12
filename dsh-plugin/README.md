# dsh-liubian · 流变系统（DSH 移植版）

把 Codex 侧的 **流变系统**（`C:\Users\Feng\.codex\skills\liubian`）与 **记忆系统**
（`C:\Users\Feng\.codex\skills\memory-skill`）两个技能及其 **9 个 MCP 服务器**移植到 DeepSeek Harness。

结构参照 DSH 自带的记忆插件 `@openviking/dsh-memory-plugin`：
它用「MCP 代理 + 技能提供方 + 生命周期钩子」把 OpenViking 接进 DSH；
本插件用「原生工具面 + 技能落盘 + 上下文插入钩子」把流变系统接进 DSH。
差别在于流变系统的后端不是常驻服务，而是一组 Python CLI（`memory.py` / `liubian.py` /
`liubian_path2.py`），所以不需要 MCP 代理这一跳。

## 为什么复用而不重写

数据全在 `E:\DSH_data\.memory_registry\liubian.db`（SQLite，30 个用户 / 13 个工作区 /
3 万条 tag 索引 / 3 个被炉房间）。插件直接复用这套 Python 实现，因此：

- 两端**同源同数据**：DSH 写的日记，Codex 侧 `#m` 流程立刻能检索到，反之亦然
- 后端修 bug 只有一处要改
- 不需要迁移任何数据

## DSH 侧不需要任何身份

用户要求：DSH 侧不再有身份 / 密钥 / 密码这些东西。后端的鉴权分布决定了这么做的办法：

| 能力 | 后端鉴权状况 | 本插件的做法 |
|---|---|---|
| 写日记 `write` | 整段被 `if username:` 包住，**不带 `-u` 就完全不鉴权**，也不校验工作区归属 | **匿名写**（不传 `-u`） |
| 检索 `search` | 带 `-u` 要密码+KEY；不带 `-u` 的匿名分支要求工作区 index 里有 legacy `last_key`，而库里 13 个工作区该字段全是空串 → **匿名分支已死** | 用自动注册的**免密系统账号** |
| 留言 / 被炉 / 更新 | 都要一个存在的账号（「我的收件箱」本质上需要知道「我是谁」） | 同上 |

**免密系统账号**：插件在首次需要时自动 `register --name <花名> --free`
（库里 `pwd` 为空 → `verify_user_pwd` 直接放行，**密码根本不存在**），并把 KEY 缓存到
`C:\Users\Feng\.dsh\liubian\account.json`。账号名默认 `玉兰`（`search` 强制要求
`username ∈ FLOWER_NAMES`，所以必须是花朵名），可在 config 的 `systemUser` 改。

用户从头到尾不需要输入任何密码或 KEY；插件自动建号时会在日志里写一行。

> `memory.py` 的几个命令把 `--password` 当**语法必填**（`search`：给了 `-u` 就必须给
> `-password`；`post`：`--password` 为空就直接报参数错），所以插件统一传一个占位符
> `dsh-noauth` —— 免密账号会忽略它，用户永远看不到也不需要知道。

## 上下文插入（对照 DSH 记忆插件的接线）

| 钩子 | OpenViking 的做法 | 本插件的做法 |
|---|---|---|
| `agent/session-start` | `agent.inject(profileMessage)` 塞「用户画像 + 可用记忆」 | 塞**流变接入卡**：写入模式 / 系统账号 / 最近一篇日记 / 未读留言数 / 被炉房间 / 记忆规模 |
| `agent/pre-step`（`prepend:true`） | 在 `next()` 返回的消息尾部追加 `recallMessage`，每轮按 prompt 自动召回 | 按 prompt 自动挑 tag → 走 `memory.py search`（tag + 语义 1:1 融合、含技能总揽命中）→ 追加召回块 |

注入块分别长这样（`source` 属性区分用途）：

```
<liubian-context source="profile"> …接入卡… </liubian-context>
<liubian-context source="recall" tags="银砂纪年,第76章,莉诺尔,米娅,…"> …检索结果… </liubian-context>
```

### 「本轮的人话」怎么认（最容易踩的坑）

召回查询必须是**人真正说的那句话**。实测打印出宿主在 pre-step 给出的消息表，
`role:'user'` 的消息里混着四种「非人」内容：

| source.kind | 来源 | 实测长度 |
|---|---|---|
| `plugin` | 本插件的接入卡/召回块、OpenViking 的画像块、`dsh-system-prompt` 的运行时快照 | 数百~数千字 |
| `skill-catalog` | 技能目录 system-reminder | **约 6900 字** |
| `tool` | 工具结果 | — |
| （`role:'assistant'`） | 助手消息 | — |

所以判定「人话」= `role==='user'` 且 `source.kind` 为空或 `'user'`。

**这个坑真的踩过两次**：第一版只排除了 `kind:'plugin'`，查询就落到 6900 字的技能目录上，
选出来的 tag 变成 `音频特征 / 触发条件 / 蒸馏 / 仿写` 这种噪声，用户问的第76章、米娅、
莉诺尔一个都没进标签，召回结果全跑偏到 `skill学院` 工作区。

### 召回怎么挑 tag

流变检索要求「至少 4 个标签」，而 prompt 是自由文本，所以插件自己挑：

1. 拉全局标签字典（13869 个标签，缓存 10 分钟），预先把每个标签的所有 2~4 元组放进 `Set`
   （约 7 万项）——挑 tag 时 O(1) 判定，不用扫全表。
2. 从 prompt 取 **CJK 2~4 元组（含数字**，否则「第76章」会被数字切成「第」「章」两个短片段，
   永远选不中）+ **拉丁词（≥4 字符、滤英文虚词）**，只保留出现在字典里的。
3. 去掉互为子串的候选（`银砂纪年` 命中后就不再要 `银砂纪`/`砂纪年`/`银砂`/`纪年`），
   把 8 个 tag 位留给更多概念。
4. 交给 `memory.py search` 做模糊扩展 —— 与 Codex 侧 `#m` 流程**同一条检索链路**。

实测（同一句话，修 before/after）：

| prompt | 修复前 | 修复后 |
|---|---|---|
| 帮我把《银砂纪年》第76章接着写下去，注意米娅和莉诺尔的关系 | `银砂纪年, 章接着写, 接着写下, 写下去…`（未过字典） | `银砂纪年, 第76章, 莉诺尔, 注意, 米娅, 关系, 风格, 贴合` |
| 替身：技能目录污染那一版 | `风格,写作,使用,蒸馏,文字,触发条件,音频特征,仿写` | `银砂纪年, 第76章, 莉诺尔, 米娅, 关系, …` |
| 只有宽泛词的 prompt | — | 空（<4 个 tag → 不召回） |

### 触发与去重

- 只在**新一轮人类输入**时召回：同一轮内的工具往返（末尾是工具结果或助手消息）不重复召回。
- 按 prompt 文本去重；先占位再 await，同一轮的并发 pre-step 不会重复触发。
- `recallMinChars`（默认 8）以下的短输入不召回。
- 预算：接入卡按 `profileTokenBudget`（默认 700 token，CJK 1.5 token/字）裁剪；
  召回块按 `recallMaxChars`（默认 2400 字）截断。
- `recallDebug: true` 会在日志里打印 pre-step 真实消息表与最终选中的 tag，排障用。

### 没有移植 capture

OpenViking 会把每一轮对话写进它自己的会话库；流变日记是用户精心打标签、用于长期检索的
**记忆资产**，自动把原始对话灌进去只会污染检索。所以写日记仍由技能流程显式调用 `write`。

### 消息构造器的回退

`@deepseek-ai/dsh-llm` 从本插件的真实路径解析不到（DSH 的模块解析钩子不覆盖
`~/.dsh/plugins`），所以 `createUserMessage` 拿不到时插件退回等价的最小消息结构
（`{role:'user', content:[{type:'text'}], source:{kind:'plugin', plugin:'dsh-liubian', form}}`）。
实测该回退结构被宿主正常接受：新会话能原样收到注入块，日志会写明 `消息构造器=内置回退`。

## 语义向量服务：已拆成独立插件

向量服务**不属于记忆系统**，已拆到独立插件 **`dsh-liubian-embed`**
（`C:\Users\Feng\.dsh\plugins\dsh-liubian-embed`），本插件不再持有它的配置、工具与生命周期。

解耦点只有一条约定：**HTTP 调不到就回退纯 tag**。所以：

- 那个插件没装、没跑、挂了，本插件的检索都照常工作，只是少了语义融合那一半权重
- 本插件不调用那个插件，也不关心它怎么起停；工具名 `_dsh_external_dsh_liubian_embed`
  保持不变（由 `dsh-liubian-embed` 提供），技能与使用习惯都不用改
- 融合公式（在 `semantic_search.py` 里）：`0.5 × tag命中率 + 0.5 × 语义余弦`；
  在线时检索输出 `语义检索: 已启用(向量 n 篇, 融合 tag+语义)`，离线时 `语义检索: 不可用(回退纯tag)`

## 自动日记（外部 API 撰写，下一轮写上一轮）

用户定的规格：**下一轮写上一轮**、**每轮都写**、**仍按工作区署名**、**标签字典送进 API（优先复用、允许新建）**、
**输入是上一轮完整对话**、**每篇 ≤500 字（超出新建一篇）**、失败不阻塞、开启后不再手动写。

实现（`impl.mjs` §6）：

| 环节 | 做法 |
|---|---|
| **采集** | `ctx.on('session/event')` 累积每轮的 `user/message`(人话) + `assistant/message` + `tool/call`，`turn/end` 封口。**不依赖 pre-step 的 messages**——长会话可能被上下文压缩截断，事件流才是权威 |
| **触发** | 下一轮第一步（`agent/pre-step` 且 `currentPrompt()` 非空）→ `scheduleDiaryFlush()`：**fire-and-forget**，API 要几秒，绝不阻塞本轮 |
| **末轮兜底** | `session/flush` 时补写还没写的轮次（你要求"每轮都写"，只靠下一轮会漏掉末轮） |
| **幂等** | 键 = `sessionId#turn`；已写集合从 `auto_diary_log.jsonl` 恢复，重复触发不重写 |
| **输入** | system：撰写规则 + 输出 JSON schema；user：工作区 + 轮次 + **标签候选** + 上一轮完整对话（含工具轨迹）。总量上限 `diaryMaxInputChars`(12000)，超长只截助手正文尾部 |
| **标签候选** | 从全局字典（13938 个）按**相关度**挑，上限 `diaryTagHints`(200)：`candidateTags` 取 24 个高分 gram → 每 gram 内按「精确 > 前缀 > 包含」+ 短标签优先 → 每 gram 取固定配额 |
| **归一化** | 标签不足 5 个用候选补足（保住后端硬规则）；正文 >500 字按句末标点切成多篇、摘要自动加 `（1/2）`；每轮最多 8 篇 |
| **写库** | 匿名 `memory.py write`（零身份），收集 `[OK] Dxxxx` 落 `auto_diary_log.jsonl` |
| **失败** | 落 `pending_diaries.jsonl`；之后每轮补写最多 3 条、单条最多重试 5 次，超限记 warn 后丢弃 |
| **开关** | `~/.dsh/liubian/diary.json`：`{enabled, url, apiKey, model, temperature, maxTokens, jsonMode}`。**默认关**；未配 key 直接静默跳过 |
| **运维** | 工具 `_dsh_external_dsh_liubian_diary`：`status` / `preview`（**预览将发给 API 的完整输入，不调用 API**）/ `run` / `retry` / `enable` / `disable` |

接入卡会写明开关状态（`[自动日记] 已开启 → 不要再手动 write`），技能文档据此分支，避免"自动 + 手动"双写。

> 自检抓到的一个真 bug：标签字典是**按字母序**排的，最初直接遍历取前 200 条 →
> 送去的候选是 `128K上下文 / A1修正版 / ASR后端 / AUC符号修正…` 这类字母序靠前、与本轮毫无关系的标签。
> 改成按相关度取之后，同一段对话的候选变成 `记忆技能 / 技能文档 / 上下文插入 / 插件修复 / 桥接…`。

## 工具映射（9 个 MCP → 16 个原生工具）

| Codex MCP 服务器 | 原工具 | DSH 工具（前缀 `_dsh_external_dsh_liubian_`） |
|---|---|---|
| mcp-memory-core | memory_info / list_tags / get_key / check_inbox / post_message / register_user | `status` / `tags` / `account` / `inbox` / `post` |
| mcp-memory-write | write_diary / write_log | `write`（`kind=diary\|log`） |
| mcp-memory-search | search_diary / read_diary | `search` / `read` |
| mcp-memory-validate | validate_answer | `path2` |
| mcp-memory-panel | open_admin_panel / open_kotatsu_ui | `panel`（`target=admin\|kotatsu`） |
| mcp-kotatsu | join/send/poll/search/todo/diary_mark + watch_start/take/status/stop | `kotatsu`（`action=…`，含 `watch_*`） |
| mcp-update | update_check/list/install/uninstall/sync/snapshot/agents/subscribe/broadcast + read_skill_source / list_skills | `update`（`action=…`） |
| mcp-skill-index | index_skill / index_all_skills / skill_index_status | `skill_index`（`action=index\|all\|status`） |
| mcp-embed-model | 嵌入服务生命周期 | → 已拆到独立插件 `dsh-liubian-embed`（工具名不变） |
| —（liubian.py） | liubian.py status | `status` |
| —（新增，DSH 独有） | 无对应（Codex 侧靠智能体手写） | `diary`：自动日记的查看 / 预览 / 补写 / 开关 |

**全部工具都没有 username / password / key 参数**（相对 Codex 侧 MCP 最主要的简化）。

## 其它移植改动

1. **超长正文走 `--file`**：Windows 命令行上限约 32KB，日记正文很容易超；超过 20KB
   自动落临时文件走 `memory.py --file` 通道，用完即删。
2. **挂机监听改为异步轮询**：Codex 侧监听由 MCP 子进程的守护线程托管，DSH 侧在插件进程内用
   异步 `execFile` 每 N 秒读一次房间（同步调用会卡住宿主 Electron 主进程的事件循环），
   随插件卸载自动收摊。
3. **`status` 的数字是真的**：`liubian.py status` 的日记数按旧的文件模式统计（纯 SQLite
   之后恒为 0），这里额外直读 docs 表给出真实数字。

## 文件结构

```
dsh-liubian/
├─ package.json
├─ lib/
│  ├─ main.mjs      入口壳（name/inject + 带缓存戳的动态导入）
│  └─ impl.mjs      实现主体（单文件：配置 + 子进程桥 + 免密账号 + 挂机监听 + 上下文插入 + 15 个工具）
├─ helper/          插件自带 python 小工具
│  ├─ user_key.py       读某账号最新日记 KEY
│  ├─ room_read.py      读被炉房间新消息（监听轮询源）
│  ├─ registry_stats.py 注册表总览 / 会话卡 / 全局标签字典（--tag-list）
│  └─ skill_index.py    技能 SKILL.md 入语义检索库
├─ skills/          随插件分发的 SKILL.md（启动时同步到 ~/.dsh/skills）
│  ├─ liubian-memory/SKILL.md
│  └─ liubian/SKILL.md
└─ node_modules/@deepseek-ai/dsh-tools   ← junction，见下
```

## 两个安装期约束（踩过的坑）

### 1. 依赖解析需要本插件自己的 `node_modules`

插件装在 `~/.dsh/plugins/dsh-liubian`，解析 `@deepseek-ai/*` 时会从**真实路径**逐级向上找
`node_modules`，到不了 profile 的 `node_modules`，会报
`Cannot find package '@deepseek-ai/dsh-tools'`。因此插件目录里放了一个 junction：

```
node_modules/@deepseek-ai/dsh-tools → C:\Users\Feng\.dsh\profiles\desktop\node_modules\@deepseek-ai\dsh-tools
```

### 2. 入口壳为什么要做缓存戳

Node 按 URL 缓存 ESM 模块，而 DSH 的注入器在本机版本上 `loader.internal` 不可用
（`dev_reload_package` 报错），反注入再注入拿到的仍是旧模块 —— 改了代码不生效
（实测：改完重新注入，日志还是旧版本的字符串）。

所以入口拆两层：`main.mjs` 静态导出 `name`/`inject` 并提供 `apply`，
`apply` 内用 `import('./impl.mjs?t=' + Date.now())` 动态导入实现。
**改 `impl.mjs` 后重新注入即热生效，不需要重启 DSH。**
（只有改 `name`/`inject` 或换 `main.mjs` 本身才需要重启。）

## 配置

默认值写在 `impl.mjs` 的 `DEFAULTS`，可用 `C:\Users\Feng\.dsh\liubian\config.json` 覆盖
（读写都容忍 BOM —— 记事本 / Windows PowerShell 写出来的就是带 BOM 的）。

| 键 | 默认 | 说明 |
|---|---|---|
| `workspace` | `工作组` | `memory.py` 用 cwd 判定工作区 |
| `systemUser` | `玉兰` | 免密系统账号花名（必须是未被占用的花朵名） |
| `autoProvision` | `true` | 账号不存在时自动 `register --free` |
| `installSkills` | `true` | 启动时把自带 SKILL.md 同步到 `~/.dsh/skills` |
| `profileInject` | `true` | 会话启动注入接入卡 |
| `recall` | `true` | 每个新人类输入自动召回一次 |
| `recallTagCount` | `8` | 自动召回挑多少个 tag（<4 则不召回） |
| `recallMaxChars` | `2400` | 召回块最大字数 |
| `recallMinChars` | `8` | 短于此长度的输入不召回 |
| `recallTimeoutMs` | `30000` | 召回检索超时 |
| `profileTokenBudget` | `700` | 接入卡 token 预算（CJK 1.5 token/字） |
| `recallDebug` | `false` | 在日志里打印 pre-step 消息表与选中 tag |

> 向量服务的配置（`embedUrl` / `embedCmd` / `autoEnsureOnLoad` …）现在在
> 独立插件的 `C:\Users\Feng\.dsh\liubian\embed.json` 里，见 `dsh-liubian-embed/README.md`。

## 技能

- `liubian-memory` —— 记忆流程：写日记 → 查留言板 → 检索 → 回答（含四行状态头）、标签策略、
  语义检索、留言板、被炉与挂机监听、通路二、更新。
- `liubian` —— 流变系统总纲：四个子系统 + 15 个工具速查 + 数据位置 + 面板。

插件启动时同步到 `C:\Users\Feng\.dsh\skills\`（内容不同才写）。**新落盘的技能要下一次会话才进技能目录。**
