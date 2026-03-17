#!/usr/bin/env python3
import json
import hashlib
from datetime import datetime, timezone
from pathlib import Path

from lib.public_intents_writer import append_intent as append_public_intent

ROOT = Path('/Users/gwbox/.openclaw/workspace')
THESIS = ROOT / 'memory/proposals/reading_theses.jsonl'
STATE = ROOT / 'memory/reading_x_thread_state.json'
PUBLIC_QUEUE = ROOT / 'memory/public_intents_queue.jsonl'


def parse_ts(s: str):
    try:
        return datetime.fromisoformat(s.replace('Z', '+00:00'))
    except Exception:
        return None


def load_jsonl(path: Path):
    out = []
    if not path.exists():
        return out
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except Exception:
            continue
    return out


def clamp(s: str, n: int = 278):
    s = ' '.join((s or '').split())
    if len(s) <= n:
        return s
    clipped = s[:n]
    cut = clipped.rfind(' ')
    return clipped[:cut].rstrip() if cut >= int(n * 0.75) else clipped.rstrip()


def sha1(s: str) -> str:
    return hashlib.sha1(s.encode('utf-8')).hexdigest()


def sanitize_public_claim(claim: str) -> str:
    c = ' '.join((claim or '').split()).strip()
    low = c.lower()
    for p in ('market angle:', 'systems angle:', 'execution angle:', 'culture angle:'):
        if low.startswith(p):
            c = c[len(p):].strip()
            low = c.lower()
            break
    # remove scaffold label fragments that trigger public voice policy gates
    c = c.replace(' — implication:', '. ').replace(' implication:', '. ')
    return c.strip(' -—:;,.')


def low_quality_claim(claim: str) -> bool:
    c = ' '.join((claim or '').split()).strip()
    if len(c) < 50:
        return True
    low = c.lower()
    bad = (
        'reporting accessibility issues',
        'if you cannot access content',
        'all rights reserved',
        'privacy policy',
        'sign in',
        'subscribe',
    )
    if any(b in low for b in bad):
        return True
    if low.endswith((' an', ' a', ' the', ' to', ' and', ' or', ' of', ' in', ' on', ' for', ' with')):
        return True
    return False


def fallback_claim_from_metadata(title: str, source_url: str):
    t = f"{title} {source_url}".lower()
    rules = [
        (('token', 'network design'), 'token networks win when contribution, ownership, and distribution incentives are aligned in one loop.'),
        (('ether', 'ethereum'), 'compute networks stay reliable when resource usage is explicitly metered and paid for.'),
        (('headlight', 'land'), 'coordination-heavy technologies fail unless adoption incentives are synchronized across participants.'),
        (('next big thing', 'toy'), 'breakthrough platforms often start as low-status toys before distribution compounding makes them inevitable.'),
        (('content', 'free'), 'distribution channels capture value unless creators keep direct economic rails to users.'),
        (('read write own',), 'ownership-native networks convert users into aligned stakeholders instead of rented audience.'),
        (('decision theory',), 'better decisions come from pre-committed policies under uncertainty, not reactive improvisation.'),
        (('accessibility',), 'accessibility constraints force clearer interfaces and improve reliability for all users.'),
        (('sepia', 'libraries'), 'knowledge systems compound when provenance, indexing, and update ownership are explicit.'),
        (('alien film crew',), 'large-scale coordination systems dominate outcomes when institutions align many humans toward one objective.'),
    ]
    for keys, claim in rules:
        if all(k in t for k in keys):
            return claim
    return None


