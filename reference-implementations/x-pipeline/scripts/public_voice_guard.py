#!/usr/bin/env python3
from __future__ import annotations
import json
from pathlib import Path
from typing import Optional

ROOT = Path('/Users/gwbox/.openclaw/workspace')
CFG = ROOT / 'playbooks' / 'public_voice_guardrails.json'


def load_cfg() -> dict:
    try:
        return json.loads(CFG.read_text(encoding='utf-8'))
    except Exception:
        return {}


def violation(text: str) -> Optional[str]:
    t = str(text or '').lower().strip()
    cfg = load_cfg()

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
