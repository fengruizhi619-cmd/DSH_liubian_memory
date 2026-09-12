# -*- coding: utf-8 -*-
"""MCP: 被炉系统（KOTATSU）—— 挂机监听常驻 + 收发/检索/待办
挂机监听核心：kotatsu_watch_start 在 MCP 进程内起后台守护线程，轮询房间新消息推入内存队列，
主智能体随时 kotatsu_watch_take 取消息、处理并 kotatsu_send 回复；下线 kotatsu_watch_stop 停止。
解决 listen/watch 阻塞式轮询占用整轮对话的问题：监听由 MCP 子进程托管，主智能体可并行工作。
被炉纪律：回复不带名字前缀、括号；收到消息立即处理；下线前必须 watch_stop 停止监听。"""
import os, json, sqlite3, threading, time
from mcp.server.fastmcp import FastMCP
from _common import run_memory

mcp = FastMCP("mcp-kotatsu", instructions=(
    "被炉系统 MCP：join/send/poll 收发消息；watch_start 起后台常驻监听（守护线程轮询房间），"
    "watch_take 取新消息，watch_stop 下线停止。被炉纪律：回复不带名字前缀与括号，"
    "收到消息立即处理回复，下线前必须 watch_stop。"))

DB = r"E:/DSH_data/.memory_registry/liubian.db"
KOTATSU_DIR = r"E:/DSH_data/.memory_registry/kotatsu_rooms"

_watchers = {}
_watchers_lock = threading.Lock()


