# -*- coding: utf-8 -*-
"""读某用户的最新日记 KEY（search / inbox 登录用）。

用法:  python user_key.py <username>
环境:  LU_DB = liubian.db 路径
输出:  KEY（无则空行）

对应 Codex 侧 mcp_memory.py 的 _latest_key()，但改读 memory.py 真正使用的
users 文档（memory.get_user_key 从 USERS_FILE 读，也就是 docs['users']）。
"""
import json
import os
import sqlite3
import sys


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    db = os.environ.get("LU_DB", "")
    user = sys.argv[1] if len(sys.argv) > 1 else ""
    key = ""
    if db and user and os.path.isfile(db):
        try:
            conn = sqlite3.connect(db, timeout=15)
            try:
                row = conn.execute("SELECT value FROM docs WHERE key='users'").fetchone()
            finally:
                conn.close()
            if row and row[0]:
                users = (json.loads(row[0]).get("users") or {})
                key = ((users.get(user) or {}).get("last_key") or "")
        except Exception:
            key = ""
    print(key)


if __name__ == "__main__":
    main()
