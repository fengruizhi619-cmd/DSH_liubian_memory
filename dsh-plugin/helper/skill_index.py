# -*- coding: utf-8 -*-
"""技能文档语义索引（只索引每个技能的 SKILL.md 总揽）。

用法:  python skill_index.py <index|all|status|prune|search> [skill|查询文本]

环境:  LU_SCRIPTS     = memory-skill/scripts（semantic_search.py 所在目录）
       LU_SKILLS_ROOT = 可选，覆盖扫描根目录（默认用 semantic_search.SKILLS_DIR）
       LU_SKILL_TOP   = search 模式返回条数（默认 3）

输出:  index/all/status/prune 为人类可读文本；search 为 JSON（供插件解析）

为什么需要 LU_SKILLS_ROOT：DSH 侧技能装在 ~/.dsh/skills，Codex 侧在 ~/.codex/skills，
两处都要能入检索库。检索库文档 id 是 "SKILL:<技能文件夹名>"，同名技能会互相覆盖。

prune（2026-09-12 新增）：清理"目录里已经不存在、但索引里还留着"的技能。
  背景：`index_skill` 只清理**同一个技能前缀**下的失效文档；技能文件夹整个被删/被移走时，
  它那条 SKILL:xxx 不会被任何一次 index 覆盖到，于是永久留在库里 —— 实测现象是
  `status` 里还列着已经从技能目录移走的 kotatsu-always-listen。
  做法：调 ensure_skill_index()，它内部用 valid_ids 差集删失效文档。
  ⚠️ valid_ids 只含**当前扫描根**的技能，所以 prune 会连带删掉"另一个根"的条目；
  那不影响功能（下次对那个根做 index/all 会重新补回），但调用时要知道自己在做这件事。
"""
import json
import os
import sys


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    mode = (sys.argv[1] if len(sys.argv) > 1 else "status").strip().lower()
    arg = sys.argv[2].strip() if len(sys.argv) > 2 else ""

    scripts = os.environ.get("LU_SCRIPTS", "")
    if scripts and scripts not in sys.path:
        sys.path.insert(0, scripts)
    try:
        import semantic_search as ss
    except Exception as e:
        print("[错误] 无法导入 semantic_search（检查 LU_SCRIPTS）：%s" % e)
        return

    root = os.environ.get("LU_SKILLS_ROOT", "").strip()
    if root and os.path.isdir(root):
        ss.SKILLS_DIR = root

    if mode == "index":
        if not arg:
            print("[错误] index 模式需要 skill 参数（技能文件夹名）")
            return
        r = ss.index_skill(arg)
        if r is None:
            print("[错误] 向量服务不可用，技能 '%s' 未索引（服务恢复后搜索会自动补索引）" % arg)
            return
        new, total = r
        if total == 0:
            good = [r for r in all_roots(ss, root) if os.path.isfile(os.path.join(r, arg, "SKILL.md"))]
            if good:
                print("[提示] 技能 '%s' 不在当前根（%s）里，它在：%s —— 用 action=all 一起索引" % (arg, ss.SKILLS_DIR, good[0]))
                return
            print("[无] 扫描根里没有技能 '%s'（根：%s）" % (arg, ss.SKILLS_DIR))
            return
        print("[OK] 技能 '%s' 索引完成：新增/变更 %d 篇，共 %d 篇" % (arg, new, total))
    elif mode == "all":
        index_all_roots(ss, root)
    elif mode == "prune":
        prune(ss, root)
    elif mode == "search":
        search(ss, arg)
    else:
        status(ss, arg)


def all_roots(ss, root):
    """本次要一起处理的全部技能根：LU_ALL_ROOTS（分号分隔）+ 当前根。"""
    roots = [r.strip() for r in os.environ.get("LU_ALL_ROOTS", "").split(";") if r.strip()]
    if root and root not in roots:
        roots.insert(0, root)
    if not roots:
        roots = [ss.SKILLS_DIR]
    return [r for r in roots if os.path.isdir(r)]


