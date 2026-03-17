#!/usr/bin/env python3
"""Generate a daily ANTIHUNTER holder distribution report and queue an X post."""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import re
from decimal import Decimal, getcontext
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

from lib.public_intents_writer import append_intent as append_public_intent

ROOT = Path(__file__).resolve().parents[1]
REPORT_DIR = ROOT / "memory" / "holder_reports"
QUEUE_PATH = ROOT / "memory" / "public_intents_queue.jsonl"
HISTORY_PATH = REPORT_DIR / "history.jsonl"
TOKEN_ADDRESS = "0xe2f3fae4bc62e21826018364aa30ae45d430bb07"
BLOCKSCOUT_BASE = "https://base.blockscout.com/api/v2"
BASESCAN_TOKEN_URL = f"https://basescan.org/token/{TOKEN_ADDRESS}"
TREASURY_WALLETS = {
    "0xa668ddf22a4c0ecbb31c89b16f355b26ae7703c3": "primary treasury",
    "0x30d8c9f8955e6453f6b471fb950ff49c2e843d3": "reserve treasury",
}
MAX_HOLDERS = 200
getcontext().prec = 50
TZ_ET = ZoneInfo("America/New_York")


def iso_utc(ts: dt.datetime | None = None) -> str:
    ts = ts or dt.datetime.now(dt.timezone.utc)
    return ts.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def get_json(path: str, params: Optional[dict] = None) -> dict:
    url = f"{BLOCKSCOUT_BASE}{path}"
    if params:
        query = urlencode({k: v for k, v in params.items() if v is not None})
        connector = "&" if "?" in url else "?"
        url = f"{url}{connector}{query}"
    req = Request(url, headers={"User-Agent": "holder-report/1.0"})
    with urlopen(req, timeout=30) as response:
        data = response.read()
    return json.loads(data)


def fetch_token_info() -> dict:
    return get_json(f"/tokens/{TOKEN_ADDRESS}")


def fetch_basescan_token_html() -> str:
    req = Request(BASESCAN_TOKEN_URL, headers={"User-Agent": "holder-report/1.0"})
    with urlopen(req, timeout=30) as response:
        return response.read().decode("utf-8", errors="ignore")


def fetch_basescan_holder_count() -> Optional[int]:
    html = fetch_basescan_token_html()
    match = re.search(r"Holders\s*</div>\s*<div[^>]*>\s*([0-9,]+)", html, re.I)
    if not match:
        match = re.search(r"Holders:\s*([0-9,]+)", html, re.I)
    if not match:
        return None
    return int(match.group(1).replace(",", ""))


def fetch_basescan_top_holders(limit: int = MAX_HOLDERS) -> List[dict]:
    url = f"https://basescan.org/token/generic-tokenholders2?a={TOKEN_ADDRESS}"
    req = Request(url, headers={"User-Agent": "holder-report/1.0"})
    with urlopen(req, timeout=30) as response:
        html = response.read().decode("utf-8", errors="ignore")

    tbody_match = re.search(r"<tbody[^>]*>(.*?)</tbody>", html, re.I | re.S)
    if not tbody_match:
        return []
    tbody = tbody_match.group(1)
    rows = re.findall(r"<tr>(.*?)</tr>", tbody, re.I | re.S)

    holders: List[dict] = []
    for row in rows[:limit]:
        addr_match = re.search(r"data-clipboard-text='(0x[a-fA-F0-9]{40})'", row)
        if not addr_match:
            continue
        addr = addr_match.group(1)

        # Prefer tagged name if present, else fallback to shortened address text.
        name_match = re.search(r"target='_parent'>([^<]+)</a></span>", row)
        if not name_match:
            name_match = re.search(r'data-highlight-target="[^"]+">([^<]+)</span>', row)
        label = (name_match.group(1).strip() if name_match else addr)

        val_match = re.search(r"title='([0-9,]+(?:\.[0-9]+)?)'", row)
        if not val_match:
            continue
        tokens = Decimal(val_match.group(1).replace(',', ''))

        meta_name = label.lower()
        is_contract = ('pool manager' in meta_name) or ('uniswap' in meta_name)
        holders.append({
            'address': {
                'hash': addr,
                'name': label,
                'ens_domain_name': None,
                'is_contract': is_contract,
                'metadata': {'tags': []},
            },
            'value': str((tokens * (Decimal(10) ** 18)).quantize(Decimal('1'))),
        })
    return holders


