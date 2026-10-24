"""Latency and cost report for real phone calls (#82, #84, SPEC §12.5).

Reads the `turns` logged by the agent (timings + token usage) for recent calls and prints
p50/p95 per stage against the §12.1/§12.2 targets, the first-turn cache hit rate (L2) and the
Claude cost per call. Also home of the shared percentile / pricing math used by
harness/scripted_calls.py.

Sources:
  default        `npx convex run calls:latencyExport '{"limit": N}'` against the Convex dev
                 deployment configured in dashboard/.env.local (read-only; the internal query
                 must exist -- see docs/latency.md).
  --from-json F  an exported JSON file: a list of calls, or {"calls": [...]}. Each call is
                 {callId, startedAt?, kind?, outcome?, turns: [{idx, speaker, at, timings, usage}]}.

Usage (from agent/):
  .venv/bin/python ../harness/latency_report.py --limit 20
  .venv/bin/python ../harness/latency_report.py --from-json calls.json --json out.json
"""

import argparse
import json
import math
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Claude Haiku 5.5 (claude-haiku-5-5), USD per million tokens. Source: platform.claude.com
# pricing page (fetched 2026-10-24); matches SPEC §12.4. A request whose prompt (input + cache
# read + cache write) is over 100,000 tokens pays the higher tier for the whole request.
HAIKU_5_5_PRICES = {
    "le100k": {"input": 0.10, "output": 0.50, "write5m": 0.125, "write1h": 0.20, "read": 0.01},
    "gt100k": {"input": 0.50, "output": 2.50, "write5m": 0.625, "write1h": 1.00, "read": 0.05},
}
LONG_PROMPT_TOKENS = 100_000

# §12.1 / §12.2 / §16.2 targets, milliseconds unless noted.
TARGETS = {
    "voice_to_voice": (800, 1500),  # caller stops speaking -> agent starts speaking
    "tool_filler": (800, 1500),  # tool turn -> filler line starts
    "tool_result": (2500, 4000),  # tool turn -> result spoken (cached search)
    "llm_ttft_budget_p50": 300,  # §12.2 Claude time to first token (warm cache)
    "stt_budget_p50": 100,  # §12.2 final transcript
    "tts_budget_p50": 100,  # §12.2 TTS first audio
    "first_turn_cache_hit": 0.95,  # L2
    "cost_per_call_usd": 0.05,  # #84
    "cut_off_call_rate": 0.10,  # §3.3 / #35: fewer than 1 call in 10 with a cut-off
}
# Non-LLM stages of the §12.2 p50 budget (end-of-turn 250 + STT 100 + TTS 100 + network 50).
NON_LLM_BUDGET_MS = 500


# ---------- math ----------


def percentile(values, q: float):
    """Linear-interpolation percentile (numpy's default, 'type 7'). None for no data."""
    data = sorted(v for v in values if v is not None)
    if not data:
        return None
    if len(data) == 1:
        return float(data[0])
    pos = (len(data) - 1) * q / 100
    lo, hi = math.floor(pos), math.ceil(pos)
    return data[lo] + (data[hi] - data[lo]) * (pos - lo)


def summarize(values) -> dict:
    data = [v for v in values if v is not None]
    return {
        "n": len(data),
        "p50": percentile(data, 50),
        "p95": percentile(data, 95),
        "max": max(data) if data else None,
    }


def request_cost(
    input_tokens=0, output_tokens=0, cache_read=0, cache_write_5m=0, cache_write_1h=0
) -> float:
    """USD cost of ONE Claude Haiku 5.5 request (tier chosen from that request's prompt size)."""
    prompt = input_tokens + cache_read + cache_write_5m + cache_write_1h
    p = HAIKU_5_5_PRICES["gt100k" if prompt > LONG_PROMPT_TOKENS else "le100k"]
    return (
        input_tokens * p["input"]
        + output_tokens * p["output"]
        + cache_read * p["read"]
        + cache_write_5m * p["write5m"]
        + cache_write_1h * p["write1h"]
    ) / 1_000_000


def usage_cost(usage: dict, write_ttl: str = "5m") -> float:
    """Cost from a logged turn usage {input, output, cacheRead, cacheWrite}.

    The turn log sums all requests of a turn and does not split cache writes by TTL, so this
    is an approximation: writes are priced at `write_ttl` and the tier is chosen from the
    turn's summed prompt size (conservative: may over-apply the >100K tier).
    """
    usage = usage or {}
    write = usage.get("cacheWrite", 0) or 0
    return request_cost(
        usage.get("input", 0) or 0,
        usage.get("output", 0) or 0,
        usage.get("cacheRead", 0) or 0,
        write if write_ttl == "5m" else 0,
        write if write_ttl == "1h" else 0,
    )


def fmt_ms(value) -> str:
    return "-" if value is None else f"{value:,.0f}"


