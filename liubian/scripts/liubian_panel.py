# -*- coding: utf-8 -*-
"""流变系统管理面板 —— 本地 Web UI（仅真人管理员使用）
功能：系统总览 / 用户管理（删除需二次确认、重置密码）/ 记忆检索 / 被炉房间 / 技能装载 / 通路二用量。
纯文字清爽风格、无 emoji、行距 1.5、无登录（仅绑定 127.0.0.1）。
用法：python liubian_panel.py [--port 8801]
"""
import argparse
import json
import subprocess
import sys
import webbrowser
import threading
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import sys as _sys
_sys.path.insert(0, r"C:\Users\Feng\.codex\skills\memory-skill\scripts")
import memory_db

ROOT = Path(__file__).resolve().parent
REGISTRY = Path(r"E:\DSH_data\.memory_registry")
TRACKER = Path(r"C:\Users\Feng\.codex\skills\.skill_tracker")
MEMORY_PY = Path(r"C:\Users\Feng\.codex\skills\memory-skill\scripts\memory.py")
CODEX_DATA = Path(r"E:\codex_data")
DEFAULT_WS = "skill学院"

CSS = """
body{font-family:"Microsoft YaHei",system-ui,sans-serif;line-height:1.5;margin:0;background:#f5f6f8;color:#222}
header{background:#2f3542;color:#fff;padding:12px 20px;display:flex;justify-content:space-between;align-items:center}
header h1{font-size:18px;margin:0}
nav a{color:#cfd8e3;margin-right:14px;text-decoration:none;font-size:14px}
nav a:hover{color:#fff}
.wrap{max-width:1100px;margin:18px auto;padding:0 16px}
.card{background:#fff;border-radius:8px;padding:16px 20px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{border:1px solid #e3e6ea;padding:6px 8px;text-align:left}
th{background:#eef1f5}
button,input[type=submit]{background:#3a5a8c;color:#fff;border:0;border-radius:4px;padding:5px 12px;cursor:pointer;font-size:13px}
button.danger{background:#b0403f}
input[type=text],input[type=password],select{padding:5px 8px;border:1px solid #c5ccd6;border-radius:4px;font-size:13px}
.tag{display:inline-block;background:#e8eef7;border-radius:4px;padding:2px 8px;margin:2px;font-size:12px}
.ok{color:#2e7d32}.warn{color:#c77700}.bad{color:#c62828}
.foot{color:#8a929c;font-size:12px;text-align:center;margin:24px 0}
"""


def load_json(path, default=None):
    p = Path(path)
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8-sig"))
        except Exception:
            pass
    return default if default is not None else {}


def ws_list():
    return memory_db.list_workspaces()


def page(title, body):
    return f"""<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">
<title>{title} - 流变系统</title><style>{CSS}</style></head><body>
<header><h1>流变系统管理面板</h1><nav>
<a href="/">总览</a><a href="/users">用户</a><a href="/memory">记忆</a>
<a href="/rooms">被炉</a><a href="/update">更新</a><a href="/path">通路</a></nav></header>
<div class="wrap">{body}<div class="foot">流变系统 liubian_panel · 仅本机管理员访问</div></div></body></html>"""


def esc(s):
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


# ---------- 数据采集 ----------

def overview_data():
    users = memory_db.get_users().get("users", {})
    agents = {k.split(":", 1)[1] for k in memory_db.keys_with_prefix("agent_versions:")}
    rooms = [k.split(":", 1)[1] for k in memory_db.keys_with_prefix("kotatsu_room:")]
    ws_mem = []
    for ws in ws_list():
        d = (CODEX_DATA / ws / "memory")
        n = len(list((d / "diaries").glob("D*.md")))
        ws_mem.append((ws, n))
    # 通路二用量汇总
    usage = []
    logf = ROOT / "通路2" / "usage_log.jsonl"
    if logf.exists():
        for line in logf.read_text(encoding="utf-8", errors="replace").splitlines():
            try:
                usage.append(json.loads(line))
            except Exception:
                pass
    total = sum(u.get("total_tokens", 0) for u in usage)
    calls = len(usage)
    return users, agents, rooms, ws_mem, usage, total, calls


def users_table(users, agents):
    rows = []
    for name, meta in sorted(users.items()):
        sync = "有" if name in agents else "-"
        sync_cls = "ok" if name in agents else "warn"
        rows.append(
            f"<tr><td><b>{esc(name)}</b></td><td>{esc(meta.get('created',''))}</td>"
            f"<td>{esc(meta.get('created_id',''))}</td><td>{esc(meta.get('home','-'))}</td>"
            f"<td class='{sync_cls}'>{sync}</td>"
            f"<td>{esc(meta.get('last_key','')[:8])}</td>"
            f"<td><form method='post' action='/users/delete' style='display:inline'>"
            f"<input type='hidden' name='name' value='{esc(name)}'>"
            f"<input type='hidden' name='confirm' value='1'>"
            f"<button class='danger' onclick='return confirm(\"确认删除 {esc(name)}？此操作不可逆\")'>删除</button></form> "
            f"<form method='post' action='/users/resetpwd' style='display:inline'>"
            f"<input type='hidden' name='name' value='{esc(name)}'>"
            f"<input type='text' name='pwd' maxlength='8' size='8' placeholder='新8位密码'>"
            f"<button>重置密码</button></form></td></tr>")
    return rows


