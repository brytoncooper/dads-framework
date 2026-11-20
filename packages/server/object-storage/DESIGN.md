# Object storage — design

Rules this lib keeps that its README does not state. Each cites the test that proves it.

## Rules

- **disk-multipart-reads-back**: A disk multipart upload completes through the same whole-or-absent write as a plain put, so the finished object reads back, with the metadata its upload fixed, after any restart on the same root. — proven by: disk-direct-transfer-storage.test.ts::stores parts, completes them in order, and the disk store reads the object back; disk-direct-transfer-storage.test.ts::survives a new instance on the same root: open uploads, parts and objects
- **disk-part-needs-valid-link**: The disk twin of browser-direct storage stores a part only for an unchanged, unexpired signed link whose upload is open for the same key, and only the byte count the link names; anything else stores nothing. — proven by: disk-direct-transfer-storage.test.ts::stores nothing for a tampered, expired or wrong-size link, or an upload of another key
