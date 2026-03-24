"""
LLM Provider A/B 对比基准测试

运行方式：
    python -m scripts.benchmark_providers

对比指标：
    1. JSON 可解析率（LLM 输出能被正确解析为 JSON 的比例）
    2. 字段完整度（业务字段如 nodes/gates/confidence/analysis_summary 的完整程度）
    3. 延迟（平均 / 最小 / 最大 响应时间）
    4. 成本（API token 估算，仅云端 Provider）

根据评分自动建议默认 Provider。
"""

import asyncio
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from backend.core.llm.manager import get_llm_manager
from backend.config import settings

# ── 测试样本 ──────────────────────────────────────────────

TEST_PROMPTS = [
    # 电机类
    "生成一个电机无法启动的故障树，顶事件：电机无法启动",
    "生成一个电机轴承过热故障的故障树，顶事件：电机轴承温度超过90°C",
    # 液压系统
    "生成一个液压缸无动作的故障树，顶事件：液压缸不伸出",
    "生成一个液压泵压力不足的故障树，顶事件：液压系统压力低于额定值",
    # PLC/控制系统
    "生成一个PLC通讯失败的故障树，顶事件：PLC与上位机通讯中断",
    "生成一个PLC程序异常停机的故障树，顶事件：PLC触发急停",
    # 泵类
    "生成一个离心泵无法启动的故障树，顶事件：离心泵启动后无流量输出",
    "生成一个螺杆泵流量不足的故障树，顶事件：螺杆泵输出流量低于额定值",
    # 阀门类
    "生成一个气动阀门无法关闭的故障树，顶事件：气动调节阀关闭不到位",
    "生成一个液压阀泄漏的故障树，顶事件：液压方向阀内泄漏导致系统失压",
    # 传感器/仪表
    "生成一个压力传感器读数异常的故障树，顶事件：压力变送器显示值与实际值偏差超限",
    "生成一个液位计失真的故障树，顶事件：磁翻板液位计液位显示与实际不符",
    # 润滑/冷却
    "生成一个润滑系统阻塞的故障树，顶事件：主轴润滑泵无法建立油压",
    "生成一个冷却系统失效的故障树，顶事件：冷却水循环中断导致设备过热",
    # 综合
    "生成一个变频器过载停机的故障树，顶事件：变频器报过载故障并停机",
    "生成一个制动器失灵的故障树，顶事件：电动执行器制动器无法抱闸",
]

# ── Benchmark Prompt（精简版，避免 Token 过长影响对比） ──

BENCH_PROMPT_TEMPLATE = """你是工业设备故障分析专家，请基于以下顶事件生成故障树。

顶事件：{top_event}

要求：
- 输出一严格JSON对象，格式：{{"top_event":"...","nodes":[...],"gates":[...],"confidence":0.0,"analysis_summary":"..."}}
- nodes每项包含：id(N001/N002...), type(top|intermediate|basic), name, description, source_ref(null)
- gates每项包含：id(G001...), type(AND|OR), output_node, input_nodes(数组)
- 只输出JSON，不要任何其他文字
"""


def print_divider():
    print("=" * 70)


def print_table(results: dict):
    """打印对比表格"""
    print(f"\n{'指标':<25} " + "  ".join(f"{p:>18}" for p in results))
    print("-" * 70)

    rows = [
        ("总请求数", "total_requests"),
        ("成功次数", "success_count"),
        ("JSON可解析率", "parseable_json_rate"),
        ("字段完整度", "field_completeness"),
        ("平均延迟 (ms)", "avg_latency_ms"),
        ("最小延迟 (ms)", "min_latency_ms"),
        ("最大延迟 (ms)", "max_latency_ms"),
    ]

    for label, key in rows:
        vals = []
        for pname, r in results.items():
            val = getattr(r, key, None)
            if val is None:
                vals.append("N/A")
            elif key == "parseable_json_rate":
                vals.append(f"{val:.1%}")
            elif key in ("field_completeness", "avg_latency_ms", "min_latency_ms", "max_latency_ms"):
                vals.append(f"{val:.1f}")
            else:
                vals.append(str(int(val)))
        print(f"{label:<25} " + "  ".join(f"{v:>18}" for v in vals))


