# -*- coding: utf-8 -*-
"""联合检索：tag 命中 + 语义向量，一次算完，返回综合得分排序的日记。

为什么放在 DSH 侧自己算，而不是调 `memory.py search`：
  memory.py 的语义查询用的是 `" ".join(raw_tags)`（把标签拼成查询），
  而且它的分数是 tag 与语义 **1:1 融合、无稀有度权重**，泛标签会淹没精准语义命中。
  用户要的是「自由文本查语义 + 模型挑的 tag 查字面，两路加权融合」，
  这需要自己控制查询向量与公式，所以这里直接读 liubian.db 自己算。

数据来源（都是只读）：
  · docs['index:<工作区>']  → 每篇日记的 tags/摘要/日期（tag 一路）
  · embeddings 表           → 每篇日记的 1024 维向量（语义一路）
  · diary_content 表        → 正文（--full 时回传，供注入上下文）

用法（全部 JSON，走 stdin 或 --json）:
  echo {"workspace":"工作组","tags":["a","b"],"vec":[...],"top":10,"wTag":0.5,"full":true} | python memory_query.py

输入字段:
  workspace  '' 或省略 = 跨全部工作区
  tags       数组，tag 一路的查询标签（模型挑出来的 5 个）
  vec        1024 维查询向量（语义一路）；为空则只用 tag 一路
  top        返回前几篇（默认 10）
  wTag       tag 一路权重（默认 0.5）
  full       true = 带正文；false = 只带摘要（省 token）

输出:
  {"ok":true,"candidates":N,"tagCandidates":N,"semCandidates":N,
   "results":[{"ws","id","tag","sem","score","matchedTags","tags","summary","date",
               "contentChars","content"}]}
"""
import json
import math
import os
import sqlite3
import struct
import sys

MAX_TAGS_PER_ENTRY = 8      # 报告里每篇最多列几个命中标签
CONTENT_LIMIT = 4000        # 正文回传上限（防单篇过长把上下文吃光）


def out(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False))
    sys.stdout.flush()


def norm(vec):
    s = 0.0
    for x in vec:
        s += x * x
    return s ** 0.5 or 1e-9


def load_index(conn, workspace):
    """docs['index:<ws>'] → {(ws, diary_id): {"tags":set, "entry":{...}}}（跨工作区则遍历全部）"""
    rows = conn.execute(
        "SELECT key, value FROM docs WHERE key LIKE 'index:%'"
    ).fetchall()
    items = {}
    for key, value in rows:
        ws = key.split(":", 1)[1]
        if workspace and ws != workspace:
            continue
        try:
            idx = json.loads(value).get("index") or {}
        except Exception:
            continue
        for tag, entries in idx.items():
            for e in entries:
                did = e.get("id")
                if not did:
                    continue
                slot = items.setdefault((ws, did), {"tags": set(), "entry": e})
                slot["tags"].add(tag)
                # 摘要/日期取最新一次出现的（同一篇在多个 tag 下重复登记）
                if e.get("summary"):
                    slot["entry"]["summary"] = e.get("summary")
                if e.get("date"):
                    slot["entry"]["date"] = e.get("date")
    return items


