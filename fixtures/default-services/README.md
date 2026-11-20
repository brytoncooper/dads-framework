# Default services migration fixture

Start Docker, then run from the workspace root.

```sh
npm run build
npm run test:integration -w @dads-fixture/default-services
```

The fixture runs the [default services migration](migrations/20261120000000_default_services.migration.ts)
on empty PostgreSQL, accepts a tenant invitation with a verified identity
session, and checks that replay leaves the journal and data intact.
