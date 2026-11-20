# Experimental authorization benchmark

Measure the operation your application depends on. Point checks, fresh
resource discovery, revision-validated lookup reuse, and protected
transactions have different costs.

These are Linux development VM measurements with both engines accessed
locally. The SpiceDB comparison used the fully consistent in-memory
datastore. The figures apply to the listed fixtures and configurations.
They do not set a production latency target or compare persistent
SpiceDB deployments. The benchmarks do not include HTTP, application
writes, or serializable transaction overhead.

## Matched point checks against SpiceDB

```sh
CONTAINER_PER_FILE=1 npm run benchmark -w @dads-framework/postgres-access -- src/point-check-comparison.benchmark.test.ts
```

The harness uses the same 5,000-leaf graph for each depth and engine. Both
use the public Node authorization adapters over local TCP, with the opt-in prepared-check path against PostgreSQL 16.16 and fully consistent gRPC
against the SpiceDB 1.57.0 in-memory testing datastore. It includes transport,
encoding, SQL compilation, and decoding in the timed calls. The Linux VM
has 32 vCPUs on an i9-13900KF and runs Node 24.20.0.

Each engine takes three rounds of 1,280 checks per depth and worker count,
after 30 warmups per worker. Engine order alternates and each worker checks
both granted and denied subjects. The measured mix is 75% granted, with
distinct leaf IDs and distinct denied subject IDs within each round. After
timing, an independent writer revokes and restores the membership while the
same reader must observe both changes.

The columns are the medians of the three round summaries. Latency is in
milliseconds, and throughput is completed checks per second at that worker
count.

| Arrows | Workers | Engine     |   p50 |   p95 |   p99 | Checks/s |
| -----: | ------: | :--------- | ----: | ----: | ----: | -------: |
|      2 |       1 | PostgreSQL | 0.275 | 0.702 | 1.192 |    3,054 |
|      2 |       1 | SpiceDB    | 0.620 | 0.996 | 2.086 |    1,509 |
|      2 |       8 | PostgreSQL | 0.440 | 0.951 | 1.843 |   14,044 |
|      2 |       8 | SpiceDB    | 1.369 | 2.269 | 3.342 |    5,678 |
|      8 |       1 | PostgreSQL | 0.184 | 0.472 | 0.873 |    4,118 |
|      8 |       1 | SpiceDB    | 0.633 | 1.020 | 1.838 |    1,441 |
|      8 |       8 | PostgreSQL | 0.224 | 0.481 | 0.561 |   25,178 |
|      8 |       8 | SpiceDB    | 0.814 | 1.654 | 2.116 |    8,446 |
|     16 |       1 | PostgreSQL | 0.187 | 0.362 | 0.419 |    4,476 |
|     16 |       1 | SpiceDB    | 0.859 | 1.286 | 1.833 |    1,150 |
|     16 |       8 | PostgreSQL | 0.381 | 0.491 | 0.544 |   19,146 |
|     16 |       8 | SpiceDB    | 1.268 | 1.986 | 2.885 |    5,925 |

At 16 arrows and eight workers, PostgreSQL's per-round p95 was 0.490,
0.491, and 0.500 ms. An earlier implementation used the ordinary named
query and measured 0.877, 0.878, and 1.003 ms on the same fixture.
One first check per depth after seeding, using a fresh adapter, took
6.73–8.98 ms with PostgreSQL and 2.26–4.86 ms with SpiceDB. These first
calls include any connection setup deferred until the first request and
start with the server already running.

The graph has a shared chain and one grant. The 8- and 16-arrow cases use
the bounded indexed traversal, while the 2-arrow case uses the shallow
prepared path. It exercises neither production
network hops nor all policy shapes, datastore configurations, or vendor
features. A warm point check can still exceed 1 ms, especially for wide
graphs that need the full traversal.

A separate 5,001-way branch at 16 arrows tested the exact fallback with
eight checks per mode in each of two alternating rounds. The observed
maximums were 486 and 281 ms for the ordinary prepared query, and 332 and
281 ms with the bounded traversal plus fallback. The small fanout sample
illustrates how wide data can dominate absolute latency.

