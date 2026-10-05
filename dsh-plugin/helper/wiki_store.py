# -*- coding: utf-8 -*-
"""
流变·记忆 wiki 存储（v0.2，S1+S2 + 银杏审读修订）
================================================
条目模型（设计文档：docs/流变记忆wiki化_DSH实施方案.md v0.2）：
  条目五要件 = 家族归宿 / 内容介绍 / 正文 / 修订记录（含贡献者）/ 梯度稀释检查点
  森林结构 = 条目可嵌套，家族归宿 = 到根的有序路径（结构化 tag）

家族规则 v0.2（银杏审读定稿）：
  · 物化全路径列 full_path：根条目（familyPath == slug）full = slug，子条目 full = 父full + '/' + slug
  · 层级/子树查询全部走 full_path（= 等于父full 为直系子；LIKE 父full/% 为子树）
  · **slug 不可变**（v0）：改标题/内容用 update；改名+级联列 v1
  · status 词表：draft（整理中）/ stable（定稿）/ obsolete（废弃）
  · move = 改挂（子树批量跟随，逐条记修订）

调用协议（与 memory_query.py 同款）：stdin 喂 JSON，stdout 吐 JSON。
  {"op":"create","slug":..,"familyPath":..,"title":..,"intro":..,"content":..,"status":..,
   "sessionHash":..,"workspace":..,"sourceContributor":?}
  {"op":"update","slug":..,"content":?,"intro":?,"title":?,"status":?,"summary":?,同上三键}
  {"op":"get","slug":..}
  {"op":"tree"}                                   → 森林（roots/orphans/children 平面清单）
  {"op":"list","familyPrefix":"自然/水果"}          → 子树清单
  {"op":"move","slug":..,"newFamilyPath":..,同上三键}  → 改挂（目标家族须已存在）
  {"op":"rollback","slug":..,"time":..,同上三键}       → 按时间定位检查点恢复

归因（〈升格流落树约定〉规则 7，2026-10-01 定稿）：
  · 执行者 executor 由 `sessionHash` 查注册中心 bindings 派生，**不可由传参覆盖**；
    未命中 / 无会话 / 注册中心离线 → 回退 `workspace` 并标 workspace-fallback（summary 自动标注）；
  · 内容来源者 sourceContributor 显式可选（旧键 `contributor` 保留为别名）；
  · 两者落库为独立列；legacy `contributor` 列老行冻结、新行写执行者作兼容镜像。
"""
import json, sys, os, sqlite3, time, unicodedata, hashlib

CHECKPOINT_THRESHOLDS_MIN = [5, 10, 30, 60, 360, 720, 1440, 10080]  # 5m/10m/30m/1h/6h/12h/24h/7d
MAX_CHECKPOINTS = len(CHECKPOINT_THRESHOLDS_MIN)  # 8
STATUSES = ("draft", "stable", "obsolete")
REGISTRY_DB = os.path.expanduser("~/.dsh/liubian-infra/registry.db")

_registry_cache = None

def resolve_contributor(name):
    """独特名解析：查注册中心拿短ID，格式「名字 #短ID」。注册中心离线或查不到 → 原样返回。"""
    global _registry_cache
    if _registry_cache is None:
        _registry_cache = {}
        try:
            rc = sqlite3.connect(f"file:{REGISTRY_DB}?mode=ro", uri=True, timeout=5)
            for row in rc.execute("SELECT name, short_id FROM identities"):
                _registry_cache[row[0]] = row[1]
            rc.close()
        except Exception:
            pass  # 注册中心离线 → 空缓存，降级原样返回
    sid = _registry_cache.get(name)
    if sid:
        return f"{name} #{sid}"
    return name


_binding_cache = None


def _bindings():
    """只读注册中心 bindings 表：session_hash → name。
    与基建 v0.2 的 bindings 表同源（契约 v1 §3 只读 URI、§5.1 会话哈希派生同源）。
    注册中心离线/表不存在 → 空缓存，调用方走工作区兜底。"""
    global _binding_cache
    if _binding_cache is None:
        _binding_cache = {}
        try:
            rc = sqlite3.connect(f"file:{REGISTRY_DB}?mode=ro", uri=True, timeout=5)
            for row in rc.execute("SELECT session_hash, name FROM bindings"):
                _binding_cache[row[0]] = row[1]
            rc.close()
        except Exception:
            pass
    return _binding_cache


