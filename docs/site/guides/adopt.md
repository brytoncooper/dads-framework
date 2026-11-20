# Adopt one capability

Choose one behavior to prove in your existing application. For a route with
unclear validation, capture a malformed request in a test, define the accepted
input at the HTTP boundary, then run the malformed request and a valid one.
Keep the route's existing access rules and prove denial with an account that
lacks the required relationship.
[HTTP contract example](./http.md) · [Denial test](./guarded-resource.md)

## Preview a starter beside your application

An isolated starter lets you practice on a working API before editing your
application. When your registry carries a stable `create-dads` release, run
this preview with the root of your existing application as the target.

```sh
npm create dads@latest /path/to/your/project -- --existing --dry-run --json
```

Check that `initialization.projectRoot` points to the project's `dads/`
subdirectory. `initialization.created` lists the starter files it would write.
Remove `--dry-run` to write those files and install dependencies. The host
manifest stays intact. With Docker running, start the separate app.

```sh
cd /path/to/your/project/dads
npm start
```

Open the web URL printed by the launcher and [save a note](./quickstart.md#save-a-note).
Commit the starter's `package-lock.json` if you use its CI. Its
`ci/verify.sh` runs `npm ci` before verification.

The public npm `latest` tag currently points to a staging version. From a
framework checkout, you can preview the same layout with the source creator.

```sh
npm ci
npm run build
node packages/foundation/create-dads/dist/cli.js /path/to/your/project \
  --existing --dry-run --json
```

If the host already has the [Toolbox](../../../packages/foundation/toolbox/README.md),
run `npx dad doctor` in the host to inspect its current findings. Use
`npx dad doctor explain <issue-id>` to read the rule and the suggested repair.
[Doctor reference](../../doctor.md)
