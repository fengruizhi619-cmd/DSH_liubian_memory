# -*- coding: utf-8 -*-

import json, re, sys, datetime, hashlib
from memory_db import get_doc, set_doc, get_users, save_users, get_board, save_board, get_workspace_index, save_workspace_index, get_workspace_tags, save_workspace_tags, get_workspace_cooccurrence, save_workspace_cooccurrence, keys_with_prefix, get_diary_content, set_diary_content
from pathlib import Path
MEMORY_DIR = Path.cwd() / "memory"
GLOBAL_DIR = Path("E:/DSH_data/.memory_registry")
GLOBAL_DIR.mkdir(parents=True, exist_ok=True)
TAGS_FILE = MEMORY_DIR / "tags.json"
INDEX_FILE = MEMORY_DIR / "index.json"
COOCCUR_FILE = MEMORY_DIR / "cooccurrence.json"
USERS_FILE = GLOBAL_DIR / "users.json"
CURRENT_USER_FILE = MEMORY_DIR / ".current_user"
DIARIES_DIR = MEMORY_DIR / "diaries"
MSG_BOARD_FILE = GLOBAL_DIR / "message_board.json"
KOTATSU_DIR = GLOBAL_DIR / "kotatsu_rooms"
KOTATSU_SCHEDULE_FILE = GLOBAL_DIR / "kotatsu_schedule.json"
TRACKER_PY = r"C:/Users/Feng/.codex/skills/auto-updater/scripts/tracker.py"
KOTATSU_HOOKS_FILE = GLOBAL_DIR / "kotatsu_hooks.json"
DIARY_INTERVAL = 10  # 被炉每10条消息提醒创始人记日记


def ensure_dirs():
    """纯数据库模式：不再创建工作区 memory 目录（数据全在 SQLite）"""
    return


def _doc_key_for(path):
    """核心记忆文件 -> SQLite 文档 key；返回 None 表示继续用 JSON 文件"""
    path = Path(path)
    if path == USERS_FILE:
        return "users"
    if path == MSG_BOARD_FILE:
        return "board"
    if path.parent == KOTATSU_DIR and path.suffix == ".json":
        return "kotatsu_room:" + path.stem
    if path == KOTATSU_SCHEDULE_FILE:
        return "kotatsu_schedule"
    if path == KOTATSU_HOOKS_FILE:
        return "kotatsu_hooks"
    _ws = Path.cwd().name
    if path == INDEX_FILE:
        return "index:" + _ws
    if path == TAGS_FILE:
        return "tags:" + _ws
    if path == COOCCUR_FILE:
        return "cooccurrence:" + _ws
    return None


def load_json(path, default=None):
    k = _doc_key_for(path)
    if k is not None:
        v = get_doc(k, None)
        return v if v is not None else (default if default is not None else {})
    if path.exists():
        with open(path, "r", encoding="utf-8-sig") as f:
            return json.load(f)
    return default if default is not None else {}


