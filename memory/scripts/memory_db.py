# -*- coding: utf-8 -*-
"""记忆系统 SQLite 存储层（liubian.db 文档存储）

核心记忆数据（用户表/留言板/各工作区索引/标签/共现）统一存到 SQLite：
  key = users | board | index:<工作区> | tags:<工作区> | cooccurrence:<工作区>
value 为序列化 JSON，保持与旧 JSON 文件完全相同的数据结构，
使 memory.py 与面板的逻辑无需改动即可切换存储引擎。

并发：WAL 模式 + busy_timeout，解决多智能体并发读写 JSON 文件的损坏问题。
"""
import json
import sqlite3
import struct
from pathlib import Path

DB_PATH = Path(r"E:/DSH_data/.memory_registry/liubian.db")


def db_connect():
    conn = sqlite3.connect(str(DB_PATH), timeout=15)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=8000")
    conn.execute(
        "CREATE TABLE IF NOT EXISTS docs("
        "key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    conn.execute(
        "CREATE TABLE IF NOT EXISTS diary_content("
        "workspace TEXT NOT NULL, diary_id TEXT NOT NULL, "
        "content TEXT NOT NULL, updated TEXT, "
        "PRIMARY KEY(workspace, diary_id))")
    conn.execute(
        "CREATE TABLE IF NOT EXISTS embeddings("
        "workspace TEXT NOT NULL, diary_id TEXT NOT NULL, "
        "vec BLOB NOT NULL, updated TEXT, "
        "PRIMARY KEY(workspace, diary_id))")
    conn.execute(
        "CREATE TABLE IF NOT EXISTS skill_docs("
        "id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, "
        "summary TEXT, fhash TEXT, vec BLOB NOT NULL, updated TEXT)")
    conn.commit()
    return conn


def get_doc(key, default=None):
    try:
        conn = db_connect()
        try:
            row = conn.execute(
                "SELECT value FROM docs WHERE key=?", (key,)).fetchone()
            return json.loads(row[0]) if row else default
        finally:
            conn.close()
    except Exception:
        return default


