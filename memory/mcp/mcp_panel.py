# -*- coding: utf-8 -*-
"""MCP: 看面板（管理面板 + 被炉系统UI）"""
import os
from mcp.server.fastmcp import FastMCP
from _common import run_memory, PANEL_EXE, PANEL_PY, KOTATSU_UI_PY, PY, launch_detached, LIUBIAN_ROOT

mcp = FastMCP("mcp-memory-panel", instructions=(
    "打开面板：管理面板（用户/被炉/skill 管理）或被炉系统房间UI。"))

@mcp.tool()
def open_admin_panel() -> str:
    """打开流变系统管理面板（系统用户管理/被炉系统/skill管理），后台无窗口启动。"""
    if os.path.isfile(PANEL_EXE):
        return launch_detached([PANEL_EXE])
    if os.path.isfile(PANEL_PY):
        return launch_detached([PY, PANEL_PY])
    return "[错误] 未找到面板程序"

@mcp.tool()
def open_kotatsu_ui(room: str, workspace: str) -> str:
    """打开被炉系统房间 UI（实时聊天+待处理+检索），后台启动。"""
    cwd = os.path.join(LIUBIAN_ROOT, workspace) if workspace else None
    if not os.path.isfile(KOTATSU_UI_PY):
        return "[错误] 未找到 kotatsu_ui.py"
    try:
        import subprocess
        subprocess.Popen([PY, KOTATSU_UI_PY, "--room", room],
                         cwd=cwd, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return f"已启动被炉房间 [{room}] UI"
    except Exception as e:
        return f"[错误] {e}"

if __name__ == "__main__":
    from mcp_guard import start as _guard
    _guard()
    mcp.run(transport="stdio")