def save_json(path, data, backup=True):
    """核心记忆文件写入 SQLite；其余文件沿用原子写 + 自动备份"""
    k = _doc_key_for(path)
    if k is not None:
        set_doc(k, data)
        return
    """原子写 + 自动备份 (防多智能体并发读写竞争清空共享房间文件)"""
    import shutil, time, os as _os
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if backup and path.exists() and path.stat().st_size > 0:
        try:
            bak = path.with_name(path.name + ".bak_%d" % int(time.time() * 1000))
            shutil.copy2(str(path), str(bak))
            baks = sorted(path.parent.glob(path.name + ".bak_*"))
            for old in baks[:-8]:
                try:
                    old.unlink()
                except OSError:
                    pass
        except OSError:
            pass
    tmp = path.with_name(path.name + ".tmp_%d_%d" % (_os.getpid(), int(time.time() * 1000)))
    with open(str(tmp), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    # Windows 下目标文件可能被其他智能体进程短暂占用: 重试替换
    ok = False
    for _ in range(10):
        try:
            _os.replace(str(tmp), str(path))
            ok = True
            break
        except OSError:
            time.sleep(0.3)
    if not ok:
        # 兜底: 直接复制覆盖 (仅极端锁定时)
        try:
            shutil.copy2(str(tmp), str(path))
        except OSError as _e:
            print("[save_json] 写入失败: %s" % _e)


def get_next_id():
    idx = load_json(INDEX_FILE, {"index": {}})
    nums = []
    for _tag, items in idx.get("index", {}).items():
        for it in items:
            m = re.match(r"^D(\d+)$", str(it.get("id", "")))
            if m:
                nums.append(int(m.group(1)))
    return f"D{max(nums) + 1:04d}" if nums else "D0001"


def get_user_key(username):
    users = load_json(USERS_FILE, {"users": {}})
    user = users.get("users", {}).get(username)
    if user:
        return user.get("last_key", "")
    return ""


def set_user_key(username, key, created_id=""):
    users = load_json(USERS_FILE, {"users": {}})
    if "users" not in users:
        users["users"] = {}
    if username not in users["users"]:
        users["users"][username] = {"created": "", "created_id": "", "last_key": ""}
    users["users"][username]["last_key"] = key
    if created_id:
        users["users"][username]["created_id"] = created_id
        users["users"][username]["created"] = datetime.date.today().isoformat()
    save_json(USERS_FILE, users)


FLOWER_NAMES = {
    "梅花", "牡丹", "荷花", "兰花", "菊花", "桂花", "茉莉", "杜鹃",
    "水仙", "蔷薇", "海棠", "山茶", "百合", "紫藤", "玫瑰", "莲花",
    "桃花", "杏花", "梨花", "樱花", "月季", "芍药", "丁香", "郁金香",
    "康乃馨", "鸢尾", "铃兰", "风信子", "向日葵", "薰衣草", "栀子", "米兰",
    "木棉", "玉兰", "含笑", "瑞香", "迎春", "连翘", "碧桃", "紫薇",
    "木槿", "芙蓉", "琼花", "辛夷", "忍冬", "金银花", "凌霄", "紫荆",
    "合欢", "石榴花", "睡莲", "凤仙", "鸡冠花", "千日红", "雏菊", "金盏",
    "翠菊", "波斯菊", "矢车菊", "石竹", "满天星", "勿忘我", "番红花", "绣球"
}

def check_flower_name(username):
    if username in FLOWER_NAMES:
        return None
    non_flower = ["codex", "bot", "测试", "操作员", "智能体", "admin", "user", "模型"]
    ul = username.lower()
    for p in non_flower:
        if p in ul:
            return True
    return None


def user_exists(username):
    users = load_json(USERS_FILE, {"users": {}})
    return username in users.get("users", {})


def get_current_user():
    return get_doc("current_user:" + Path.cwd().name, "") or ""

def set_current_user(username):
    set_doc("current_user:" + Path.cwd().name, username)

def clear_current_user():
    set_doc("current_user:" + Path.cwd().name, "")


def cmd_register(username, password="", free=False):
    if not username:
        print("错误: --name 是必填参数")
        return
    if not free:
        if not password:
            print("错误: --password 是必填参数，请设置8位数字密码（免密账户用 --free）")
            return
        if not (len(password) == 8 and password.isdigit()):
            print("错误: 密码必须为8位数字")
            return
        if password == "00000000":
            print("错误: 密码不能为默认密码 00000000")
            return
        # 花名校验：仅对普通账户生效，免密账户（真人用户）不受花朵名限制
        if username not in FLOWER_NAMES:
            print(f"错误: 用户名 '{username}' 不是花朵中文名，请使用花朵中文名（如 梅花、牡丹、茉莉）")
            return
    users = load_json(USERS_FILE, {"users": {}})
    if username in users.get("users", {}):
        print(f"错误: 用户 '{username}' 已存在")
        return
    WORKSPACE = Path.cwd().name
    did = get_next_id()
    today = datetime.date.today().isoformat()
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    body = f"# Diary {did}\n\n- **时间**: {now}\n- **日期**: {today}\n- **用户**: {username}\n- **标签**: 注册\n\n---\n\n用户 {username} 注册成功，开始记录记忆。\n\n---\n\n> 摘要: 用户 {username} 注册"
    set_diary_content(Path.cwd().name, did, body)
    key = hashlib.sha256((did + body + now).encode("utf-8")).hexdigest()[:16]
    set_user_key(username, key, did)
    # 记录注册工作区+密码哈希
    users = load_json(USERS_FILE, {"users": {}})
    if username in users.get("users", {}):
        users["users"][username]["home"] = WORKSPACE
        users["users"][username]["pwd"] = hashlib.sha256(password.encode()).hexdigest() if not free else ""
        save_json(USERS_FILE, users)
    idx = load_json(INDEX_FILE, {"index": {}})
    entry = {"id": did, "date": today, "summary": f"用户 {username} 注册",
             "path": f"diaries/{did}.md", "type": "log", "key": key, "user": username}
    tag = "注册"
    if "index" not in idx:
        idx["index"] = {}
    if tag not in idx["index"]:
        idx["index"][tag] = []
    idx["index"][tag].append(entry)
    save_json(INDEX_FILE, idx)
    print(f"[OK] 用户 '{username}' 注册成功")
    if free:
        print("  [免密账户] 无需密码即可登录与发言，仅供真人用户使用")
    else:
        print(f"  [密码规则] 8位数字，请牢记密码，后续登录需要")
        if password == "00000000":
            print(f"  [!] 警告：当前使用初始密码 00000000，请及时修改")
        if username not in FLOWER_NAMES:
            print("  [!] 提示：请用花朵的中文名作为用户名（如 梅花、牡丹、茉莉），不要随意取名")
    print(f"[OK] {did} [KEY: {key}]")


def cmd_tags():
    tags_data = load_json(TAGS_FILE, {"tags": {}})
    tags = tags_data.get("tags", {})
    if not tags:
        print("(暂无标签)")
        return
    for tag, info in sorted(tags.items()):
        c = info["count"]
        cr = info.get("created", "?")
        print(f"#{tag}  (使用{c}次，创建于{cr})")



def load_cooccurrence():
    """全局共现表（跨全部工作区合并，供搜索 tag 扩展用）"""
    from memory_db import get_cooccurrence_all
    data = get_cooccurrence_all()
    co = data.get("cooccurrence_weighted", data.get("cooccurrence", {}))
    return co, data.get("tag_total", {})

def expand_tags(input_tags, max_total=8, min_total=8):
    cooccur, tag_total = load_cooccurrence()
    if not cooccur:
        return input_tags
    result = list(input_tags)
    seen = set(result)
    # For each input tag, add its top co-occurring tags
    for tag in input_tags:
        if tag in cooccur:
            for rel in cooccur[tag]:
                if len(result) >= max_total:
                    break
                if rel['tag'] not in seen:
                    result.append(rel['tag'])
                    seen.add(rel['tag'])
        if len(result) >= max_total:
            break
    # Still need more? weighted expansion from matched tags + popular fallback
    if len(result) < min_total:
        scores = {}
        for t in result:
            if t in cooccur:
                for rel in cooccur[t]:
                    if rel['tag'] not in seen:
                        w = rel.get('weight', rel.get('count', 0) / max(tag_total.get(t, 1), 1))
                        scores[rel['tag']] = scores.get(rel['tag'], 0) + w
        if scores:
            for t, _ in sorted(scores.items(), key=lambda x: -x[1]):
                if len(result) >= min_total:
                    break
                result.append(t)
                seen.add(t)
        # If still not enough or no cooccur data, use globally most common tags
        if len(result) < min_total and tag_total:
            popular = sorted(tag_total.items(), key=lambda x: -x[1])
            for t, _ in popular:
                if len(result) >= min_total:
                    break
                if t not in seen:
                    result.append(t)
                    seen.add(t)
    return result

def cmd_search(tags_str, search_key="", username="", password=""):
    if username and not user_exists(username):
        print(f"错误: 用户 '{username}' 不存在，请先 register")
        return
    if username and username not in FLOWER_NAMES:
        print(f"  [!] 用户名 '{username}' 不是花朵中文名，请用 rename 命令改名（如 梅花、牡丹、茉莉）")
        return
    # 密码验证（全局检索已放开工作区限制，但仍需密码+KEY 登录）
    if username:
        users = load_json(USERS_FILE, {"users": {}})
        user = users.get("users", {}).get(username, {})
        stored_pwd = user.get("pwd", "")
        if stored_pwd:
            if not password:
                print(f"错误: 用户 '{username}' 需要 --password 参数")
                return
            if hashlib.sha256(password.encode()).hexdigest() != stored_pwd:
                print(f"错误: 密码错误，无法以 '{username}' 搜索")
                return
    # 全局检索：跨全部工作区搜日记（不再按工作区划分）
    if username:
        latest_key = get_user_key(username)
        if latest_key:
            if not search_key:
                print(f"错误: 用户 '{username}' 需要 --key 参数登录")
                return
            if search_key != latest_key:
                print(f"错误: 密钥不匹配（用户: {username}）")
                print(f"期望: {latest_key[:16]}...")
                print(f"收到: {search_key[:16]}...")
                return
    else:
        latest_key = load_json(INDEX_FILE, {"index": {}}).get("last_key", "")
        users_data = load_json(USERS_FILE, {"users": {}})
        has_users = len(users_data.get("users", {})) > 0
        if has_users and not latest_key:
            print("错误: 密钥已过期，请先 write 刷新或使用 --user <用户名> --key <KEY> 登录")
            return
        if latest_key and not search_key:
            print("错误: 需要 --key 参数")
            return
        if latest_key and search_key != latest_key:
            print("错误: 密钥不匹配")
            return

    if not tags_str:
        print("请指定标签")
        return
    raw_tags = [t.strip() for t in tags_str.split(",")]
    if len(raw_tags) < 4:
        print(f'错误: 搜索需要至少4个标签（当前{len(raw_tags)}个），请补充后重试')
        return
    # ---- 全局索引/标签字典（跨工作区）----
    from memory_db import get_workspace_index_all, find_diary_workspaces
    ws_index = get_workspace_index_all()  # {工作区: {tag: [entry,...]}}
    tag_index_merged = {}
    for _idx in ws_index.values():
        for tag, entries in _idx.items():
            tag_index_merged.setdefault(tag, []).extend(entries)
    all_known_tags = list(tag_index_merged.keys())
    fuzzy_raw = []
    for rt in raw_tags:
        if rt in all_known_tags:
            fuzzy_raw.append(rt)
        else:
            matches = [t for t in all_known_tags if rt in t]
            rev_matches = [t for t in all_known_tags if t in rt and t not in matches]
            matches.extend(rev_matches)
            if matches:
                fuzzy_raw.extend(matches)
                print(f'  [!] "{rt}" 未精确匹配，自动扩展为: {",".join(matches)}')
            else:
                fuzzy_raw.append(rt)
    target_tags = expand_tags(fuzzy_raw)
    raw_tags_set = set(fuzzy_raw)
    # tag 候选 key=(workspace, diary_id)（跨区 id 可重复，必须带工作区）
    candidates = {}
    for ws, idx in ws_index.items():
        for tag in target_tags:
            for entry in idx.get(tag, []):
                key = (ws, entry["id"])
                if key not in candidates:
                    candidates[key] = {"entry": entry, "ws": ws,
                                       "match_count": 0, "tags_match": []}
                candidates[key]["match_count"] += 1
                candidates[key]["tags_match"].append(tag)
    # ----- 全局语义向量检索 -----
    sem_hits = None
    sem_indexed = 0
    try:
        from semantic_search import (index_all, index_pending_global,
                                     search_semantic_global, service_alive,
                                     count_indexed_global)
        if service_alive():
            pend = index_pending_global()
            if pend:
                print(f"语义检索: 增量索引 {pend} 篇缺失向量...")
            index_all(progress=False)
            sem_indexed = count_indexed_global()
            sem_hits = search_semantic_global(" ".join(raw_tags))
    except Exception:
        sem_hits = None
    # 技能风格包/蒸馏 语义检索（跨工作区全局）
    skill_hits = None
    try:
        from semantic_search import ensure_skill_index, search_skills
        ensure_skill_index()
        skill_hits = search_skills(" ".join(raw_tags), top=8)
    except Exception:
        skill_hits = None
    MAX_RESULTS = 50
    id2entry = {}
    for ws, idx in ws_index.items():
        for entries in idx.values():
            for e in entries:
                id2entry.setdefault((ws, e["id"]), e)
    tag_pool = [c for c in candidates.values()
                if any(t in raw_tags_set for t in c["tags_match"])]
    sem_map = {(w, i): s for w, i, s in (sem_hits or [])}
    union = {}
    for c in tag_pool:
        union[(c["ws"], c["entry"]["id"])] = {
            "entry": c["entry"], "ws": c["ws"], "match_count": c["match_count"],
            "tags_match": c["tags_match"], "sem": sem_map.get((c["ws"], c["entry"]["id"]), 0.0)}
    if sem_hits:
        for ws, did, s in sem_hits:
            if (ws, did) not in union:
                union[(ws, did)] = {
                    "entry": id2entry.get((ws, did), {"id": did, "date": "?", "ws": ws,
                                                      "summary": "(语义命中，无索引元数据)"}),
                    "ws": ws, "match_count": 0, "tags_match": [], "sem": s}
    lt = len(target_tags)
    if union:
        def fused(v):
            tag_ratio = (v["match_count"] / lt) if lt else 0.0
            sem_n = min(1.0, max(0.0, v["sem"]))
            return 0.5 * tag_ratio + 0.5 * sem_n
        sc = sorted(union.values(),
                    key=lambda v: (-fused(v), v["entry"].get("date", "")))
    else:
        sc = []
    total_cnt = len(sc)
    if total_cnt > MAX_RESULTS:
        sc = sc[:MAX_RESULTS]
    user_info = f" (登录: {username})" if username else ""
    print(f"检索标签: {','.join(target_tags)}{user_info}")
    print(f"检索范围: 全局（{len(ws_index)} 个工作区）")
    if sem_hits:
        print(f"语义检索: 已启用(向量 {sem_indexed} 篇, 融合 tag+语义)")
    else:
        print(f"语义检索: 不可用(回退纯tag)")
    if not sc:
        print("(未找到匹配的日记)")
        return
    if total_cnt > MAX_RESULTS:
        print(f"共 {total_cnt} 篇相关日记 (显示前 {MAX_RESULTS} 篇):")
    else:
        print(f"共 {total_cnt} 篇相关日记:")
    for c in sc:
        e = c["entry"]
        t = ",".join(c["tags_match"]) or "(语义命中)"
        ei = e.get("id", "?")
        ws = c.get("ws", e.get("ws", ""))
        ed = e.get("date", "?")
        cm = c["match_count"]
        es = e.get("summary", "无摘要")
        us = e.get("user", "")
        user_tag = f" [{us}]" if us else ""
        sem_note = f" 语义{c['sem']:.2f}" if c["sem"] > 0 else ""
        tag_id = f"{ei}@{ws}" if ws else ei
        print(f"  [{tag_id}]{user_tag} | {ed} [{cm}/{lt}标签]{sem_note}")
        print(f"  标签: {t}")
        try:
            print(f"  摘要: {es}")
        except UnicodeEncodeError:
            print(f"  摘要: [摘要包含非GBK字符]")
    if skill_hits:
        print(f"技能检索: 命中 {len(skill_hits)} 篇风格包/蒸馏")
        for did, name, summary, sc in skill_hits:
            print(f"  [{did}] 语义{sc:.2f} | {name}")
            if summary:
                print(f"  摘要: {summary[:120]}")


def cmd_read(diary_ids_str):
    """跨工作区读取：支持 Dxxxx 或 Dxxxx@工作区；Dxxxx 自动定位"""
    ids = [x.strip() for x in diary_ids_str.replace(",", " ").split() if x.strip()]
    _cwd_ws = Path.cwd().name
    from memory_db import find_diary_workspaces
    for i, token in enumerate(ids):
        if i > 0:
            print("---")
        diary_id, ws_spec = token, None
        if "@" in token:
            diary_id, ws_spec = token.rsplit("@", 1)
        ws_list = find_diary_workspaces(diary_id)
        target = None
        if ws_spec:
            target = ws_spec if ws_spec in ws_list else None
        elif _cwd_ws in ws_list:
            target = _cwd_ws
        elif len(ws_list) == 1:
            target = ws_list[0]
        if not target:
            if ws_list:
                print(f"未找到日记 {token}（跨 {len(ws_list)} 个工作区: {','.join(ws_list)}，请用 Dxxxx@工作区 指定）")
            else:
                print(f"未找到日记 {token}")
            continue
        content = get_diary_content(target, diary_id)
        if content is not None:
            print(content.rstrip())
            continue
        if target == _cwd_ws:
            p = DIARIES_DIR / f"{diary_id}.md"
            if p.exists():
                with open(p, "r", encoding="utf-8-sig") as f:
                    print(f.read().rstrip())
                continue
        print(f"未找到日记 {token}")


def rebuild_cooccurrence():
    """从当前工作区的index.json重建共现表"""
    from collections import defaultdict
    idx = load_json(INDEX_FILE, {"index": {}}).get("index", {})
    if not idx:
        return
    diary_tags = defaultdict(set)
    for tag, entries in idx.items():
        for entry in entries:
            diary_tags[entry["id"]].add(tag)
    cooccur = defaultdict(lambda: defaultdict(int))
    tag_total = defaultdict(int)
    for diary_id, tags in diary_tags.items():
        tags = sorted(tags)
        for t in tags:
            tag_total[t] += 1
        for i in range(len(tags)):
            for j in range(i+1, len(tags)):
                a, b = tags[i], tags[j]
                cooccur[a][b] += 1
                cooccur[b][a] += 1
    cooccur_weighted = {}
    for tag, related in cooccur.items():
        total = tag_total.get(tag, 1)
        ranked = []
        for rel_tag, co_cnt in related.items():
            weight = co_cnt / total
            ranked.append({'tag': rel_tag, 'count': co_cnt, 'weight': round(weight, 3)})
        ranked.sort(key=lambda x: -x['weight'])
        cooccur_weighted[tag] = ranked[:10]
    output = {'tag_total': dict(tag_total), 'cooccurrence_weighted': cooccur_weighted}
    save_json(COOCCUR_FILE, output)  # 走 SQLite 路由（纯数据库模式）

def cmd_write(tags_str, summary, content_text, kind="diary", username="", password=""):
    if username and not user_exists(username):
        print(f"错误: 用户 '{username}' 不存在，请先 register")
        return
    if username and username not in FLOWER_NAMES:
        print(f"  [!] 用户名 '{username}' 不是花朵中文名，请用 rename 命令改名（如 梅花、牡丹、茉莉）")
        return
    # 跨工作区拦截
    if username:
        users = load_json(USERS_FILE, {"users": {}})
        user = users.get("users", {}).get(username)
        if user and "home" in user and user["home"] != Path.cwd().name:
            print(f"错误: '{username}' 注册于 [{user['home']}]，不能从 [{Path.cwd().name}] 写入")
            return
    # 密码验证
    if username:
        users = load_json(USERS_FILE, {"users": {}})
        user = users.get("users", {}).get(username, {})
        stored_pwd = user.get("pwd", "")
        if stored_pwd:
            if not password:
                print(f"错误: 用户 '{username}' 需要 --password 参数")
                return
            if hashlib.sha256(password.encode()).hexdigest() != stored_pwd:
                print(f"错误: 密码错误，无法以 '{username}' 写入")
                return
    ensure_dirs()
    did = get_next_id()
    today = datetime.date.today().isoformat()
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    tl = [t.strip() for t in tags_str.split(",")] if tags_str else []
    if len(tl) < 5:
        print(f"错误: 至少需要5个标签，当前只有{len(tl)}个")
        return
    ts = ",".join(tl) if tl else "无"
    sum_str = str(summary or "")
    body = "# Diary " + did + "\n"
    body += "\n- **时间**: " + now + "\n"
    body += "- **日期**: " + today + "\n"
    body += "- **标签**: " + ts + "\n"
    if username:
        body += "- **用户**: " + username + "\n"
    body += "\n---\n\n" + content_text.strip()
    body += "\n\n---\n\n> 摘要: " + sum_str + "\n"
    set_diary_content(Path.cwd().name, did, body)  # 正文进 SQLite（纯数据库模式，不再写 .md）

    hash_input = did + body + now
    diary_key = hashlib.sha256(hash_input.encode("utf-8")).hexdigest()[:16]

    td = load_json(TAGS_FILE, {"tags": {}})
    tags = td.get("tags", {})
    for tag in tl:
        if tag in tags:
            tags[tag]["count"] += 1
        else:
            tags[tag] = {"count": 1, "created": today}
    save_json(TAGS_FILE, td)

    idx = load_json(INDEX_FILE, {"index": {}})
    index = idx.get("index", {})
    entry = {"id": did, "date": today, "summary": sum_str,
             "path": "diaries/" + did + ".md", "type": kind, "key": diary_key}
    if username:
        entry["user"] = username
    for tag in tl:
        if tag not in index:
            index[tag] = []
        index[tag].append(entry)

    if username:
        idx["last_key_" + username] = diary_key
        set_user_key(username, diary_key)
        idx["last_key"] = ""
    else:
        idx["last_key"] = diary_key
    save_json(INDEX_FILE, idx)

    user_info = f" [{username}]" if username else ""
    print(f"[OK] {did}{user_info} [KEY: {diary_key}]")
    rebuild_cooccurrence()


def load_board():
    return load_json(MSG_BOARD_FILE, {"messages": []})

def save_board(data):
    save_json(MSG_BOARD_FILE, data)

def get_next_msg_id(messages):
    if not messages:
        return "M0001"
    nums = [int(m["id"][1:]) for m in messages]
    return f"M{max(nums) + 1:04d}"

def verify_user_pwd(username, password):
    """验证用户密码；pwd 为空表示免密账户，直接放行"""
    if not username:
        return False
    users = load_json(USERS_FILE, {"users": {}})
    user = users.get("users", {}).get(username, {})
    stored_pwd = user.get("pwd", "")
    if not stored_pwd:
        return True  # 免密账户
    return hashlib.sha256(password.encode()).hexdigest() == stored_pwd

def cmd_post(from_user, password, to_user, content):
    """留言帖：给指定用户留消息"""
    if not from_user or not to_user or not content:
        print("错误: post 需要 -u <发送者> --password <密码> --to <接收者> --content <内容>")
        return
    if not user_exists(from_user):
        print(f"错误: 发送者 '{from_user}' 不存在")
        return
    if not user_exists(to_user):
        print(f"错误: 接收者 '{to_user}' 不存在")
        return
    if not verify_user_pwd(from_user, password):
        print(f"错误: 密码错误，无法以 '{from_user}' 身份发帖")
        return
    board = load_board()
    messages = board.get("messages", [])
    mid = get_next_msg_id(messages)
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    messages.append({
        "id": mid,
        "from": from_user,
        "to": to_user,
        "content": content,
        "time": now,
        "read": False
    })
    board["messages"] = messages
    save_board(board)
    print(f"[OK] 留言 {mid} 已发布: {from_user} -> {to_user} @ {now}")

def cmd_inbox(username, password, key):
    """查看发给我的留言（需密码+KEY登录）"""
    if not username:
        print("错误: inbox 需要 -u <用户名> --password <密码> --key <KEY>")
        return
    if not user_exists(username):
        print(f"错误: 用户 '{username}' 不存在")
        return
    if not verify_user_pwd(username, password):
        print(f"错误: 密码错误，无法登录 '{username}' 查收留言")
        return
    latest_key = get_user_key(username)
    if latest_key:
        if not key:
            print(f"错误: 用户 '{username}' 需要 --key 参数登录")
            return
        if key != latest_key:
            print(f"错误: 密钥不匹配（用户: {username}）")
            return
    board = load_board()
    messages = board.get("messages", [])
    mine = [m for m in messages if m["to"] == username]
    unread = [m for m in mine if not m["read"]]
    if not mine:
        print(f"[{username}] 没有留言")
        return
    if not unread:
        print(f"[{username}] 无新留言（已读 {len(mine)} 条）")
        return
    print(f"[{username}] 新留言 {len(unread)} 条:")
    for m in unread:
        print(f"  {m['id']} [未读] 来自 {m['from']} @ {m['time']}")
        print(f"    {m['content'][:200]}")
    # 查看后自动标记已读：已读留言不再推送为未读
    for m in unread:
        m["read"] = True
    board["messages"] = messages
    save_board(board)

def cmd_msg_read(msg_id):
    """标记留言为已读"""
    board = load_board()
    messages = board.get("messages", [])
    for m in messages:
        if m["id"] == msg_id:
            m["read"] = True
            board["messages"] = messages
            save_board(board)
            print(f"[OK] 留言 {msg_id} 已标记为已读")
            return
    print(f"错误: 留言 {msg_id} 不存在")

def load_kotatsu_room(room):
    KOTATSU_DIR.mkdir(parents=True, exist_ok=True)
    room_file = KOTATSU_DIR / f"{room}.json"
    default = {"room": room, "members": [], "messages": [], "todos": [],
               "next_id": 1, "next_todo": 1, "founder": "", "msg_since_diary": 0,
               "last_active": {}, "last_seen": {}}
    import time as _t, shutil as _sh
    bad = None
    if room_file.exists() and room_file.stat().st_size == 0:
        # 空文件 = 上次被截断: 先备份, 再尝试从最近 .bak 恢复
        bad = room_file.with_name(room_file.name + ".corrupt_%d" % int(_t.time()))
        try:
            _sh.copy2(str(room_file), str(bad))
        except OSError:
            pass
    data = None
    try:
        data = load_json(room_file, default)
    except Exception:
        data = None
    if not isinstance(data, dict) or not isinstance(data.get("messages"), list):
        # 解析异常/空: 备份损坏文件, 尝试从最近 .bak 恢复历史 (水仙#5: 读失败兜底读旧备份)
        if bad is None:
            bad = room_file.with_name(room_file.name + ".corrupt_%d" % int(_t.time()))
            try:
                _sh.copy2(str(room_file), str(bad))
            except OSError:
                pass
        # 选消息数最多的 .bak 恢复 (而非字典序最新的名字), 避免陈旧备份覆盖新消息
        baks = sorted(room_file.parent.glob(room_file.name + ".bak_*"), reverse=True)
        best_bk, best_max = None, -1
        for bk in baks:
            try:
                d = load_json(bk, default)
                if isinstance(d, dict) and isinstance(d.get("messages"), list):
                    mx = max([m.get("id", 0) for m in d["messages"]], default=0)
                    if mx > best_max:
                        best_bk, best_max = bk, mx
            except Exception:
                continue
        if best_bk is not None:
            try:
                data = load_json(best_bk, default)
                _sh.copy2(str(best_bk), str(room_file))  # 用备份覆盖损坏文件
                print("[load_kotatsu_room] 从备份恢复(消息最多): %s" % best_bk.name)
            except Exception:
                pass
        if data is None:
            data = default
    for k, v in default.items():
        if k not in data:
            data[k] = v
    return data, room_file

def save_kotatsu_room(room_file, data):
    save_json(room_file, data)

def kotatsu_lock(room_file, timeout=15):
    """跨进程文件锁（Windows msvcrt）：保护被炉房间文件读-改-写事务
    注意: 初始化读写与被锁持有都会抛 PermissionError/OSError, 统一进入等待重试."""
    import msvcrt, time as _t
    room_file = Path(room_file)
    lock_path = room_file.parent / (room_file.name + ".lock")
    deadline = _t.time() + timeout
    while True:
        lf = None
        try:
            lf = open(lock_path, "a+b")
            lf.seek(0)
            if lf.read(1) == b"":
                lf.write(b"0")
                lf.flush()
            lf.seek(0)
            msvcrt.locking(lf.fileno(), msvcrt.LK_NBLCK, 1)
            return lf
        except OSError:
            try:
                if lf is not None:
                    lf.close()
            except OSError:
                pass
            if _t.time() > deadline:
                raise TimeoutError("[kotatsu_lock] 房间文件锁超时: " + room_file.name)
            _t.sleep(0.05)


def kotatsu_unlock(lf):
    """释放被炉房间文件锁"""
    import msvcrt
    try:
        lf.seek(0)
        msvcrt.locking(lf.fileno(), msvcrt.LK_UNLCK, 1)
    except OSError:
        pass
    try:
        lf.close()
    except OSError:
        pass


def update_kotatsu_room(room, mutator):
    """事务化更新被炉房间：加锁→锁内重读→mutator修改→保存→解锁"""
    data, room_file = load_kotatsu_room(room)
    lf = kotatsu_lock(room_file)
    try:
        data, room_file = load_kotatsu_room(room)  # 锁内重读，避免lost update
        result = mutator(data)
        save_kotatsu_room(room_file, data)
        return result
    finally:
        kotatsu_unlock(lf)


def kotatsu_add_todo(data, from_user, content, msg_id, time_str):
    tid = data.get("next_todo", 1)
    data.setdefault("todos", []).append({"id": tid, "from": from_user, "content": content,
                                         "msg_id": msg_id, "time": time_str, "status": "pending"})
    data["next_todo"] = tid + 1
    return tid

def kotatsu_diary_reminder(data):
    """满10条消息：生成日记提醒给创始人；创始人离线则改选新创始人"""
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    recent = [m for m in data["messages"]][-DIARY_INTERVAL:]
    active = [m["from"] for m in recent if m.get("from") and m.get("from") not in ("管理员", "系统")]
    founder = data.get("founder") or ""
    if (not founder or founder not in active) and active:
        founder = active[-1]
        data["founder"] = founder
    mid = data["next_id"]
    content = ("【日记提醒】被炉已累计" + str(DIARY_INTERVAL) + "条消息，请创始人[" + (founder or "未指定") +
               "]记录日记（kotatsu diary --room <房间名> 标记完成并重置计数）")
    data["messages"].append({"id": mid, "from": "系统", "content": content, "time": now, "system": True})
    data["next_id"] = mid + 1
    data["msg_since_diary"] = 0
    return founder

def cmd_kotatsu_join(room, username, password):
    """加入或创建被炉房间（新房间自动弹出UI）"""
    if not room or not username:
        print("错误: kotatsu join 需要 --room <房间名> --user <用户名> --password <密码>")
        return
    if not verify_user_pwd(username, password):
        print(f"错误: 密码错误，无法以 '{username}' 身份加入")
        return
    room_file = KOTATSU_DIR / f"{room}.json"
    is_new = not room_file.exists()
    data, room_file = load_kotatsu_room(room)
    if is_new:
        data["founder"] = username
        data["created"] = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    def _mut(d):
        if username not in d["members"]:
            d["members"].append(username)
        return username in data["members"]
    is_member = update_kotatsu_room(room, _mut)
    data, _ = load_kotatsu_room(room)
    if not is_member:
        print(f"[OK] {username} 已加入被炉 [{room}]（成员: {','.join(data['members']) or '无'}）")
    else:
        print(f"[OK] {username} 已在被炉 [{room}]（成员: {','.join(data['members']) or '无'}）")
    if is_new:
        print("[OK] 新被炉创建，自动打开UI...")
        cmd_kotatsu_ui(room)


def cmd_kotatsu_send(room, username, password, message):
    """发送被炉消息；@管理员 自动生成待办；满10条消息提醒创始人记日记"""
    if not room or not username or not message:
        print("错误: kotatsu send 需要 --room <房间名> --user <用户名> --password <密码> --message <内容>")
        return
    if not verify_user_pwd(username, password):
        print(f"错误: 密码错误，无法以 '{username}' 身份发言")
        return
    def _mut(data):
        if username not in data["members"]:
            data["members"].append(username)
        mid = data["next_id"]
        now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        data["messages"].append({"id": mid, "from": username, "content": message, "time": now, "read_by": [username]})
        data.setdefault("last_active", {})[username] = now
        data.setdefault("last_seen", {})[username] = mid
        data["next_id"] = mid + 1
        data["msg_since_diary"] = data.get("msg_since_diary", 0) + 1
        todo_tid = None
        if "@管理员" in message or "＠管理员" in message:
            todo_tid = kotatsu_add_todo(data, username, message, mid, now)
        if data.get("msg_since_diary", 0) >= DIARY_INTERVAL:
            kotatsu_diary_reminder(data)
        return mid, now, todo_tid
    mid, now, todo_tid = update_kotatsu_room(room, _mut)
    print(f"[{username}] {now} #{mid}: {message}")
    if todo_tid:
        print(f"[待办] 已自动生成待办 #{todo_tid}（来自 {username} 的 @管理员）")
    data_after, _ = load_kotatsu_room(room)
    if data_after.get("msg_since_diary", 0) >= DIARY_INTERVAL:
        print(f"[日记提醒] 已满{DIARY_INTERVAL}条消息，提醒创始人[{data_after.get('founder') or '未指定'}]记录日记")


def cmd_kotatsu_poll(room, username, password, since=0):
    """查看被炉新消息（--since 之后的消息）"""
    if not room or not username:
        print("错误: kotatsu poll 需要 --room <房间名> --user <用户名> --password <密码>")
        return
    if not verify_user_pwd(username, password):
        print(f"错误: 密码错误，无法以 '{username}' 身份查看")
        return
    def _mut(data):
        now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        data.setdefault("last_active", {})[username] = now
        for m in data["messages"]:
            if m["id"] > since and username not in m.setdefault("read_by", []):
                m["read_by"].append(username)
        return None
    update_kotatsu_room(room, _mut)
    data, _ = load_kotatsu_room(room)
    messages = [m for m in data["messages"] if m["id"] > since]
    if not messages:
        print(f"[{room}] 无新消息")
        return
    print(f"[{room}] {len(messages)} 条新消息:")
    for m in messages:
        tag = "系统" if m.get("system") else m["from"]
        print(f"  {tag} {m['time']} #{m['id']}: {m['content']}")


def cmd_kotatsu_listen(room, username, password, timeout=120):
    """实时监听模式：等待新消息，收到后退出"""
    if not room or not username:
        print("错误: kotatsu listen 需要 --room <房间名> --user <用户名> --password <密码>")
        return
    if not verify_user_pwd(username, password):
        print(f"错误: 密码错误，无法以 '{username}' 身份监听")
        return
    data, _ = load_kotatsu_room(room)
    last_id = data.get("last_seen", {}).get(username, 0)
    if last_id == 0:
        last_id = max([m["id"] for m in data["messages"]], default=0)
    print(f"[{username}] 正在监听被炉 [{room}]，等待新消息（超时 {timeout} 秒，Ctrl+C 退出）...")
    import time
    start = time.time()
    while time.time() - start < timeout:
        data, _ = load_kotatsu_room(room)
        new_msgs = [m for m in data["messages"] if m["id"] > last_id]
        if new_msgs:
            def _mut(d):
                now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                d.setdefault("last_active", {})[username] = now
                for m in d["messages"]:
                    if m["id"] > last_id and username not in m.setdefault("read_by", []):
                        m["read_by"].append(username)
                d.setdefault("last_seen", {})[username] = max(m["id"] for m in d["messages"] if m["id"] > last_id)
                return None
            update_kotatsu_room(room, _mut)
            data, _ = load_kotatsu_room(room)
            new_msgs = [m for m in data["messages"] if m["id"] > last_id]
            print(f"[{room}] {len(new_msgs)} 条新消息:")
            for m in new_msgs:
                tag = "系统" if m.get("system") else m["from"]
                print(f"  {tag} {m['time']} #{m['id']}: {m['content']}")
                sys.stdout.flush()
            return
        time.sleep(1)
    print(f"[{username}] 监听超时（{timeout} 秒），无新消息")


def cmd_kotatsu_search(room, msg_id=0, username="", since="", until="", keyword=""):
    """在聊天记录内检索：按消息序列号/用户名/时间范围/关键词（不涉及记忆系统）"""
    if not room:
        print("错误: kotatsu search 需要 --room <房间名>")
        return
    data, _ = load_kotatsu_room(room)
    msgs = data["messages"]
    if msg_id:
        msgs = [m for m in msgs if m["id"] == msg_id]
    if username:
        msgs = [m for m in msgs if m.get("from") == username]
    if keyword:
        msgs = [m for m in msgs if keyword in m["content"]]
    if since:
        if len(since) == 10:
            msgs = [m for m in msgs if (m["time"] or "")[:10] >= since]
        else:
            msgs = [m for m in msgs if (m["time"] or "") >= since]
    if until:
        if len(until) == 10:
            msgs = [m for m in msgs if (m["time"] or "")[:10] <= until]
        else:
            msgs = [m for m in msgs if (m["time"] or "") <= until]
    if not msgs:
        print(f"[{room}] 无匹配消息")
        return
    print(f"[{room}] 检索到 {len(msgs)} 条消息:")
    for m in msgs:
        tag = "系统" if m.get("system") else m["from"]
        print(f"  {tag} {m['time']} #{m['id']}: {m['content']}")


def cmd_kotatsu_diary(room, username, password):
    """创始人标记日记已记录，重置10条消息计数"""
    if not room or not username:
        print("错误: kotatsu diary 需要 --room <房间名> --user <用户名> --password <密码>")
        return
    if not verify_user_pwd(username, password):
        print(f"错误: 密码错误，无法以 '{username}' 身份操作")
        return
    def _mut(d):
        founder = d.get("founder") or ""
        if founder and founder != username:
            return ("deny", founder)
        if not founder:
            d["founder"] = username
        d["msg_since_diary"] = 0
        return ("ok", d.get("founder"))
    res = update_kotatsu_room(room, _mut)
    if res[0] == "deny":
        print(f"错误: 创始人[{res[1]}]才能标记日记完成，当前用户 [{username}] 无权操作")
        return
    print(f"[OK] 创始人[{username}] 已标记日记完成，计数重置")


def cmd_kotatsu_todo(room, username, password, action, todo_id=0, content=""):
    """被炉待办：add 挂载待办 / list 查看 / withdraw 撤回自己的待办请求"""
    if not room or not username:
        print("错误: kotatsu todo 需要 --room <房间名> --user <用户名> --password <密码> [add|list|withdraw]")
        return
    if not verify_user_pwd(username, password):
        print(f"错误: 密码错误，无法以 '{username}' 身份操作")
        return
    if action == "add":
        if not content:
            print("错误: todo add 需要 --content <内容>")
            return
        def _mut_add(data):
            now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            tid = kotatsu_add_todo(data, username, content, 0, now)
            return ("ok", tid)
        res = update_kotatsu_room(room, _mut_add)
        print(f"[OK] 待办 #{res[1]} 已挂载给管理员处理（来自 {username}）")
    elif action == "withdraw":
        if not todo_id:
            print("错误: todo withdraw 需要 --id <待办编号>（不支持位置参数，如 withdraw 190 应写 withdraw --id 190）")
            return
        def _mut_withdraw(data):
            target = next((t for t in data["todos"] if t["id"] == todo_id), None)
            if not target:
                return ("error", f"待办 #{todo_id} 不存在")
            if target["from"] != username:
                return ("error", f"待办 #{todo_id} 属于 {target['from']}，只能撤回自己的待办请求")
            if target["status"] != "pending":
                return ("error", f"待办 #{todo_id} 当前状态为 {target['status']}，无法撤回")
            target["status"] = "withdrawn"
            return ("ok", todo_id)
        res = update_kotatsu_room(room, _mut_withdraw)
        if res[0] == "error":
            print(f"错误: {res[1]}")
            return
        print(f"[OK] 待办 #{res[1]} 已撤回")
    else:
        data, _ = load_kotatsu_room(room)
        todos = data.get("todos", [])
        if not todos:
            print(f"[{room}] 暂无待办")
            return
        print(f"[{room}] 待办列表（共{len(todos)} 条）:")
        for t in todos:
            print(f"  #{t['id']} [{t['status']}] {t['from']} {t['time']}: {t['content']}")


def cmd_kotatsu_watch(room, username, password):
    """常驻监听模式：循环检查新消息并打印，保持进程在线（Ctrl+C 退出）"""
    if not room or not username:
        print("错误: kotatsu watch 需要 --room <房间名> --user <用户名> --password <密码>")
        return
    if not verify_user_pwd(username, password):
        print(f"错误: 密码错误，无法以 '{username}' 身份监听")
        return
    import time
    data, _ = load_kotatsu_room(room)
    last_id = data.get("last_seen", {}).get(username, 0)
    if last_id == 0:
        last_id = max([m["id"] for m in data["messages"]], default=0)
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:
        pass
    print(f"[{username}] 常驻监听被炉 [{room}]（每秒轮询，Ctrl+C 退出）...")
    try:
        while True:
            data, _ = load_kotatsu_room(room)
            new_msgs = [m for m in data["messages"] if m["id"] > last_id]
            if new_msgs:
                def _mut(d):
                    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                    d.setdefault("last_active", {})[username] = now
                    for m in d["messages"]:
                        if m["id"] > last_id and username not in m.setdefault("read_by", []):
                            m["read_by"].append(username)
                    d.setdefault("last_seen", {})[username] = max(
                        m["id"] for m in d["messages"] if m["id"] > last_id)
                    return None
                update_kotatsu_room(room, _mut)
                data, _ = load_kotatsu_room(room)
                new_msgs = [m for m in data["messages"] if m["id"] > last_id]
                for m in new_msgs:
                    tag = "系统" if m.get("system") else m["from"]
                    print(f"  {tag} {m['time']} #{m['id']}: {m['content']}")
                    sys.stdout.flush()
                last_id = max(m["id"] for m in new_msgs)
            time.sleep(1)
    except KeyboardInterrupt:
        print(f"[{username}] 已退出被炉监听 [{room}]")


def kotatsu_update_json(path, default, mutator, timeout=15):
    """通用事务化 JSON 更新（带跨进程锁）：schedule/hooks 配置文件共用"""
    path = Path(path)
    data = load_json(path, default)
    lf = kotatsu_lock(path, timeout)
    try:
        data = load_json(path, default)
        result = mutator(data)
        save_json(path, data)
        return result
    finally:
        kotatsu_unlock(lf)


def cmd_kotatsu_schedule(action, time_s="", room="", target="", content="", repeat="once", todo_id=0):
    """被炉闹铃任务：add 添加 / list 查看 / remove 删除"""
    import re
    if not action:
        print("用法: kotatsu schedule add|list|remove ...")
        return
    if action == "add":
        if not time_s or not re.fullmatch(r"\d{2}:\d{2}", time_s):
            print("错误: --time 需要 HH:MM 格式（如 23:00）")
            return
        hh, mm = time_s.split(":")
        if not (0 <= int(hh) <= 23 and 0 <= int(mm) <= 59):
            print("错误: 时间超出范围")
            return
        if not room or not content:
            print("错误: schedule add 需要 --room <房间名> --content <内容>")
            return
        if repeat not in ("once", "daily", "hourly", "weekday"):
            print("错误: --repeat 仅支持 once|daily|hourly|weekday")
            return
        def _mut(data):
            tid = data.get("next_id", 1)
            data.setdefault("tasks", []).append({"id": tid, "time": time_s, "room": room,
                                                 "target": target or "", "content": content,
                                                 "repeat": repeat, "enabled": True, "last_triggered": ""})
            data["next_id"] = tid + 1
            return ("ok", tid)
        res = kotatsu_update_json(KOTATSU_SCHEDULE_FILE, {"tasks": [], "next_id": 1}, _mut)
        print(f"[OK] 闹铃任务 #{res[1]} 已添加: {time_s} [{repeat}] -> {room} {content[:40]}")
    elif action == "list":
        data = load_json(KOTATSU_SCHEDULE_FILE, {"tasks": [], "next_id": 1})
        tasks = data.get("tasks", [])
        if not tasks:
            print("[schedule] 暂无闹铃任务")
            return
        print(f"[schedule] 共{len(tasks)} 个闹铃任务:")
        for t in tasks:
            st = "启用" if t.get("enabled", True) else "停用"
            print(f"  #{t['id']} [{st}] {t['time']} [{t.get('repeat')}] -> {t['room']} 目标:{t.get('target') or '广播'} {t.get('content', '')[:40]}")
    elif action == "remove":
        if not todo_id:
            print("错误: schedule remove 需要 --id <任务编号>")
            return
        def _mut(data):
            tasks = data.get("tasks", [])
            if not any(t["id"] == todo_id for t in tasks):
                return ("error", f"闹铃任务 #{todo_id} 不存在")
            data["tasks"] = [t for t in tasks if t["id"] != todo_id]
            return ("ok", todo_id)
        res = kotatsu_update_json(KOTATSU_SCHEDULE_FILE, {"tasks": [], "next_id": 1}, _mut)
        if res[0] == "error":
            print(f"错误: {res[1]}")
            return
        print(f"[OK] 闹铃任务 #{res[1]} 已删除")


def cmd_kotatsu_hook(action, room="", content="", secret="", todo_id=0):
    """被炉 API Hook：add 注册外部回调 / list 查看 / remove 删除"""
    import secrets as _sec
    if not action:
        print("用法: kotatsu hook add|list|remove ...")
        return
    if action == "add":
        if not room or not content:
            print("错误: hook add 需要 --room <房间名> --content <内容>")
            return
        if not secret:
            secret = _sec.token_hex(8)
        def _mut(data):
            hid = data.get("next_id", 1)
            data.setdefault("hooks", []).append({"id": hid, "room": room, "content": content, "secret": secret})
            data["next_id"] = hid + 1
            return ("ok", hid)
        res = kotatsu_update_json(KOTATSU_HOOKS_FILE, {"hooks": [], "next_id": 1}, _mut)
        print(f"[OK] API Hook #{res[1]} 已注册: {room} | secret: {secret}")
        print(f"[提示] 外部调用: curl -X POST http://127.0.0.1:<serve端口>/api/kotatsu/push -H 'Content-Type: application/json' -d '{{\"room\": \"{room}\", \"content\": \"训练完成\", \"secret\": \"{secret}\"}}'")
    elif action == "list":
        data = load_json(KOTATSU_HOOKS_FILE, {"hooks": [], "next_id": 1})
        hooks = data.get("hooks", [])
        if not hooks:
            print("[hook] 暂无 API Hook")
            return
        print(f"[hook] 共{len(hooks)} 个:")
        for h in hooks:
            print(f"  #{h['id']} {h['room']} secret:{h['secret']} content:{h.get('content', '')[:40]}")
    elif action == "remove":
        if not todo_id:
            print("错误: hook remove 需要 --id <编号>")
            return
        def _mut(data):
            hooks = data.get("hooks", [])
            if not any(h["id"] == todo_id for h in hooks):
                return ("error", f"API Hook #{todo_id} 不存在")
            data["hooks"] = [h for h in hooks if h["id"] != todo_id]
            return ("ok", todo_id)
        res = kotatsu_update_json(KOTATSU_HOOKS_FILE, {"hooks": [], "next_id": 1}, _mut)
        if res[0] == "error":
            print(f"错误: {res[1]}")
            return
        print(f"[OK] API Hook #{res[1]} 已删除")


def kotatsu_check_schedules(serving_user, serving_pwd):
    """serve 循环内检查闹铃任务：到点推送房间并标记 last_triggered"""
    now = datetime.datetime.now()
    hm = now.strftime("%H:%M")
    data = load_json(KOTATSU_SCHEDULE_FILE, {"tasks": [], "next_id": 1})
    tasks = data.get("tasks", [])
    fired = []
    for t in tasks:
        if not t.get("enabled", True):
            continue
        if t.get("time") != hm:
            continue
        rep = t.get("repeat", "once")
        lt = t.get("last_triggered", "")
        if rep == "hourly":
            key = now.strftime("%Y-%m-%d %H")
            if lt == key:
                continue
        else:
            key = now.strftime("%Y-%m-%d")
            if lt == key:
                continue
        if rep == "weekday" and now.weekday() >= 5:
            continue
        fired.append(t)
    if not fired:
        return
    fired_ids = [t["id"] for t in fired]
    def _mut(d):
        tasks = d.get("tasks", [])
        kept = []
        for t in tasks:
            if t["id"] not in fired_ids:
                kept.append(t)
                continue
            if t.get("repeat") == "once":
                continue  # 一次性任务触发后移除
            if t.get("repeat") == "hourly":
                t["last_triggered"] = now.strftime("%Y-%m-%d %H")
            else:
                t["last_triggered"] = now.strftime("%Y-%m-%d")
            kept.append(t)
        d["tasks"] = kept
        return None
    kotatsu_update_json(KOTATSU_SCHEDULE_FILE, {"tasks": [], "next_id": 1}, _mut)
    for t in fired:
        target = t.get("target", "")
        prefix = f"@{target} " if target else ""
        msg = f"【闹铃】{prefix}{t.get('content', '')}"
        cmd_kotatsu_send(t.get("room", ""), serving_user, serving_pwd, msg)
        print(f"[闹铃] #{t['id']} 已触发 -> {t.get('room')} {msg[:60]}")
        sys.stdout.flush()


def cmd_kotatsu_serve(room, username, password):
    """被炉官方监听服务 v2：常驻 watch + 闹铃调度 + API 接口（POST push / GET status）"""
    import time, threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from urllib.parse import urlparse
    if not room or not username:
        print("错误: kotatsu serve 需要 --room <房间名> --user <用户名> --password <密码>")
        return
    if not verify_user_pwd(username, password):
        print(f"错误: 密码错误，无法以 '{username}' 身份启动服务")
        return
    api_state = {"start": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "room": room}

    class APIHandler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass
        def _json(self, obj, code=200):
            body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        def do_GET(self):
            if urlparse(self.path).path == "/api/kotatsu/status":
                data, _ = load_kotatsu_room(room)
                self._json({"ok": True, "service": "kotatsu-serve-v2", "start": api_state["start"],
                            "room": room, "user": username,
                            "last_id": data.get("next_id", 1) - 1,
                            "schedules": len(load_json(KOTATSU_SCHEDULE_FILE, {"tasks": []}).get("tasks", [])),
                            "hooks": len(load_json(KOTATSU_HOOKS_FILE, {"hooks": []}).get("hooks", []))})
            else:
                self._json({"ok": False, "error": "not found"}, 404)
        def do_POST(self):
            if urlparse(self.path).path != "/api/kotatsu/push":
                self._json({"ok": False, "error": "not found"}, 404)
                return
            try:
                length = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(length).decode("utf-8"))
            except Exception:
                self._json({"ok": False, "error": "bad json"}, 400)
                return
            hroom = body.get("room") or room
            hcontent = body.get("content", "").strip()
            hsecret = body.get("secret", "")
            if not hcontent:
                self._json({"ok": False, "error": "content 不能为空"}, 400)
                return
            hooks_data = load_json(KOTATSU_HOOKS_FILE, {"hooks": []})
            hook = next((h for h in hooks_data.get("hooks", [])
                         if h.get("room") == hroom and h.get("secret") == hsecret), None)
            if not hook:
                self._json({"ok": False, "error": "secret 校验失败"}, 403)
                return
            cmd_kotatsu_send(hroom, username, password, hcontent)
            self._json({"ok": True, "room": hroom})

    srv = ThreadingHTTPServer(("127.0.0.1", 0), APIHandler)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:
        pass
    data, _ = load_kotatsu_room(room)
    last_id = data.get("last_seen", {}).get(username, 0)
    if last_id == 0:
        last_id = max([m["id"] for m in data["messages"]], default=0)
    print(f"[OK] 被炉监听服务 v2 运行中 | 房间: {room} | 用户: {username} | API: http://127.0.0.1:{port} | Ctrl+C 退出")
    try:
        while True:
            kotatsu_check_schedules(username, password)
            data, _ = load_kotatsu_room(room)
            new_msgs = [m for m in data["messages"] if m["id"] > last_id]
            if new_msgs:
                def _mut(d):
                    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                    d.setdefault("last_active", {})[username] = now
                    for m in d["messages"]:
                        if m["id"] > last_id and username not in m.setdefault("read_by", []):
                            m["read_by"].append(username)
                    d.setdefault("last_seen", {})[username] = max(
                        m["id"] for m in d["messages"] if m["id"] > last_id)
                    return None
                update_kotatsu_room(room, _mut)
                data, _ = load_kotatsu_room(room)
                new_msgs = [m for m in data["messages"] if m["id"] > last_id]
                for m in new_msgs:
                    tag = "系统" if m.get("system") else m["from"]
                    print(f"  {tag} {m['time']} #{m['id']}: {m['content']}")
                    sys.stdout.flush()
                last_id = max(m["id"] for m in new_msgs)
            time.sleep(1)
    except KeyboardInterrupt:
        print(f"[{username}] 已退出被炉监听服务 [{room}]")
        sys.stdout.flush()
        srv.shutdown()


