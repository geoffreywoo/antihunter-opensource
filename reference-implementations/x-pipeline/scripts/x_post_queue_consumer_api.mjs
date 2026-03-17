#!/usr/bin/env node
/*
  Consume Anti Hunter X post queue via the official X API (OAuth 2.0 user context).

  Inputs:
  - queue (canonical): memory/public_intents_queue.jsonl (surface=x)
  - state:  memory/x_post_queue_state.json
  - runs:   memory/x_post_queue_runs.jsonl
  - oauth2 client:  .secrets/x_antihunter_oauth2.json
  - oauth2 tokens:  .secrets/x_antihunter_tokens.json

  Key reliability rules (2026-02):
  - Append-only queue; we do NOT rewrite the queue file.
  - Idempotency comes from state.* maps.
  - Auth/transient failures are NOT terminal failures:
    - 401/invalid_token => skipped_auth (retryable) + open circuit breaker.
    - never burn intents into state.failed due to auth outages.

  Usage:
    node scripts/x_post_queue_consumer_api.mjs --max 4
*/

import { readFileSync, writeFileSync, chmodSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const PATHS = {
  state: '/Users/gwbox/.openclaw/workspace/memory/x_post_queue_state.json',
  runs: '/Users/gwbox/.openclaw/workspace/memory/x_post_queue_runs.jsonl',
  breaker: '/Users/gwbox/.openclaw/workspace/memory/x_auth_circuit_breaker.json',
  pause: '/Users/gwbox/.openclaw/workspace/memory/x_poster_pause.json',
  quarantine: '/Users/gwbox/.openclaw/workspace/memory/x_quarantine_queue.jsonl',
  rewardPromises: '/Users/gwbox/.openclaw/workspace/memory/reward_promises.jsonl',
  rewardPromisesSummary: '/Users/gwbox/.openclaw/workspace/memory/reward_promises_summary.json',
  oauthCfg: '/Users/gwbox/.openclaw/workspace/.secrets/x_antihunter_oauth2.json',
  oauthTokens: '/Users/gwbox/.openclaw/workspace/.secrets/x_antihunter_tokens.json',
  preflight: '/Users/gwbox/.openclaw/workspace/memory/_x_engagement_dedupe_sets.json',
  publicGuardrails: '/Users/gwbox/.openclaw/workspace/playbooks/public_voice_guardrails.json',
  publicQueue: '/Users/gwbox/.openclaw/workspace/memory/public_intents_queue.jsonl',
  activeQueue: '/Users/gwbox/.openclaw/workspace/memory/x_active_queue.jsonl',
  browserFallbackQueue: '/Users/gwbox/.openclaw/workspace/memory/x_browser_fallback_queue.jsonl',
};
const LOCK_PATH = '/tmp/x_thread_poster.lock';
const LOCK_STALE_MS = 5 * 60 * 1000;

function acquireLock(path, staleMs = LOCK_STALE_MS) {
  try {
    writeFileSync(path, JSON.stringify({ pid: process.pid, ts: Date.now() }) + '\n', { flag: 'wx' });
    return true;
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      try {
        const stat = statSync(path);
        const age = Date.now() - Number(stat.mtimeMs || 0);
        if (age > staleMs) {
          unlinkSync(path);
          return acquireLock(path, staleMs);
        }
      } catch {
        try { unlinkSync(path); } catch {}
        return acquireLock(path, staleMs);
      }
      return false;
    }
    throw err;
  }
}

function releaseLock(path) {
  try {
    unlinkSync(path);
  } catch {}
}