def verdict(value, limit) -> str:
    if value is None:
        return "n/a"
    return "PASS" if value <= limit else "MISS"


# ---------- real-call analysis ----------


def _diff(later, earlier):
    if later is None or earlier is None or later < earlier:
        return None
    return later - earlier


def analyze_calls(calls: list[dict], write_ttl: str = "5m") -> dict:
    stages = {
        "speechEnd->sttFinal": [],
        "sttFinal->llmRequest": [],
        "llmRequest->llmFirstToken": [],
        "sttFinal->llmFirstToken": [],
        "llmFirstToken->ttsFirstAudio": [],
        "voiceToVoice (speechEnd->ttsFirstAudio)": [],
    }
    per_call, first_hits, first_known = [], 0, 0
    for call in calls:
        turns = sorted(call.get("turns") or [], key=lambda t: t.get("idx", 0))
        cost, over100k = 0.0, 0
        first_model_turn = None
        # #35: caller turns carry timings.cutOff = 1 when the caller started talking within 1 s
        # of the agent starting to speak (echo turns are never logged), and holdOffMs when the
        # agent held off on an unfinished-sounding ending.
        user_timings = [t.get("timings") or {} for t in turns if t.get("speaker") == "user"]
        cut_offs = sum(1 for t in user_timings if t.get("cutOff") == 1)
        hold_offs = sum(1 for t in user_timings if (t.get("holdOffMs") or 0) > 0)
        for turn in turns:
            if turn.get("speaker") != "assistant":
                continue
            t = turn.get("timings") or {}
            u = turn.get("usage") or {}
            model_turn = (u.get("input", 0) + u.get("cacheRead", 0) + u.get("cacheWrite", 0)) > 0
            if not model_turn:
                continue  # templated greeting: no LLM request
            if first_model_turn is None:
                first_model_turn = turn
            stages["speechEnd->sttFinal"].append(_diff(t.get("sttFinalAt"), t.get("speechEndAt")))
            stages["sttFinal->llmRequest"].append(_diff(t.get("llmRequestAt"), t.get("sttFinalAt")))
            stages["llmRequest->llmFirstToken"].append(
                _diff(t.get("llmFirstTokenAt"), t.get("llmRequestAt"))
            )
            stages["sttFinal->llmFirstToken"].append(
                _diff(t.get("llmFirstTokenAt"), t.get("sttFinalAt"))
            )
            stages["llmFirstToken->ttsFirstAudio"].append(
                _diff(t.get("ttsFirstAudioAt"), t.get("llmFirstTokenAt"))
            )
            stages["voiceToVoice (speechEnd->ttsFirstAudio)"].append(
                _diff(t.get("ttsFirstAudioAt"), t.get("speechEndAt"))
            )
            prompt = u.get("input", 0) + u.get("cacheRead", 0) + u.get("cacheWrite", 0)
            over100k += prompt > LONG_PROMPT_TOKENS
            cost += usage_cost(u, write_ttl)
        hit = None
        if first_model_turn is not None:
            first_known += 1
            hit = (first_model_turn.get("usage") or {}).get("cacheRead", 0) > 0
            first_hits += hit
        per_call.append(
            {
                "callId": call.get("callId"),
                "startedAt": call.get("startedAt"),
                "kind": call.get("kind"),
                "outcome": call.get("outcome"),
                "modelTurns": sum(
                    1
                    for t in turns
                    if t.get("speaker") == "assistant"
                    and sum((t.get("usage") or {}).get(k, 0) for k in ("input", "cacheRead")) > 0
                ),
                "firstTurnCacheHit": hit,
                "costUsd": round(cost, 6),
                "turnsOver100kPrompt": over100k,
                "cutOffs": cut_offs,
                "holdOffTurns": hold_offs,
            }
        )
    stage_stats = {name: summarize(values) for name, values in stages.items()}
    costs = [c["costUsd"] for c in per_call if c["modelTurns"]]
    cut_off_calls = sum(1 for c in per_call if c["cutOffs"])
    return {
        "cutOffCalls": cut_off_calls,
        "cutOffCallRate": (cut_off_calls / len(per_call)) if per_call else None,
        "holdOffTurns": sum(c["holdOffTurns"] for c in per_call),
        "calls": len(calls),
        "stages": stage_stats,
        "firstTurnCacheHitRate": (first_hits / first_known) if first_known else None,
        "firstTurnCacheHits": first_hits,
        "firstTurnCacheKnown": first_known,
        "costPerCall": summarize(costs) | {"mean": (sum(costs) / len(costs)) if costs else None},
        "perCall": per_call,
        "writeTtlAssumed": write_ttl,
    }