def cmd_kotatsu_ui(room):
    """启动被炉系统UI（本地Web服务器+自动打开浏览器）"""
    if not room:
        print("错误: kotatsu ui 需要 --room <房间名>")
        return
    import subprocess
    ui_script = Path(__file__).parent / "kotatsu_ui.py"
    print(f"[OK] 正在启动被炉 [{room}] UI...")
    CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    subprocess.Popen([sys.executable, str(ui_script), "--room", room],
                     cwd=Path.cwd(), creationflags=CREATE_NO_WINDOW)
def cmd_info():
    ensure_dirs()
    t = len(load_json(TAGS_FILE, {"tags": {}}).get("tags", {}))
    idx = load_json(INDEX_FILE, {"index": {}}).get("index", {})
    _ids = {e.get("id") for _tag, items in idx.items() for e in items}
    d = len(_ids)
    i = sum(len(v) for v in idx.values())
    users = load_json(USERS_FILE, {"users": {}}).get("users", {})
    print(f"日记: {d} | 标签: {t} | 索引条目: {i} | 用户: {len(users)}")
    if users:
        for uname, uinfo in sorted(users.items()):
            # 密钥不对外显示，防止泄露
            cid = uinfo.get("created_id", "?")
            print(f"  [{uname}] 注册:{cid}")
    gk = load_json(INDEX_FILE, {"index": {}}).get("last_key", "")
    print(f"存储: {MEMORY_DIR}")


