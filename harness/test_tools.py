import asyncio
import importlib
import json
import uuid

import httpx
import pytest

import tools
from convex_api import ConvexAPI
from tools import TOOLS, ToolContext, dispatch
from tools import search as search_mod
from tools.catalog import catalog_item, search_fixtures
from tools.favorites import match_favorite

FAVORITES = [
    {
        "_id": "fav1",
        "name": "Medium-roast coffee, big can",
        "aliases": ["my usual", "my coffee", "usual coffee"],
        "store": "Walmart",
        "storeItemId": "demo-coffee-big",
        "usualQty": 1,
    },
    {
        "_id": "fav2",
        "name": "Decaf medium-roast coffee",
        "aliases": ["coffee", "medium roast"],
        "store": "Walmart",
        "storeItemId": "demo-coffee-decaf",
        "usualQty": 1,
    },
]
CONTEXT = {"household": {"preferredName": "Margaret"}, "favorites": FAVORITES}


@pytest.fixture(autouse=True)
def fixture_mode(monkeypatch):
    monkeypatch.delenv("APIFY_TOKEN", raising=False)
    monkeypatch.delenv("APIFY_WALMART_ACTOR", raising=False)
    monkeypatch.setenv("SEARCH_MODE", "auto")


def make_ctx(api=None, *, context=CONTEXT, tool_use_id="toolu_1"):
    return ToolContext(
        api=api, call_id=f"call-{uuid.uuid4().hex[:8]}", context=context, tool_use_id=tool_use_id
    )


def order_api(handler):
    return ConvexAPI(
        "https://example.convex.site",
        "test-agent-".ljust(40, "a"),
        transport=httpx.MockTransport(handler),
    )


# ---- tool list -------------------------------------------------------------------------------


def test_tool_list_is_fixed_ordered_and_byte_identical_across_imports():
    names = [t["name"] for t in TOOLS]
    assert names == [
        "match_favorite",
        "search_items",
        "place_order",
        "forget_fact",
        "connect_family",
        "raise_wellbeing_alert",
        # Milestone 7 stretch tools, appended (#55 #66 #60).
        "order_status",
        "compare_prices",
        "stop_checkins",
    ]
    before = json.dumps(TOOLS)
    import tools.definitions as defs

    importlib.reload(defs)
    assert json.dumps(defs.TOOLS) == before
    for tool in TOOLS:
        assert set(tool) == {"name", "description", "input_schema"}
    place = next(t for t in TOOLS if t["name"] == "place_order")
    assert "explicitly said yes" in place["description"]
    assert "priceCents" not in json.dumps(place["input_schema"])


# ---- fixtures / search -----------------------------------------------------------------------


def test_fixture_search_returns_demo_paper_towels_in_order():
    for query in ["paper towels", "Paper towel", "some paper towels please", "PAPER-TOWELS"]:
        options = search_fixtures(query)
        assert [(o["size"], o["priceCents"]) for o in options] == [
            ("6 rolls", 897),
            ("12 rolls", 1548),
        ], query
        assert all(set(o) == {"name", "size", "priceCents", "storeItemId"} for o in options)


def test_fixture_catalog_supports_call_one_total():
    towels = search_fixtures("paper towels")[0]
    coffee = catalog_item("demo-coffee-big")
    assert coffee["name"] == "Medium-roast coffee, big can"
    assert towels["priceCents"] + coffee["priceCents"] == 2145
    assert catalog_item("demo-coffee-decaf")["priceCents"] > 0
    for query in [
        "milk",
        "a loaf of bread",
        "bananas",
        "a dozen eggs",
        "dish soap",
        "toilet paper",
    ]:
        assert len(search_fixtures(query)) == 2, query
    assert search_fixtures("snowmobile") == []


