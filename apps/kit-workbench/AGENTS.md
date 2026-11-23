# Dads app

## Governing principle — Independent Evolution (IEP)

**Things that can evolve independently are contracted independently; things that change together live together.** Similarity today is not shared ownership. Before adding any layer, seam, port, fake, or file, ask: _what real change does this absorb?_ If you cannot name one (an independently deployed client, another domain's release, a vendor swap, or a second implementation), do not add it.

- **Meaningful boundaries (contract required, internals walled):** API wire ↔ clients (hand-written Zod contracts, never derived from DB tables); domain ↔ domain (consumer-owned port or event, never internal imports); persistence ↔ wire (a DB row never becomes a DTO); application code ↔ swappable vendors (one chokepoint).
- **Not boundaries (one owner, keep together):** a route, its handler, and its access declaration; row/insert types and their table; a feature page and its loader. One test seam is kept on purpose: a domain's reader/writer store contract for pure unit tests with in-memory fakes (never re-implementing Postgres rules).
- **Precedence:** IEP outranks structural conventions when a convention demands an unearned seam, but never overrides safety walls, domain boundaries, or `Authorization`.

## Where code goes

- `domains/<name>/{contract,access,pure,server}` — wire schemas & `*Operation` contracts (`contract/`), resource permissions (`access/`), deterministic rules with zero I/O (`pure/`), and thin routes/store/plugin (`server/`).
- `workflows/` — multi-domain orchestration using public domain exports and integration ports.
- `integrations/` — external vendor SDK adapters behind app-owned capability ports.
- `libraries/` — domain-free shared primitives and narrow capability tokens.
- `migrations/` — append-only SQL migrations (`*.migration.ts`).
- `assembly/` — composition root wiring infrastructure into `startHttpHost`.

## Working in this repo

- Ask `dad orient <path> --json` which package owns the work.
- Read the [add-domain skill](./.agents/skills/add-domain/SKILL.md) for access, routes, and migrations.
- Keep each domain's contracts, access decisions, and storage in its own folder.
- Mount routes explicitly in `apps/<api>/app.ts`.
- Register migration sources in `assembly/migrations.ts`.
- Prove guarded routes for both a member and a nonmember.
- Run `npm run verify` before delivery.
- Use the [local setup](./README.md) and [run guide](./DEPLOY.md) for environment and rollout changes.
