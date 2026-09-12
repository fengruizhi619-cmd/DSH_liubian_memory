# -*- coding: utf-8 -*-
"""语义向量检索（llama.cpp 本地嵌入服务）

在 tag 检索基础上自动叠加语义相似度：
- 向量存 SQLite embeddings 表（float32 BLOB），增量索引只嵌入新增/缺失篇
- 服务不可用时静默回退纯 tag（返回 None，调用方照旧）
- 依赖：E:/llama.cpp 的 llama-server --embeddings，端口 8082
"""
import json
import struct
import urllib.request

EMBED_URL = "http://127.0.0.1:8082/v1/embeddings"
MODEL = "qwen3-emb"
EMBED_DIM = 1024
MAX_TEXT = 600  # 嵌入截断字符数，控制耗时与上下文

try:
    import numpy as np
    HAVE_NUMPY = True
except Exception:
    HAVE_NUMPY = False


def embed_texts(texts, timeout=120):
    """调用本地嵌入服务；返回 list[list[float]]，失败返回 None"""
    try:
        payload = {"model": MODEL,
                   "input": [t[:MAX_TEXT] for t in texts]}
        body = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            EMBED_URL, data=body,
            headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return [d["embedding"] for d in data.get("data", [])]
    except Exception:
        return None


def service_alive():
    try:
        return embed_texts(["ping"]) is not None
    except Exception:
        return False


def _norm(vec):
    s = 0.0
    for x in vec:
        s += x * x
    return s ** 0.5 or 1e-9


