# @dads-framework/object-storage

Put, get, delete, and sign download or single-PUT upload URLs for object bytes. The composition
root picks the in-memory driver, the S3-compatible driver or the local disk driver
(`OBJECT_STORAGE_DRIVER`).

`DiskObjectStorage` keeps each object at `<root>/objects/<key>` with a SHA-256 sidecar. Writes are
whole or absent, a disk floor refuses a new file before the volume fills, and signed links are
path-only and HMAC-signed with a key the box makes (`loadOrCreateDiskSigningKey`).

`DirectTransferStorage` is the browser-direct seam on the same bucket:
server-chosen multipart uploads, presigned part and attachment-download URLs,
and the reads that verify a finished upload. See
docs/reference/object-storage.md.

The package re-exports the capability and in-memory implementation from
[`@dads-framework/object-storage-core`](../object-storage-core/README.md).
The core's conformance suite also runs against the disk and S3 implementations.

## Download delivery

S3 options can carry one `CloudFrontDownloadSigner`, shared by
`getSignedUrl` and `presignAttachmentDownload`. Its deployment-owned HTTPS base
URL includes the public path prefix; callers use returned URLs unchanged. Native
CloudFront signatures cover the exact object path and optional `download`
filename query. The signer accepts published keys only, rejects `quarantine/`,
and limits link validity to one hour. Its clock is injected.

Uploads, object verification and server reads retain the configured S3 client.
Without the download signer, local MinIO and staged AWS environments retain S3
GET signatures. Browser download buttons navigate to attachment links; they do
not fetch the file into application memory. Routing, trusted public keys and an
ACTIVE qualified flat-rate plan must precede production signer cutover.
