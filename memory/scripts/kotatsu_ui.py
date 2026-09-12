# -*- coding: utf-8 -*-
"""被炉系统 UI：本地 Web 服务器 + SSE 实时推送 + 纯文字清爽界面
仅真人管理员使用：无需登录选择与密码，发送身份固定为「管理员」。
功能：实时对话、处理事项（已办结/拒绝/撤回）、聊天记录检索（序列号/用户名/时间）。"""
import json, sys, time, threading, webbrowser, argparse, datetime
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

import sys as _sys
_sys.path.insert(0, r"C:\Users\Feng\.codex\skills\memory-skill\scripts")
import memory_db as _mdb

GLOBAL_DIR = Path("E:/DSH_data/.memory_registry")
KOTATSU_DIR = GLOBAL_DIR / "kotatsu_rooms"
ADMIN = "管理员"
DIARY_INTERVAL = 10


def load_json(path, default=None):
    if path.exists():
        try:
            with open(path, "r", encoding="utf-8-sig") as f:
                return json.load(f)
        except Exception:
            return default if default is not None else {}
    return default if default is not None else {}


def load_kotatsu_room(room):
    KOTATSU_DIR.mkdir(parents=True, exist_ok=True)
    room_file = KOTATSU_DIR / f"{room}.json"
    default = {"room": room, "members": [], "messages": [], "todos": [],
               "next_id": 1, "next_todo": 1, "founder": "", "msg_since_diary": 0}
    data = _mdb.get_doc("kotatsu_room:" + room, None)
    if data is None:
        data = default
    for k, v in default.items():
        if k not in data:
            data[k] = v
    return data, room_file


def save_kotatsu_room(room_file, data):
    # SQLite 存储（WAL 事务，天然防并发损坏）
    _mdb.set_doc("kotatsu_room:" + Path(room_file).stem, data)


def kotatsu_lock(room_file, timeout=15):
    """跨进程文件锁（Windows msvcrt）：保护被炉房间文件读-改-写事务
    注意: 初始化读写与被锁持有都会抛 PermissionError/OSError, 统一进入等待重试."""
    import msvcrt as _m
    room_file = Path(room_file)
    lock_path = room_file.parent / (room_file.name + ".lock")
    deadline = time.time() + timeout
    while True:
        lf = None
        try:
            lf = open(lock_path, "a+b")
            lf.seek(0)
            if lf.read(1) == b"":
                lf.write(b"0")
                lf.flush()
            lf.seek(0)
            _m.locking(lf.fileno(), _m.LK_NBLCK, 1)
            return lf
        except OSError:
            try:
                if lf is not None:
                    lf.close()
            except OSError:
                pass
            if time.time() > deadline:
                raise TimeoutError("[kotatsu_lock] 房间文件锁超时: " + room_file.name)
            time.sleep(0.05)


def kotatsu_unlock(lf):
    """释放被炉房间文件锁"""
    import msvcrt as _m
    try:
        lf.seek(0)
        _m.locking(lf.fileno(), _m.LK_UNLCK, 1)
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
        data, room_file = load_kotatsu_room(room)
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


ROOM = ""
data_lock = threading.Lock()
clients = []

