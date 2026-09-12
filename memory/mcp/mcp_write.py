# -*- coding: utf-8 -*-
"""MCP: 写日记（每轮对话结束记录）"""
from mcp.server.fastmcp import FastMCP
from _common import run_memory

mcp = FastMCP("mcp-memory-write", instructions=(
    "写日记。每轮对话后必须写一篇；日志用于工作流/实践，日记用于日常。"
    "正文用 --content 直传，不产生临时文件。"))

@mcp.tool()
def write_diary(tags: str, summary: str, content: str, workspace: str, username: str, password: str) -> str:
    """写日记。tags 至少5个逗号分隔；summary 一句话摘要；content 正文（须覆盖对话要点）。
    返回 [OK] Dxxxx [KEY: ...]，KEY 即后续 search/inbox 的登录密钥。"""
    return run_memory(["write", "-t", tags, "-s", summary,
                       "--content", content, "-u", username, "--password", password],
                      workspace=workspace)

@mcp.tool()
def write_log(tags: str, summary: str, content: str, workspace: str, username: str, password: str) -> str:
    """写日志（工作流/实践记录，内容须覆盖原对话80%以上）。tags 至少5个。"""
    return run_memory(["write", "-t", tags, "-s", summary, "-k", "log",
                       "--content", content, "-u", username, "--password", password],
                      workspace=workspace)

if __name__ == "__main__":
    from mcp_guard import start as _guard
    _guard()
    mcp.run(transport="stdio")
