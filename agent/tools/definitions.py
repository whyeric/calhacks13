"""Anthropic tool definitions. Part of the cached prompt prefix (§11.3): keep them byte-stable.

Never put timestamps, ids or anything per-call in here. Order is fixed.
"""

import json

TOOLS: list[dict] = [
    {
        "name": "match_favorite",
        "description": (
            "Check whether what the caller asked for is one of their saved favorites, such as "
            '"my usual" or "my coffee". Call this first for any item the caller may buy '
            'regularly. Returns status "match" with one favorite (confirm it in one question, '
            'e.g. "Your usual medium-roast coffee, the big can?", and skip searching), '
            '"ambiguous" with candidates (ask which one; never guess), or "none" (use '
            "search_items)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "utterance": {
                    "type": "string",
                    "description": 'The caller\'s words for the item, e.g. "my coffee".',
                }
            },
            "required": ["utterance"],
            "additionalProperties": False,
        },
    },
    {
        "name": "search_items",
        "description": (
            "Search the store for an item that is not a favorite. Returns up to two options with "
            "name, size and priceCents. Read both options aloud with size and price in dollars, "
            "then ask which one the caller wants. Search one item at a time."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": 'Short product search, e.g. "paper towels".',
                }
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    },
    {
        "name": "place_order",
        "description": (
            "Place the order and pay. This is the only way to buy anything. Call it only after "
            "you have read back every item, the total and the expected arrival, and the caller "
            "has explicitly said yes. Use storeItemId values returned by match_favorite or "
            "search_items in this call; names and prices are filled in by the system. Call it at "
            "most once per reply. Results: "
            '"paid" (confirm warmly), "needs_approval" (explain the reason and that the '
            'family will be asked; nothing was charged), "blocked" (not paid; explain gently; '
            'nothing was charged), "failed" (payment did not go through; nothing was charged), '
            '"processing" (payment still going through) or "unconfirmed" (outcome unknown): '
            "for these two never say it failed or that nothing was charged. An error means the "
            "order was not placed."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "items": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                        "type": "object",
                        "properties": {
                            "storeItemId": {"type": "string"},
                            "qty": {"type": "integer", "minimum": 1, "maximum": 20},
                        },
                        "required": ["storeItemId", "qty"],
                        "additionalProperties": False,
                    },
                },
                "store": {
                    "type": "string",
                    "description": "Store name. Defaults to Walmart.",
                },
            },
            "required": ["items"],
            "additionalProperties": False,
        },
    },
    {
        "name": "forget_fact",
        "description": (
            'Forget something the caller asked you not to remember, e.g. "forget what I said '
            "about my neighbor.\" Describe what to forget in the caller's own terms."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "description": {
                    "type": "string",
                    "description": "What the caller wants forgotten.",
                }
            },
            "required": ["description"],
            "additionalProperties": False,
        },
    },
    {
        "name": "connect_family",
        "description": (
            "Send a short message to the caller's family. Only call after the caller has said "
            "yes to you letting their family know."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "contact": {
                    "type": "string",
                    "description": 'Who to reach, e.g. "Dana" or "my daughter".',
                },
                "message": {
                    "type": "string",
                    "description": "The message in plain words, as the caller would want it.",
                },
            },
            "required": ["contact", "message"],
            "additionalProperties": False,
        },
    },
    {
        "name": "raise_wellbeing_alert",
        "description": (
            'Alert the caller\'s family about a wellbeing concern. Use "emergency" for a fall '
            'with injury, can\'t get up, chest pain or sudden confusion; "crisis" for '
            'self-harm or wanting to die; "concern" for non-urgent worries the caller agreed '
            "to share. Never give medical advice."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "level": {"type": "string", "enum": ["emergency", "crisis", "concern"]},
                "summary": {
                    "type": "string",
                    "description": "One or two factual sentences about what the caller said.",
                },
            },
            "required": ["level", "summary"],
            "additionalProperties": False,
        },
    },
    # Milestone 7 stretch tools, appended so the earlier prefix stays byte-identical.
    {
        "name": "order_status",
        "description": (
            "Look up the caller's recent orders when they ask \"where's my order?\" or whether "
            "an order went through. Read-only; it never orders or pays. Returns a speak line "
            "about the latest order: say it in plain words, at most two short sentences."
        ),
        "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "compare_prices",
        "description": (
            "Compare one item's price at two stores when the caller asks which store is "
            "cheaper. Returns at most two options, cheapest first, with store, name, size, "
            "priceCents and storeItemId, plus a speak line naming the cheaper store. To order "
            "one, pass its storeItemId and its store to place_order."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": 'Short product search, e.g. "paper towels".',
                }
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    },
    {
        "name": "stop_checkins",
        "description": (
            "Turn off check-in calls when the caller says they don't want Errand Line to call "
            'them to check in any more, e.g. "please stop calling me".'
        ),
        "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
]

TOOL_NAMES = tuple(tool["name"] for tool in TOOLS)
TOOLS_JSON = json.dumps(TOOLS, sort_keys=True, separators=(",", ":"))
