# -*- coding: utf-8 -*-
"""MCP 防残留保护：启动时清理同款孤儿进程 + 父进程死亡自动退出。

背景：Codex 退出/崩溃后，其 spawn 的 MCP stdio 子进程可能变孤儿残留（多次启动积累出
重复实例，导致锁竞争、向量服务起不来、新会话连不上）。本模块让每个 MCP 子进程：
1. 启动时清理“同脚本名且其父进程已死”的孤儿，避免重复积累；
2. 起后台守护线程探测父进程；父进程消失则主动退出，做到随 Codex 消亡。
纯标准库（ctypes），不引入 psutil；不影响多窗口各自一套 MCP 的正常运行。
"""
import ctypes
import csv
import io
import os
import subprocess
import sys
import threading
import time

PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_TERMINATE = 0x0001
STILL_ACTIVE = 259
CHECK_INTERVAL = 3.0


def pid_alive(pid):
    """Windows 下判断进程是否存在且存活。"""
    if not pid or pid <= 0:
        return False
    h = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY_INFORMATION, False, int(pid))
    if not h:
        return False
    try:
        code = ctypes.c_ulong()
        if not ctypes.windll.kernel32.GetExitCodeProcess(h, ctypes.byref(code)):
            return False
        return code.value == STILL_ACTIVE
    finally:
        ctypes.windll.kernel32.CloseHandle(h)


def _ppid_alive():
    return pid_alive(os.getppid())


def _kill_pid(pid):
    h = ctypes.windll.kernel32.OpenProcess(PROCESS_TERMINATE, False, int(pid))
    if not h:
        return False
    try:
        return bool(ctypes.windll.kernel32.TerminateProcess(h, 0))
    finally:
        ctypes.windll.kernel32.CloseHandle(h)


def _list_python(script):
    """返回 [(pid, ppid, cmdline), ...]（本机 python.exe，含 script 名）"""
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" "
             "| Select-Object ProcessId,ParentProcessId,CommandLine "
             "| ConvertTo-Csv -NoTypeInformation"],
            capture_output=True, text=True, timeout=25,
            encoding="utf-8", errors="replace")
    except Exception:
        return []
    lines = [ln for ln in (out.stdout or "").splitlines() if ln.strip()]
    if not lines:
        return []
    try:
        rows = list(csv.reader(io.StringIO("\n".join(lines))))
    except Exception:
        return []
    if not rows:
        return []
    header = [h.strip().lower() for h in rows[0]]
    def idx(name):
        return header.index(name) if name in header else -1
    i_pid, i_ppid, i_cmd = idx("processid"), idx("parentprocessid"), idx("commandline")
    if i_pid < 0 or i_cmd < 0:
        return []
    out_rows = []
    for r in rows[1:]:
        if len(r) <= max(i_pid, i_ppid, i_cmd):
            continue
        pid = r[i_pid].strip()
        ppid = r[i_ppid].strip() if i_ppid >= 0 else ""
        cmd = r[i_cmd].strip()
        if script in cmd and pid.isdigit():
            out_rows.append((int(pid), int(ppid) if ppid.isdigit() else 0, cmd))
    return out_rows


def cleanup_orphans(script=None):
    """清理同脚本名、且其父进程已死（孤儿）的 python 进程。返回清理数。"""
    script = script or os.path.basename(sys.argv[0])
    me = os.getpid()
    killed = 0
    for pid, ppid, _cmd in _list_python(script):
        if pid == me or not pid_alive(pid):
            continue
        # 父进程仍活着 -> 属于活跃 Codex，保留；父进程已死 -> 孤儿，清理
        if pid_alive(ppid):
            continue
        if _kill_pid(pid):
            killed += 1
    return killed


def _watch_loop():
    # 给一点启动宽限，避免刚 spawn 就误判
    time.sleep(CHECK_INTERVAL)
    while True:
        if not _ppid_alive():
            # 父进程（Codex）已消失，主动退出，避免残留
            os._exit(0)
        time.sleep(CHECK_INTERVAL)



def dedupe_same_parent(script=None):
    """已废弃：同父去重会打断 Codex 的 MCP 连接（Transport closed），故不再执行。
    保留占位以避免旧调用报错；重复实例问题改由父死孤儿清理处理。"""
    return 0

def start():
    """在每个 MCP 的 __main__ 入口调用：清理同款孤儿 + 父进程死亡自毁。
    清理与父进程探测均放后台线程，不阻塞 stdio 握手。"""
    def _bg():
        time.sleep(1.5)  # 先让主线程进入 mcp.run 建立 stdio
        try:
            cleanup_orphans()
        except Exception:
            pass
        _watch_loop()
    threading.Thread(target=_bg, daemon=True).start()


if __name__ == "__main__":
    n = cleanup_orphans()
    print("mcp_guard standalone: cleaned %d orphan(s); ppid=%s alive=%s" %
          (n, os.getppid(), _ppid_alive()))