def fetch_address_token_balance(address: str) -> Decimal:
    try:
        data = get_json(f"/addresses/{address}/token-balances")
    except HTTPError:
        return Decimal(0)
    if isinstance(data, dict):
        items = data.get("items", [])
    else:
        items = data
    for item in items:
        token = item.get("token") or {}
        if (token.get("address_hash") or "").lower() == TOKEN_ADDRESS.lower():
            return Decimal(item.get("value", "0"))
    return Decimal(0)


def to_decimal(value: str) -> Decimal:
    return Decimal(value)


def format_amount(amount: Decimal) -> str:
    abs_amount = abs(amount)
    if abs_amount >= Decimal("1000000000"):
        return f"{amount / Decimal('1000000000'):.2f}B"
    if abs_amount >= Decimal("1000000"):
        return f"{amount / Decimal('1000000'):.2f}M"
    if abs_amount >= Decimal("1000"):
        return f"{amount / Decimal('1000'):.2f}K"
    return f"{amount:.2f}"


def detect_exchange(holder: dict) -> bool:
    meta = holder.get("address", {}).get("metadata") or {}
    tags = meta.get("tags") or []
    for tag in tags:
        name = (tag.get("name") or "").lower()
        slug = (tag.get("slug") or "").lower()
        if "exchange" in name or slug == "exchange":
            return True
    return False


def detect_liquidity_infra(holder: dict) -> bool:
    address = holder.get("address", {}) or {}
    meta = address.get("metadata") or {}
    tags = meta.get("tags") or []
    hay = " ".join(filter(None, [
        str(address.get("name") or ""),
        str(address.get("ens_domain_name") or ""),
        *[(tag.get("name") or "") for tag in tags],
        *[(tag.get("slug") or "") for tag in tags],
    ])).lower()
    needles = (
        'pool manager', 'poolmanager', 'uniswap', 'aerodrome', 'dex', 'pair', 'lp', 'liquidity', 'router', 'vault'
    )
    return any(n in hay for n in needles)


def infer_label(holder: dict) -> str:
    address = holder.get("address", {})
    if detect_exchange(holder):
        return "exchange"
    if address.get("is_contract"):
        if address.get("ens_domain_name"):
            return f"contract ({address['ens_domain_name']})"
        return "contract"
    if address.get("ens_domain_name"):
        return address["ens_domain_name"]
    if address.get("name"):
        return address["name"]
    return "wallet"


def load_last_history() -> Optional[dict]:
    if not HISTORY_PATH.exists():
        return None
    lines = [line.strip() for line in HISTORY_PATH.read_text().splitlines() if line.strip()]
    if not lines:
        return None
    try:
        return json.loads(lines[-1])
    except json.JSONDecodeError:
        return None


def append_history(entry: dict) -> None:
    HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
    with HISTORY_PATH.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")


def format_delta(current: float, previous: Optional[float], precision: int = 1) -> str:
    if previous is None:
        return ""
    diff = round(current - previous, precision)
    if abs(diff) < (0.1 if precision == 1 else 0.01):
        diff = 0.0
    sign = "+" if diff > 0 else "" if diff == 0 else ""
    return f" ({sign}{diff:.{precision}f})"


def format_int_delta(current: int, previous: Optional[int]) -> str:
    if previous is None:
        return ""
    diff = current - previous
    sign = "+" if diff > 0 else "" if diff == 0 else ""
    return f" ({sign}{diff})"