@pytest.mark.asyncio
async def test_search_items_uses_cache_without_token():
    result = await dispatch("search_items", {"query": "paper towels"}, make_ctx())
    assert result["status"] == "ok" and result["source"] == "cache"
    assert [o["priceCents"] for o in result["options"]] == [897, 1548]
    empty = await dispatch("search_items", {"query": "snowmobile"}, make_ctx())
    assert empty["status"] == "no_results" and empty["options"] == []


def use_live(monkeypatch, handler):
    monkeypatch.setenv("APIFY_TOKEN", "apify-test-token")
    monkeypatch.setenv("APIFY_WALMART_ACTOR", "someone/walmart-search")
    client = httpx.AsyncClient(
        base_url=search_mod.APIFY_BASE, transport=httpx.MockTransport(handler)
    )
    monkeypatch.setattr(search_mod, "_client", client)


@pytest.mark.asyncio
async def test_live_search_maps_results_to_two_options(monkeypatch):
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(
            200,
            json=[
                {"name": "Brand Paper Towels, 8 Rolls", "usItemId": "111", "price": 12.5},
                {
                    "title": "Value towels",
                    "itemId": 222,
                    "priceInfo": {"currentPrice": {"price": "$5.97"}},
                    "size": "6 ct",
                },
                {"name": "Missing price", "usItemId": "333"},
                {"name": "Third", "usItemId": "444", "price": 1},
            ],
        )

    use_live(monkeypatch, handler)
    result = await search_mod.search_items("paper towels")
    assert result["source"] == "live"
    assert result["options"] == [
        {
            "name": "Brand Paper Towels, 8 Rolls",
            "size": "8 Rolls",
            "priceCents": 1250,
            "storeItemId": "walmart-111",
        },
        {"name": "Value towels", "size": "6 ct", "priceCents": 597, "storeItemId": "walmart-222"},
    ]
    request = seen[0]
    assert request.url.path == "/v2/acts/someone~walmart-search/run-sync-get-dataset-items"
    assert request.headers["Authorization"] == "Bearer apify-test-token"
    assert "apify-test-token" not in str(request.url)


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["timeout", "http", "garbage", "empty"])
async def test_live_search_failure_falls_back_to_cache(monkeypatch, failure):
    def handler(request):
        if failure == "timeout":
            raise httpx.ReadTimeout("slow", request=request)
        if failure == "http":
            return httpx.Response(403, text="blocked")
        if failure == "garbage":
            return httpx.Response(200, text="<html>captcha</html>")
        return httpx.Response(200, json=[])

    use_live(monkeypatch, handler)
    result = await dispatch("search_items", {"query": "paper towels"}, make_ctx())
    assert result["source"] == "cache"
    assert [o["priceCents"] for o in result["options"]] == [897, 1548]


@pytest.mark.asyncio
async def test_search_mode_fixtures_never_calls_network(monkeypatch):
    def handler(request):
        raise AssertionError("network used")

    use_live(monkeypatch, handler)
    monkeypatch.setenv("SEARCH_MODE", "fixtures")
    result = await search_mod.search_items("paper towels")
    assert result["source"] == "cache"


def test_price_parsing_to_integer_cents():
    assert search_mod.to_cents(8.97) == 897
    assert search_mod.to_cents("$1,299.99") == 129999
    assert search_mod.to_cents({"price": {"priceString": "$15.48"}}) == 1548
    assert search_mod.to_cents(None) is None
    assert search_mod.to_cents("free") is None


# ---- match_favorite --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "utterance",
    [
        "my coffee",
        "My usual",
        "the usual",
        "my usual coffee",
        "can I get my coffee and some paper towels",
    ],
)
def test_personal_alias_matches_the_big_can(utterance):
    result = match_favorite(utterance, FAVORITES)
    assert result["status"] == "match", utterance
    fav = result["favorite"]
    assert fav["storeItemId"] == "demo-coffee-big"
    assert fav["qty"] == 1 and fav["priceCents"] == 1248 and fav["store"] == "Walmart"
    assert fav["name"] == "Medium-roast coffee, big can"


