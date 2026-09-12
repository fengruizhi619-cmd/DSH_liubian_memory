# -*- coding: utf-8 -*-
"""MCP: 检索（语义+tag 联合检索记忆）"""
from mcp.server.fastmcp import FastMCP
from _common import run_memory

mcp = FastMCP("mcp-memory-search", instructions=(
    "记忆检索（全局，跨全部工作区）。search 自动叠加语义向量检索+tag 检索（1:1 融合），"
    "结果带 @工作区 标识；read 支持 Dxxxx 自动定位或 Dxxxx@工作区 精确读取。"))

@mcp.tool()
def search_diary(tags: str, username: str, password: str, key: str, workspace: str = "") -> str:
    """全局检索记忆（跨全部工作区，不再按工作区划分）。tags 至少4个逗号分隔；
    key 为该用户最新日记KEY；workspace 可留空（全局）。结果形如 [D0001@工程0]。"""
    return run_memory(["search", "--tags", tags,
                       "-u", username, "--password", password, "--key", key],
                      workspace=workspace or None)

@mcp.tool()
def read_diary(diary_ids: str, workspace: str = "") -> str:
    """读取指定日记正文（跨工作区）。diary_ids 可为 D0932 或 D0932@工程0；
    不带工作区时自动定位（唯一或当前工作区）。"""
    return run_memory(["read", diary_ids], workspace=workspace or None)

if __name__ == "__main__":
    from mcp_guard import start as _guard
    _guard()
    mcp.run(transport="stdio")