def index_all_roots(ss, root):
    """把**所有根**的技能一起索引，再按"合并后的有效集合"清理失效条目。

    为什么不能直接用 ss.ensure_skill_index()：它的删除条件是
    `stale = existing - {当前根的技能}` —— 全库差集。于是只跑一个根就会把
    **另一个根**已索引的条目全删掉。实测事故（2026-09-12）：DSH 侧索引的
    dsh-plugin-checklist / liubian-memory 被 Codex 侧一次全量刷新清空，库从 35 掉到 33。
    这里改为：先收集所有根的文档 → 各自嵌入 → 一并 upsert → remove_stale(合并集合)。
    """
    try:
        from memory_db import (get_skill_doc_hash, get_skill_doc_ids,
                               upsert_skill_doc, remove_stale_skill_docs)  # type: ignore
    except Exception as e:
        print("[错误] 无法导入 memory_db：%s" % e)
        return
    if not ss.service_alive():
        print("[错误] 向量服务不可用（先 embed ensure）")
        return

    roots = all_roots(ss, root)
    if not roots:
        print("[错误] 没有可用的扫描根")
        return

    docs = []      # (id, name, path, summary, fhash, root)
    seen = set()
    counts = []
    old = ss.SKILLS_DIR
    for r in roots:
        try:
            ss.SKILLS_DIR = r
            got = ss.scan_skill_docs()
        except Exception:
            got = []
        finally:
            ss.SKILLS_DIR = old
        n = 0
        for d in got:
            if d[0] in seen:          # 同名技能：先出现的根胜出
                continue
            seen.add(d[0])
            docs.append((d[0], d[1], d[2], d[3], d[4], r))
            n += 1
        counts.append("%s（%d）" % (r, n))

    existing = get_skill_doc_ids()
    changed = [d for d in docs if d[0] not in existing or get_skill_doc_hash(d[0]) != d[4]]
    valid_ids = {d[0] for d in docs}
    stale = existing - valid_ids
    if stale:
        remove_stale_skill_docs(valid_ids)

    new_n = 0
    batch = 16
    for i in range(0, len(changed), batch):
        chunk = changed[i:i + batch]
        texts = []
        for d in chunk:
            try:
                body = ss._read_text(d[2])
            except Exception:
                body = ""
            texts.append((body or d[3] or d[1])[:ss.MAX_TEXT])
        out = ss.embed_texts(texts)
        if not out:
            print("[错误] 嵌入失败（向量服务中断），已索引 %d 篇后停止" % new_n)
            break
        for d, v in zip(chunk, out):
            upsert_skill_doc(d[0], d[1], d[2], d[3], d[4], v[:ss.EMBED_DIM])
            new_n += 1

    total = len(valid_ids)
    print("[OK] 全量索引完成：新增/变更 %d 篇，总文档 %d 篇，清理失效 %d 篇" % (new_n, total, len(stale)))
    print("[根] " + "；".join(counts))
    """删掉"任何已知扫描根里都不存在"的技能条目，并列出删了什么。

    ⚠️ 有效性必须**跨全部根**判断：只按当前根算的话，另一个根里真实存在的技能
    会被误删（例如以 DSH 根运行 prune，会把 Codex 根独有的技能全删光）。
    """
    try:
        from memory_db import get_skill_docs  # type: ignore
    except Exception as e:
        print("[错误] 无法导入 memory_db：%s" % e)
        return
    before = get_skill_docs()
    if not before:
        print("[无] 技能检索库为空")
        return

    home = os.environ.get("LU_HOME", os.path.expanduser("~")).replace("\\", "/")
    roots = [r.strip() for r in os.environ.get("LU_ALL_ROOTS", "").split(";") if r.strip()]
    if not roots:
        roots = [ss.SKILLS_DIR]
    if root and root not in roots:
        roots.append(root)

    valid, scanned = set(), []
    old = ss.SKILLS_DIR
    for r in roots:
        if not os.path.isdir(r):
            continue
        try:
            ss.SKILLS_DIR = r
            docs = ss.scan_skill_docs()
        except Exception:
            docs = []
        finally:
            ss.SKILLS_DIR = old
        scanned.append("%s（%d 个技能）" % (r, len(docs)))
        valid |= {d[0] for d in docs}

    stale = [r for r in before if r[0] not in valid]
    if not stale:
        print("[OK] 无需清理：库内 %d 篇在这些根里都存在" % len(before))
        for s in scanned:
            print("   已扫 %s" % s)
        return

    # ensure_skill_index 只按"当前根"算有效性，会误删异根条目 —— 所以这里自己删。
    try:
        from memory_db import remove_stale_skill_docs  # type: ignore
        remove_stale_skill_docs(valid)
    except Exception as e:
        print("[错误] 删除失效条目失败：%s" % e)
        return
    after = get_skill_docs()
    print("[OK] 清理完成：技能检索库 %d → %d 篇" % (len(before), len(after)))
    for row in stale:
        print("   删 %s（%s）" % (row[0], str(row[2]).split("?root=")[0]))
    for s in scanned:
        print("   已扫 %s" % s)


