# -*- coding: utf-8 -*-
"""
liubian_path2.py — 流变·通路 通路二执行工具（一次性、无状态产品）

职责：
  1. 调用外部 API-A：根据原问题生成初始回答
  2. 调用外部 API-B：对初始回答进行检验，列出问题清单
  3. 输出结构化 JSON：{ initial_answer, problems, usage }
  4. 每次调用把 token 用量追加进 usage_log（用于确认两个通路/两次调用的 token 消耗）

特性：
  - 无上下文继承：每个外部 API 只拿到本调用需要的内容
  - 两个外部 API 相互独立配置（url / key / model），默认不同模型以便对比消耗
  - 不检索记忆、不写记忆、不写日记

用法：
  python liubian_path2.py "问题文本"
  python liubian_path2.py "问题文本" --config <配置路径> --out <输出json路径>
"""

import argparse
import hashlib
import json
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

DEFAULT_DIR = Path(__file__).resolve().parent
DEFAULT_CONFIG = DEFAULT_DIR / "config.json"
DEFAULT_USAGE_LOG = DEFAULT_DIR / "usage_log.jsonl"

PROMPT_A = (
    "你是一个直接、准确的回答生成器。请针对用户的问题给出清晰、完整、结构化的回答。"
    "只回答这一个问题，不要提及任何外部记忆或上下文。"
)

PROMPT_B = (
    "你是一个回答检验员。请仔细审查给定的「初始回答」，找出其中存在的问题。\n"
    "检查维度：\n"
    "1. 逻辑断裂：推理前后矛盾、跳跃\n"
    "2. 未回答问题：遗漏了问题的关键部分\n"
    "3. 证据缺失：给出结论但没有依据\n"
    "4. 过度声称：把推测说成事实\n"
    "5. 答非所问：内容与问题无关\n"
    "请严格只输出一个 JSON 数组，不要使用 markdown 代码块，不要输出任何其他文字：\n"
    '[{"问题": "...", "位置": "初始回答中的位置描述", "理由": "...", "维度": "逻辑断裂|未回答问题|证据缺失|过度声称|答非所问"}]'
)


def mask_key(key):
    if not key:
        return ""
    if len(key) <= 8:
        return "*" * len(key)
    return key[:4] + "*" * (len(key) - 8) + key[-4:]


def load_config(path):
    cfg = json.loads(Path(path).read_text(encoding="utf-8"))
    for profile in ("api_a", "api_b"):
        if profile not in cfg:
            raise SystemExit(f"错误: 配置缺少 {profile}")
        for field in ("url", "api_key", "model"):
            if not cfg[profile].get(field):
                raise SystemExit(f"错误: 配置 {profile}.{field} 为空")
    return cfg


def call_api(profile, messages, max_tokens):
    url = profile["url"]
    payload = {
        "model": profile["model"],
        "messages": messages,
        "max_tokens": max_tokens or profile.get("max_tokens", 2048),
        "temperature": profile.get("temperature", 0.3),
    }
    if profile.get("thinking"):
        payload["thinking"] = profile["thinking"]
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + profile["api_key"],
        },
        method="POST",
    )
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=120) as resp:
        raw = resp.read().decode("utf-8")
    latency_ms = int((time.time() - t0) * 1000)
    data = json.loads(raw)
    content = data["choices"][0]["message"]["content"]
    usage = data.get("usage", {})
    usage["latency_ms"] = latency_ms
    return content, usage


def run_path2(question, cfg, out_path=None):
    api_a = cfg["api_a"]
    api_b = cfg["api_b"]

    # 1) API-A：初始回答
    ans_a, usage_a = call_api(
        api_a,
        [{"role": "system", "content": PROMPT_A},
         {"role": "user", "content": question}],
        api_a.get("max_tokens"),
    )

    # 2) API-B：检验（依赖 A 的初始回答）
    critique_input = f"原问题：{question}\n\n初始回答：\n{ans_a}"
    problems_raw, usage_b = call_api(
        api_b,
        [{"role": "system", "content": PROMPT_B},
         {"role": "user", "content": critique_input}],
        api_b.get("max_tokens"),
    )
    problems = parse_problems(problems_raw)

    result = {
        "question": question,
        "initial_answer": ans_a,
        "problems": problems,
        "usage": {
            "api_a": {"model": api_a["model"], "name": api_a.get("name", "初始回答"), **usage_a},
            "api_b": {"model": api_b["model"], "name": api_b.get("name", "检验"), **usage_b},
        },
    }
    if out_path:
        Path(out_path).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return result


def parse_problems(raw):
    text = raw.strip()
    # 去掉 markdown 代码块围栏
    if text.startswith("```"):
        text = text.split("\n", 1)[-1] if "\n" in text else text[3:]
        text = text.rsplit("```", 1)[0]
        text = text.strip()
        if text.startswith("json"):
            text = text[4:].strip()
    # 整体解析：列表 或 {"problems": [...]} 包装
    try:
        data = json.loads(text)
        if isinstance(data, list):
            return data
        if isinstance(data, dict) and isinstance(data.get("problems"), list):
            return data["problems"]
    except Exception:
        pass
    # 数组片段提取：取最后一个完整的 [...] 段
    start = text.find("[")
    end = text.rfind("]")
    if start != -1 and end != -1 and end > start:
        try:
            data = json.loads(text[start:end + 1])
            if isinstance(data, list):
                return data
        except Exception:
            pass
    # 兜底：解析失败时按原文整段记录
    return [{"问题": text[:500], "位置": "全文", "理由": "检验输出未按JSON格式，保留原文", "维度": "未结构化"}]


def log_usage(result):
    for key in ("api_a", "api_b"):
        u = result["usage"][key]
        entry = {
            "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "call": key,
            "name": u.get("name"),
            "model": u.get("model"),
            "prompt_tokens": u.get("prompt_tokens", 0),
            "completion_tokens": u.get("completion_tokens", 0),
            "total_tokens": u.get("total_tokens", 0),
            "cache_hit_tokens": u.get("prompt_cache_hit_tokens", 0),
            "cache_miss_tokens": u.get("prompt_cache_miss_tokens", 0),
            "latency_ms": u.get("latency_ms", 0),
        }
        with open(DEFAULT_USAGE_LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return True


def main():
    ap = argparse.ArgumentParser(description="流变·通路 通路二执行工具")
    ap.add_argument("question", help="原问题文本")
    ap.add_argument("--config", default=str(DEFAULT_CONFIG), help="配置文件路径")
    ap.add_argument("--out", default="", help="结果JSON输出路径")
    args = ap.parse_args()

    cfg = load_config(args.config)
    print(f"[通路二] API-A: {cfg['api_a']['model']} | API-B: {cfg['api_b']['model']}", file=sys.stderr)

    result = run_path2(args.question, cfg, args.out or None)
    log_usage(result)

    # 标准输出只输出结构化 JSON，供主智能体直接消费
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
