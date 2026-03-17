#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendIntent as appendPublicIntent } from './lib/public_intents_writer.mjs';

const ROOT = process.cwd();
const TZ = 'America/New_York';
const LAST24H_MS = 24 * 60 * 60 * 1000;
const MAX_TWEETS = 6;
const SHIPPING_NOTES_ARTIFACT = path.join(ROOT, 'memory/public_agent/shipping_notes_latest.json');

const SITE_DIR = path.join(ROOT, 'antihunter-site');

function runSiteChangelogRollup() {
  const p = spawnSync('npm', ['run', '-s', 'changelog:nightly'], {
    cwd: SITE_DIR,
    encoding: 'utf8',
    timeout: 120000,
  });
  if (p.status !== 0) {
    const stderr = String(p.stderr || '').trim();
    const stdout = String(p.stdout || '').trim();
    throw new Error(`shipping receipt blocked: changelog:nightly failed (${p.status}) ${stderr || stdout || ''}`.trim());
  }

  const v = spawnSync('npm', ['run', '-s', 'changelog:validate'], {
    cwd: SITE_DIR,
    encoding: 'utf8',
    timeout: 30000,
  });
  if (v.status !== 0) {
    const stderr = String(v.stderr || '').trim();
    const stdout = String(v.stdout || '').trim();
    throw new Error(`shipping receipt blocked: changelog validation failed (${v.status}) ${stderr || stdout || ''}`.trim());
  }
}

function parseTodayChangelogEntry() {
  const fp = path.join(SITE_DIR, 'src', 'data', 'changelog.json');
  if (!fs.existsSync(fp)) throw new Error('shipping receipt blocked: changelog.json missing');

  const today = dateEt(new Date());
  const src = fs.readFileSync(fp, 'utf8');
  const re = new RegExp(`\{[\s\S]*?day:\s*(\d+)\s*,[\s\S]*?date:\s*'${today}'[\s\S]*?summary:\s*\n\s*'([\s\S]*?)',[\s\S]*?links:\s*\[([\s\S]*?)\]\s*,?[\s\S]*?\n\t\},`, 'm');
  const m = src.match(re);
  if (!m) throw new Error(`shipping receipt blocked: no changelog entry for ${today}`);

  const day = Number.parseInt(m[1], 10);
  const summary = normalize(String(m[2] || '').replace(/\n\s*/g, ' '));
  const linksBlob = String(m[3] || '');
  const links = Array.from(new Set((linksBlob.match(/https?:\/\/[^'"\s)]+/g) || [])));

  return { day, date: today, summary, links };
}

function sentenceChunks(text, max = 3) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return [];
  const parts = raw
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean);
  if (!parts.length) return [];

  const out = [];
  for (const part of parts) {
    if (out.length >= max) break;
    out.push(part);
  }
  return out;
}

// Core mandate:
// shipping receipts must read like a narrative changelog, not a telemetry dump.
// avoid repetitive section-template phrasing and explain what changed + why it matters.

function sha1(s) {
  return crypto.createHash('sha1').update(s).digest('hex');
}

function enforce280(text) {
  const s = String(text ?? '').trim();
  if (s.length <= 280) return s;
  return s.slice(0, 277).trimEnd() + '…';
}


function loadQueuedKeys() {
  const p = `${ROOT}/memory/public_intents_queue.jsonl`;
  if (!fs.existsSync(p)) return new Set();
  const keys = new Set();
  for (const ln of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!ln.trim()) continue;
    try {
      const o = JSON.parse(ln);
      if (o?.idempotencyKey) keys.add(o.idempotencyKey);
    } catch {}
  }
  return keys;
}

function dateEt(value = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value);
}

function isFreshShippingNotesPayload(payload, now = new Date()) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('shipping receipt blocked: unified shipping notes payload invalid');
  }

  const today = dateEt(now);
  if (payload.date !== today) {
    throw new Error(`shipping receipt blocked: unified shipping notes stale (date ${payload.date || 'missing'} != ${today})`);
  }

  const generatedAt = payload?.generatedAt ? parseDateMs(payload.generatedAt) : null;
  if (!generatedAt || !inWindow(generatedAt, new Date(`${today}T00:00:00-05:00`).getTime(), now.getTime())) {
    throw new Error('shipping receipt blocked: unified shipping notes missing generatedAt or stale');
  }

  const thread = Array.isArray(payload.xThread) ? payload.xThread : [];
  if (!thread.length) {
    throw new Error('shipping receipt blocked: unified shipping notes missing xThread');
  }

  return thread;
}

