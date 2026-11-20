import { AnswersOncePerScope } from "@dads-framework/request-work";

import type { FeatureFlagState } from "../../contract/index.js";
import {
  type FeatureFlagBatchWrite,
  type FeatureFlagHistoryPage,
  FeatureFlagStore,
} from "../ports/feature-flag-store.js";

/**
 * A store that reads each set of flag states once per request.
 *
 * A request that asks many flags (a list page asking one per row) would read
 * every state for each question. Inside `answeringEachQuestionOnce` — the
 * HTTP kit opens one per request — a repeated `listStates` for the same slugs
 * shares the first read. The scope ends with its request, so no answer reaches
 * another request. A batch write forgets every answer before and after it, so
 * the request still sees its own change. Outside a scope every call reads.
 */
export class ReadStatesOnceFeatureFlagStore extends FeatureFlagStore {
  readonly #inner: FeatureFlagStore;
  readonly #states = new AnswersOncePerScope<readonly FeatureFlagState[]>();

  constructor(inner: FeatureFlagStore) {
    super();
    this.#inner = inner;
  }

  override listStates(
    slugs: readonly string[],
  ): Promise<readonly FeatureFlagState[]> {
    return this.#states.answer(JSON.stringify(slugs), () =>
      this.#inner.listStates(slugs),
    );
  }

  override listHistory(input: {
    readonly slug: string;
    readonly page: number;
    readonly perPage: number;
  }): Promise<FeatureFlagHistoryPage> {
    return this.#inner.listHistory(input);
  }

  override async applyBatch(
    input: FeatureFlagBatchWrite,
  ): Promise<"applied" | "revision-conflict"> {
    this.#states.forget();
    try {
      return await this.#inner.applyBatch(input);
    } finally {
      this.#states.forget();
    }
  }
}
