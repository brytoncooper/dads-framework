# ADR-0006: Permission-Aware Offline Sync Engine (`@dads-framework/sync`)

## Status

Proposed

## Date

2026-11-21

## Context

Field, construction, and industrial platforms operate in environments where WAN connectivity drops routinely or disappears inside plant facilities, underground sites, and remote work zones. Plant site servers, shared shop-floor kiosks, and mobile devices must serve local reads without waiting on the cloud and accept durable offline writes without losing operator work. At the same time, B2B multi-tenant platforms enforce Zanzibar-style relationship-based access control (ReBAC), strict tenant isolation, financial invariants, and regulatory audit trails.

Two common offline-sync approaches fail under B2B multi-tenant constraints:

- **Raw table-to-table WAL replication:** Logical replication streams row changes directly from a primary database to downstream replicas. It cannot evaluate multi-hop ReBAC revocations inside the replication stream, forces teams to duplicate authorization predicates in separate SQL filters or YAML sync rules that drift from application code, and couples every node to PostgreSQL internals.
- **Blind row-level CRDT merges:** Conflict-free replicated data types converge concurrent edits at the column or document level without executing application logic. Letting merged rows bypass route handlers breaks Zod input validation, skips cross-table financial and workflow invariants, erases actor attribution in audit logs, and silently overwrites approved budgets or invoices.

Dads Framework already provides the primitives required to build a permission-aware sync engine without duplicating models:

- **Shared ReBAC model and revision tracking:** `@dads-framework/access` declares the typed relationship graph, `lookupResources` computes visible entity IDs for any subject, and `@dads-framework/postgres-access` tracks namespace revisions through `lookupRevisionSchemaMigration` ([ADR-0001](./0001-transactional-postgres-rebac.md)).
- **Client-mintable identifiers:** `@dads-framework/core/contract` exports `entityIdSchema` and `mintEntityId`, generating time-ordered UUIDv7 primary keys so offline devices create parent and child records without coordinating sequences with the cloud.
- **Route serving modes:** `@dads-framework/http` declares `SiteServing` (`"served"`, `"write_door"`, and `"cloud_only"`) in [`capabilities.ts`](../../packages/server/http/src/lib/route/capabilities.ts) to specify whether a site server answers a route locally, accepts a local write for upstream relay, or refuses it offline.
- **Transactional write guards:** `@dads-framework/postgres-access` provides serializable `withProtectedPostgresTransaction`, and SQLite provides `BEGIN IMMEDIATE` write locks so every node rechecks authorization atomically with state changes.

## Decision

Build `@dads-framework/sync` around five core architectural invariants and a dedicated media lane so offline reads, offline writes, and revocation evictions reuse the application's existing ReBAC model, route contracts, and audit pipeline.

### Five core architectural invariants

1. **Strict tree topology (no peer-to-peer mesh):** Data flows strictly along a tree: Cloud Primary (PostgreSQL) to an optional Site Server (local PostgreSQL, SQLite, or MySQL serving LAN kiosks and tablets while WAN is down) to end-user clients (mobile or kiosk SQLite, or browser OPFS and IndexedDB). Every downstream node syncs with one upstream parent, giving each subtree a single linearization authority for conflict resolution and access checks. A Site Server composes both roles: it runs as a `SyncClient` pulling scoped rows and scoped ReBAC tuples for its facility or project from the cloud, and as a `SyncServer` executing local ReBAC checks and Dads routes over the LAN during WAN outages.

2. **Database-agnostic HTTP/JSON sync protocol (`SyncStore` adapter):** Sync never couples to PostgreSQL WAL or logical replication slots. Upstream and downstream nodes exchange scoped JSON deltas and idempotent mutation commands over HTTP against a focused `SyncStore` adapter interface. Each participating database stores sync state in four internal tables:
   - `_dad_sync_cursor`: stores the last acknowledged upstream cursor and `accessRevision` per scope.
   - `_dad_sync_outbox`: persists pending local mutations awaiting upstream replay and server acknowledgement.
   - `_dad_sync_idempotency`: records processed `mutationId` keys and cached responses so retries remain idempotent.
   - `_dad_sync_tombstones`: logs deleted entity IDs with monotonic sequence numbers so downstream pulls remove deleted rows deterministically.

   Synced application tables add two columns: `sync_seq` (monotonic sequence updated on every committed change) and `row_version` (optimistic concurrency version incremented on every mutation). The protocol and `SyncStore` contract run identically across PostgreSQL, SQLite, and MySQL.