function sha1(s) {
  return createHash('sha1').update(s).digest('hex');
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function appendJsonl(path, obj) {
  writeFileSync(path, JSON.stringify(obj) + '\n', { encoding: 'utf8', flag: 'a' });
}

function readJsonSafe(path, fallback = {}) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function extractHandleFromParentUrl(url) {
  const u = String(url || '');
  const m = u.match(/x\.com\/([^\/\?]+)\/status\//i);
  return m ? String(m[1]).toLowerCase() : null;
}

function enqueueBrowserFallback(intent, reason, tsEt) {
  const rec = {
    tsEt,
    reason,
    idempotencyKey: intent?.idempotencyKey || null,
    sourceJob: intent?.sourceJob || null,
    kind: intent?.kind || null,
    policyReason: intent?.reason || null,
    text: intent?.text || '',
    parentTweetId: intent?.parentTweetId || null,
    parentUrl: intent?.parentUrl || intent?.anchorUrl || null,
    persona: intent?.persona || null,
    surface: intent?.surface || null,
    opportunityId: intent?.opportunityId || null,
    decisionId: intent?.decisionId || null,
    adaptivityTelemetry: intent?.adaptivityTelemetry || {},
    status: 'queued_browser',
  };
  appendJsonl(PATHS.browserFallbackQueue, rec);
}

function maybeRecordRewardPromise(intent, postedUrl, tsEt) {
  const t = intent?.adaptivityTelemetry || {};
  const rewardIntent = Boolean(t.rewardIntent) || Boolean(intent?.rewardIntent) || String(intent?.reason || '').includes('reward_scaled');
  const amount = Number(t.rewardAmount || intent?.rewardAmount || 0);
  const token = String(t.rewardToken || intent?.rewardToken || '$antihunter').toLowerCase();
  const text = String(intent?.text || '').toLowerCase();
  const textSignalsReward = text.includes('100,000,000 $antihunter') || text.includes('100000000 $antihunter') || text.includes('scaled by engagement') || text.includes('likes + views') || text.includes('bestow') || text.includes('awarded');
  const isReward = rewardIntent || (amount > 0) || textSignalsReward;
  if (!isReward) return;

  const beneficiary = String(t.beneficiaryHandle || extractHandleFromParentUrl(intent?.parentUrl || intent?.anchorUrl || '') || '').toLowerCase() || null;
  const rewardAmount = amount > 0 ? amount : (text.includes('100,000,000') || text.includes('100000000') ? 100000000 : 0);
  const rewardBase = Number(t.rewardBase || intent?.rewardBase || 0);
  const rewardBonus = Number(t.rewardBonus || intent?.rewardBonus || 0);

  const rec = {
    tsEt,
    promisePostUrl: postedUrl,
    parentUrl: intent?.parentUrl || intent?.anchorUrl || null,
    parentTweetId: intent?.parentTweetId || null,
    beneficiaryHandle: beneficiary,
    amount: rewardAmount,
    rewardBase,
    rewardBonus,
    token,
    sourceIntentKey: intent?.idempotencyKey || null,
  };
  appendJsonl(PATHS.rewardPromises, rec);

  let summary = { updatedAtEt: tsEt, totalsByHandle: {}, totalsByToken: {}, countByHandle: {}, totalPromises: 0 };
  if (existsSync(PATHS.rewardPromisesSummary)) {
    try { summary = JSON.parse(readFileSync(PATHS.rewardPromisesSummary, 'utf8')); } catch {}
  }
  summary.updatedAtEt = tsEt;
  summary.totalPromises = Number(summary.totalPromises || 0) + 1;
  if (beneficiary) {
    summary.totalsByHandle = summary.totalsByHandle || {};
    summary.countByHandle = summary.countByHandle || {};
    summary.totalsByHandle[beneficiary] = Number(summary.totalsByHandle[beneficiary] || 0) + Number(rewardAmount || 0);
    summary.countByHandle[beneficiary] = Number(summary.countByHandle[beneficiary] || 0) + 1;
  }
  summary.totalsByToken = summary.totalsByToken || {};
  summary.totalsByToken[token] = Number(summary.totalsByToken[token] || 0) + Number(rewardAmount || 0);

  writeFileSync(PATHS.rewardPromisesSummary, JSON.stringify(summary, null, 2) + "\n", 'utf8');
}

function refreshActiveQueue() {
  try {
    execFileSync('python3', ['/Users/gwbox/.openclaw/workspace/scripts/x_materialize_active_queue.py'], { stdio: 'ignore' });
  } catch {}
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { max: 4, dryRun: false, maxRuntimeMs: 45_000, approvedOnly: false, hourlyCap: 9999, dailyCap: 9999 };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--max') out.max = Number(args[++i]);
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--max-runtime-ms') out.maxRuntimeMs = Number(args[++i]);
    else if (a === '--approved-only') out.approvedOnly = true;
    else if (a === '--hourly-cap') out.hourlyCap = Number(args[++i]);
    else if (a === '--daily-cap') out.dailyCap = Number(args[++i]);
  }
  if (!Number.isFinite(out.max) || out.max <= 0) out.max = 4;
  if (!Number.isFinite(out.maxRuntimeMs) || out.maxRuntimeMs <= 0) out.maxRuntimeMs = 90_000;
  if (!Number.isFinite(out.hourlyCap) || out.hourlyCap <= 0) out.hourlyCap = 9999;
  if (!Number.isFinite(out.dailyCap) || out.dailyCap <= 0) out.dailyCap = 9999;
  return out;
}

function loadQueue() {
  const items = [];

  // Prefer materialized active queue when available; fall back to raw append-only queue.
  const queuePath = existsSync(PATHS.activeQueue) ? PATHS.activeQueue : PATHS.publicQueue;
  if (existsSync(queuePath)) {
    const lines = readFileSync(queuePath, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const r = JSON.parse(line);
        const forceDailyPost = String(r?.adaptivityTelemetry?.forceDailyPost || r?.forceDailyPost || '').trim();
        const surface = String(r?.surface || '').toLowerCase();
        if (surface !== 'x' && !forceDailyPost) continue;
        if (String(r?.status || 'queued') !== 'queued') continue;
        items.push({
          kind: r.kind || r.mode || 'reply',
          text: r.text || '',
          parentTweetId: r.parentTweetId || '',
          parentIdempotencyKey: r.parentIdempotencyKey || null,
          parentUrl: r.parentUrl || null,
          priority: Number.isFinite(r.priority) ? r.priority : 999,
          tsEt: r.tsEt || null,
          persona: r.persona || 'geoffrey_woo',
          sourceJob: r.sourceJob || r.source || 'public_intents_queue',
          idempotencyKey: r.idempotencyKey || r.intentId || null,
          anchorUrl: r.anchorUrl || null,
          bucket: r.bucket || 'public_unified',
          opportunityId: r.opportunityId || null,
          decisionId: r.decisionId || null,
          reason: r.reason || null,
          forceDailyPost: forceDailyPost || null,
          adaptivityTelemetry: r.adaptivityTelemetry || {},
        });
      } catch {}
    }
  }

  return items;
}

function loadState() {
  if (!existsSync(PATHS.state)) {
    return { posted: {}, failed: {}, skipped: {}, lastRunAtEt: null, lastRunSummary: null };
  }
  const s = readJson(PATHS.state);
  s.posted ||= {};
  s.failed ||= {};
  s.skipped ||= {};
  return s;
}

function loadPreflight() {
  if (!existsSync(PATHS.preflight)) return { generatedAt: null, failedPermanentParentIds: [] };
  try {
    return readJson(PATHS.preflight);
  } catch {
    return { generatedAt: null, failedPermanentParentIds: [] };
  }
}

