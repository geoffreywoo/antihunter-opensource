#!/usr/bin/env python3
"""Build shared X engagement dedupe sets + lightweight skip heuristics.

Outputs:
- memory/_x_engagement_dedupe_sets.json

Used by engagement workers before drafting replies.
"""

import json
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path('/Users/gwbox/.openclaw/workspace')
QUEUE = ROOT / 'memory' / 'public_intents_queue.jsonl'
STATE = ROOT / 'memory' / 'x_post_queue_state.json'
OUT = ROOT / 'memory' / '_x_engagement_dedupe_sets.json'


def nowz():
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def read_json(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding='utf-8', errors='replace'))
    except Exception:
        return default


def read_jsonl(path: Path):
    if not path.exists():
        return []
    out = []
    for ln in path.read_text(encoding='utf-8', errors='replace').splitlines():
        ln = ln.strip()
        if not ln:
            continue
        try:
            out.append(json.loads(ln))
        except Exception:
            pass
    return out


def is_media_only_text(text: str) -> bool:
    t = (text or '').strip()
    if not t:
        return True
    lower = t.lower()
    # short hype/no-context shouts -> skip by default
    if len(lower.split()) <= 3 and any(k in lower for k in ['$antihunter', '$anti', 'moon', 'pump', 'wen', 'gm']):
        return True
    return False


def main():
    q = read_jsonl(QUEUE)
    s = read_json(STATE, {'posted': {}, 'failed': {}})

    posted_reply_parent_ids = set()
    pending_reply_parent_ids = set()
    failed_permanent_parent_ids = set()
    failed_permanent_info = {}
    failed_reply_forbidden_parent_ids = set()
    failed_reply_forbidden_info = {}

    for _, v in (s.get('posted') or {}).items():
        if (v.get('kind') == 'reply') and v.get('parentTweetId'):
            posted_reply_parent_ids.add(str(v.get('parentTweetId')))

    for it in q:
        if str(it.get('surface') or 'x').lower() != 'x':
            continue
        if it.get('kind') != 'reply' and it.get('mode') != 'reply':
            continue
        st = str(it.get('status') or '').lower()
        if st == 'posted':
            continue
        pt = it.get('parentTweetId')
        if pt:
            pending_reply_parent_ids.add(str(pt))

    for _, v in (s.get('failed') or {}).items():
        pt = v.get('parentTweetId')
        hs = v.get('httpStatus')
        if not pt or hs not in (401, 403, 404):
            continue
        pt = str(pt)
        reason = str(v.get('reason') or '').lower()
        # X API reply restriction is effectively permanent for replies unless mentioned/engaged.
        if hs == 403 and ('reply to this conversation is not allowed' in reason or 'not been mentioned or otherwise engaged' in reason):
            failed_reply_forbidden_parent_ids.add(pt)
            failed_reply_forbidden_info[pt] = {'httpStatus': hs, 'tsEt': v.get('tsEt')}
            continue
        failed_permanent_parent_ids.add(pt)
        failed_permanent_info[pt] = {'httpStatus': hs, 'tsEt': v.get('tsEt')}

    out = {
        'generatedAt': nowz(),
        'postedReplyParentIds': sorted(posted_reply_parent_ids),
        'pendingReplyParentIds': sorted(pending_reply_parent_ids),
        'failedPermanentParentIds': sorted(failed_permanent_parent_ids),
        'failedPermanentInfo': failed_permanent_info,
        'failedReplyForbiddenParentIds': sorted(failed_reply_forbidden_parent_ids),
        'failedReplyForbiddenInfo': failed_reply_forbidden_info,
        'preflightRules': {
            'skip_media_only_or_contextless': True,
            'skip_short_hype': True,
        }
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')

    print(json.dumps({
        'ok': True,
        'out': str(OUT),
        'counts': {
            'postedReplyParentIds': len(out['postedReplyParentIds']),
            'pendingReplyParentIds': len(out['pendingReplyParentIds']),
            'failedPermanentParentIds': len(out['failedPermanentParentIds']),
            'failedReplyForbiddenParentIds': len(out['failedReplyForbiddenParentIds'])
        }
    }, indent=2))


if __name__ == '__main__':
    main()