def run_memory(args, cwd=None):
    cmd = [sys.executable, "-X", "utf8", str(MEMORY_PY)] + args
    try:
        r = subprocess.run(cmd, cwd=str(cwd) if cwd else None,
                           capture_output=True, text=True, encoding="utf-8", timeout=30)
        return (r.stdout or "") + (r.stderr or "")
    except Exception as e:
        return f"执行失败: {e}"


# ---------- 路由 ----------

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, html):
        data = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _redirect(self, loc):
        self.send_response(302)
        self.send_header("Location", loc)
        self.end_headers()

    def do_GET(self):
        u = urlparse(self.path)
        try:
            if u.path == "/" or u.path == "/overview":
                self.page_overview()
            elif u.path == "/users":
                self.page_users()
            elif u.path == "/memory":
                self.page_memory(u)
            elif u.path == "/diary":
                self.page_diary(u)
            elif u.path == "/rooms":
                self.page_rooms()
            elif u.path == "/update":
                self.page_update()
            elif u.path == "/path":
                self.page_path()
            else:
                self._send(page("404", "<p>页面不存在</p>"))
        except Exception as e:
            self._send(page("错误", f"<p class='bad'>{esc(e)}</p>"))

    def do_POST(self):
        u = urlparse(self.path)
        try:
            length = int(self.headers.get("Content-Length", 0))
            q = parse_qs(self.rfile.read(length).decode("utf-8"))
            if u.path == "/users/delete":
                name = (q.get("name") or [""])[0].strip()
                if name:
                    msg = run_memory(["delete-user", "-u", name, "--confirm"])
                    self._cleanup_user_key(name)
                    self._redirect("/users?msg=" + name)
                    return
            elif u.path == "/users/resetpwd":
                name = (q.get("name") or [""])[0].strip()
                pwd = (q.get("pwd") or [""])[0].strip()
                if name and len(pwd) == 8 and pwd.isdigit() and pwd != "00000000":
                    run_memory(["rename", "-u", name, "--password", pwd])
                self._redirect("/users")
                return
            self._redirect("/")
        except Exception as e:
            self._send(page("错误", f"<p class='bad'>{esc(e)}</p>"))

    def _cleanup_user_key(self, name):
        """删除用户后，清理各工作区 index.json 里的 last_key_<name>（保留日记索引）"""
        key = "last_key_" + name
        for ws in ws_list():
            if memory_db.get_workspace_index(ws) is None:
                continue
            idx = memory_db.get_workspace_index(ws)
            if key in idx:
                del idx[key]
                memory_db.save_workspace_index(ws, idx)

    # --- 页面 ---

    def page_overview(self):
        users, agents, rooms, ws_mem, usage, total, calls = overview_data()
        body = [f"""<div class='card'><h2>系统总览</h2>
<p>注册用户 <b>{len(users)}</b> · 被炉房间 <b>{len(rooms)}</b> ·
通路二累计调用 <b>{calls}</b> 次 / <b>{total}</b> tokens</p>
<table><tr><th>工作区</th><th>日记数</th></tr>"""]
        for ws, n in ws_mem:
            body.append(f"<tr><td>{esc(ws)}</td><td>{n}</td></tr>")
        body.append("</table></div>")
        body.append(f"<div class='card'><h2>最近注册用户</h2>"
                    + "".join(users_table(users, agents)[:8]) if users else "<p>无用户</p>"
                    + "</div>")
        self._send(page("总览", "".join(body)))

    def page_users(self):
        users, agents, _, _, _, _, _ = overview_data()
        rows = users_table(users, agents)
        body = f"""<div class='card'><h2>用户管理（{len(users)}）</h2>
<table><tr><th>用户名</th><th>注册日期</th><th>注册ID</th><th>工作区</th>
<th>技能同步</th><th>密钥</th><th>操作</th></tr>{"".join(rows)}</table>
<p class='foot'>删除不可逆（日记文件保留）；重置密码需 8 位数字且不能为默认密码。</p></div>"""
        self._send(page("用户", body))

    def page_memory(self, u):
        q = parse_qs(u.query)
        ws = (q.get("ws") or [DEFAULT_WS])[0]
        tag = (q.get("tag") or [""])[0].strip()
        sel = "".join(f"<option value='{esc(w)}' {'selected' if w==ws else ''}>{esc(w)}</option>"
                      for w in ws_list())
        idx = memory_db.get_workspace_index(ws).get("index", {})
        hits = []
        if tag:
            for t, items in idx.items():
                if tag in t:
                    for it in items:
                        hits.append((t, it.get("id"), it.get("date"), it.get("summary", ""),
                                     it.get("user", "")))
            hits.sort(key=lambda x: int(x[1][1:]) if x[1][1:].isdigit() else 0, reverse=True)
            hits = hits[:50]
        rows = "".join(
            f"<tr><td><span class='tag'>{esc(t)}</span></td><td><a href='/diary?ws={esc(ws)}&id={esc(i)}'>{esc(i)}</a></td>"
            f"<td>{esc(d)}</td><td>{esc(u2)}</td><td>{esc(s)}</td></tr>"
            for t, i, d, s, u2 in hits) if tag else "<tr><td colspan='5'>输入标签关键词检索</td></tr>"
        body = f"""<div class='card'><h2>记忆检索</h2>
<form method='get' action='/memory'>工作区 <select name='ws'>{sel}</select>
标签关键词 <input type='text' name='tag' value='{esc(tag)}' placeholder='如：流变系统'>
<button>检索</button></form>
<p class='foot'>共命中 {len(hits)} 条（按 ID 倒序，最多 50）</p></div>
<div class='card'><table><tr><th>标签</th><th>ID</th><th>日期</th><th>用户</th><th>摘要</th></tr>{rows}</table></div>"""
        self._send(page("记忆", body))

    def page_diary(self, u):
        q = parse_qs(u.query)
        ws = (q.get("ws") or [DEFAULT_WS])[0]
        did = (q.get("id") or [""])[0]
        content = memory_db.get_diary_content(ws, did)
        if content is None:
            p = CODEX_DATA / ws / "memory" / "diaries" / f"{did}.md"
            content = p.read_text(encoding="utf-8-sig", errors="replace") if p.exists() else "日记不存在"
        body = f"<div class='card'><h2>{esc(did)} <span class='foot'>{esc(ws)}</span></h2><pre style='white-space:pre-wrap'>{esc(content)}</pre></div>"
        self._send(page(f"{did}", body))

    def page_rooms(self):
        rooms = [k.split(":", 1)[1] for k in memory_db.keys_with_prefix("kotatsu_room:")]
        body = [f"<div class='card'><h2>被炉房间（{len(rooms)}）</h2><table>"
                f"<tr><th>房间</th><th>成员</th><th>消息数</th><th>待办</th><th>创始人</th></tr>"]
        for r in rooms:
            d = memory_db.get_doc("kotatsu_room:" + r, {})
            body.append(f"<tr><td>{esc(r)}</td><td>{esc(','.join(d.get('members', [])))}</td>"
                        f"<td>{len(d.get('messages', []))}</td><td>{len(d.get('todos', []))}</td>"
                        f"<td>{esc(d.get('founder',''))}</td></tr>")
        body.append("</table></div>")
        self._send(page("被炉", "".join(body)))

    def page_update(self):
        agents = {}
        for k in memory_db.keys_with_prefix("agent_versions:"):
            try:
                d = memory_db.get_doc(k, {})
                agents[k.split(":", 1)[1]] = (d.get("updated_at") or "", list(d.get("skills", {}).keys()))
            except Exception:
                pass
        rows = "".join(
            f"<tr><td>{esc(a)}</td><td>{esc(t)}</td><td>{len(sk)}</td><td>{esc(','.join(sk[:6]))}</td></tr>"
            for a, (t, sk) in sorted(agents.items()))
        body = f"<div class='card'><h2>智能体技能装载（{len(agents)}）</h2>"
        body += "<table><tr><th>智能体</th><th>最后同步</th><th>技能数</th><th>已装载</th></tr>" + rows + "</table></div>"
        self._send(page("更新", body))

    def page_path(self):
        logf = ROOT / "通路2" / "usage_log.jsonl"
        usage = []
        if logf.exists():
            for line in logf.read_text(encoding="utf-8", errors="replace").splitlines():
                try:
                    usage.append(json.loads(line))
                except Exception:
                    pass
        rows = "".join(
            f"<tr><td>{esc(u.get('time',''))}</td><td>{esc(u.get('call',''))}</td>"
            f"<td>{esc(u.get('model',''))}</td><td>{u.get('prompt_tokens',0)}</td>"
            f"<td>{u.get('completion_tokens',0)}</td><td>{u.get('total_tokens',0)}</td>"
            f"<td>{u.get('cache_hit_tokens',0)}</td><td>{u.get('cache_miss_tokens',0)}</td>"
            f"<td>{u.get('latency_ms',0)}</td></tr>" for u in usage[-50:][::-1])
        total = sum(u.get("total_tokens", 0) for u in usage)
        body = f"""<div class='card'><h2>通路二用量（累计 {len(usage)} 次 / {total} tokens）</h2>
<table><tr><th>时间</th><th>调用</th><th>模型</th><th>prompt</th><th>completion</th>
<th>total</th><th>缓存命中</th><th>缓存未命中</th><th>延迟ms</th></tr>{rows}</table></div>"""
        self._send(page("通路", body))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8801)
    ap.add_argument("--no-browser", action="store_true", help="不自动打开浏览器")
    args = ap.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    url = f"http://127.0.0.1:{args.port}/"
    print(f"[liubian_panel] 已启动: {url}")
    if not args.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[liubian_panel] 已停止")


if __name__ == "__main__":
    main()
