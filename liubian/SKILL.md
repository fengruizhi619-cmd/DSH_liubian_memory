---
name: liubian
description: >
  流变系统统一技能。统合 记忆 / 被炉 / 更新 / 通路 四个子系统与本地管理面板。
  触发：每轮记忆流程（#m）；技能更新（#update）；复杂问题走通路（分解→检索→通路二→汇聚）；
  管理员使用本地管理面板（liubian_panel_qt.py）。
---

# 流变系统

流变系统 = 智能体基础设施集合体，四个子系统：
- 流变·记忆（memory-skill）：日记/标签/检索/用户/留言板
- 流变·被炉（KOTATSU）：实时聊天室/待办/定时/钩子
- 流变·更新（auto-updater 整合入口）：技能版本/独立装载/快照广播
- 流变·通路：双通路问答（分解→tag检索→通路二外部校验→汇聚）

## 统一 CLI（绝对路径：C:\Users\Feng\.codex\skills\liubian\scripts\liubian.py）
- `python "C:\Users\Feng\.codex\skills\liubian\scripts\liubian.py" status` — 系统总览（用户/日记/被炉房间/技能装载）
- `python "C:\Users\Feng\.codex\skills\liubian\scripts\liubian.py" path "问题" [--out 路径]` — 通路二（初始回答+校验，输出JSON）
- `python "C:\Users\Feng\.codex\skills\liubian\scripts\liubian.py" <旧命令...>` — 透传 memory.py，完全兼容

## 通路二工具（绝对路径：C:\Users\Feng\.codex\skills\liubian\scripts\通路2\liubian_path2.py）
- 调用方式：`python "C:\Users\Feng\.codex\skills\liubian\scripts\通路2\liubian_path2.py" "问题" --out <输出json路径>`
- 两个独立 DeepSeek API（deepseek-v4-flash）：API-A 初始回答（thinking=disabled），API-B 五维度校验（thinking=enabled budget 2048）
- 出参 `{initial_answer, problems[]}`；每次用量写入同目录 usage_log.jsonl
- 一次性无状态产品：不检索记忆、不写日记、不继承上下文
- 密钥配置：`C:\Users\Feng\.codex\skills\liubian\scripts\通路2\config.json`（勿外传）

## 本地管理面板（scripts/liubian_panel_qt.py，PyQt5）
- 主选单：系统用户管理 / 被炉系统 / Skill 管理
- 启动：`python scripts/liubian_panel_qt.py`；打包：`dist/liubian_panel.exe`
- 仅本机真人管理员使用（绑定 127.0.0.1 / 桌面窗口）

## 数据位置
- 全局注册表：E:\DSH_data\.memory_registry（users/message_board/kotatsu_rooms）
- 技能快照：C:\Users\Feng\.codex\skills\.skill_tracker
- 通路二配置/密钥：C:\Users\Feng\.codex\skills\liubian\scripts\通路2\config.json（勿外传）
