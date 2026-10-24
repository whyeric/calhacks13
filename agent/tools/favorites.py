"""match_favorite (#19): deterministic, code-side favorite matching. Never guesses (FAV-3).

1. Personal aliases ("my usual", "my coffee", "usual coffee": any alias using "my" or "usual")
   and full favorite names are strong: if the utterance contains exactly one favorite's strong
   phrase, that favorite matches.
2. Otherwise compare product words. A favorite matches only if it covers every product word in
   the utterance and no other favorite does ("decaf" → decaf, "big can of coffee" → big can).
   Several favorites covering the words ("coffee", "medium roast") → ambiguous.
"""

from .catalog import DEFAULT_STORE, catalog_item
from .text import contains_phrase, content_tokens, phrase, tokens

_PERSONAL = {"my", "usual"}


def _normalize_utterance(utterance: str) -> str:
    text = phrase(utterance)
    return f" {text} ".replace(" the usual ", " my usual ").strip()


def _strong_phrases(fav: dict) -> list[str]:
    out = [phrase(fav.get("name", ""))]
    for alias in fav.get("aliases") or []:
        if _PERSONAL & set(tokens(alias)):
            out.append(phrase(alias))
    return [p for p in out if p]


def _vocab(fav: dict) -> set[str]:
    words = set(content_tokens(fav.get("name", "")))
    for alias in fav.get("aliases") or []:
        words.update(content_tokens(alias))
    return words


def describe(fav: dict) -> dict:
    """The favorite as the model sees it, priced from the catalog (never from the model)."""
    store_item_id = str(fav.get("storeItemId", ""))
    item = catalog_item(store_item_id)
    qty = fav.get("usualQty")
    out = {
        "name": fav.get("name") or (item or {}).get("name", ""),
        "storeItemId": store_item_id,
        "store": fav.get("store") or DEFAULT_STORE,
        "qty": int(qty) if isinstance(qty, (int, float)) and qty >= 1 else 1,
        "priceCents": item["priceCents"] if item else None,
    }
    if item and item.get("size"):
        out["size"] = item["size"]
    return out


def match_favorite(utterance: str, favorites: list[dict]) -> dict:
    favorites = [f for f in favorites or [] if isinstance(f, dict) and f.get("storeItemId")]
    text = _normalize_utterance(utterance)
    if not text or not favorites:
        return {"status": "none"}

    strong = [f for f in favorites if any(contains_phrase(text, p) for p in _strong_phrases(f))]
    if len(strong) == 1:
        return {"status": "match", "favorite": describe(strong[0])}
    pool = strong or favorites

    words = set(content_tokens(utterance))
    if not words:
        if len(strong) > 1:
            return {"status": "ambiguous", "candidates": [describe(f) for f in strong]}
        return {"status": "none"}

    scored = [(len(words & _vocab(f)), f) for f in pool]
    full = [f for score, f in scored if score == len(words)]
    if len(full) == 1:
        return {"status": "match", "favorite": describe(full[0])}
    if len(full) > 1:
        return {"status": "ambiguous", "candidates": [describe(f) for f in full]}
    if len(strong) > 1:
        return {"status": "ambiguous", "candidates": [describe(f) for f in strong]}
    partial = [f for score, f in scored if score > 0]
    if partial:
        # Some words matched but none fully: let the caller choose rather than guess.
        return {"status": "ambiguous", "candidates": [describe(f) for f in partial]}
    return {"status": "none"}
