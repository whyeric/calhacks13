"""Cached Walmart search fixtures (#12): offline, deterministic, same shape as search_items."""

import json
import os
from functools import lru_cache
from pathlib import Path

from .text import content_tokens, phrase

DEFAULT_STORE = "Walmart"


def fixtures_dir() -> Path:
    override = os.environ.get("WALMART_FIXTURES_DIR")
    if override:
        return Path(override)
    # agent/tools/catalog.py -> repo root -> fixtures/walmart
    return Path(__file__).resolve().parents[2] / "fixtures" / "walmart"


@lru_cache(maxsize=1)
def _load() -> tuple[list[dict], dict[str, dict]]:
    path = fixtures_dir() / "search.json"
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return [], {}
    store = data.get("store", DEFAULT_STORE)
    entries, by_id = [], {}
    for entry in data.get("entries", []):
        results = [
            {
                "name": str(r["name"]),
                "size": str(r.get("size", "")),
                "priceCents": int(r["priceCents"]),
                "storeItemId": str(r["storeItemId"]),
            }
            for r in entry.get("results", [])
        ]
        phrases = [phrase(entry["key"]), *(phrase(s) for s in entry.get("synonyms", []))]
        vocab = set()
        for p in phrases:
            vocab.update(content_tokens(p))
        entries.append({"phrases": phrases, "vocab": vocab, "results": results})
        for r in results:
            by_id.setdefault(r["storeItemId"], {**r, "store": store})
    return entries, by_id


def search_fixtures(query: str) -> list[dict]:
    """Return the cached top-two results for a query, or [] when nothing plausible matches.

    Order of preference: exact key/synonym phrase, then a key/synonym phrase contained in the
    query ("some paper towels please"), then the entry sharing the most product words.
    Ties go to the earlier entry so results never depend on dict ordering.
    """
    entries, _ = _load()
    q = phrase(query)
    q_content = phrase(" ".join(content_tokens(query)))
    if not q:
        return []
    for entry in entries:
        if q in entry["phrases"] or (q_content and q_content in entry["phrases"]):
            return [dict(r) for r in entry["results"][:2]]
    best, best_len = None, 0
    for entry in entries:
        for p in entry["phrases"]:
            if f" {p} " in f" {q} " and len(p) > best_len:
                best, best_len = entry, len(p)
    if best:
        return [dict(r) for r in best["results"][:2]]
    words = set(content_tokens(query))
    best, best_score = None, 0
    for entry in entries:
        score = len(words & entry["vocab"])
        if score > best_score:
            best, best_score = entry, score
    return [dict(r) for r in best["results"][:2]] if best else []


def catalog_item(store_item_id: str) -> dict | None:
    """Look up a fixture item by store item id: {name, size, priceCents, storeItemId, store}."""
    _, by_id = _load()
    item = by_id.get(store_item_id)
    return dict(item) if item else None
