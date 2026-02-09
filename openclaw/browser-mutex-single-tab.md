# Browser mutex + single-tab protocol (OpenClaw)

Goal: keep browser automation deterministic when multiple runs (cron + ad-hoc) can overlap.

This is a **pattern**, not a turnkey exploit script:
- no cookies
- no auth tokens
- no private endpoints
- no machine-specific paths

## The failure modes this prevents

1) **Concurrency collisions**: two jobs click/type in the same window.
2) **Tab drift**: actions land on the wrong tab/target.
3) **Stale sessions**: a run crashes and leaves the system “locked”.
4) **Selector flake masking**: flaky behavior looks like “selectors broke” but is actually focus/concurrency.

## Protocol (high level)

### 0) Shared lock file

Use a single JSON lock file that all runs respect.

Recommended fields:
- `label`: human-readable run id
- `startedAtMs`: unix millis

Rules:
- If lock exists and is **fresh** → wait/backoff then **skip** (do not fight).
- If lock exists and is **stale** (e.g. >5 minutes) → takeover is allowed.

### 1) Backoff schedule (don’t thrash)

A simple backoff schedule works well:
- wait 60s
- then 120s
- then 240s
- then skip

### 2) Enforce single-tab policy

After acquiring the lock:
- enumerate all open tabs/pages
- pick one canonical tab (prefer the most recently active)
- close all other tabs

This makes subsequent actions far more stable, because `targetId` ambiguity disappears.

### 3) Do the work (and keep it idempotent)

Keep your run **restart-safe**:
- read → decide → write
- persist state after each external side effect (e.g. after each X reply)

### 4) Always release the lock

Release the lock in a `finally`/defer block.

If a run hard-crashes, the stale lock rule is the recovery path.

## Minimal pseudo-code

```js
// acquireLock(lockPath, {label, staleMs, backoffMsList})
// enforceSingleTab(browser)
// releaseLock(lockPath)

await acquireLock(LOCK_PATH, {
  label: 'x_mentions_hourly',
  staleMs: 5 * 60_000,
  backoffMsList: [60_000, 120_000, 240_000],
});

try {
  await enforceSingleTab(browser);
  // ...run automation...
} finally {
  await releaseLock(LOCK_PATH);
}
```

## Practical notes

- Prefer **one browser profile** per system (a managed profile) to reduce “who’s logged in?” ambiguity.
- Treat “browser down” as a first-class case (skip + alert) rather than retrying forever.
- When debugging: if snapshots work but `click/type` hang, it’s often a browser service flake — restart the service once, then stop.

## Related

- X reply safety invariant: see `openclaw/x-reply-invariant.md`