function parseDateMs(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : null;
}

function inWindow(ms, sinceMs, toMs) {
  return Number.isFinite(ms) && ms >= sinceMs && ms <= toMs;
}

function normalize(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function getDayFromBase() {
  const statePath = path.join(ROOT, 'memory', 'x_shipping_post_state.json');
  if (!fs.existsSync(statePath)) return 0;
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const base = state?.baseDateET || '2026-02-06';
    const baseTs = parseDateMs(`${base}T00:00:00-05:00`);
    const todayEt = dateEt(new Date());
    const todayTs = parseDateMs(`${todayEt}T00:00:00-05:00`);
    if (!Number.isFinite(baseTs) || !Number.isFinite(todayTs)) return 0;
    return Math.max(0, Math.floor((todayTs - baseTs) / (24 * 60 * 60 * 1000)));
  } catch {
    return 0;
  }
}

function resolveRepoLogRef() {
  // swarm-aware default: require remote-tracking branch so receipts reflect pushed work across machines.
  const preferred = process.env.SHIP_LOG_REF || 'origin/main';
  const checkPreferred = spawnSync('git', ['-C', ROOT, 'rev-parse', '--verify', preferred], { encoding: 'utf8' });
  if (checkPreferred.status === 0) return preferred;

  const checkOriginHead = spawnSync('git', ['-C', ROOT, 'symbolic-ref', 'refs/remotes/origin/HEAD'], { encoding: 'utf8' });
  if (checkOriginHead.status === 0) {
    const ref = String(checkOriginHead.stdout || '').trim();
    const checkRef = spawnSync('git', ['-C', ROOT, 'rev-parse', '--verify', ref], { encoding: 'utf8' });
    if (checkRef.status === 0) return ref;
  }

  throw new Error('shipping receipt requires remote ref (origin/main unavailable)');
}

function refreshRemote() {
  // best effort; do not fail run if network/git is temporarily unavailable
  spawnSync('git', ['-C', ROOT, 'fetch', '--prune', 'origin'], { encoding: 'utf8', timeout: 20000 });
}

function parseGitCommits(sinceIso, sinceMs, toMs) {
  refreshRemote();
  const ref = resolveRepoLogRef();
  const p = spawnSync('git', [
    '-C', ROOT,
    'log',
    ref,
    '--no-merges',
    '--since', sinceIso,
    '--pretty=format:%h\x7f%ct\x7f%s',
    '--max-count=220',
  ], { encoding: 'utf8' });

  if (p.status !== 0) return [];
  const out = [];
  const seen = new Set();

  for (const row of String(p.stdout || '').split('\n').map(x => x.trim()).filter(Boolean)) {
    const [hash, t, ...rest] = row.split('\x7f');
    const ts = Number.parseInt(t, 10) * 1000;
    if (!inWindow(ts, sinceMs, toMs)) continue;
    const subject = normalize(rest.join('\x7f'));
    if (!subject) continue;
    if (subject.includes('anti fund') || subject.includes('antifund') || subject.includes('jake paul') || subject.includes('logan paul')) continue;

    const strong = /(ship|add|build|implement|fix|improve|refactor|harden|migrate|wire|launch|support)/.test(subject);
    if (!strong) continue;

    // hardening: drop low-signal chores unless clearly architecture-impact
    const infraImpact = /(mission control|multi-host|multi host|multi-mac|mac mini|gateway|cron manifest|sync|failover|watchdog|mutex|orchestrat|node)/.test(subject);
    if (subject.startsWith('chore:') && !infraImpact) continue;

    const line = `commit ${hash}: ${subject}`;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push({ ts, text: line, infraImpact });
  }

  out.sort((a, b) => b.ts - a.ts);
  return out;
}