@pytest.mark.parametrize(
    "utterance", ["coffee", "some coffee", "medium roast", "medium-roast coffee"]
)
def test_similar_favorites_are_ambiguous_never_guessed(utterance):
    result = match_favorite(utterance, FAVORITES)
    assert result["status"] == "ambiguous", utterance
    assert {c["storeItemId"] for c in result["candidates"]} == {
        "demo-coffee-big",
        "demo-coffee-decaf",
    }


@pytest.mark.parametrize(
    "utterance,item",
    [
        ("decaf", "demo-coffee-decaf"),
        ("decaf coffee", "demo-coffee-decaf"),
        ("the big can of coffee", "demo-coffee-big"),
    ],
)
def test_distinguishing_words_pick_one_favorite(utterance, item):
    result = match_favorite(utterance, FAVORITES)
    assert result["status"] == "match" and result["favorite"]["storeItemId"] == item


def test_no_favorite_match():
    assert match_favorite("paper towels", FAVORITES) == {"status": "none"}
    assert match_favorite("my coffee", []) == {"status": "none"}


@pytest.mark.asyncio
async def test_match_favorite_requires_household():
    result = await dispatch("match_favorite", {"utterance": "my coffee"}, make_ctx(context=None))
    assert "registered" in result["error"]


# ---- place_order -----------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_call_one_order_posts_server_side_prices_and_idempotency_key():
    received = []

    def handler(request):
        received.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={"status": "paid", "orderId": "o1", "totalCents": 2145, "paymentRef": "tok_demo"},
        )

    api = order_api(handler)
    ctx = make_ctx(api)
    await dispatch("match_favorite", {"utterance": "my coffee"}, ctx)
    await dispatch("search_items", {"query": "paper towels"}, ctx)
    ctx.tool_use_id = "toolu_order"
    result = await dispatch(
        "place_order",
        {
            "items": [
                {"storeItemId": "demo-paper-towels-6", "qty": 1, "priceCents": 1},
                {"storeItemId": "demo-coffee-big", "qty": 1},
            ]
        },
        ctx,
    )
    assert result.pop("say") == (
        "Done. Your order is placed and paid, twenty-one dollars and forty-five cents in all, "
        "and your family can see it too. Anything else?"
    )
    assert result == {
        "status": "paid",
        "orderId": "o1",
        "totalCents": 2145,
        "paymentRef": "tok_demo",
    }
    body = received[0]
    assert body["callId"] == ctx.call_id
    assert body["idempotencyKey"] == f"{ctx.call_id}:toolu_order"
    assert body["store"] == "Walmart"
    assert body["items"] == [
        {
            "name": "Paper towels, 6-roll pack",
            "storeItemId": "demo-paper-towels-6",
            "qty": 1,
            "priceCents": 897,
        },
        {
            "name": "Medium-roast coffee, big can",
            "storeItemId": "demo-coffee-big",
            "qty": 1,
            "priceCents": 1248,
        },
    ]
    assert sum(i["priceCents"] * i["qty"] for i in body["items"]) == 2145

    # The model re-sending the same order never pays twice.
    ctx.tool_use_id = "toolu_again"
    again = await dispatch(
        "place_order",
        {
            "items": [
                {"storeItemId": "demo-coffee-big", "qty": 1},
                {"storeItemId": "demo-paper-towels-6", "qty": 1},
            ]
        },
        ctx,
    )
    assert again["status"] == "paid" and "already placed" in again["note"]
    assert len(received) == 1
    await api.close()


