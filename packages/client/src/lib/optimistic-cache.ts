type QueryKey = readonly unknown[];

/** The query-cache operations needed to patch and restore optimistic reads. */
export type OptimisticQueryCache = {
  cancelQueries(filters: { readonly queryKey: QueryKey }): Promise<void>;
  getQueriesData(filters: { readonly queryKey: QueryKey }): readonly (readonly [QueryKey, unknown])[];
  setQueriesData(filters: { readonly queryKey: QueryKey }, updater: (cached: unknown) => unknown): void;
  setQueryData(key: QueryKey, data: unknown): void;
  invalidateQueries(filters: { readonly queryKey: QueryKey }): Promise<void>;
};

/**
 * What one write is expected to do to the records already on screen.
 *
 * `change` merges fields into the record with this id wherever it is cached —
 * a detail read, a row in a page, an item in a plain list, or a record nested
 * one level inside a detail (a ticket's parties, a company's relationship). `remove` takes the record out of
 * every page and list it appears in, and lowers each page's total to match.
 * `key` names the identifying field when a record is not keyed by `id`
 * (`staffId`, `relationshipId`).
 */
export type OptimisticRecordEffect = {
  readonly id: string;
  readonly key?: string;
} & ({ readonly change: Readonly<Record<string, unknown>> } | { readonly remove: true });

/** What `onMutate` hands back so a refused write can be put back. */
export type OptimisticSnapshot = {
  readonly entries: readonly (readonly [QueryKey, unknown])[];
};

/** The mutation options an optimistic write spreads into its factory. */
export type OptimisticRecordWriteOptions<TVariables> = {
  readonly onMutate: (variables: TVariables) => Promise<OptimisticSnapshot>;
  readonly onError: (error: Error, variables: TVariables, snapshot: OptimisticSnapshot | undefined) => void;
  readonly onSettled: () => Promise<void>;
};

/**
 * {@link optimisticRecordWrite} for a write that takes no input — opening one
 * order, closing one release — whose effect is known when the factory is
 * built.
 *
 * Its options name no input, so the mutation keeps taking none. The snapshot
 * to restore is the one its latest send took: such a write is sent from one
 * control at a time, and the refetch on settle corrects any overlap.
 */
export function optimisticRecordWriteWithoutInput(
  queryClient: OptimisticQueryCache,
  scope: QueryKey,
  effect: OptimisticRecordEffect | null,
) {
  const write = optimisticRecordWrite<undefined>(queryClient, scope, () => effect);
  let latest: OptimisticSnapshot | undefined;
  return {
    onMutate: async (): Promise<OptimisticSnapshot> => {
      latest = await write.onMutate(undefined);
      return latest;
    },
    onError: (error: Error): void => {
      write.onError(error, undefined, latest);
    },
    onSettled: write.onSettled,
  };
}

/**
 * Mutation options that show a write before the server answers it.
 *
 * The screen changes the moment the reader acts: every cached read under
 * `scope` is patched with the expected effect. If the server refuses, each
 * read is restored exactly as it was, and the refusal is explained by the
 * app's single failure notice — or, when the hook declares
 * `FAILURE_PRESENTED_INLINE` and its screen stays mounted, by that screen's
 * own inline message. Either way the scope is refetched once the write
 * settles, so the server's answer — not the guess — is what stays on screen.
 *
 * Spread it into a mutation factory beside its own `onSuccess`. The patch is
 * structural: it recognises `{ items, meta }` pages, arrays of records, and
 * records by their identifying field, so a resource's key factory never has
 * to enumerate the views that show it. An effect that names a field a view
 * does not carry changes nothing there, and the refetch corrects it.
 */
export function optimisticRecordWrite<TVariables>(
  queryClient: OptimisticQueryCache,
  scope: QueryKey,
  effectOf: (variables: TVariables) => OptimisticRecordEffect | null,
): OptimisticRecordWriteOptions<TVariables> {
  return {
    onMutate: async (variables: TVariables): Promise<OptimisticSnapshot> => {
      const effect = effectOf(variables);
      if (effect === null) return { entries: [] };
      await queryClient.cancelQueries({ queryKey: scope });
      const entries = queryClient.getQueriesData({ queryKey: scope });
      queryClient.setQueriesData({ queryKey: scope }, (cached: unknown) => applyRecordEffect(cached, effect));
      return { entries };
    },
    onError: (_error: Error, _variables: TVariables, snapshot: OptimisticSnapshot | undefined) => {
      for (const [queryKey, data] of snapshot?.entries ?? []) {
        queryClient.setQueryData(queryKey, data);
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: scope }),
  };
}

/**
 * One cached read with the effect applied; the same reference when the read
 * does not hold the record, so untouched views do not re-render.
 */
export function applyRecordEffect(cached: unknown, effect: OptimisticRecordEffect): unknown {
  if (Array.isArray(cached)) {
    return applyToRecords(cached, effect) ?? cached;
  }
  if (!isObject(cached)) return cached;
  if (Array.isArray(cached["items"]) && isObject(cached["meta"])) {
    const items = applyToRecords(cached["items"], effect);
    if (items === null) return cached;
    return {
      ...cached,
      items,
      meta: decrementPageTotal(cached["meta"], cached["items"].length - items.length),
    };
  }
  if (isTarget(cached, effect)) {
    return "change" in effect ? { ...cached, ...effect.change } : cached;
  }
  return applyToNestedRows(cached, effect);
}

function decrementPageTotal(meta: Record<string, unknown>, removed: number): Record<string, unknown> {
  const total = meta["total"];
  return typeof total === "number" && removed > 0 ? { ...meta, total: Math.max(0, total - removed) } : meta;
}

function applyToNestedRows(record: Readonly<Record<string, unknown>>, effect: OptimisticRecordEffect): unknown {
  let patched: Record<string, unknown> | null = null;
  for (const [field, value] of Object.entries(record)) {
    const next = Array.isArray(value)
      ? applyToRecords(value, effect)
      : isTarget(value, effect) && "change" in effect
        ? { ...value, ...effect.change }
        : null;
    if (next === null) continue;
    patched = { ...(patched ?? record), [field]: next };
  }
  return patched ?? record;
}

function applyToRecords(records: readonly unknown[], effect: OptimisticRecordEffect): unknown[] | null {
  if (!records.some((record) => isTarget(record, effect))) return null;
  if ("remove" in effect) {
    return records.filter((record) => !isTarget(record, effect));
  }
  return records.map((record) => (isTarget(record, effect) ? { ...record, ...effect.change } : record));
}

function isTarget(record: unknown, effect: OptimisticRecordEffect): record is Record<string, unknown> {
  return isObject(record) && record[effect.key ?? "id"] === effect.id;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
