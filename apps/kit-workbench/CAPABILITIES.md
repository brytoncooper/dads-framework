# Starter capabilities

The starter composes one real implementation for each runtime port it uses.
The customer and staff APIs share identity and tenant services. Customer selects
the Notes routes and its attachment worker. Staff selects tenant routes.

| Package role            | Packages                                                                                                                                                            | Starter use                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP and contracts      | `access`, `authorization`, `contract`, `errors`, `health`, `http`, `plugin`, `request-work`                                                                         | Typed routes, relationship enforcement, readiness probes, request work and explicit API selection                                                   |
| Identity and tenancy    | `identity`, `identity-better-auth`, `tenants`                                                                                                                       | Cookies, email verification and tenant invitations                                                                                                  |
| Persistence and audit   | `audit`, `audit-actor`, `migrations`, `postgres`, `postgres-access`                                                                                                 | PostgreSQL state, transaction-scoped writes, audit attribution and request diagnostics                                                              |
| Flags and diagnostics   | `diagnostics`, `feature-flags`, `feature-flags-postgres`, `telemetry`, `telemetry-core`                                                                             | Tenant flag state, local fault logs and opt-in telemetry export                                                                                     |
| Files and jobs          | `job-queue`, `job-queue-core`, `object-storage`, `object-storage-core`, `clock`                                                                                     | Disk-backed note attachments, local background inspection, and a clock port                                                                         |
| Mail                    | `email-delivery`, `email-sender-core`, `email-templates`                                                                                                            | PostgreSQL delivery records, rendered verification and invitation email, and a private development spool                                            |
| Reports                 | `csv`, `pdf`                                                                                                                                                        | Protected per-note download endpoints. Starter migrations enable the Notes export flag through stored flag state                                    |
| Browser                 | `client-feature-flags`, `client-request-transport`, `copy`, `design-tokens`, `styles`, `ui`                                                                         | Browser building blocks, selected by the application UI                                                                                             |
| Optional integration    | `authorization-migration`, `client-telemetry`, `client-telemetry-core`, `client-xlsx`, `cross-domain-references`, `email-sender`, `event-bus`, `feature-flags-http` | Migration tooling and optional adapters for browser telemetry, workbooks, reference checks, external email, event fanout and additional flag routes |
| Development and testing | `dev`, `path-aliases`, `testing`, `testing-import-nx`, `testing-vitest`, `toolbox`                                                                                  | Worktree slots, import resolution, targeted test planning and generator/verification commands                                                       |
| Creation                | `create-dads`                                                                                                                                                       | Generates the project from these sources                                                                                                            |
| Platform executables    | `testing-native-darwin-arm64`, `testing-native-darwin-x64`, `testing-native-linux-arm64-gnu`, `testing-native-linux-x64-gnu`, `testing-native-win32-x64`            | The testing façade selects the matching optional package                                                                                            |

Package names in this table use the `@dads-framework/` scope except
`create-dads`. Alternative adapters can bind the same ports, such as S3
object storage, BullMQ job execution, and external email senders.

## Try the local services

After signing in and creating a note, POST `{"text":"Private attachment"}`
to `/api/tenants/:tenantId/notes/:noteId/attachments`. GET the same resource
with its returned `fileId` to see the text and the background worker's byte
count and SHA-256 digest. The in-process worker runs while the customer
process is running. Use a durable queue for work that must survive restarts.

GET `/api/tenants/:tenantId/notes/:noteId/exports/csv` or `/exports/pdf`
to obtain the base64-encoded report. The note authoring and artifact routes
use the tenant relationship and refuse requests outside that tenant.

The development mailbox stores rendered messages privately in
`DADS_MAIL_SPOOL_DIR`. Read verification and invitation links locally from
that directory. Production deployments need an application-configured
sender. The spool has full message contents and must stay private.