@pytest.mark.asyncio
async def test_live_item_ids_resolve_from_this_calls_search(monkeypatch):
    def apify(request):
        return httpx.Response(
            200,
            json=[
                {"name": "Towels", "usItemId": "9", "price": 3.5},
                {"name": "More towels", "usItemId": "10", "price": 6},
            ],
        )

    use_live(monkeypatch, apify)
    received = []

    def handler(request):
        received.append(json.loads(request.content))
        return httpx.Response(
            200, json={"status": "paid", "orderId": "o", "totalCents": 700, "paymentRef": "r"}
        )

    api = order_api(handler)
    ctx = make_ctx(api)
    await dispatch("search_items", {"query": "paper towels"}, ctx)
    result = await dispatch("place_order", {"items": [{"storeItemId": "walmart-9", "qty": 2}]}, ctx)
    assert result["status"] == "paid"
    assert received[0]["items"] == [
        {"name": "Towels", "storeItemId": "walmart-9", "qty": 2, "priceCents": 350}
    ]
    other_call = make_ctx(api)
    rejected = await dispatch(
        "place_order", {"items": [{"storeItemId": "walmart-9", "qty": 1}]}, other_call
    )
    assert "Unknown item" in rejected["error"]
    await api.close()


@pytest.mark.parametrize(
    "status_body",
    [
        {
            "status": "needs_approval",
            "orderId": "o2",
            "totalCents": 6210,
            "reason": "This order is $62.10, which is over your $50.00 per-order limit.",
        },
        {"status": "blocked", "reason": "Gift cards can't be bought through Errand Line."},
        {"status": "failed", "orderId": "o3", "reason": "The payment didn't go through."},
    ],
)
@pytest.mark.asyncio
async def test_place_order_passes_statuses_through(status_body):
    api = order_api(lambda request: httpx.Response(200, json=status_body))
    result = await dispatch(
        "place_order", {"items": [{"storeItemId": "demo-milk-gallon", "qty": 1}]}, make_ctx(api)
    )
    say = result.pop("say", None)
    hold = result.pop("_hold", None)
    assert result == status_body
    # paid / needs_approval / blocked carry the templated line spoken at once; failed does not.
    if status_body["status"] == "needs_approval":
        # The caller is held on the line for the family's decision (#92): no question yet.
        assert say.startswith("This order is sixty-two dollars and ten cents, which is over")
        assert "nothing has been charged" in say and "stay on the line" in say
        assert "?" not in say
        assert hold.order_id == "o2" and hold.window_s == 90
    elif status_body["status"] == "blocked":
        assert say == "I couldn't place that order. Gift cards can't be bought through Errand Line."
    else:
        assert say is None
    await api.close()


@pytest.mark.asyncio
async def test_place_order_rejects_unknown_items_bad_qty_and_unknown_callers():
    def handler(request):
        raise AssertionError("must not reach Convex")

    api = order_api(handler)
    unknown = await dispatch(
        "place_order", {"items": [{"storeItemId": "gift-card-500", "qty": 1}]}, make_ctx(api)
    )
    assert "Unknown item" in unknown["error"]
    bad_qty = await dispatch(
        "place_order", {"items": [{"storeItemId": "demo-eggs-12", "qty": 0}]}, make_ctx(api)
    )
    assert "Quantity" in bad_qty["error"]
    empty = await dispatch("place_order", {"items": []}, make_ctx(api))
    assert "error" in empty
    stranger = await dispatch(
        "place_order",
        {"items": [{"storeItemId": "demo-eggs-12", "qty": 1}]},
        make_ctx(api, context=None),
    )
    assert "registered" in stranger["error"]
    await api.close()


@pytest.mark.asyncio
async def test_unconfirmed_order_reuses_idempotency_key_on_retry():
    keys = []
    fail = {"on": True}

    def handler(request):
        keys.append(json.loads(request.content)["idempotencyKey"])
        if fail["on"]:
            raise httpx.ConnectTimeout("down", request=request)
        return httpx.Response(
            200, json={"status": "paid", "orderId": "o", "totalCents": 348, "paymentRef": "r"}
        )

    api = order_api(handler)
    ctx = make_ctx(api, tool_use_id="toolu_a")
    first = await dispatch(
        "place_order", {"items": [{"storeItemId": "demo-milk-gallon", "qty": 1}]}, ctx
    )
    assert first["status"] == "unconfirmed" and "error" not in first
    assert "nothing was charged" in first["message"] and "Don't say" in first["message"]
    fail["on"] = False
    ctx.tool_use_id = "toolu_b"
    second = await dispatch(
        "place_order", {"items": [{"storeItemId": "demo-milk-gallon", "qty": 1}]}, ctx
    )
    assert second["status"] == "paid"
    assert set(keys) == {f"{ctx.call_id}:toolu_a"}
    await api.close()