def print_report(result: dict, out=None):
    w = (out or sys.stdout).write
    w(f"\nReal-call latency report: {result['calls']} call(s)\n\n")
    w(f"{'stage':44} {'n':>4} {'p50 ms':>9} {'p95 ms':>9} {'max ms':>9}  target\n")
    notes = {
        "speechEnd->sttFinal": f"p50 <= {TARGETS['stt_budget_p50'] + 250} (EOT 250 + STT 100)",
        "llmRequest->llmFirstToken": f"p50 <= {TARGETS['llm_ttft_budget_p50']} (§12.2)",
        "llmFirstToken->ttsFirstAudio": f"p50 <= {TARGETS['tts_budget_p50']} (§12.2)",
        "voiceToVoice (speechEnd->ttsFirstAudio)": "p50 <= 800, p95 <= 1500 (§12.1)",
    }
    for name, s in result["stages"].items():
        w(
            f"{name:44} {s['n']:>4} {fmt_ms(s['p50']):>9} {fmt_ms(s['p95']):>9} "
            f"{fmt_ms(s['max']):>9}  {notes.get(name, '')}\n"
        )
    v2v = result["stages"]["voiceToVoice (speechEnd->ttsFirstAudio)"]
    if v2v["n"]:
        w(
            f"\nL1 voice-to-voice: p50 {verdict(v2v['p50'], 800)}, "
            f"p95 {verdict(v2v['p95'], 1500)} ({v2v['n']} turns; L1 needs >= 50)\n"
        )
    else:
        w(
            "\nVoice-to-voice: no turns carry both speechEndAt and ttsFirstAudioAt yet, so only "
            "the agent-side stages can be reported.\n"
        )
    rate = result["firstTurnCacheHitRate"]
    w(
        "First-turn cache hit (L2): "
        + (
            f"{rate:.0%} ({result['firstTurnCacheHits']}/{result['firstTurnCacheKnown']} calls), "
            f"target >= 95%: {'PASS' if rate >= TARGETS['first_turn_cache_hit'] else 'MISS'}\n"
            if rate is not None
            else "n/a (no model turns)\n"
        )
    )
    c = result["costPerCall"]
    if c["n"]:
        w(
            f"Claude cost per call: mean ${c['mean']:.4f}, p95 ${c['p95']:.4f}, max ${c['max']:.4f}"
            f" (target <= ${TARGETS['cost_per_call_usd']:.2f}: "
            f"{verdict(c['p95'], TARGETS['cost_per_call_usd'])} at p95). Cache writes priced at "
            f"the {result['writeTtlAssumed']} rate; pre-warm requests are not logged.\n"
        )
    over = sum(c["turnsOver100kPrompt"] for c in result["perCall"])
    if over:
        w(f"WARNING: {over} turn(s) had prompts over 100K tokens (higher Haiku 5.5 tier).\n")
    rate = result.get("cutOffCallRate")
    if rate is not None:
        limit = TARGETS["cut_off_call_rate"]
        w(
            f"Cut-off calls (§3.3, #35): {result['cutOffCalls']}/{result['calls']} "
            f"({rate:.0%}), target < 1 in 10: {'PASS' if rate < limit else 'MISS'}. "
            f"Turns where the hold-off fired: {result['holdOffTurns']}.\n"
        )
    w("Barge-in stop time (L3) is not in the report yet; see docs/latency.md.\n")


def load_calls(path: Path) -> list[dict]:
    data = json.loads(path.read_text())
    if isinstance(data, dict):
        data = data.get("calls", data.get("value", []))
    if not isinstance(data, list):
        raise SystemExit('Expected a list of calls or {"calls": [...]}')
    return data


def fetch_from_convex(limit: int) -> list[dict]:
    """Read-only `npx convex run` of the internal export query on the dev deployment."""
    cmd = ["npx", "convex", "run", "calls:latencyExport", json.dumps({"limit": limit})]
    proc = subprocess.run(cmd, check=False, cwd=ROOT / "dashboard", capture_output=True, text=True)
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout).strip().splitlines()[-3:]
        raise SystemExit(
            "Could not run calls:latencyExport on the Convex dev deployment.\n"
            + "\n".join(tail)
            + "\nThe internal query is specified in docs/latency.md; or pass --from-json."
        )
    data = json.loads(proc.stdout)
    return data.get("calls", []) if isinstance(data, dict) else data


def main(argv=None):
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawTextHelpFormatter
    )
    parser.add_argument("--from-json", type=Path, help="exported calls JSON instead of Convex")
    parser.add_argument("--limit", type=int, default=20, help="recent calls to read (default 20)")
    parser.add_argument("--write-ttl", choices=["5m", "1h"], default="5m")
    parser.add_argument("--json", type=Path, help="also write the result as JSON here")
    args = parser.parse_args(argv)
    calls = load_calls(args.from_json) if args.from_json else fetch_from_convex(args.limit)
    result = analyze_calls(calls, args.write_ttl)
    print_report(result)
    if args.json:
        args.json.write_text(json.dumps(result, indent=2) + "\n")
    return result


if __name__ == "__main__":
    main()