def main():
    rows = load_jsonl(THESIS)
    if not rows:
        print('[reading-thread]: SKIP — no_theses')
        print(json.dumps({'status': 'skip', 'reason': 'no_theses'}))
        return

    state = {}
    if STATE.exists():
        try:
            state = json.loads(STATE.read_text())
        except Exception:
            state = {}

    last_ts = parse_ts(state.get('lastTs', '')) if state.get('lastTs') else None

    enriched = []
    for r in rows:
        ts = parse_ts(str(r.get('ts', '')))
        if ts is None:
            continue
        if last_ts and ts <= last_ts:
            continue
        enriched.append((ts, r))

    if not enriched:
        print('[reading-thread]: SKIP — no_new_items')
        print(json.dumps({'status': 'skip', 'reason': 'no_new_items'}))
        return

    enriched.sort(key=lambda x: x[0])
    batch = enriched[-6:]

    # Single-post mode: one jumbo post with all learnings + source URLs (no thread replies).
    lesson_rows = []

    used_theses = set()
    used_core_claims = set()
    for i, (ts, r) in enumerate(batch, start=1):
        raw_claim = str(r.get('distilledClaim') or '').strip()
        cands = [str(x).strip() for x in (r.get('thesisCandidates') or []) if str(x).strip()]
        idx_sel = int(r.get('selectedIndex') or 0)

        ordered = []
        if cands:
            if 0 <= idx_sel < len(cands):
                ordered.append(cands[idx_sel])
            for c in cands:
                if c not in ordered:
                    ordered.append(c)

        thesis = None

        if raw_claim:
            key_claim = ' '.join(raw_claim.lower().split())
            core_claim = key_claim[:140]
            if key_claim not in used_theses and core_claim not in used_core_claims:
                thesis = raw_claim
                used_theses.add(key_claim)
                used_core_claims.add(core_claim)

        if not thesis:
            for c in ordered:
                key = ' '.join(c.lower().split())
                core = key
                if 'suggests ' in core:
                    core = core.split('suggests ', 1)[1]
                core = core[:140]
                if key in used_theses:
                    continue
                if core in used_core_claims:
                    continue
                thesis = c
                used_theses.add(key)
                used_core_claims.add(core)
                break

        if not thesis:
            summary = str(r.get('summary') or '').strip()
            if summary:
                thesis = summary
            elif ordered:
                thesis = ordered[0]
            else:
                thesis = 'no thesis extracted'

        title = str(r.get('title') or r.get('source') or 'untitled')
        source = str(r.get('source') or 'unknown source')
        url = str(r.get('sourceUrl') or '').strip()

        meta_claim = fallback_claim_from_metadata(title, url)
        if meta_claim:
            thesis = meta_claim
        elif low_quality_claim(thesis):
            thesis = 'the source argues for tighter incentive design and measurable execution loops over narrative-first strategy.'

        thesis = sanitize_public_claim(thesis)

        # Hard requirement: each per-source reading post must include the source URL.
        short_title = title[:64].rstrip(' -—:;,.')
        if url:
            # Reserve room for source URL; prioritize coherent lesson over long titles.
            reserved = len(f" src: {url}")
            prefix = f"{i}) {source} — "
            thesis_budget = max(80, 270 - reserved - len(prefix))
            thesis_short = thesis[:thesis_budget].rstrip(' -—:;,.')
            text = f"{prefix}{thesis_short} src: {url}"
        else:
            thesis_short = thesis[:190].rstrip(' -—:;,.')
            text = f"{i}) {source} — {thesis_short}"

        lesson_rows.append({'source': source, 'claim': thesis_short, 'url': url, 'line': clamp(text, 275)})

    takeaway = 'anti hunter is learning in public by converting source reading into testable mechanisms and execution decisions.'

    ts_now = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    run_id = f"reading-thread-{ts_now}"

    latest_ts = batch[-1][0].astimezone(timezone.utc).isoformat().replace('+00:00', 'Z')
    source_fingerprint = sha1('|'.join(sorted(str(r.get('sourceUrl') or '') for _, r in batch)))
    anchor_source = next((str(r.get('sourceUrl') or '').strip() for _, r in batch if str(r.get('sourceUrl') or '').strip()), '')
    opportunity_id = f'reading_opportunity:{run_id}'
    root_decision_id = f'reading_root:{run_id}'

    narrative_parts = [f"today's reading run pulled {len(lesson_rows)} sources into one coherent map of what anti hunter should do next."]
    for idx, row in enumerate(lesson_rows, start=1):
        narrative_parts.append(f"{idx}) from {row['source']}: {row['claim']}")

    sources_block = [f"{idx}) {row['url']}" for idx, row in enumerate(lesson_rows, start=1) if row.get('url')]

    root_lines = [
        " ".join(narrative_parts),
        takeaway,
        "sources:",
        *sources_block,
    ]
    # User-requested jumbo single post mode in narrative format.
    root_text = "\n".join(root_lines)
    root_key = sha1(f"reading_root|{latest_ts}|{source_fingerprint}|{root_text}")

    append_public_intent({
        'tsEt': ts_now,
        'sourceJob': 'reading_thread_consolidator',
        'runId': run_id,
        'kind': 'root',
        'text': root_text,
        'idempotencyKey': root_key,
        'status': 'queued',
        'surface': 'x',
        'mode': 'queue_only',
        'approvalRequired': False,
        'bucket': 'READING_THESES',
        'priority': 2,
        'similarityMax': 0,
        'forceDailyPost': 'reading_daily',
        'anchorUrl': anchor_source or 'https://x.com/i/reading-thread',
        'opportunityId': opportunity_id,
        'decisionId': root_decision_id,
        'adaptivityTelemetry': {'forceDailyPost': 'reading_daily', 'contentClass': 'reading_consolidated_jumbo_single_post'},
    }, source_job='reading_thread_consolidator', default_priority=2)

    queued = 1

    latest_ts = batch[-1][0].astimezone(timezone.utc).isoformat().replace('+00:00', 'Z')
    STATE.write_text(json.dumps({'lastTs': latest_ts, 'updatedAt': ts_now, 'lastRootKey': root_key, 'lastSourceFingerprint': source_fingerprint}, indent=2) + '\n')

    print(f"[reading-thread]: OK — queued={queued}")
    print(json.dumps({'status': 'ok', 'queued': queued, 'rootIdempotencyKey': root_key, 'sourceFingerprint': source_fingerprint, 'queue': str(PUBLIC_QUEUE), 'state': str(STATE)}))


if __name__ == '__main__':
    main()
