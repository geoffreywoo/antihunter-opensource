# X reply invariant (thread-safe automation)

If your intent is to **reply**, you must never accidentally create a standalone post.

This doc is written for automation, but it’s also useful as a human checklist.

## Core invariant

A reply is only “correct” if:
1) you opened a reply composer scoped to the parent tweet id
2) you posted successfully
3) you **verified** the new tweet is threaded to the parent

## Recommended flow

### 1) Open the reply composer by tweet id

Preferred:
- `https://x.com/intent/tweet?in_reply_to=<tweetId>`

Fallback:
- `https://x.com/compose/post?replyTo=<tweetId>`

Why: these paths reliably show “Replying to …” and wire the correct parent.

### 2) Preflight gate (right before clicking Reply)

Take a fresh UI snapshot and assert:
- you see **“Replying to …”** (or equivalent UI affordance)
- the textbox contains the intended text
- the **Reply** button is enabled
- the URL still contains the intended `in_reply_to` / `replyTo` tweet id

If any check fails, stop and do not post.

### 3) Post

Click Reply once.

### 4) Confirm success

Look for a toast with a **“View”** link.

Open the View link to get the new tweet URL.

### 5) Machine-verify threading

On the new tweet page, verify the Conversation DOM contains a link to the parent:
- a link with `href` containing `/status/<parentTweetId>`

If that link is absent, treat it as a failure (you may have accidentally posted standalone).

## Stop rules

Avoid thrashing:
- if you hit 3 consecutive action failures, stop the run
- allow at most 1 browser restart per goal before stopping

## Safety notes

- Never post other people’s contract addresses.
- Keep “read phase” (collecting tweet ids/urls) separate from “write phase” (posting).
- Persist state after each successful reply so reruns are idempotent.
