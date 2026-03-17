#!/usr/bin/env python3
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Dict, Optional

ROOT = Path('/Users/gwbox/.openclaw/workspace')
GUARDS = ROOT / 'playbooks' / 'public_voice_guardrails.json'


def _load() -> dict:
    try:
        return json.loads(GUARDS.read_text(encoding='utf-8'))
    except Exception:
        return {}


def _token_set(text: str) -> set[str]:
    clean = ''.join(ch.lower() if ch.isalnum() or ch.isspace() else ' ' for ch in str(text or ''))
    return {w for w in clean.split() if len(w) >= 4}


def jaccard(a: str, b: str) -> float:
    sa, sb = _token_set(a), _token_set(b)
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / max(1, len(sa | sb))


def voice_violation(text: str) -> Optional[str]:
    t = str(text or '').lower().strip()
    cfg = _load()

    if any(t.startswith(x) for x in cfg.get('metaLabelPrefixes', [])):
        return 'meta_label_leak'
    if any(x in t for x in cfg.get('metaLabelInline', [])):
        return 'meta_label_leak'
    if any(x in t for x in cfg.get('selfOwnPhrases', [])):
        return 'self_own_pattern'

    hedge_hits = sum(1 for x in cfg.get('hedgePhrases', []) if x in t)
    if hedge_hits >= 2:
        return 'hedge_tone_blocked'

    if any(x in t for x in cfg.get('genericFillerPhrases', [])):
        return 'generic_pattern'

    return None


def validate_public_text(text: str, *, min_len: int = 40, max_len: int = 420) -> Optional[str]:
    lo = str(text or '').strip().lower()
    vr = voice_violation(lo)
    if vr:
        return vr
    if len(lo) < min_len:
        return 'too_short'
    if len(lo) > max_len:
        return 'too_long'
    if any(x in lo for x in ['@bankrbot', 'swap ', 'buy ', 'sell ', 'transfer ', 'send ', 'mint ']):
        return 'forbidden_money_command'
    return None


def voice_checksum(text: str) -> Dict[str, Any]:
    t = str(text or '').lower()
    thesis = any(k in t for k in [' is ', ' are ', 'will ', 'must ', 'only '])
    mechanism = any(k in t for k in ['because', 'via ', 'through', 'by ', 'so that'])
    implication = any(k in t for k in ['so ', 'therefore', 'next', 'this means', 'we will'])
    passed = thesis and mechanism and implication
    return {
        'thesis': thesis,
        'mechanism': mechanism,
        'implication': implication,
        'passed': passed,
    }
