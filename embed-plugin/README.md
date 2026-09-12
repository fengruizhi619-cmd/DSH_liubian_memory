# dsh-liubian-embed · 本地语义向量服务

llama.cpp `llama-server` + **Qwen3-Embedding-0.6B**（端口 8082）的独立管理插件。
从 `dsh-liubian` 里拆出来 —— 向量服务是**通用能力**，不属于记忆系统；拆开后改向量服务
不用动记忆插件，反之亦然。

## 职责（只管这一件事）

| 能力 | 说明 |
|---|---|
| 探活 | `GET {embedUrl}/health` |
| 拉起 | 无窗口后台**直接起 `llama-server.exe`**，不阻塞 |
| 等待就绪 | `ensure` 会轮询到模型加载完（上限 `readyTimeoutMs`） |
| 关停 | 按端口找 LISTENING 的 PID → `taskkill /T /F`，用来**释放显存** |
| 加载时自动带起 | 插件 apply 时探活一次，离线就后台拉起 |

> **没有定时保活**：只有「插件加载时探活一次」+「显式 `ensure`/`restart`」会拉起服务。
> 所以正常运行时不会周期性动作、也不会周期性闪窗。

### 为什么改成了"直起 exe"（2026-09-12 修黑框）

原来由 `cmd.exe /c start_emb.cmd` 拉起，脚本里是 `start "" /b llama-server.exe …`。
**`start /b` 在"没有控制台可继承"时会新建一个控制台并把窗口显示出来** —— 那一跳发生在
cmd 内部，Node 的 `windowsHide` 管不住。实测证据：窗口枚举里长期存在
`VISIBLE E:\llama.cpp\llama-server.exe`；对照实验也显示 `cmd /c` + `detached` 会出
VISIBLE 窗口，而 `CREATE_NO_WINDOW`（即现在的 `windowsHide: true`，且**不**带 detached）不会。

现在的做法：直接 `spawn(serverExe, serverArgs, { stdio:'ignore', windowsHide:true })`，
**不 detached**（detached 会被 Node 升级成 `CREATE_NEW_CONSOLE`，窗口照样冒出来）。

## 工具

`_dsh_external_dsh_liubian_embed`（名字与拆分前一致，技能与肌肉记忆都不用改）

| action | 作用 |
|---|---|
| `status` | 探活 + 端口/PID + 启动方式/配置文件位置 |
| `ensure` | 拉起并等待就绪 |
| `stop` | 关停并释放显存 |
| `restart` | 关停 → 拉起 → 等就绪 |

## 检索侧怎么用它（解耦点）

记忆插件**不调用本插件**，只依赖一条约定：**HTTP 调不到就回退纯 tag**。
所以本插件没装、没跑、挂了，检索都照常工作，只是少了语义融合那一半权重：

- 融合公式（在 `memory.py` / `semantic_search.py` 里）：`0.5 × tag命中率 + 0.5 × 语义余弦`
- 服务在线时输出 `语义检索: 已启用(向量 n 篇, 融合 tag+语义)`
- 服务离线时输出 `语义检索: 不可用(回退纯tag)`

## 配置

`C:\Users\Feng\.dsh\liubian\embed.json`（读写都容忍 BOM）：

| 键 | 默认 | 说明 |
|---|---|---|
| `embedUrl` | `http://127.0.0.1:8082` | 服务地址 |
| `embedPort` | `8082` | 用于找 PID / 关停 |
| `launchViaCmd` | `false` | **`false`=直起 exe（无窗，推荐）**；`true`=走 `embedCmd`（会闪黑框） |
| `serverExe` | `E:/llama.cpp/llama-server.exe` | 直起方式的可执行文件 |
| `serverArgs` | `['-m', …, '-c','8192','-ngl','99','--embeddings']` | 直起方式的参数（数组） |
| `serverCwd` | `E:/llama.cpp` | 工作目录 |
| `embedCmd` | `E:/llama.cpp/start_emb.cmd` | 仅 `launchViaCmd=true` 时用（备用路径） |
| `autoEnsureOnLoad` | `true` | 插件加载时探活并带起服务 |
| `readyTimeoutMs` | `45000` | `ensure` 等待就绪的上限 |
| `probeTimeoutMs` | `3000` | 单次探活超时 |

等价的服务启动命令（直起方式就是这条，不经 cmd）：

```
E:\llama.cpp\llama-server.exe -m E:\llama.cpp\models\qwen3-emb\Qwen3-Embedding-0.6B-Q8_0.gguf \
  --host 127.0.0.1 --port 8082 -c 8192 -ngl 99 --embeddings
```

> ⚠️ `E:\llama.cpp\start_emb.cmd` 是**共用文件**（Codex 侧的 memory-skill 也在用），
> 本插件**没有改它**。如果你看到黑框来自 Codex 侧那条链路，那是同一个 `start /b` 成因，
> 但修它属于 Codex 侧的事。

## 安装期注意

和 `dsh-liubian` 一样两个约束：

1. 插件目录内需要 junction `node_modules/@deepseek-ai/dsh-tools` → profile 的同名包，
   否则从真实路径解析不到宿主依赖。
2. 入口 `main.mjs` 只是壳，实现在 `impl.mjs`，用 `?t=<时间戳>` 动态导入绕过 ESM 缓存 ——
   **改 `impl.mjs` 重新注入即热生效，不用重启 DSH**。