def _tracker_run(args, timeout=60, ret_out=False):
    """调用 auto-updater tracker.py 并透传输出（子进程强制 utf-8 输出，避免 GBK 乱码）
    ret_out=True 时返回 (returncode, stdout)，用于快照变更解析"""
    import subprocess, os
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    try:
        result = subprocess.run(['python', TRACKER_PY] + args, capture_output=True, text=True,
                                encoding="utf-8", errors="replace", timeout=timeout, env=env)
        out = result.stdout.strip()
        if out:
            print(out)
        if result.stderr and result.stderr.strip():
            print(result.stderr.strip())
        if ret_out:
            return result.returncode, out
        return result.returncode
    except Exception as e:
        print(f"错误: tracker 调用失败 - {e}")
        if ret_out:
            return 1, ""
        return 1


def _ensure_agent_record(username):
    """确保智能体有独立安装记录（SQLite docs: agent_versions:<name>），无则自动创建

    注意：tracker.py 的 _load_agent/_save_agent 已迁移到 SQLite，
    这里必须同样写库，否则会出现「写 JSON、读 DB」的读写分离（记录永远找不到）。
    """
    import datetime as _dt
    key = "agent_versions:" + username
    if get_doc(key, None):
        return
    data = {"agent": username,
            "registered_at": _dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "updated_at": None, "skills": {}}
    set_doc(key, data)
    print(f"[OK] 智能体 '{username}' 独立安装记录已创建（首次使用，需 check 后 sync 完成安装）")