## Opt-in lookup reuse

This run measured the public `lookupResources` call on PostgreSQL 16.16 after analyzing
the fixture tables. The application alternated between two users with distinct
authorized sets of 5,000 IDs reached over eight hops. The driver was on the
same Linux VM. The caller verified the complete ordered answers outside the
elapsed interval. Each row has 40 to 100 timed iterations after warm-up.
Batch rows measure completion of all eight operations.

| Public operation or workload                                            |      p95, ms |
| ----------------------------------------------------------------------- | -----------: |
| Fresh lookup, reuse disabled                                            |         9.31 |
| Reuse enabled, forced miss on every call                                |        11.93 |
| Reuse enabled, both answers retained                                    |         0.97 |
| Eight concurrent retained lookups                                       |         1.05 |
| Retained lookups with an unrelated write every ten calls                |         0.85 |
| Lookups with a same-namespace write every ten calls                     |        10.83 |
| Eight concurrent inserts to one namespace, migration absent / installed | 4.14 / 35.26 |

The recorded run had one-minute VM load 6.25. An earlier run saw a retained
lookup p95 of 0.43 ms and eight-write batch p95 of 0.88 / 2.96 ms. The revision
row is a contention point for writers. A lookup miss still evaluates the
graph, and throughput and tail latency depend on how often its namespace
changes. These retained-result timings include a primary PostgreSQL revision
read. They apply only after a successful fill for the same lookup. Fresh or
invalidated lookups still read the graph and return every requested ID.

## Recursive userset traversal

PostgreSQL 16.16 on the same Linux VM. Baseline and candidate alternated on
the same tuple table. Each result was verified; reported p95 is the upper
sample of eight calls. Before an explicit `ANALYZE`, the baseline recursive
step for 1,024 memberships revisited about 1,050,000 tuples. The same step
with indexed frontier probes visited 1,025 frontier rows. Both arms used the same test deadline.

| Nested memberships | Point check p95 before / after | Lookup p95 before / after |
| -----------------: | -----------------------------: | ------------------------: |
|                 32 |                 1.42 / 0.81 ms |            0.99 / 0.63 ms |
|              1,024 |               219.14 / 3.40 ms |          206.14 / 3.00 ms |
|             10,000 |             timeout / 26.34 ms |        timeout / 24.36 ms |

After explicit `ANALYZE`, the baseline and candidate 10,000-edge checks
both measured about 26 ms p95, and lookups about 23 ms p95. These chains
exercise nested subject sets, separate from the permission-arrow graph
above. Each test also checked denial, batched decisions, rollback and
revocation of a middle relationship, and regrant.

Ordinary permission-arrow fixtures remained comparable. At two hops and
500 IDs, allowed lookup p95 was 1.93 / 1.90 ms before explicit analyze.
At eight hops, 500 parent branches and 5,000 IDs it was 16.40 / 15.71 ms
before analyze. After analyze the broad fixture had similar medians
(14.98 / 15.11 ms) and more variable tails (16.40 / 19.50 ms). Each fixture
checked ordered result equality and post-commit revocation.

## Recursive group membership soak

From a built checkout with Docker available:

```sh
CONTAINER_PER_FILE=1 POSTGRES_ACCESS_DEEP_SOAK=1 npm run test:integration -w @dads-framework/postgres-access -- recursive-subject-set.integration.test.ts
```

The soak traverses 32, 128, 1,024, and 10,000 group-to-group subject-set
links. Each case adds one root user membership and one terminal document
grant, for 10,002 tuples in the deepest case. These hops follow data across
instances of the same group relation. The arrow benchmarks above follow
permission references declared in the schema.

At each depth, the soak checks a point allow, ordered bulk allow and deny
decisions, and a singleton lookup. Removing a midpoint membership denies the
previously allowed point and bulk checks and empties the lookup. Restoring the
membership restores access and discovery.