function loadBreaker() {
  if (!existsSync(PATHS.breaker)) return { open: false };
  try {
    return readJson(PATHS.breaker);
  } catch {
    return { open: false, parseError: true };
  }
}

function setBreaker({ open, reason, cooldownMinutes, tsEt }) {
  const untilMs = open ? (Date.now() + (cooldownMinutes ?? 30) * 60_000) : null;
  const payload = {
    open: !!open,
    reason: reason || null,
    openedAtEt: open ? tsEt : null,
    openUntilMs: open ? untilMs : null,
    updatedAtEt: tsEt,
  };
  writeJson(PATHS.breaker, payload);
}

function breakerOpenNow(b) {
  if (!b?.open) return false;
  if (!b.openUntilMs) return true;
  return Date.now() < Number(b.openUntilMs);
}

function loadPause() {
  if (!existsSync(PATHS.pause)) return { open: false };
  try { return readJson(PATHS.pause); } catch { return { open: false }; }
}

function pauseOpenNow(p) {
  if (!p?.open) return false;
  if (!p.openUntilMs) return true;
  return Date.now() < Number(p.openUntilMs);
}

function setPause({ open, reason, cooldownMinutes, tsEt }) {
  const untilMs = open ? (Date.now() + (cooldownMinutes ?? 180) * 60_000) : null;
  writeJson(PATHS.pause, {
    open: !!open,
    reason: reason || null,
    openedAtEt: open ? tsEt : null,
    openUntilMs: open ? untilMs : null,
    updatedAtEt: tsEt,
  });
}

function postedCountSince(state, msWindow) {
  const cutoff = Date.now() - msWindow;
  let n = 0;
  for (const p of Object.values(state?.posted || {})) {
    const ts = Date.parse(p?.tsEt || p?.postedAtEt || '') || 0;
    if (ts >= cutoff) n += 1;
  }
  return n;
}

function quarantineIntent(it, reason, tsEt) {
  appendJsonl(PATHS.quarantine, {
    tsEt,
    reason,
    idempotencyKey: it?.idempotencyKey || null,
    parentTweetId: it?.parentTweetId || null,
    kind: it?.kind || null,
    text: it?.text || null,
    sourceJob: it?.sourceJob || null,
  });
}

function canonicalParentTweetId(it) {
  const explicit = String(it?.parentTweetId || '').trim();
  if (explicit) return explicit;
  const fromParentUrl = tweetIdFromUrl(it?.parentUrl);
  if (fromParentUrl) return fromParentUrl;
  const fromAnchor = tweetIdFromUrl(it?.anchorUrl);
  if (fromAnchor) return fromAnchor;
  return '';
}

function classifyArchetype(text = '', kind = 'reply') {
  const t = String(text || '').toLowerCase();
  if (kind === 'reply') return 'engagement_reply';
  if (kind === 'quote') return 'amplification_qt';
  if (/(shipped|deployed|live|launched|commit|merged|release|changelog)/.test(t)) return 'build_receipt';
  if (/(treasury|wallet|onchain|pnl|position|allocation|holdings)/.test(t)) return 'treasury_update';
  if (/(thesis|market|why now|edge|distribution|strategy|mechanism)/.test(t)) return 'thesis_take';
  if (/(weekly|daily|report|scorecard|metrics|kpi|receipts)/.test(t)) return 'ops_report';
  return 'general_update';
}

function classifyAngle(text = '') {
  const t = String(text || '').toLowerCase();
  if (/(what changed|update|now live|shipped|done)/.test(t)) return 'what_changed';
  if (/(why|because|therefore|so that|mechanism)/.test(t)) return 'mechanism';
  if (/(next|roadmap|coming|soon|plan)/.test(t)) return 'forward_look';
  if (/(proof|receipt|evidence|onchain|tx|link)/.test(t)) return 'proof';
  if (/(question|thoughts\?|feedback\?|agree\?)/.test(t)) return 'conversation_prompt';
  return 'statement';
}

function classifyPackaging(text = '', hasMedia = false) {
  const src = String(text || '');
  const words = src.trim() ? src.trim().split(/\s+/).length : 0;
  const low = src.toLowerCase();
  const hasLink = /https?:\/\//.test(low) || /x\.com\//.test(low);
  const bulletLike = /\n\s*[-•]/.test(src) || /\n\s*\d+\./.test(src);
  const hookLen = Math.min((src.split(/\n/)[0] || '').length, 280);
  const lengthBand = words < 25 ? 'short' : (words <= 80 ? 'medium' : 'long');
  return {
    words,
    hookLen,
    lengthBand,
    hasMedia: !!hasMedia,
    hasLink,
    structure: bulletLike ? 'list' : 'prose',
  };
}

function isForceDailyIntent(it) {
  const marker = String(it?.forceDailyPost || it?.adaptivityTelemetry?.forceDailyPost || '').trim().toLowerCase();
  return marker.endsWith('_daily');
}

function normalizeIntent(it) {
  const kind = it.kind || 'reply';
  const parentTweetId = canonicalParentTweetId(it);
  const text = (it.text || '').trim();
  const idempotencyKey = it.idempotencyKey || sha1(`${kind}:${parentTweetId}:${text}`);
  const forceDailyPost = String(it?.forceDailyPost || it?.adaptivityTelemetry?.forceDailyPost || '').trim() || null;

  const inferredArchetype = classifyArchetype(text, kind);
  const inferredAngle = classifyAngle(text);
  const inferredPackaging = classifyPackaging(text, Boolean(it?.media || it?.mediaPath || it?.imageModel));

  return {
    ...it,
    kind,
    parentTweetId,
    text,
    idempotencyKey,
    forceDailyPost,
    surface: isForceDailyIntent({ ...it, forceDailyPost }) ? 'x' : it?.surface,
    archetype: it?.archetype || inferredArchetype,
    angle: it?.angle || inferredAngle,
    packaging: it?.packaging || inferredPackaging,
  };
}

