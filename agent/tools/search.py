"""search_items (#8): live Apify Walmart search with a tight timeout, cached fixtures otherwise.

Env:
  SEARCH_MODE=fixtures      force the cache (the demo sets this); default "auto"
  APIFY_TOKEN               Apify API token; live search is attempted only when set
  APIFY_WALMART_ACTOR       Actor id, "username~actor-name" (or "username/actor-name")
  APIFY_TIMEOUT_SECONDS     client timeout for the live call, default 2.5
  APIFY_WALMART_QUERY_FIELD input field the Actor reads the search term from (optional; by
                            default the common names searchTerms/searchQueries/query/keyword
                            are all sent)
"""

import logging
import os
import re
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

import httpx

from .catalog import DEFAULT_STORE, search_fixtures

log = logging.getLogger(__name__)

APIFY_BASE = "https://api.apify.com/v2"
_client: httpx.AsyncClient | None = None

_SIZE = re.compile(
    r"(\d+(?:\.\d+)?\s*(?:-\s*)?(?:fl\.?\s*oz|oz|ounces?|lbs?|pounds?|ct|count|rolls?|pack|pk|"
    r"gal(?:lon)?s?|liters?|l|ml|sheets?|bags?|cans?)\b)",
    re.IGNORECASE,
)


def get_client() -> httpx.AsyncClient:
    """One pooled client for all Apify calls (§12.3: reuse connections)."""
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(base_url=APIFY_BASE)
    return _client


async def close_client():
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


def _timeout() -> float:
    try:
        return max(0.1, float(os.environ.get("APIFY_TIMEOUT_SECONDS", "2.5")))
    except ValueError:
        return 2.5


def live_configured() -> bool:
    if os.environ.get("SEARCH_MODE", "auto").strip().lower() in {"fixtures", "cache", "offline"}:
        return False
    return bool(os.environ.get("APIFY_TOKEN") and os.environ.get("APIFY_WALMART_ACTOR"))


def to_cents(value) -> int | None:
    """Dollar amounts from Actor output (8.97, "$8.97", {"price": 8.97}) → integer cents."""
    if isinstance(value, dict):
        for key in ("currentPrice", "price", "salePrice", "value", "amount", "priceString"):
            if key in value:
                cents = to_cents(value[key])
                if cents is not None:
                    return cents
        return None
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, str):
        match = re.search(r"\d[\d,]*(?:\.\d+)?", value)
        if not match:
            return None
        value = match.group(0).replace(",", "")
    try:
        dollars = Decimal(str(value))
    except InvalidOperation:
        return None
    if dollars <= 0:
        return None
    return int((dollars * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def _first(raw: dict, *keys):
    for key in keys:
        value = raw.get(key)
        if value not in (None, "", [], {}):
            return value
    return None


def map_live_item(raw) -> dict | None:
    if not isinstance(raw, dict):
        return None
    name = _first(raw, "name", "title", "productName")
    item_id = _first(raw, "usItemId", "itemId", "productId", "id", "sku")
    price = _first(raw, "price", "currentPrice", "salePrice", "priceInfo", "offerPrice")
    cents = to_cents(price)
    if not name or item_id is None or cents is None:
        return None
    size = _first(raw, "size", "unitSize", "variant", "packSize")
    if not size:
        found = _SIZE.search(str(name))
        size = found.group(1) if found else ""
    return {
        "name": str(name).strip()[:120],
        "size": str(size).strip()[:40],
        "priceCents": cents,
        "storeItemId": f"walmart-{item_id}",
    }


def _actor_input(query: str) -> dict:
    field = os.environ.get("APIFY_WALMART_QUERY_FIELD")
    if field:
        return {field: [query] if field.endswith("s") else query, "maxItems": 5}
    return {
        "searchTerms": [query],
        "searchQueries": [query],
        "query": query,
        "keyword": query,
        "maxItems": 5,
        "maxResults": 5,
    }


async def search_live(query: str) -> list[dict]:
    """Top two mapped results from the Actor. Raises on timeout, HTTP error or bad payload."""
    actor = os.environ["APIFY_WALMART_ACTOR"].strip().replace("/", "~")
    timeout = _timeout()
    response = await get_client().post(
        f"/acts/{actor}/run-sync-get-dataset-items",
        params={"limit": 10, "timeout": max(1, int(timeout + 0.999))},
        headers={"Authorization": f"Bearer {os.environ['APIFY_TOKEN']}"},
        json=_actor_input(query),
        timeout=timeout,
    )
    response.raise_for_status()
    rows = response.json()
    if isinstance(rows, dict):
        rows = rows.get("items") or rows.get("data") or []
    if not isinstance(rows, list):
        raise TypeError("unexpected Actor payload")
    options, seen = [], set()
    for raw in rows:
        item = map_live_item(raw)
        if item and item["storeItemId"] not in seen:
            seen.add(item["storeItemId"])
            options.append(item)
        if len(options) == 2:
            break
    return options


async def search_items(query: str) -> dict:
    """{status, query, store, source: "live"|"cache", options: [≤2 {name,size,priceCents,storeItemId}]}"""
    query = str(query or "").strip()[:100]
    if not query:
        return {"error": "Say what to search for, like 'paper towels'."}
    if live_configured():
        try:
            options = await search_live(query)
            if options:
                return _result(query, "live", _top_up(options, query))
        except Exception as exc:  # noqa: BLE001 -- any live failure falls back to the cache
            # Never log the request or exception repr: they can carry the token.
            log.warning("Live search failed (%s); using cached results", type(exc).__name__)
    options = search_fixtures(query)
    return _result(query, "cache", options)


def _top_up(options: list[dict], query: str) -> list[dict]:
    """VO-5: always offer two options. A one-item live result gets the best cached match."""
    if len(options) >= 2:
        return options[:2]
    ids = {o["storeItemId"] for o in options}
    extra = [o for o in search_fixtures(query) if o["storeItemId"] not in ids]
    return options + extra[: 2 - len(options)]


def _result(query: str, source: str, options: list[dict]) -> dict:
    result = {
        "status": "ok" if options else "no_results",
        "query": query,
        "store": DEFAULT_STORE,
        "source": source,
        "options": options,
    }
    if not options:
        result["message"] = "Nothing found. Ask the caller to describe it another way."
    return result
