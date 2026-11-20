# Dads app

- Ask `dad orient <path> --json` which package owns the work.
- Read the [add-domain skill](./.agents/skills/add-domain/SKILL.md) for access, routes, and migrations.
- Keep each domain's contracts, access decisions, and storage in its own folder.
- Mount routes explicitly in `apps/<api>/app.ts`.
- Register migration sources in `assembly/migrations.ts`.
- Prove guarded routes for both a member and a nonmember.
- Run `npm run verify` before delivery.
- Use the [local setup](./README.md) and [run guide](./DEPLOY.md) for environment and rollout changes.
