# @dads-framework/object-storage-core

Use `ObjectStorage` for application code that reads and writes objects by key.
Use `InMemoryObjectStorage` for unit tests and local composition. Applications
can choose a disk or S3 implementation from
[`@dads-framework/object-storage`](../object-storage/README.md).

## Try it

```ts
import { InMemoryObjectStorage } from "@dads-framework/object-storage-core";

const storage = new InMemoryObjectStorage();
await storage.put("reports/daily.txt", "Ready", "text/plain");
console.log((await storage.get("reports/daily.txt"))?.contentType); // text/plain
```

## Provider contract

The `/testing` export provides named conformance cases. Run them against a
provider to check exact bytes and content type, prefix isolation, idempotent
deletion, and the headers callers must send with a signed upload. Provider
tests exercise signing and credential rules against their own backend.