def set_doc(key, value):
    conn = db_connect()
    try:
        conn.execute(
            "INSERT INTO docs(key,value) VALUES(?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, json.dumps(value, ensure_ascii=False)))
        conn.commit()
    finally:
        conn.close()


def keys_with_prefix(prefix):
    try:
        conn = db_connect()
        try:
            rows = conn.execute(
                "SELECT key FROM docs WHERE key LIKE ?", (prefix + "%",)).fetchall()
            return [r[0] for r in rows]
        finally:
            conn.close()
    except Exception:
        return []


# ---------- 便捷访问（与旧 JSON 结构一致） ----------

def set_diary_content(ws, diary_id, content):
    conn = db_connect()
    try:
        conn.execute(
            "INSERT INTO diary_content(workspace, diary_id, content, updated) "
            "VALUES(?,?,?,?) ON CONFLICT(workspace, diary_id) "
            "DO UPDATE SET content=excluded.content, updated=excluded.updated",
            (ws, diary_id, content, _now()))
        conn.commit()
    finally:
        conn.close()


def get_diary_content(ws, diary_id):
    try:
        conn = db_connect()
        try:
            row = conn.execute(
                "SELECT content FROM diary_content WHERE workspace=? AND diary_id=?",
                (ws, diary_id)).fetchone()
            return row[0] if row else None
        finally:
            conn.close()
    except Exception:
        return None


def get_all_diary_ids(ws):
    """当前工作区所有有正文的日记 id（语义索引的候选全集）"""
    try:
        conn = db_connect()
        try:
            rows = conn.execute(
                "SELECT DISTINCT diary_id FROM diary_content WHERE workspace=?",
                (ws,)).fetchall()
            return [r[0] for r in rows]
        finally:
            conn.close()
    except Exception:
        return []


# ---------- 语义向量 ----------

def set_embedding(ws, diary_id, vec):
    """写入向量（float32 BLOB），减少 JSON 膨胀"""
    conn = db_connect()
    try:
        blob = struct.pack("<%df" % len(vec), *vec)
        conn.execute(
            "INSERT INTO embeddings(workspace, diary_id, vec, updated) "
            "VALUES(?,?,?,?) ON CONFLICT(workspace, diary_id) "
            "DO UPDATE SET vec=excluded.vec, updated=excluded.updated",
            (ws, diary_id, blob, _now()))
        conn.commit()
    finally:
        conn.close()


def count_embeddings(ws):
    try:
        conn = db_connect()
        try:
            return conn.execute(
                "SELECT COUNT(*) FROM embeddings WHERE workspace=?",
                (ws,)).fetchone()[0]
        finally:
            conn.close()
    except Exception:
        return 0


def get_embedding_ids(ws):
    try:
        conn = db_connect()
        try:
            rows = conn.execute(
                "SELECT diary_id FROM embeddings WHERE workspace=?",
                (ws,)).fetchall()
            return [r[0] for r in rows]
        finally:
            conn.close()
    except Exception:
        return []


def get_all_embeddings(ws):
    """返回 [(diary_id, vec_blob), ...]"""
    try:
        conn = db_connect()
        try:
            rows = conn.execute(
                "SELECT diary_id, vec FROM embeddings WHERE workspace=?",
                (ws,)).fetchall()
            return [(r[0], r[1]) for r in rows]
        finally:
            conn.close()
    except Exception:
        return []


def upsert_skill_doc(did, name, path, summary, fhash, vec):
    """写入技能风格包/蒸馏文档向量"""
    conn = db_connect()
    try:
        blob = struct.pack("<%df" % len(vec), *vec)
        conn.execute(
            "INSERT INTO skill_docs(id,name,path,summary,fhash,vec,updated) "
            "VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET "
            "name=excluded.name, path=excluded.path, summary=excluded.summary, "
            "fhash=excluded.fhash, vec=excluded.vec, updated=excluded.updated",
            (did, name, path, summary, fhash, blob, _now()))
        conn.commit()
    finally:
        conn.close()


def get_skill_docs():
    """返回 [(id, name, path, summary, vec_blob), ...]"""
    try:
        conn = db_connect()
        try:
            rows = conn.execute(
                "SELECT id,name,path,summary,vec FROM skill_docs").fetchall()
            return [(r[0], r[1], r[2], r[3], r[4]) for r in rows]
        finally:
            conn.close()
    except Exception:
        return []


def get_skill_doc_ids():
    try:
        conn = db_connect()
        try:
            return {r[0] for r in conn.execute("SELECT id FROM skill_docs")}
        finally:
            conn.close()
    except Exception:
        return set()


def get_skill_doc_hash(did):
    try:
        conn = db_connect()
        try:
            row = conn.execute(
                "SELECT fhash FROM skill_docs WHERE id=?", (did,)).fetchone()
            return row[0] if row else None
        finally:
            conn.close()
    except Exception:
        return None


def remove_stale_skill_docs(valid_ids):
    conn = db_connect()
    try:
        if not valid_ids:
            conn.execute("DELETE FROM skill_docs")
        else:
            marks = ",".join("?" * len(valid_ids))
            conn.execute(
                "DELETE FROM skill_docs WHERE id NOT IN (%s)" % marks,
                tuple(valid_ids))
        conn.commit()
    finally:
        conn.close()


def _now():
    import datetime
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def list_workspaces():
    """从数据库返回存在记忆索引的工作区列表"""
    return sorted(k[len("index:"):] for k in keys_with_prefix("index:"))


def get_users():
    return get_doc("users", {"users": {}})


def save_users(data):
    set_doc("users", data)


def get_board():
    return get_doc("board", {"messages": []})


def save_board(data):
    set_doc("board", data)


def get_workspace_index(ws):
    return get_doc("index:" + ws, {"index": {}})


def save_workspace_index(ws, data):
    set_doc("index:" + ws, data)


def get_workspace_tags(ws):
    return get_doc("tags:" + ws, {"tags": {}})


def save_workspace_tags(ws, data):
    set_doc("tags:" + ws, data)


def get_workspace_cooccurrence(ws):
    return get_doc("cooccurrence:" + ws, {})


def save_workspace_cooccurrence(ws, data):
    set_doc("cooccurrence:" + ws, data)


# ---------- 全局检索（跨工作区，2026-09-07） ----------

def get_workspace_index_all():
    """返回 {工作区: {tag: [entry,...]}} —— 全部工作区 tag 索引并集"""
    out = {}
    for ws in list_workspaces():
        idx = get_workspace_index(ws).get("index", {})
        if idx:
            out[ws] = idx
    return out


def get_workspace_tags_all():
    """合并全部工作区标签字典：{tags: {tag: {count: 总和, created: 最早}}}"""
    merged = {"tags": {}}
    for ws in list_workspaces():
        for tag, info in (get_workspace_tags(ws).get("tags", {}) or {}).items():
            cur = merged["tags"].setdefault(tag, {"count": 0, "created": ""})
            cur["count"] += int(info.get("count", 0) or 0)
            if not cur["created"]:
                cur["created"] = info.get("created", "")
    return merged


def get_cooccurrence_all():
    """合并全部工作区共现表（count 跨区求和后重算 weight）"""
    tag_total = {}
    pairs = {}
    for ws in list_workspaces():
        d = get_workspace_cooccurrence(ws) or {}
        for t, n in (d.get("tag_total", {}) or {}).items():
            tag_total[t] = tag_total.get(t, 0) + int(n or 0)
        for tag, rels in (d.get("cooccurrence_weighted", {}) or {}).items():
            for r in rels:
                key2 = "\x01".join(sorted([tag, r.get("tag", "")]))
                if key2:
                    pairs[key2] = pairs.get(key2, 0) + int(r.get("count", 0) or 0)
    co = {}
    for key2, cnt in pairs.items():
        a, b = key2.split("\x01", 1)
        co.setdefault(a, []).append((b, cnt))
        co.setdefault(b, []).append((a, cnt))
    weighted = {}
    for tag, rels in co.items():
        total = tag_total.get(tag, 1) or 1
        ranked = [{"tag": rt, "count": c, "weight": round(c / total, 3)} for rt, c in rels]
        ranked.sort(key=lambda x: -x["weight"])
        weighted[tag] = ranked[:10]
    return {"tag_total": tag_total, "cooccurrence_weighted": weighted}


def find_diary_workspaces(diary_id):
    """返回包含该日记 id 的全部工作区列表"""
    try:
        conn = db_connect()
        try:
            rows = conn.execute(
                "SELECT DISTINCT workspace FROM diary_content WHERE diary_id=?",
                (diary_id,)).fetchall()
            return [r[0] for r in rows]
        finally:
            conn.close()
    except Exception:
        return []


def get_embedding_rows_all():
    """全库向量：[(workspace, diary_id, vec_blob), ...]"""
    try:
        conn = db_connect()
        try:
            return conn.execute(
                "SELECT workspace, diary_id, vec FROM embeddings").fetchall()
        finally:
            conn.close()
    except Exception:
        return []


def count_embeddings_all():
    try:
        conn = db_connect()
        try:
            return conn.execute("SELECT COUNT(*) FROM embeddings").fetchone()[0]
        finally:
            conn.close()
    except Exception:
        return 0
