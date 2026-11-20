# @dads-framework/object-storage-core

Use `ObjectStorage` for application code that reads and writes objects by key.
Use `InMemoryObjectStorage` for unit tests and local composition. Applications
can choose a disk or S3 implementation from
[`@dads-framework/object-storage`](../object-storage/README.md).

## Try it

In a project using Node.js 22 or later, install the example dependencies.

```sh
npm install @dads-framework/object-storage-core
npm install -D tsx
```

Save this as `example.mts` and run `npx tsx example.mts`.

<!-- dads:check-example -->

```ts
import { InMemoryObjectStorage } from "@dads-framework/object-storage-core";

const storage = new InMemoryObjectStorage();
await storage.put("reports/daily.txt", "Ready", "text/plain");
const stored = await storage.get("reports/daily.txt");
if (stored) {
  console.log(stored.contentType, new TextDecoder().decode(stored.body));
}
```

The script prints `text/plain Ready`. The object lives in the current process.

The starter uses the injected storage capability to write and read note attachments and their inspection results. [`apps/kit-workbench/domains/notes/server/attachments.ts`](../../../apps/kit-workbench/domains/notes/server/attachments.ts)

## Provider contract

The `/testing` export provides named conformance cases. Run them against a
provider to check exact bytes and content type, prefix isolation, idempotent
deletion, and the headers callers must send with a signed upload. Provider
tests exercise signing and credential rules against their own backend.
