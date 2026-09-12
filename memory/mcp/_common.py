# -*- coding: utf-8 -*-
"""流变·记忆系统 MCP 公共辅助：子进程调用 memory.py / 通路二 / 面板"""
import os
import subprocess

PY = r"E:\python\python.exe"
MEMORY_PY = r"C:\Users\Feng\.codex\skills\memory-skill\scripts\memory.py"
LIUBIAN_ROOT = r"E:\codex_data"
PANEL_EXE = r"C:\Users\Feng\.codex\skills\liubian\dist\liubian_panel.exe"
PANEL_PY = r"C:\Users\Feng\.codex\skills\liubian\scripts\liubian_panel_qt.py"
KOTATSU_UI_PY = r"C:\Users\Feng\.codex\skills\memory-skill\scripts\kotatsu_ui.py"
PATH2_PY = r"C:\Users\Feng\.codex\skills\liubian\scripts\通路2\liubian_path2.py"


def _cwd_for(workspace):
    """memory.py 用 Path.cwd().name 路由工作区，这里显式指定 cwd"""
    if workspace:
        d = os.path.join(LIUBIAN_ROOT, workspace)
        if os.path.isdir(d):
            return d
    return None


def run_memory(args, workspace=None, timeout=180):
    """运行 memory.py 并返回 stdout+stderr"""
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    cwd = _cwd_for(workspace)
    try:
        r = subprocess.run(
            [PY, MEMORY_PY] + args,
            stdin=subprocess.DEVNULL, capture_output=True, text=True, encoding="utf-8",
            errors="replace", timeout=timeout, cwd=cwd, env=env)
        out = (r.stdout or "").strip()
        if r.stderr and r.stderr.strip():
            out += "\n[stderr] " + r.stderr.strip()
        return out or "(无输出)"
    except subprocess.TimeoutExpired:
        return "[错误] 执行超时"
    except Exception as e:
        return f"[错误] {e}"


def run_path2(question, out_path=None):
    """运行通路二（无上下文外部校验），返回 JSON 字符串"""
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    args = [PY, PATH2_PY, question]
    if out_path:
        args += ["--out", out_path]
    try:
        r = subprocess.run(args, stdin=subprocess.DEVNULL, capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=300, env=env)
        out = (r.stdout or "").strip()
        if r.stderr and r.stderr.strip():
            out += "\n[stderr] " + r.stderr.strip()
        return out or "(无输出)"
    except subprocess.TimeoutExpired:
        return "[错误] 通路二执行超时"
    except Exception as e:
        return f"[错误] {e}"


def launch_detached(cmd):
    """无窗口后台启动（面板/被炉UI）"""
    import sys as _sys
    try:
        subprocess.Popen(cmd, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return "已启动"
    except Exception as e:
        return f"[错误] {e}"
