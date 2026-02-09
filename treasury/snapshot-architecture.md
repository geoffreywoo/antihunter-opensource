# Treasury snapshot architecture (fast + receipts-first)

## Problem

A “live” on-chain treasury page is easy to make slow and flaky:
- RPCs time out
- log scans are expensive
- pricing endpoints rate-limit
- serverless cold starts happen

But users want:
- fast page load
- up-to-date numbers
- receipts they can verify

## Pattern

Use a **static daily (or periodic) snapshot** as the default data source.

- The website serves `public/treasury.snapshot.json` from the CDN (fast, cacheable).
- A generator script recomputes the snapshot on a schedule.
- A live API endpoint can exist as a fallback/debug tool, but it’s not on the critical path.

This yields:
- consistent UX
- fewer production failures
- auditable history (snapshots can be committed)

## Data flow

1) **Collector** reads on-chain data (balances, swap flows, etc.)
2) **Enricher** adds pricing (e.g. spot price) and derived fields (FMV, PnL)
3) **Writer** outputs a stable JSON schema
4) Site loads snapshot first, then optionally refreshes from live API

## JSON shape (example)

The exact schema is project-specific, but a stable “row” model is key:

- `symbol`
- `name`
- `chain`
- `address` (or null for native)
- `balance`
- `entryDate`
- `costBasisEth`
- `costBasisUsd`
- `fmvUsd`
- `pnlUsd`

Also include metadata:
- `date`
- `updatedAt`
- `notes[]`

## Accounting stance

Keep the stance explicit:
- balances + spot FMV can update frequently
- entry date + cost basis are best-effort inference from observable flows
- the source of truth remains on-chain receipts (explorer links)

## Operational guidance

- Run snapshot updates on a schedule (cron/CI).
- If the generator fails, keep serving the last known-good snapshot.
- Prefer small, bounded log windows + explicit allowlists to avoid RPC rejection.

## Non-goals

- This pattern does not attempt perfect attribution in the presence of complex routing/bridges.
- It’s a pragmatic “make the treasury legible” approach, not institutional accounting.