# ---- stubs and dispatch ----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_phase_two_tools_need_a_household_and_never_claim_success():
    # Implemented in tools/memory_tools.py (#47 #63 #73); see test_companion.py.
    for name, tool_input in [
        ("forget_fact", {"description": "my neighbor"}),
        ("connect_family", {"contact": "Dana", "message": "Call me"}),
        ("raise_wellbeing_alert", {"level": "concern", "summary": "Feeling low."}),
    ]:
        result = await dispatch(name, tool_input, make_ctx(context=None))
        assert "error" in result and "status" not in result
        json.dumps(result)


@pytest.mark.asyncio
async def test_dispatch_never_raises(monkeypatch):
    ctx = make_ctx()
    assert "error" in await dispatch("no_such_tool", {}, ctx)
    assert "error" in await dispatch("search_items", "paper towels", ctx)  # type: ignore[arg-type]

    def boom(*args, **kwargs):
        raise RuntimeError("secret detail")

    monkeypatch.setattr(tools, "match_favorite", boom)
    result = await dispatch("match_favorite", {"utterance": "coffee"}, ctx)
    assert "error" in result and "secret" not in result["error"]

    class BrokenAPI:
        async def post(self, route, payload):
            raise ValueError("nope")

    broken = await dispatch(
        "place_order", {"items": [{"storeItemId": "demo-eggs-12", "qty": 1}]}, make_ctx(BrokenAPI())
    )
    assert broken["status"] == "unconfirmed"


# ---- slow payments ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_order_request_gets_a_longer_timeout_than_other_routes():
    timeouts = {}

    def handler(request):
        timeouts[request.url.path] = request.extensions["timeout"]["read"]
        return httpx.Response(200, json={"status": "paid", "orderId": "o", "totalCents": 348})

    api = order_api(handler)
    await api.post("/agent/order", {})
    await api.post("/agent/turn", {})
    assert timeouts["/agent/order"] >= 12  # the Visa rail alone can take ~8s
    assert timeouts["/agent/turn"] == 5
    await api.close()


@pytest.fixture
def fast_polls(monkeypatch):
    from tools import order

    monkeypatch.setattr(order, "POLL_DELAYS_S", (0, 0, 0))


@pytest.mark.asyncio
async def test_processing_order_is_polled_with_the_same_key_until_terminal(fast_polls):
    keys = []
    replies = [
        {"status": "processing", "orderId": "o", "totalCents": 348},
        {"status": "processing", "orderId": "o", "totalCents": 348},
        {"status": "paid", "orderId": "o", "totalCents": 348, "paymentRef": "r"},
    ]

    def handler(request):
        keys.append(json.loads(request.content)["idempotencyKey"])
        return httpx.Response(200, json=replies.pop(0))

    api = order_api(handler)
    ctx = make_ctx(api, tool_use_id="toolu_p")
    result = await dispatch(
        "place_order", {"items": [{"storeItemId": "demo-milk-gallon", "qty": 1}]}, ctx
    )
    assert result["status"] == "paid"
    assert keys == [f"{ctx.call_id}:toolu_p"] * 3
    await api.close()


