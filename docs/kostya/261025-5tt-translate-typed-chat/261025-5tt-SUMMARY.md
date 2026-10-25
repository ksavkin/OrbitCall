---
quick_id: 261025-5tt
status: complete
completed: 2026-10-25
branch: kostya/translate-typed-chat (from origin/main b3b3e66)
key-files:
  created:
    - convex/messageTranslation.ts
    - convex/lib/lineTranslation.ts
    - tests/messageTranslation.test.ts
  modified:
    - convex/messages.ts
---

# 261025-5tt: translate typed room lines

Typed room lines were stored with empty `translations`, so an operator reading another language only ever saw the original (`original_only`). Voice phrases were already translated by the Python worker; typed lines now get the same treatment in Convex.

## Behavior

- **`messages.send`** inserts the line as before. When `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` are set, the other two languages (en/ru/zh minus the author's) are stored as `pending`, and two jobs are scheduled: `messageTranslation.translate` (now) and `messages.storeTranslations` with all-null results (in 30 s, `TRANSLATION_DEADLINE_MS`). Without a key nothing is scheduled and every other language reads the original, exactly as before.
- **`messageTranslation.translate`** (`"use node"`) calls `callClaude` once per language. A reply passes only if it carries exactly the original's number tokens (`numbersPreserved`: same digit runs with separators, none added or dropped); otherwise, or on any provider error (logged by `safeFailure` code only), that language is stored as `original_only`. One language failing never affects the other.
- **`messages.storeTranslations`** changes only languages still `pending`, so a late translation after the deadline is dropped and a landed translation is never overwritten. A deleted row is ignored.
- **`toMessage`** also reads a `pending` older than 30 s as `original_only`, so no viewer is left on "Translating" even if the scheduled expiry has not run yet.
- The Coordination Host is unaffected: `hostContext` reads `originalText`/`originalLang` only, and the input version is built from those fields, so a translation patch does not change it.

## Tests

`tests/messageTranslation.test.ts`: translated ok (pending until it lands), author reads original, number mismatch falls back for one language only, provider failure falls back, no key sends and reads original, deadline reads original and expiry settles it, expiry never overwrites a landed translation, `numbersPreserved` cases. `npm run check`: 66 files, 1572 tests pass. Web gates (`next typegen`, `tsc`, `eslint src`) pass; no web change was needed (`LiveLines` already renders `pending`, `ok` and `original_only`).

## Risks

- Each typed line costs two Claude calls on the same key and rate limit as the Analyst and Advocates.
- `callClaude` has a 90 s timeout; a translation slower than 30 s is dropped by design.