def build_report(date_str: str, token_info: dict, holders: List[dict], basescan_holder_count: Optional[int]) -> dict:
    decimals = int(token_info.get("decimals", "18"))
    scale = Decimal(10) ** decimals
    total_supply = Decimal(token_info.get("total_supply", "0")) / scale
    holders_count = int(basescan_holder_count or 0)
    price = Decimal(token_info.get("exchange_rate", "0"))
    market_cap = Decimal(token_info.get("circulating_market_cap", "0"))

    enriched = []
    for item in holders:
        raw_value = Decimal(item.get("value", "0"))
        tokens = raw_value / scale
        pct = (tokens / total_supply * Decimal(100)) if total_supply > 0 else Decimal(0)
        addr = item.get("address", {}).get("hash", "").lower()
        enriched.append({
            "address": addr,
            "tokens": tokens,
            "percent": pct,
            "label": infer_label(item),
            "is_treasury": addr in TREASURY_WALLETS,
            "is_exchange": detect_exchange(item),
            "is_liquidity_infra": detect_liquidity_infra(item),
            "is_contract": bool(item.get("address", {}).get("is_contract")),
        })

    enriched.sort(key=lambda x: x["tokens"], reverse=True)

    # ensure treasury wallets are explicitly included even if the holder API omits them
    current_by_addr = {entry["address"]: entry for entry in enriched}
    for treasury_addr, label in TREASURY_WALLETS.items():
        addr_lower = treasury_addr.lower()
        if addr_lower in current_by_addr:
            current_by_addr[addr_lower]["is_treasury"] = True
            continue
        raw_balance = fetch_address_token_balance(addr_lower)
        if raw_balance <= 0:
            continue
        tokens = raw_balance / scale
        pct = (tokens / total_supply * Decimal(100)) if total_supply > 0 else Decimal(0)
        entry = {
            "address": addr_lower,
            "tokens": tokens,
            "percent": pct,
            "label": label,
            "is_treasury": True,
            "is_exchange": False,
            "is_liquidity_infra": False,
            "is_contract": False,
        }
        enriched.append(entry)

    enriched.sort(key=lambda x: x["tokens"], reverse=True)

    public_holders = [
        entry for entry in enriched
        if not entry["is_treasury"] and not entry["is_liquidity_infra"] and not entry["is_exchange"]
    ]

    def pct_sum(entries: List[dict], count: int) -> float:
        return float(sum(entry["percent"] for entry in entries[:count]))

    treasury_pct = float(sum(entry["percent"] for entry in enriched if entry["is_treasury"]))
    exchange_pct = float(sum(entry["percent"] for entry in enriched if entry["is_exchange"]))
    liquidity_infra_pct = float(sum(entry["percent"] for entry in enriched if entry["is_liquidity_infra"]))

    largest_non_treasury = next((entry for entry in public_holders), None)
    largest_non_treasury_pct = float(largest_non_treasury["percent"]) if largest_non_treasury else 0.0

    one_percent_wallets = [entry for entry in public_holders if entry["percent"] >= 1.0]

    stats = {
        "methodology": "basescan_only_public_wallets_ex_treasury_liquidity_exchange_v3",
        "date": date_str,
        "holders": holders_count,
        "top1_pct": float(enriched[0]["percent"]) if enriched else 0.0,
        "top1_public_pct": float(public_holders[0]["percent"]) if public_holders else 0.0,
        "top5_pct": pct_sum(public_holders, 5),
        "top10_pct": pct_sum(public_holders, 10),
        "top25_pct": pct_sum(public_holders, 25),
        "treasury_pct": treasury_pct,
        "exchange_pct": exchange_pct,
        "liquidity_infra_pct": liquidity_infra_pct,
        "largest_non_treasury_pct": largest_non_treasury_pct,
        "wallets_over_1pct": len(one_percent_wallets),
        "price": float(price),
        "market_cap": float(market_cap),
    }

    return {
        "stats": stats,
        "holders": enriched,
        "total_supply": float(total_supply),
    }


def write_markdown(report: dict, date_str: str) -> Path:
    stats = report["stats"]
    holders = report["holders"]
    path = REPORT_DIR / f"holder_report_{date_str}.md"
    REPORT_DIR.mkdir(parents=True, exist_ok=True)

    lines = [
        f"# $antihunter holder report — {date_str}",
        "",
        "## snapshot",
        f"- holders: {stats['holders']}",
        f"- price: ${stats['price']:.6f}",
        f"- circulating mcap (usd): ${stats['market_cap']:.0f}",
        f"- total supply: {format_amount(Decimal(str(report['total_supply'])))}",
        "",
        "## concentration",
        f"- top 1 raw holder: {stats['top1_pct']:.2f}% of supply",
        f"- top 1 public wallet (ex treasury/liquidity): {stats['top1_public_pct']:.2f}%",
        f"- top 5 public wallets: {stats['top5_pct']:.2f}%",
        f"- top 10 public wallets: {stats['top10_pct']:.2f}%",
        f"- treasury (0xa668 + 0x30d8): {stats['treasury_pct']:.2f}%",
        f"- liquidity infra: {stats['liquidity_infra_pct']:.2f}%",
        f"- exchange/custody: {stats['exchange_pct']:.2f}%",
        f"- wallets >= 1%: {stats['wallets_over_1pct']}",
        "",
        "## top holders",
        "| rank | address | tokens | % supply | label |",
        "|---|---|---|---|---|",
    ]

    for idx, entry in enumerate(holders[:20], start=1):
        tokens_display = format_amount(entry["tokens"])
        pct_display = f"{entry['percent']:.2f}%"
        label_parts = []
        if entry["is_treasury"]:
            label_parts.append(TREASURY_WALLETS[entry["address"]])
        if entry["is_exchange"]:
            label_parts.append("exchange")
        if not label_parts:
            label_parts.append(entry["label"])
        label = ", ".join(label_parts)
        addr = entry["address"]
        lines.append(f"| {idx} | `{addr}` | {tokens_display} | {pct_display} | {label} |")

    lines.extend([
        "",
        "_data source: basescan.org token page + holder table._",
    ])

    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def health_sentence(stats: dict) -> str:
    top10 = stats["top10_pct"]
    largest_non_treasury = stats["largest_non_treasury_pct"]

    if top10 < 25 and largest_non_treasury < 5:
        return "public holder distribution looks fairly spread — no non-treasury/non-liquidity wallet dominates."
    if top10 < 40 and largest_non_treasury < 10:
        return "public holder distribution is watchable but still reasonable — concentration exists, not dominance."
    return "public holder concentration is elevated — monitor whale wallets and liquidity dependence closely."


