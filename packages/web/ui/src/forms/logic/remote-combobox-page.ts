export type RemoteComboboxPage<Item> = {
  readonly items: readonly Item[];
  readonly hasMore: boolean;
};

export type RemoteComboboxLoadArgs = {
  readonly query: string;
  readonly page: number;
  readonly signal: AbortSignal;
};

export type LoadRemoteComboboxPage<Item> = (
  args: RemoteComboboxLoadArgs,
) => Promise<RemoteComboboxPage<Item>>;

export function pageHasMore(meta: {
  readonly page: number;
  readonly perPage: number;
  readonly total: number;
}): boolean {
  return meta.page * meta.perPage < meta.total;
}

export function nextRemoteComboboxItems<Item>(input: {
  readonly current: readonly Item[];
  readonly incoming: readonly Item[];
  readonly page: number;
  readonly itemKey: (item: Item) => string | number;
}): readonly Item[] {
  if (input.page <= 1) return input.incoming;
  const seen = new Set(input.current.map(input.itemKey));
  return [
    ...input.current,
    ...input.incoming.filter((item) => !seen.has(input.itemKey(item))),
  ];
}

export function shouldPrefetchNextPage(input: {
  readonly hasMore: boolean;
  readonly loading: boolean;
}): boolean {
  return input.hasMore && !input.loading;
}
