# -*- coding: utf-8 -*-
"""MCP: 更新系统（auto-updater 整合进记忆系统）—— 技能独立装载/检查/同步/快照
铁则：update_sync 前必须先通读该技能 SKILL.md 原文（可用 read_skill_source 读取），
未通读=未完成更新。MCP 只提供机制，通读确认由主智能体完成。"""
import os
from mcp.server.fastmcp import FastMCP
from _common import run_memory, PY, MEMORY_PY

mcp = FastMCP("mcp-update", instructions=(
    "更新系统 MCP：check/list/install/uninstall/sync/snapshot/agents/subscribe/broadcast。"
    "snapshot 刷新后自动向订阅者群发技能更新公告；broadcast 可手动群发公告。"
    "铁则：sync 前必须先 read_skill_source 通读该技能原文，未通读不得 sync。"))

SKILLS_ROOT = r"C:/Users/Feng/.codex/skills"


@mcp.tool()
def update_check(username: str, password: str, workspace: str = "") -> str:
    """检查该智能体需更新的技能（对比独立安装哈希 vs 快照）。"""
    return run_memory(["update", "-u", username, "--password", password, "check"],
                      workspace=workspace)


@mcp.tool()
def update_list(username: str, password: str, workspace: str = "") -> str:
    """查看该智能体已装载技能清单。"""
    return run_memory(["update", "-u", username, "--password", password, "list"],
                      workspace=workspace)


@mcp.tool()
def update_install(username: str, password: str, skill: str, workspace: str = "") -> str:
    """独立装载指定技能（skill 传技能文件夹名或 all 全量）。"""
    return run_memory(["update", "-u", username, "--password", password,
                       "install", "--skill", skill], workspace=workspace)


@mcp.tool()
def update_uninstall(username: str, password: str, skill: str, workspace: str = "") -> str:
    """卸载指定技能（skill 传技能文件夹名或 all 全量）。"""
    return run_memory(["update", "-u", username, "--password", password,
                       "uninstall", "--skill", skill], workspace=workspace)


@mcp.tool()
def update_sync(username: str, password: str, workspace: str = "") -> str:
    """同步已装载技能哈希到最新（必须先 read_skill_source 通读变更技能原文）。"""
    return run_memory(["update", "-u", username, "--password", password, "sync"],
                      workspace=workspace)


@mcp.tool()
def update_snapshot(username: str, password: str, workspace: str = "") -> str:
    """维护者刷新技能快照 tracker（技能文件被修改后执行；变更自动留言板广播订阅者）。"""
    return run_memory(["update", "-u", username, "--password", password, "snapshot"],
                      workspace=workspace)


@mcp.tool()
def update_agents(username: str, password: str, workspace: str = "") -> str:
    """查看全局各智能体独立安装状态（维护视角）。"""
    return run_memory(["update", "-u", username, "--password", password, "agents"],
                      workspace=workspace)


@mcp.tool()
def update_subscribe(username: str, password: str, action: str, workspace: str = "") -> str:
    """订阅/退订技能更新通知：action 为 on 或 off（默认订阅）。"""
    return run_memory(["subscribe", "-u", username, "--password", password, action],
                      workspace=workspace)


@mcp.tool()
def update_broadcast(username: str, password: str, content: str, workspace: str = "") -> str:
    """维护者向订阅了更新通知的所有用户群发留言板公告（快照广播同款机制，content 为公告内容）。
    更新技能后自动群发由 update_snapshot 触发；本工具用于手动群发公告。"""
    return run_memory(["broadcast", "-u", username, "--password", password,
                       "--content", content], workspace=workspace)

@mcp.tool()
def read_skill_source(skill: str) -> str:
    """读取指定技能 SKILL.md 原文（sync 前通读铁则用）。skill 为技能文件夹名。"""
    p = os.path.join(SKILLS_ROOT, skill, "SKILL.md")
    if not os.path.isfile(p):
        return "[错误] 未找到技能原文: %s" % p
    try:
        with open(p, "r", encoding="utf-8", errors="replace") as f:
            return f.read()
    except Exception as e:
        return "[错误] 读取失败: %s" % e


@mcp.tool()
def list_skills() -> str:
    """列出本地全部技能文件夹名。"""
    try:
        names = sorted(n for n in os.listdir(SKILLS_ROOT)
                       if os.path.isdir(os.path.join(SKILLS_ROOT, n)))
        return "共 %d 个技能:\n%s" % (len(names), "、".join(names))
    except Exception as e:
        return "[错误] %s" % e


if __name__ == "__main__":
    from mcp_guard import start as _guard
    _guard()
    mcp.run(transport="stdio")