def resolve_executor(session_hash, workspace):
    """执行者两级解析（〈升格流落树约定〉规则 7 定稿，2026-10-01）：
      ① 会话哈希命中注册中心绑定 → 用该名字，标记 binding；
      ② 未命中 / 无会话上下文 / 注册中心离线 → 回退工作区名，标记 workspace-fallback。
    **执行者不可由显式传参覆盖**——冒名在结构上不可能（银杏 #12 加固）。
    返回 (格式化执行者, 三态标记)。"""
    sh = str(session_hash or "").strip()
    if sh:
        name = _bindings().get(sh)
        if name:
            return resolve_contributor(name), "binding"
    return resolve_contributor(str(workspace or "").strip() or "未知"), "workspace-fallback"


FALLBACK_NOTE = "贡献者按工作区兜底"


def annotate_fallback(summary, resolved):
    """兜底归因要在账目上自己标出来（玉簪提的：可疑归因不能长得像正常归因）。
    只在 workspace-fallback 时追加，且幂等——不重复叠加。"""
    s = str(summary or "").strip()
    if resolved != "workspace-fallback":
        return s
    if FALLBACK_NOTE in s:
        return s
    return (s + "｜" + FALLBACK_NOTE) if s else FALLBACK_NOTE


def attribution(req):
    """归因三件套：执行者（会话派生，不可覆盖）/ 三态标记 / 内容来源者（显式可选）。
    工具参数 `contributor` 保留为 source_contributor 的**别名**（不破坏既有调用形态）。"""
    executor, marker = resolve_executor(req.get("sessionHash"), req.get("workspace"))
    raw_source = str(req.get("sourceContributor") or req.get("contributor") or "").strip()
    source = resolve_contributor(raw_source) if raw_source else ""
    return executor, marker, source