function parseChangelog(sinceMs, toMs) {
  const fp = path.join(ROOT, 'antihunter-site', 'src', 'data', 'changelog.json');
  if (!fs.existsSync(fp)) return [];
  const text = fs.readFileSync(fp, 'utf8');
  const re = /\{\s*day:\s*(\d+)\s*,\s*date:\s*'([^']+)'[\s\S]*?summary:\s*'([\s\S]*?)',[\s\S]*?\n\t\},/g;

  const out = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(text))) {
    const dayNum = Number.parseInt(m[1], 10);
    const dateLabel = m[2];
    const summary = normalize(m[3].replace(/\n\s*/g, ' '));
    const dayStart = parseDateMs(`${dateLabel}T00:00:00-05:00`);
    const dayEnd = dayStart == null ? null : dayStart + 24 * 60 * 60 * 1000;
    if (!Number.isFinite(dayStart) || !Number.isFinite(dayEnd)) continue;
    if (dayEnd < sinceMs || dayStart > toMs) continue;
    if (!summary) continue;
    const line = `changelog day ${dayNum}: ${summary}`;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push({ ts: dayStart, text: line });
  }

  out.sort((a, b) => b.ts - a.ts);
  return out;
}

function parseStrategyNotes(sinceMs, toMs) {
  const memDir = path.join(ROOT, 'memory');
  if (!fs.existsSync(memDir)) return [];
  const out = [];
  const seen = new Set();
  const kw = /(strategy|thesis|roadmap|priority|focus|decision|plan|pivot|positioning|go-to-market|gtm)/;

  for (const f of fs.readdirSync(memDir)) {
    const m = f.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
    if (!m) continue;
    const d = m[1];
    const dayStart = parseDateMs(`${d}T00:00:00-05:00`);
    const dayEnd = dayStart + 24 * 60 * 60 * 1000;
    if (dayEnd < sinceMs || dayStart > toMs) continue;

    const lines = fs.readFileSync(path.join(memDir, f), 'utf8').split('\n');
    for (const ln of lines) {
      const s = ln.trim();
      if (!s || (!s.startsWith('- ') && !s.startsWith('* '))) continue;
      const body = normalize(s.replace(/^[-*]\s*/, ''));
      if (body.length < 20) continue;
      if (!kw.test(body)) continue;
      if (body.includes('anti fund') || body.includes('antifund') || body.includes('jake paul') || body.includes('logan paul')) continue;
      if (seen.has(body)) continue;
      seen.add(body);
      out.push({ ts: dayStart + 3600_000, text: body });
    }
  }

  out.sort((a, b) => b.ts - a.ts);
  return out;
}

function parseInfraArchitecture(commits, sinceMs, toMs) {
  const out = [];
  const seen = new Set();
  const infraKw = /(mission control|multi-host|multi host|multi-mac|mac mini|gateway|cron manifest|sync|failover|watchdog|mutex|orchestrat|node)/;

  for (const c of commits) {
    const txt = normalize(c.text);
    if (!infraKw.test(txt)) continue;
    if (seen.has(txt)) continue;
    seen.add(txt);
    let clean = txt.replace(/^commit\s+[a-f0-9]+:\s*/, '');
    clean = clean.replace(/^chore:\s*/, 'infra hardening: ');
    out.push({ ts: c.ts, text: clean });
  }

  const opsDir = path.join(ROOT, 'memory', 'ops');
  if (fs.existsSync(opsDir)) {
    for (const f of fs.readdirSync(opsDir)) {
      if (!f.endsWith('.md')) continue;
      const fp = path.join(opsDir, f);
      const st = fs.statSync(fp);
      const ts = st.mtimeMs;
      if (!inWindow(ts, sinceMs, toMs)) continue;
      const lines = fs.readFileSync(fp, 'utf8').split('\n');
      for (const ln of lines) {
        const s = normalize(ln.replace(/^[-*]\s*/, ''));
        if (s.length < 20) continue;
        if (!infraKw.test(s)) continue;
        if (seen.has(s)) continue;
        seen.add(s);
        out.push({ ts, text: s });
      }
    }
  }

  // force explicit architecture framing when mission-control style work is present
  if (out.length) {
    out.unshift({
      ts: toMs + 1,
      text: 'mission control update: strengthened multi-mac mini orchestration with tighter cron manifest sync, gateway reliability checks, and failover-safe workflow controls',
    });
  }

  out.sort((a, b) => b.ts - a.ts);
  return out;
}

function pickTop(arr, n) {
  return arr.slice(0, n).map(x => x.text);
}

