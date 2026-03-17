# X Pipeline Reference Implementation (Anti Hunter)

Curated public-safe snapshot of Anti Hunter's X content pipeline hardening work.

Included:
- Canonical public intents writer modules (`scripts/lib/public_intents_writer.{py,mjs}`)
- Queue producers for treasury/shipping/reading/holder workflows
- Queue consumer (`x_post_queue_consumer_api.mjs`) and policy/voice guards
- Preflight/policy logic for API-true reply/quote constraints (403 handling)
- Guardrail/contract playbooks used by generator/consumer policy checks

Notes:
- This is a reference implementation snapshot, not a full runnable mono-repo.
- Local machine paths and private state files are intentionally excluded.
