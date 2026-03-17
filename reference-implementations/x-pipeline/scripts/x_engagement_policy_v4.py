#!/usr/bin/env python3
import json
import re
import hashlib
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path('/Users/gwbox/.openclaw/workspace')
MEM = ROOT / 'memory'
CONTEXT = MEM / 'x_engagement_context.jsonl'
STATE = MEM / 'x_post_queue_state.json'
QUEUE = MEM / 'public_intents_queue.jsonl'
CREATORS = MEM / 'x_creator_context.jsonl'
OUT = MEM / 'x_engagement_policy_decisions.jsonl'
MENTIONS_LOG = MEM / 'x_mentions_log.jsonl'
MENTIONS_DAILY = MEM / 'x_mentions_topics_daily.json'

SELF_HANDLE = 'antihunterai'
SIGIL_TERMS = ('sigil', 'anti hunter sigil', 'antihunter sigil')
IRL_TERMS = ('irl', 'in real life', 'street', 'wall', 'spray', 'sticker', 'tattoo', 'shirt', 'hoodie', 'neighborhood', 'city')
PROOF_TERMS = ('proof', 'proof video', 'proof pic', 'video proof', 'wallet')
PILGRIMAGE_TERMS = ('pilgrimage', 'brought to irl', 'brought irl', 'in the wild', 'street proof')
ANTIHUNTER_TERMS = ('@antihunterai', 'antihunter', 'anti hunter', '$antihunter')
AI_TERMS = ('ai generated', 'midjourney', 'stable diffusion', 'sora', 'render', 'generated image', 'synthetic')
MONEY_TERMS = ('send me', 'give me money', 'pay me', 'tip me', 'bounty now', '@bankrbot', 'bankrbot')
SCAM_TERMS = (
    'airdrop', 'claim now', 'mint now', 'free mint', 'wl spot', 'whitelist',
    'presale', 'pump', '100x', 'contract address', 'ca:', 'dexscreener',
    'connect wallet', 'verify wallet', 'drain', 'launching now', 'token launch',
    'drop is live', 'holders only', 'giveaway', 'claim link', 'check wallet',
    'antihunterevent.org'
)

SCAM_REGEX = [
    re.compile(r'\bclaim\b.{0,24}\blink\b', re.I),
    re.compile(r'\bcheck\b.{0,12}\bwallet\b', re.I),
    re.compile(r'\bverify\b.{0,16}\bwallet\b', re.I),
    re.compile(r'\bconnect\b.{0,16}\bwallet\b', re.I),
    re.compile(r'\bdrop\b.{0,24}\b(claim|wallet|link)\b', re.I),
    re.compile(r'\bholders?\b.{0,20}\bevent\b.{0,24}\bgrab\b', re.I),
]


def load_jsonl(path: Path):
    rows = []
    if not path.exists():
        return rows
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        try:
            rows.append(json.loads(line))
        except Exception:
            pass
    return rows