def _parse_tracker_changes(out):
    """从 tracker update 输出解析变更的目录（技能）名清单"""
    changed = []
    in_changes = False
    for ln in (out or "").splitlines():
        s = ln.strip()
        if "[CHANGES]" in ln:
            in_changes = True
            continue
        if not in_changes:
            continue
        if not s:
            continue
        if s.startswith(("[OK]", "[update]", "[INFO]", "[WARN]")) or "Snapshot updated" in s:
            break
        if s.startswith("["):
            continue
        f = re.sub(r"^[a-z]\s+", "", s)  # 单字母前缀（m/a/d/l/t/r...）
        skill = f.replace("\\", "/").split("/")[0]
        if skill and skill not in changed:
            changed.append(skill)
    return changed


def notify_recipients():
    """返回订阅了技能更新通知的用户列表（未设置 notify 视为订阅）"""
    users = load_json(USERS_FILE, {"users": {}}).get("users", {})
    return [n for n, m in users.items() if m.get("notify", True)]


def cmd_subscribe(username, password, action):
    """订阅/退订技能更新通知（快照广播只发给订阅者）"""
    if not username:
        print("错误: subscribe 需要 -u <用户名> 参数")
        return
    if not user_exists(username):
        print(f"错误: 用户 '{username}' 不存在")
        return
    users = load_json(USERS_FILE, {"users": {}})
    user = users["users"].get(username, {})
    stored_pwd = user.get("pwd", "")
    if stored_pwd:
        if not password:
            print(f"错误: 用户 '{username}' 需要 --password 参数")
            return
        if hashlib.sha256(password.encode()).hexdigest() != stored_pwd:
            print(f"错误: 密码错误，无法以 '{username}' 操作订阅")
            return
    if action not in ("on", "off"):
        print("用法: subscribe -u <用户名> --password <密码> on|off")
        print(f"[{username}] 当前订阅状态: {'订阅中' if user.get('notify', True) else '已退订'}")
        return
    user["notify"] = (action == "on")
    save_json(USERS_FILE, users)
    print(f"[OK] 用户 '{username}' 已{'订阅' if action == 'on' else '退订'}技能更新通知")


