"""Convex state assertions for scripted calls (#22).

After a scripted call ends, the harness reads what actually happened in the Convex DEV
deployment and checks it against the script's machine-readable "convex" block. Reads go
through the Convex CLI (`npx convex data <table>` in dashboard/), which only ever targets the
dev deployment configured in dashboard/.env.local; this module never passes --prod.

Assertion format (every key optional; a key may be an object with "needs": "<feature>" to mark
an assertion that can only pass once that feature lands, e.g. "memory-writer" or "scam"):

  "convex": {
    "waitForMemory": true,                 # poll calls.memoryWrite for up to 60 s first
    "call": {"outcome": "ordered", "kind": "order", "summary": true,
             "scamIncident": true, "scamHold": true, "scamIncidentIncludes": "gift card"},
    "callSummary": {"value": true, "needs": "memory-writer"},  # summary written after hang-up
    "orders": {"count": 1, "none": false, "nonePaid": false,
               "last": {"status": "paid", "totalCents": 2145,
                        "items": {"demo-coffee-big": 1}}},
    "alerts": [{"type": "scam", "excerptIncludes": "gift card|medicare"}],
    "noAlerts": ["scam", "connect_nudge"],  # alert types that must NOT exist for this call
    "facts": {
      "added": [{"text": "recital", "evidence": true}],     # facts sourced from this call
      "notAdded": ["owe|medicare"],                           # no added fact may match
      "addedMax": 10,
      "status": [{"text": "tomato", "status": "forgotten", "evidenceTurnRedacted": true}]
    },
    "followups": [{"speakable": "recital", "status": "closed", "askedInThisCall": true}],
    "followupsAskedInCall": 1,
    "followupsAdded": [{"speakable": "recital", "notBeforeAfterCall": true}],
    "turns": {"anyRedacted": true, "noneInclude": ["owe medicare"], "refusedAny": true},
    "latency": {"metric": "llm", "p50Ms": 800, "p95Ms": 1500, "minTurns": 1}
  }

Patterns are case-insensitive regular expressions. Failures are plain strings; one tagged
"[needs X] ..." belongs to a feature that hasn't landed (see scripted_calls status PENDING).
"""

import json
import re
import shutil
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DASHBOARD = ROOT / "dashboard"
MEMORY_WAIT_S = 60
TABLE_LIMIT = 500
TURN_LIMIT = 2000

# §12.1: voice-to-voice p50 800 ms / p95 1.5 s; §12.2 leaves ~300 ms of that to Claude.
LATENCY_METRICS = {
    # caller's turn received -> first model token (what the agent measures today)
    "llm": ("sttFinalAt", "llmFirstTokenAt"),
    # end of caller speech -> first agent audio (needs both marks from the voice layer)
    "voice": ("speechEndAt", "ttsFirstAudioAt"),
}


class ConvexError(RuntimeError):
    pass


class ConvexCLI:
    """Reads tables and runs internal functions on the DEV deployment through the Convex CLI."""

    def __init__(self, cwd: Path = DASHBOARD, *, timeout: float = 60):
        self.cwd = Path(cwd)
        self.timeout = timeout
        if not shutil.which("npx"):
            raise ConvexError("npx is not on PATH; the Convex CLI is needed for state checks")

    def _cli(self, *args: str) -> str:
        cmd = ["npx", "convex", *args]
        assert "--prod" not in cmd  # never against production
        done = subprocess.run(
            cmd, check=False, cwd=self.cwd, capture_output=True, text=True, timeout=self.timeout
        )
        if done.returncode != 0:
            # The CLI's stderr names the command, not credentials; keep it short anyway.
            raise ConvexError(f"convex {args[0]} failed: {done.stderr.strip()[-300:]}")
        return done.stdout

    def table(self, name: str, limit: int = TABLE_LIMIT) -> list[dict]:
        out = self._cli("data", name, "--limit", str(limit), "--format", "jsonArray")
        start = out.find("[")
        return json.loads(out[start:]) if start >= 0 else []

    def run(self, function: str, args: dict) -> object:
        out = self._cli("run", function, json.dumps(args))
        try:
            return json.loads(out)
        except ValueError:
            return out.strip()


# ---------- snapshot ----------


