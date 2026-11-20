# Run the starter outside development

For local development, use `npm start` to run the Compose stack and see its
assigned URLs. The [starter README](./README.md#start) covers that workflow.

Use the generated project as the deployment unit for a host or container.
The API needs Node 24, a reachable PostgreSQL database, and a supervisor
that can start Node and send it a termination signal.

## Prepare the release

1. Install from the committed lockfile with `npm ci` and run
   `npm run verify`. Provide Docker for the tests that start disposable
   PostgreSQL.
2. Run `npm run build:web`. Serve the entire `dist/` directory, including
   its assets and license files. Configure a fallback to `index.html` for
   browser routes and forward the browser's same-origin `/api` requests to
   the customer API.
3. Configure `DATABASE_URL` and `DADS_IDENTITY_SECRET` in the runtime's
   secret store. Set `DADS_BASE_URL` to the public HTTPS origin for sign-in.
   Keep the origin and secret consistent across replicas of the same API.
4. Connect application email delivery to a real provider and configure
   durable storage for features that write files.
5. Run `npm run migrate` once against the intended database before starting
   the new API processes. Review migration output before opening traffic.

## Start and check

Set `NODE_ENV=production` and run `npm run start:api`. Select
`DADS_API=customer` for the customer routes or `DADS_API=staff` for the staff
routes. Set `PORT` for each process and `HOST` to the interface reached by
your ingress. Terminate HTTPS at the ingress and forward the original
origin and cookie headers so sign-in stays on the intended origin.

Expect `GET /api/health` to return HTTP 200 with a status of `ok`. Use the
[customer API walkthrough](./README.md#call-the-customer-api-from-the-command-line)
with delivered mail to verify a session, create a tenant, and write a note.
Repeat the note request as an account without membership and expect HTTP 404. Confirm the staff origin exposes only the intended routes. Verify
HTTPS and email delivery in the environment you operate.
