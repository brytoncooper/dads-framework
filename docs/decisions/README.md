# Architecture Decision Records

This directory records architectural decisions in Dads Framework that carry long-term trade-offs or high reversal cost. Each record captures the constraints, the chosen design, the rejected alternatives, and the concrete files where the decision lives.

## Index

| ADR                                                              | Title                                                                                 | Status   | Date       |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------- | ---------- |
| [ADR-0001](./0001-transactional-postgres-rebac.md)               | Compile ReBAC into PostgreSQL Transactions Behind the Shared Access Runtime Port      | Accepted | 2026-11-20 |
| [ADR-0002](./0002-fail-closed-404-on-authorization-denial.md)    | Fail Closed with HTTP 404 on Authorization Denial Before Validation and Rate Limiting | Accepted | 2026-11-20 |
| [ADR-0003](./0003-direct-fastify-zod-drizzle-edges.md)           | Use Fastify, Zod, and Drizzle Directly at Transport and Storage Edges                 | Accepted | 2026-11-20 |
| [ADR-0004](./0004-mechanical-boundaries-and-one-way-ratchets.md) | Enforce Domain Boundaries and Code Health with Mechanical Gates and One-Way Ratchets  | Accepted | 2026-11-20 |
| [ADR-0005](./0005-workspace-and-tenant-terminology.md)           | Use Tenant in Framework Packages and Product Nouns in Application UIs                 | Accepted | 2026-11-20 |
| [ADR-0006](./0006-permission-aware-offline-sync.md)              | Permission-Aware Offline Sync Engine (`@dads-framework/sync`)                         | Proposed | 2026-11-21 |

## Lifecycle and conventions

Every ADR moves through four states: `Proposed`, `Accepted`, `Superseded by ADR-XXXX`, or `Deprecated`.

- Keep accepted ADRs immutable in spirit. Do not delete an ADR when a decision changes; write a new numbered ADR that links to and supersedes the earlier record.
- Name files `NNNN-short-kebab-title.md` with four-digit sequential numbering.
- Ground every claim in concrete package names, source paths, and observed trade-offs.
