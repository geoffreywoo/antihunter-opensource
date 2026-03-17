# x_engagement_generator_contract_v1

Canonical contract for the X engagement generator.

## Inputs
- `memory/x_engagement_policy_decisions.jsonl`
- `playbooks/public_persona_unified_v1.md` (persona authority)

## Output
Append JSONL intents to `memory/public_intents_queue.jsonl` with:
- `surface: "x"`
- `status: "queued"`
- `mode: "queue_only"`
- required identity fields (`kind`, `text`, `parentUrl`, `parentTweetId`, `idempotencyKey`, `persona`, `priority`, `sourceJob`)
- required telemetry fields (`mediaAttached`, `mediaType`, `authenticity`, `irlCreditGranted`)

## Hard rules
- One intent max per parent tweet id.
- Ground every reply in concrete parent context.
- No templates / canned scaffolds.
- No money-move command instructions.
- Sigil/proof language only when `sigilDetected=true`.
- If no media and sigil claim context exists: deny IRL credit + request proof.
- If synthetic media: deny IRL credit.
- Respect anti-scam filters and blocked domains.
- **Do not generate `reply`/`quote` unless mention/thread-eligible**:
  - mention-eligible: `mentionsAntiHunterHandle=true`
  - thread-eligible: prior Anti Hunter participation in `threadContext.roleCounts.self > 0`
- For non-mention + non-thread candidates: default `skip`.
- Rare exception path (strict): only highest-quality parent contexts (`reason=verified_irl_sigil_qt_reward_scaled` or `priority_geoff_tags_antihunter`) may emit a `quote`.
- Browser fallback is scarce capacity; generator must optimize for low-volume/high-quality, never volume.

## Priority lane
- P0 when `sigilDetected=true` and media includes video.
- P0 defaults: `kind=quote`, `priority=0`, include SLA telemetry.

## Quality gate
- One rewrite max for weak drafts.
- Skip only if still generic/incoherent/off-topic after rewrite.

## Notes
- Mechanism-token matching is deprecated and must not be used as a blocking gate.