def parse_dt(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(str(s).replace('Z', '+00:00'))
    except Exception:
        return None


def tweet_id_from_url(url: str):
    m = re.search(r'/status/(\d+)', str(url or ''))
    return m.group(1) if m else None


def canonical_parent_tweet_id(row):
    """Canonical parent key across workflows: prefer explicit id, fallback to URL extraction."""
    pid = str((row or {}).get('parentTweetId') or '').strip()
    if pid:
        return pid
    for k in ('parentUrl', 'anchorUrl', 'url'):
        t = tweet_id_from_url((row or {}).get(k))
        if t:
            return t
    return ''


def contains_any(t: str, terms):
    x = (t or '').lower()
    return any(k in x for k in terms)


def scam_risk(t: str):
    x = str(t or '').lower()
    score = 0

    # lexical signals
    term_hits = sum(1 for k in SCAM_TERMS if k in x)
    score += min(term_hits, 3)

    # semantic-ish pattern bundles (less brittle than exact word matching)
    if any(rx.search(x) for rx in SCAM_REGEX):
        score += 2

    has_link = ('http://' in x) or ('https://' in x) or ('t.co/' in x)
    link_count = x.count('http://') + x.count('https://') + x.count('t.co/')
    has_wallet = any(k in x for k in ('wallet', 'connect', 'verify'))
    has_claim = any(k in x for k in ('claim', 'drop', 'airdrop', 'mint', 'grab'))

    if has_link and has_wallet:
        score += 2
    if has_link and has_claim:
        score += 1
    if has_wallet and has_claim:
        score += 2
    # common low-detail bait shape: celebration + multiple links + "grab" language.
    if link_count >= 2 and ('grab' in x or 'holders event' in x):
        score += 2

    # clamp
    score = min(score, 10)
    return {
        'score': score,
        'suspected': score >= 3,
        'high': score >= 5,
    }



def classify_request_type(text: str) -> str:
    t = str(text or '').lower()
    if any(k in t for k in ('?', 'how', 'why', 'what', 'when', 'where', 'can you', 'could you')):
        return 'question'
    if any(k in t for k in ('please', 'can you', 'could you', 'would you', 'need', 'help')):
        return 'request'
    if any(k in t for k in ('scam', 'fake', 'rug', 'airdrop', 'claim', 'wallet')):
        return 'risk_alert'
    if any(k in t for k in ('great', 'love', 'bullish', 'awesome', 'based')):
        return 'support'
    if any(k in t for k in ('wrong', 'bad', 'terrible', 'scam project', 'fraud')):
        return 'criticism'
    return 'comment'


def extract_topic_tags(text: str) -> list:
    t = str(text or '').lower()
    tags = []
    rule_map = [
        ('treasury', ('treasury', 'wallet', 'balance', 'asset', 'allocation')),
        ('tokenomics', ('$antihunter', 'tokenomics', 'staking', 'buyback', 'supply', 'holders')),
        ('product', ('product', 'feature', 'launch', 'automation', 'agent', 'workflow')),
        ('reading', ('reading', 'thesis', 'learn', 'book', 'source', 'article')),
        ('shipping', ('shipping', 'receipt', 'changelog', 'deploy', 'shipped')),
        ('roadmap', ('roadmap', 'next', 'plan', 'milestone')),
        ('sigil', ('sigil', 'irl', 'proof', 'pilgrimage')),
        ('governance', ('policy', 'rule', 'governance', 'decision')),
    ]
    for tag, terms in rule_map:
        if any(k in t for k in terms):
            tags.append(tag)
    return tags or ['general']


def load_jsonl(path: Path):
    rows = []
    if not path.exists():
        return rows
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        try:
            rows.append(json.loads(line))
        except Exception:
            continue
    return rows


def append_mentions_log(decisions):
    # Keep durable mention intelligence locally for frequent-request analytics.
    existing = load_jsonl(MENTIONS_LOG)
    seen = set((str(r.get('tweetId') or ''), str(r.get('loggedAt') or '')[:10]) for r in existing)

    new_rows = []
    for d in decisions:
        if not d.get('mentionsAntiHunterHandle'):
            continue
        tweet_id = str(d.get('parentTweetId') or '').strip()
        if not tweet_id:
            continue
        text = str(d.get('contextText') or '')
        day_key = str(d.get('tsEt') or '')[:10]
        k = (tweet_id, day_key)
        if k in seen:
            continue
        row = {
            'loggedAt': d.get('tsEt'),
            'tweetId': tweet_id,
            'authorUsername': d.get('authorUsername'),
            'text': text[:600],
            'requestType': classify_request_type(text),
            'topicTags': extract_topic_tags(text),
            'mentionsAntiHunterHandle': bool(d.get('mentionsAntiHunterHandle')),
            'decisionAction': d.get('action'),
            'decisionReason': d.get('reason'),
            'mustRespond': bool(d.get('mustRespond')),
            'source': 'x_engagement_policy_v4',
        }
        new_rows.append(row)
        seen.add(k)

    if new_rows:
        with MENTIONS_LOG.open('a') as f:
            for r in new_rows:
                f.write(json.dumps(r, ensure_ascii=False) + '\n')

    # Daily aggregate for quick operator view.
    rows = load_jsonl(MENTIONS_LOG)[-5000:]
    by_day = {}
    for r in rows:
        day = str(r.get('loggedAt') or '')[:10]
        if not day:
            continue
        ent = by_day.setdefault(day, {'mentions': 0, 'requestTypes': {}, 'topicTags': {}, 'actions': {}, 'topQuestions': []})
        ent['mentions'] += 1
        rt = str(r.get('requestType') or 'unknown')
        ent['requestTypes'][rt] = int(ent['requestTypes'].get(rt, 0)) + 1
        act = str(r.get('decisionAction') or 'none')
        ent['actions'][act] = int(ent['actions'].get(act, 0)) + 1
        for tag in (r.get('topicTags') or []):
            ent['topicTags'][tag] = int(ent['topicTags'].get(tag, 0)) + 1

    MENTIONS_DAILY.write_text(json.dumps({'updatedAt': datetime.now().isoformat(), 'days': by_day}, indent=2) + '\n')
    return len(new_rows)

def classify_media(ctx):
    text = str(ctx.get('text') or '').lower()
    has_media = bool(ctx.get('hasMedia'))
    media_types = [str(x).lower() for x in (ctx.get('mediaTypes') or [])]
    has_image_or_video = has_media and any(mt in ('photo', 'video', 'animated_gif') for mt in media_types)

    sigil_mentioned = contains_any(text, SIGIL_TERMS) or 'sigil' in text
    irl_mentioned = contains_any(text, IRL_TERMS)
    proof_mentioned = contains_any(text, PROOF_TERMS)
    pilgrimage_mentioned = contains_any(text, PILGRIMAGE_TERMS)
    antihunter_mentioned = contains_any(text, ANTIHUNTER_TERMS)
    ai_markers = contains_any(text, AI_TERMS)

    # detection split:
    # - sigil_or_equivalent: broad for engagement handling
    # - reward eligibility is handled downstream with stricter sigil requirement
    sigil_or_equivalent = bool(sigil_mentioned or (has_image_or_video and antihunter_mentioned and (proof_mentioned or pilgrimage_mentioned)))

    if not has_image_or_video:
        # still surface sigil claims even without media so they can be processed and denied IRL credit explicitly.
        return 'none', sigil_or_equivalent

    if ai_markers:
        return 'synthetic', sigil_or_equivalent

    # euphoric acceptance calibration: media-backed plausible IRL sigil gets verified by default.
    if sigil_or_equivalent and has_image_or_video and not ai_markers:
        return 'verified_irl', True

    if sigil_or_equivalent and irl_mentioned:
        return 'verified_irl', True

    if sigil_or_equivalent:
        return 'uncertain', True

    return 'none', False




def _clamp(v, lo, hi):
    return max(lo, min(hi, v))


def _deterministic_unit(seed: str):
    h = hashlib.sha256(seed.encode('utf-8')).hexdigest()
    return int(h[:12], 16) / float(16**12 - 1)


def compute_reward_profile(ctx, parent_tweet_id: str):
    metrics = ctx.get('publicMetrics') or {}
    likes = int(metrics.get('like_count') or ctx.get('likeCount') or 0)
    views = int(metrics.get('impression_count') or ctx.get('viewCount') or 0)
    media_types = [str(x).lower() for x in (ctx.get('mediaTypes') or [])]
    text = str(ctx.get('text') or '').lower()

    # Performance base (0..100m): primary by views, secondary by likes.
    views_norm = _clamp(views / 1_000_000.0, 0.0, 1.0)
    likes_norm = _clamp(likes / 20_000.0, 0.0, 1.0)
    perf_weight = _clamp(0.75 * views_norm + 0.25 * likes_norm, 0.0, 1.0)
    base_reward = int(round(perf_weight * 100_000_000))

    # Creativity signal + variable lottery bonus (0..20m).
    creativity = 0.0
    if 'video' in media_types:
        creativity += 0.45
    elif 'photo' in media_types or 'animated_gif' in media_types:
        creativity += 0.30
    if any(k in text for k in ('street', 'wall', 'city', 'neighborhood', 'public', 'irl', 'pilgrimage')):
        creativity += 0.25
    if 'sigil' in text:
        creativity += 0.15
    if len(text) >= 180:
        creativity += 0.15
    creativity = _clamp(creativity, 0.0, 1.0)

    seed = parent_tweet_id or str(ctx.get('anchorUrl') or '')
    roll_a = _deterministic_unit(seed + ':bonus:a')
    roll_b = _deterministic_unit(seed + ':bonus:b')

    jackpot_prob = 0.10 + (0.40 * creativity)
    jackpot_hit = roll_a < jackpot_prob

    if jackpot_hit:
        bonus_reward = int(round((0.35 + 0.65 * roll_b) * 20_000_000 * max(0.35, creativity)))
    else:
        bonus_reward = int(round(roll_b * 0.20 * 20_000_000 * max(0.20, creativity)))

    bonus_reward = int(_clamp(bonus_reward, 0, 20_000_000))
    suggested = int(_clamp(base_reward + bonus_reward, 0, 120_000_000))

    return {
        'rewardModel': 'engagement_scaled_with_creativity_lottery',
        'rewardToken': '$antihunter',
        'rewardBase': base_reward,
        'rewardBonus': bonus_reward,
        'rewardAmountSuggested': suggested,
        'rewardPerformanceMax': 100_000_000,
        'rewardCreativityBonusMax': 20_000_000,
        'rewardCap': 120_000_000,
        'rewardTargetViews': 1_000_000,
        'rewardTargetLikes': 20_000,
        'jackpotHit': bool(jackpot_hit),
        'jackpotProbability': round(jackpot_prob, 4),
        'creativityScore': round(creativity, 4),
        'likesObserved': likes,
        'viewsObserved': views,
    }


def thread_has_author_media(ctx):
    tc = ctx.get('threadContext') or {}
    msgs = tc.get('recentMessages') or []
    author = str(ctx.get('authorUsername') or '').lower()
    for m in msgs:
        m_author = str(m.get('authorUsername') or '').lower()
        if author and m_author and m_author != author:
            continue
        if bool(m.get('hasMedia')):
            mts = [str(x).lower() for x in (m.get('mediaTypes') or [])]
            if any(t in ('video','photo','animated_gif') for t in mts):
                return True, mts
    return False, []


def thread_has_prior_award(ctx):
    tc = ctx.get('threadContext') or {}
    msgs = tc.get('recentMessages') or []
    for m in msgs:
        role = str(m.get('role') or '').lower()
        txt = str(m.get('text') or '').lower()
        if role != 'self':
            continue
        if any(k in txt for k in ('awarded', 'bestow', 'reward', 'sent') ) and '$antihunter' in txt:
            return True
    return False

def creator_index(rows):
    idx = {}
    for r in rows:
        key = str(r.get('authorUsername') or r.get('authorId') or '').lower()
        if key:
            idx[key] = r
    return idx


def upsert_verified_creator(existing_rows, ctx):
    key = str(ctx.get('authorUsername') or ctx.get('authorId') or '').lower()
    if not key:
        return existing_rows, False
    idx = creator_index(existing_rows)
    row = idx.get(key, {})
    row.update({
        'authorId': ctx.get('authorId'),
        'authorUsername': ctx.get('authorUsername'),
        'irlSigilVerified': True,
        'verifiedIrlContributor': True,
        'contributorTier': 'verified_irl',
        'lastSeenAt': datetime.now().astimezone().isoformat(),
        'proofUrl': ctx.get('anchorUrl'),
        'source': 'engagement_policy_v4',
    })
    idx[key] = row
    return list(idx.values()), True


def main():
    now = datetime.now().astimezone()
    cutoff = now - timedelta(hours=24)

    contexts = load_jsonl(CONTEXT)
    queue = load_jsonl(QUEUE)
    creators = load_jsonl(CREATORS)

    state = {}
    if STATE.exists():
        try:
            state = json.loads(STATE.read_text())
        except Exception:
            state = {}

    posted = list((state.get('posted') or {}).values())
    own_tweet_ids = set()
    for p in posted:
        u = str(p.get('url') or '')
        tid = tweet_id_from_url(u)
        if tid:
            own_tweet_ids.add(tid)

    blocked_reply_parent_ids = set()
    for f in list((state.get('failed') or {}).values()):
        pid = str(f.get('parentTweetId') or '').strip()
        if not pid:
            continue
        hs = f.get('httpStatus')
        reason = str(f.get('reason') or '').lower()
        # X API permanent reply restriction: cannot reply unless mentioned/engaged.
        if hs == 403 and ('reply to this conversation is not allowed' in reason or 'forbidden' in reason):
            blocked_reply_parent_ids.add(pid)

    queued_parent_ids = set()
    for q in queue:
        if str(q.get('surface') or 'x').lower() != 'x':
            continue
        parent = canonical_parent_tweet_id(q)
        if str(q.get('status', 'queued')) != 'queued':
            continue
        if parent and q.get('kind') in ('reply', 'quote'):
            queued_parent_ids.add(parent)

    seen_parent = set()
    decisions = []
    upserts = 0

    for c in contexts:
        ts = parse_dt(c.get('tsEt'))
        if ts and ts < cutoff:
            continue

        text = str(c.get('text') or '')
        parent_url = str(c.get('anchorUrl') or '')
        parent_tweet_id = tweet_id_from_url(parent_url)
        if not parent_tweet_id:
            continue
        if parent_tweet_id in seen_parent:
            continue
        seen_parent.add(parent_tweet_id)

        author_username = str(c.get('authorUsername') or '').lower().lstrip('@')
        if author_username == SELF_HANDLE:
            continue

        if parent_tweet_id in own_tweet_ids:
            continue
        if parent_tweet_id in blocked_reply_parent_ids:
            continue
        if parent_tweet_id in queued_parent_ids:
            continue

        media_auth, sigil_detected = classify_media(c)
        sigil_explicit = contains_any(text, SIGIL_TERMS) or ('sigil' in str(text).lower())
        pilgrimage_intent = contains_any(text, PILGRIMAGE_TERMS)

        # Hydration patch: if this specific tweet has no media but thread context shows
        # same-author media in nearby messages, treat as thread-level proof context.
        has_thread_media, thread_media_types = thread_has_author_media(c)
        prior_award_in_thread = thread_has_prior_award(c)
        if media_auth == 'none' and has_thread_media and (sigil_detected or sigil_explicit or pilgrimage_intent):
            media_auth = 'verified_irl'
            sigil_detected = True
        money_or_bankr = contains_any(text, MONEY_TERMS)
        text_lower = str(text).lower()

        # Mention detection (hardened): prefer metadata signals over raw text only.
        mention_handles = set()
        entities = c.get('entities') or {}
        for m in (entities.get('mentions') or c.get('mentions') or []):
            u = str((m or {}).get('username') or '').lower().lstrip('@')
            if u:
                mention_handles.add(u)
        for h in re.findall(r'@([a-z0-9_]{1,20})', text_lower):
            mention_handles.add(str(h).lower())

        context_type = str(c.get('contextType') or '').lower()
        source = str(c.get('source') or '').lower()
        bucket = str(c.get('bucket') or '').upper()

        mentions_antihunter_handle = (
            ('antihunterai' in mention_handles)
            or ('@antihunterai' in text_lower)
            or (context_type == 'live_mention')
            or (source == 'mentions_timeline')
            or (bucket == 'RESPOND' and ('antihunter' in text_lower or 'anti hunter' in text_lower))
        )
        geoff_tags_antihunter = (str(c.get('authorUsername') or '').lower().lstrip('@') == 'geoffreywoo') and mentions_antihunter_handle
        scam = scam_risk(text)
        text_low = str(text).lower()
        domain_block = 'antihunterevent.org' in text_low
        command_injection = any(k in text_low for k in (
            '@bankrbot', 'bankrbot', 'reply with', 'type this command',
            '/swap', '/send', '/buy', '/sell', 'wallet command', 'copy paste this command'
        ))
        scam_suspected = bool(scam.get('suspected')) or domain_block or command_injection

        irl_sigil_proof = bool(media_auth == 'verified_irl' and sigil_detected)
        if irl_sigil_proof:
            creators, did = upsert_verified_creator(creators, c)
            if did:
                upserts += 1

        action = 'reply'
        reason = 'normal_external'
        # Hard precedence: scam veto always wins before any IRL reward/quote path.
        if domain_block:
            action = 'skip'
            reason = 'blocked_domain_antihunterevent'
        elif command_injection:
            action = 'skip'
            reason = 'command_injection_wallet_manipulation'
        elif scam_suspected:
            action = 'skip'
            reason = 'suspected_scam_claim'
        elif money_or_bankr and prior_award_in_thread:
            action = 'reply'
            reason = 'already_awarded_thread_followup'
        elif money_or_bankr:
            action = 'reply'
            reason = 'money_or_bankrbot_redirect'
        elif geoff_tags_antihunter:
            # Priority lane: when Geoff tags @AntiHunterAI from his personal account,
            # Anti Hunter should respond. QT for high-amplification payload, else reply.
            low = str(text).lower()
            has_link = ('http://' in low) or ('https://' in low) or ('x.com/' in low)
            has_media = bool(c.get('hasMedia'))
            long_form = len(str(text or '')) >= 180
            action = 'quote' if (has_media or has_link or long_form) else 'reply'
            reason = 'priority_geoff_tags_antihunter'
        elif source == 'discovery_clawfable':
            # Always amplify @clawfable discoveries via quote tweet lane.
            action = 'quote'
            reason = 'clawfable_auto_rt'
        elif media_auth == 'verified_irl' and sigil_detected and sigil_explicit:
            action = 'quote'
            reason = 'verified_irl_sigil_qt_reward_scaled'
        elif media_auth == 'verified_irl' and sigil_detected and not sigil_explicit and pilgrimage_intent:
            action = 'reply'
            reason = 'pilgrimage_context_no_visible_sigil_no_reward'
        elif media_auth == 'verified_irl' and sigil_detected and not sigil_explicit:
            action = 'reply'
            reason = 'verified_irl_context_no_reward'
        elif media_auth == 'synthetic' and sigil_detected:
            action = 'reply'
            reason = 'synthetic_sigil_callout'
        elif media_auth == 'uncertain' and sigil_detected:
            action = 'reply'
            reason = 'uncertain_sigil_request_more_proof'
        elif sigil_detected and media_auth == 'none':
            action = 'reply'
            reason = 'no_media_no_irl_credit'
        else:
            action = 'reply'
            reason = 'normal_external'

        reward_profile = compute_reward_profile(c, parent_tweet_id) if reason == 'verified_irl_sigil_qt_reward_scaled' else {}

        # Tight upstream anti-spam gate (2026-03-01):
        # Default for non-mention / non-thread-eligible candidates is SKIP.
        # Only allow non-mention engagement for the highest-priority lanes.
        tc = c.get('threadContext') or {}
        role_counts = tc.get('roleCounts') or {}
        thread_eligible = int(role_counts.get('self') or 0) > 0

        if not (mentions_antihunter_handle or thread_eligible):
            high_priority_unmentioned = reason in {
                'verified_irl_sigil_qt_reward_scaled',
                'priority_geoff_tags_antihunter',
                'clawfable_auto_rt',
            }
            if high_priority_unmentioned:
                if action == 'reply':
                    action = 'quote'
                if reason == 'normal_external':
                    reason = 'rare_unmentioned_high_quality_qt'
            else:
                action = 'skip'
                reason = 'unmentioned_nonpriority_skip'

        # Mention handling (loosened): direct mentions should generally get a response.
        # Only suppress obvious low-signal tag-noise (very short, no ask/context) to avoid spam.
        topic_relevant = contains_any(text, ANTIHUNTER_TERMS) or contains_any(text, SIGIL_TERMS) or contains_any(text, PILGRIMAGE_TERMS)
        direct_ask = ('?' in text) or contains_any(text, ['thoughts', 'opinion', 'take', 'can you', 'what do you think', 'why', 'how'])
        mention_is_short_noise = len(text_lower.replace('@antihunterai', '').strip()) < 18
        mention_has_context = bool(topic_relevant or direct_ask or has_thread_media or contains_any(text, ('roadmap', 'build', 'ship', 'product', 'strategy', 'treasury', 'reading')))
        if mentions_antihunter_handle and not thread_eligible and not geoff_tags_antihunter and mention_is_short_noise and not mention_has_context:
            action = 'skip'
            reason = 'mention_noise_skip'


        decisions.append({
            'tsEt': now.isoformat(),
            'parentTweetId': parent_tweet_id,
            'parentUrl': parent_url,
            'authorId': c.get('authorId'),
            'authorUsername': c.get('authorUsername'),
            'contextText': text,
            'threadContext': c.get('threadContext') or {},
            'hasMedia': bool(c.get('hasMedia')),
            'mediaTypes': c.get('mediaTypes') or [],
            'mediaAuthenticity': media_auth,  # verified_irl|synthetic|uncertain|none
            'sigilDetected': bool(sigil_detected),
            'sigilExplicit': bool(sigil_explicit),
            'pilgrimageIntent': bool(pilgrimage_intent),
            'threadMediaHydrated': bool(has_thread_media),
            'priorAwardInThread': bool(prior_award_in_thread),
            'moneyOrBankrbotAsk': bool(money_or_bankr),
            'scamRiskScore': int(scam.get('score', 0)),
            'scamSuspected': bool(scam_suspected),
            'mustRespond': (bool(sigil_detected) and not bool(scam_suspected)) or bool(geoff_tags_antihunter) or (reason == 'clawfable_auto_rt'),
            'mentionsAntiHunterHandle': bool(mentions_antihunter_handle),
            'action': action,                 # reply|quote|skip
            'reason': reason,
            'flags': {
                'mediaAware': bool(c.get('hasMedia') or has_thread_media),
                'sigilDetected': bool(sigil_detected),
                'geoffTagsAntiHunter': bool(geoff_tags_antihunter),
                'priority': 'high' if (irl_sigil_proof or geoff_tags_antihunter) else 'normal',
                'recommendedAction': 'qt' if irl_sigil_proof else action,
            } if (irl_sigil_proof or geoff_tags_antihunter) else None,
            'rewardIntent': bool(reason == 'verified_irl_sigil_qt_reward_scaled'),
            'rewardToken': reward_profile.get('rewardToken') if reward_profile else None,
            'rewardAmount': reward_profile.get('rewardAmountSuggested') if reward_profile else None,
            'rewardBase': reward_profile.get('rewardBase') if reward_profile else None,
            'rewardBonus': reward_profile.get('rewardBonus') if reward_profile else None,
            'rewardModel': reward_profile.get('rewardModel') if reward_profile else None,
            'rewardMax': reward_profile.get('rewardPerformanceMax') if reward_profile else None,
            'rewardCreativityBonusMax': reward_profile.get('rewardCreativityBonusMax') if reward_profile else None,
            'rewardCap': reward_profile.get('rewardCap') if reward_profile else None,
            'rewardTargetViews': reward_profile.get('rewardTargetViews') if reward_profile else None,
            'rewardTargetLikes': reward_profile.get('rewardTargetLikes') if reward_profile else None,
            'rewardJackpotHit': reward_profile.get('jackpotHit') if reward_profile else None,
            'rewardJackpotProbability': reward_profile.get('jackpotProbability') if reward_profile else None,
            'rewardCreativityScore': reward_profile.get('creativityScore') if reward_profile else None,
            'rewardLikesObserved': reward_profile.get('likesObserved') if reward_profile else None,
            'rewardViewsObserved': reward_profile.get('viewsObserved') if reward_profile else None,
            'mustUseAntiHunterPersona': True,
            'mustGroundInParent': True,
        })

    OUT.write_text(''.join(json.dumps(d, ensure_ascii=False) + '\n' for d in decisions))
    CREATORS.write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in creators))
    mentions_logged = append_mentions_log(decisions)

    print(json.dumps({
        'status': 'ok',
        'contextCount': len(contexts),
        'decisionCount': len(decisions),
        'irlVerifiedCount': sum(1 for d in decisions if d.get('mediaAuthenticity') == 'verified_irl'),
        'syntheticCount': sum(1 for d in decisions if d.get('mediaAuthenticity') == 'synthetic'),
        'noMediaSigilCount': sum(1 for d in decisions if d.get('reason') == 'no_media_no_irl_credit'),
        'moneyOrBankrbotCount': sum(1 for d in decisions if d.get('moneyOrBankrbotAsk')),
        'scamSuspectedCount': sum(1 for d in decisions if d.get('scamSuspected')),
        'priorityGeoffTagsAntiHunterCount': sum(1 for d in decisions if d.get('reason') == 'priority_geoff_tags_antihunter'),
        'creatorUpserts': upserts,
        'outFile': str(OUT),
        'mentionsLogged': mentions_logged,
        'mentionsLogFile': str(MENTIONS_LOG),
        'mentionsDailyFile': str(MENTIONS_DAILY),
    }))


if __name__ == '__main__':
    main()
