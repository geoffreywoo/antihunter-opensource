# Model Selection Protocol (Skill Gist)

**Goal:** default to *fast + responsive* while reserving *maximum intelligence* for code + high-stakes decisions.

## Inputs
- **Provider availability:** Codex OAuth preferred; OpenAI API key fallback when OAuth is depleted/blocked.
- **Task type:** routine vs coding vs high-stakes.
- **Latency tolerance:** “chatty” work should feel instant; “ship” steps can be slower.

---

## Default hierarchy

### 1) When Codex OAuth is available (preferred)
**A. Default + most coding:** `openai-codex/gpt-5.3-codex`
- Use for: day-to-day reasoning, drafting, most coding, ops.
- Why: best balance of *smart + snappy*.

**B. Background / bulk / extraction:** `openai-codex/gpt-5.2`
- Use for: web/page digestion, list-building, summarization, triage, sub-agent work.
- Why: cheaper, still strong; minimizes burn.

### 2) When forced to OpenAI API key fallback (OAuth depleted)
**C. Routine workhorse:** `openai/gpt-5.1-codex`
- Use for: fast back-and-forth, outlines, drafts, extraction, normal ops.

**D. Coding / important:** `openai/gpt-5.2-pro`
- Use for: final code, refactors, correctness-critical work, final decision memos.
- Rule: **use sparingly** due to latency; deploy in *short bursts*.

---

## “Bursting” pattern (recommended)
To keep UX fast *and* outputs elite:
- **Phase 1 (fast):** use the workhorse for gathering facts, outlining, drafting v0.
- **Phase 2 (smart):** switch to the pro model only for the final answer/code/memo.

---

## Switchback policy
- Always prefer **Codex OAuth** when healthy.
- If on API key fallback, periodically check if OAuth is replenished, then switch back.

---

## Guardrails
- Don’t pay pro latency for routine chat.
- Use pro when mistakes are expensive: shipping code, publishing, money/security decisions.
- Keep first-draft cheap; spend tokens on the final artifact.