def load_vecs(conn, workspace):
    """embeddings 表 → {(ws, diary_id): tuple(vec)}"""
    if workspace:
        rows = conn.execute(
            "SELECT workspace, diary_id, vec FROM embeddings WHERE workspace=?", (workspace,)
        ).fetchall()
    else:
        rows = conn.execute("SELECT workspace, diary_id, vec FROM embeddings").fetchall()
    out_map = {}
    for ws, did, blob in rows:
        if not blob:
            continue
        out_map[(ws, did)] = struct.unpack("<%df" % (len(blob) // 4), blob)
    return out_map


def load_contents(conn, workspace):
    if workspace:
        rows = conn.execute(
            "SELECT workspace, diary_id, content FROM diary_content WHERE workspace=?", (workspace,)
        ).fetchall()
    else:
        rows = conn.execute("SELECT workspace, diary_id, content FROM diary_content").fetchall()
    return {(ws, did): (body or "") for ws, did, body in rows}


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    db = os.environ.get("LU_DB", "")
    if not db or not os.path.isfile(db):
        out({"ok": False, "error": "liubian.db not found: " + db})
        return

    # ⚠️ 必须按**字节**读 stdin 再自己解 UTF-8。
    # Windows 上 sys.stdin 的编码是系统 ANSI 代码页（中文机器上是 cp936），
    # 直接 sys.stdin.read() 会把传进来的 UTF-8 JSON 解码错 —— 中文标签全变乱码，
    # 于是 tag 一路永远零命中（这个坑实测踩过：查 "自动日记" 变成 "鑷?鍔ㄦ棩璁?"）。
    raw_bytes = sys.stdin.buffer.read()
    try:
        raw = raw_bytes.decode("utf-8")
    except UnicodeDecodeError:
        raw = raw_bytes.decode("utf-8", "replace")
    try:
        req = json.loads(raw or "{}")
    except Exception as e:
        out({"ok": False, "error": "bad json: %s" % e})
        return

    workspace = str(req.get("workspace") or "").strip()
    query_tags = [str(t).strip() for t in (req.get("tags") or []) if str(t).strip()]
    vec = req.get("vec") or []
    top = int(req.get("top") or 10)
    w_tag = float(req.get("wTag") if req.get("wTag") is not None else 0.5)
    want_full = bool(req.get("full"))
    # mode=semantic：只回语义一路的 (ws,id,score)，供调用方在拿到模型挑的 tag 后**在内存里融合**
    #   —— 这样每轮只需要起一次 python 进程（起进程 ~0.3s，比再查一遍库便宜）。
    mode = str(req.get("mode") or "full")
    # ids 模式只按 id 取正文，不需要 tags/vec（别被下面这行守卫挡掉）
    if not query_tags and not vec and mode != "ids":
        out({"ok": False, "error": "需要 tags 或 vec 至少一路"})
        return

    try:
        conn = sqlite3.connect(db, timeout=20)
    except Exception as e:
        out({"ok": False, "error": str(e)})
        return

    try:
        items = load_index(conn, workspace)
        vecs = load_vecs(conn, workspace) if vec else {}
        contents = load_contents(conn, workspace) if want_full else {}
    finally:
        conn.close()

    # 查询向量归一化（一篇日记的向量也各自归一化后点积 = 余弦）
    qv = None
    if vec:
        qv = [float(x) for x in vec]
        qn = norm(qv)
        qv = [x / qn for x in qv]

    sem_scores = {}
    if qv is not None:
        for key, v in vecs.items():
            if len(v) != len(qv):
                continue
            dot = 0.0
            for a, b in zip(v, qv):
                dot += a * b
            sem_scores[key] = dot

    qset = set(query_tags)
    tag_hits = {}
    if qset:
        for key, slot in items.items():
            matched = slot["tags"] & qset
            if matched:
                tag_hits[key] = matched

    # ── 标签稀有度（IDF）──────────────────────────────────────────────────
    # ⚠️ 实测踩过的坑：不加 IDF 时，"命中 1 个标签"就是 1/5=0.2 分，于是
    #   泛标签（如"联合""检索"命中几百篇）能把语义只有 0.43 的无关日记顶到第一，
    #   权重越大越糟（wTag=0.65 时前 6 篇全是 tag 0.2/sem 0.43 的噪声）。
    #   所以每个标签的分量按 log(N/df) 计：命中冷门标签才值钱，命中大路货几乎不加分。
    total_docs = max(1, len(items))
    df = {}
    for slot in items.values():
        for t in ((slot["tags"] & qset) if qset else ()):
            df[t] = df.get(t, 0) + 1
    tag_weight = {}
    for t in qset:
        d = df.get(t, 0)
        tag_weight[t] = math.log(1.0 + total_docs / d) if d > 0 else 0.0   # 库里没有的标签=0 分
    # 标签证据：命中**比例**（0~1）；融合时按 tagBonus 缩放成加成（见下）。
    # ⚠️ 融合方式被实测反复打脸，最终形态与所有被否掉的写法都记在这里，别再重走：
    #   朴素线性融合 score = w·命中率 + (1-w)·cos，在 w=0.5 时单标签命中贡献 0.1，
    #   足以把语义 0.31~0.43 的无关日记顶到第二（实测 D0598：标签"双通道检索"与
    #   ASR/剪辑领域的**同名标签**撞车，语义只有 0.31 却排前）。
    #   试过的补丁全部否掉：
    #     ① IDF 加权平均 → 单命中仍拿 1/k，无效；
    #     ② IDF 之和 → 单命中≈满分，更糟；
    #     ③ 命中率平方 / 1.5 次方 → 单命中被压到 0.04~0.09，tag 一路彻底浮不上来
    #       （实测前 10 全是纯语义篇），等于把"tag 一路"废掉。
    #   根因是**量纲不同**：cos 集中在 [0.3, 0.7] 的窄带里，而"命中 1/5"在线性加权下
    #   等价于 cos 意义上的 0.2 —— 比两个平庸语义分之间的差距还大。
    #   所以改成：**语义分是底分，标签命中是加成（封顶 tagBonus）**：
    #       score = cos + tagBonus · 命中率
    #   标签能把"语义还行 + 标签也对上"的篇顶上去（这正是用户要的第二路价值），
    #   但一个平庸的语义分不可能靠单个标签命中翻盘。
    def tag_score(key):
        matched = tag_hits.get(key) or set()
        if not matched or not qset:
            return set(), 0.0
        return matched, len(matched) / len(qset)

    tag_bonus = max(0.0, w_tag)

    def rec_for(key, matched, tag_score_val, sem, score):
        slot = items.get(key) or {}
        entry = slot.get("entry") or {}
        rec = {
            "ws": key[0],
            "id": key[1],
            "tag": round(tag_score, 4),
            "sem": round(sem, 4),
            "score": round(score, 4),
            "matchedTags": sorted(matched)[:MAX_TAGS_PER_ENTRY],
            "tags": sorted(slot.get("tags") or [])[:MAX_TAGS_PER_ENTRY],
            "summary": entry.get("summary") or "",
            "date": entry.get("date") or "",
        }
        if want_full:
            body = contents.get(key) or ""
            rec["contentChars"] = len(body)
            if len(body) > CONTENT_LIMIT:
                body = body[:CONTENT_LIMIT] + "\n…（正文过长已截断）"
            rec["content"] = body
        return rec

    # mode=semantic：回语义一路前 N 篇（带 tags/摘要/日期；--full 时带正文）。
    #   ⚠️ 不要在这里回**全部**候选：6114 篇带正文序列化会撑爆子进程管道（实测 60s 超时）。
    #   调用方只需要"前 N 篇 + 足够做加权融合的候选元数据"，N 由 top 控制。
    if mode == "semantic":
        ranked = sorted(sem_scores.items(), key=lambda kv: (-kv[1], kv[0][0], kv[0][1]))[:max(1, top)]
        out({
            "ok": True,
            "mode": "semantic",
            "workspace": workspace or "(全局)",
            "semCandidates": len(sem_scores),
            "results": [rec_for(k, set(), 0.0, max(0.0, s), 0.0) for k, s in ranked],
        })
        return

    # mode=keys：只回 {(ws,id): [tags]}（极小），供调用方在内存里做 tag 命中率计算
    if mode == "keys":
        out({
            "ok": True,
            "mode": "keys",
            "count": len(items),
            "keys": [{"ws": k[0], "id": k[1], "tags": sorted(v["tags"])} for k, v in items.items()],
        })
        return

    # mode=rank：只回**排序后的 id 与分数**（不正文），top 已由调用方传入。
    #   融合公式在这里算（与 full 模式同源），调用方再按 id 精确取正文 —— 两段加起来
    #   传输量很小，避免把全库正文塞进管道。
    if mode == "rank":
        keys = set(tag_hits) | set(sem_scores)
        rows = []
        for key in keys:
            matched, tscore = tag_score(key)
            sem = max(0.0, sem_scores.get(key, 0.0))
            rows.append({
                "ws": key[0],
                "id": key[1],
                "sem": round(sem, 4),
                "tag": round(tscore, 4),
                "score": round(sem + tag_bonus * tscore, 4),
                "matchedTags": sorted(matched)[:MAX_TAGS_PER_ENTRY],
            })
        rows.sort(key=lambda r: (-r["score"], -r["sem"], r["ws"], r["id"]))
        out({
            "ok": True,
            "mode": "rank",
            "workspace": workspace or "(全局)",
            "tagCandidates": len(tag_hits),
            "semCandidates": len(sem_scores),
            "wTag": w_tag,
            "tagIdf": {t: round(v, 3) for t, v in sorted(tag_weight.items(), key=lambda kv: -kv[1])},
            "results": rows[:max(1, top)],
        })
        return

    # mode=ids：按指定 id 精确取正文（只取调用方真正要注入的那几篇）
    #   ids 容忍三种形态：[[ws,id],...] / "[[\"ws\",\"id\"]]"(被二次编码的字符串) / ["ws|id", ...]
    if mode == "ids":
        raw_ids = req.get("ids") or []
        if isinstance(raw_ids, str):
            try:
                raw_ids = json.loads(raw_ids)
            except Exception:
                raw_ids = [p for p in raw_ids.split(",") if p.strip()]
        want = []
        for a in raw_ids:
            if isinstance(a, str):
                if "|" in a:
                    parts = a.split("|", 1)
                    want.append((parts[0].strip(), parts[1].strip()))
                continue
            if isinstance(a, (list, tuple)) and len(a) == 2:
                want.append((str(a[0]).strip(), str(a[1]).strip()))
        rows = []
        for ws, did in want:
            key = (ws, did)
            body = contents.get(key, "")
            entry = (items.get(key) or {}).get("entry") or {}
            if len(body) > CONTENT_LIMIT:
                body = body[:CONTENT_LIMIT] + "\n…（正文过长已截断）"
            rows.append({
                "ws": ws, "id": did,
                "tags": sorted((items.get(key) or {}).get("tags") or [])[:MAX_TAGS_PER_ENTRY],
                "summary": entry.get("summary") or "",
                "date": entry.get("date") or "",
                "contentChars": len(contents.get(key, "")),
                "content": body,
            })
        out({"ok": True, "mode": "ids", "count": len(rows), "results": rows})
        return

    keys = set(tag_hits) | set(sem_scores)
    results = []
    for key in keys:
        matched, tscore = tag_score(key)
        sem = max(0.0, sem_scores.get(key, 0.0))
        results.append(rec_for(key, matched, tscore, sem, sem + tag_bonus * tscore))

    results.sort(key=lambda r: (-r["score"], -r["sem"], r["ws"], r["id"]))
    out({
        "ok": True,
        "workspace": workspace or "(全局)",
        "queryTags": query_tags,
        "candidates": len(results),
        "tagCandidates": len(tag_hits),
        "semCandidates": len(sem_scores),
        "wTag": w_tag,
        "results": results[:max(1, top)],
    })


if __name__ == "__main__":
    main()
