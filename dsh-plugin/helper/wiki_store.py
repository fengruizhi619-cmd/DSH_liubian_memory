# -*- coding: utf-8 -*-
"""
流变·记忆 wiki 存储（v0，S1+S2）
================================
条目模型（设计文档：docs/流变记忆wiki化_DSH实施方案.md）：
  条目五要件 = 家族归宿 / 内容介绍 / 正文 / 修订记录（含贡献者）/ 梯度稀释检查点
  森林结构 = 条目可嵌套，家族归宿 = 到根的有序路径（结构化 tag）

存储（全部在 liubian.db，与既有日记库同库不同表，互不干扰）：
  wiki_pages      条目主表（slug 主键 / 家族路径 / 标题 / 简介 / 正文 / 状态 / 修订计数）
  wiki_revisions  修订账目（全量保留：slug+rev 主键，贡献者/动作/摘要/时间）
  wiki_checkpoints 内容快照（梯度稀释槽位，每条目 ≤8 份，时间稀释级联）

调用协议（与 memory_query.py 同款）：stdin 喂 JSON，stdout 吐 JSON。
  {"op":"create","slug":..,"familyPath":..,"title":..,"intro":..,"content":..,"contributor":..}
  {"op":"update","slug":..,"content":..,"intro":?,"title":?,"familyPath":?,"contributor":..,"summary":?}
  {"op":"get","slug":..}
  {"op":"tree"}                          → 森林（根 → 子树计数）
  {"op":"list","familyPrefix":"水果"}     → 该前缀下条目清单
  {"op":"move","slug":..,"newFamilyPath":..}  → 改挂（子树路径批量更新）
  {"op":"rollback","slug":..,"slot":3,"contributor":..}  → 恢复检查点为新修订
"""
import json, sys, os, sqlite3, time

CHECKPOINT_THRESHOLDS_MIN = [5, 10, 30, 60, 360, 720, 1440, 10080]  # 5m/10m/30m/1h/6h/12h/24h/7d
MAX_CHECKPOINTS = len(CHECKPOINT_THRESHOLDS_MIN)  # 8

DDL = [
    """CREATE TABLE IF NOT EXISTS wiki_pages (
        slug TEXT PRIMARY KEY,
        family_path TEXT NOT NULL,
        title TEXT NOT NULL,
        intro TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'stable',
        revisions INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS wiki_revisions (
        slug TEXT NOT NULL,
        rev INTEGER NOT NULL,
        time INTEGER NOT NULL,
        contributor TEXT NOT NULL,
        action TEXT NOT NULL,
        summary TEXT,
        content TEXT NOT NULL,
        PRIMARY KEY (slug, rev))""",
    """CREATE TABLE IF NOT EXISTS wiki_checkpoints (
        slug TEXT NOT NULL,
        slot INTEGER NOT NULL,
        time INTEGER NOT NULL,
        content TEXT NOT NULL,
        PRIMARY KEY (slug, slot))""",
    """CREATE INDEX IF NOT EXISTS idx_wiki_family ON wiki_pages(family_path)""",
]


def out(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False))
    sys.stdout.flush()


def connect():
    db = os.environ.get("LU_DB", "")
    if not db or not os.path.isfile(db):
        out({"ok": False, "error": "liubian.db not found: " + db})
        sys.exit(0)
    conn = sqlite3.connect(db, timeout=20)
    # 幂等建表：wiki 表随首次操作自动初始化（v0 起，旧日记表不受影响）
    for stmt in DDL:
        conn.execute(stmt)
    conn.commit()
    return conn


# ── 梯度稀释检查点：时间稀释保留规则 ─────────────────────────────────────
# 全部候选快照（含刚被替换的旧正文）按时间降序，贪心保留：
#   保留最新一份；此后每份必须与上一份保留快照相距 ≥ 下一档阈值（5m/10m/30m/...）；
#   最多保留 MAX_CHECKPOINTS 份，其余丢弃（这就是"稀释"——存储有界）。
# 密集编辑会在最细档自然塌缩（只留最新一份旧正文）；稀疏编辑的旧状态随编辑推进
# 逐档向粗迁移，年龄跨档前不会被丢。


def retain(snaps_desc, now_ms):
    kept = []
    last_t = None
    for s in snaps_desc:  # 已按 time 降序
        if not kept:
            kept.append(s)
            last_t = s["time"]
            continue
        if len(kept) > MAX_CHECKPOINTS:
            break
        th_min = CHECKPOINT_THRESHOLDS_MIN[len(kept) - 1]
        if last_t - s["time"] >= th_min * 60000:
            kept.append(s)
            last_t = s["time"]
    return kept[:MAX_CHECKPOINTS]


def load_checkpoints(conn, slug):
    rows = conn.execute(
        "SELECT slot, time, content FROM wiki_checkpoints WHERE slug=? ORDER BY time DESC",
        (slug,)).fetchall()
    return [{"time": t, "content": c} for _, t, c in rows]


