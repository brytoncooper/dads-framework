/** Minimal structural Postgres boundary. `pg` Pool and PoolClient satisfy these types. */
/** Values are passed only as parameters; their concrete encoding remains pg-owned. */
export type PostgresValue = unknown;

export type PostgresQuery = {
  readonly text: string;
  readonly values?: PostgresValue[];
  /** node-postgres client-side read deadline in milliseconds. */
  readonly query_timeout?: number;
};

/** Gives mutable driver configuration to clients without exposing plan mutation upstream. */
export function copyPostgresQuery(query: PostgresQuery): PostgresQuery {
  const values = query.values ? [...query.values] : undefined;
  if (query.query_timeout === undefined) return values ? { text: query.text, values } : { text: query.text };
  return values
    ? { text: query.text, values, query_timeout: query.query_timeout }
    : { text: query.text, query_timeout: query.query_timeout };
}

export type PostgresRow = Readonly<Record<string, unknown>>;

export type PostgresQueryResult<Row extends PostgresRow = PostgresRow> = {
  readonly rows: readonly Row[];
  readonly rowCount: number | null;
};

/** Minimal structural node-postgres client boundary (`pg.PoolClient` satisfies this). */
export type PgClientLike = {
  query(query: string | PostgresQuery, values?: PostgresValue[]): PromiseLike<PostgresQueryResult>;
  release(destroy?: Error | boolean): void;
  getTransactionStatus?(): string | null;
};

/** Minimal structural node-postgres pool boundary (`pg.Pool` satisfies this). */
export type PgPoolLike<Client extends PgClientLike = PgClientLike> = {
  query(query: string | PostgresQuery, values?: PostgresValue[]): PromiseLike<PostgresQueryResult>;
  connect(): PromiseLike<Client>;
};
