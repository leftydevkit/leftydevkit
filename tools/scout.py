#!/usr/bin/env python3
"""Daily corruption scout for LeftyDevKit.

Pulls recent news for a fixed set of corruption queries, drops anything that
already matches the verified ledger or a previous candidate, and writes the
survivors to apps/website/static/data/candidates.json for human verification.

This is a *queue*, not a ledger writer: nothing here is verified, and nothing
here touches totals. A person promotes an item into ledger.json with citations.

Usage:
    python tools/scout.py                # last 2 days
    python tools/scout.py --days 7
    python tools/scout.py --dry-run      # print, write nothing

No API keys. Google News RSS with a Bing News RSS fallback.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LEDGER = ROOT / "apps" / "website" / "static" / "data" / "ledger.json"
OUT = ROOT / "apps" / "website" / "static" / "data" / "candidates.json"

QUERIES = [
    "Trump corruption OR self-dealing OR \"conflict of interest\"",
    "Trump \"no-bid\" OR emolument OR \"pay to play\"",
    "Trump crypto OR \"World Liberty Financial\" OR memecoin",
    "Trump pardon OR donor OR super PAC",
    "site:propublica.org Trump",
    "site:reuters.com Trump investigation",
]

UA = "ldk-scout/1.0 (+https://leftydevkit.com)"

# A headline only enters the queue if it names Trump (or a family entity) AND
# carries at least one corruption-adjacent term. Keeps OR-query noise out.
ENTITY_TERMS = ("trump", "world liberty", "kushner", "trump organization", "djt")
CORRUPTION_TERMS = (
    "corrupt", "self-deal", "conflict", "emolument", "no-bid", "pay to play",
    "donor", "pardon", "crypto", "stock", "trade", "contract", "bribe", "gift",
    "lobby", "dark money", "insider", "ethic", "investigat", "probe", "lawsuit",
    "settlement", "tariff", "sanction", "deal", "profit", "payment",
)


def relevant(title: str) -> bool:
    t = title.lower()
    if not any(e in t for e in ENTITY_TERMS):
        return False
    return any(c in t for c in CORRUPTION_TERMS)


def get(url: str, timeout: int = 20) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/rss+xml, application/xml"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def feed_urls(query: str, days: int) -> list[str]:
    q = urllib.parse.quote_plus(f"{query} when:{days}d")
    return [
        f"https://news.google.com/rss/search?q={q}&hl=en-US&gl=US&ceid=US:en",
        "https://www.bing.com/news/search?format=RSS&q=" + q,
    ]


def parse_feed(blob: bytes, query: str) -> list[dict]:
    out: list[dict] = []
    try:
        root = ET.fromstring(blob)
    except ET.ParseError:
        return out
    for item in root.iter("item"):
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        pub = item.findtext("pubDate") or item.findtext("{http://purl.org/dc/elements/1.1/}date") or ""
        source = item.findtext("source") or ""
        if not title or not link:
            continue
        try:
            when = parsedate_to_datetime(pub).astimezone(timezone.utc)
        except Exception:
            when = None
        out.append({
            "title": title,
            "url": link,
            "source": source.strip(),
            "published": when.isoformat() if when else None,
            "query": query,
        })
    return out


def norm_title(t: str) -> str:
    t = re.sub(r"\s+-\s+[^-]+$", "", t)          # strip trailing " - Publisher"
    t = re.sub(r"[^a-z0-9 ]+", " ", t.lower())
    return " ".join(t.split())


def known_titles() -> set[str]:
    titles: set[str] = set()
    try:
        data = json.loads(LEDGER.read_text(encoding="utf-8"))
        for inc in data.get("incidents", []):
            if inc.get("title"):
                titles.add(norm_title(inc["title"]))
    except Exception:
        pass
    try:
        prev = json.loads(OUT.read_text(encoding="utf-8"))
        for it in prev.get("items", []):
            titles.add(norm_title(it.get("title", "")))
    except Exception:
        pass
    return titles


def is_dupe(title: str, known: set[str]) -> bool:
    n = norm_title(title)
    if not n:
        return True
    if n in known:
        return True
    words = set(n.split())
    for k in known:
        kw = set(k.split())
        if len(words & kw) / max(1, len(words | kw)) > 0.72:
            return True
    return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=2)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    known = known_titles()
    seen_urls: set[str] = set()
    items: list[dict] = []
    fetched = 0
    errors: list[str] = []

    for q in QUERIES:
        got = False
        for url in feed_urls(q, args.days):
            try:
                blob = get(url)
                rows = parse_feed(blob, q)
                fetched += len(rows)
                for row in rows:
                    if not relevant(row["title"]):
                        continue
                    if row["url"] in seen_urls or is_dupe(row["title"], known):
                        continue
                    seen_urls.add(row["url"])
                    items.append(row)
                got = True
                break
            except Exception as e:                      # noqa: BLE001 - one feed down is normal
                errors.append(f"{url.split('/')[2]}: {e}")
        if not got:
            continue

    cutoff = datetime.now(timezone.utc) - timedelta(days=args.days)
    items = [i for i in items if not i.get("published") or datetime.fromisoformat(i["published"]) >= cutoff]
    items.sort(key=lambda i: i.get("published") or "", reverse=True)

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "window_days": args.days,
        "queries": QUERIES,
        "stats": {"fetched": fetched, "new": len(items)},
        "items": items[:120],
    }

    if args.dry_run:
        print(json.dumps(payload, indent=2)[:6000])
        return 0

    # keep the last 300 candidates across runs
    old: list[dict] = []
    try:
        old = json.loads(OUT.read_text(encoding="utf-8")).get("items", [])
    except Exception:
        pass
    merged = items + [i for i in old if i.get("url") not in seen_urls]
    payload["items"] = merged[:300]
    payload["stats"]["kept"] = len(payload["items"])
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"scout: fetched {fetched}, new {len(items)}, kept {len(payload['items'])} -> {OUT.relative_to(ROOT)}")
    if errors:
        print("feed errors: " + "; ".join(errors[:3]), file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