def prune(ss, root):
    """清理失效技能条目：列出删了什么，然后按**全部根**的并集重建。

    ⚠️ 有效性必须跨全部根判断：只按当前根算的话，另一个根里真实存在的技能会被误删
    （例如以 DSH 根运行 prune，会把 Codex 根独有的技能全删光 —— 这正是 2026-09-12
    那次"库从 35 掉到 33"的成因，只不过当时是 ensure_skill_index 干的）。
    """
    try:
        from memory_db import get_skill_docs, remove_stale_skill_docs  # type: ignore
    except Exception as e:
        print("[错误] 无法导入 memory_db：%s" % e)
        return
    before = get_skill_docs()
    if not before:
        print("[无] 技能检索库为空")
        return

    roots = all_roots(ss, root)
    valid, scanned = set(), []
    old = ss.SKILLS_DIR
    for r in roots:
        try:
            ss.SKILLS_DIR = r
            got = ss.scan_skill_docs()
        except Exception:
            got = []
        finally:
            ss.SKILLS_DIR = old
        scanned.append("%s（%d 个技能）" % (r, len(got)))
        valid |= {d[0] for d in got}

    stale = [r for r in before if r[0] not in valid]
    if not stale:
        print("[OK] 无需清理：库内 %d 篇在这些根里都存在" % len(before))
        for s in scanned:
            print("   已扫 %s" % s)
        return
    try:
        remove_stale_skill_docs(valid)
    except Exception as e:
        print("[错误] 删除失效条目失败：%s" % e)
        return
    after = get_skill_docs()
    print("[OK] 清理完成：技能检索库 %d → %d 篇" % (len(before), len(after)))
    for row in stale:
        print("   删 %s（%s）" % (row[0], str(row[2]).split("?root=")[0]))
    for s in scanned:
        print("   已扫 %s" % s)


def _skill_vectors(ss, root):
    """取某个根下所有技能 SKILL.md 的 (skill, path, summary, 向量列表)。
    直接调 semantic_search 的 embedding 接口，不走库 —— 这样"哪个根"只影响扫描，不影响结果。"""
    import math
    old = ss.SKILLS_DIR
    try:
        ss.SKILLS_DIR = root
        docs = ss.scan_skill_docs()
    finally:
        ss.SKILLS_DIR = old
    if not docs:
        return []
    vecs = []
    batch = 16
    for i in range(0, len(docs), batch):
        chunk = docs[i:i + batch]
        texts = []
        for d in chunk:
            try:
                body = ss._read_text(d[2])
            except Exception:
                body = ''
            texts.append((body or d[3] or d[1])[:600])
        out = ss.embed_texts(texts)
        if not out:
            return []
        vecs.extend(out)
    res = []
    for d, v in zip(docs, vecs):
        res.append((d[1], str(d[2]), d[3], v))
    return res


def search(ss, query):
    """在**多个根**里语义检索技能，合并去重后取 top N，输出 JSON。

    LU_SKILLS_ROOT 支持分号分隔多个根（如 "C:/a/skills;C:/b/skills"）。
    合并规则：同名技能（如两处都有 memory-skill）只保留分数最高的那条。
    直接对 SKILL.md 现算向量，不依赖检索库里存的是哪个根的条目 —— 避免"库里有旧根残留"
    或"另一个根的条目被 prune 删掉后就搜不到"这类耦合。
    """
    top = int(os.environ.get("LU_SKILL_TOP", "3") or 3)
    if not query:
        print(json.dumps({"ok": False, "error": "search 模式需要查询文本"}, ensure_ascii=False))
        return
    try:
        import numpy as _np  # noqa: F401
    except Exception:
        pass

    q = ss.embed_texts([query[:600]])
    if not q:
        print(json.dumps({"ok": False, "error": "向量服务不可用"}, ensure_ascii=False))
        return
    qv = q[0][:ss.EMBED_DIM]
    qn = ss._norm(qv)

    roots = [r.strip() for r in os.environ.get("LU_SKILLS_ROOT", "").split(";") if r.strip()]
    if not roots:
        roots = [ss.SKILLS_DIR]

    best = {}
    scanned = 0
    for root in roots:
        if not os.path.isdir(root):
            continue
        for name, path, summary, vec in _skill_vectors(ss, root):
            scanned += 1
            v = vec[:ss.EMBED_DIM]
            vn = ss._norm(v)
            score = sum(a * b for a, b in zip(v, qv)) / (vn * qn or 1e-9)
            prev = best.get(name)
            if prev is None or score > prev["score"]:
                best[name] = {"id": "SKILL:" + name, "skill": name,
                              "summary": summary or "", "score": round(float(score), 4),
                              "root": root}
    if not best:
        print(json.dumps({"ok": False, "error": "技能扫描为空（根：%s）" % ";".join(roots)}, ensure_ascii=False))
        return
    hits = sorted(best.values(), key=lambda h: -h["score"])[:max(1, top)]
    print(json.dumps({"ok": True, "top": top, "scanned": scanned,
                      "roots": roots, "hits": hits}, ensure_ascii=False))


def status(ss, skill):
    rows = ss.skill_index_status(skill)
    if not rows:
        print("[无] 技能 '%s' 尚未索引任何文档" % skill if skill else "[无] 技能检索库为空")
        return
    if skill:
        print("[OK] 技能 '%s' 已索引 %d 篇：" % (skill, len(rows)))
        for r in rows:
            print("  %s | %s" % (r[0], str(r[2]).split("?root=")[0]))
    else:
        from collections import Counter
        cnt = Counter(r[1] for r in rows)
        print("[OK] 技能检索库共 %d 篇，%d 个技能：" % (len(rows), len(cnt)))
        for name, n in sorted(cnt.items()):
            print("  %s: %d 篇" % (name, n))


if __name__ == "__main__":
    main()
