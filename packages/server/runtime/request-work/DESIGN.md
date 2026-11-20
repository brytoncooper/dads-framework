# Request work — design

## What this lib owns

Per-request work accounting and the once-per-request answer scope
(`answeringEachQuestionOnce`). The tally rules live in `INVARIANTS.md`.

## Rules

- **outside-request-answers-reuse-nothing**: Work run through `outsideRequestAnswers`, and every timer and promise it starts, reuses no answer of the scope it was called from, even from a timer that scope set; the scope's own answers stay as they were. — proven by: answer-once.test.ts::asks again from inside a scope, and leaves the scope's own answer alone, answer-once.test.ts::asks again on a timer a scope set, where the timer alone reuses the scope's answer