function isRetryableSkip(s) {
  const r = String(s?.reason || '');
  return r.startsWith('skipped_auth') || r.startsWith('skipped_rate_limit') || r.startsWith('skipped_transient');
}

function ownTweetIdsFromState(state) {
  const ids = new Set();
  for (const p of Object.values(state?.posted || {})) {
    const u = String(p?.url || '');
    const m = u.match(/\/status\/(\d+)/);
    if (m) ids.add(String(m[1]));
  }
  return ids;
}

function selectPending(queue, state, opts = {}) {
  const failedParentIds = new Set((opts.preflight?.failedPermanentParentIds || []).map((id) => String(id)));
  const failedReplyForbiddenParentIds = new Set((opts.preflight?.failedReplyForbiddenParentIds || []).map((id) => String(id)));
  // dedupe by idempotencyKey: keep newest by tsEt if present, else last occurrence
  const byId = new Map();
  for (const raw of queue) {
    const it = normalizeIntent(raw);
    const prev = byId.get(it.idempotencyKey);
    if (!prev) byId.set(it.idempotencyKey, it);
    else {
      const prevTs = Date.parse(prev.tsEt || '') || 0;
      const ts = Date.parse(it.tsEt || '') || 0;
      if (ts >= prevTs) byId.set(it.idempotencyKey, it);
    }
  }

  const ownTweetIds = ownTweetIdsFromState(state);


  let items = Array.from(byId.values()).filter((it) => {
    if (state.posted?.[it.idempotencyKey]) return false;
    if (opts.approvedOnly) {
      const approved = String(it.sourceJob || '') === 'manual_approved' || Boolean(it?.adaptivityTelemetry?.approvedExactText);
      if (!approved) return false;
    }
    if (state.failed?.[it.idempotencyKey]) return false;
    if (!it.text) return false;
    if (it.kind === 'reply' && !it.parentTweetId && !it.parentIdempotencyKey) return false;
    if (it.kind === 'quote' && !it.parentTweetId) return false;

    // allow multi-turn engagement on the same parent across runs; only same-run
    // dedupe is enforced later in this function.

    // hard self-loop veto: never engage with our own parent tweet ids
    if ((it.kind === 'reply' || it.kind === 'quote') && it.parentTweetId && ownTweetIds.has(String(it.parentTweetId))) return false;

    // avoid parents that have already produced permanent failures (non-reply restriction)
    if ((it.kind === 'reply' || it.kind === 'quote') && it.parentTweetId && failedParentIds.has(String(it.parentTweetId))) return false;

    // X API reply restriction is permanent for replies unless mentioned/engaged.
    if (it.kind === 'reply' && it.parentTweetId && failedReplyForbiddenParentIds.has(String(it.parentTweetId))) return false;

    // retryable skips are allowed back into pending
    const sk = state.skipped?.[it.idempotencyKey];
    if (sk && !isRetryableSkip(sk)) {
      const rsn = String(sk?.reason || '');
      const forceDailyRecoverable = isForceDailyIntent(it) && (
        rsn.startsWith('policy_gate:repetitive_text:') ||
        rsn.startsWith('policy_gate:missing_required_fields:')
      );
      if (!forceDailyRecoverable) return false;
    }

    return true;
  });

  // priority: lower number = higher; then tsEt older first
  items.sort((a, b) => {
    const pa = Number.isFinite(a.priority) ? a.priority : 999;
    const pb = Number.isFinite(b.priority) ? b.priority : 999;
    if (pa !== pb) return pa - pb;
    const ta = Date.parse(a.tsEt || '') || 0;
    const tb = Date.parse(b.tsEt || '') || 0;
    return ta - tb;
  });

  // one-intent-per-parent per run (even before posting)
  // exception: shipping-receipt reply threads should post as a contiguous batch.
  const seenParent = new Set();
  const deduped = [];
  for (const it of items) {
    const isShippingReply = String(it?.sourceJob || '').includes('x_nightly_shipping_receipt_1935et') && it.kind === 'reply';
    if (!isShippingReply && (it.kind === 'reply' || it.kind === 'quote') && it.parentTweetId) {
      const pid = String(it.parentTweetId);
      if (seenParent.has(pid)) continue;
      seenParent.add(pid);
    }
    deduped.push(it);
  }

  return deduped;
}



function applySurfaceCaps(items, maxTotal = 5) {
  const max = Math.max(0, Number(maxTotal) || 0);
  const out = [];

  // pacing rule (2026-03-15 update):
  // - at most 6 thread-actions (reply/quote) per run
  // - at most 4 other posts (typically root/reading/learning updates) per run
  let threadActions = 0;
  let otherPosts = 0;

  for (const it of items) {
    if (out.length >= max) break;
    const kind = String(it?.kind || '').toLowerCase();
    const isThreadAction = kind === 'reply' || kind === 'quote';

    if (isThreadAction) {
      if (threadActions >= 6) continue;
      threadActions += 1;
      out.push(it);
      continue;
    }

    if (otherPosts >= 4) continue;
    otherPosts += 1;
    out.push(it);
  }

  return out;
}

