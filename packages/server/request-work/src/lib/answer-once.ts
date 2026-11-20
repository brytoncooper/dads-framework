import { AsyncLocalStorage } from "node:async_hooks";

/**
 * One request's memory of answers. Each `AnswersOncePerScope` keeps its own
 * answers per scope, so a scope holds nothing once its request ends.
 */
const currentScope = new AsyncLocalStorage<object>();

/**
 * Runs `work` with every `AnswersOncePerScope` answering each question once.
 * Inside a scope already open — the HTTP kit opens one per request — `work`
 * joins it rather than nesting, so a write anywhere in the request forgets
 * every answer the request holds. The scope must end with the request: never
 * open one around work that outlives it.
 */
export function answeringEachQuestionOnce<T>(
  work: () => Promise<T>,
): Promise<T> {
  if (currentScope.getStore() !== undefined) return work();
  return currentScope.run({}, work);
}

/**
 * Runs `work` outside any scope, so every question it asks — and every
 * question asked by the timers and promises it starts — reaches the source.
 *
 * For work a request starts that outlives it, such as a pass on a timer. A
 * timer set inside a request still runs inside that request's scope, so it
 * would answer with what the request learned; a later request's write
 * forgets only that later request's answers, never these.
 */
export function outsideRequestAnswers<T>(work: () => T): T {
  return currentScope.exit(work);
}

/**
 * Answers a repeated question once inside `answeringEachQuestionOnce`, and
 * asks every time outside it. A failed answer is asked again, never repeated.
 */
export class AnswersOncePerScope<T> {
  readonly #answersByScope = new WeakMap<object, Map<string, Promise<T>>>();

  answer(key: string, ask: () => Promise<T>): Promise<T> {
    const answers = this.#answersInScope();
    if (answers === undefined) return ask();
    const known = answers.get(key);
    if (known !== undefined) return known;
    const answer = ask();
    answers.set(key, answer);
    answer.catch(() => {
      if (answers.get(key) === answer) answers.delete(key);
    });
    return answer;
  }

  /** Forgets this scope's answers, for when the facts behind them change. */
  forget(): void {
    this.#answersInScope()?.clear();
  }

  #answersInScope(): Map<string, Promise<T>> | undefined {
    const scope = currentScope.getStore();
    if (scope === undefined) return undefined;
    const known = this.#answersByScope.get(scope);
    if (known !== undefined) return known;
    const answers = new Map<string, Promise<T>>();
    this.#answersByScope.set(scope, answers);
    return answers;
  }
}

/**
 * One value per `answeringEachQuestionOnce` scope, for state a scope holds
 * besides its answers: the questions it has gathered to send together.
 * Outside a scope there is nowhere to keep it, so `get` answers `undefined`
 * and `set` does nothing.
 */
export class OneValuePerScope<T> {
  readonly #valueByScope = new WeakMap<object, T>();

  get(): T | undefined {
    const scope = currentScope.getStore();
    return scope === undefined ? undefined : this.#valueByScope.get(scope);
  }

  set(value: T): void {
    const scope = currentScope.getStore();
    if (scope !== undefined) this.#valueByScope.set(scope, value);
  }

  /** Whether the caller is inside a scope that can keep a value. */
  inScope(): boolean {
    return currentScope.getStore() !== undefined;
  }
}
