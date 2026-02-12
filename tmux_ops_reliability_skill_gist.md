# tmux Ops Reliability Skill (OpenClaw)

## Why this exists
OpenClaw cron and browser-control paths can be flaky under load (`cron run/status` hangs, gateway RPC timeouts, browser `act` stalls).  
This skill adds an **operator control plane** around existing jobs so debugging is persistent, parallel, and recoverable.

## Core design
- Keep production cron logic unchanged.
- Add a persistent tmux supervision layer for observability + fast intervention.
- Add deterministic doctor/recover scripts for repeatable triage.
- Preserve artifacts (logs, run transcripts) for postmortems.

## Components shipped

### 1) `scripts/tmux_ops.sh`
Starts a named tmux session (`oc-ops`) with dedicated windows:

1. `status`
   - loops `openclaw gateway status`
   - loops `openclaw cron list`
2. `runs`
   - watches selected critical jobs from `memory/ops_critical_cron_jobs.txt`
   - tails recent `openclaw cron runs` output
3. `browser`
   - loops `openclaw status`
   - tails gateway log `/tmp/openclaw/openclaw-YYYY-MM-DD.log`
4. `incidents`
   - filters key failure signatures:
     - `gateway timeout`
     - `OpenClaw browser control service`
     - `timed out after 20000ms`
     - `EPIPE`
     - `Non-fatal unhandled rejection`
5. `adhoc`
   - interactive shell for manual fixes / ad-hoc runs

### 2) `scripts/cron_run_now_safe.sh`
Ad-hoc run wrapper with macOS-safe timeout and persistent logs.

- command: `openclaw cron run <jobId>`
- timeout guard: perl alarm wrapper
- artifacts: `memory/cron_run_now/<jobId>_<timestamp>.log`

### 3) `scripts/openclaw_doctor.sh`
One-shot health snapshot:
- gateway status
- `openclaw status` RPC sanity
- timeout-guarded cron list
- browser status
- recent error signatures from gateway logs

### 4) `scripts/openclaw_recover.sh`
Conservative recovery routine:
1. `openclaw gateway restart`
2. browser profile bring-up (`openclaw browser start --profile openclaw`)
3. post-recovery verification (`openclaw gateway status`, `openclaw status`)

## Reliability principles
- **Supervision beats guesswork**: always keep live status/runs/logs panes up.
- **Fail fast with evidence**: save logs on every ad-hoc trigger.
- **Bounded recovery**: single restart cycle before re-evaluation.
- **No silent drift**: keep critical-job watchlist explicit in a tracked file.

## Quickstart
```bash
brew install tmux
cd /Users/gwbox/.openclaw/workspace
scripts/tmux_ops.sh start
scripts/tmux_ops.sh attach
```

Run ad-hoc safely:
```bash
scripts/cron_run_now_safe.sh <jobId> 180
```

Doctor + recover:
```bash
scripts/openclaw_doctor.sh
scripts/openclaw_recover.sh
```

## What this does NOT do
- It does **not** eliminate underlying gateway/cron/browser bugs.
- It does make diagnosis, recovery, and iterative hardening significantly faster.

## Suggested next upgrades
- Auto-write incident records to `memory/incidents.jsonl` from doctor signatures.
- Add a stale-mutex breaker policy with explicit approval gates.
- Add structured metrics export (run latency, timeout rate, restart rate) for trend analysis.