async function refreshAccessToken(cfg, tokens) {
  const url = 'https://api.x.com/2/oauth2/token';
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: cfg.client_id,
  });

  const headers = { 'content-type': 'application/x-www-form-urlencoded' };

  if (cfg.client_secret && typeof cfg.client_secret === 'string' && cfg.client_secret.length > 0 && !cfg.client_secret.includes('OPTIONAL_')) {
    headers['authorization'] = `Basic ${Buffer.from(`${cfg.client_id}:${cfg.client_secret}`).toString('base64')}`;
  }

  const res = await fetch(url, { method: 'POST', headers, body });
  const txt = await res.text();
  let json;
  try { json = JSON.parse(txt); } catch { json = { raw: txt }; }
  if (!res.ok) {
    const err = new Error(`refresh failed (${res.status}): ${JSON.stringify(json)}`);
    // @ts-ignore
    err.httpStatus = res.status;
    throw err;
  }
  return json;
}

async function postTweet(accessToken, payload) {
  const res = await fetch('https://api.x.com/2/tweets', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify(payload),
  });
  const txt = await res.text();
  let json;
  try { json = JSON.parse(txt); } catch { json = { raw: txt }; }
  if (!res.ok) {
    const err = new Error(`post failed (${res.status}): ${JSON.stringify(json)}`);
    // @ts-ignore
    err.httpStatus = res.status;
    throw err;
  }
  return json;
}

function tweetIdFromUrl(u) {
  const m = String(u || '').match(/\/status\/(\d+)/);
  return m ? m[1] : null;
}

function buildPayload(intent, state) {
  if (intent.kind === 'root') return { text: intent.text };

  if (intent.kind === 'reply') {
    let parentTweetId = intent.parentTweetId;
    if (!parentTweetId && intent.parentIdempotencyKey && state?.posted?.[intent.parentIdempotencyKey]?.url) {
      parentTweetId = tweetIdFromUrl(state.posted[intent.parentIdempotencyKey].url);
    }
    if (!parentTweetId) throw new Error('reply intent missing parentTweetId (or unresolved parentIdempotencyKey)');
    return { text: intent.text, reply: { in_reply_to_tweet_id: parentTweetId } };
  }

  if (intent.kind === 'quote') return { text: intent.text, quote_tweet_id: intent.parentTweetId };
  throw new Error(`unknown kind: ${intent.kind}`);
}

function violatesScope(text) {
  const t = String(text || '').toLowerCase();
  if (t.includes('jake paul')) return 'scope_excluded_jake_paul';
  if (t.includes('logan paul')) return 'scope_excluded_logan_paul';
  if (t.includes('anti fund') || t.includes('antifund') || t.includes('@antifund')) return 'scope_excluded_anti_fund';
  return null;
}


function violatesMetaLabels(text) {
  const t = String(text || '').toLowerCase();
  const banned = [
    'direct response:',
    'mythic framing:',
    'prophetic close:',
    'so what:',
    'voice note:',
    'operator so-what:',
  ];
  return banned.some((b) => t.includes(b)) ? 'meta_label_leak' : null;
}

function violatesPersonaBoundary(intent) {
  const persona = String(intent?.persona || '').toLowerCase();
  const surface = String(intent?.surface || '').toLowerCase();
  const sourceJob = String(intent?.sourceJob || '').toLowerCase();

  // this consumer handles Anti Hunter public account with Geoff voice.
  if (persona && !['anti_hunter','antihunter','geoffrey_woo','geoff'].includes(persona)) return `persona_mismatch:${persona}`;

  const forbiddenHints = ['anti fund', 'anti_fund', 'antifund', 'investor_ic', 'ic_analyst', 'geoffreywoo'];
  for (const h of forbiddenHints) {
    if (surface.includes(h) || sourceJob.includes(h)) return `persona_boundary_violation:${h}`;
  }

  return null;
}

function violatesAdaptiveFields(intent) {
  const persona = String(intent?.persona || '').toLowerCase();
  if (!(persona === 'anti_hunter' || persona === 'antihunter')) return null;

  const missing = [];
  if (!intent?.anchorUrl) missing.push('anchorUrl');
  if (!intent?.bucket) missing.push('bucket');
  if (!intent?.adaptivityTelemetry || typeof intent.adaptivityTelemetry !== 'object') missing.push('adaptivityTelemetry');
  if (!intent?.opportunityId) missing.push('opportunityId');
  if (!intent?.decisionId) missing.push('decisionId');
  if (missing.length) return `missing_required_fields:${missing.join(',')}`;
  return null;
}


function violatesGeoffVoice(intent) {
  const t = String(intent?.text || '').toLowerCase().trim();
  const g = readJsonSafe(PATHS.publicGuardrails, {});

  const starts = Array.isArray(g.metaLabelPrefixes) ? g.metaLabelPrefixes : [];
  if (starts.some((k) => t.startsWith(String(k)))) return 'meta_label_leak';

  const inline = Array.isArray(g.metaLabelInline) ? g.metaLabelInline : [];
  if (inline.some((k) => t.includes(String(k)))) return 'meta_label_leak';

  const selfOwn = Array.isArray(g.selfOwnPhrases) ? g.selfOwnPhrases : [];
  if (selfOwn.some((k) => t.includes(String(k)))) return 'self_own_blocked';

  const hedge = Array.isArray(g.hedgePhrases) ? g.hedgePhrases : [];
  const hedgeHits = hedge.filter((k) => t.includes(String(k))).length;
  if (hedgeHits >= 2) return 'hedge_tone_blocked';

  const filler = Array.isArray(g.genericFillerPhrases) ? g.genericFillerPhrases : [];
  if (filler.some((k) => t.includes(String(k)))) return 'generic_filler_blocked';

  return null;
}


