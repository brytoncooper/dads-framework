---
name: add-domain
description: Add a Dads domain and attach it to an explicit API entrypoint.
---

1. Keep declarations and logic in a named folder under `domains/`.
2. Register the domain's route plugin in each API that should serve it.
3. Add and register a forward migration for new persistent state.
4. Prove authorized and unauthorized requests, then run `npm run verify`.
