#!/usr/bin/env node

import fs from 'node:fs';
import crypto from 'node:crypto';
import { appendIntent as appendPublicIntent } from './lib/public_intents_writer.mjs';

const TZ = 'America/New_York';
const ROOT = process.cwd();

function readJson(p) {
	return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function etDateISO(d = new Date()) {
	return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function dayDiffISO(day0, dayN) {
	const [y0, m0, d0] = day0.split('-').map(Number);
	const [y1, m1, d1] = dayN.split('-').map(Number);
	const t0 = Date.UTC(y0, m0 - 1, d0);
	const t1 = Date.UTC(y1, m1 - 1, d1);
	return Math.floor((t1 - t0) / (24 * 60 * 60 * 1000));
}

function sha1(s) {
	return crypto.createHash('sha1').update(s).digest('hex');
}

function fmtUsd0(n) {
	// IMPORTANT: avoid leading "$" amounts in X posts; X is mangling "$334,633" into ",633".
	// we print as "334,633 usd" instead.
	if (n == null || !Number.isFinite(n)) return '0';
	return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(n);
}

function enforce280(text) {
	if (text.length <= 280) return text;
	const lines = text.split('\n');
	while (lines.length && lines.join('\n').length > 280) {
		let removed = false;
		// drop trailing position lines first
		for (let i = lines.length - 1; i >= 0; i--) {
			if (lines[i].startsWith('- $')) {
				lines.splice(i, 1);
				removed = true;
				break;
			}
		}
		if (!removed) lines.pop();
	}
	return lines.join('\n').trim();
}

function assertTreasuryFormat(tweets) {
	// hard guardrails so formatting doesn’t slip.
	// requirements:
	// - first tweet has total line
	// - every position line includes chain in parens
	// - cryptopunk line includes "33 eth" and a usd equivalent "(~$... )"
	const all = tweets.join('\n').split('\n').map((s) => s.trim()).filter(Boolean);
	const totalLine = all.find((l) => l.startsWith('total: '));
	if (!totalLine) throw new Error('treasury format violation: missing total line');
	if (!totalLine.endsWith(' usd')) throw new Error('treasury format violation: total line must end with " usd"');
	const pos = all.filter((l) => l.startsWith('- ')).filter((l) => !l.startsWith('- basescan') && !l.startsWith('- etherscan'));
	for (const l of pos) {
		if (!l.includes('(') || !l.includes('):')) throw new Error(`treasury format violation: missing chain label in line: ${l}`);
		if (l.includes('$')) throw new Error(`treasury format violation: position line must not include '$' cashtag: ${l}`);
	}
	const punk = pos.find((l) => l.toLowerCase().includes('cryptopunk #5730'));
	if (!punk) throw new Error('treasury format violation: missing cryptopunk #5730 line');
	if (!punk.toLowerCase().includes('33 eth')) throw new Error('treasury format violation: cryptopunk line must include "33 eth"');
	if (!punk.includes('(~')) throw new Error('treasury format violation: cryptopunk line must include usd equivalent "(~...)"');
	if (!punk.toLowerCase().includes(' usd')) throw new Error('treasury format violation: cryptopunk line must include "usd"');
}

function splitIntoTweets(lines, { headerLines = [], footerLines = [] } = {}) {
	const tweets = [];
	let buf = [...headerLines];
	for (const ln of lines) {
		const candidate = [...buf, ln].join('\n');
		if (candidate.length <= 280) {
			buf.push(ln);
			continue;
		}
		// finalize current tweet (no footer yet)
		if (buf.length > 0) tweets.push(buf.join('\n').trim());
		buf = [ln];
	}
	if (buf.length > 0) tweets.push(buf.join('\n').trim());

	// apply footer (scan links) to last tweet if it fits; otherwise append a new tweet.
	if (footerLines.length) {
		if (tweets.length === 0) tweets.push('');
		const last = tweets[tweets.length - 1];
		const withFooter = [last, '', ...footerLines].join('\n').trim();
		if (withFooter.length <= 280) tweets[tweets.length - 1] = withFooter;
		else tweets.push(['', ...footerLines].join('\n').trim());
	}

	return tweets.map((t) => enforce280(t));
}


function buildTweetFromSnapshot(snapshot, day, { minUsd = 100 } = {}) {
	const rows = Array.isArray(snapshot?.rows) ? snapshot.rows : [];
	const snapshotTotalUsd = Number(snapshot?.totalUsd ?? 0);

	// derive eth-usd from snapshot eth rows (base preferred) so we stay consistent with site snapshot pricing.
	const ethRows = rows.filter((r) => String(r.symbol || '').toLowerCase() === 'eth');
	let ethPriceUsd = null;
	for (const r of ethRows) {
		if (String(r.chain || '').toLowerCase() !== 'base') continue;
		const bal = Number(r.balance || 0);
		const usd = Number(r.fmvUsd || 0);
		if (bal > 0 && usd > 0) { ethPriceUsd = usd / bal; break; }
	}
	if (ethPriceUsd == null) {
		for (const r of ethRows) {
			const bal = Number(r.balance || 0);
			const usd = Number(r.fmvUsd || 0);
			if (bal > 0 && usd > 0) { ethPriceUsd = usd / bal; break; }
		}
	}

	// cryptopunk mark policy: treat as 33 eth, assume liquid, and include usd equiv in total.
	const punkRow = rows.find((r) => String(r.symbol || '').toLowerCase() === 'cryptopunk #5730');
	const punkEth = punkRow ? Number(punkRow.costBasisEth ?? 33) : 33;
	const punkSnapshotUsd = punkRow ? Number(punkRow.fmvUsd ?? 0) : 0;
	const punkMarkedUsd = (ethPriceUsd != null) ? punkEth * ethPriceUsd : punkSnapshotUsd;
	const totalUsd = snapshotTotalUsd - punkSnapshotUsd + punkMarkedUsd;

	const lines = [];
	lines.push(`agentic crypto treasury for @antihunterai: day ${day}`);
	lines.push(`total: ${fmtUsd0(totalUsd)} usd`);
	lines.push('');

	// include only positions with FMV >= $100 (website heuristics already baked into snapshot.fmvUsd,
	// including sBNKR split handling)
	const mapped = rows.map((r) => {
		const symRaw = String(r.symbol || '').trim();
		const sym = symRaw ? symRaw.toUpperCase() : '';
		const usd = Number(r.fmvUsd ?? 0);
		const isPunk = symRaw.toLowerCase().startsWith('cryptopunk #');
		const punkEthLocal = isPunk ? Number(r.costBasisEth ?? 33) : 0;
		return { sym, usd, raw: r, isPunk, punkEth: punkEthLocal };
	});

	// include only positions with FMV >= $100, plus special-case cryptopunk mark (33 eth) per policy.
	const kept = mapped.filter((x) => {
		if (!x.sym) return false;
		if (x.isPunk) return true;
		return Number.isFinite(x.usd) && x.usd >= minUsd;
	});

	kept.sort((a, b) => (b.usd || 0) - (a.usd || 0));

	for (const r of kept) {
		const ch = String(r.raw.chain || '').toLowerCase() || 'unknown';
		if (r.isPunk) {
			const usdEq = Number.isFinite(punkMarkedUsd) ? fmtUsd0(punkMarkedUsd) : fmtUsd0(r.usd);
			lines.push(`- ${r.raw.symbol} (${ch}): ${punkEth} eth (~${usdEq} usd)`);
			continue;
		}
		// keep lines compact so we can include more positions
		// NOTE: avoid $TOKEN cashtags here; X is stripping them in the rendered tweet.
		lines.push(`- ${r.sym.toLowerCase()} (${ch}): ${fmtUsd0(r.usd)} usd`);
	}

	lines.push('');
	const bases = Array.isArray(snapshot?.basescans) ? snapshot.basescans : [snapshot?.basescan].filter(Boolean);
	if (bases[0]) lines.push(`basescan (primary): ${bases[0]}`);
	if (bases[1]) lines.push(`basescan (reserve): ${bases[1]}`);
	if (snapshot?.etherscan) lines.push(`etherscan (reserve): ${snapshot.etherscan}`);

	return lines.join('\n');
}

function main() {
	const anchorPath = `${ROOT}/memory/treasury_day_anchor.json`;
	const anchor = fs.existsSync(anchorPath) ? readJson(anchorPath) : { day0DateET: '2026-02-06' };
	const today = etDateISO();
	const day = dayDiffISO(anchor.day0DateET || '2026-02-06', today);

	const snapPath = `${ROOT}/antihunter-site/public/treasury.snapshot.json`;
	if (!fs.existsSync(snapPath)) throw new Error(`missing ${snapPath} (run site snapshot job first)`);
	const snapshot = readJson(snapPath);

	const raw = buildTweetFromSnapshot(snapshot, day, { minUsd: 100 });
	const rawLines = raw.split('\n');
	const headerLines = rawLines.slice(0, 3); // title, total, blank
	const positionLines = rawLines.filter((l) => l.startsWith('- '));
	const footerLines = rawLines.filter((l) => l.startsWith('basescan') || l.startsWith('etherscan'));

	const tweets = splitIntoTweets(positionLines, { headerLines, footerLines });
	assertTreasuryFormat(tweets);

	// "this job always deprecates": stable per-day idempotency keys so reruns replace prior queued intents.
	const rootKey = sha1(`root|treasury|${today}`);

	const nowIso = new Date().toISOString();
	appendPublicIntent({
		tsEt: nowIso,
		sourceJob: 'x_treasury_report_nightly_post_2130et',
		runId: `enqueue-${nowIso}`,
		kind: 'root',
		text: tweets[0],
		idempotencyKey: rootKey,
		status: 'queued',
		surface: 'x',
		mode: 'queue_only',
		approvalRequired: false,
		bucket: 'TREASURY',
		priority: 0,
		persona: 'anti_hunter',
		anchorUrl: 'https://antihunter.com/treasury',
		opportunityId: `treasury-${today}-root`,
		decisionId: `treasury-${today}-root`,
		adaptivityTelemetry: {
			anchorType: 'url',
			bucket: 'TREASURY',
			freshInputsUsed: ['treasury_snapshot'],
			similarityMax: 0,
			rejectedForSimilarityCount: 0,
			forceDailyPost: 'treasury_daily',
		},
	});

	const replyKeys = [];
	let prevKey = rootKey;
	for (let i = 1; i < tweets.length; i++) {
		const k = sha1(`reply|treasury|${today}|${i}`);
		replyKeys.push(k);
		appendPublicIntent({
			tsEt: nowIso,
			sourceJob: 'x_treasury_report_nightly_post_2130et',
			runId: `enqueue-${nowIso}`,
			kind: 'reply',
			text: tweets[i],
			parentIdempotencyKey: prevKey,
			idempotencyKey: k,
			status: 'queued',
			surface: 'x',
			mode: 'queue_only',
			approvalRequired: false,
			bucket: 'TREASURY',
			priority: 0,
			persona: 'anti_hunter',
			anchorUrl: 'https://antihunter.com/treasury',
			opportunityId: `treasury-${today}-${i}`,
			decisionId: `treasury-${today}-${i}`,
			adaptivityTelemetry: {
				anchorType: 'url',
				bucket: 'TREASURY',
				freshInputsUsed: ['treasury_snapshot'],
				similarityMax: 0,
				rejectedForSimilarityCount: 0,
				forceDailyPost: 'treasury_daily',
			},
		});
		prevKey = k;
	}

	process.stdout.write(
		JSON.stringify({ ok: true, day, dateET: today, queued: { root: rootKey, replies: replyKeys }, tweetCount: tweets.length }, null, 2) + '\n'
	);
}

main();