def snapshot(source, call_id: str) -> dict:
    """Everything the assertions need about one call and its household, read once."""
    calls = source.table("calls")
    call = next((c for c in calls if c.get("_id") == call_id), None)
    if call is None:
        raise ConvexError(f"call {call_id} not found in the dev deployment")
    household = call.get("householdId")
    household_calls = {c["_id"] for c in calls if household and c.get("householdId") == household}
    household_calls.add(call_id)
    turns = [t for t in source.table("turns", TURN_LIMIT) if t.get("callId") in household_calls]
    return {
        "call": call,
        "orders": sorted(
            (o for o in source.table("orders") if o.get("callId") == call_id),
            key=lambda o: o.get("_creationTime", 0),
        ),
        "alerts": [a for a in source.table("alerts") if a.get("callId") == call_id],
        "facts": [f for f in source.table("memory_facts") if f.get("householdId") == household]
        if household
        else [],
        "followups": [f for f in source.table("followups") if f.get("householdId") == household]
        if household
        else [],
        "turns": sorted(turns, key=lambda t: (t.get("callId", ""), t.get("idx", 0))),
    }


def wait_for_memory(source, call_id: str, timeout: float | None = None, poll: float = 3):
    """Poll until the memory writer has run for this call (calls.memoryWrite set)."""
    deadline = time.monotonic() + (MEMORY_WAIT_S if timeout is None else timeout)
    while True:
        call = next((c for c in source.table("calls", 50) if c.get("_id") == call_id), None)
        if call and call.get("memoryWrite"):
            return call["memoryWrite"]
        if time.monotonic() >= deadline:
            return None
        time.sleep(poll)


def last_awaiting_order(source, call_id: str) -> dict | None:
    pending = [
        o
        for o in source.table("orders", 50)
        if o.get("callId") == call_id and o.get("status") == "awaiting_approval"
    ]
    return max(pending, key=lambda o: o.get("_creationTime", 0)) if pending else None


# ---------- assertions ----------


def _m(pattern: str, text) -> bool:
    return bool(re.search(pattern, str(text or ""), re.IGNORECASE))


def _spec(value):
    """(value, needs) for an assertion that may be wrapped as {"value"/fields..., "needs"}."""
    if isinstance(value, dict) and "needs" in value:
        value = dict(value)
        needs = value.pop("needs")
        return value.pop("value", value), needs
    return value, None


class _Checks:
    def __init__(self):
        self.failures: list[str] = []

    def fail(self, message: str, needs: str | None):
        self.failures.append(f"[needs {needs}] {message}" if needs else message)


def _items(order: dict) -> dict:
    out: dict[str, int] = {}
    for item in order.get("items") or []:
        sid = item.get("storeItemId")
        out[sid] = out.get(sid, 0) + int(item.get("qty", 1))
    return out


def _percentile(values: list[float], q: float) -> float:
    values = sorted(values)
    k = (len(values) - 1) * q
    lo = int(k)
    hi = min(lo + 1, len(values) - 1)
    return values[lo] + (values[hi] - values[lo]) * (k - lo)


def turn_latencies(turns: list[dict], metric: str = "llm") -> list[float]:
    start, end = LATENCY_METRICS[metric]
    out = []
    for turn in turns:
        t = turn.get("timings") or {}
        if turn.get("speaker") == "assistant" and t.get(start) is not None and t.get(end):
            out.append(t[end] - t[start])
    return out


def latency_failures(turns: list[dict], spec: dict, where: str = "latency") -> list[str]:
    """p50/p95 thresholds over assistant turns that carry both timing marks."""
    metric = spec.get("metric", "llm")
    values = turn_latencies(turns, metric)
    if len(values) < spec.get("minTurns", 1):
        return [f"{where}: only {len(values)} turn(s) carry {metric} timings"]
    failures = []
    for key, q in (("p50Ms", 0.5), ("p95Ms", 0.95)):
        if key in spec:
            value = _percentile(values, q)
            if value > spec[key]:
                failures.append(f"{where}: {metric} {key[:3]} {value:.0f} ms > {spec[key]} ms")
    return failures


