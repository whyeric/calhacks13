"""Offline tests for the latency harness: percentile/cost math, script assertions, fake Convex."""

import json

import convex_state
import httpx
import latency_report as lr
import pytest
import pytest_asyncio
import scripted_calls as sc

from convex_api import ConvexAPI

# ---------- math ----------


def test_percentile_linear_interpolation_matches_numpy_default():
    data = [100, 200, 300, 400, 500]
    assert lr.percentile(data, 50) == 300
    assert lr.percentile(data, 95) == pytest.approx(480)
    assert lr.percentile([7], 95) == 7
    assert lr.percentile([], 50) is None
    assert lr.percentile([None, 10, None, 20], 50) == 15
    assert lr.percentile(range(1, 101), 95) == pytest.approx(95.05)


def test_summarize_ignores_missing_values():
    s = lr.summarize([None, 100, 300])
    assert s == {"n": 2, "p50": 200, "p95": pytest.approx(290), "max": 300}
    assert lr.summarize([])["p50"] is None


def test_request_cost_uses_haiku_5_5_prices_and_long_prompt_tier():
    # 1M of each category at the <=100K tier... priced per token, so scale down.
    cost = lr.request_cost(
        input_tokens=1000, output_tokens=200, cache_read=8000, cache_write_5m=500
    )
    expected = (1000 * 0.10 + 200 * 0.50 + 8000 * 0.01 + 500 * 0.125) / 1e6
    assert cost == pytest.approx(expected)
    assert lr.request_cost(cache_write_1h=1_000) == pytest.approx(1000 * 0.20 / 1e6)
    # Prompt over 100K tokens (cache reads count) -> whole request at the higher tier.
    long = lr.request_cost(input_tokens=1000, output_tokens=100, cache_read=100_000)
    assert long == pytest.approx((1000 * 0.50 + 100 * 2.50 + 100_000 * 0.05) / 1e6)
    assert lr.request_cost(input_tokens=100_000) == pytest.approx(100_000 * 0.10 / 1e6)


def test_usage_cost_prices_cache_writes_by_assumed_ttl():
    usage = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 1000}
    assert lr.usage_cost(usage, "5m") == pytest.approx(1000 * 0.125 / 1e6)
    assert lr.usage_cost(usage, "1h") == pytest.approx(1000 * 0.20 / 1e6)


