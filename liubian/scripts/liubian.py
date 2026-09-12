# -*- coding: utf-8 -*-
"""
liubian.py — 流变系统统一 CLI

整合四个子系统：
  - 流变·记忆 / 流变·被炉 / 流变·更新  → 透传给 memory-skill 的 memory.py（旧命令完全兼容）
  - 流变·通路  → 新命令 path，调用通路二工具 liubian_path2.py

用法：
  python liubian.py status                     # 系统总览
  python liubian.py path "问题" [--out 路径]    # 通路二：初始回答 + 校验
  python liubian.py <任意旧命令...>             # 透传给 memory.py（write/search/kotatsu/update 等）

迁移原则：旧命令全部保持兼容，不做破坏性更名。
"""

import json
import subprocess
import sys
from pathlib import Path

MEMORY_PY = Path(r"C:\Users\Feng\.codex\skills\memory-skill\scripts\memory.py")
import sys as _sys
_sys.path.insert(0, r"C:\Users\Feng\.codex\skills\memory-skill\scripts")
import memory_db as _mdb
PATH2_PY = Path(__file__).resolve().parent / "通路2" / "liubian_path2.py"
REGISTRY = Path(r"E:\DSH_data\.memory_registry")
TRACKER_DIR = Path(r"C:\Users\Feng\.codex\skills\.skill_tracker")

HELP = """流变系统统一 CLI
  流变·通路:
    python liubian.py path "问题" [--out 路径]   调用通路二（初始回答+校验），输出 JSON
  系统总览:
    python liubian.py status                      汇总用户/日记/被炉房间/技能装载情况
  旧命令（透传 memory.py，完全兼容）:
    write / search / inbox / post / tags / read / info / use / register /
    rename / delete-user / msg-read / kotatsu ... / update ... / #m ...
"""


def run_python(script, args):
    cmd = [sys.executable, "-X", "utf8", str(script)] + args
    return subprocess.call(cmd)


def cmd_status():
    info = {}
    # 用户
    try:
        users = _mdb.get_users().get("users", {})
        info["users"] = {"total": len(users), "names": sorted(users.keys())}
    except Exception as e:
        info["users"] = {"error": str(e)}
    # 日记（当前工作区）
    cwd_mem = Path.cwd() / "memory"
    try:
        n = len(list((cwd_mem / "diaries").glob("D*.md")))
        info["diaries"] = {"workspace": Path.cwd().name, "total": n}
    except Exception as e:
        info["diaries"] = {"error": str(e)}
    # 被炉房间
    try:
        rooms = [f.stem for f in (REGISTRY / "kotatsu_rooms").glob("*.json")]
        info["kotatsu_rooms"] = rooms
    except Exception as e:
        info["kotatsu_rooms"] = {"error": str(e)}
    # 技能装载
    try:
        av = [k.split(":", 1)[1] for k in _mdb.keys_with_prefix("agent_versions:")]
        info["agents_with_skills"] = sorted(av)
    except Exception as e:
        info["agents_with_skills"] = {"error": str(e)}
    print(json.dumps(info, ensure_ascii=False, indent=2))


def main():
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help", "help"):
        print(HELP)
        return 0
    cmd = args[0]
    if cmd == "path":
        return run_python(PATH2_PY, args[1:])
    if cmd == "status":
        cmd_status()
        return 0
    # 其余全部透传 memory.py，保证旧命令兼容
    return run_python(MEMORY_PY, args)


if __name__ == "__main__":
    sys.exit(main())