The test uses isolated databases and sets `statement_timeout` to 4.9 seconds
for its fixture. This is a test setting.
The test disables autovacuum for its fixture table to control when statistics
are collected. One run leaves the freshly seeded table unanalyzed, and the
other runs `ANALYZE` after each seed. In a development VM run before the
indexed recursive traversal change, the first 10,000-hop point check hit the
4.9-second deadline without `ANALYZE`. With indexed traversal, all four depths
passed before and after `ANALYZE` on the same VM.

## Historical compiler measurements

These tables document changes to the benchmark fixtures over time. The
current code and benchmark commands can produce different timings.

### Original forward and reverse baseline

This early baseline was measured on 2026-11-19 Mountain Time. Both backends ran in containers on the same Linux development VM with a 32-vCPU Intel Core i9-13900KF and 25 GiB RAM. Postgres used the `postgres:16-alpine` image. SpiceDB v1.57.0 used its in-memory datastore and fully consistent reads. Node was v24.20.0.

The fixture grants one actor access through a chain of parent relationships. A single check targets one leaf. A lookup returns every leaf the actor can see. The benchmark validates each answer and takes 15 sequential samples after one warm-up call. Timings include application-side query compilation, transport, and reading the response. They exclude schema installation and seeding. This run used a 4.9-second PostgreSQL statement deadline and a 5-second client deadline.

All figures are milliseconds, shown as median / p95.

| Arrow depth | Visible IDs | Postgres check | SpiceDB check | Postgres lookup |  SpiceDB lookup |
| ----------: | ----------: | -------------: | ------------: | --------------: | --------------: |
|           2 |         500 |    1.43 / 1.67 |   1.00 / 1.33 |     1.69 / 2.97 |    4.97 / 10.70 |
|           8 |       5,000 |        Timeout |   0.74 / 1.74 |   48.06 / 53.23 |   59.57 / 87.73 |
|          16 |       5,000 |        Timeout |   2.35 / 3.04 | 109.85 / 128.91 | 156.05 / 215.70 |

The original forward SQL check timed out at eight and sixteen arrows while reverse resource discovery completed. Keep the backend experimental and measure check latency on the application's real policy graph before rollout. These samples do not establish production throughput, concurrent behavior, or performance with a persistent SpiceDB datastore.

To run the same fixture against the current implementation:

```sh
CONTAINER_PER_FILE=1 npm run benchmark -w @dads-framework/postgres-access
```

### Forward-check follow-up

On Postgres 16.16, the original depth-8 and depth-16 statements planned in
2.40 ms and 5.01 ms, then timed out during execution at 4.9 seconds. The
original plans pulled the arrow predicates up into nested semijoins. Disabling
JIT and setting `join_collapse_limit = 1` did not stop the timeouts. Keeping
each arrow as a correlated subplan with `OFFSET 0` left the predicates and
deadline intact. The resulting EXPLAIN ANALYZE reported 0.59 ms planning and
0.25 ms execution at depth 8, and 1.54 ms planning and 0.56 ms execution at
depth 16.

The same application benchmark also passed under concurrent VM load. The
one-minute load rose from 36.54 to 43.62 on 32 vCPUs. The kernel's ten-second
CPU pressure was 36.47% at the start and 27.64% at the end. These are measured
contention conditions. They differ from the earlier baseline.

| Arrow depth | Visible IDs | Postgres check | SpiceDB check | Postgres lookup |  SpiceDB lookup |
| ----------: | ----------: | -------------: | ------------: | --------------: | --------------: |
|           2 |         500 |    1.87 / 3.22 |   1.94 / 5.28 |    4.04 / 22.94 |   15.23 / 35.90 |
|           8 |       5,000 |    2.31 / 6.73 |   2.43 / 5.83 |   86.43 / 94.09 | 123.45 / 148.72 |
|          16 |       5,000 |    5.63 / 6.56 |   3.20 / 3.78 | 146.43 / 193.42 | 105.89 / 133.29 |

In a second run with lower CPU pressure (10.94% to 4.65%), the depth-8
Postgres check measured 2.76 / 4.40 ms and depth 16 measured 2.10 / 2.73 ms.
Lookup medians were 80.26 ms and 117.57 ms respectively.

This historical comparison changed the forward SQL only. The adapter
remains experimental. This fixture measures one chain with a shared parent
and sequential requests. Production policies may have branching relationships,
more tuples, and concurrent reads and writes.