def build_tweet(stats: dict, prev: Optional[dict]) -> str:
    comparable_prev = prev if prev and prev.get('methodology') == stats.get('methodology') else None
    holders_line = f"holders: {stats['holders']}{format_int_delta(stats['holders'], comparable_prev.get('holders') if comparable_prev else None)}"
    top10_line = f"top 10 public wallets: {stats['top10_pct']:.1f}%{format_delta(stats['top10_pct'], comparable_prev.get('top10_pct') if comparable_prev else None)}"
    treasury_line = f"treasury: {stats['treasury_pct']:.1f}%"
    liquidity_line = f"liquidity infra: {stats['liquidity_infra_pct']:.1f}%"
    largest_line = f"largest public wallet: {stats['largest_non_treasury_pct']:.1f}%"
    exchange_line = f"exchanges/custody: {stats['exchange_pct']:.2f}%"
    health_line = health_sentence(stats)
    source_line = "source: basescan.org/token/0xe2f3fae4bc62e21826018364aa30ae45d430bb07"

    text = "\n".join([
        "morning holder scan — $antihunter",
        holders_line,
        top10_line,
        treasury_line,
        liquidity_line,
        largest_line,
        exchange_line,
        health_line,
        source_line,
    ])
    return text.lower()


def queue_post(text: str, now_et: dt.datetime) -> dict:
    entry = {
        "tsEt": now_et.isoformat(),
        "sourceJob": "holder_distribution_daily",
        "runId": f"holder-report-{now_et.isoformat()}",
        "kind": "root",
        "text": text,
        "idempotencyKey": hashlib.sha1(text.encode("utf-8")).hexdigest(),
        "status": "queued",
        "approvalRequired": False,
        "bucket": "HOLDERS",
        "priority": 1,
        "mode": "queue_only",
        "surface": "x",
        "persona": "anti_hunter",
        "forceDailyPost": "holder_daily",
        "anchorUrl": "https://basescan.org/token/0xe2f3fae4bc62e21826018364aa30ae45d430bb07",
        "opportunityId": f"holder-distribution-{now_et.date().isoformat()}",
        "decisionId": f"holder-distribution-{now_et.date().isoformat()}-root",
        "adaptivityTelemetry": {
            "forceDailyPost": "holder_daily",
            "bucket": "HOLDERS",
            "contentClass": "holder_distribution_root",
        },
    }
    return append_public_intent(entry, source_job="holder_distribution_daily", default_priority=1, queue_path=QUEUE_PATH)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate holder distribution report + X post")
    parser.add_argument("--date", help="YYYY-MM-DD (defaults to today ET)")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.date:
        target_date = dt.date.fromisoformat(args.date)
    else:
        target_date = dt.datetime.now(TZ_ET).date()
    date_str = target_date.isoformat()

    token_info = fetch_token_info()
    basescan_holder_count = fetch_basescan_holder_count()
    holders = fetch_basescan_top_holders()
    report = build_report(date_str, token_info, holders, basescan_holder_count)
    stats = report["stats"]
    prev = load_last_history()
    markdown_path = write_markdown(report, date_str)

    history_entry = {
        **stats,
        "report_path": str(markdown_path.relative_to(ROOT)),
        "generated_at": iso_utc(),
    }
    append_history(history_entry)

    tweet_text = build_tweet(stats, prev)
    now_et = dt.datetime.now(TZ_ET)
    if args.dry_run:
        print(json.dumps({
            "stats": stats,
            "tweet": tweet_text,
            "report": str(markdown_path),
        }, indent=2))
        return

    queue_post(tweet_text, now_et)
    print(json.dumps({
        "status": "ok",
        "report": str(markdown_path),
        "tweet": tweet_text,
    }, indent=2))


if __name__ == "__main__":
    main()