HTML = """<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<title>被炉系统 %s</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: "Microsoft YaHei", "PingFang SC", sans-serif; background: #f5f6f8; color: #333; height: 100vh; display: flex; flex-direction: column; }
.header { background: #4a9fe0; color: #fff; padding: 10px 20px; display: flex; align-items: baseline; }
.header .title { font-family: "SimHei", "Microsoft YaHei", sans-serif; font-size: 24px; font-weight: bold; letter-spacing: 2px; color: #fff; }
.header .sep { margin: 0 10px; color: rgba(255,255,255,0.85); font-size: 16px; }
.header .room { font-size: 14px; color: #ffffff; }
.header .online { margin-left: auto; font-size: 13px; color: #e8f4ff; }
.main { flex: 1; display: flex; min-height: 0; }
.chat { flex: 1; overflow-y: auto; padding: 16px 20px; }
.side { width: 320px; border-left: 1px solid #e0e2e5; background: #fff; display: flex; flex-direction: column; overflow-y: auto; }
.panel { padding: 12px 16px; border-bottom: 1px solid #eef0f3; }
.panel h3 { font-size: 14px; color: #2f3542; margin-bottom: 8px; border-left: 3px solid #4a9fe0; padding-left: 8px; }
.msg { margin-bottom: 14px; line-height: 1.5; }
.msg .meta { font-size: 12px; color: #9aa0a6; margin-bottom: 2px; }
.msg .meta b { font-size: 14px; color: #2f3542; }
.msg .rd { color: #7a8699; font-size: 12px; }
.msg .bubble { background: #eef1f5; padding: 8px 12px; border-radius: 8px; border: 1px solid #c5ccd6; word-break: break-word; }
.msg.me { margin-left: auto; }
.msg.me .bubble { background: #e3f0ff; color: #333; border: 1px solid #9ec5ff; }
.msg.other .bubble { background: #eef1f5; color: #333; border: 1px solid #c5ccd6; }
.msg.sys { text-align: center; color: #9aa0a6; font-size: 12px; margin: 10px 0; line-height: 1.5; }
.input-bar { background: #fff; border-top: 1px solid #e0e2e5; padding: 10px 16px; display: flex; gap: 8px; align-items: center; }
.input-bar textarea { flex: 1; padding: 10px; border: 1px solid #ccd0d5; border-radius: 6px; font-size: 14px; line-height: 1.5; resize: none; min-height: 42px; max-height: 140px; font-family: inherit; }
.input-bar button { padding: 10px 22px; background: #2f3542; color: #fff; border: none; border-radius: 6px; font-size: 14px; cursor: pointer; }
.input-bar button:hover { background: #57606f; }
.tgroup { font-size: 12px; color: #9aa0a6; margin: 8px 0 6px; font-weight: bold; }
.tgroup.fold { cursor: pointer; user-select: none; }
.todo { border: 1px solid #e8eaed; border-radius: 6px; padding: 8px; margin-bottom: 8px; font-size: 13px; line-height: 1.5; }
.todo .tmeta { color: #9aa0a6; font-size: 12px; margin-bottom: 4px; }
.todo .tmeta b { color: #2f3542; font-size: 13px; }
.todo.pending { border-color: #ffa502; }
.todo .tbtn { margin-top: 6px; display: flex; gap: 6px; }
.todo .tbtn button { padding: 3px 10px; border: 1px solid #ccd0d5; border-radius: 4px; background: #fff; cursor: pointer; font-size: 12px; }
.todo .tbtn button.done { color: #2e7d32; }
.todo .tbtn button.reject { color: #c62828; }
.search-line { display: flex; gap: 6px; margin-bottom: 8px; }
.search-line input { flex: 1; min-width: 0; padding: 6px; border: 1px solid #ccd0d5; border-radius: 4px; font-size: 13px; }
.search-btn { padding: 6px 12px; border: 1px solid #ccd0d5; border-radius: 4px; background: #fff; cursor: pointer; font-size: 13px; }
.search-res { max-height: 220px; overflow-y: auto; font-size: 13px; line-height: 1.5; }
.search-res .hit { border-bottom: 1px dashed #eef0f3; padding: 6px 0; }
.hint { color: #9aa0a6; font-size: 12px; margin-top: 4px; }
</style>
</head>
<body>
<div class="header"><span class="title">被炉</span><span class="sep">-</span><span class="room">%s</span><span class="online" id="onlineUsers"></span></div>
<div class="main">
  <div class="chat" id="chat"></div>
  <div class="side">
    <div class="panel">
      <h3>处理事项</h3>
      <div id="todos">加载中...</div>
    </div>
    <div class="panel">
      <h3 onclick="toggleSearch()" style="cursor:pointer">检索记录<span id="searchArrow" style="float:right;font-weight:normal">折叠</span></h3>
      <div id="searchBox">
      <div class="search-line"><input id="sid" placeholder="消息ID"></div>
      <div class="search-line"><input id="suser" placeholder="用户名"></div>
      <div class="search-line"><input id="sfrom" placeholder="起始时间(YYYY-MM-DD)"></div>
      <div class="search-line"><input id="sto" placeholder="结束时间(YYYY-MM-DD)"></div>
      <button class="search-btn" onclick="doSearch()">检索</button>
      <button class="search-btn" onclick="clearSearch()">清除</button>
      <div class="search-res" id="sres"></div>
      <div class="hint" id="shint"></div>
      </div>
    </div>
  </div>
</div>
<div class="input-bar">
  <textarea id="msg" rows="1" placeholder="输入消息，回车发送，Shift+回车换行" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();send()}" oninput="autoGrow()"></textarea>
  <button onclick="send()">发送</button>
</div>
<script>
const room = %s;
const chat = document.getElementById('chat');
const msgEl = document.getElementById('msg');
const ADMIN = '\u7ba1\u7406\u5458';
let lastId = 0;
let doneOpen = false;

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function nearBottom() {
  return chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80;
}

function scrollToBottom(force) {
  if (force || nearBottom()) chat.scrollTop = chat.scrollHeight;
}

function addMsg(m, forceScroll) {
  const div = document.createElement('div');
  if (m.system) {
    div.className = 'msg sys';
    div.textContent = m.content;
  } else {
    div.className = 'msg ' + (m.from === ADMIN ? 'me' : 'other');
    const rb = (m.read_by && m.read_by.length) ? m.read_by.map(escapeHtml).join('、') : '无';
    div.innerHTML = '<div class="meta"><b>' + escapeHtml(m.from) + '</b>  ' + escapeHtml(m.time) + '  #' + m.id +
      '  <span class="rd">已读: ' + rb + '</span></div>' +
      '<div class="bubble">' + escapeHtml(m.content) + '</div>';
  }
  chat.appendChild(div);
  scrollToBottom(forceScroll);
}

function addSystem(t) {
  const div = document.createElement('div');
  div.className = 'msg sys';
  div.textContent = t;
  chat.appendChild(div);
  scrollToBottom(false);
}

function renderOnline(lastActive) {
  const el = document.getElementById('onlineUsers');
  if (!el) return;
  if (!lastActive) { el.textContent = ''; return; }
  const now = Date.now();
  const names = [];
  Object.keys(lastActive).forEach(k => {
    const t = String(lastActive[k] || '').replace(' ', 'T');
    const diff = now - new Date(t).getTime();
    if (isNaN(diff) || diff < 70000) names.push(k);
  });
  el.textContent = names.length ? '在线: ' + names.join('、') : '在线: 无';
}

async function loadHistory() {
  const r = await fetch('/history');
  const data = await r.json();
  chat.innerHTML = '';
  data.messages.forEach(m => { addMsg(m, true); lastId = Math.max(lastId, m.id); });
  renderTodos(data.todos || []);
  renderOnline(data.last_active || {});
}

const STATUS = {pending: '待处理', done: '已办结', rejected: '已拒绝', withdrawn: '已撤回'};

function todoHtml(t) {
  const cls = t.status === 'pending' ? 'todo pending' : 'todo';
  let btns = '';
  if (t.status === 'pending') {
    btns = '<div class="tbtn"><button class="done" onclick="todoAct(' + t.id + ',&quot;done&quot;)">已办结</button>' +
           '<button class="reject" onclick="todoAct(' + t.id + ',&quot;reject&quot;)">拒绝</button></div>';
  }
  return '<div class="' + cls + '"><div class="tmeta"><b>' + escapeHtml(t.from) + '</b> #' + t.id +
    ' [' + (STATUS[t.status] || t.status) + '] ' + escapeHtml(t.time) + '</div>' +
    '<div>' + escapeHtml(t.content) + '</div>' + btns + '</div>';
}

function renderTodos(todos) {
  const el = document.getElementById('todos');
  if (!todos.length) { el.innerHTML = '<div class="hint">暂无待办</div>'; return; }
  const pending = todos.filter(t => t.status === 'pending');
  const done = todos.filter(t => t.status !== 'pending');
  let html = '';
  if (pending.length) {
    html += '<div class="tgroup">待处理（' + pending.length + '）</div>' + pending.map(todoHtml).join('');
  }
  if (done.length) {
    html += '<div class="tgroup fold" onclick="toggleDone()">已处理（' + done.length + '）<span id="doneArrow">' + (doneOpen ? '折叠' : '展开') + '</span></div>' +
            '<div id="doneBox" style="display:' + (doneOpen ? '' : 'none') + '">' + done.map(todoHtml).join('') + '</div>';
  }
  el.innerHTML = html;
}

function toggleDone() {
  const box = document.getElementById('doneBox');
  const arrow = document.getElementById('doneArrow');
  if (!box) return;
  const hidden = box.style.display === 'none';
  box.style.display = hidden ? '' : 'none';
  doneOpen = hidden;
  if (arrow) arrow.textContent = doneOpen ? '折叠' : '展开';
}

async function todoAct(id, action) {
  const r = await fetch('/todo/' + action, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({id})});
  const res = await r.json();
  if (!res.ok) { alert(res.error); return; }
  const h = await (await fetch('/todos')).json();
  renderTodos(h.todos || []);
}

async function send() {
  const content = msgEl.value.trim();
  if (!content) return;
  const r = await fetch('/send', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({content})});
  const res = await r.json();
  if (!res.ok) { alert(res.error); return; }
  msgEl.value = '';
  autoGrow();
  pollHistory();
}

async function doSearch() {
  const id = document.getElementById('sid').value.trim();
  const user = document.getElementById('suser').value.trim();
  const frm = document.getElementById('sfrom').value.trim();
  const to = document.getElementById('sto').value.trim();
  const r = await fetch('/history');
  const data = await r.json();
  let msgs = data.messages;
  if (id) msgs = msgs.filter(m => m.id === Number(id));
  if (user) msgs = msgs.filter(m => m.from === user);
  if (frm) msgs = msgs.filter(m => (m.time || '').slice(0, 10) >= frm);
  if (to) msgs = msgs.filter(m => (m.time || '').slice(0, 10) <= to);
  const el = document.getElementById('sres');
  const hint = document.getElementById('shint');
  if (!msgs.length) { el.innerHTML = ''; hint.textContent = '无匹配消息'; return; }
  el.innerHTML = msgs.map(m => '<div class="hit"><b>' + escapeHtml(m.from) + '</b> #' + m.id + ' ' + escapeHtml(m.time) + '<br>' + escapeHtml(m.content) + '</div>').join('');
  hint.textContent = '共 ' + msgs.length + ' 条';
}

function autoGrow() {
  const el = msgEl;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 140) + 'px';
}

function toggleSearch() {
  const box = document.getElementById('searchBox');
  const arrow = document.getElementById('searchArrow');
  if (!box) return;
  const hidden = box.style.display === 'none';
  box.style.display = hidden ? '' : 'none';
  arrow.textContent = hidden ? '折叠' : '展开';
}

function clearSearch() {
  ['sid','suser','sfrom','sto'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('sres').innerHTML = '';
  document.getElementById('shint').textContent = '';
}

async function refreshTodos() {
  const h = await (await fetch('/todos')).json();
  renderTodos(h.todos || []);
}

const es = new EventSource('/events');
es.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id > lastId) { addMsg(m, false); lastId = m.id; }
  refreshTodos();
};
es.onerror = () => { addSystem('连接中断，正在重连...'); };

// 兜底轮询：2秒拉取一次历史，SSE失效时也能实时刷新，且服务重启后自动恢复
async function pollHistory() {
  try {
    const r = await fetch('/history');
    const data = await r.json();
    const msgs = data.messages || [];
    const last = msgs.length ? msgs[msgs.length - 1].id : 0;
    if (last > lastId) {
      msgs.forEach(m => { if (m.id > lastId) { addMsg(m, false); lastId = m.id; } });
    }
    renderTodos(data.todos || []);
    renderOnline(data.last_active || {});
  } catch (e) {}
}
setInterval(pollHistory, 2000);
window.addEventListener('focus', pollHistory);
document.addEventListener('visibilitychange', () => { if (!document.hidden) pollHistory(); });

loadHistory();
</script>
</body>
</html>"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        global ROOM
        url = urlparse(self.path)
        if url.path == "/":
            body = HTML % (ROOM, ROOM, json.dumps(ROOM))
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body.encode("utf-8"))
        elif url.path == "/history":
            def _mut(d):
                now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                d.setdefault("last_active", {})[ADMIN] = now
                for m in d.get("messages", []):
                    if ADMIN not in m.setdefault("read_by", []):
                        m["read_by"].append(ADMIN)
                return d
            data = update_kotatsu_room(ROOM, _mut)
            self._json(data)
        elif url.path == "/todos":
            data, _ = load_kotatsu_room(ROOM)
            self._json({"todos": data.get("todos", [])})
        elif url.path == "/events":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            with data_lock:
                clients.append(self)
            try:
                while True:
                    time.sleep(1)
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
            except Exception:
                pass
            finally:
                with data_lock:
                    if self in clients:
                        clients.remove(self)
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        global ROOM
        url = urlparse(self.path)
        if url.path == "/send":
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            content = body.get("content", "").strip()
            if not content:
                self._json({"ok": False, "error": "内容不能为空"})
                return
            def _mut(data):
                if ADMIN not in data["members"]:
                    data["members"].append(ADMIN)
                mid = data["next_id"]
                now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                data["messages"].append({"id": mid, "from": ADMIN, "content": content, "time": now, "read_by": [ADMIN]})
                data.setdefault("last_active", {})[ADMIN] = now
                data["next_id"] = mid + 1
                data["msg_since_diary"] = data.get("msg_since_diary", 0) + 1
                appended = [data["messages"][-1]]
                if data.get("msg_since_diary", 0) >= DIARY_INTERVAL:
                    kotatsu_diary_reminder(data)
                    appended.append(data["messages"][-1])
                return mid, appended
            mid, appended = update_kotatsu_room(ROOM, _mut)
            with data_lock:
                for c in list(clients):
                    try:
                        for m in appended:
                            payload = json.dumps(m)
                            c.wfile.write(("data: " + payload + "\n\n").encode("utf-8"))
                            c.wfile.flush()
                    except Exception:
                        pass
            self._json({"ok": True, "id": mid})
        elif url.path in ("/todo/done", "/todo/reject"):
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            tid = int(body.get("id", 0))
            def _mut(data):
                target = next((t for t in data.get("todos", []) if t["id"] == tid), None)
                if not target:
                    return ("error", "待办 #" + str(tid) + " 不存在")
                if target["status"] != "pending":
                    return ("error", "待办 #" + str(tid) + " 状态为 " + target["status"] + "，无法操作")
                target["status"] = "done" if url.path == "/todo/done" else "rejected"
                return ("ok", None)
            res = update_kotatsu_room(ROOM, _mut)
            if res[0] == "error":
                self._json({"ok": False, "error": res[1]})
                return
            self._json({"ok": True})
        else:
            self._json({"ok": False, "error": "not found"})

    def _json(self, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    global ROOM
    ap = argparse.ArgumentParser()
    ap.add_argument("--room", required=True)
    ap.add_argument("--port", type=int, default=0)
    args = ap.parse_args()
    ROOM = args.room
    load_kotatsu_room(ROOM)
    port = args.port
    if port == 0:
        import socket
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        s.close()
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    url = "http://127.0.0.1:" + str(port)
    print("[OK] 被炉系统 UI: " + url)
    print("[INFO] 房间: " + ROOM + " | 按 Ctrl+C 停止")
    threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[OK] UI 已停止")


if __name__ == "__main__":
    main()