async def main():
    print_divider()
    print("  LLM Provider A/B 对比基准测试")
    print_divider()

    manager = get_llm_manager()
    available = []

    for pname in ["ollama", "minimax"]:
        try:
            p = manager.get_provider(pname)
            ok = p.is_available()
            print(f"\n  [{pname}] {'✓ 可用' if ok else '✗ 不可用'}")
            if ok:
                available.append(pname)
        except Exception as e:
            print(f"\n  [{pname}] ✗ 不可用: {e}")

    if len(available) < 2:
        print(f"\n  注意：只有 {len(available)} 个 Provider 可用，对比受限。")

    if not available:
        print("\n  没有可用的 Provider，退出。")
        return

    bench_prompts = [
        BENCH_PROMPT_TEMPLATE.format(top_event=p.replace("顶事件：", ""))
        for p in TEST_PROMPTS
    ]

    print(f"\n  测试样本数: {len(bench_prompts)}")
    print(f"  对比 Provider: {available}")
    print(f"  默认主 Provider: {settings.LLM_PROVIDER}")
    print(f"  默认备用 Provider: {manager.fallback_name}")
    print("\n  正在运行测试，请稍候...\n")

    t0 = time.perf_counter()
    results = await manager.benchmark_providers(bench_prompts, providers=available)
    elapsed = time.perf_counter() - t0

    # 补充可解析率
    for pname, r in results.items():
        r.parseable_json_rate = (
            r.parseable_json_count / r.total_requests
            if r.total_requests > 0 else 0.0
        )

    print_table(results)

    # ── 评分与推荐 ────────────────────────────────────────
    print_divider()
    print("  评分与推荐")
    print_divider()

    scores = {}
    for pname, r in results.items():
        # 加权评分：可解析率 40% + 字段完整度 40% + 延迟 20%（越快越好）
        latency_score = 1.0 - min(r.avg_latency_ms / 30000, 1.0)  # 30s 封顶 = 0分
        score = (
            r.parseable_json_rate * 0.40
            + r.field_completeness * 0.40
            + latency_score * 0.20
        )
        scores[pname] = {
            "json_rate": r.parseable_json_rate,
            "field_score": r.field_completeness,
            "latency_score": latency_score,
            "total": score,
        }
        print(f"\n  [{pname}]")
        print(f"    JSON 可解析率:  {r.parseable_json_rate:.1%}  (权重 40%)")
        print(f"    字段完整度:     {r.field_completeness:.2f}  (权重 40%)")
        print(f"    延迟得分:       {latency_score:.2f}  (权重 20%，延迟 {r.avg_latency_ms:.0f}ms)")
        print(f"    综合评分:       {score:.3f}")

    best = max(scores, key=lambda k: scores[k]["total"])
    primary = settings.LLM_PROVIDER
    fallback = manager.fallback_name

    print(f"\n  ── 建议 ──")
    print(f"  当前默认: primary={primary}, fallback={fallback}")
    print(f"  推荐默认: {best}（综合得分 {scores[best]['total']:.3f}）")

    # 建议逻辑
    if best != primary:
        print(f"\n  ⚠  建议：将 LLM_PROVIDER 改为 '{best}'")
    else:
        print(f"\n  ✓  当前配置 '{primary}' 即为评分最高，继续使用。")

    # Ollama 特殊提示
    if "ollama" in available:
        print(f"\n  💡 Ollama 为本地模型，零 API 成本，建议作为日常开发首选。")
        print(f"     MiniMax 建议保留作为 fallback 或生产环境使用。")

    print(f"\n  总耗时: {elapsed:.1f}s")
    print_divider()

    # 保存结果
    output_path = Path(__file__).parent.parent / "benchmark_results.json"
    serializable = {
        pname: {
            "provider": r.provider,
            "total_requests": r.total_requests,
            "success_count": r.success_count,
            "parseable_json_count": r.parseable_json_count,
            "parseable_json_rate": r.parseable_json_rate,
            "field_completeness": r.field_completeness,
            "avg_latency_ms": r.avg_latency_ms,
            "min_latency_ms": r.min_latency_ms,
            "max_latency_ms": r.max_latency_ms,
            "errors": r.errors[:5],  # 只保留前5条
            "scores": scores[pname],
        }
        for pname, r in results.items()
    }
    output_path.write_text(json.dumps(serializable, ensure_ascii=False, indent=2))
    print(f"\n  结果已保存到: {output_path}")


if __name__ == "__main__":
    asyncio.run(main())