def notify_all_agents(from_user, content):
    """向订阅了更新通知的用户广播留言板消息（发件人为维护者）"""
    users = notify_recipients()
    if not users:
        return 0
    board = load_board()
    messages = board.get("messages", [])
    nums = [int(m["id"][1:]) for m in messages if str(m.get("id", "")).startswith("M")]
    nid = (max(nums) + 1) if nums else 1
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    for name in users:
        messages.append({"id": f"M{nid:04d}", "from": from_user, "to": name,
                         "content": content, "time": now, "read": False})
        nid += 1
    board["messages"] = messages
    save_board(board)
    return len(users)


def cmd_broadcast(username="", password="", content=""):
    """维护者向订阅了更新通知的用户群发留言板公告（快照广播同款机制）"""
    if not username:
        print("错误: broadcast 需要 -u <用户名> --password <密码> --content <内容>")
        return
    if not user_exists(username):
        print(f"错误: 用户 '{username}' 不存在")
        return
    if username not in FLOWER_NAMES:
        print(f"错误: 用户名 '{username}' 不是花朵中文名，broadcast 已被全局禁用")
        return
    users = load_json(USERS_FILE, {"users": {}})
    stored_pwd = users.get("users", {}).get(username, {}).get("pwd", "")
    if stored_pwd:
        if not password:
            print(f"错误: 用户 '{username}' 需要 --password 参数")
            return
        if hashlib.sha256(password.encode()).hexdigest() != stored_pwd:
            print(f"错误: 密码错误，无法以 '{username}' 执行广播")
            return
    if not content:
        print("错误: broadcast 需要 --content <内容>")
        return
    n = notify_all_agents(username, content)
    print(f"[OK] 已向 {n} 个订阅用户群发留言板公告（发件人 {username}）")


