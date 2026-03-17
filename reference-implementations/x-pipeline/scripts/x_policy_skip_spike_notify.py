#!/usr/bin/env python3
import json
from pathlib import Path
from datetime import datetime, timezone

ROOT = Path('/Users/gwbox/.openclaw/workspace')
RUNS = ROOT / 'memory' / 'x_post_queue_runs.jsonl'
STATE = ROOT / 'memory' / 'x_policy_skip_spike_notify_state.json'


def load_last_spike():
    if not RUNS.exists():
      return None
    last = None
    for line in RUNS.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            r = json.loads(line)
        except Exception:
            continue
        note = str(r.get('note') or '')
        if not note.startswith('policy_skip_spike:'):
            continue
        try:
            n = int(note.split(':', 1)[1])
        except Exception:
            n = None
        last = {
            'tsEt': r.get('tsEt'),
            'policySkips': n,
            'note': note,
            'reasons': r.get('failedOrSkipped', []),
        }
    return last


def load_state():
    if not STATE.exists():
        return {}
    try:
        return json.loads(STATE.read_text())
    except Exception:
        return {}


def save_state(obj):
    STATE.write_text(json.dumps(obj, indent=2) + '\n')


def top_reasons(rows, limit=3):
    counts = {}
    for x in rows or []:
        reason = str(x.get('reason') or '')
        if not reason:
            continue
        counts[reason] = counts.get(reason, 0) + 1
    pairs = sorted(counts.items(), key=lambda kv: kv[1], reverse=True)
    return pairs[:limit]


def main():
    spike = load_last_spike()
    if not spike:
        print('NOOP: no spike')
        return

    state = load_state()
    last_sent_ts = state.get('lastSentTsEt')
    if last_sent_ts == spike.get('tsEt'):
        print('NOOP: already sent')
        return

    reasons = top_reasons(spike.get('reasons', []))
    reasons_txt = '; '.join([f"{k} x{v}" for k, v in reasons]) if reasons else 'none'
    msg = (
        f"[x-policy-spike]: policy_skip_spike={spike.get('policySkips')} at {spike.get('tsEt')}\n"
        f"top reasons: {reasons_txt}\n"
        f"action: posting not paused (alert-only mode)."
    )

    print(msg)
    state['lastSentTsEt'] = spike.get('tsEt')
    state['updatedAt'] = datetime.now(timezone.utc).isoformat()
    save_state(state)


if __name__ == '__main__':
    main()