def _read_room(room):
    """读房间数据：优先 SQLite docs 表，缺失回退 JSON 文件（只读，不加锁）"""
    try:
        conn = sqlite3.connect(DB, timeout=15)
        try:
            row = conn.execute("SELECT value FROM docs WHERE key=?",
                               ("kotatsu_room:" + room,)).fetchone()
        finally:
            conn.close()
        if row and row[0]:
            return json.loads(row[0])
    except Exception:
        pass
    fp = os.path.join(KOTATSU_DIR, room + ".json")
    try:
        with open(fp, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _watch_loop(w):
    data = _read_room(w.room)
    if data:
        ls = (data.get("last_seen") or {}).get(w.username, 0) or 0
        mx = max([m.get("id", 0) for m in data.get("messages", [])], default=0)
        w.cursor = ls if ls > 0 else mx
    last_hb = time.time()
    while not w.stop_event.is_set():
        try:
            data = _read_room(w.room)
            if data:
                new = [m for m in data.get("messages", [])
                       if m.get("id", 0) > w.cursor]
                if new:
                    new.sort(key=lambda m: m.get("id", 0))
                    w.cursor = max(m.get("id", 0) for m in new)
                    items = [{"id": m.get("id"), "from": m.get("from"),
                              "time": m.get("time"), "content": m.get("content"),
                              "system": bool(m.get("system"))} for m in new]
                    with w.qlock:
                        w.queue.extend(items)
                    # 标记已读 + 更新在线（房间维度，--since=当前游标）
                    run_memory(["kotatsu", "poll", "--room", w.room, "--user", w.username,
                                "--password", w.password, "--since", str(w.cursor)],
                               w.workspace, timeout=60)
                    last_hb = time.time()
            if time.time() - last_hb >= w.heartbeat:
                run_memory(["kotatsu", "poll", "--room", w.room, "--user", w.username,
                            "--password", w.password, "--since", str(w.cursor)],
                           w.workspace, timeout=60)
                last_hb = time.time()
        except Exception as e:
            w.last_error = str(e)
        w.stop_event.wait(w.interval)


class _Watcher:
    def __init__(self, room, username, password, workspace, interval, heartbeat):
        self.room = room
        self.username = username
        self.password = password
        self.workspace = workspace
        self.interval = interval
        self.heartbeat = heartbeat
        self.queue = []
        self.qlock = threading.Lock()
        self.stop_event = threading.Event()
        self.cursor = 0
        self.thread = None
        self.last_error = ""
        self.started = time.strftime("%Y-%m-%d %H:%M:%S")


def _key(room, username):
    return "%s|%s" % (room, username)


@mcp.tool()
def kotatsu_join(room: str, username: str, password: str, workspace: str = "") -> str:
    """加入/创建被炉房间（创建者=创始人）。workspace 填当前工作区（如 skill学院）。"""
    return run_memory(["kotatsu", "join", "--room", room, "--user", username,
                       "--password", password], workspace=workspace)


@mcp.tool()
def kotatsu_send(room: str, username: str, password: str, message: str, workspace: str = "") -> str:
    """在被炉房间发消息（不带名字前缀与括号；@管理员 自动生成待办；满10条提醒创始人记日记）。"""
    return run_memory(["kotatsu", "send", "--room", room, "--user", username,
                       "--password", password, "--message", message], workspace=workspace)


@mcp.tool()
def kotatsu_poll(room: str, username: str, password: str, workspace: str = "") -> str:
    """一次性查看新消息（自动从该用户在房间的 last_seen 起取，返回新消息）。"""
    data = _read_room(room)
    since = 0
    if data:
        since = (data.get("last_seen") or {}).get(username, 0) or 0
    return run_memory(["kotatsu", "poll", "--room", room, "--user", username,
                       "--password", password, "--since", str(since)], workspace=workspace)


@mcp.tool()
def kotatsu_search(room: str, keyword: str = "", user: str = "", msg_id: int = 0,
                   workspace: str = "") -> str:
    """在聊天记录内检索（不涉及记忆系统）：keyword 关键词 / user 用户 / msg_id 消息序号。"""
    args = ["kotatsu", "search", "--room", room]
    if keyword:
        args += ["--keyword", keyword]
    if user:
        args += ["--user", user]
    if msg_id:
        args += ["--id", str(msg_id)]
    return run_memory(args, workspace=workspace)


@mcp.tool()
def kotatsu_diary_mark(room: str, username: str, password: str, workspace: str = "") -> str:
    """创始人标记日记完成，重置 10 条消息计数（仅创始人可操作）。"""
    return run_memory(["kotatsu", "diary", "--room", room, "--user", username,
                       "--password", password], workspace=workspace)


@mcp.tool()
def kotatsu_todo(room: str, username: str, password: str, action: str,
                 content: str = "", todo_id: int = 0, workspace: str = "") -> str:
    """被炉待办：add 挂载（需 content）/ list 查看 / withdraw 撤回（需 todo_id）。"""
    args = ["kotatsu", "todo", "--room", room, "--user", username,
            "--password", password, action]
    if content:
        args += ["--content", content]
    if todo_id:
        args += ["--id", str(todo_id)]
    return run_memory(args, workspace=workspace)


@mcp.tool()
def kotatsu_watch_start(room: str, username: str, password: str, workspace: str = "",
                        interval_sec: int = 5, heartbeat_sec: int = 25) -> str:
    """启动后台挂机监听：守护线程轮询房间新消息推入队列，主智能体可并行工作。
    默认每5秒查一次、每25秒心跳一次保持在线；之后用 kotatsu_watch_take 取消息。
    返回值包含监听密钥 key（形如 房间|用户），供 take/stop 使用。"""
    k = _key(room, username)
    with _watchers_lock:
        w = _watchers.get(k)
        if w and w.thread and w.thread.is_alive():
            return "[OK] 已在监听 %s|%s（队列 %d 条）" % (room, username, len(w.queue))
        w = _Watcher(room, username, password, workspace,
                     max(1, interval_sec), max(5, heartbeat_sec))
        w.thread = threading.Thread(target=_watch_loop, args=(w,), daemon=True)
        _watchers[k] = w
    w.thread.start()
    return "[OK] 已启动挂机监听 %s|%s | key=%s | 间隔 %ds 心跳 %ds" % (
        room, username, k, w.interval, w.heartbeat)


@mcp.tool()
def kotatsu_watch_take(room: str, username: str) -> str:
    """取出挂机监听收到的新消息（FIFO，取后清空队列）。返回每条消息的 发送者/时间/编号/内容。"""
    k = _key(room, username)
    with _watchers_lock:
        w = _watchers.get(k)
    if not w or not w.thread or not w.thread.is_alive():
        return "[错误] %s 未启动挂机监听（先 kotatsu_watch_start）" % k
    with w.qlock:
        items = list(w.queue)
        w.queue = []
    if not items:
        return "[%s] 无新消息" % room
    lines = []
    for m in items:
        tag = "系统" if m.get("system") else m.get("from")
        lines.append("%s %s #%s: %s" % (tag, m.get("time"), m.get("id"), m.get("content")))
    return "[%s] %d 条新消息:\n%s" % (room, len(items), "\n".join(lines))


@mcp.tool()
def kotatsu_watch_status() -> str:
    """查看所有挂机监听线程状态（房间/用户/队列/游标/启动时间）。"""
    if not _watchers:
        return "[被炉] 当前无挂机监听"
    out = []
    with _watchers_lock:
        for k, w in list(_watchers.items()):
            alive = bool(w.thread and w.thread.is_alive())
            out.append("[%s] alive=%s 队列%d 游标%s 启动%s %s" % (
                k, alive, len(w.queue), w.cursor, w.started,
                ("| 错误:" + w.last_error) if w.last_error else ""))
    return "\n".join(out)


@mcp.tool()
def kotatsu_watch_stop(room: str, username: str) -> str:
    """停止指定挂机监听并清空队列（下线时调用；在线状态随心跳停止在约70秒内自然消失）。"""
    k = _key(room, username)
    with _watchers_lock:
        w = _watchers.pop(k, None)
    if not w:
        return "[错误] %s 无挂机监听可停止" % k
    w.stop_event.set()
    if w.thread:
        w.thread.join(timeout=5)
    return "[OK] 已停止挂机监听 %s" % k


@mcp.tool()
def kotatsu_watch_stop_all() -> str:
    """停止当前进程内所有挂机监听（整体下线）。"""
    with _watchers_lock:
        keys = list(_watchers.keys())
        ws = [_watchers.pop(k, None) for k in keys]
    n = 0
    for w in ws:
        if w:
            w.stop_event.set()
            if w.thread:
                w.thread.join(timeout=3)
            n += 1
    return "[OK] 已停止 %d 个挂机监听" % n


if __name__ == "__main__":
    from mcp_guard import start as _guard
    _guard()
    mcp.run(transport="stdio")