@pytest.mark.asyncio
async def test_still_processing_order_is_reported_as_processing_and_keeps_its_key(fast_polls):
    keys = []
    state = {"paid": False}

    def handler(request):
        keys.append(json.loads(request.content)["idempotencyKey"])
        if state["paid"]:
            return httpx.Response(200, json={"status": "paid", "orderId": "o", "totalCents": 348})
        return httpx.Response(200, json={"status": "processing", "orderId": "o", "totalCents": 348})

    api = order_api(handler)
    ctx = make_ctx(api, tool_use_id="toolu_a")
    order = {"items": [{"storeItemId": "demo-milk-gallon", "qty": 1}]}
    first = await dispatch("place_order", order, ctx)
    assert first["status"] == "processing" and "error" not in first
    assert first["message"] == (
        "The payment is still going through; don't say it failed or that nothing was charged."
    )
    assert len(keys) == 4  # first request plus three polls
    state["paid"] = True
    ctx.tool_use_id = "toolu_b"
    second = await dispatch("place_order", order, ctx)
    assert second["status"] == "paid"
    assert set(keys) == {f"{ctx.call_id}:toolu_a"}
    await api.close()


@pytest.mark.parametrize("failure", ["read_timeout", "server_error", "garbage"])
@pytest.mark.asyncio
async def test_unknown_order_outcomes_are_unconfirmed_never_failed(failure):
    def handler(request):
        if failure == "read_timeout":
            raise httpx.ReadTimeout("slow", request=request)
        if failure == "server_error":
            return httpx.Response(503, json={"error": "busy"})
        return httpx.Response(200, json={"surprise": True})

    api = order_api(handler)
    result = await dispatch(
        "place_order", {"items": [{"storeItemId": "demo-milk-gallon", "qty": 1}]}, make_ctx(api)
    )
    assert result["status"] == "unconfirmed" and "error" not in result
    await api.close()


@pytest.mark.asyncio
async def test_order_refusals_are_errors_and_get_a_fresh_key_next_time():
    keys = []

    def handler(request):
        keys.append(json.loads(request.content)["idempotencyKey"])
        return httpx.Response(400, json={"error": "Call has ended"})

    api = order_api(handler)
    ctx = make_ctx(api, tool_use_id="toolu_a")
    order = {"items": [{"storeItemId": "demo-milk-gallon", "qty": 1}]}
    assert "error" in await dispatch("place_order", order, ctx)
    ctx.tool_use_id = "toolu_b"
    await dispatch("place_order", order, ctx)
    assert keys == [f"{ctx.call_id}:toolu_a", f"{ctx.call_id}:toolu_b"]
    await api.close()


@pytest.mark.asyncio
async def test_order_deadline_bounds_a_hanging_request(monkeypatch):
    from tools import order

    monkeypatch.setattr(order, "ORDER_DEADLINE_S", 0.05)

    class HangingAPI:
        async def post(self, route, payload):
            await asyncio.Event().wait()

    result = await dispatch(
        "place_order",
        {"items": [{"storeItemId": "demo-eggs-12", "qty": 1}]},
        make_ctx(HangingAPI()),
    )
    assert result["status"] == "unconfirmed"


def test_place_order_description_separates_unknown_outcomes_from_failures():
    place = next(t for t in TOOLS if t["name"] == "place_order")["description"]
    for status in ["paid", "needs_approval", "blocked", "failed", "processing", "unconfirmed"]:
        assert f'"{status}"' in place
    assert "never say it failed or that nothing was charged" in place