def _turn(idx, speaker, timings=None, usage=None):
    return {
        "idx": idx,
        "speaker": speaker,
        "at": 0,
        "timings": timings or {},
        "usage": usage or {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
    }


def test_analyze_calls_stages_cache_hit_and_cost():
    warm = {"input": 50, "output": 20, "cacheRead": 5000, "cacheWrite": 100}
    cold = {"input": 50, "output": 20, "cacheRead": 0, "cacheWrite": 6000}
    calls = [
        {
            "callId": "a",
            "turns": [
                _turn(0, "assistant"),  # templated greeting: ignored
                _turn(1, "user", {"sttFinalAt": 1000}),
                _turn(
                    2,
                    "assistant",
                    {
                        "speechEndAt": 700,
                        "sttFinalAt": 1000,
                        "llmRequestAt": 1010,
                        "llmFirstTokenAt": 1400,
                        "ttsFirstAudioAt": 1500,
                    },
                    warm,
                ),
            ],
        },
        {
            "callId": "b",
            "turns": [
                _turn(2, "assistant", {"sttFinalAt": 0, "llmFirstTokenAt": 900}, cold),
                _turn(4, "assistant", {"sttFinalAt": 0, "llmFirstTokenAt": 500}, warm),
            ],
        },
    ]
    result = lr.analyze_calls(calls)
    assert result["stages"]["voiceToVoice (speechEnd->ttsFirstAudio)"]["p50"] == 800
    assert result["stages"]["voiceToVoice (speechEnd->ttsFirstAudio)"]["n"] == 1
    assert result["stages"]["sttFinal->llmFirstToken"]["n"] == 3
    assert result["stages"]["llmRequest->llmFirstToken"]["p50"] == 390
    # Call a's first model turn read the cache; call b's first did not.
    assert result["firstTurnCacheHitRate"] == 0.5
    per = {c["callId"]: c for c in result["perCall"]}
    assert per["b"]["costUsd"] == pytest.approx(lr.usage_cost(cold) + lr.usage_cost(warm), abs=1e-6)
    assert result["costPerCall"]["n"] == 2


def test_cut_off_calls_and_hold_offs_are_counted(capsys):
    warm = {"input": 5, "output": 5, "cacheRead": 5000, "cacheWrite": 0}
    reply = _turn(2, "assistant", {"sttFinalAt": 0, "llmFirstTokenAt": 500}, warm)
    calls = [
        {"callId": "a", "turns": [_turn(1, "user", {"cutOff": 1, "holdOffMs": 700}), reply]},
        {"callId": "b", "turns": [_turn(1, "user", {"holdOffMs": 700}), reply]},
        {"callId": "c", "turns": [_turn(1, "user", {"cutOff": 0}), reply]},
    ]
    result = lr.analyze_calls(calls)
    assert result["cutOffCalls"] == 1 and result["cutOffCallRate"] == pytest.approx(1 / 3)
    assert result["holdOffTurns"] == 2
    assert {c["callId"]: c["cutOffs"] for c in result["perCall"]} == {"a": 1, "b": 0, "c": 0}
    lr.print_report(result)
    out = capsys.readouterr().out
    assert "Cut-off calls (§3.3, #35): 1/3 (33%), target < 1 in 10: MISS" in out
    assert "Turns where the hold-off fired: 2." in out


def test_report_reads_exported_json(tmp_path, capsys):
    path = tmp_path / "calls.json"
    turn = _turn(
        1,
        "assistant",
        {"sttFinalAt": 0, "llmRequestAt": 5, "llmFirstTokenAt": 305},
        {"input": 10, "output": 5, "cacheRead": 4000, "cacheWrite": 0},
    )
    path.write_text(json.dumps({"calls": [{"callId": "x", "turns": [turn]}]}))
    result = lr.main(["--from-json", str(path), "--json", str(tmp_path / "out.json")])
    assert result["firstTurnCacheHitRate"] == 1
    assert json.loads((tmp_path / "out.json").read_text())["calls"] == 1
    assert "First-turn cache hit (L2): 100%" in capsys.readouterr().out


# ---------- script assertions ----------


def _record(turns, opening="Hi Margaret, how did Lily's recital go?", **extra):
    return {"opening": opening, "turns": turns, "callEnd": {}, **extra}


def _order_tool(status="paid", total=2145, items=None):
    items = items or [
        {"storeItemId": "demo-paper-towels-6", "qty": 1},
        {"storeItemId": "demo-coffee-big", "qty": 1},
    ]
    return {
        "name": "place_order",
        "input": {"items": items},
        "result": {"status": status, "totalCents": total},
        "ms": 5,
    }


def test_speech_patterns_are_case_insensitive_regex_alternatives():
    assert sc.check_speech("That's $21.45 in total.", ["21\\.45|twenty.one"]) == []
    assert sc.check_speech("Twenty-One dollars", ["21\\.45|twenty.one"]) == []
    assert sc.check_speech("ok", ["decaf"]) != []
    assert sc.check_speech("I placed it", excludes=["placed"]) != []


def test_evaluate_passes_call1_shape_and_checks_confirmation():
    turns = [
        {"idx": 1, "caller": "I need paper towels", "agent": "6-roll for $8.97?", "tools": []},
        {
            "idx": 2,
            "caller": "The small one.",
            "agent": "That's $21.45 in total, arriving tomorrow. Shall I order it?",
            "tools": [],
        },
        {"idx": 3, "caller": "Yes, please.", "agent": "Done.", "tools": [_order_tool()]},
    ]
    expect = {
        "finalOrder": {
            "status": "paid",
            "totalCents": 2145,
            "items": {"demo-paper-towels-6": 1, "demo-coffee-big": 1},
        },
        "placeOrderOnlyAfterYes": True,
        "speechIncludes": ["8\\.97"],
    }
    assert sc.evaluate(_record(turns), expect) == []


def test_evaluate_flags_order_without_read_back_and_wrong_total():
    turns = [
        {
            "idx": 1,
            "caller": "Paper towels and my coffee.",
            "agent": "Done!",
            "tools": [_order_tool(total=2694)],
        }
    ]
    failures = sc.evaluate(
        _record(turns),
        {"finalOrder": {"status": "paid", "totalCents": 2145}, "placeOrderOnlyAfterYes": True},
    )
    assert any("totalCents 2694" in f for f in failures)
    assert any("without a read-back question" in f for f in failures)


def test_evaluate_no_paid_order_followups_tools_and_outcome():
    turns = [
        {
            "idx": 1,
            "caller": "Yes",
            "agent": "That needs Dana's approval.",
            "tools": [_order_tool(status="needs_approval", total=9588)],
            "expect": {"toolsNotCalled": ["search_items"], "toolsCalled": ["place_order"]},
        }
    ]
    record = _record(
        turns,
        opening="Shall I order it?",
        callEnd={"outcome": "awaiting_approval"},
        fake={"orders": [{"status": "needs_approval"}], "followupsAsked": 2},
    )
    expect = {
        "noPaidOrder": True,
        "outcome": "awaiting_approval",
        "followupsAsked": 1,
        "toolsNotCalled": ["connect_family"],
    }
    assert sc.evaluate(record, expect) == ["follow-up marked asked 2x, expected 1"]
    record["fake"]["orders"].append({"status": "paid"})
    assert "the fake order service recorded a paid order" in sc.evaluate(record, expect)
    assert sc.evaluate(record, {"outcome": "ordered"}) == [
        "call-end outcome 'awaiting_approval' != 'ordered'"
    ]


def test_skipped_turns_are_not_evaluated_and_resolve_turn_alternatives():
    turn = {
        "say": "Yes.",
        "alts": [{"ifAgent": "8\\.97", "say": "Yes, and the small towels."}],
        "skipIfAgent": "shall i",
    }
    assert sc.resolve_turn(turn, "Your usual coffee?") == "Yes."
    assert sc.resolve_turn(turn, "6-roll for $8.97 or 12?") == "Yes, and the small towels."
    assert sc.resolve_turn(turn, "$21.45. Shall I order it?") is None
    record = _record(
        [{"idx": 1, "skipped": True, "caller": "x", "expect": {"toolsCalled": ["place_order"]}}]
    )
    assert sc.evaluate(record, {}) == []


def test_bundled_scripts_load_and_l1_has_50_turns():
    names = sorted(p.stem for p in sc.SCRIPTS.glob("*.json"))
    assert {
        "call1",
        "l1_latency",
        "t2_ambiguous_coffee",
        "t3_over_cap",
        "t4_unknown_caller",
    } <= set(names)
    l1 = sc.load_script("l1_latency")
    assert len(l1) == 10 and sum(len(c["turns"]) for c in l1) == 50
    call1 = sc.load_script("call1")[0]
    assert call1["expect"]["finalOrder"]["totalCents"] == 2145


# ---------- fake Convex ----------


@pytest_asyncio.fixture
async def fake_api():
    fake = sc.FakeConvex()
    api = ConvexAPI(sc.FAKE_SITE, sc.FAKE_SECRET, transport=fake.transport)
    yield fake, api
    await api.close()


@pytest.mark.asyncio
async def test_fake_household_known_and_unknown_callers(fake_api):
    _fake, api = fake_api
    known = await api.post("/agent/household", {"callerPhone": sc.FAKE_CALLER_PHONE})
    ctx = known["context"]
    assert ctx["household"]["preferredName"] == "Margaret"
    assert ctx["limits"]["perOrderCapCents"] == 5000
    assert {f["storeItemId"] for f in ctx["favorites"]} == {"demo-coffee-big", "demo-coffee-decaf"}
    assert ctx["followups"][0]["speakable"].startswith("How did Lily")
    assert "phone" not in json.dumps(ctx["household"]["familyContacts"])
    unknown = await api.post("/agent/household", {"callerPhone": sc.UNKNOWN_PHONE})
    assert unknown["context"] is None and unknown["callId"] != known["callId"]


@pytest.mark.asyncio
async def test_fake_order_pays_call1_and_is_idempotent(fake_api):
    fake, api = fake_api
    call_id = (await api.post("/agent/household", {"callerPhone": sc.FAKE_CALLER_PHONE}))["callId"]
    body = {
        "callId": call_id,
        "idempotencyKey": f"{call_id}:toolu_1",
        "store": "Walmart",
        "items": [
            {"name": "6-roll", "storeItemId": "demo-paper-towels-6", "qty": 1, "priceCents": 897},
            {"name": "Coffee", "storeItemId": "demo-coffee-big", "qty": 1, "priceCents": 1248},
        ],
    }
    first = await api.post("/agent/order", body)
    assert first["status"] == "paid" and first["totalCents"] == 2145
    again = await api.post("/agent/order", body)
    assert again == first and len(fake.orders) == 1
    assert fake.month_spent == 2145


@pytest.mark.asyncio
async def test_fake_order_limits_and_validation(fake_api):
    fake, api = fake_api
    call_id = (await api.post("/agent/household", {"callerPhone": sc.FAKE_CALLER_PHONE}))["callId"]

    def order(key, items, store="Walmart"):
        return {"callId": call_id, "idempotencyKey": key, "store": store, "items": items}

    tp = {"name": "TP", "storeItemId": "demo-toilet-paper-24", "qty": 4, "priceCents": 2397}
    over = await api.post("/agent/order", order("k1", [tp]))
    assert over["status"] == "needs_approval" and over["totalCents"] == 9588
    assert "$95.88" in over["reason"] and "$50.00 per-order limit" in over["reason"]
    milk = {"name": "Milk", "storeItemId": "demo-milk-gallon", "qty": 1, "priceCents": 348}
    store = await api.post("/agent/order", order("k2", [milk], store="Target"))
    assert store["status"] == "needs_approval"
    assert fake.month_spent == 0
    import httpx

    # The catalog price wins over whatever price the agent sent.
    cheap = await api.post("/agent/order", order("k3", [{**milk, "priceCents": 1}]))
    assert cheap["status"] == "paid" and cheap["totalCents"] == 348
    with pytest.raises(httpx.HTTPStatusError) as unknown:
        await api.post("/agent/order", order("k5", [{**milk, "storeItemId": "demo-nope"}]))
    assert unknown.value.response.json() == {"error": "Unknown item"}
    with pytest.raises(httpx.HTTPStatusError):
        await api.post("/agent/order", order("k4", [{**milk, "qty": 0}]))


@pytest.mark.asyncio
async def test_fake_monthly_budget_and_unknown_caller_cannot_order():
    fake = sc.FakeConvex({"monthSpentCents": 19_000})
    api = ConvexAPI(sc.FAKE_SITE, sc.FAKE_SECRET, transport=fake.transport)
    call_id = (await api.post("/agent/household", {"callerPhone": sc.FAKE_CALLER_PHONE}))["callId"]
    coffee = {"name": "Coffee", "storeItemId": "demo-coffee-big", "qty": 1, "priceCents": 1248}
    result = await api.post(
        "/agent/order",
        {"callId": call_id, "idempotencyKey": "m1", "store": "Walmart", "items": [coffee]},
    )
    assert result["status"] == "needs_approval" and "monthly budget" in result["reason"]
    stranger = (await api.post("/agent/household", {"callerPhone": sc.UNKNOWN_PHONE}))["callId"]
    import httpx

    with pytest.raises(httpx.HTTPStatusError):
        await api.post(
            "/agent/order",
            {"callId": stranger, "idempotencyKey": "m2", "store": "Walmart", "items": [coffee]},
        )
    await api.close()


@pytest.mark.asyncio
async def test_fake_rejects_bad_secret_and_records_followups_and_call_end():
    fake = sc.FakeConvex()
    bad = ConvexAPI(sc.FAKE_SITE, "wrong-secret".ljust(40, "z"), transport=fake.transport)
    import httpx

    with pytest.raises(httpx.HTTPStatusError):
        await bad.post("/agent/household", {"callerPhone": sc.FAKE_CALLER_PHONE})
    await bad.close()
    api = ConvexAPI(sc.FAKE_SITE, sc.FAKE_SECRET, transport=fake.transport)
    call_id = (await api.post("/agent/household", {"callerPhone": sc.FAKE_CALLER_PHONE}))["callId"]
    api.fire("/agent/followup", {"callId": call_id, "followupId": "fake-followup-recital"})
    api.log_turn({"callId": call_id, "idx": 0, "speaker": "assistant", "text": "Hi"})
    await api.flush()
    await api.post("/agent/call-end", {"callId": call_id, "outcome": "no_order"})
    assert len(fake.followups_asked) == 1 and len(fake.turns) == 1
    assert fake.call_ends == [{"callId": call_id, "outcome": "no_order"}]
    await api.close()


# ---------- runner plumbing with a fake Anthropic client (no network) ----------


@pytest.mark.asyncio
async def test_run_call_end_to_end_with_scripted_model(monkeypatch):
    """Drives the real ErrandAgent + tools + fake Convex with a canned model stream."""
    import asyncio
    from types import SimpleNamespace

    class Final:
        def __init__(self, content, stop, cache_read):
            self.content = [
                SimpleNamespace(model_dump=lambda exclude_none=True, c=c: dict(c)) for c in content
            ]
            self.stop_reason = stop
            self.usage = SimpleNamespace(
                input_tokens=10,
                output_tokens=5,
                cache_read_input_tokens=cache_read,
                cache_creation_input_tokens=0,
                cache_creation=None,
            )

    def text(t):
        return SimpleNamespace(type="text", text=t)

    def tool_start():
        return SimpleNamespace(
            type="content_block_start",
            content_block=SimpleNamespace(type="tool_use", name="place_order"),
        )

    order_use = {
        "type": "tool_use",
        "id": "toolu_x",
        "name": "place_order",
        "input": {"store": "Walmart", "items": [{"storeItemId": "demo-coffee-big", "qty": 1}]},
    }
    script = [
        (
            [text("Your usual coffee is $12.48. Shall I order it?")],
            Final(
                [{"type": "text", "text": "Your usual coffee is $12.48. Shall I order it?"}],
                "end_turn",
                3000,
            ),
        ),
        ([tool_start()], Final([order_use], "tool_use", 3000)),
        # No third request: the paid confirmation is templated from the place_order result.
    ]

    class Stream:
        def __init__(self, events, final):
            self.events, self.final = events, final

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        def __aiter__(self):
            async def gen():
                for e in self.events:
                    await asyncio.sleep(0)
                    yield e

            return gen()

        async def get_final_message(self):
            return self.final

    class FakeAnthropic:
        def __init__(self, **kw):
            self.messages = SimpleNamespace(stream=self._stream, create=self._create)

        def _stream(self, **params):
            return Stream(*script.pop(0))

        async def _create(self, **params):
            return Final([], "max_tokens", 0)

        async def close(self):
            pass

    import anthropic

    monkeypatch.setattr(anthropic, "AsyncAnthropic", FakeAnthropic)
    monkeypatch.setenv("SEARCH_MODE", "fixtures")
    opts = SimpleNamespace(live_convex=False, first_delay=0, reply_delay=0)
    call = {
        "name": "unit",
        "caller": "margaret",
        "household": {"followup": True},
        "turns": [{"say": "My coffee please."}, {"say": "Yes, please."}],
        "expect": {
            "finalOrder": {"status": "paid", "totalCents": 1248},
            "placeOrderOnlyAfterYes": True,
            "followupsAsked": 1,
            "outcome": "ordered",
        },
    }
    record = await sc.run_call(call, opts)
    assert record["error"] is None, record["error"]
    assert record["failures"] == []
    assert record["firstTurnCacheRead"] == 3000
    t2 = record["turns"][1]
    assert t2["rounds"] == 1 and t2["tools"][0]["name"] == "place_order"
    assert t2["agent"].startswith("Placing that now. Done. Your order is placed and paid")
    assert t2["firstChunkMs"] is not None and t2["resultTextMs"] is not None
    assert record["fake"]["orders"][0]["totalCents"] == 1248
    summary = sc.summarize_run([record])
    assert summary["firstTurnCacheHitRate"] == 1
    assert summary["turns"] == 2 and summary["toolTurns"] == 1


def test_read_back_survives_an_error_line_in_between():
    turns = [
        {"idx": 1, "caller": "Black tea.", "agent": "$3.98. Shall I order one box?", "tools": []},
        {
            "idx": 2,
            "caller": "How much is it?",
            "agent": "I'm having trouble answering just now. Please try again in a moment.",
            "tools": [],
        },
        {"idx": 3, "caller": "Yes, please order it.", "agent": "Done.", "tools": [_order_tool()]},
    ]
    failures = sc.evaluate(_record(turns, opening="Hi"), {"placeOrderOnlyAfterYes": True})
    # The error line itself is always reported; the read-back rule still holds.
    assert failures == ["turn 2: agent spoke the error line (exception in agent code)"]


def test_read_back_yes_carries_over_the_scam_guards_gentle_question():
    turns = [
        {"idx": 1, "caller": "Bread.", "agent": "$2.50. Shall I order it?", "tools": []},
        {"idx": 2, "caller": "Yes.", "agent": "Is someone asking you to buy this?", "tools": []},
        {"idx": 3, "caller": "No, I ran out.", "agent": "Done.", "tools": [_order_tool()]},
    ]
    assert sc.evaluate(_record(turns, opening="Hi"), {"placeOrderOnlyAfterYes": True}) == []
    # Without the yes before it, the guard question doesn't count as a read-back.
    turns[1]["caller"] = "Hmm."
    assert sc.evaluate(_record(turns, opening="Hi"), {"placeOrderOnlyAfterYes": True})


@pytest.mark.asyncio
async def test_request_errors_raised_on_stream_open_are_recorded():
    from types import SimpleNamespace

    class Manager:
        async def __aenter__(self):
            exc = RuntimeError("overloaded")
            exc.status_code, exc.body = 529, {"error": {"message": "Overloaded"}}
            raise exc

        async def __aexit__(self, *a):
            raise AssertionError("never entered")

    class Inner:
        messages = SimpleNamespace(stream=lambda **kw: Manager())

    client = sc.InstrumentedClient(Inner())
    client.tag = 1
    with pytest.raises(RuntimeError):
        async with client.messages.stream(model="m"):
            pass
    rec = client.records[0]
    assert rec["error"] == "RuntimeError 529: Overloaded" and rec["endAt"] >= rec["startAt"]
    metrics = sc.turn_metrics(client.records, rec["startAt"], rec["endAt"], rec["endAt"])
    assert metrics["errors"] == ["RuntimeError 529: Overloaded"]
    record = {"turns": [{"idx": 1, "agent": "x", "tools": [], **metrics}], "opening": ""}
    assert "turn 1: model request failed: RuntimeError 529: Overloaded" in sc.evaluate(record, {})


# ---------- #13 scripts: coverage of §16.1 and §16.2 ----------

MATRIX_IDS = (
    [f"T{i}" for i in range(1, 6)]
    + [f"S{i}" for i in range(1, 6)]
    + [f"M{i}" for i in range(1, 8)]
    + [f"C{i}" for i in range(1, 5)]
    + ["W1", "W2", "L1", "L2", "L3", "L4"]
)


def _all_scripts():
    return [c for p in sorted(sc.SCRIPTS.glob("*.json")) for c in sc.load_script(str(p))]


def test_every_matrix_id_has_a_script_or_a_stated_way_to_run_it():
    by_id = {}
    for call in _all_scripts():
        by_id.setdefault(call["id"], []).append(call)
    missing = [i for i in MATRIX_IDS if i not in by_id]
    assert missing == []
    for test_id in MATRIX_IDS:
        for call in by_id[test_id]:
            assert call.get("manual") or call.get("turns"), test_id
            # Every played script states pass conditions in machine-readable form.
            assert call.get("manual") or call.get("expect") or call.get("convex"), test_id
    assert sc.script_for_id("s1").name == "call2.json"
    assert sc.load_script("C1")[0]["name"] == "call3"


def _spec_caller_lines(call_no: int) -> list[str]:
    text = (sc.ROOT / "SPEC.md").read_text()
    start = text.index(f"**Call {call_no}:")
    end = text.index("*Pass when:*", start)
    return [
        line.split("**Margaret:**", 1)[1].strip()
        for line in text[start:end].splitlines()
        if "**Margaret:**" in line
    ]


@pytest.mark.parametrize("call_no,name", [(1, "call1"), (2, "call2"), (3, "call3")])
def test_scripted_calls_match_spec_word_for_word(call_no, name):
    script = sc.load_script(name)[0]
    lines = _spec_caller_lines(call_no)
    assert lines and [t["say"] for t in script["turns"][: len(lines)]] == lines


def test_call_pass_conditions_are_machine_readable():
    call1, call2, call3 = (sc.load_script(n)[0] for n in ("call1", "call2", "call3"))
    assert call1["convex"]["orders"]["last"] == {
        "status": "paid",
        "totalCents": 2145,
        "items": {"demo-paper-towels-6": 1, "demo-coffee-big": 1},
    }
    assert call1["convex"]["followupsAskedInCall"] == 1
    assert call2["convex"]["call"]["outcome"] == "declined_scam"
    assert {"search_items", "place_order"} <= set(call2["expect"]["toolsNotCalled"])
    assert call3["expect"]["toolOnlyAfterYes"] == ["connect_family"]
    assert call3["expect"]["followupsAsked"] == 1


# ---------- #22 Convex state assertions ----------

CALL = "call-1"


def _snap(**overrides):
    snap = {
        "call": {
            "_id": CALL,
            "householdId": "h1",
            "outcome": "ordered",
            "kind": "order",
            "startedAt": 1_000,
            "endedAt": 9_000,
            "summary": "Ordered coffee and towels; recital went well.",
        },
        "orders": [
            {
                "callId": CALL,
                "status": "paid",
                "totalCents": 2145,
                "items": [
                    {"storeItemId": "demo-paper-towels-6", "qty": 1},
                    {"storeItemId": "demo-coffee-big", "qty": 1},
                ],
            }
        ],
        "alerts": [],
        "facts": [
            {
                "text": "Lily's recital went well.",
                "evidence": "she played beautifully",
                "sourceCallId": CALL,
                "status": "active",
            }
        ],
        "followups": [
            {"speakable": "How did Lily's recital go?", "status": "closed", "askedInCallId": CALL}
        ],
        "turns": [
            {"callId": CALL, "idx": i, "speaker": "user", "text": f"line {i}", "redacted": False}
            for i in range(6)
        ],
    }
    snap.update(overrides)
    return snap


def test_call1_state_passes_and_reports_each_miss():
    expect = sc.load_script("call1")[0]["convex"]
    assert convex_state.check_state(_snap(), expect) == []
    snap = _snap(
        orders=[{"callId": CALL, "status": "paid", "totalCents": 2694, "items": []}],
        followups=[{"speakable": "recital", "status": "asked", "askedInCallId": CALL}],
        facts=[],
    )
    failures = convex_state.check_state(snap, expect)
    assert "order totalCents 2694 != 2145" in failures
    # The memory writer (#32) has landed, so these are plain failures, not PENDING.
    assert any(f.startswith("follow-up") for f in failures)
    assert any(f.startswith("no fact") for f in failures)


def test_call2_state_requires_scam_outcome_alert_excerpt_and_no_debt_fact():
    expect = sc.load_script("call2")[0]["convex"]
    good = _snap(
        call={
            "_id": CALL,
            "householdId": "h1",
            "outcome": "declined_scam",
            "scamIncident": "Scam attempt: $400 Apple gift cards for 'Medicare'.",
        },
        orders=[],
        alerts=[
            {"callId": CALL, "type": "scam", "transcriptExcerpt": "I need $400 in Apple gift cards"}
        ],
        facts=[],
    )
    assert convex_state.check_state(good, expect) == []
    bad = {
        **good,
        "call": {**good["call"], "outcome": "no_order"},
        "facts": [{"text": "Margaret owes Medicare a fee", "sourceCallId": CALL}],
        "alerts": [],
    }
    failures = convex_state.check_state(bad, expect)
    assert "calls.outcome 'no_order' != 'declined_scam'" in failures
    assert any("must not exist" in f and "Medicare" in f for f in failures)
    assert any("no scam alert" in f for f in failures)


def test_m3_forgotten_fact_needs_its_evidence_turn_redacted():
    expect = sc.load_script("M3")[0]["convex"]
    fact = {
        "text": "Margaret grows tomatoes.",
        "evidence": "my tomatoes",
        "sourceCallId": CALL,
        "status": "forgotten",
    }
    redacted = {"callId": CALL, "idx": 0, "text": "[forgotten]", "redacted": True}
    assert convex_state.check_state(_snap(facts=[fact], turns=[redacted]), expect) == []
    leaked = {"callId": CALL, "idx": 0, "text": "out with my tomatoes", "redacted": False}
    failures = convex_state.check_state(_snap(facts=[fact], turns=[leaked]), expect)
    assert "evidence turn for /tomato/ is not redacted" in failures
    assert "no turn of this call is redacted" in failures


def test_followup_rescheduled_and_latency_thresholds():
    snap = _snap(
        followups=[{"speakable": "recital next week", "sourceCallId": CALL, "notBefore": 99_000}],
        turns=[
            {
                "callId": CALL,
                "speaker": "assistant",
                "timings": {"sttFinalAt": 0, "llmFirstTokenAt": ms},
            }
            for ms in (200, 250, 300, 900)
        ],
    )
    expect = {
        "followupsAdded": [{"speakable": "recital", "notBeforeAfterCall": True}],
        "latency": {"metric": "llm", "p50Ms": 300, "p95Ms": 800},
    }
    assert convex_state.check_state(snap, expect) == ["latency: llm p95 810 ms > 800 ms"]
    assert convex_state.latency_failures([], {"p50Ms": 1}) == [
        "latency: only 0 turn(s) carry llm timings"
    ]
    # §12.1 voice-to-voice uses the voice-layer marks when present.
    voice = [{"speaker": "assistant", "timings": {"speechEndAt": 0, "ttsFirstAudioAt": 700}}]
    assert convex_state.latency_failures(voice, {"metric": "voice", "p50Ms": 800}) == []


class _Source:
    def __init__(self, snap, memory=True):
        call = {**snap["call"], **({"memoryWrite": {"status": "written"}} if memory else {})}
        self.tables = {
            "calls": [call],
            "orders": snap["orders"],
            "alerts": snap["alerts"],
            "memory_facts": [{**f, "householdId": "h1"} for f in snap["facts"]],
            "followups": [{**f, "householdId": "h1"} for f in snap["followups"]],
            "turns": snap["turns"],
        }

    def table(self, name, limit=500):
        return self.tables[name]


def test_check_live_waits_for_memory_and_snapshots(monkeypatch):
    expect = sc.load_script("call1")[0]["convex"]
    assert convex_state.check_live(_Source(_snap()), CALL, expect)["failures"] == []
    monkeypatch.setattr(convex_state, "MEMORY_WAIT_S", 0)
    no_writer = convex_state.check_live(_Source(_snap(), memory=False), CALL, expect)
    assert no_writer["failures"][0].startswith("[needs memory-writer] no memory write")
    missing = convex_state.check_live(_Source(_snap()), "other-call", {})
    assert "not found" in missing["failures"][0]


# ---------- #22 statuses and the per-ID report ----------


def _rec(test_id, status, **extra):
    return {"id": test_id, "name": test_id, "status": status, "failures": [], **extra}


def test_status_pending_only_for_unlanded_features():
    assert sc.status_of({"failures": []}) == "PASS"
    assert sc.status_of({"failures": ["[needs scam] no scam alert"]}) == "PENDING"
    assert sc.status_of({"failures": ["[needs scam] x", "order totalCents 1 != 2"]}) == "FAIL"
    assert sc.status_of({"failures": ["anything"], "pendingOn": ["wellbeing"]}) == "PENDING"
    assert sc.status_of({"manual": "phone", "failures": []}) == "MANUAL"


def test_report_rows_pass_rates_and_aggregate_bars():
    records = (
        [_rec("M1", "PASS", passRate=0.9, firstTurnCacheRead=100) for _ in range(9)]
        + [_rec("M1", "FAIL", passRate=0.9, failures=["no recital"], firstTurnCacheRead=0)]
        + [
            _rec("T3", "PASS", firstTurnCacheRead=1),
            _rec(
                "T3", "PENDING", pendingOn=["approval-wait"], failures=["x"], firstTurnCacheRead=1
            ),
        ]
        + [_rec(f"B{i}", "PASS", firstTurnCacheRead=1) for i in range(1, 19)]
        + [_rec("B19", "FAIL", firstTurnCacheRead=1), _rec("B20", "FAIL", firstTurnCacheRead=1)]
        + [{**_rec("L3", "MANUAL"), "manual": "Needs a phone."}]
    )
    rows = {r["id"]: r for r in sc.build_report(records)}
    assert rows["M1"]["status"] == "PASS" and rows["M1"]["detail"].startswith("9/10")
    assert rows["T3"]["status"] == "PENDING" and "needs approval-wait" in rows["T3"]["detail"]
    assert rows["B1-B20"]["status"] == "FAIL" and "2 false decline" in rows["B1-B20"]["detail"]
    assert rows["L3"]["status"] == "MANUAL"
    # L2 judges every played call: 31 of 32 hit the cache.
    assert rows["L2"]["status"] == "PASS" and "31/32" in rows["L2"]["detail"]
    few = sc.build_report([_rec("C2", "PASS", firstTurnCacheRead=5)])
    assert {r["id"]: r["status"] for r in few}["L2"] == "INSUFFICIENT"


def test_l1_row_needs_50_turns_and_the_voice_to_voice_bar():
    def call(ms_list):
        turns = [
            {"idx": i, "caller": "hi", "agent": "hello", "tools": [], "firstChunkMs": ms}
            for i, ms in enumerate(ms_list)
        ]
        return {"id": "L1", "name": "l1", "turns": turns, "passed": True, "costUsd": 0.0}

    assert sc._l1_row([call([200] * 10)])["status"] == "INSUFFICIENT"
    assert sc._l1_row([call([200] * 50)])["status"] == "PASS"
    assert sc._l1_row([call([200] * 40 + [1500] * 10)])["status"] == "FAIL"


def test_routes_tool_gate_and_latency_growth_checks():
    routes = {"/agent/alert": [{"type": "scam", "message": "gift cards"}]}
    assert sc.check_routes(routes, {"/agent/alert": {"min": 1, "max": 1, "includes": "scam"}}) == []
    assert sc.check_routes(routes, {"/agent/alert": {"max": 0, "includes": "scam"}}) != []
    assert sc.check_routes({}, {"/agent/alert": {"min": 1, "needs": "scam"}})[0].startswith(
        "[needs scam]"
    )
    nudge = {"name": "connect_family", "input": {}, "result": {}, "ms": 1}
    turns = [
        {"idx": 1, "caller": "Dana's been busy.", "agent": "Shall I let Dana know?", "tools": []},
        {"idx": 2, "caller": "That would be nice.", "agent": "I'll call her.", "tools": [nudge]},
    ]
    gate = {"toolOnlyAfterYes": ["connect_family"]}
    # "Maybe later" is not a yes; the gate flags it. Call 3's verbatim "That would be nice."
    # (§16.1) counts as a yes, as it does for Convex's consent check (#63).
    turns[1]["caller"] = "Maybe later."
    assert sc.evaluate(_record(turns), gate)
    turns[1]["caller"] = "That would be nice."
    assert sc.evaluate(_record(turns), gate) == []
    slow = [
        {"idx": i, "caller": "hi", "agent": "hello", "tools": [], "firstChunkMs": ms}
        for i, ms in enumerate([100] * 10 + [900] * 10)
    ]
    failures = sc.evaluate(_record(slow), {"latencyLastTurns": {"turns": 10}})
    assert any("p50" in f for f in failures)


@pytest.mark.asyncio
async def test_fake_records_other_routes_and_runs_family_approval():
    fake = sc.FakeConvex({"followup": "How are your tomatoes doing?"})
    assert fake.context["followups"][0]["speakable"] == "How are your tomatoes doing?"
    api = ConvexAPI(sc.FAKE_SITE, sc.FAKE_SECRET, transport=fake.transport)
    call = await api.post("/agent/household", {"callerPhone": sc.FAKE_CALLER_PHONE})
    alert = await api.post("/agent/alert", {"callId": call["callId"], "type": "scam"})
    assert alert["delivery"] == "queued"
    assert fake.extra["/agent/alert"] == [{"callId": call["callId"], "type": "scam"}]
    order = await api.post(
        "/agent/order",
        {
            "callId": call["callId"],
            "idempotencyKey": "k1",
            "store": "Walmart",
            "items": [{"storeItemId": "demo-toilet-paper-24", "qty": 4}],
        },
    )
    assert order["status"] == "needs_approval"
    ids = {"callId": call["callId"], "orderId": order["orderId"]}
    # Like Convex: the database calls it awaiting_approval, and only this call's order is seen.
    waiting = await api.post("/agent/order-status", ids)
    assert waiting["status"] == "awaiting_approval" and waiting["decidedBy"] is None
    with pytest.raises(httpx.HTTPStatusError):
        await api.post("/agent/order-status", {**ids, "callId": "another-call"})
    recent = (await api.post("/agent/recent-orders", {"callId": call["callId"]}))["orders"]
    assert [(o["status"], o["totalCents"], o["thisCall"]) for o in recent] == [
        ("awaiting_approval", 9588, True)
    ]
    done = await sc.run_action("approve_last_order", call["callId"], fake, None)
    assert done["orderId"] == order["orderId"]
    status = await api.post("/agent/order-status", ids)
    assert status["status"] == "paid" and status["decidedBy"] == "Dana"
    recent = (await api.post("/agent/recent-orders", {"callId": call["callId"]}))["orders"]
    assert recent[0]["status"] == "paid" and recent[0]["decidedBy"] == "Dana"
    assert (await sc.run_action("decline_last_order", call["callId"], fake, None))["error"]
    await api.close()


def test_manual_rows_are_reported_without_a_call():
    record = sc.manual_record(sc.load_script("L3")[0])
    assert record["status"] == "MANUAL" and "300 ms" in record["manual"]
