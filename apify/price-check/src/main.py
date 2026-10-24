"""Grocery Price Check Actor: Walmart prices for everyday items, in integer cents.

Input: {"queries": ["paper towels", ...], "maxItems": 5, "proxyConfiguration": {...}}
(Errand Line's search tool may also send searchTerms / query / maxResults; all are accepted.)
Output: one dataset record per priced result; see src/walmart.py for the fields.
"""

import asyncio

import httpx
from apify import Actor

from .walmart import max_items_from_input, parse_search, queries_from_input, search_url

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/126.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "en-US,en;q=0.9",
}
ATTEMPTS = 3


async def fetch(query: str, proxy_configuration) -> str | None:
    for attempt in range(ATTEMPTS):
        proxy = await proxy_configuration.new_url() if proxy_configuration else None
        try:
            async with httpx.AsyncClient(proxy=proxy, headers=HEADERS, timeout=20) as client:
                response = await client.get(search_url(query), follow_redirects=True)
            if response.status_code == 200 and "__NEXT_DATA__" in response.text:
                return response.text
            Actor.log.warning(f"{query!r}: HTTP {response.status_code} (attempt {attempt + 1})")
        except httpx.HTTPError as exc:
            Actor.log.warning(f"{query!r}: {type(exc).__name__} (attempt {attempt + 1})")
        await asyncio.sleep(1 + attempt)
    return None


async def main() -> None:
    async with Actor:
        actor_input = await Actor.get_input() or {}
        queries = queries_from_input(actor_input)
        if not queries:
            await Actor.fail(status_message="Give at least one item in `queries`.")
            return
        max_items = max_items_from_input(actor_input)
        proxy_configuration = await Actor.create_proxy_configuration(
            actor_proxy_input=actor_input.get("proxyConfiguration")
        )
        total = 0
        for query in queries:
            html = await fetch(query, proxy_configuration)
            records = parse_search(html or "", query, max_items)
            if not records:
                Actor.log.warning(f"{query!r}: no priced results")
                continue
            await Actor.push_data(records)
            total += len(records)
        await Actor.set_status_message(f"Priced {total} results for {len(queries)} items")