function loadShippingNotesPayload() {
  if (!fs.existsSync(SHIPPING_NOTES_ARTIFACT)) {
    throw new Error(`shipping receipt blocked: unified shipping notes missing (${SHIPPING_NOTES_ARTIFACT})`);
  }

  const cached = JSON.parse(fs.readFileSync(SHIPPING_NOTES_ARTIFACT, 'utf8'));
  const tweets = isFreshShippingNotesPayload(cached);
  return { ...cached, xThread: tweets };
}

function validateThread(tweets) {
  if (!Array.isArray(tweets) || tweets.length < 2) throw new Error('shipping receipt blocked: thread too short');
  const bad = ['(fill)', 'story:', 'window:'];
  const hasUrl = tweets.some((t) => /https?:\/\//i.test(String(t || '')));
  if (!hasUrl) throw new Error('shipping receipt blocked: missing receipt url');

  for (const t of tweets) {
    const s = String(t || '').trim();
    if (!s) throw new Error('shipping receipt blocked: empty tweet');
    if (s.includes('…') || /\.\.\./.test(s)) throw new Error('shipping receipt blocked: truncated tweet text');
    if (bad.some((b) => s.toLowerCase().includes(b))) throw new Error('shipping receipt blocked: template-y text leaked');
  }

  const root = String(tweets[0] || '').toLowerCase();
  if (root.length < 40) {
    throw new Error('shipping receipt blocked: weak root narrative');
  }
}

function buildThread() {
  const payload = loadShippingNotesPayload();
  const out = Array.isArray(payload?.xThread) ? payload.xThread.slice(0, MAX_TWEETS) : [];
  validateThread(out);
  return out;
}

function main() {
  const tweets = buildThread();
  const now = new Date();
  const runId = `enqueue-${now.toISOString()}`;
  const today = dateEt(now);
  const contentHash = sha1(JSON.stringify(tweets));
  const rootKey = sha1(`root|ship|${today}|${contentHash}`);

  const queueKeys = loadQueuedKeys();
  if (queueKeys.has(rootKey)) {
    process.stdout.write(JSON.stringify({ ok: true, queued: { root: rootKey, replies: [] }, note: 'already_queued' }, null, 2) + '\n');
    return;
  }

  appendPublicIntent({
    tsEt: now.toISOString(),
    sourceJob: 'x_nightly_shipping_receipt_1935et',
    runId,
    kind: 'root',
    text: tweets[0],
    idempotencyKey: rootKey,
    status: 'queued',
    surface: 'x',
    mode: 'queue_only',
    approvalRequired: false,
    bucket: 'SHIP',
    priority: 1,
    persona: 'anti_hunter',
    anchorUrl: 'https://antihunter.com/acts',
    opportunityId: `ship-${today}-root`,
    decisionId: `ship-${today}-root`,
    adaptivityTelemetry: {
      anchorType: 'url',
      bucket: 'SHIP',
      freshInputsUsed: ['shipping_receipt'],
      similarityMax: 0,
      rejectedForSimilarityCount: 0,
      forceDailyPost: 'shipping_daily',
    },
  });

  const replyKeys = [];
  for (let i = 1; i < tweets.length; i++) {
    const text = tweets[i];
    const k = sha1(`reply|${rootKey}|${i}|${text}`);
    replyKeys.push(k);
    appendPublicIntent({
      tsEt: now.toISOString(),
      sourceJob: 'x_nightly_shipping_receipt_1935et',
      runId,
      kind: 'reply',
      text,
      parentIdempotencyKey: rootKey,
      idempotencyKey: k,
      status: 'queued',
      surface: 'x',
      mode: 'queue_only',
      approvalRequired: false,
      bucket: 'SHIP',
      priority: 1,
      persona: 'anti_hunter',
      anchorUrl: 'https://antihunter.com/acts',
      opportunityId: `ship-${today}-${i}`,
      decisionId: `ship-${today}-${i}`,
      adaptivityTelemetry: {
        anchorType: 'url',
        bucket: 'SHIP',
        freshInputsUsed: ['shipping_receipt'],
        similarityMax: 0,
        rejectedForSimilarityCount: 0,
        forceDailyPost: 'shipping_daily',
      },
    });
  }

  process.stdout.write(JSON.stringify({ ok: true, queued: { root: rootKey, replies: replyKeys }, tweetCount: tweets.length }, null, 2) + '\n');
}

try {
  main();
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(error?.message || error) }, null, 2) + '\n');
  process.exitCode = 1;
}