def save_checkpoints(conn, slug, snaps, now_ms):
    conn.execute("DELETE FROM wiki_checkpoints WHERE slug=?", (slug,))
    for i, s in enumerate(snaps):
        conn.execute(
            "INSERT INTO wiki_checkpoints(slug, slot, time, content) VALUES(?,?,?,?)",
            (slug, i, s["time"], s["content"]))


def on_update_cascade(conn, slug, prev_content, prev_time, now_ms):
    """编辑提交时调用：把被替换的旧正文送入稀释检查点体系。"""
    snaps = load_checkpoints(conn, slug)
    snaps.sort(key=lambda s: -s["time"])
    snaps.insert(0, {"time": prev_time, "content": prev_content})
    kept = retain(snaps, now_ms)
    save_checkpoints(conn, slug, kept, now_ms)


# ── 操作实现 ──────────────────────────────────────────────────────────────

def op_create(conn, req):
    slug = str(req.get("slug") or "").strip()
    family = str(req.get("familyPath") or "").strip().strip("/")
    title = str(req.get("title") or "").strip()
    intro = str(req.get("intro") or "").strip()
    content = str(req.get("content") or "")
    contributor = str(req.get("contributor") or "未知").strip()
    now = int(time.time() * 1000)
    if not slug or "/" in slug:
        return {"ok": False, "error": "slug 必填且不含 /（家族归属用 familyPath 表达）"}
    if not family:
        return {"ok": False, "error": "familyPath 必填（根条目也要有归属，可为自身类别名）"}
    if not title:
        return {"ok": False, "error": "title 必填"}
    dup = conn.execute("SELECT 1 FROM wiki_pages WHERE slug=?", (slug,)).fetchone()
    if dup:
        return {"ok": False, "error": f"slug 已存在: {slug}"}
    conn.execute(
        "INSERT INTO wiki_pages(slug, family_path, title, intro, content, status, revisions, created_at, updated_at)"
        " VALUES(?,?,?,?,?, 'stable', 1, ?, ?)",
        (slug, family, title, intro, content, now, now))
    conn.execute(
        "INSERT INTO wiki_revisions(slug, rev, time, contributor, action, summary, content)"
        " VALUES(?,?,?,?,'create',?,?)",
        (slug, 1, now, contributor, intro or title, content))
    conn.commit()
    return {"ok": True, "slug": slug, "familyPath": family, "rev": 1}


def op_update(conn, req):
    slug = str(req.get("slug") or "").strip()
    row = conn.execute(
        "SELECT content, intro, title, family_path, revisions, updated_at FROM wiki_pages WHERE slug=?",
        (slug,)).fetchone()
    if not row:
        return {"ok": False, "error": "条目不存在: " + slug}
    old_content, old_intro, old_title, old_family, old_revs, old_updated = row
    content = req.get("content")
    new_content = str(content) if content is not None else old_content
    new_intro = str(req["intro"]) if req.get("intro") is not None else old_intro
    new_title = str(req["title"]) if req.get("title") is not None else old_title
    new_family = str(req.get("familyPath") or "").strip().strip("/") or old_family
    contributor = str(req.get("contributor") or "未知").strip()
    summary = str(req.get("summary") or "").strip()
    now = int(time.time() * 1000)
    if new_content == old_content and new_intro == old_intro and new_title == old_title and new_family == old_family:
        return {"ok": True, "slug": slug, "unchanged": True}
    # ① 梯度稀释检查点：旧正文送入时间稀释槽位（级联保留）
    on_update_cascade(conn, slug, old_content, old_updated, now)
    # ② 修订账目（全量）
    new_revs = old_revs + 1
    conn.execute(
        "UPDATE wiki_pages SET content=?, intro=?, title=?, family_path=?, revisions=?, updated_at=? WHERE slug=?",
        (new_content, new_intro, new_title, new_family, new_revs, now, slug))
    conn.execute(
        "INSERT INTO wiki_revisions(slug, rev, time, contributor, action, summary, content)"
        " VALUES(?,?,?,?, 'update', ?, ?)",
        (slug, new_revs, now, contributor, summary, new_content))
    conn.commit()
    return {"ok": True, "slug": slug, "rev": new_revs,
            "checkpoints": load_checkpoints(conn, slug) and
            [{"slot": i, "time": t} for i, t, _ in
             conn.execute("SELECT slot, time, content FROM wiki_checkpoints WHERE slug=?", (slug,)).fetchall()]}


def op_get(conn, req):
    slug = str(req.get("slug") or "").strip()
    row = conn.execute(
        "SELECT slug, family_path, title, intro, content, status, revisions, created_at, updated_at"
        " FROM wiki_pages WHERE slug=?", (slug,)).fetchone()
    if not row:
        return {"ok": False, "error": "条目不存在: " + slug}
    cps = conn.execute(
        "SELECT slot, time FROM wiki_checkpoints WHERE slug=? ORDER BY slot", (slug,)).fetchall()
    revs = conn.execute(
        "SELECT rev, time, contributor, action, summary FROM wiki_revisions WHERE slug=? ORDER BY rev DESC LIMIT 20",
        (slug,)).fetchall()
    children = [r[0] for r in conn.execute(
        "SELECT DISTINCT family_path FROM wiki_pages WHERE family_path LIKE ? AND family_path != ?",
        (row[1] + "/%", row[1] + "/%"))]
    return {"ok": True, "page": {
        "slug": row[0], "familyPath": row[1], "title": row[2], "intro": row[3],
        "content": row[4], "status": row[5], "revisions": row[6],
        "createdAt": row[7], "updatedAt": row[8],
        "childrenPaths": children,
        "checkpoints": [{"slot": s, "time": t} for s, t in cps],
        "recentRevisions": revs,
    }}