def cmd_update(username="", password="", sub="snapshot", skill=""):
    """技能更新统一入口（已整合进记忆系统，替代直接调用 tracker.py）
    sub: snapshot 刷新快照(维护者) / check 检查本智能体需更新技能 / sync 装载后同步(独立安装完成)
         status 查看本智能体版本 / agents 全局智能体安装状态(维护视角)"""
    if not username:
        print("错误: update 需要 -u <用户名> 参数")
        return
    if not user_exists(username):
        print(f"错误: 用户 '{username}' 不存在，请先 register")
        return
    if username not in FLOWER_NAMES:
        print(f"错误: 用户名 '{username}' 不是花朵中文名，update 已被全局禁用")
        return
    users = load_json(USERS_FILE, {"users": {}})
    user = users.get("users", {}).get(username, {})
    stored_pwd = user.get("pwd", "")
    if stored_pwd:
        if not password:
            print(f"错误: 用户 '{username}' 需要 --password 参数")
            return
        if hashlib.sha256(password.encode()).hexdigest() != stored_pwd:
            print(f"错误: 密码错误，无法以 '{username}' 执行 update")
            return
    auth = ['--user', username, '--password', password]
    if sub == "snapshot":
        print(f"[update] 刷新技能快照（{username}）...")
        code, out = _tracker_run(['update'] + auth, ret_out=True)
        if code == 0 and out and "[CHANGES]" in out:
            changed = _parse_tracker_changes(out)
            if changed:
                content = ("【技能更新通知】快照已更新，以下技能有变更：" + "、".join(changed)
                           + "。请尽快运行 #update 或 memory.py update -u <你的用户名> --password <密码> check / sync 完成同步。")
                n = notify_all_agents(username, content)
                print(f"[update] 已向 {n} 个用户发送技能更新留言板通知")
    elif sub == "check":
        _ensure_agent_record(username)
        print(f"[update] 检查智能体 '{username}' 技能版本...")
        _tracker_run(['agent', 'check', '--name', username] + auth)
    elif sub == "sync":
        _ensure_agent_record(username)
        print(f"[update] 智能体 '{username}' 确认装载，同步独立安装版本...")
        _tracker_run(['agent', 'sync', '--name', username] + auth)
    elif sub == "status":
        _ensure_agent_record(username)
        _tracker_run(['agent', 'status', '--name', username] + auth)
    elif sub == "agents":
        print(f"[update] 全局智能体独立安装状态：")
        av_keys = sorted(keys_with_prefix("agent_versions:"))
        if not av_keys:
            print("  暂无已注册智能体安装记录")
            return
        for k in av_keys:
            try:
                d = get_doc(k, {})
                n = len(d.get("skills", {}))
                up = d.get("updated_at") or "从未同步"
                print(f"  [{d.get('agent', k.split(':',1)[-1])}] 技能 {n} 个 | 上次同步: {up}")
            except Exception:
                continue
    elif sub == "install":
        _ensure_agent_record(username)
        if not skill:
            print("错误: update install 需要 --skill <技能名|all>")
            return
        print(f"[update] 智能体 '{username}' 独立装载技能: {skill} ...")
        _tracker_run(['agent', 'install', '--name', username, '--skill', skill] + auth)
    elif sub == "uninstall":
        _ensure_agent_record(username)
        if not skill:
            print("错误: update uninstall 需要 --skill <技能名|all>")
            return
        print(f"[update] 智能体 '{username}' 卸载技能: {skill} ...")
        _tracker_run(['agent', 'uninstall', '--name', username, '--skill', skill] + auth)
    elif sub == "list":
        _ensure_agent_record(username)
        print(f"[update] 智能体 '{username}' 已装载技能清单：")
        _tracker_run(['agent', 'status', '--name', username] + auth)
    else:
        print("错误: update 子命令仅支持 snapshot|check|sync|status|agents|install|uninstall|list")


def cmd_rename(old_name, new_name="", new_pwd=""):
    """重命名用户或修改密码"""
    if not old_name:
        print("错误: rename 需要 -u <用户名>")
        return
    if not user_exists(old_name):
        print(f"错误: 用户 '{old_name}' 不存在")
        return
    # 修改密码模式
    if new_pwd:
        if not (len(new_pwd) == 8 and new_pwd.isdigit()):
            print("错误: 密码必须为8位数字")
            return
        if new_pwd == "00000000":
            print("错误: 密码不能为默认密码 00000000")
            return
        users = load_json(USERS_FILE, {"users": {}})
        if "pwd" not in users["users"][old_name]:
            users["users"][old_name]["pwd"] = ""
        users["users"][old_name]["pwd"] = hashlib.sha256(new_pwd.encode()).hexdigest()
        save_json(USERS_FILE, users)
        print(f"[OK] 用户 '{old_name}' 密码已修改")
        return
    # 改用户名模式
    if not new_name:
        print("错误: 改用户名需要 --new，改密码需要 --password")
        return
    if user_exists(new_name):
        print(f"错误: 用户 '{new_name}' 已存在")
        return
    if new_name not in FLOWER_NAMES:
        print(f"错误: 新用户名 '{new_name}' 不是花朵中文名")
        return
    users = load_json(USERS_FILE, {"users": {}})
    users["users"][new_name] = users["users"].pop(old_name)
    save_json(USERS_FILE, users)
    # 更新 index.json 中的密钥键名
    idx = load_json(INDEX_FILE, {"index": {}})
    old_key = "last_key_" + old_name
    new_key = "last_key_" + new_name
    if old_key in idx:
        idx[new_key] = idx.pop(old_key)
    save_json(INDEX_FILE, idx)
    print(f"[OK] 用户 '{old_name}' -> '{new_name}' 重命名成功")


def cmd_delete_user(username, confirm=False):
    """删除用户（需二次确认）"""
    if not username:
        print("错误: 需要 -u <用户名> 参数")
        return
    if not user_exists(username):
        print(f"错误: 用户 '{username}' 不存在")
        return
    if not confirm:
        print(f"[!]  确认删除用户 '{username}'？")
        print(f"  此操作不可恢复，该用户的日记索引标记将被保留")
        print(f"  使用 --confirm 参数确认删除")
        return
    # 从 users.json 删除
    users = load_json(USERS_FILE, {"users": {}})
    del users["users"][username]
    save_json(USERS_FILE, users)
    # 从所有工作区清理密钥（SQLite 文档）
    key_name = "last_key_" + username
    for _d in Path("E:/codex_data").iterdir():
        if not (_d / "memory").is_dir():
            continue
        _idx = get_workspace_index(_d.name)
        if key_name in _idx:
            del _idx[key_name]
            save_workspace_index(_d.name, _idx)
    print(f"[OK] 用户 '{username}' 已删除")


def cmd_use(username, password=""):
    """设置当前用户（需密码验证）"""
    if not user_exists(username):
        print(f"错误: 用户 '{username}' 不存在")
        return
    users = load_json(USERS_FILE, {"users": {}})
    user = users.get("users", {}).get(username, {})
    stored_pwd = user.get("pwd", "")
    if stored_pwd:
        if not password:
            print(f"错误: 用户 '{username}' 需要 --password 参数登录")
            return
        if hashlib.sha256(password.encode()).hexdigest() != stored_pwd:
            print(f"错误: 密码错误，无法登录 '{username}'")
            return
    set_current_user(username)
    print(f"[OK] 当前用户已设为: {username}")
    if password == "00000000":
        print(f"  [!] 当前使用初始密码，请及时修改：rename -u {username} --password 87654321")


HELP = """用法: python memory.py <命令> [选项]

命令:
  register --name <n> --password <p>  注册新用户（需设置密码）
  register --name <n> --free       注册免密账户（真人用户专用）
  tags                         列出所有标签
  search --tags <t>            全局检索（跨全部工作区，登录后搜全部日记）
        --key <k> --user <u>   用户用KEY登录解锁
  read <id>                    读取日记
  write -t <t> -s <s>         写入（可加 -u <n> 指定用户）
        -k log|diary, --file <p>
  info                         系统概览
  use -u <n>                   设置当前用户
  delete-user -u <n> [--confirm]  删除用户（需二次确认）
  rename -u <n> --new <n>        重命名用户
  rename -u <n> --password <p>  修改密码（8位数字）
  update -u <n> --password <p>  更新tracker（需密码验证）
  post -u <n> --password <p> --to <接收者> --content <内容>
                               留言帖：给指定用户留言
  inbox -u <n> --password <p> --key <KEY>
                               查看发给我的留言
  msg-read <id>                标记留言为已读
  broadcast -u <n> --password <p> --content <c>
                               维护者向订阅用户群发留言板公告
  kotatsu join --room <r> --user <u> --password <p>
                               加入/创建被炉房间
  kotatsu send --room <r> --user <u> --password <p> --message <m>
                               发送被炉消息（@管理员自动生成待办）
  kotatsu poll --room <r> --user <u> --password <p> [--since <id>]
                               查看被炉新消息
  kotatsu listen --room <r> --user <u> --password <p> [--timeout <秒>]
                               实时监听，等待对方回复
  kotatsu ui --room <r>       启动被炉系统UI（仅管理员，实时+待办+检索）
  kotatsu search --room <r> [--id <n>] [--user <u>] [--from <t>] [--to <t>] [--keyword <k>]
                               在聊天记录内检索
  kotatsu diary --room <r> --user <u> --password <p>
                               创始人标记日记完成（重置10条计数）
  kotatsu todo --room <r> --user <u> --password <p> add|list|withdraw
                               待办：add挂载 / list查看 / withdraw撤回

流程: register -> use -u <n> -> write -> search --key <KEY>
KEY=登录密码，首次注册后获得"""