def test_spoken_dollars_and_confirmation_lines():
    from tools.order import confirmation_line, family_name, spoken_dollars

    assert spoken_dollars(2145) == "twenty-one dollars and forty-five cents"
    assert spoken_dollars(100) == "one dollar"
    assert spoken_dollars(5) == "five cents"
    assert spoken_dollars(0) == "zero cents"
    assert spoken_dollars(123456) == (
        "one thousand two hundred thirty-four dollars and fifty-six cents"
    )
    ctx = {"household": {"familyContacts": [{"name": "Dana Reyes", "relation": "daughter"}]}}
    assert family_name(ctx) == "Dana"
    assert family_name(None) == "your family"
    assert confirmation_line({"status": "paid", "totalCents": 2145}, ctx) == (
        "Done. Your order is placed and paid, twenty-one dollars and forty-five cents in all, "
        "and Dana can see it too. Anything else?"
    )
    approval = confirmation_line(
        {"status": "needs_approval", "totalCents": 9588, "reason": "Over the $50.00 cap"}, ctx
    )
    assert approval == (
        "Over the fifty dollars cap. So I've asked Dana to okay it first, and nothing has been "
        "charged. Once Dana says yes, it will go through. Is there anything else I can help with?"
    )
    # Outcomes the result doesn't fully determine are left to the model.
    for result in [
        {"status": "failed", "reason": "x"},
        {"status": "processing", "totalCents": 5},
        {"status": "unconfirmed", "message": "x"},
        {"error": "Unknown item"},
        {"status": "paid", "totalCents": 5, "note": "This exact order was already placed."},
    ]:
        assert confirmation_line(result, ctx) is None


# ---- unknown caller, top-up, order history (#51 #8 M2) ------------------------------------------


@pytest.mark.asyncio
async def test_unknown_caller_cannot_search_or_order_and_nothing_is_requested(monkeypatch):
    def handler(request):
        raise AssertionError("network used for an unknown caller")

    use_live(monkeypatch, handler)
    api = order_api(handler)
    stranger = make_ctx(api, context=None)
    for name, tool_input in [
        ("search_items", {"query": "paper towels"}),
        ("match_favorite", {"utterance": "my coffee"}),
        ("place_order", {"items": [{"storeItemId": "demo-eggs-12", "qty": 1}]}),
    ]:
        result = await dispatch(name, tool_input, stranger)
        assert "registered" in result["error"] and "family member" in result["error"]
        assert "options" not in result
    await api.close()


@pytest.mark.asyncio
async def test_one_item_live_result_is_topped_up_to_two_from_the_cache(monkeypatch):
    def handler(request):
        return httpx.Response(
            200, json=[{"name": "Brand Paper Towels, 8 Rolls", "usItemId": "111", "price": 12.5}]
        )

    use_live(monkeypatch, handler)
    result = await search_mod.search_items("paper towels")
    assert result["source"] == "live"
    assert len(result["options"]) == 2
    assert result["options"][0]["storeItemId"] == "walmart-111"
    assert result["options"][1] == search_fixtures("paper towels")[0]


@pytest.mark.asyncio
async def test_m2_same_item_as_last_time_is_orderable_from_order_history():
    received = []

    def handler(request):
        received.append(json.loads(request.content))
        return httpx.Response(
            200, json={"status": "paid", "orderId": "o", "totalCents": 1099, "paymentRef": "r"}
        )

    api = order_api(handler)
    history = {
        **CONTEXT,
        "recentOrders": [
            {
                "items": [
                    {
                        "name": "Folgers Classic Roast",
                        "qty": 1,
                        "priceCents": 1099,
                        "storeItemId": "walmart-777",
                    },
                ],
                "store": "Walmart",
                "status": "paid",
                "totalCents": 1099,
                "createdAt": 1,
            }
        ],
    }
    result = await dispatch(
        "place_order",
        {"items": [{"storeItemId": "walmart-777", "qty": 1}]},
        make_ctx(api, context=history),
    )
    assert result["status"] == "paid"
    assert received[0]["items"] == [
        {
            "name": "Folgers Classic Roast",
            "storeItemId": "walmart-777",
            "qty": 1,
            "priceCents": 1099,
        }
    ]
    await api.close()


def test_tool_outcome_is_a_short_status_without_details():
    assert tools.tool_outcome({"status": "paid", "paymentRef": "tok_secret"}) == "paid"
    assert tools.tool_outcome({"error": "Unknown item gift-card"}) == "error"
    assert tools.tool_outcome({"options": []}) == "ok"
    assert len(tools.tool_outcome({"status": "x" * 200})) == 64