def op_tree(conn, req):
    """森林视图：层级由条目之间的前缀链推导——
    若条目 B 的 family_path == 条目 A 的 family_path + '/' + A.slug，则 B 是 A 的子节点。"""
    rows = conn.execute(
        "SELECT slug, family_path, title, intro, status, revisions, updated_at"
        " FROM wiki_pages ORDER BY family_path, slug").fetchall()
    entries = []
    byfull = {}
    for slug, fp, title, intro, status, revs, upd in rows:
        e = {"slug": slug, "familyPath": fp, "title": title, "intro": intro,
             "status": status, "revisions": revs, "updatedAt": upd, "children": []}
        entries.append(e)
        byfull[fp + "/" + slug] = e
    roots = []
    for e in entries:
        parent = byfull.get(e["familyPath"])
        if parent is not None and parent is not e:
            parent["children"].append({"slug": e["slug"], "familyPath": e["familyPath"],
                                       "title": e["title"]})
        else:
            roots.append(e)
    return {"ok": True, "count": len(entries), "roots": [r["slug"] for r in roots],
            "entries": entries}


def op_move(conn, req):
    slug = str(req.get("slug") or "").strip()
    newfp = str(req.get("newFamilyPath") or "").strip().strip("/")
    if not slug or not newfp:
        return {"ok": False, "error": "slug 与 newFamilyPath 必填"}
    oldfp = conn.execute("SELECT family_path FROM wiki_pages WHERE slug=?", (slug,)).fetchone()
    if not oldfp:
        return {"ok": False, "error": "条目不存在: " + slug}
    oldfp = oldfp[0]
    # 子树批量改路径：自身 + 以 oldfp/ 开头的后代
    conn.execute("UPDATE wiki_pages SET family_path=? || substr(family_path, ?) WHERE family_path=? OR family_path LIKE ?",
                 (newfp, len(oldfp) + 1, oldfp, oldfp + "/%"))
    conn.commit()
    moved = conn.execute("SELECT COUNT(*) FROM wiki_pages WHERE family_path=? OR family_path LIKE ?",
                         (newfp, newfp + "/%")).fetchone()[0]
    return {"ok": True, "moved": moved}


def op_rollback(conn, req):
    slug = str(req.get("slug") or "").strip()
    slot = int(req.get("slot", -1))
    contributor = str(req.get("contributor") or "未知").strip()
    now = int(time.time() * 1000)
    snap = conn.execute("SELECT time, content FROM wiki_checkpoints WHERE slug=? AND slot=?",
                        (slug, slot)).fetchone()
    if not snap:
        return {"ok": False, "error": f"检查点不存在: slot={slot}"}
    snap_time, snap_content = snap
    old = conn.execute("SELECT content, updated_at FROM wiki_pages WHERE slug=?", (slug,)).fetchone()
    if not old:
        return {"ok": False, "error": "条目不存在"}
    # 当前内容先进稀释体系（回滚前的现场也要保住）
    on_update_cascade(conn, slug, old[0], old[1], now)
    revs = conn.execute("SELECT revisions FROM wiki_pages WHERE slug=?", (slug,)).fetchone()[0]
    new_revs = revs + 1
    conn.execute(
        "UPDATE wiki_pages SET content=?, revisions=?, updated_at=? WHERE slug=?",
        (snap_content, new_revs, now, slug))
    conn.execute(
        "INSERT INTO wiki_revisions(slug, rev, time, contributor, action, summary, content)"
        " VALUES(?,?,?,?, 'rollback', ?, ?)",
        (slug, new_revs, now, contributor, f"回滚自槽位 {slot}（快照时间 {snap_time}）", snap_content))
    conn.commit()
    return {"ok": True, "slug": slug, "rev": new_revs, "restoredFromSlot": slot}


OPS = {
    "create": op_create,
    "update": op_update,
    "get": op_get,
    "tree": op_tree,
    "move": op_move,
    "rollback": op_rollback,
}


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    raw = sys.stdin.buffer.read().decode("utf-8", "replace")
    try:
        req = json.loads(raw or "{}")
    except Exception as e:
        out({"ok": False, "error": "bad json: %s" % e})
        return
    op = str(req.get("op") or "").strip()
    fn = OPS.get(op)
    if not fn:
        out({"ok": False, "error": f"未知 op: {op}（可选: create/update/get/tree/list/move/rollback）"})
        return
    conn = connect()
    try:
        out(fn(conn, req))
    finally:
        conn.close()


if __name__ == "__main__":
    main()