function violatesBankrbotCommand(text) {
  const t = String(text || '').toLowerCase();
  // highest-order safety: never emit bankrbot command-style or mentions that could trigger money movement.
  if (t.includes('@bankrbot')) return 'bankrbot_blocked';
  const cmdLike = /\b(swap|buy|sell|mint|send|transfer|create|deploy)\b/;
  if (t.includes('bankrbot') && cmdLike.test(t)) return 'bankrbot_command_blocked';
  return null;
}

function normalizeForSimilarity(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSet(text) {
  return new Set(normalizeForSimilarity(text).split(' ').filter((w) => w.length >= 4));
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

function violatesRepetition(text, state, intent) {
  const mine = tokenSet(text);
  const recent = Object.values(state?.posted || {}).slice(-120);
  let maxSim = 0;
  for (const p of recent) {
    const sim = jaccard(mine, tokenSet(p?.text || ''));
    if (sim > maxSim) maxSim = sim;
  }
  const kind = String(intent?.kind || '').toLowerCase();
  const threshold = (kind === 'reply' || kind === 'quote') ? 0.90 : 0.80;
  return maxSim >= threshold ? `repetitive_text:${maxSim.toFixed(2)}` : null;
}

async function main() {
  if (!acquireLock(LOCK_PATH)) {
    console.log(JSON.stringify({ status: 'skipped', reason: 'poster_already_running' }, null, 2));
    return;
  }

  const { max, dryRun, maxRuntimeMs, approvedOnly, hourlyCap, dailyCap } = parseArgs();
  refreshActiveQueue();
  const tsEt = new Date().toISOString();
  const deadlineMs = Date.now() + maxRuntimeMs;

  try {
    const breaker = loadBreaker();
  if (breakerOpenNow(breaker)) {
    const run = { tsEt, jobName: 'x_post_queue_consumer_api', max, note: 'auth breaker open; skipping', breaker };
    appendJsonl(PATHS.runs, run);
    console.log(JSON.stringify({ status: 'noop', note: 'breaker_open' }, null, 2));
    return;
  }

  const pause = loadPause();
  if (pauseOpenNow(pause)) {
    const run = { tsEt, jobName: 'x_post_queue_consumer_api', max, note: 'poster pause open; skipping', pause };
    appendJsonl(PATHS.runs, run);
    console.log(JSON.stringify({ status: 'noop', note: 'poster_paused' }, null, 2));
    return;
  }

  const cfg = readJson(PATHS.oauthCfg);
  const tokens = readJson(PATHS.oauthTokens);
  if (!tokens.refresh_token) throw new Error('missing refresh_token in tokens file');

  const queue = loadQueue();
  const state = loadState();
  const preflight = loadPreflight();

  const pending = selectPending(queue, state, { approvedOnly, preflight });
  const capped = applySurfaceCaps(pending, max);
  const toProcess = capped.slice(0, max);

  const run = {
    tsEt,
    jobName: 'x_post_queue_consumer_api',
    max,
    queueLines: queue.length,
    pendingBefore: pending.length,
    attempted: 0,
    posted: [],
    failedOrSkipped: [],
    dryRun,
    maxRuntimeMs,
    budgetExhausted: false,
    version: 2,
    policySkips: 0,
    preflightMeta: {
      failedPermanentParents: Array.isArray(preflight?.failedPermanentParentIds) ? preflight.failedPermanentParentIds.length : 0,
      generatedAt: preflight?.generatedAt || null,
    },
  };

  const postedLastHour = postedCountSince(state, 60 * 60 * 1000);
  const postedLastDay = postedCountSince(state, 24 * 60 * 60 * 1000);

  if (toProcess.length === 0) {
    run.note = 'no pending intents';
    appendJsonl(PATHS.runs, run);
    state.lastRunAtEt = tsEt;
    state.lastRunSummary = { status: 'noop', pending: 0 };
    if (run.policySkips >= 5) {
    run.note = `policy_skip_spike:${run.policySkips}`;
    console.warn(JSON.stringify({
      event: 'policy_skip_spike',
      policySkips: run.policySkips,
      tsEt,
      source: 'x_post_queue_consumer_api'
    }));
  }

  writeJson(PATHS.state, state);
    console.log(JSON.stringify({ status: 'noop', attempted: 0, posted: 0, failed: 0, liveUrls: [] }, null, 2));
    return;
  }

  if (dryRun) {
    for (const it of toProcess) {
      run.failedOrSkipped.push({ idempotencyKey: it.idempotencyKey, status: 'skipped', reason: 'dry_run', parentTweetId: it.parentTweetId, kind: it.kind });
    }
    appendJsonl(PATHS.runs, run);
    state.lastRunAtEt = tsEt;
    state.lastRunSummary = { status: 'dry_run', attempted: toProcess.length };
    if (run.policySkips >= 5) {
    run.note = `policy_skip_spike:${run.policySkips}`;
    console.warn(JSON.stringify({
      event: 'policy_skip_spike',
      policySkips: run.policySkips,
      tsEt,
      source: 'x_post_queue_consumer_api'
    }));
  }

  writeJson(PATHS.state, state);
    console.log(JSON.stringify({ status: 'dry_run', attempted: toProcess.length, posted: 0, failed: 0, liveUrls: [] }, null, 2));
    return;
  }

  // refresh token -> access token (preferred)
  let access = null;
  try {
    const refreshed = await refreshAccessToken(cfg, tokens);

    const newTokens = { ...tokens, ...refreshed, savedAt: tsEt };
    writeJson(PATHS.oauthTokens, newTokens);
    chmodSync(PATHS.oauthTokens, 0o600);

    access = refreshed.access_token;
    if (!access) throw new Error('refresh response missing access_token');
    run.refresh = { ok: true };
  } catch (e) {
    const msg = String(e?.message || e);
    // @ts-ignore
    const httpStatus = e?.httpStatus;
    run.refresh = { ok: false, error: msg, httpStatus };

    // auth outage: open breaker + skip_auth everything (retryable)
    if (httpStatus === 400 || httpStatus === 401) {
      setBreaker({ open: true, reason: `refresh_failed:${msg}`, cooldownMinutes: 30, tsEt });
      run.auth = { needsReauth: true, reason: msg, where: 'refresh' };
      for (const it of toProcess) {
        state.skipped[it.idempotencyKey] = { tsEt, reason: `skipped_auth:${msg}`, kind: it.kind, parentTweetId: it.parentTweetId || '', sourceJob: it.sourceJob || '' };
        run.failedOrSkipped.push({ idempotencyKey: it.idempotencyKey, status: 'skipped', reason: `auth:${msg}`, parentTweetId: it.parentTweetId || '', kind: it.kind });
      }
      state.lastRunAtEt = tsEt;
      state.lastRunSummary = { status: 'noop', attempted: 0, posted: 0, skipped: run.failedOrSkipped.length };
      if (run.policySkips >= 5) {
    run.note = `policy_skip_spike:${run.policySkips}`;
    console.warn(JSON.stringify({
      event: 'policy_skip_spike',
      policySkips: run.policySkips,
      tsEt,
      source: 'x_post_queue_consumer_api'
    }));
  }

  writeJson(PATHS.state, state);
      appendJsonl(PATHS.runs, run);
      console.log(JSON.stringify({ status: 'noop', attempted: 0, posted: 0, failed: 0, liveUrls: [] }, null, 2));
      return;
    }

    // fallback to last saved access token (may still be valid)
    if (tokens.access_token) {
      access = tokens.access_token;
      run.refresh.fallback = 'used_saved_access_token';
    } else {
      throw e;
    }
  }

  for (const it of toProcess) {
    if ((postedCountSince(state, 60 * 60 * 1000)) >= hourlyCap) {
      state.skipped[it.idempotencyKey] = { tsEt, reason: 'skipped_rate_limit:hourly_cap', kind: it.kind, parentTweetId: it.parentTweetId || '', sourceJob: it.sourceJob || '' };
      run.failedOrSkipped.push({ idempotencyKey: it.idempotencyKey, status: 'skipped', reason: 'rate_limit:hourly_cap', parentTweetId: it.parentTweetId || '', kind: it.kind, text: it.text });
      continue;
    }
    if ((postedCountSince(state, 24 * 60 * 60 * 1000)) >= dailyCap) {
      state.skipped[it.idempotencyKey] = { tsEt, reason: 'skipped_rate_limit:daily_cap', kind: it.kind, parentTweetId: it.parentTweetId || '', sourceJob: it.sourceJob || '' };
      run.failedOrSkipped.push({ idempotencyKey: it.idempotencyKey, status: 'skipped', reason: 'rate_limit:daily_cap', parentTweetId: it.parentTweetId || '', kind: it.kind, text: it.text });
      continue;
    }
    if (Date.now() > deadlineMs) {
      run.budgetExhausted = true;
      state.failed ||= {};
      state.skipped[it.idempotencyKey] = {
        tsEt,
        reason: 'budget_exhausted',
        kind: it.kind,
        parentTweetId: it.parentTweetId || '',
        sourceJob: it.sourceJob || '',
      };
      run.failedOrSkipped.push({
        idempotencyKey: it.idempotencyKey,
        status: 'skipped',
        reason: 'budget_exhausted',
        parentTweetId: it.parentTweetId || '',
        kind: it.kind,
        text: it.text,
      });
      continue;
    }

    const scopeViolation = violatesScope(it.text);
    const styleViolation = violatesGeoffVoice(it);
    const metaViolation = violatesMetaLabels(it.text);
    const repetitionViolation = isForceDailyIntent(it) ? null : violatesRepetition(it.text, state, it);
    const personaViolation = violatesPersonaBoundary(it);
    const adaptiveViolation = violatesAdaptiveFields(it);
    const bankrbotViolation = violatesBankrbotCommand(it.text);
    if (scopeViolation || styleViolation || metaViolation || repetitionViolation || personaViolation || adaptiveViolation || bankrbotViolation) {
      const reason = scopeViolation || styleViolation || metaViolation || repetitionViolation || personaViolation || adaptiveViolation || bankrbotViolation;
      // policy gate is a SKIP, not a terminal failure (text can be edited and requeue)
      state.skipped[it.idempotencyKey] = { tsEt, reason: `policy_gate:${reason}`, kind: it.kind, parentTweetId: it.parentTweetId || '', sourceJob: it.sourceJob || '' };
      quarantineIntent(it, `policy_gate:${reason}`, tsEt);
      run.policySkips += 1;
      run.failedOrSkipped.push({ idempotencyKey: it.idempotencyKey, status: 'skipped', reason: `policy_gate:${reason}`, parentTweetId: it.parentTweetId || '', kind: it.kind, text: it.text });
      continue;
    }

    if (!isApiEligibleThreadIntent(it, state)) {
      const reason = 'api_blocked_not_mentioned_browser_required';
      state.skipped[it.idempotencyKey] = { tsEt, reason, kind: it.kind, parentTweetId: it.parentTweetId || '', sourceJob: it.sourceJob || '' };
      enqueueBrowserFallback(it, reason, tsEt);
      run.failedOrSkipped.push({ idempotencyKey: it.idempotencyKey, status: 'skipped', reason, parentTweetId: it.parentTweetId || '', kind: it.kind, text: it.text });
      continue;
    }

    run.attempted += 1;
    try {
      const payload = buildPayload(it, state);
      const res = await postTweet(access, payload);
      const tweetId = res?.data?.id;
      if (!tweetId) throw new Error(`missing tweet id in response: ${JSON.stringify(res)}`);
      const url = `https://x.com/antihunterai/status/${tweetId}`;

      state.posted[it.idempotencyKey] = {
        tsEt,
        url,
        parentTweetId: it.parentTweetId || '',
        kind: it.kind,
        text: it.text,
        sourceJob: it.sourceJob || '',
        arm: it.arm || '',
        imageModel: it.imageModel || '',
        mediaPath: it.mediaPath || it.media || '',
        archetype: it.archetype || '',
        angle: it.angle || '',
        packaging: it.packaging || null,
      };
      // clear any prior retryable skip
      if (state.skipped?.[it.idempotencyKey]) delete state.skipped[it.idempotencyKey];
      run.posted.push({ idempotencyKey: it.idempotencyKey, url, tweetId, parentTweetId: it.parentTweetId || '', kind: it.kind, text: it.text });
      maybeRecordRewardPromise(it, url, tsEt);
    } catch (e) {
      const msg = String(e?.message || e);
      // @ts-ignore
      const httpStatus = e?.httpStatus;

      if (httpStatus === 401) {
        // retryable auth failure: do not burn into failed
        setBreaker({ open: true, reason: `post_401:${msg}`, cooldownMinutes: 30, tsEt });
        run.auth = { needsReauth: true, reason: msg, where: 'post' };
        state.skipped[it.idempotencyKey] = { tsEt, reason: `skipped_auth:${msg}`, kind: it.kind, parentTweetId: it.parentTweetId || '', sourceJob: it.sourceJob || '' };
        run.failedOrSkipped.push({ idempotencyKey: it.idempotencyKey, status: 'skipped', reason: `auth_401:${msg}`, parentTweetId: it.parentTweetId || '', kind: it.kind, text: it.text, httpStatus });
        continue;
      }

      const klass = httpStatus && Number(httpStatus) >= 500 ? 'transient' : 'permanent';
      state.failed[it.idempotencyKey] = { tsEt, reason: msg, class: klass, httpStatus: httpStatus || null, kind: it.kind, parentTweetId: it.parentTweetId || '' };
      run.failedOrSkipped.push({ idempotencyKey: it.idempotencyKey, status: 'failed', reason: msg, parentTweetId: it.parentTweetId || '', kind: it.kind, text: it.text, httpStatus });
    }
  }

  state.lastRunAtEt = tsEt;
  state.lastRunSummary = {
    status: run.budgetExhausted
      ? 'budget_exhausted'
      : (run.posted.length > 0 ? 'ok' : 'no_posts'),
    attempted: run.attempted,
    posted: run.posted.length,
    failed: run.failedOrSkipped.filter((x) => x.status === 'failed').length,
    skipped: run.failedOrSkipped.filter((x) => x.status === 'skipped').length,
    budgetExhausted: run.budgetExhausted,
  };

  if (run.policySkips >= 5) {
    run.note = `policy_skip_spike:${run.policySkips}`;
    console.warn(JSON.stringify({
      event: 'policy_skip_spike',
      policySkips: run.policySkips,
      tsEt,
      source: 'x_post_queue_consumer_api'
    }));
  }

  writeJson(PATHS.state, state);
  appendJsonl(PATHS.runs, run);

  const liveUrls = run.posted.map((p) => p.url);
  console.log(JSON.stringify({ status: state.lastRunSummary.status, attempted: run.attempted, posted: run.posted.length, failed: state.lastRunSummary.failed, liveUrls }, null, 2));
  } finally {
    releaseLock(LOCK_PATH);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

function isSelfParentByUrl(it) {
  const u = String(it?.parentUrl || it?.anchorUrl || '').toLowerCase();
  return u.includes('/antihunterai/status/');
}

function containsForbiddenHandle(text) {
  const t = String(text || '').toLowerCase();
  return t.includes('@bankrbot');
}

function isApiEligibleThreadIntent(it, state = null) {
  const kind = String(it?.kind || '').toLowerCase();
  if (!(kind === 'reply' || kind === 'quote')) return true;

  // New rule (2026-03-01): API posting is blocked for thread actions unless
  // we have evidence the account is mentioned/part of that thread.
  const telemetry = it?.adaptivityTelemetry || {};
  const surface = String(telemetry?.opportunitySurface || it?.surface || '').toLowerCase();
  const sourceJob = String(it?.sourceJob || '').toLowerCase();
  const parentUrl = String(it?.parentUrl || it?.anchorUrl || '').toLowerCase();

  const explicitMentionSignals = [
    telemetry?.mentioned,
    telemetry?.isMentioned,
    telemetry?.mentionContext,
    telemetry?.inThreadContext,
  ].some(Boolean);

  const parentFromOwnPostedThread = Boolean(
    it?.parentIdempotencyKey && state?.posted?.[it.parentIdempotencyKey]?.url
  );

  const impliedMentionSignals =
    surface === 'mentions_timeline' ||
    sourceJob.includes('mentions') ||
    parentUrl.includes('/antihunterai/status/');

  return explicitMentionSignals || impliedMentionSignals || parentFromOwnPostedThread;
}


