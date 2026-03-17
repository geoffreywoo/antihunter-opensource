#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';

export const ROOT = '/Users/gwbox/.openclaw/workspace';
export const QUEUE = `${ROOT}/memory/public_intents_queue.jsonl`;

const VALID_KINDS = new Set(['root', 'reply', 'quote']);

function nowIso() {
  return new Date().toISOString();
}

function sha1(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex');
}

export function normalizeIntent(intent = {}, { sourceJob, defaultPriority = 3 } = {}) {
  const out = { ...intent };
  out.surface = String(out.surface || 'x').toLowerCase();
  out.status = String(out.status || 'queued').toLowerCase();
  out.mode = String(out.mode || 'queue_only').toLowerCase();
  out.persona = String(out.persona || 'anti_hunter');
  out.sourceJob = String(out.sourceJob || sourceJob || 'unknown_source');
  out.priority = Number.isFinite(out.priority) ? out.priority : defaultPriority;
  out.tsEt = String(out.tsEt || nowIso());

  let kind = String(out.kind || out.mode || '').toLowerCase();
  if (kind === 'queue_only') kind = 'root';
  out.kind = kind;

  const parent = String(out.parentTweetId || '');
  const text = String(out.text || '');
  if (!out.idempotencyKey) {
    out.idempotencyKey = sha1(`${kind}:${parent}:${text}`);
  }

  return out;
}

export function validateIntent(it) {
  const required = ['surface', 'status', 'mode', 'kind', 'text', 'persona', 'sourceJob', 'idempotencyKey'];
  for (const k of required) {
    if (!it[k]) throw new Error(`missing required field: ${k}`);
  }

  if (!VALID_KINDS.has(String(it.kind))) {
    throw new Error(`invalid kind: ${it.kind}`);
  }
  if (it.kind === 'reply' && !(it.parentTweetId || it.parentIdempotencyKey)) {
    throw new Error('reply missing parentTweetId/parentIdempotencyKey');
  }
  if (it.kind === 'quote' && !it.parentTweetId) {
    throw new Error('quote missing parentTweetId');
  }
}

export function appendIntent(intent, { sourceJob, defaultPriority = 3, queuePath = QUEUE } = {}) {
  const row = normalizeIntent(intent, { sourceJob, defaultPriority });
  validateIntent(row);
  fs.appendFileSync(queuePath, JSON.stringify(row) + '\n', 'utf8');
  return row;
}