def check_state(snap: dict, expect: dict | None) -> list[str]:
    """Failures for a snapshot against a script's "convex" block; [] means pass."""
    expect = expect or {}
    c = _Checks()
    call = snap["call"]
    call_id = call["_id"]

    spec, needs = _spec(expect.get("call"))
    for key, want in (spec or {}).items():
        if key in ("outcome", "kind"):
            if call.get(key) != want:
                c.fail(f"calls.{key} {call.get(key)!r} != {want!r}", needs)
        elif key == "summary":
            if bool(call.get("summary")) != want:
                c.fail(f"call summary {'missing' if want else 'present'}", needs)
        elif key == "scamIncident":
            if bool(call.get("scamIncident")) != want:
                c.fail(f"scam incident {'missing' if want else 'recorded'}", needs)
        elif key == "scamIncidentIncludes":
            if not _m(want, call.get("scamIncident")):
                c.fail(f"scam incident does not match /{want}/", needs)
        elif key == "scamHold":  # noqa: SIM102 -- one branch per key
            if bool((call.get("scamHold") or {}).get("active")) != want:
                c.fail(f"scam hold {'not active' if want else 'active'}", needs)

    spec, needs = _spec(expect.get("callSummary"))
    if spec is not None and bool(call.get("summary")) != spec:
        c.fail(f"call summary {'missing' if spec else 'present'}", needs)

    spec, needs = _spec(expect.get("orders"))
    orders = snap["orders"]
    if spec:
        if spec.get("none") and orders:
            c.fail(f"{len(orders)} order(s) recorded but none should be", needs)
        if spec.get("nonePaid") and any(o.get("status") == "paid" for o in orders):
            c.fail("an order was paid but none should be", needs)
        if "count" in spec and len(orders) != spec["count"]:
            c.fail(f"{len(orders)} order(s) recorded, expected {spec['count']}", needs)
        last_want = spec.get("last")
        if last_want:
            if not orders:
                c.fail("no order recorded for this call", needs)
            else:
                last = orders[-1]
                for key in ("status", "totalCents"):
                    if key in last_want and last.get(key) != last_want[key]:
                        c.fail(f"order {key} {last.get(key)!r} != {last_want[key]!r}", needs)
                if "items" in last_want and _items(last) != last_want["items"]:
                    c.fail(f"order items {_items(last)} != {last_want['items']}", needs)

    for want in expect.get("alerts") or []:
        want, needs = _spec(want)
        found = [
            a
            for a in snap["alerts"]
            if a.get("type") == want.get("type")
            and (
                not want.get("excerptIncludes")
                or _m(want["excerptIncludes"], a.get("transcriptExcerpt"))
            )
            and (not want.get("messageIncludes") or _m(want["messageIncludes"], a.get("message")))
        ]
        if not found:
            c.fail(f"no {want.get('type')} alert matching {want}", needs)
        elif "count" in want and len(found) != want["count"]:
            c.fail(f"{len(found)} {want.get('type')} alerts, expected {want['count']}", needs)
    spec, needs = _spec(expect.get("noAlerts"))
    for kind in spec or []:
        if any(a.get("type") == kind for a in snap["alerts"]):
            c.fail(f"a {kind} alert was sent but must not be", needs)

    spec, needs = _spec(expect.get("facts"))
    added = [f for f in snap["facts"] if f.get("sourceCallId") == call_id]
    for want in (spec or {}).get("added") or []:
        want, w_needs = _spec(want)
        found = [
            f
            for f in added
            if _m(want["text"], f.get("text")) and (not want.get("evidence") or f.get("evidence"))
        ]
        if not found:
            c.fail(
                f"no fact from this call matches /{want['text']}/ with evidence", w_needs or needs
            )
    for pattern in (spec or {}).get("notAdded") or []:
        bad = [f["text"] for f in added if _m(pattern, f.get("text"))]
        if bad:
            c.fail(f"fact(s) that must not exist were added: {bad}", needs)
    if spec and "addedMax" in spec and len(added) > spec["addedMax"]:
        c.fail(f"{len(added)} facts added, at most {spec['addedMax']}", needs)
    for want in (spec or {}).get("status") or []:
        want, w_needs = _spec(want)
        matching = [f for f in snap["facts"] if _m(want["text"], f.get("text"))]
        if not matching:
            c.fail(f"no fact matches /{want['text']}/", w_needs or needs)
            continue
        if not any(f.get("status") == want["status"] for f in matching):
            c.fail(
                f"fact /{want['text']}/ status {[f.get('status') for f in matching]} "
                f"!= {want['status']!r}",
                w_needs or needs,
            )
        if want.get("evidenceTurnRedacted"):
            for fact in (f for f in matching if f.get("status") == want["status"]):
                evidence = str(fact.get("evidence") or "").lower()
                source_turns = [
                    t for t in snap["turns"] if t.get("callId") == fact.get("sourceCallId")
                ]
                leaked = [
                    t
                    for t in source_turns
                    if not t.get("redacted") and evidence and evidence in t.get("text", "").lower()
                ]
                if leaked or not any(t.get("redacted") for t in source_turns):
                    c.fail(f"evidence turn for /{want['text']}/ is not redacted", w_needs or needs)

    for want in expect.get("followups") or []:
        want, needs = _spec(want)
        matching = [f for f in snap["followups"] if _m(want["speakable"], f.get("speakable"))]
        if want.get("askedInThisCall"):
            matching = [f for f in matching if f.get("askedInCallId") == call_id]
        if not matching:
            c.fail(f"no follow-up matches {want}", needs)
        elif "status" in want and not any(f.get("status") == want["status"] for f in matching):
            c.fail(
                f"follow-up /{want['speakable']}/ status "
                f"{[f.get('status') for f in matching]} != {want['status']!r}",
                needs,
            )
    spec, needs = _spec(expect.get("followupsAskedInCall"))
    if spec is not None:
        asked = sum(1 for f in snap["followups"] if f.get("askedInCallId") == call_id)
        if asked != spec:
            c.fail(f"{asked} follow-up(s) asked in this call, expected {spec}", needs)
    for want in expect.get("followupsAdded") or []:
        want, needs = _spec(want)
        new = [
            f
            for f in snap["followups"]
            if f.get("sourceCallId") == call_id and _m(want["speakable"], f.get("speakable"))
        ]
        if not new:
            c.fail(f"no new follow-up matches /{want['speakable']}/", needs)
        elif want.get("notBeforeAfterCall") and not any(
            f.get("notBefore", 0) > (call.get("endedAt") or call.get("startedAt", 0)) for f in new
        ):
            c.fail(f"follow-up /{want['speakable']}/ is not scheduled after this call", needs)

    spec, needs = _spec(expect.get("turns"))
    this_call = [t for t in snap["turns"] if t.get("callId") == call_id]
    if spec:
        if spec.get("anyRedacted") and not any(t.get("redacted") for t in this_call):
            c.fail("no turn of this call is redacted", needs)
        if spec.get("refusedAny") and not any(t.get("refused") for t in this_call):
            c.fail("no turn of this call is marked refused", needs)
        for pattern in spec.get("noneInclude") or []:
            if any(_m(pattern, t.get("text")) for t in this_call if not t.get("redacted")):
                c.fail(f"an unredacted turn matches /{pattern}/", needs)
        if "minTurns" in spec and len(this_call) < spec["minTurns"]:
            c.fail(f"only {len(this_call)} turns logged, expected ≥{spec['minTurns']}", needs)

    spec, needs = _spec(expect.get("latency"))
    if spec:
        for failure in latency_failures(this_call, spec):
            c.fail(failure, needs)
    return c.failures


def check_live(source, call_id: str, expect: dict | None) -> dict:
    """Wait for the memory writer if asked, snapshot, and check. Never raises."""
    expect = expect or {}
    result = {"memoryWrite": None, "failures": []}
    try:
        if expect.get("waitForMemory"):
            result["memoryWrite"] = wait_for_memory(source, call_id)
            if result["memoryWrite"] is None:
                result["failures"].append(
                    f"[needs memory-writer] no memory write within {MEMORY_WAIT_S} s of hang-up"
                )
        result["failures"] += check_state(snapshot(source, call_id), expect)
    except Exception as exc:  # noqa: BLE001 -- report, don't crash the run
        result["failures"].append(f"Convex state check failed: {type(exc).__name__}: {exc}"[:300])
    return result