# ---- approval hold (#92) ---------------------------------------------------------------------


def status_api(bodies):
    """ConvexAPI whose /agent/order-status answers from `bodies` in order (an int = HTTP error)."""
    seen = []

    def handler(request):
        seen.append(json.loads(request.content))
        body = bodies.pop(0) if len(bodies) > 1 else bodies[0]
        if isinstance(body, int):
            return httpx.Response(body, json={"error": "x"})
        return httpx.Response(200, json=body)

    return order_api(handler), seen


@pytest.mark.asyncio
async def test_approval_hold_polls_until_paid_and_words_each_outcome():
    from tools.order import ApprovalHold

    waiting = {"status": "awaiting_approval", "totalCents": 9588}
    paid = {"status": "paid", "totalCents": 9588, "decidedBy": "Dana"}
    api, seen = status_api([waiting, {**paid, "status": "approved"}, paid])
    ctx = {"household": {"familyContacts": [{"name": "Dana", "relation": "daughter"}]}}
    hold = ApprovalHold(api, "call-1", "order-1", ctx, window_s=5, poll_s=0.01)
    decision = await hold.wait()
    assert decision == paid and len(seen) == 3
    assert seen[0] == {"callId": "call-1", "orderId": "order-1"}
    assert hold.outcome_line(decision) == (
        "Good news. Dana said yes, and your order is placed, ninety-five dollars and "
        "eighty-eight cents in all. Anything else?"
    )
    assert "would rather hold off" in hold.outcome_line({"status": "declined"})
    assert "wasn't answered in time" in hold.outcome_line({"status": "declined", "expired": True})
    assert "didn't go through" in hold.outcome_line({"status": "failed"})
    assert "can't check on it" in hold.outcome_line({"status": "unknown"})
    assert "haven't been able to reach Dana" in hold.outcome_line({"status": "timeout"})
    assert "Dana" in hold.reassurance_line(0) and "?" not in hold.reassurance_line(1)
    note = hold.model_note({**paid, "items": "x", "orderId": "o"})
    assert note == {**paid, "meaning": note["meaning"]}
    assert "placed and paid" in note["meaning"]  # never read as still waiting
    assert "still waiting" in hold.model_note({"status": "timeout"})["meaning"]
    assert "declined" in hold.model_note({"status": "declined"})["meaning"]
    await api.close()


@pytest.mark.asyncio
async def test_approval_hold_times_out_and_gives_up_after_repeated_poll_errors():
    from tools.order import ApprovalHold

    api, seen = status_api([{"status": "awaiting_approval"}])
    hold = ApprovalHold(api, "call-1", "order-1", None, window_s=0.05, poll_s=0.01)
    assert (await hold.wait())["status"] == "timeout"
    await api.close()

    # Approved but not yet paid when the window ends: still a yes.
    api, _ = status_api([{"status": "approved", "decidedBy": "Dana"}])
    hold = ApprovalHold(api, "call-1", "order-1", None, window_s=0.05, poll_s=0.01)
    assert (await hold.wait())["status"] == "approved"
    await api.close()

    api, seen = status_api([500])
    hold = ApprovalHold(api, "call-1", "order-1", None, window_s=5, poll_s=0.01)
    assert await hold.wait() == {"status": "unknown"}
    assert len(seen) == 3
    await api.close()


@pytest.mark.asyncio
async def test_approval_hold_can_be_turned_off(monkeypatch):
    body = {"status": "needs_approval", "orderId": "o2", "totalCents": 6210, "reason": "Over."}
    api = order_api(lambda request: httpx.Response(200, json=body))
    monkeypatch.setenv("APPROVAL_HOLD_S", "0")
    result = await dispatch(
        "place_order", {"items": [{"storeItemId": "demo-milk-gallon", "qty": 1}]}, make_ctx(api)
    )
    assert "_hold" not in result
    assert result["say"].endswith("Is there anything else I can help with?")
    await api.close()
