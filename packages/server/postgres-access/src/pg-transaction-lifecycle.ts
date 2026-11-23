import type { PgClientLike } from "./postgres-types.js";

export type PgTransactionState = {
  began: boolean;
  committed: boolean;
  destroyClient: boolean;
};

export async function abortPgTransaction(
  client: PgClientLike,
  state: PgTransactionState,
): Promise<boolean> {
  if (!state.began) return true;
  if (state.committed) return false;
  if (isIdleClient(client)) return false;
  try {
    await client.query("ROLLBACK");
    return false;
  } catch {
    return true;
  }
}

export function releasePgClient(client: PgClientLike, destroy: boolean): void {
  const needsDestroy = destroy || !isIdleOrUnknownClient(client);
  client.release(needsDestroy ? true : undefined);
}

function isIdleClient(client: PgClientLike): boolean {
  return (
    typeof client.getTransactionStatus === "function" &&
    client.getTransactionStatus() === "I"
  );
}

function isIdleOrUnknownClient(client: PgClientLike): boolean {
  return (
    typeof client.getTransactionStatus !== "function" ||
    client.getTransactionStatus() === "I"
  );
}
