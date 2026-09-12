# -*- coding: utf-8 -*-
"""MCP: 技能文档索引（把技能 SKILL.md / .md 蒸馏文档加入语义检索库）

创建新的文档型技能后，调用 index_skill 即可把它加入检索，之后写作/问答时
语义检索会自动命中该技能的风格包/蒸馏文档。
"""
import sys
sys.path.insert(0, r"C:\Users\Feng\.codex\skills\memory-skill\scripts")

from mcp.server.fastmcp import FastMCP
import semantic_search as ss

mcp = FastMCP(
    "mcp-skill-index",
    instructions=(
        "技能文档索引服务。创建新的文档型技能后调用 index_skill 把它加入语义检索库；"
        "index_all_skills 全量增量刷新；skill_index_status 查看已索引文档。"),
)


@mcp.tool()
def index_skill(skill: str) -> str:
    """定向索引一个技能的文档（SKILL.md + 技能内 .md 蒸馏文件）到语义检索库。skill 为技能文件夹名（如 makeine-losing-heroine）。创建新的文档型技能后调用它。"""
    r = ss.index_skill(skill)
    if r is None:
        return f"[错误] 向量服务不可用，技能 '{skill}' 未索引（之后搜索时会自动补索引）"
    new, total = r
    return f"[OK] 技能 '{skill}' 索引完成：新增/变更 {new} 篇，共 {total} 篇"


@mcp.tool()
def index_all_skills() -> str:
    """全量增量刷新所有技能的文档索引（只处理新增/变更/删除）。"""
    r = ss.ensure_skill_index()
    if r is None:
        return "[错误] 向量服务不可用"
    new, total = r
    return f"[OK] 全量索引：新增/变更 {new} 篇，总文档 {total} 篇"


@mcp.tool()
def skill_index_status(skill: str = "") -> str:
    """查看技能检索库已索引文档。skill 为空时返回全部技能统计。"""
    rows = ss.skill_index_status(skill)
    if not rows:
        return f"[无] 技能 '{skill}' 尚未索引任何文档" if skill else "[无] 技能检索库为空"
    if skill:
        lines = [f"{r[0]} | {r[2]}" for r in rows]
        return f"[OK] 技能 '{skill}' 已索引 {len(rows)} 篇：\n" + "\n".join(lines)
    from collections import Counter
    cnt = Counter(r[1] for r in rows)
    lines = [f"{name}: {n} 篇" for name, n in sorted(cnt.items())]
    return f"[OK] 技能检索库共 {len(rows)} 篇，{len(cnt)} 个技能：\n" + "\n".join(lines)


if __name__ == "__main__":
    from mcp_guard import start as _guard
    _guard()
    mcp.run(transport="stdio")