3. **Single declaration on tables and routes:** Authorization, delta scoping, and conflict behavior live beside the domain schema and route definition rather than in a separate sync configuration file.
   - **Table declaration:** `syncTable(table, { entity, scope: permissionToken })` binds a Drizzle table to its `@dads-framework/access` entity kind and read permission token. The sync engine derives permission-scoped pull queries, tombstone queries, and revocation evictions from this single declaration.
   - **Route declaration:** Routes attach `sync: { mode: "served" | "write_door" | "cloud_only", conflict: "append" | "field-merge" | "optimistic-lock" }` alongside existing HTTP route capabilities. Replaying a synced write executes the route's existing Zod validation, `enforceAccess` check ([ADR-0002](./0002-fail-closed-404-on-authorization-denial.md)), protected database transaction, and `@dads-framework/audit` recording without parallel sync handlers.

4. **Pull equals permission-scoped deltas plus revocation eviction:** A downstream node requests deltas by sending `{ scopes, cursor, accessRevision }` to its upstream parent. The upstream `SyncServer` evaluates the caller's visible resources against the requested scopes using `lookupResources`, compares `accessRevision` to detect permission changes, and returns `{ upserts, deletes, evictIds, tupleDeltas, nextCursor, accessRevision }`:
   - `upserts` carries rows whose `sync_seq` advanced past `cursor` (or newly granted resources after an `accessRevision` change) within the caller's authorized set.
   - `deletes` carries rows recorded in `_dad_sync_tombstones` since `cursor`.
   - `evictIds` lists entity IDs that still exist upstream but are no longer visible to the caller (for example, when a subcontractor leaves a project or a user loses facility membership). On receipt, the downstream `SyncClient` deletes those rows locally before advancing `_dad_sync_cursor`.
   - `tupleDeltas` delivers scoped ReBAC tuple updates to Site Server nodes so local LAN enforcement reflects the latest cloud permissions.

5. **Push equals durable mutation outbox, idempotent replay, and explicit conflict policies:** Every offline or `write_door` mutation writes `{ mutationId, route, params, body, baseVersion, baseFields }` into `_dad_sync_outbox`, applies an optimistic update to local storage, and replays the command through the real upstream Dads route upon reconnection. Upstream records `mutationId` inside `_dad_sync_idempotency` within the same database transaction as the domain write so duplicate deliveries return the original outcome. Each route selects one of three explicit conflict policies:
   - `append` (photos, field notes, inspection readings): combines client-minted UUIDv7 IDs with `mutationId` idempotency; writes never conflict.
   - `field-merge` (tasks, checklists, forms): transmits modified columns together with `baseFields` captured before the offline edit; the server merges non-overlapping column updates and emits a structured conflict record when two edits modify the same column.
   - `optimistic-lock` (invoices, approvals, budgets): requires `baseVersion === currentVersion` inside the protected write transaction; stale mutations fail with `{ code: "SYNC_CONFLICT", serverRow, mutation }` so financial and approval records are never overwritten silently.

### Dedicated chunked media and blob lane

Binary attachments (photos, videos, and PDFs) travel on a separate resumable transfer queue backed by local metadata records `{ blobId, localPath, sha256, status }`. Structured domain mutations reference `blobId` immediately and sync through the JSON outbox in milliseconds, while the media worker streams chunked uploads and downloads against `@dads-framework/object-storage` independently. Large field videos never block small JSON mutations or permission revocations.

## Alternatives considered

### Raw PostgreSQL WAL and logical replication sync (PowerSync / ElectricSQL style)

- **Pros:** Captures every SQL write from the WAL with low latency and requires minimal instrumentation on write paths.
- **Cons:** Couples sync infrastructure tightly to PostgreSQL logical replication slots, cannot run on SQLite or MySQL site servers without an external translation layer, forces teams to rewrite ReBAC rules as separate SQL sync predicates that drift from `@dads-framework/access`, and bypasses route validation, domain invariants, and `@dads-framework/audit` when ingesting client writes.
- **Rejected:** Multi-tenant B2B apps require one authorization model and full route-level validation on every write.

### Row-level CRDT table merging (Automerge / Yjs / CouchDB style)

