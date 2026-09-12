# -*- coding: utf-8 -*-
"""MCP: 记忆核心（信息/标签/留言板/用户）"""
from mcp.server.fastmcp import FastMCP
from _common import run_memory
import sqlite3, json

mcp = FastMCP("mcp-memory-core", instructions=(
    "记忆系统核心操作：信息、标签、留言板、用户注册与密钥。"
    "check_inbox 查看后自动标记已读。"))


def _latest_key(workspace, username):
    try:
        conn = sqlite3.connect(r"E:/DSH_data/.memory_registry/liubian.db", timeout=15)
        try:
            row = conn.execute(
                "SELECT value FROM docs WHERE key=?", ("index:" + workspace,)).fetchone()
            if row:
                return json.loads(row[0]).get("last_key_" + username, "")
        finally:
            conn.close()
    except Exception:
        pass
    return ""


@mcp.tool()
def memory_info(workspace: str) -> str:
    """当前工作区记忆统计（日记数/标签数/索引条目/用户数）。"""
    return run_memory(["info"], workspace=workspace)


@mcp.tool()
def list_tags(workspace: str) -> str:
    """列出当前工作区已使用的全部标签。"""
    return run_memory(["tags"], workspace=workspace)


@mcp.tool()
def get_key(username: str, workspace: str) -> str:
    """查询用户在当前工作区的最新日记 KEY（search/inbox 登录用）。"""
    k = _latest_key(workspace, username)
    return k if k else f"[无] {username} 在 {workspace} 无 KEY（先 write 一篇）"


@mcp.tool()
def check_inbox(username: str, password: str, key: str, workspace: str) -> str:
    """查留言板（查看后自动标记已读，不再推送未读）。"""
    return run_memory(["inbox", "-u", username, "--password", password, "--key", key],
                      workspace=workspace)


@mcp.tool()
def post_message(from_user: str, password: str, to_user: str, content: str, workspace: str) -> str:
    """给其他用户留言（跨对话交流）。"""
    return run_memory(["post", "-u", from_user, "--password", password,
                       "--to", to_user, "--content", content], workspace=workspace)


@mcp.tool()
def register_user(name: str, password: str, workspace: str) -> str:
    """注册用户（8位数字密码，花名）。"""
    return run_memory(["register", "--name", name, "--password", password],
                      workspace=workspace)


if __name__ == "__main__":
    from mcp_guard import start as _guard
    _guard()
    mcp.run(transport="stdio")
