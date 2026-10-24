# Grocery Price Check (Walmart)

Prices everyday items at Walmart. Give it a list of short searches ("paper towels", "medium roast coffee"); it returns the top matches for each with the price in integer cents, the size and Walmart's item ID.

Built for [Errand Line](https://github.com/whyeric/calhacks13), a phone line where older adults order groceries by voice. Its `search_items` tool calls this Actor with `run-sync-get-dataset-items` and reads `name`, `usItemId`, `price` and `size`.

## Input

| Field | Type | Default | Notes |
|---|---|---|---|
| `queries` | string list | (required) | One search per item. `searchTerms`, `searchQueries`, `query` and `keyword` are accepted too. |
| `maxItems` | integer | 5 | Results per item, 1 to 20 (`maxResults` is accepted too). |
| `proxyConfiguration` | proxy | Apify residential | Walmart blocks many datacenter IPs. |

## Output

One dataset record per priced result:

```json
{
  "query": "paper towels",
  "store": "Walmart",
  "name": "Bounty Select-A-Size Paper Towels, 6 Double Rolls",
  "usItemId": "123456789",
  "price": 8.97,
  "priceCents": 897,
  "size": "6 Double Rolls",
  "inStock": true,
  "url": "https://www.walmart.com/ip/123456789"
}
```

Prices are read from the public search page at run time and can change. Sponsored placeholders and duplicates are skipped.

## Run locally

```sh
pip install -r requirements.txt
mkdir -p storage/key_value_stores/default
echo '{"queries": ["paper towels"], "maxItems": 2}' > storage/key_value_stores/default/INPUT.json
apify run   # or: python -m src
```

Parsing is unit-tested without the network in `harness/test_apify_actor.py` (run from `agent/`).