- **Pros:** Converges arbitrary offline edits automatically without requiring an upstream coordinator or explicit conflict handlers.
- **Cons:** Silent column or document merges violate financial invariants (such as double-approving a budget or overwriting a locked invoice), bypass Zod schemas and `withProtectedPostgresTransaction` checks, bloat storage with per-field causal metadata across relational tables, and cannot express ReBAC-driven revocation evictions natively.
- **Rejected:** Collaborative text editors benefit from CRDT convergence; relational business records require explicit, route-enforced conflict policies.

### Peer-to-peer mesh sync between kiosks and mobile devices

- **Pros:** Allows devices on a partitioned LAN to exchange state directly without electing or deploying a Site Server.
- **Cons:** Eliminates a single authorization and linearization boundary, complicates revocation enforcement across partitioned peers, requires distributed conflict resolution across untrusted client devices, and breaks audit attribution when mutations hop through multiple peers.
- **Rejected:** A strict tree with an optional Site Server handles LAN-only operation while keeping one authoritative gatekeeper per tier.

## Phased implementation plan and prerequisites

1. **Phase 1 (prerequisite): Multi-DB ReBAC parity.** Bring `@dads-framework/postgres-access` and a new `@dads-framework/sqlite-access` adapter to feature parity on the shared `@dads-framework/access/runtime` port, including tuple expiration, polymorphic arrows, recursive arrows, and `lookupSubjects`. Site servers and local clients cannot enforce identical permission models until SQLite and PostgreSQL evaluate the same ReBAC semantics.
2. **Phase 2: Core sync engine and storage adapters.** Ship `@dads-framework/sync-core` containing the HTTP/JSON protocol contracts, `syncTable` metadata registration, the permission-scoped pull and revocation eviction engine, the idempotent push dispatcher, and all three conflict policies (`append`, `field-merge`, `optimistic-lock`), paired with PostgreSQL and SQLite `SyncStore` adapters.
3. **Phase 3: Site-server relay, media lane, and client SDK.** Add Site Server relay mode (`served`, `write_door`, `cloud_only` enforcement plus scoped `tupleDeltas` replication), the resumable chunked blob queue, selective scope downloads for large projects, and the mobile/web client SDK targeting SQLite and browser OPFS/IndexedDB.

## Consequences

- One `@dads-framework/access` graph governs cloud HTTP endpoints, Site Server LAN execution, and sync pull scoping; no parallel SQL or YAML authorization rules exist to drift.
- Every offline mutation passes through real route validation, `enforceAccess`, serializable or `BEGIN IMMEDIATE` transactions, and `@dads-framework/audit`, preserving invariants and actor attribution across online and offline writes.
- Synced tables require `sync_seq` and `row_version` columns alongside the four internal `_dad_sync_*` tables, and `_dad_sync_tombstones` requires a bounded retention window after which long-disconnected clients fall back to a full scoped resync.
- Offline devices continue serving cached rows under their last synced permissions until they reconnect; operations that require real-time central authority must declare `cloud_only` and remain unavailable offline.
- Client applications using `field-merge` or `optimistic-lock` routes must present `SYNC_CONFLICT` payloads to operators or automated resolvers instead of assuming silent last-write-wins behavior.
- Replaying queued mutations through HTTP route handlers trades raw bulk-ingest throughput for full authorization, validation, and audit guarantees.

## References

- [ADR-0001: Compile ReBAC into PostgreSQL Transactions Behind the Shared Access Runtime Port](./0001-transactional-postgres-rebac.md)
- [ADR-0002: Fail Closed with HTTP 404 on Authorization Denial Before Validation and Rate Limiting](./0002-fail-closed-404-on-authorization-denial.md)
- [`@dads-framework/access` README](../../packages/access/README.md)
- [`@dads-framework/postgres-access` README](../../packages/server/postgres-access/README.md)
- [`@dads-framework/http` README](../../packages/server/http/README.md)
- [Route capabilities (`SiteServing`)](../../packages/server/http/src/lib/route/capabilities.ts)
- [Entity ID schemas (`entityIdSchema`)](../../packages/core/src/contract/lib/entity-id.ts)
- [`@dads-framework/audit` README](../../packages/server/audit/README.md)
- [`@dads-framework/object-storage` README](../../packages/server/object-storage/README.md)
