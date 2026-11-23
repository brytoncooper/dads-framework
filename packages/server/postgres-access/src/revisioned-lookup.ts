import type { ResourceLookup } from "@dads-framework/access/runtime";
import {
  lookupRevisionQuery,
  lookupWithRevision,
  readLookupRevision,
  readRevisionedIds,
} from "./lookup-revision-query.js";
import type { PostgresQuery, PostgresRow } from "./postgres-types.js";

const MAX_ENTRIES = 32;
const MAX_IDS = 32_768;
const MAX_ENTRY_IDS = 8_192;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_IN_FLIGHT = 16;
const MAX_IN_FLIGHT_KEY_UNITS = 2_048;

type RevisionedResult = {
  readonly stamp: string;
  readonly ids: readonly string[];
};
type CacheEntry = RevisionedResult & { readonly bytes: number };
type ReadRows = (query: PostgresQuery) => Promise<readonly PostgresRow[]>;

/** Per adapter instance. The instance owns exactly one compiled model, namespace and pool. */
export class RevisionedLookup {
  readonly #entries = new Map<string, CacheEntry>();
  readonly #pending = new Map<string, Promise<RevisionedResult>>();
  #bytes = 0;
  #ids = 0;
  #generation = 0;

  constructor(
    private readonly namespace: string,
    private readonly readRows: ReadRows,
  ) {}

  async lookup(input: ResourceLookup, compile: () => PostgresQuery): Promise<readonly string[]> {
    const key = JSON.stringify([
      input.resourceType,
      input.permission,
      input.subject.type,
      input.subject.id,
      input.subject.relation ?? "",
      input.consistencyToken ?? "",
    ]);
    const previouslyLoaded = this.#entries.get(key);
    if (previouslyLoaded !== undefined) {
      if ((await this.#currentStamp()) === previouslyLoaded.stamp) return previouslyLoaded.ids;
      if (this.#entries.get(key) === previouslyLoaded) this.#remove(key);
    }

    // A caller may have entered after the pending SQL read's snapshot. It
    // must validate the result on its own before reusing it, including empty
    // lists. The initiating operation already observed its own snapshot.
    const pending = this.#pending.get(key);
    if (pending !== undefined) {
      const result = await pending;
      if ((await this.#currentStamp()) === result.stamp) return result.ids;
      return (await this.#fill(key, compile)).ids;
    }
    return (await this.#fill(key, compile)).ids;
  }

  async #currentStamp(): Promise<string> {
    try {
      const rows = await this.readRows(lookupRevisionQuery(this.namespace));
      return readLookupRevision(rows[0]);
    } catch (error) {
      this.#invalidate();
      throw error;
    }
  }

  async #fill(key: string, compile: () => PostgresQuery): Promise<RevisionedResult> {
    const previous = this.#entries.get(key);
    const generation = this.#generation;
    const read = this.#read(compile());
    const share =
      key.length <= MAX_IN_FLIGHT_KEY_UNITS && !this.#pending.has(key) && this.#pending.size < MAX_IN_FLIGHT;
    if (share) this.#pending.set(key, read);
    try {
      const result = await read;
      // An older or slower load may not replace a newer fill.
      if (this.#generation === generation && this.#entries.get(key) === previous) this.#retain(key, result);
      return result;
    } catch (error) {
      this.#invalidate();
      throw error;
    } finally {
      if (share && this.#pending.get(key) === read) this.#pending.delete(key);
    }
  }

  async #read(query: PostgresQuery): Promise<RevisionedResult> {
    const rows = await this.readRows(lookupWithRevision(query, this.namespace));
    return {
      stamp: readLookupRevision(rows[0]),
      ids: readRevisionedIds(rows[0]),
    };
  }

  #retain(key: string, result: RevisionedResult): void {
    if (result.ids.length > MAX_ENTRY_IDS) return;
    const bytes =
      (key.length + result.stamp.length) * 2 + 128 + result.ids.reduce((sum, id) => sum + id.length * 2 + 32, 0);
    if (bytes > MAX_BYTES) return;
    this.#remove(key);
    while (
      this.#entries.size >= MAX_ENTRIES ||
      this.#bytes + bytes > MAX_BYTES ||
      this.#ids + result.ids.length > MAX_IDS
    ) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#remove(oldest.value);
    }
    this.#entries.set(key, { ...result, bytes });
    this.#bytes += bytes;
    this.#ids += result.ids.length;
  }

  #invalidate(): void {
    this.#generation++;
    this.#entries.clear();
    this.#pending.clear();
    this.#bytes = 0;
    this.#ids = 0;
  }

  #remove(key: string): void {
    const entry = this.#entries.get(key);
    if (entry === undefined) return;
    this.#entries.delete(key);
    this.#bytes -= entry.bytes;
    this.#ids -= entry.ids.length;
  }
}
