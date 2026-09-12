# -*- coding: utf-8 -*-
"""技能文档语义索引（只索引每个技能的 SKILL.md 总揽）。

用法:  python skill_index.py <index|all|status> [skill]
环境:  LU_SCRIPTS      = memory-skill/scripts（semantic_search.py 所在目录）
       LU_SKILLS_ROOT  = 可选，覆盖扫描根目录（默认用 semantic_search.SKILLS_DIR）
输出:  人类可读文本

LU_SKILLS_ROOT 用来把 DSH 侧技能目录也纳入检索（DSH 技能装在
~/.dsh/skills 而不是 ~/.codex/skills）。注意检索库的文档 id 是
"SKILL:<技能文件夹名>"，两端同名技能会互相覆盖，按需指定即可。
"""
import os
import sys


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    mode = (sys.argv[1] if len(sys.argv) > 1 else "status").strip().lower()
    skill = sys.argv[2].strip() if len(sys.argv) > 2 else ""

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
        if not skill:
            print("[错误] index 模式需要 skill 参数（技能文件夹名）")
            return
        r = ss.index_skill(skill)
        if r is None:
            print("[错误] 向量服务不可用，技能 '%s' 未索引（服务恢复后搜索会自动补索引）" % skill)
            return
        new, total = r
        print("[OK] 技能 '%s' 索引完成：新增/变更 %d 篇，共 %d 篇" % (skill, new, total))
    elif mode == "all":
        r = ss.ensure_skill_index()
        if r is None:
            print("[错误] 向量服务不可用")
            return
        new, total = r
        print("[OK] 全量索引：新增/变更 %d 篇，总文档 %d 篇" % (new, total))
    else:
        rows = ss.skill_index_status(skill)
        if not rows:
            print("[无] 技能 '%s' 尚未索引任何文档" % skill if skill else "[无] 技能检索库为空")
            return
        if skill:
            print("[OK] 技能 '%s' 已索引 %d 篇：" % (skill, len(rows)))
            for r in rows:
                print("  %s | %s" % (r[0], r[2]))
        else:
            from collections import Counter
            cnt = Counter(r[1] for r in rows)
            print("[OK] 技能检索库共 %d 篇，%d 个技能：" % (len(rows), len(cnt)))
            for name, n in sorted(cnt.items()):
                print("  %s: %d 篇" % (name, n))


if __name__ == "__main__":
    main()
