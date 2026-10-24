"""Deterministic text normalization shared by fixture search and favorite matching."""

import re

_PUNCT = re.compile(r"[^a-z0-9%\s]+")
_SPACE = re.compile(r"\s+")

# Words that never identify a product on their own.
FILLER = frozenset(
    [
        "a",
        "an",
        "the",
        "some",
        "of",
        "my",
        "our",
        "me",
        "i",
        "id",
        "im",
        "please",
        "can",
        "could",
        "would",
        "you",
        "get",
        "got",
        "want",
        "wanted",
        "need",
        "needs",
        "order",
        "buy",
        "more",
        "another",
        "again",
        "just",
        "and",
        "to",
        "for",
        "like",
        "also",
        "any",
        "pick",
        "up",
        "usual",
        "one",
    ]
)

# Plural forms the suffix rules below get wrong.
_IRREGULAR = {
    "loaves": "loaf",
    "knives": "knife",
    "leaves": "leaf",
    "potatoes": "potato",
    "tomatoes": "tomato",
    "glasses": "glass",
    "boxes": "box",
    "dishes": "dish",
    "peaches": "peach",
    "sandwiches": "sandwich",
}
_KEEP = frozenset(
    {"news", "glass", "swiss", "hummus", "asparagus", "molasses", "decaf", "oj", "tp"}
)


def singular(word: str) -> str:
    if word in _IRREGULAR:
        return _IRREGULAR[word]
    if word in _KEEP or len(word) <= 3 or word.endswith(("ss", "us")):
        return word
    if word.endswith("ies") and len(word) > 4:
        return word[:-3] + "y"
    if word.endswith("s"):
        return word[:-1]
    return word


def tokens(text: str) -> list[str]:
    """Lowercase, strip punctuation (hyphens split words), singularize."""
    cleaned = _PUNCT.sub(" ", str(text).lower().replace("'", ""))
    return [singular(w) for w in _SPACE.split(cleaned.strip()) if w]


def phrase(text: str) -> str:
    return " ".join(tokens(text))


def content_tokens(text: str) -> list[str]:
    return [t for t in tokens(text) if t not in FILLER]


def contains_phrase(haystack: str, needle: str) -> bool:
    """Whole-word phrase containment on already-normalized phrases."""
    if not needle:
        return False
    return f" {needle} " in f" {haystack} "
