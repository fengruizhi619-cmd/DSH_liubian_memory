# -*- coding: utf-8 -*-

import json, sys, datetime, hashlib
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


def ensure_dirs():
    MEMORY_DIR.mkdir(parents=True, exist_ok=True)
    DIARIES_DIR.mkdir(parents=True, exist_ok=True)


def load_json(path, default=None):
    if path.exists():
        with open(path, "r", encoding="utf-8-sig") as f:
            return json.load(f)
    return default if default is not None else {}


def save_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def get_next_id():
    existing = list(DIARIES_DIR.glob("D*.md"))
    if not existing:
        return "D0001"
    nums = [int(f.stem[1:]) for f in existing]
    return f"D{max(nums) + 1:04d}"


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
    if CURRENT_USER_FILE.exists():
        return CURRENT_USER_FILE.read_text(encoding='utf-8').strip()
    return ""

def set_current_user(username):
    CURRENT_USER_FILE.write_text(username, encoding='utf-8')

def clear_current_user():
    if CURRENT_USER_FILE.exists():
        CURRENT_USER_FILE.unlink()


def cmd_register(username, password=""):
    if not username:
        print("错误: --name 是必填参数")
        return
    if not password:
        print("错误: --password 是必填参数，请设置8位数字密码")
        return
    if not (len(password) == 8 and password.isdigit()):
        print("错误: 密码必须为8位数字")
        return
    if password == "00000000":
        print("错误: 密码不能为默认密码 00000000")
        return
    users = load_json(USERS_FILE, {"users": {}})
    if username in users.get("users", {}):
        print(f"错误: 用户 '{username}' 已存在")
        return
    # 花名校验：注册前先检查，不在花名白名单直接拒绝
    if username not in FLOWER_NAMES:
        print(f"错误: 用户名 '{username}' 不是花朵中文名，请使用花朵中文名（如 梅花、牡丹、茉莉）")
        return
    WORKSPACE = Path.cwd().name
    did = get_next_id()
    today = datetime.date.today().isoformat()
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    body = f"# Diary {did}\n\n- **时间**: {now}\n- **日期**: {today}\n- **用户**: {username}\n- **标签**: 注册\n\n---\n\n用户 {username} 注册成功，开始记录记忆。\n\n---\n\n> 摘要: 用户 {username} 注册"
    with open(DIARIES_DIR / (f"{did}.md"), "w", encoding="utf-8-sig") as f:
        f.write(body)
    key = hashlib.sha256((did + body + now).encode("utf-8")).hexdigest()[:16]
    set_user_key(username, key, did)
    # 记录注册工作区+密码哈希
    users = load_json(USERS_FILE, {"users": {}})
    if username in users.get("users", {}):
        users["users"][username]["home"] = WORKSPACE
        users["users"][username]["pwd"] = hashlib.sha256(password.encode()).hexdigest()
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
    if COOCCUR_FILE.exists():
        data = load_json(COOCCUR_FILE, {})
        # weighted format preferred
        co = data.get("cooccurrence_weighted", data.get("cooccurrence", {}))
        return co, data.get("tag_total", {})
    return {}, {}

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

import sys; sys.stderr.write("SYS.ARGV: " + repr(sys.argv) + "\n"); sys.stderr.flush()
def cmd_search(tags_str, search_key="", username="", password=""):
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
            print(f"错误: '{username}' 注册于 [{user['home']}]，不能从 [{Path.cwd().name}] 搜索")
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
                print(f"错误: 密码错误，无法以 '{username}' 搜索")
                return
    """任何有效用户的KEY都可以解锁搜索，搜全部日记（不分用户）"""
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
        # 检查是否有注册用户（全局密钥被销毁）
        users_data = load_json(USERS_FILE, {"users": {}})
        has_users = len(users_data.get("users", {})) > 0
        if has_users and not latest_key:
            print("错误: 全局密钥已销毁，请使用 --user <用户名> --key <KEY> 登录")
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
    # Fuzzy match raw tags against actual tag names in the system
    all_known_tags = list(load_json(INDEX_FILE, {"index": {}}).get("index", {}).keys())
    fuzzy_raw = []
    for rt in raw_tags:
        if rt in all_known_tags:
            fuzzy_raw.append(rt)
        else:
            # forward: input tag is substring of known tag
            matches = [t for t in all_known_tags if rt in t]
            # reverse: known tag is substring of input tag  
            rev_matches = [t for t in all_known_tags if t in rt and t not in matches]
            matches.extend(rev_matches)
            if matches:
                fuzzy_raw.extend(matches)
                print(f'  [!] "{rt}" 未精确匹配，自动扩展为: {",".join(matches)}')
            else:
                fuzzy_raw.append(rt)
    target_tags = expand_tags(fuzzy_raw)
    raw_tags_set = set(fuzzy_raw)  # for filtering original-match-only
    index_data = load_json(INDEX_FILE, {"index": {}})
    index = index_data.get("index", {})
    candidates = {}
    for tag in target_tags:
        for entry in index.get(tag, []):
            eid = entry["id"]
            # 不按用户过滤——登录后搜全部日记
            if eid not in candidates:
                candidates[eid] = {"entry": entry, "match_count": 0, "tags_match": []}
            candidates[eid]["match_count"] += 1
            candidates[eid]["tags_match"].append(tag)
    if not candidates:
        print("(未找到匹配的日记)")
        return
    MAX_RESULTS = 50
    # Only keep diaries matching at least 1 original tag
    sc = [c for c in candidates.values() if any(t in raw_tags_set for t in c["tags_match"])]
    sc.sort(key=lambda x: (-x["match_count"], x["entry"].get("date")))
    total_cnt = len(sc)
    if total_cnt > MAX_RESULTS:
        sc = sc[:MAX_RESULTS]
    user_info = f" (登录: {username})" if username else ""
    print(f"检索标签: {','.join(target_tags)}{user_info}")
    if total_cnt > MAX_RESULTS:
        print(f"共 {total_cnt} 篇相关日记 (显示前 {MAX_RESULTS} 篇):")
    else:
        print(f"共 {total_cnt} 篇相关日记:")
    for c in sc:
        e = c["entry"]
        t = ",".join(c["tags_match"])
        ei = e.get("id", "?")
        ed = e.get("date", "?")
        cm = c["match_count"]
        lt = len(target_tags)
        es = e.get("summary", "无摘要")
        us = e.get("user", "")
        user_tag = f" [{us}]" if us else ""
        print(f"  [{ei}]{user_tag} | {ed} [{cm}/{lt}标签]")
        print(f"  标签: {t}")
        try:
            print(f"  摘要: {es}")
        except UnicodeEncodeError:
            print(f"  摘要: [摘要包含非GBK字符]")


