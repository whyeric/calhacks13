"""Pure parsing for the price-check Actor: no Apify or network imports, so it is unit-tested.

Walmart's search page embeds its results as JSON in <script id="__NEXT_DATA__">. Each result
becomes one flat record whose field names match what Errand Line's search_items tool reads
(name, usItemId, price, size), plus the price in integer cents.
"""

import json
import re
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from urllib.parse import quote_plus

SEARCH_URL = "https://www.walmart.com/search?q={query}"
_NEXT_DATA = re.compile(
    r'<script[^>]*id="__NEXT_DATA__"[^>]*>(?P<json>.*?)</script>', re.DOTALL | re.IGNORECASE
)
_SIZE = re.compile(
    r"(\d+(?:\.\d+)?\s*(?:-\s*)?(?:(?:double|mega|family|giant|big|regular)\s+)?(?:fl\.?\s*oz|oz|ounces?|lbs?|pounds?|ct|count|rolls?|pack|pk|"
    r"gal(?:lon)?s?|liters?|l|ml|sheets?|bags?|cans?)\b)",
    re.IGNORECASE,
)


def search_url(query: str) -> str:
    return SEARCH_URL.format(query=quote_plus(query.strip()))


def to_cents(value) -> int | None:
    """8.97, "$8.97", "8.97" -> 897. None for missing, zero or unparseable prices."""
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


def _price(item: dict) -> int | None:
    info = item.get("priceInfo") or {}
    for candidate in (
        (info.get("currentPrice") or {}).get("price"),
        info.get("linePrice"),
        (info.get("currentPrice") or {}).get("priceString"),
        item.get("price"),
    ):
        cents = to_cents(candidate)
        if cents is not None:
            return cents
    return None


def _in_stock(item: dict) -> bool:
    status = item.get("availabilityStatusV2")
    value = status.get("value") if isinstance(status, dict) else item.get("availabilityStatus")
    return (value or "IN_STOCK") == "IN_STOCK"


def next_data(html: str) -> dict | None:
    match = _NEXT_DATA.search(html or "")
    if not match:
        return None
    try:
        return json.loads(match.group("json"))
    except ValueError:
        return None


def _items(data: dict) -> list[dict]:
    search = (((data.get("props") or {}).get("pageProps") or {}).get("initialData") or {}).get(
        "searchResult"
    ) or {}
    out = []
    for stack in search.get("itemStacks") or []:
        for item in stack.get("items") or []:
            if isinstance(item, dict):
                out.append(item)
    return out


def parse_search(html: str, query: str, max_items: int = 5) -> list[dict]:
    """Priced product records from one Walmart search page, in page order, without sponsored
    placeholders or duplicates."""
    data = next_data(html)
    if not data:
        return []
    records, seen = [], set()
    for item in _items(data):
        if item.get("__typename") not in (None, "Product"):
            continue
        item_id = item.get("usItemId") or item.get("id")
        name = " ".join(str(item.get("name") or "").split())
        cents = _price(item)
        if not item_id or not name or cents is None or item_id in seen:
            continue
        seen.add(item_id)
        size = _SIZE.search(name)
        url = item.get("canonicalUrl") or ""
        records.append(
            {
                "query": query,
                "store": "Walmart",
                "name": name[:200],
                "usItemId": str(item_id),
                "price": cents / 100,
                "priceCents": cents,
                "size": size.group(1) if size else "",
                "inStock": _in_stock(item),
                "url": f"https://www.walmart.com{url}" if url.startswith("/") else url,
            }
        )
        if len(records) >= max_items:
            break
    return records


def queries_from_input(actor_input: dict) -> list[str]:
    """`queries`, or the aliases Errand Line's search tool sends (searchTerms, query...)."""
    raw = []
    for key in ("queries", "searchTerms", "searchQueries"):
        value = actor_input.get(key)
        if isinstance(value, list):
            raw += value
    for key in ("query", "keyword"):
        if isinstance(actor_input.get(key), str):
            raw.append(actor_input[key])
    out = []
    for q in raw:
        q = " ".join(str(q).split())[:100]
        if q and q.lower() not in (o.lower() for o in out):
            out.append(q)
    return out[:50]


def max_items_from_input(actor_input: dict) -> int:
    for key in ("maxItems", "maxResults"):
        value = actor_input.get(key)
        if isinstance(value, int) and not isinstance(value, bool):
            return min(max(value, 1), 20)
    return 5