def _cos_loop(rows, qv):
    """纯 Python 回退：rows=[(id, blob)] -> [(id, score)]"""
    out = []
    for did, blob in rows:
        v = struct.unpack("<%df" % (len(blob) // 4), blob)
        dot = 0.0
        for a, b in zip(v, qv):
            dot += a * b
        out.append((did, dot))
    return out


def index_workspace(ws, batch=16, progress=False):
    """增量嵌入当前工作区缺索引的日记。
    返回 (新索引篇数, 总篇数)；服务不可用返回 None。
    """
    from memory_db import (get_all_diary_ids, get_diary_content,
                           get_embedding_ids, set_embedding)
    if not service_alive():
        return None
    all_ids = get_all_diary_ids(ws)
    if not all_ids:
        return (0, 0)
    existing = set(get_embedding_ids(ws))
    missing = [i for i in all_ids if i not in existing]
    if not missing:
        return (0, len(all_ids))
    for start in range(0, len(missing), batch):
        chunk = missing[start:start + batch]
        texts = []
        for did in chunk:
            content = get_diary_content(ws, did) or ""
            # 去掉标题/时间等模板头，正文更有语义
            texts.append(content)
        vecs = embed_texts(texts)
        if vecs is None:
            break
        for did, vec in zip(chunk, vecs):
            set_embedding(ws, did, vec)
        if progress:
            print(f"  语义索引 {start + len(chunk)}/{len(missing)} ...")
    return (len(missing), len(all_ids))






def count_indexed(ws):
    """当前工作区已索引的向量数"""
    from memory_db import count_embeddings
    return count_embeddings(ws)

def index_pending(ws):
    """返回当前工作区尚缺向量的日记数"""
    from memory_db import get_all_diary_ids, get_embedding_ids
    all_ids = get_all_diary_ids(ws)
    existing = set(get_embedding_ids(ws))
    return sum(1 for i in all_ids if i not in existing)

def search_semantic(ws, query, top=100):
    """查询嵌入与工作区全量向量算余弦。
    返回 [(diary_id, score), ...] 降序；不可用/无索引返回 None。
    """
    from memory_db import get_all_embeddings
    rows = get_all_embeddings(ws)
    if not rows:
        return None
    q = embed_texts([query])
    if not q:
        return None
    qv = q[0][:EMBED_DIM]
    if HAVE_NUMPY:
        ids = [r[0] for r in rows]
        try:
            mat = np.frombuffer(
                b"".join(r[1] for r in rows), dtype="<f4"
            ).reshape(len(rows), EMBED_DIM)
            qa = np.asarray(qv, dtype="<f4")
            qn = np.linalg.norm(qa)
            if qn == 0:
                return None
            qa = qa / qn
            norms = np.linalg.norm(mat, axis=1)
            mat = mat / np.maximum(norms, 1e-9).reshape(-1, 1)
            scores = (mat @ qa).tolist()
            ranked = sorted(zip(ids, scores), key=lambda x: -x[1])
            return [(i, max(0.0, float(s))) for i, s in ranked[:top]]
        except Exception:
            pass
    # 纯 Python 回退
    try:
        qn = _norm(qv)
        qv = [x / qn for x in qv]
        scored = _cos_loop(rows, qv)
        scored.sort(key=lambda x: -x[1])
        return [(i, max(0.0, float(s))) for i, s in scored[:top]]
    except Exception:
        return None



def index_all(progress=True):
    """对数据库里所有工作区做全量增量向量化，返回 [(工作区, 新增数, 总数)]"""
    from memory_db import get_all_diary_ids
    workspaces = sorted({r[0] for r in _all_ws_ids()})
    results = []
    for ws in workspaces:
        r = index_workspace(ws, progress=progress)
        if r is None:
            results.append((ws, -1, -1))
        else:
            results.append((ws, r[0], r[1]))
            if progress:
                print(f"[{ws}] 新增 {r[0]} / 共 {r[1]}")
    return results


def _all_ws_ids():
    """所有工作区的 (workspace, diary_id) 列表（供 index_all 用）"""
    import sqlite3
    from memory_db import DB_PATH
    conn = sqlite3.connect(str(DB_PATH), timeout=15)
    try:
        return conn.execute(
            "SELECT DISTINCT workspace, diary_id FROM diary_content").fetchall()
    finally:
        conn.close()


# ---------- 全局语义检索（跨工作区，2026-09-07） ----------

def index_pending_global():
    """全部工作区尚缺向量的日记总数"""
    from memory_db import list_workspaces, get_all_diary_ids, get_embedding_ids
    total = 0
    for ws in list_workspaces():
        existing = set(get_embedding_ids(ws))
        total += sum(1 for i in get_all_diary_ids(ws) if i not in existing)
    return total


def count_indexed_global():
    """全库已向量化日记数"""
    from memory_db import count_embeddings_all
    return count_embeddings_all()


def search_semantic_global(query, top=100):
    """全库语义检索：查询嵌入与所有工作区向量算余弦。
    返回 [(workspace, diary_id, score), ...] 降序；不可用/无索引返回 None。"""
    from memory_db import get_embedding_rows_all
    rows = get_embedding_rows_all()
    if not rows:
        return None
    q = embed_texts([query])
    if not q:
        return None
    qv = q[0][:EMBED_DIM]
    if HAVE_NUMPY:
        keys = [(r[0], r[1]) for r in rows]
        try:
            mat = np.frombuffer(
                b"".join(r[2] for r in rows), dtype="<f4"
            ).reshape(len(rows), EMBED_DIM)
            qa = np.asarray(qv, dtype="<f4")
            qn = np.linalg.norm(qa)
            if qn == 0:
                return None
            qa = qa / qn
            norms = np.linalg.norm(mat, axis=1)
            mat = mat / np.maximum(norms, 1e-9).reshape(-1, 1)
            scores = (mat @ qa).tolist()
            ranked = sorted(zip(keys, scores), key=lambda x: -x[1])
            return [(ws, did, max(0.0, float(s))) for (ws, did), s in ranked[:top]]
        except Exception:
            pass
    try:
        qn = _norm(qv)
        qv = [x / qn for x in qv]
        scored = []
        for ws, did, blob in rows:
            v = struct.unpack("<%df" % (len(blob) // 4), blob)
            dot = 0.0
            for a, b in zip(v, qv):
                dot += a * b
            scored.append(((ws, did), max(0.0, dot)))
        scored.sort(key=lambda x: -x[1])
        return [(ws, did, s) for (ws, did), s in scored[:top]]
    except Exception:
        return None


# ---------- 技能风格包/蒸馏结果 语义检索 ----------

SKILLS_DIR = r"C:\Users\Feng\.codex\skills"
SKIP_DIRS = {".skill_tracker", ".system", "__pycache__", "build", "dist",
             "assets", "agents", "scripts", ".venv"}
SKIP_FILES = {"tracker.json"}
MAX_FILES_PER_SKILL = 500  # 2026-08-30 修复：distill-novel-writing 细读卡片/论文写作参考被 15 上限截断遗漏，提升以全量入检索
MAX_TEXT = 1500


def _read_text(path):
    try:
        with open(path, "r", encoding="utf-8-sig", errors="replace") as f:
            return f.read()
    except Exception:
        return ""


def _frontmatter_desc(content):
    """从 SKILL.md frontmatter 提取 description"""
    if content.startswith("---"):
        end = content.find("---", 3)
        if end > 0:
            fm = content[3:end]
            for line in fm.split("\n"):
                if line.strip().startswith("description:"):
                    return line.split(":", 1)[1].strip()[:120]
    return ""


def scan_skill_docs():
    """扫描技能文档：仅每个技能的 SKILL.md 总揽文件（不索引技能内部细读/蒸馏/references 等）。
    返回 [(id, skill_name, path, summary, fhash), ...]"""
    import hashlib, os
    docs = []
    if not os.path.isdir(SKILLS_DIR):
        return docs
    for skill in sorted(os.listdir(SKILLS_DIR)):
        sp = os.path.join(SKILLS_DIR, skill)
        if not os.path.isdir(sp) or skill in SKIP_DIRS:
            continue
        smd = os.path.join(sp, "SKILL.md")
        if os.path.isfile(smd):
            content = _read_text(smd)
            summary = _frontmatter_desc(content) or skill
            docs.append(("SKILL:" + skill, skill, smd, summary,
                         hashlib.md5(content.encode("utf-8", "replace")).hexdigest()))
    return docs


def ensure_skill_index(progress=False):
    """增量索引技能文档（只重建变更/新增/删除），返回 (新增数, 总文档数) 或 None"""
    from memory_db import (get_skill_doc_ids, get_skill_doc_hash,
                           upsert_skill_doc, remove_stale_skill_docs)
    if not service_alive():
        return None
    docs = scan_skill_docs()
    existing = get_skill_doc_ids()
    changed = [d for d in docs
               if d[0] not in existing or get_skill_doc_hash(d[0]) != d[4]]
    valid_ids = {d[0] for d in docs}
    stale = existing - valid_ids
    if stale:
        remove_stale_skill_docs(valid_ids)
    if not changed:
        return (0, len(docs))
    for start in range(0, len(changed), 16):
        chunk = changed[start:start + 16]
        texts = [_read_text(d[2]) for d in chunk]
        vecs = embed_texts(texts)
        if vecs is None:
            break
        for d, vec in zip(chunk, vecs):
            upsert_skill_doc(d[0], d[1], d[2], d[3], d[4], vec)
        if progress:
            print(f"  技能索引 {start + len(chunk)}/{len(changed)} ...")
    return (len(changed), len(docs))


def index_skill(skill, progress=False):
    """定向索引单个技能的文档（SKILL.md + 技能内 .md 蒸馏文件）到技能检索库。
    只处理新增/变更/删除，不影响其他技能。返回 (新增数, 该技能总文档数) 或 None。"""
    from memory_db import (get_skill_doc_ids, get_skill_doc_hash,
                           upsert_skill_doc, remove_stale_skill_docs)
    if not service_alive():
        return None
    docs = [d for d in scan_skill_docs() if d[1] == skill]
    if not docs:
        return (0, 0)
    prefix = "SKILL:" + skill
    existing = get_skill_doc_ids()
    target_ids = {d[0] for d in docs}
    stale = {i for i in existing
             if (i == prefix or i.startswith(prefix + "/")) and i not in target_ids}
    if stale:
        remove_stale_skill_docs(existing - stale)  # 只清本技能的陈旧项
    changed = [d for d in docs
               if d[0] not in existing or get_skill_doc_hash(d[0]) != d[4]]
    if not changed:
        return (0, len(docs))
    for start in range(0, len(changed), 16):
        chunk = changed[start:start + 16]
        texts = [_read_text(d[2]) for d in chunk]
        vecs = embed_texts(texts)
        if vecs is None:
            break
        for d, vec in zip(chunk, vecs):
            upsert_skill_doc(d[0], d[1], d[2], d[3], d[4], vec)
        if progress:
            print(f"  技能索引 {start + len(chunk)}/{len(changed)} ...")
    return (len(changed), len(docs))


def skill_index_status(skill=""):
    """查询技能检索库已索引文档。返回 [(id, skill_name, path, summary), ...]"""
    from memory_db import get_skill_docs
    rows = get_skill_docs()
    if skill:
        rows = [r for r in rows if r[1] == skill]
    return [(r[0], r[1], r[2], r[3]) for r in rows]


def search_skills(query, top=8):
    """语义检索技能风格包/蒸馏结果。
    返回 [(id, skill_name, summary, score), ...] 降序；不可用返回 None"""
    from memory_db import get_skill_docs
    rows = get_skill_docs()
    if not rows:
        return None
    q = embed_texts([query])
    if not q:
        return None
    qv = q[0][:EMBED_DIM]
    id2name = {r[0]: r[1] for r in rows}
    id2sum = {r[0]: r[3] for r in rows}
    if HAVE_NUMPY:
        ids = [r[0] for r in rows]
        try:
            mat = np.frombuffer(b"".join(r[4] for r in rows), dtype="<f4"
                                ).reshape(len(rows), EMBED_DIM)
            qa = np.asarray(qv, dtype="<f4")
            qn = np.linalg.norm(qa)
            if qn == 0:
                return None
            qa = qa / qn
            mat = mat / np.maximum(np.linalg.norm(mat, axis=1), 1e-9).reshape(-1, 1)
            scores = (mat @ qa).tolist()
            ranked = sorted(zip(ids, scores), key=lambda x: -x[1])
            return [(i, id2name.get(i, i), id2sum.get(i, ""), max(0.0, float(sc)))
                    for i, sc in ranked[:top]]
        except Exception:
            pass
    # 纯 Python 兜底
    try:
        qn = _norm(qv)
        qv = [x / qn for x in qv]
        scored = []
        for did, _name, _path, _sum, blob in rows:
            v = struct.unpack("<%df" % (len(blob) // 4), blob)
            dot = sum(a * b for a, b in zip(v, qv))
            scored.append((did, dot))
        scored.sort(key=lambda x: -x[1])
        return [(i, id2name.get(i, i), id2sum.get(i, ""), max(0.0, float(sc)))
                for i, sc in scored[:top]]
    except Exception:
        return None


def _lookup_name(rows, did):
    for r in rows:
        if r[0] == did:
            return r[1]
    return did


def _lookup_summary(rows, did):
    for r in rows:
        if r[0] == did:
            return r[3]
    return ""


if __name__ == "__main__":
    import sys
    ws = sys.argv[1] if len(sys.argv) > 1 else "skill学院"
    print("服务在线:", service_alive())
    r = index_workspace(ws, progress=True)
    print("索引结果:", r)
    if r:
        res = search_semantic(ws, "语义向量检索升级 记忆系统 结合tag")
        print("搜索示例:", res[:5] if res else None)
