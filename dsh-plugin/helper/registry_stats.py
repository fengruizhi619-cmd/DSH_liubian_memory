# -*- coding: utf-8 -*-
"""流变注册表总览 / 身份卡 / 标签字典。

用法:
  python registry_stats.py                  # 注册表总览（status 工具用）
  python registry_stats.py <username>       # 总览 + 该用户身份卡（会话启动上下文用）
  python registry_stats.py --tag-list       # 全局标签名 JSON 数组（自动召回选 tag 用）

环境:  LU_DB = liubian.db 路径
输出:  JSON

Codex 侧 `liubian.py status` 的日记数是按旧的 `<cwd>/memory/diaries/*.md`
统计的（纯 SQLite 之后恒为 0），这里改为直读 docs 表，数字才是真的。
"""
import json
import os
import sqlite3
import sys


def _load_docs(db):
    conn = sqlite3.connect(db, timeout=15)
    try:
        return conn.execute("SELECT key, value FROM docs").fetchall()
    finally:
        conn.close()


def _collect(rows):
    """把 docs 拆成 用户 / 工作区索引 / 房间 / 技能装载 四类。"""
    users, workspaces, rooms, agents = {}, {}, [], []
    entries = []
    for key, value in rows:
        try:
            if key == "users":
                users = json.loads(value).get("users") or {}
            elif key.startswith("index:"):
                ws = key.split(":", 1)[1]
                idx = json.loads(value).get("index") or {}
                workspaces[ws] = {"tags": len(idx), "entries": sum(len(v) for v in idx.values())}
                for tag, items in idx.items():
                    for e in items:
                        entries.append((ws, tag, e))
            elif key.startswith("kotatsu_room:"):
                rooms.append(key.split(":", 1)[1])
            elif key.startswith("agent_versions:"):
                agents.append(key.split(":", 1)[1])
        except Exception:
            continue
    return users, workspaces, rooms, agents, entries


def _board(rows):
    for key, value in rows:
        if key == "board":
            try:
                return json.loads(value)
            except Exception:
                return {}
    return {}


def _card(users, entries, board, username):
    """会话启动注入的「记忆停在哪 / 有没有人找我」两块信息。

    DSH 侧的日记是匿名写的（不带 -u），所以「最近一篇」按全局最新算，不按用户过滤；
    未读留言仍按系统账号统计（留言板本来就是按收件人区分）。
    """
    import datetime
    me = users.get(username) or {}

    messages = board.get("messages") or []
    mine = [m for m in messages if m.get("to") == username]
    unread = [m for m in mine if not m.get("read")]

    newest = None
    for ws, tag, e in entries:
        if newest is None or (str(e.get("date", "")), str(e.get("id", ""))) > (
                str(newest[2].get("date", "")), str(newest[2].get("id", ""))):
            newest = (ws, tag, e)

    card = {
        "user": username,
        "registered": me.get("created") or "",
        "home": me.get("home") or "",
        "key_ready": bool(me.get("last_key")),
        "unread": len(unread),
        "total_messages": len(mine),
        "today": datetime.date.today().isoformat(),
    }
    if newest:
        ws, tag, e = newest
        card["last_diary"] = {
            "id": e.get("id", ""),
            "workspace": ws,
            "date": e.get("date", ""),
            "summary": e.get("summary", ""),
            "user": e.get("user", "") or "(匿名)",
        }
    return card


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    db = os.environ.get("LU_DB", "")
    if not db or not os.path.isfile(db):
        print(json.dumps({"error": "liubian.db not found: " + db}, ensure_ascii=False))
        return

    args = [a for a in sys.argv[1:] if a.strip()]
    try:
        rows = _load_docs(db)
    except Exception as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False))
        return

    users, workspaces, rooms, agents, entries = _collect(rows)

    # 模式一：全局标签字典（自动召回挑 tag 用 + 自动日记把全表送进外部 API）
    #   输出 {"names": [...], "counts": [...]}，**按使用次数降序**。
    #   排序是给日记用的：全表送过去时万一日后需要截断，先丢冷门标签而不是字母序靠前的。
    if "--tag-list" in args:
        freq = {}
        for _ws, t, _e in entries:
            freq[t] = freq.get(t, 0) + 1
        names = sorted(freq, key=lambda t: (-freq[t], t))
        print(json.dumps({"names": names, "counts": [freq[t] for t in names]}, ensure_ascii=False))
        return

    # 模式二：总览（可选带用户名 → 追加身份卡）
    username = next((a for a in args if not a.startswith("-")), "")
    out = {
        "db": db,
        "doc_count": len(rows),
        "user_count": len(users),
        "users": sorted(users.keys()),
        "workspace_count": len(workspaces),
        "workspaces": workspaces,
        "tag_entries": sum(w["entries"] for w in workspaces.values()),
        "tag_names": len({t for _ws, t, _e in entries}),
        "kotatsu_rooms": sorted(rooms),
        "agents_with_skills": sorted(agents),
    }
    if username:
        out["card"] = _card(users, entries, _board(rows), username)
    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
