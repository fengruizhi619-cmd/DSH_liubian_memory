# -*- coding: utf-8 -*-
"""MCP: 校验（流变·通路二：无上下文双API 生成初始回答+校验）"""
from mcp.server.fastmcp import FastMCP
from _common import run_path2

mcp = FastMCP("mcp-memory-validate", instructions=(
    "通路二校验。对问题生成初始回答并用第二个外部API校验，返回 {initial_answer, problems}。"
    "校验通过标记[校验]已校验，未执行标未校验。"))

@mcp.tool()
def validate_answer(question: str, out_path: str = "") -> str:
    """执行通路二校验。question 为需要校验的问题/回答文本。
    返回 JSON：{initial_answer, problems[]}。"""
    return run_path2(question, out_path or None)

if __name__ == "__main__":
    from mcp_guard import start as _guard
    _guard()
    mcp.run(transport="stdio")
