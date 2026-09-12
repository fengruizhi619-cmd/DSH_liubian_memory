# -*- coding: utf-8 -*-
"""读被炉房间的新消息（挂机监听的轮询源）。

用法:  python room_read.py <room> [cursor]
环境:  LU_DB / LU_ROOM_DIR / LU_USER
输出:  JSON {"ok":bool,"cursor":int,"messages":[{id,from,time,content,system},...]}

对应 Codex 侧 mcp_kotatsu.py 的 _read_room()：优先 SQLite docs 表
（key = kotatsu_room:<房间>），缺失时回退 kotatsu_rooms/<房间>.json 文件。
cursor<=0 时按该用户 last_seen 起算（无 last_seen 则从最新消息起算），
避免刚上线就把历史消息当新消息刷出来。
"""
import json
import os
import sqlite3
import sys


def read_room(db, room_dir, room):
    if db and os.path.isfile(db):
        try:
            conn = sqlite3.connect(db, timeout=15)
            try:
                row = conn.execute(
                    "SELECT value FROM docs WHERE key=?",
                    ("kotatsu_room:" + room,)).fetchone()
            finally:
                conn.close()
            if row and row[0]:
                return json.loads(row[0])
        except Exception:
            pass
    if room_dir:
        try:
            with open(os.path.join(room_dir, room + ".json"), "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return None
    return None


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    room = sys.argv[1] if len(sys.argv) > 1 else ""
    cursor = 0
    if len(sys.argv) > 2 and sys.argv[2].lstrip("-").isdigit():
        cursor = int(sys.argv[2])
    user = os.environ.get("LU_USER", "")
    data = read_room(os.environ.get("LU_DB", ""), os.environ.get("LU_ROOM_DIR", ""), room)
    if not data:
        print(json.dumps({"ok": False, "error": "room not found: " + room,
                          "cursor": cursor, "messages": []}, ensure_ascii=False))
        return
    msgs = data.get("messages") or []
    if cursor <= 0:
        last_seen = (data.get("last_seen") or {}).get(user, 0) or 0
        newest = max([m.get("id", 0) for m in msgs], default=0)
        cursor = last_seen if last_seen > 0 else newest
    new = [m for m in msgs if m.get("id", 0) > cursor]
    new.sort(key=lambda m: m.get("id", 0))
    if new:
        cursor = max(m.get("id", 0) for m in new)
    out = {
        "ok": True,
        "cursor": cursor,
        "total_messages": len(msgs),
        "last_seen": data.get("last_seen") or {},
        "messages": [{
            "id": m.get("id"),
            "from": m.get("from"),
            "time": m.get("time"),
            "content": m.get("content"),
            "system": bool(m.get("system")),
        } for m in new],
    }
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
