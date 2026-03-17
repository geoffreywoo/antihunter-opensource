#!/usr/bin/env python3
from __future__ import annotations

import json
import hashlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict

ROOT = Path('/Users/gwbox/.openclaw/workspace')
QUEUE = ROOT / 'memory' / 'public_intents_queue.jsonl'

REQUIRED_BASE = [
    'surface', 'status', 'mode', 'text', 'persona'
]

VALID_KINDS = {'root', 'reply', 'quote'}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def _sha1(s: str) -> str:
    return hashlib.sha1(s.encode('utf-8')).hexdigest()


def normalize_intent(intent: Dict[str, Any], *, source_job: str, default_priority: int = 3) -> Dict[str, Any]:
    out = dict(intent)
    out['surface'] = str(out.get('surface') or 'x').lower()
    out['status'] = str(out.get('status') or 'queued').lower()
    out['mode'] = str(out.get('mode') or 'queue_only').lower()
    out['persona'] = str(out.get('persona') or 'anti_hunter')
    out['sourceJob'] = str(out.get('sourceJob') or source_job)
    out['priority'] = int(out.get('priority') if out.get('priority') is not None else default_priority)
    out['tsEt'] = str(out.get('tsEt') or now_iso())

    kind = str(out.get('kind') or out.get('mode') or '').lower()
    if kind == 'queue_only':
        kind = 'root'
    out['kind'] = kind

    parent = str(out.get('parentTweetId') or '')
    text = str(out.get('text') or '')
    if not out.get('idempotencyKey'):
        out['idempotencyKey'] = _sha1(f"{kind}:{parent}:{text}")

    return out


def validate_intent(intent: Dict[str, Any]) -> None:
    for k in REQUIRED_BASE:
        if not intent.get(k):
            raise ValueError(f"missing required field: {k}")

    kind = str(intent.get('kind') or '').lower()
    if kind not in VALID_KINDS:
        raise ValueError(f"invalid kind: {kind}")

    if kind == 'reply' and not (intent.get('parentTweetId') or intent.get('parentIdempotencyKey')):
        raise ValueError('reply missing parentTweetId/parentIdempotencyKey')
    if kind == 'quote' and not intent.get('parentTweetId'):
        raise ValueError('quote missing parentTweetId')

    if not intent.get('sourceJob'):
        raise ValueError('missing sourceJob')
    if not intent.get('idempotencyKey'):
        raise ValueError('missing idempotencyKey')


def append_intent(intent: Dict[str, Any], *, source_job: str, default_priority: int = 3, queue_path: Path = QUEUE) -> Dict[str, Any]:
    row = normalize_intent(intent, source_job=source_job, default_priority=default_priority)
    validate_intent(row)
    queue_path.parent.mkdir(parents=True, exist_ok=True)
    with queue_path.open('a', encoding='utf-8') as f:
        f.write(json.dumps(row, ensure_ascii=False) + '\n')
    return row