### Reverse-lookup follow-up

This historical change made reverse lookup drive each relationship hop from the resource IDs already
reached. A correlated lateral subquery keeps PostgreSQL from moving a broad
tuple scan ahead of the reached IDs. Each hop still returns distinct IDs and
the final result remains sorted. This comparison kept the forward compiler unchanged.

PostgreSQL 16.16 on the same 32-vCPU Linux VM. Baseline and candidate alternated
on the same database, with four warm-up and 20 timed calls per operation. Each
call checked the complete ordered ID result. Values below are p95 milliseconds.

| Shape, visible IDs                     | Table statistics        | Allowed before / after | Denied before / after |
| -------------------------------------- | ----------------------- | ---------------------: | --------------------: |
| 8 hops, one parent branch, 5,000 IDs   | Before explicit analyze |           63.77 / 6.62 |          58.14 / 3.20 |
| 16 hops, one parent branch, 5,000 IDs  | Before explicit analyze |          123.65 / 8.58 |         108.98 / 3.06 |
| 8 hops, 500 parent branches, 5,000 IDs | Before explicit analyze |  4.9 s timeout / 18.32 |              — / 2.28 |
| 8 hops, 500 parent branches, 5,000 IDs | After analyze           |          20.02 / 15.88 |           1.20 / 1.09 |

With the broad graph the baseline timed out during its allowed warm-up before
the denied samples ran. The narrower, analyzed graphs already used efficient
plans and showed similar medians. Tail timings varied across repeats. Before
explicit analyze, the depth-16 baseline plan ran the inner chain 5,000 times.
The measured execution time fell from 150.995 ms to 3.730 ms when the query
drove the walk from the reached parent. These are synthetic planner tests,
with no throughput measurement.

### Earlier prepared single checks

This historical comparison predates bounded linear checks and the current
limits on named ordinary statements. To run the fixture on the current checkout:

```sh
CONTAINER_PER_FILE=1 npm run benchmark -w @dads-framework/postgres-access -- src/prepared-single-check.benchmark.test.ts
```

This exercises public `PostgresAuthorization.check()` over local TCP against
Postgres 16.16 with an eight-connection node-postgres pool. It interleaves
unnamed and named statements across three runs of 1,280 measured checks per
mode and worker count. Each worker warms up with 30 checks before sampling.
The fixture has one shared chain per namespace, 5,000 leaves for each positive
depth, varied resource and subject IDs, and 25% denials. It proves that
revocations, re-grants, a different subject kind, and an isolated namespace
change the answer after warm-up. Timings include SQL compilation, the pool,
the round trip, and decision decoding. They exclude HTTP and cold pool
startup.

Each cell lists the p95 in milliseconds from the three runs on the Linux VM.

| Arrows | Workers |      Unnamed p95 |        Named p95 |
| -----: | ------: | ---------------: | ---------------: |
|      0 |       1 | 0.47, 0.40, 0.45 | 0.29, 0.31, 0.30 |
|      0 |       8 | 0.69, 0.77, 0.72 | 0.68, 0.63, 0.59 |
|      2 |       1 | 0.62, 0.63, 0.69 | 0.17, 0.16, 0.27 |
|      2 |       8 | 1.11, 1.10, 1.14 | 0.55, 0.48, 0.58 |
|      8 |       1 | 1.15, 1.15, 1.15 | 0.40, 0.29, 0.51 |
|      8 |       8 | 2.23, 2.34, 2.37 | 0.57, 0.58, 0.73 |
|     16 |       1 | 1.94, 1.96, 1.94 | 0.41, 0.42, 0.43 |
|     16 |       8 | 4.23, 4.28, 4.30 | 0.92, 0.88, 0.89 |

An earlier matching fixture on the VM gave 1.03, 1.03, and 0.98 ms named
at 16 arrows with eight workers. The recorded tail crossed 1 ms in other runs of the same fixture. New or replaced connections still incur
parse and planning costs. PostgreSQL can retain custom plans for some
queries, and production policies, tuple distributions, and transport differ.