if __name__ == "__main__":
    # 输出编码兜底：GBK 控制台遇特殊字符(如 U+2212)不再 UnicodeEncodeError 崩溃
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        try:
            import io as _io
            sys.stdout = _io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
        except Exception:
            pass
    if len(sys.argv) < 2:
        print(HELP)
        sys.exit(0)
    cmd = sys.argv[1]

    if cmd == "register":
        nm = pw = None
        free = False
        for i, a in enumerate(sys.argv):
            if a == "--name" and i + 1 < len(sys.argv):
                nm = sys.argv[i + 1]
            if a == "--password" and i + 1 < len(sys.argv):
                pw = sys.argv[i + 1]
            if a == "--free":
                free = True
        cmd_register(nm, pw or "", free)

    elif cmd == "tags":
        cmd_tags()

    elif cmd == "search":
        tv = kv = uv = pw = None
        i = 2
        while i < len(sys.argv):
            if sys.argv[i] in ("--tags", "-t") and i + 1 < len(sys.argv):
                tv = sys.argv[i + 1]; i += 2
            elif sys.argv[i] in ("--key", "-k") and i + 1 < len(sys.argv):
                kv = sys.argv[i + 1]; i += 2
            elif sys.argv[i] in ("--user", "-u") and i + 1 < len(sys.argv):
                uv = sys.argv[i + 1]; i += 2
            elif sys.argv[i] in ("--password", "-p") and i + 1 < len(sys.argv):
                pw = sys.argv[i + 1]; i += 2
            else:
                i += 1
        if uv and not pw:
            print("错误: search 需要 --password/-p <密码> 参数（与 -u 配套）")
        elif uv and not kv:
            print("错误: search 需要 --key/-k <KEY> 参数（write 后刷新，可用 memory.py use 查询）")
        else:
            cmd_search(tv, kv or "", uv or "", pw or "")

    elif cmd == "read":
        if len(sys.argv) > 2:
            cmd_read(" ".join(sys.argv[2:]))
        else:
            print("用法: read <id1> [<id2> ...]  或 read <id1,id2,id3>")

    elif cmd == "write":
        tv = sv = fp = cv = kv = uv = pw = None
        i = 2
        while i < len(sys.argv):
            if sys.argv[i] == "-t" and i + 1 < len(sys.argv):
                tv = sys.argv[i + 1]; i += 2
            elif sys.argv[i] == "-s" and i + 1 < len(sys.argv):
                sv = sys.argv[i + 1]; i += 2
            elif sys.argv[i] == "--file" and i + 1 < len(sys.argv):
                fp = sys.argv[i + 1]; i += 2
            elif sys.argv[i] == "--content" and i + 1 < len(sys.argv):
                cv = sys.argv[i + 1]; i += 2
            elif sys.argv[i] == "-k" and i + 1 < len(sys.argv):
                kv = sys.argv[i + 1]; i += 2
            elif sys.argv[i] == "-u" and i + 1 < len(sys.argv):
                uv = sys.argv[i + 1]; i += 2
            elif sys.argv[i] == "--password" and i + 1 < len(sys.argv):
                pw = sys.argv[i + 1]; i += 2
            else:
                i += 1
        if not tv:
            print("错误: -t 是必填参数")
        else:
            if cv is not None:
                ct = cv.strip()  # 直传正文，避免临时文件
            elif fp:
                with open(fp, "r", encoding="utf-8-sig") as f:
                    ct = f.read().strip()
            elif not sys.stdin.isatty():
                ct = sys.stdin.read().strip()  # 管道输入，避免临时文件
            else:
                print("错误: 需要 --content <正文>、--file <路径> 或管道输入之一")
                sys.exit(0)
            cmd_write(tv, sv or "", ct, kv or "diary", uv or "", pw or "")

    elif cmd == "delete-user":
        uv = cf = None
        for i, a in enumerate(sys.argv):
            if a == "-u" and i + 1 < len(sys.argv):
                uv = sys.argv[i + 1]
            if a == "--confirm":
                cf = True
        cmd_delete_user(uv or "", cf or False)

    elif cmd == "rename":
        old = new = pwd = None
        for i, a in enumerate(sys.argv):
            if a == "-u" and i + 1 < len(sys.argv):
                old = sys.argv[i + 1]
            if a == "--new" and i + 1 < len(sys.argv):
                new = sys.argv[i + 1]
            if a == "--password" and i + 1 < len(sys.argv):
                pwd = sys.argv[i + 1]
        cmd_rename(old or "", new or "", pwd or "")

    elif cmd == "subscribe":
        uv = pw = act = None
        for i, a in enumerate(sys.argv):
            if a == "-u" and i + 1 < len(sys.argv):
                uv = sys.argv[i + 1]
            if a == "--password" and i + 1 < len(sys.argv):
                pw = sys.argv[i + 1]
            if a in ("on", "off"):
                act = a
        cmd_subscribe(uv or "", pw or "", act or "")

    elif cmd == "use":
        uv = pw = None
        for i, a in enumerate(sys.argv):
            if a == "-u" and i + 1 < len(sys.argv):
                uv = sys.argv[i + 1]
            if a == "--password" and i + 1 < len(sys.argv):
                pw = sys.argv[i + 1]
        cmd_use(uv or "", pw or "")

    elif cmd == "info":
        cmd_info()

    elif cmd == "update":
        uv = pw = usub = uskill = None
        i = 2
        while i < len(sys.argv):
            if sys.argv[i] in ("-u", "--user") and i + 1 < len(sys.argv):
                uv = sys.argv[i + 1]; i += 2
            elif sys.argv[i] in ("--password", "-p") and i + 1 < len(sys.argv):
                pw = sys.argv[i + 1]; i += 2
            elif sys.argv[i] in ("--skill", "-s") and i + 1 < len(sys.argv):
                uskill = sys.argv[i + 1]; i += 2
            elif sys.argv[i] in ("snapshot", "check", "sync", "status", "agents", "install", "uninstall", "list"):
                usub = sys.argv[i]; i += 1
            else:
                i += 1
        if not uv:
            print("错误: update 需要 -u <用户名> --password <密码> [snapshot|check|sync|status|agents|install|uninstall|list]")
        else:
            cmd_update(uv, pw or "", usub or "snapshot", uskill or "")

    elif cmd == "broadcast":
        uv = pw = cv = None
        i = 2
        while i < len(sys.argv):
            if sys.argv[i] in ("-u", "--user") and i + 1 < len(sys.argv):
                uv = sys.argv[i + 1]; i += 2
            elif sys.argv[i] in ("--password", "-p") and i + 1 < len(sys.argv):
                pw = sys.argv[i + 1]; i += 2
            elif sys.argv[i] == "--content" and i + 1 < len(sys.argv):
                cv = sys.argv[i + 1]; i += 2
            else:
                i += 1
        cmd_broadcast(uv or "", pw or "", cv or "")

    elif cmd == "post":
        uv = pw = tv = cv = None
        i = 2
        while i < len(sys.argv):
            if sys.argv[i] == "-u" and i + 1 < len(sys.argv):
                uv = sys.argv[i + 1]; i += 2
            elif sys.argv[i] == "--password" and i + 1 < len(sys.argv):
                pw = sys.argv[i + 1]; i += 2
            elif sys.argv[i] == "--to" and i + 1 < len(sys.argv):
                tv = sys.argv[i + 1]; i += 2
            elif sys.argv[i] == "--content" and i + 1 < len(sys.argv):
                cv = sys.argv[i + 1]; i += 2
            else:
                i += 1
        if uv and pw and tv and cv:
            cmd_post(uv, pw, tv, cv)
        else:
            print("错误: post 需要 -u <发送者> --password <密码> --to <接收者> --content <内容>")

    elif cmd == "inbox":
        uv = pw = kv = None
        for i, a in enumerate(sys.argv):
            if a == "-u" and i + 1 < len(sys.argv):
                uv = sys.argv[i + 1]
            if a == "--password" and i + 1 < len(sys.argv):
                pw = sys.argv[i + 1]
            if a == "--key" and i + 1 < len(sys.argv):
                kv = sys.argv[i + 1]
        cmd_inbox(uv or "", pw or "", kv or "")

    elif cmd == "msg-read":
        if len(sys.argv) > 2:
            cmd_msg_read(sys.argv[2])
        else:
            print("用法: msg-read <留言ID>")

    elif cmd == "kotatsu":
        if len(sys.argv) < 3:
            print("用法: kotatsu join|send|poll|listen|watch|ui|search|diary|todo|schedule|hook|serve ...")
            sys.exit(0)
        sub = sys.argv[2]
        room = user = pwd = msg = keyword = content = ""
        t_time = target = repeat = secret = ""
        t_from = t_to = ""
        since = 0
        timeout = 120
        todo_id = 0
        i = 3
        while i < len(sys.argv):
            if sys.argv[i] == "--room" and i + 1 < len(sys.argv):
                room = sys.argv[i + 1]; i += 2
            elif sys.argv[i] == "--user" and i + 1 < len(sys.argv):
                user = sys.argv[i + 1]; i += 2
            elif sys.argv[i] == "--password" and i + 1 < len(sys.argv):
                pwd = sys.argv[i + 1]; i += 2
            elif sys.argv[i] == "--message" and i + 1 < len(sys.argv):
                msg = sys.argv[i + 1]; i += 2
            elif sys.argv[i] == "--content" and i + 1 < len(sys.argv):
                content = sys.argv[i + 1]; i += 2
            elif sys.argv[i] == "--time" and i + 1 < len(sys.argv):
                t_time = sys.argv[i + 1]; i += 2
            elif sys.argv[i] == "--target" and i + 1 < len(sys.argv):
                target = sys.argv[i + 1]; i += 2
            elif sys.argv[i] == "--repeat" and i + 1 < len(sys.argv):
                repeat = sys.argv[i + 1]; i += 2
            elif sys.argv[i] == "--secret" and i + 1 < len(sys.argv):
                secret = sys.argv[i + 1]; i += 2
            elif sys.argv[i] == "--keyword" and i + 1 < len(sys.argv):
                keyword = sys.argv[i + 1]; i += 2
            elif sys.argv[i] == "--id" and i + 1 < len(sys.argv):
                try: todo_id = int(sys.argv[i + 1])
                except: pass
                i += 2
            elif sys.argv[i] == "--since" and i + 1 < len(sys.argv):
                try: since = int(sys.argv[i + 1])
                except: pass
                i += 2
            elif sys.argv[i] == "--timeout" and i + 1 < len(sys.argv):
                try: timeout = int(sys.argv[i + 1])
                except: pass
                i += 2
            elif sys.argv[i] == "--from" and i + 1 < len(sys.argv):
                t_from = sys.argv[i + 1]; i += 2
            elif sys.argv[i] == "--to" and i + 1 < len(sys.argv):
                t_to = sys.argv[i + 1]; i += 2
            else:
                i += 1
        if sub == "join":
            cmd_kotatsu_join(room or "", user or "", pwd or "")
        elif sub == "send":
            cmd_kotatsu_send(room or "", user or "", pwd or "", msg or "")
        elif sub == "poll":
            cmd_kotatsu_poll(room or "", user or "", pwd or "", since)
        elif sub == "listen":
            cmd_kotatsu_listen(room or "", user or "", pwd or "", timeout)
        elif sub == "watch":
            cmd_kotatsu_watch(room or "", user or "", pwd or "")
        elif sub == "ui":
            cmd_kotatsu_ui(room or "")
        elif sub == "search":
            cmd_kotatsu_search(room or "", todo_id, user or "", t_from, t_to, keyword or "")
        elif sub == "diary":
            cmd_kotatsu_diary(room or "", user or "", pwd or "")
        elif sub == "todo":
            action = sys.argv[3] if len(sys.argv) > 3 else ""
            cmd_kotatsu_todo(room or "", user or "", pwd or "", action, todo_id, content or "")
        elif sub == "schedule":
            action = sys.argv[3] if len(sys.argv) > 3 else ""
            if action in ("add", "remove") and not verify_user_pwd(user or "", pwd or ""):
                print(f"错误: 密码错误，无法以 '{user}' 身份操作")
            else:
                cmd_kotatsu_schedule(action, t_time or "", room or "", target or "", content or "", repeat or "once", todo_id)
        elif sub == "hook":
            action = sys.argv[3] if len(sys.argv) > 3 else ""
            if action in ("add", "remove") and not verify_user_pwd(user or "", pwd or ""):
                print(f"错误: 密码错误，无法以 '{user}' 身份操作")
            else:
                cmd_kotatsu_hook(action, room or "", content or "", secret or "", todo_id)
        elif sub == "serve":
            cmd_kotatsu_serve(room or "", user or "", pwd or "")
        else:
            print("用法: kotatsu join|send|poll|listen|watch|ui|search|diary|todo|schedule|hook|serve ...")
    else:
        print(HELP)