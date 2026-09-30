# -*- coding: utf-8 -*-
"""
流变·记忆 全量只读导出（供家族树治理：银杏筛 tag / 清洗内容 / 构建树）
================================================
只读，不写库。产物：
  <out>/<工作区>/Dxxxx.md      每篇日记一个文件（frontmatter：id/日期/全部标签/摘要 + 正文）
  <out>/_meta/tags.json       标签 → {count, entries[]}（tag 清洗与筛选的原始数据）
  <out>/_meta/tags.md         同上的 Markdown 视图（按使用次数降序）
  <out>/_meta/stats.json      规模统计（总量/工作区分布/长尾占比）

用法：
  python wiki_export.py --out E:\\DSH_data\\流变系统\\data\\wiki_export_20261001
环境：LU_DB 指向 liubian.db（缺省 E:\\DSH_data\\.memory_registry\\liubian.db）
"""
import os, sys, json, sqlite3, argparse, collections, datetime

DEFAULT_DB = r"E:\DSH_data\.memory_registry\liubian.db"
NOW = datetime.datetime.now()


def safe_name(s):
    for ch in '\\/:*?"<>|':
        s = s.replace(ch, "_")
    return s.strip() or "_"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, help="导出目标目录")
    ap.add_argument("--db", default=os.environ.get("LU_DB", DEFAULT_DB))
    args = ap.parse_args()
    outdir = args.out
    metadir = os.path.join(outdir, "_meta")
    os.makedirs(metadir, exist_ok=True)

    conn = sqlite3.connect(args.db, timeout=30)

    # ── 1. 按条目聚合标签（一篇多标签 → 一个集合，写文件只写一次） ──
    # index:% 值 = {"index": {tag_name: [{id,date,summary}, ...], ...}} —— 需取内层
    diary_tags = collections.defaultdict(set)  # (ws, did) → {tag,...}
    for (key, val) in conn.execute("SELECT key, value FROM docs WHERE key LIKE 'index:%'"):
        ws = key.split(":", 1)[1]
        idx = json.loads(val).get("index", {})
        for tag, entries in idx.items():
            for e in entries:
                eid = e["id"] if isinstance(e, dict) else str(e)
                diary_tags[(ws, eid)].add(tag)

    # ── 2. 按工作区写 Markdown（每篇一次） ──
    ws_stats = collections.Counter()
    n_files = 0
    for (ws, did), tags in sorted(diary_tags.items()):
        wsdir = os.path.join(outdir, safe_name(ws))
        os.makedirs(wsdir, exist_ok=True)
        row = conn.execute(
            "SELECT content FROM diary_content WHERE workspace=? AND diary_id=?",
            (ws, did)).fetchone()
        content = (row[0] if row else "") or "(正文缺失)"
        # 从正文头提取日期（若无索引日期则留空）
        m = None
        for line in content.split("\n")[:8]:
            if "- **时间**" in line or "- **日期**" in line:
                import re
                dm = re.search(r"(20\d{2})-(\d{2})-(\d{2})", line)
                if dm:
                    m = dm.group(0)
                    break
        # 摘要从正文尾部"摘要:"行提取
        summ = ""
        for line in reversed(content.split("\n")):
            if line.startswith("> 摘要"):
                summ = line.lstrip("> ").replace("摘要: ", "", 1).strip()
                break
        tagstr = "、".join(sorted(tags))
        slug = safe_name(did)
        fp = os.path.join(wsdir, f"{slug}.md")
        with open(fp, "w", encoding="utf-8") as f:
            f.write(f"---\nid: {did}\nworkspace: {ws}\ndate: {m or ''}\n")
            f.write(f"tags: [{tagstr}]\nsummary: {summ}\n---\n\n")
            f.write(content)
        ws_stats[ws] += 1
        n_files += 1

    # ── 3. 标签清单（从聚合后的真实标签-条目关系生成） ──
    tag_usage = collections.Counter()
    tag_entries_map = collections.defaultdict(list)
    for (ws, did), tags in diary_tags.items():
        for t in tags:
            tag_usage[t] += 1
            tag_entries_map[t].append({"ws": ws, "id": did})
    tags_sorted = sorted(tag_usage.items(), key=lambda x: -x[1])
    tags_json = {t: {"count": c, "entries": tag_entries_map[t][:50]} for t, c in tags_sorted}
    with open(os.path.join(metadir, "tags.json"), "w", encoding="utf-8") as f:
        json.dump(tags_json, f, ensure_ascii=False, indent=1)

    # ── 4. 统计 ──
    distinct = len(tag_usage)
    once = sum(1 for v in tag_usage.values() if v <= 1)
    le2 = sum(1 for v in tag_usage.values() if v <= 2)
    stats = {
        "exported_at": NOW.strftime("%Y-%m-%d %H:%M:%S"),
        "diaries_total": sum(ws_stats.values()),
        "workspaces": len(ws_stats),
        "ws_breakdown": dict(ws_stats),
        "tags_distinct": distinct,
        "tags_used_once": once,
        "tags_used_once_pct": round(once / max(distinct, 1) * 100, 1),
        "tags_le2": le2,
        "tags_le2_pct": round(le2 / max(distinct, 1) * 100, 1),
        "md_files_written": n_files,
        "note": "只读导出，库未被修改。tag 清洗和树构建的原始数据在 tags.json / tags.md",
    }
    with open(os.path.join(metadir, "stats.json"), "w", encoding="utf-8") as f:
        json.dump(stats, f, ensure_ascii=False, indent=1)

    # ── 5. tags.md 概览 ──
    with open(os.path.join(metadir, "tags.md"), "w", encoding="utf-8") as f:
        f.write(f"# 标签清单（{NOW:%Y-%m-%d}）\n\n")
        f.write(f"- 不同标签：{distinct}\n- 只用 1 次：{once}（{once/max(distinct,1)*100:.0f}%）\n- ≤2 次：{le2}（{le2/max(distinct,1)*100:.0f}%）\n\n")
        f.write("## 按使用次数降序 Top 200\n\n| # | 标签 | 使用次数 |\n|---|---|---|\n")
        for i, (t, c) in enumerate(tags_sorted[:200], 1):
            f.write(f"| {i} | {t} | {c} |\n")
        f.write("\n## 长尾样本（只用 1 次，前 100 个）\n\n")
        tail = [t for t, c in tag_usage.items() if c <= 1][:100]
        f.write("、".join(tail) + "\n")

    print(f"导出完成：{outdir}")
    print(f"  日记 {sum(ws_stats.values())} 篇 / {len(ws_stats)} 工作区 / 标签 {distinct}")
    print(f"  md 文件 {n_files} / stats.json / tags.json / tags.md 在 _meta/")
    conn.close()


if __name__ == "__main__":
    main()
