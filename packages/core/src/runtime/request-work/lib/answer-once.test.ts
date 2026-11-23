/**
 * What: a scope answers each question once, a nested call joins the open
 * scope, separate scopes share nothing, and work run outside the scope (even
 * on a timer the scope set) asks again.
 * Why: the HTTP kit opens one scope per request and some queries open their
 * own inside it. A nested scope that started empty would let a write inside
 * it forget only its own answers and leave the request's stale ones behind;
 * a scope shared across requests would answer one caller with another's; and
 * work that outlives its request would keep answering from it after a later
 * request's write.
 */

import { describe, expect, it } from "vitest";

import {
  answeringEachQuestionOnce,
  AnswersOncePerScope,
  OneValuePerScope,
  outsideRequestAnswers,
} from "./answer-once.js";

function countingQuestion() {
  const answers = new AnswersOncePerScope<number>();
  let asked = 0;
  return {
    ask: () => answers.answer("question", () => Promise.resolve((asked += 1))),
    forget: () => {
      answers.forget();
    },
    asked: () => asked,
  };
}

describe("answeringEachQuestionOnce", () => {
  it("answers a repeated question once inside a scope", async () => {
    const question = countingQuestion();
    await answeringEachQuestionOnce(async () => {
      await question.ask();
      await question.ask();
    });
    expect(question.asked()).toBe(1);
  });

  it("joins an open scope, so forgetting inside forgets for the whole request", async () => {
    const question = countingQuestion();
    await answeringEachQuestionOnce(async () => {
      await question.ask();
      await answeringEachQuestionOnce(async () => {
        await question.ask();
        question.forget();
      });
      await question.ask();
    });
    expect(question.asked()).toBe(2);
  });

  it("shares nothing between separate scopes or outside one", async () => {
    const question = countingQuestion();
    await Promise.all([
      answeringEachQuestionOnce(() => question.ask()),
      answeringEachQuestionOnce(() => question.ask()),
    ]);
    await question.ask();
    expect(question.asked()).toBe(3);
  });
});

describe("outsideRequestAnswers", () => {
  it("asks again from inside a scope, and leaves the scope's own answer alone", async () => {
    const question = countingQuestion();
    await answeringEachQuestionOnce(async () => {
      await question.ask();
      expect(await outsideRequestAnswers(() => question.ask())).toBe(2);
      expect(await question.ask()).toBe(1);
    });
    expect(question.asked()).toBe(2);
  });

  // 2026-11-16: a loader-users pass on a timer a grant request set reused
  // that request's "may sign in" after a later request revoked it, and put
  // the person back on the loader roster.
  it("asks again on a timer a scope set, where the timer alone reuses the scope's answer", async () => {
    const question = countingQuestion();
    const onTimer = (ask: () => Promise<number>) =>
      new Promise<number>((resolve, reject) => {
        setTimeout(() => {
          ask().then(resolve, reject);
        }, 0);
      });

    const [inherited, outside] = await answeringEachQuestionOnce(async () => {
      await question.ask();
      return Promise.all([onTimer(() => question.ask()), onTimer(() => outsideRequestAnswers(() => question.ask()))]);
    });

    expect(inherited).toBe(1);
    expect(outside).toBe(2);
  });
});

describe("OneValuePerScope", () => {
  it("keeps one value per scope and none outside a scope", async () => {
    const values = new OneValuePerScope<string>();
    values.set("ignored");

    const [first, second] = await Promise.all([
      answeringEachQuestionOnce(async () => {
        values.set("first");
        await Promise.resolve();
        return values.get();
      }),
      answeringEachQuestionOnce(async () => {
        values.set("second");
        await Promise.resolve();
        return values.get();
      }),
    ]);

    expect([first, second]).toEqual(["first", "second"]);
    expect([values.get(), values.inScope()]).toEqual([undefined, false]);
  });
});