def cmd_read(diary_ids_str):
    ids = [x.strip() for x in diary_ids_str.replace(",", " ").split() if x.strip()]
    for i, diary_id in enumerate(ids):
        p = DIARIES_DIR / f"{diary_id}.md"
        if not p.exists():
            print(f"未找到日记 {diary_id}")
            continue
        if i > 0:
            print("---")
        with open(p, "r", encoding="utf-8-sig") as f:
            print(f.read().rstrip())


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
    with open(COOCCUR_FILE, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

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
    with open(DIARIES_DIR / (did + ".md"), "w", encoding="utf-8-sig") as f:
        f.write(body)

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


def cmd_info():
    ensure_dirs()
    t = len(load_json(TAGS_FILE, {"tags": {}}).get("tags", {}))
    idx = load_json(INDEX_FILE, {"index": {}}).get("index", {})
    d = len(list(DIARIES_DIR.glob("D*.md")))
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


def cmd_update(username="", password=""):
    """更新SKILL.md后同步tracker，需密码验证"""
    if not username:
        print("错误: update 需要 -u <用户名> 参数")
        return
    if username and not user_exists(username):
        print(f"错误: 用户 '{username}' 不存在，请先 register")
        return
    if username and username not in FLOWER_NAMES:
        print(f"错误: 用户名 '{username}' 不是花朵中文名，update 已被全局禁用")
        return
    if username:
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
    # 调用 auto-updater tracker
    import subprocess
    tracker = r'C:/Users/Feng/.codex/skills/auto-updater/scripts/tracker.py'
    try:
        result = subprocess.run(['python', tracker, 'update', '--user', username, '--password', password], capture_output=True, text=True, timeout=30)
        print(result.stdout.strip())
        if result.stderr:
            print(result.stderr.strip())
    except Exception as e:
        print(f"错误: tracker update 失败 - {e}")


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
    # 从 index.json 清理密钥
    idx = load_json(INDEX_FILE, {"index": {}})
    key_name = "last_key_" + username
    if key_name in idx:
        del idx[key_name]
    save_json(INDEX_FILE, idx)
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
  tags                         列出所有标签
  search --tags <t>            检索（登录后搜全部日记）
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

流程: register -> use -u <n> -> write -> search --key <KEY>
KEY=登录密码，首次注册后获得"""


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(HELP)
        sys.exit(0)
    cmd = sys.argv[1]

    if cmd == "register":
        nm = pw = None
        for i, a in enumerate(sys.argv):
            if a == "--name" and i + 1 < len(sys.argv):
                nm = sys.argv[i + 1]
            if a == "--password" and i + 1 < len(sys.argv):
                pw = sys.argv[i + 1]
        cmd_register(nm, pw or "")

    elif cmd == "tags":
        cmd_tags()

    elif cmd == "search":
        tv = kv = uv = pw = None
        for i, a in enumerate(sys.argv):
            if a == "--tags" and i + 1 < len(sys.argv):
                tv = sys.argv[i + 1]
            if a == "--key" and i + 1 < len(sys.argv):
                kv = sys.argv[i + 1]
            if a == "--user" and i + 1 < len(sys.argv):
                uv = sys.argv[i + 1]
            if a == "--password" and i + 1 < len(sys.argv):
                pw = sys.argv[i + 1]
        cmd_search(tv, kv or "", uv or "", pw or "")

    elif cmd == "read":
        if len(sys.argv) > 2:
            cmd_read(" ".join(sys.argv[2:]))
        else:
            print("用法: read <id1> [<id2> ...]  或 read <id1,id2,id3>")

    elif cmd == "write":
        tv = sv = fp = kv = uv = pw = None
        i = 2
        while i < len(sys.argv):
            if sys.argv[i] == "-t" and i + 1 < len(sys.argv):
                tv = sys.argv[i + 1]; i += 2
            elif sys.argv[i] == "-s" and i + 1 < len(sys.argv):
                sv = sys.argv[i + 1]; i += 2
            elif sys.argv[i] == "--file" and i + 1 < len(sys.argv):
                fp = sys.argv[i + 1]; i += 2
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
            if fp:
                with open(fp, "r", encoding="utf-8-sig") as f:
                    ct = f.read().strip()
            else:
                print("错误: --file <路径> 是必填参数")
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
        uv = pw = None
        for i, a in enumerate(sys.argv):
            if a == "-u" and i + 1 < len(sys.argv):
                uv = sys.argv[i + 1]
            if a == "--password" and i + 1 < len(sys.argv):
                pw = sys.argv[i + 1]
        if uv and pw:
            cmd_update(uv, pw)
        else:
            print("错误: update 需要 -u <用户名> --password <密码>")

    else:
        print(HELP)