DDL = [
    """CREATE TABLE IF NOT EXISTS wiki_pages (
        slug TEXT PRIMARY KEY,
        family_path TEXT NOT NULL,
        full_path TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        intro TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
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
    """CREATE INDEX IF NOT EXISTS idx_wiki_full ON wiki_pages(full_path)""",
]

# 归因二分（规则 7）：贡献者/执行者拆列，**加法式迁移**——老行原样冻结、不重写不删。
# legacy `contributor` 列保持 NOT NULL：新行写执行者作兼容镜像（未升级的读取方仍能读到人）。
REVISION_OPT_COLUMNS = (("executor", "TEXT"), ("source_contributor", "TEXT"), ("executor_resolved", "TEXT"))
_REV_COLS = None


def revision_columns(conn):
    """wiki_revisions 的实际列集合（进程内缓存；迁移失败也能安全降级到老列写入）。"""
    global _REV_COLS
    if _REV_COLS is None:
        _REV_COLS = {r[1] for r in conn.execute("PRAGMA table_info(wiki_revisions)")}
    return _REV_COLS


def ensure_revision_columns(conn):
    """幂等加法迁移：缺列就补。失败只警告不阻断（写入侧会按实际列自适应）。"""
    for name, typ in REVISION_OPT_COLUMNS:
        if name not in revision_columns(conn):
            try:
                conn.execute(f"ALTER TABLE wiki_revisions ADD COLUMN {name} {typ}")
                _REV_COLS.add(name)
            except Exception as e:
                sys.stderr.write(f"[wiki_store] 列迁移失败 {name}: {e}\n")


def out(obj):
    # default=str：任何漏网的非序列化对象（如 Row）降级为字符串，不让整个工具调用炸掉
    sys.stdout.write(json.dumps(obj, ensure_ascii=False, default=str))
    sys.stdout.flush()


def connect():
    db = os.environ.get("LU_DB", "")
    if not db or not os.path.isfile(db):
        out({"ok": False, "error": "liubian.db not found: " + db})
        sys.exit(0)
    conn = sqlite3.connect(db, timeout=20)
    conn.row_factory = sqlite3.Row  # 命名访问——杜绝列序错位（v0.2.2 注入块字段错位教训）
    for stmt in DDL:  # 幂等建表
        conn.execute(stmt)
    ensure_revision_columns(conn)  # 幂等加法迁移（归因二分）
    conn.commit()
    return conn


def full_of(family, slug):
    """全路径：根条目（familyPath == slug）full = slug，不重复拼接（银杏审读①）。"""
    return slug if family == slug else family + "/" + slug


# ── 梯度稀释检查点：时间稀释保留规则 ─────────────────────────────────────
# 全部候选快照（含刚被替换的旧正文）按时间降序，贪心保留：
#   保留最新一份；此后每份必须与上一份保留快照相距 ≥ 下一档阈值（5m/10m/30m/...）；
#   最多保留 MAX_CHECKPOINTS 份，其余丢弃（稀释 = 存储有界）。


def retain(snaps_desc):
    kept = []
    last_t = None
    for s in snaps_desc:
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


def save_checkpoints(conn, slug, kept):
    conn.execute("DELETE FROM wiki_checkpoints WHERE slug=?", (slug,))
    for i, s in enumerate(kept):
        conn.execute(
            "INSERT INTO wiki_checkpoints(slug, slot, time, content) VALUES(?,?,?,?)",
            (slug, i, s["time"], s["content"]))


def on_update_cascade(conn, slug, prev_content, prev_time, now_ms):
    """编辑提交时调用：把被替换的旧正文送入稀释检查点体系。"""
    snaps = load_checkpoints(conn, slug)
    snaps.sort(key=lambda s: -s["time"])
    if snaps and snaps[0]["content"] == prev_content:
        return  # 内容没变不重复入槽
    snaps.insert(0, {"time": prev_time, "content": prev_content})
    kept = retain(snaps)
    save_checkpoints(conn, slug, kept)


def log_revision(conn, slug, rev, now, executor, action, summary, content,
                 executor_resolved="", source_contributor=""):
    """写修订账目。归因二分（〈升格流落树约定〉规则 7）：
      · executor —— 永远由调用会话绑定派生（resolve_executor），**不可覆盖**；
      · source_contributor —— 显式可选（升格流原作者/被引用者），可空；
      · legacy `contributor` 列 —— 老行原样冻结；**新行写执行者作兼容镜像**，
        免得未升级的读取方读到空白（语义边界见规则 7，逐行判读、不做自动回填）。
    按实际列自适应：迁移失败或旧库也能写入（少写可选列，不报错）。"""
    fields = {
        "slug": slug, "rev": rev, "time": now,
        "contributor": executor,                      # legacy 兼容镜像
        "executor": executor,
        "source_contributor": source_contributor or None,
        "executor_resolved": executor_resolved or None,
        "action": action, "summary": summary, "content": content,
    }
    base = ("slug", "rev", "time", "contributor", "action", "summary", "content")
    have = revision_columns(conn)
    names = list(base) + [c for c, _ in REVISION_OPT_COLUMNS if c in have]
    conn.execute(
        "INSERT INTO wiki_revisions(%s) VALUES(%s)" % (",".join(names), ",".join("?" * len(names))),
        tuple(fields[n] for n in names))


def next_rev(conn, slug):
    row = conn.execute("SELECT revisions FROM wiki_pages WHERE slug=?", (slug,)).fetchone()
    return (row[0] + 1) if row else 1


def _status_of(req, default="stable"):
    s = str(req.get("status") or default).strip()
    return s if s in STATUSES else default


# ── 操作实现 ──────────────────────────────────────────────────────────────

def op_create(conn, req):
    slug = str(req.get("slug") or "").strip()
    family = str(req.get("familyPath") or "").strip().strip("/")
    title = str(req.get("title") or "").strip()
    intro = str(req.get("intro") or "").strip()
    content = str(req.get("content") or "")
    executor, resolved, source = attribution(req)
    status = _status_of(req)
    now = int(time.time() * 1000)
    if not slug or "/" in slug:
        return {"ok": False, "error": "slug 必填且不含 /（家族归属用 familyPath 表达）"}
    if not title:
        return {"ok": False, "error": "title 必填"}
    dup = conn.execute("SELECT 1 FROM wiki_pages WHERE slug=? OR full_path=?",
                       (slug, full_of(family, slug))).fetchone()
    if dup:
        return {"ok": False, "error": f"slug 或全路径已存在: {slug}"}
    # 家族规则 v0.2（银杏审读①定稿）：familyPath == slug → 根条目（full = slug）；
    # 否则 familyPath 必须命中某已存在条目的 full_path（= 父 family_path + '/' + 父 slug）
    is_root = (family == slug)
    if not is_root:
        parent = conn.execute("SELECT 1 FROM wiki_pages WHERE full_path = ? LIMIT 1",
                              (family,)).fetchone()
        if not parent:
            return {"ok": False, "error": f"父条目不存在（familyPath 未命中任何条目全路径）: {family}。"
                    f"根条目请令 familyPath == slug"}
    full = full_of(family, slug)
    conn.execute(
        "INSERT INTO wiki_pages(slug, family_path, full_path, title, intro, content, status, revisions, created_at, updated_at)"
        " VALUES(?,?,?,?,?,?, ?, 1, ?, ?)",
        (slug, family, full, title, intro, content, status, now, now))
    log_revision(conn, slug, 1, now, executor, "create", annotate_fallback(intro or title, resolved), content,
                 executor_resolved=resolved, source_contributor=source)
    conn.commit()
    return {"ok": True, "slug": slug, "familyPath": family, "fullPath": full,
            "isRoot": is_root, "rev": 1,
            "executor": executor, "executorResolved": resolved, "sourceContributor": source or None}


def op_update(conn, req):
    slug = str(req.get("slug") or "").strip()
    row = conn.execute(
        "SELECT content, intro, title, status, revisions, updated_at, family_path, full_path"
        " FROM wiki_pages WHERE slug=?", (slug,)).fetchone()
    if not row:
        return {"ok": False, "error": "条目不存在: " + slug}
    old_content, old_intro, old_title, old_status, old_revs, old_updated, old_family, old_full = row
    if req.get("familyPath") is not None:
        return {"ok": False, "error": "改挂家族请用 op=move（会连子树一起迁移并逐条留账）；update 只改内容/元数据"}
    new_content = str(req["content"]) if req.get("content") is not None else old_content
    new_intro = str(req["intro"]) if req.get("intro") is not None else old_intro
    new_title = str(req["title"]) if req.get("title") is not None else old_title
    new_status = str(req.get("status") or "").strip()
    new_status = new_status if new_status in STATUSES else old_status
    executor, resolved, source = attribution(req)
    summary = annotate_fallback(str(req.get("summary") or "").strip(), resolved)
    now = int(time.time() * 1000)
    unchanged = (new_content == old_content and new_intro == old_intro
                 and new_title == old_title and new_status == old_status)
    # force（〈升格流落树约定〉规则 6）：内容未变也强制落一条修订——用于归因/元数据更正
    # 留痕（「存疑只标注不删撤」需要能留下更正的痕；unchanged 短路会把这条路堵死——
    # 观澜 10-03 现状梳理 #4）。检查点级联自身有"内容没变不重复入槽"守卫，不会灌槽。
    if unchanged and not req.get("force"):
        return {"ok": True, "slug": slug, "unchanged": True,
                "executor": executor, "executorResolved": resolved, "sourceContributor": source or None}
    # ① 梯度稀释检查点：旧正文送入时间稀释槽位（级联保留）
    on_update_cascade(conn, slug, old_content, old_updated, now)
    new_revs = old_revs + 1
    conn.execute(
        "UPDATE wiki_pages SET content=?, intro=?, title=?, status=?, revisions=?, updated_at=? WHERE slug=?",
        (new_content, new_intro, new_title, new_status, new_revs, now, slug))
    log_revision(conn, slug, new_revs, now, executor, "update", summary, new_content,
                 executor_resolved=resolved, source_contributor=source)
    conn.commit()
    return {"ok": True, "slug": slug, "rev": new_revs,
            "executor": executor, "executorResolved": resolved, "sourceContributor": source or None}


def op_get(conn, req):
    slug = str(req.get("slug") or "").strip()
    row = conn.execute(
        "SELECT slug, family_path, full_path, title, intro, content, status, revisions, created_at, updated_at"
        " FROM wiki_pages WHERE slug=?", (slug,)).fetchone()
    if not row:
        return {"ok": False, "error": "条目不存在: " + slug}
    my_full = row[2]
    children = conn.execute(
        "SELECT slug, family_path, title FROM wiki_pages WHERE family_path = ? AND slug != ?",
        (my_full, slug)).fetchall()
    cps = conn.execute(
        "SELECT slot, time FROM wiki_checkpoints WHERE slug=? ORDER BY slot", (slug,)).fetchall()
    rev_opt = [c for c, _ in REVISION_OPT_COLUMNS if c in revision_columns(conn)]
    rev_names = ["rev", "time", "contributor", "action", "summary"] + rev_opt
    revs = conn.execute(
        "SELECT " + ", ".join(rev_names) + " FROM wiki_revisions WHERE slug=? ORDER BY rev DESC LIMIT 20",
        (slug,)).fetchall()
    return {"ok": True, "page": {
        "slug": slug, "familyPath": row[1], "fullPath": my_full,
        "title": row[3], "intro": row[4], "content": row[5],
        "status": row[6], "revisions": row[7], "createdAt": row[8], "updatedAt": row[9],
        "children": [{"slug": s, "familyPath": f, "title": t} for s, f, t in children],
        "checkpoints": [{"slot": s, "time": t} for s, t in cps],
        "recentRevisions": [dict(zip(rev_names, r)) for r in revs],
    }}


def op_list(conn, req):
    prefix = str(req.get("familyPrefix") or "").strip().strip("/")
    if prefix:
        rows = conn.execute(
            "SELECT slug, family_path, full_path, title, intro, status, revisions, updated_at"
            " FROM wiki_pages WHERE full_path=? OR full_path LIKE ? ORDER BY full_path",
            (prefix, prefix + "/%")).fetchall()
    else:
        rows = conn.execute(
            "SELECT slug, family_path, full_path, title, intro, status, revisions, updated_at"
            " FROM wiki_pages ORDER BY family_path, slug").fetchall()
    return {"ok": True, "count": len(rows), "entries": [
        {"slug": r[0], "familyPath": r[1], "fullPath": r[2], "title": r[3], "intro": r[4],
         "status": r[5], "revisions": r[6], "updatedAt": r[7]} for r in rows]}


def op_tree(conn, req):
    """森林视图：层级由 full_path 前缀链推导 + 孤儿识别（银杏审读④）。
    孤儿 = 家族路径的父链断裂（parent 条目不存在）——治理时一眼看到断链。"""
    rows = conn.execute(
        "SELECT slug, family_path, full_path, title, intro, status, revisions, updated_at"
        " FROM wiki_pages ORDER BY full_path").fetchall()
    entries = []
    byfull = {}
    for slug, fp, full, title, intro, status, revs, upd in rows:
        e = {"slug": slug, "familyPath": fp, "fullPath": full, "title": title, "intro": intro,
             "status": status, "revisions": revs, "updatedAt": upd, "children": []}
        entries.append(e)
        byfull[full] = e
    roots, orphans = [], []
    for e in entries:
        parent = byfull.get(e["familyPath"])
        if parent is not None and parent is not e:
            parent["children"].append({"slug": e["slug"], "fullPath": e["fullPath"],
                                       "title": e["title"]})
        elif e["familyPath"] == e["slug"]:
            roots.append(e)
        else:
            orphans.append(e)
    return {"ok": True, "count": len(entries),
            "roots": [r["slug"] for r in roots],
            "orphans": [o["slug"] for o in orphans],
            "entries": entries}


def op_move(conn, req):
    """改挂家族（银杏审读②：move 必须逐条留账——修订记录是五要件之一）。
    受影响集 = 自身（full_path == 自身全路径）+ 后代（full_path LIKE 自身全路径/%）。
    目标家族须已存在（full_path 命中），否则会产生孤儿——拒绝。"""
    slug = str(req.get("slug") or "").strip()
    newfp = str(req.get("newFamilyPath") or "").strip().strip("/")
    executor, resolved, source = attribution(req)
    now = int(time.time() * 1000)
    if not slug or not newfp:
        return {"ok": False, "error": "slug 与 newFamilyPath 必填"}
    row = conn.execute("SELECT family_path, full_path FROM wiki_pages WHERE slug=?", (slug,)).fetchone()
    if not row:
        return {"ok": False, "error": "条目不存在: " + slug}
    old_family, old_full = row
    if newfp == old_family:
        return {"ok": True, "slug": slug, "unchanged": True}
    # 目标家族必须已存在（防孤儿）
    target = conn.execute("SELECT 1 FROM wiki_pages WHERE full_path = ? LIMIT 1", (newfp,)).fetchone()
    if not target:
        return {"ok": False, "error": f"目标家族不存在（防孤儿拒绝）: {newfp}"}
    old_prefix = old_full + "/"
    if newfp == old_full:
        return {"ok": False, "error": "不能把条目挂到它自己下面: " + newfp}
    # 受影响集严格按**本函数文档**的口径：自身（full_path == 自身全路径）+ 后代（前缀匹配）。
    # 2026-10-01 守夜人修：原谓词用的是 `family_path=? OR full_path LIKE ?`，与文档不符，后果是
    #   ① 把「父条目」与「兄弟」一并卷进来（改挂子条目会连坐）；
    #   ② 自身那条的全路径被算成 newfp，撞 wiki_pages.full_path 唯一约束 → 任何 move 都必然抛
    #      IntegrityError、工具只回「无输出」。取证见 _tmp 证据（改动前备份与本文件同样复现）。
    affected = conn.execute(
        "SELECT slug, family_path, full_path FROM wiki_pages WHERE full_path = ? OR full_path LIKE ? ORDER BY full_path",
        (old_full, old_prefix + "%")).fetchall()
    # 平移基线：老全路径 old_full ↔ 新全路径 base_new（= 新父 + '/' + 自己）。
    # ⚠ 后代必须相对 base_new 平移，不能相对 newfp——否则「子条目带着孙条目改挂」时
    #   孙会被压到新父下面、与子平级（守夜人第一版修法就栽在这，被自建用例抓出）。
    base_new = full_of(newfp, slug)
    try:
        for mslug, mfp, mfull in affected:
            new_full = base_new + mfull[len(old_full):]
            new_family = newfp if mfull == old_full else new_full.rsplit("/", 1)[0]
            rev = next_rev(conn, mslug)
            conn.execute(
                "UPDATE wiki_pages SET family_path=?, full_path=?, revisions=?, updated_at=? WHERE slug=?",
                (new_family, new_full, rev, now, mslug))
            log_revision(conn, mslug, rev, now, executor, "move",
                         annotate_fallback(f"家族改挂：{mfp} → {new_family}", resolved), "",
                         executor_resolved=resolved, source_contributor=source)
        conn.commit()
    except sqlite3.IntegrityError as e:
        conn.rollback()                    # 不留半截改挂（父/子路径不一致会造孤儿）
        return {"ok": False, "error": "改挂失败（全路径冲突，已回滚）: %s" % e}
    return {"ok": True, "slug": slug, "moved": len(affected),
            "executor": executor, "executorResolved": resolved, "sourceContributor": source or None}


def op_rollback(conn, req):
    slug = str(req.get("slug") or "").strip()
    executor, resolved, source = attribution(req)
    now = int(time.time() * 1000)
    # 审读⑥：slot 编号随保留规则重排不稳定——按 time 定位（slot 仅展示序号）
    t = req.get("time")
    snap = None
    if t is not None:
        t = int(t)
        row = conn.execute("SELECT content FROM wiki_checkpoints WHERE slug=? AND time=?",
                           (slug, t)).fetchone()
        if row:
            snap = (t, row[0])
    if snap is None:
        allc = conn.execute("SELECT time, content FROM wiki_checkpoints WHERE slug=? ORDER BY time DESC",
                            (slug,)).fetchall()
        if not allc:
            return {"ok": False, "error": "无检查点可回滚"}
        snap = allc[0]
    snap_time, snap_content = snap
    old = conn.execute("SELECT content, updated_at FROM wiki_pages WHERE slug=?", (slug,)).fetchone()
    if not old:
        return {"ok": False, "error": "条目不存在"}
    on_update_cascade(conn, slug, old[0], old[1], now)
    rev = next_rev(conn, slug)
    conn.execute(
        "UPDATE wiki_pages SET content=?, revisions=?, updated_at=? WHERE slug=?",
        (snap_content, rev, now, slug))
    log_revision(conn, slug, rev, now, executor, "rollback",
                 annotate_fallback(f"回滚到检查点（原时间 {snap_time}）", resolved), snap_content,
                 executor_resolved=resolved, source_contributor=source)
    conn.commit()
    return {"ok": True, "slug": slug, "rev": rev, "restoredFromTime": snap_time,
            "executor": executor, "executorResolved": resolved, "sourceContributor": source or None}



VEC_CACHE_FILE = os.path.join(os.path.expanduser("~/.dsh/liubian"), "wiki_vectors.json")


def _load_vec_cache():
    try:
        with open(VEC_CACHE_FILE, encoding="utf-8") as f:
            return json.loads(f.read())
    except Exception:
        return {}


def _save_vec_cache(cache):
    os.makedirs(os.path.dirname(VEC_CACHE_FILE), exist_ok=True)
    tmp = VEC_CACHE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cache, f)
    os.replace(tmp, VEC_CACHE_FILE)


def _embed_batch(texts):
    """批量嵌入（契约 §2.2：单批 ≤64、按 index 排序取回）。"""
    import urllib.request
    out = []
    for i in range(0, len(texts), 64):
        chunk = texts[i:i + 64]
        payload = json.dumps({"model": "qwen3-emb", "input": [t[:4000] for t in chunk]}).encode("utf-8")
        rq = urllib.request.Request(
            "http://127.0.0.1:8082/v1/embeddings", data=payload,
            headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(rq, timeout=60) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        for d in sorted(data["data"], key=lambda x: x["index"]):
            out.append(d["embedding"])
    return out


def _intro_vectors(conn):
    """全部条目的简介向量：按 (slug, intro哈希) 命中持久缓存；缺失/变更的批量补嵌（一次 HTTP）。"""
    rows = conn.execute(
        "SELECT slug, title, intro, content, status, revisions, updated_at, family_path, full_path"
        " FROM wiki_pages ORDER BY full_path").fetchall()
    cache = _load_vec_cache()
    need = []
    for r in rows:
        text = r["intro"] or r["title"] or ""
        h = hashlib.md5(text.encode("utf-8")).hexdigest()
        c = cache.get(r["slug"])
        if not c or c.get("h") != h:
            need.append((r["slug"], text, h))
    if need:
        vecs = _embed_batch([t for _, t, _ in need])
        for (slug, _, h), v in zip(need, vecs):
            cache[slug] = {"h": h, "vec": v}
        _save_vec_cache(cache)
    return rows, cache


def op_search(conn, req):
    """S4 分级向量检索：查询向量 vs 全部条目简介锚（向量持久缓存，批量补嵌）。

    返回 top-K 条目（命名字段：slug/title/family_path/full_path/intro/status/score）。"""
    qv = req.get("vec") or []
    top = max(1, int(req.get("top") or 10))
    if not qv or len(qv) < 64:
        return {"ok": False, "error": "vec 必填（查询向量，≥64 维）"}
    qv = [float(x) for x in qv]
    qn = sum(x * x for x in qv) ** 0.5
    if qn == 0:
        return {"ok": False, "error": "查询向量全零"}
    qv = [x / qn for x in qv]

    rows, cache = _intro_vectors(conn)
    scored = []
    for r in rows:
        c = cache.get(r["slug"])
        if not c:
            continue
        iv = c["vec"]
        ivn = sum(x * x for x in iv) ** 0.5
        if ivn == 0:
            continue
        iv = [x / ivn for x in iv]
        scored.append({
            "slug": r["slug"], "title": r["title"],
            "family_path": r["family_path"], "full_path": r["full_path"],
            "intro": r["intro"], "status": r["status"],
            "score": round(sum(a * b for a, b in zip(qv, iv)), 4),
        })
    scored.sort(key=lambda x: -x["score"])
    return {"ok": True, "total": len(scored), "results": scored[:top]}

OPS = {
    "create": op_create,
    "update": op_update,
    "get": op_get,
    "tree": op_tree,
    "list": op_list,
    "move": op_move,
    "rollback": op_rollback,
    "search": op_search,
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
        out({"ok": False, "error": f"未知 op: {op}（可选: {', '.join(sorted(OPS))}）"})
        return
    conn = connect()
    try:
        out(fn(conn, req))
    finally:
        conn.close()


if __name__ == "__main__":
    main()
