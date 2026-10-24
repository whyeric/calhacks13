"""#64: the price-check Actor's parsing (apify/price-check/src/walmart.py), with no network."""

import importlib.util
import json
from pathlib import Path

import pytest

ACTOR = Path(__file__).resolve().parents[1] / "apify" / "price-check"


@pytest.fixture(scope="module")
def walmart():
    spec = importlib.util.spec_from_file_location("actor_walmart", ACTOR / "src" / "walmart.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def page(items):
    data = {
        "props": {
            "pageProps": {"initialData": {"searchResult": {"itemStacks": [{"items": items}]}}}
        }
    }
    return f'<html><script id="__NEXT_DATA__" type="application/json">{json.dumps(data)}</script>'


ITEMS = [
    {"__typename": "AdPlaceholder"},
    {
        "__typename": "Product",
        "usItemId": "111",
        "name": "Paper Towels, 6 Double Rolls",
        "priceInfo": {"currentPrice": {"price": 8.97, "priceString": "$8.97"}},
        "canonicalUrl": "/ip/111",
        "availabilityStatusV2": {"value": "IN_STOCK"},
    },
    {
        "__typename": "Product",
        "usItemId": "111",
        "name": "Duplicate",
        "priceInfo": {"linePrice": "$1.00"},
    },
    {
        "__typename": "Product",
        "usItemId": "222",
        "name": "Paper Towels 12 Rolls",
        "priceInfo": {"linePrice": "$15.48"},
        "availabilityStatusV2": {"value": "OUT_OF_STOCK"},
    },
    {"__typename": "Product", "usItemId": "333", "name": "No price"},
]


def test_parse_search_returns_priced_products_in_cents(walmart):
    records = walmart.parse_search(page(ITEMS), "paper towels", 5)
    assert [(r["usItemId"], r["priceCents"], r["inStock"]) for r in records] == [
        ("111", 897, True),
        ("222", 1548, False),
    ]
    first = records[0]
    assert first["price"] == 8.97 and first["store"] == "Walmart"
    assert first["size"] == "6 Double Rolls"
    assert first["url"] == "https://www.walmart.com/ip/111"
    assert walmart.parse_search(page(ITEMS), "paper towels", 1) == records[:1]
    assert walmart.parse_search("<html>blocked</html>", "x") == []


def test_output_maps_through_errand_lines_search_tool(walmart):
    from tools.search import map_live_item

    mapped = [map_live_item(r) for r in walmart.parse_search(page(ITEMS), "paper towels")]
    assert mapped[0] == {
        "name": "Paper Towels, 6 Double Rolls",
        "size": mapped[0]["size"],
        "priceCents": 897,
        "storeItemId": "walmart-111",
    }


def test_input_accepts_errand_line_aliases(walmart):
    assert walmart.queries_from_input({"searchTerms": ["coffee"], "query": "Coffee"}) == ["coffee"]
    assert walmart.queries_from_input({"queries": [" paper  towels ", ""]}) == ["paper towels"]
    assert walmart.max_items_from_input({"maxResults": 50}) == 20
    assert walmart.max_items_from_input({}) == 5
    assert walmart.to_cents("$1,234.50") == 123450 and walmart.to_cents(0) is None
    assert walmart.search_url("paper towels") == "https://www.walmart.com/search?q=paper+towels"


def test_actor_config_is_consistent():
    actor = json.loads((ACTOR / ".actor" / "actor.json").read_text())
    schema = json.loads((ACTOR / ".actor" / "input_schema.json").read_text())
    assert actor["input"] == "./input_schema.json" and actor["dockerfile"] == "../Dockerfile"
    assert {"queries", "maxItems", "proxyConfiguration"} <= set(schema["properties"])
    assert (ACTOR / "src" / "__main__.py").exists()
