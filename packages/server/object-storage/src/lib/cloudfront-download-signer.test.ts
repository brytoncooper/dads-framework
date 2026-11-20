import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";

import { CloudFrontDownloadSigner } from "./cloudfront-download-signer.js";
import { S3DirectTransferStorage } from "./s3-direct-transfer-storage.js";
import { S3ObjectStorage } from "./s3-object-storage.js";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKey = keys.privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
const now = new Date("2026-10-19T12:00:00Z");
const signer = new CloudFrontDownloadSigner({
  baseUrl: "https://app.example.com/files",
  keyPairId: "KEXAMPLE",
  privateKey,
  now: () => now,
});

function verifiedResource(signed: string): string {
  const url = new URL(signed);
  const expires = url.searchParams.get("Expires");
  const signature = url.searchParams.get("Signature") ?? "";
  expect(url.searchParams.get("Key-Pair-Id")).toBe("KEXAMPLE");
  const resourceQuery = url.search
    .slice(1)
    .split("&")
    .filter((parameter) => !/^(Expires|Signature|Key-Pair-Id)=/.test(parameter))
    .join("&");
  const resource = `${url.origin}${url.pathname}${resourceQuery ? `?${resourceQuery}` : ""}`;
  const policy = JSON.stringify({
    Statement: [
      {
        Resource: resource,
        Condition: { DateLessThan: { "AWS:EpochTime": Number(expires) } },
      },
    ],
  });
  const decoded = Buffer.from(
    signature.replace(/-/g, "+").replace(/_/g, "=").replace(/~/g, "/"),
    "base64",
  );
  expect(verify("RSA-SHA1", Buffer.from(policy), keys.publicKey, decoded)).toBe(
    true,
  );
  return resource;
}

describe("CloudFrontDownloadSigner", () => {
  it("signs an exact encoded resource and attachment filename together", () => {
    const signed = signer.sign(
      "maintenance/manual with #.pdf",
      300,
      'Mañana "one".pdf',
    );
    const resource = new URL(verifiedResource(signed));
    expect(resource.pathname).toBe(
      "/files/maintenance/manual%20with%20%23.pdf",
    );
    expect(resource.searchParams.get("download")).toBe('Mañana "one".pdf');
    expect(new URL(signed).searchParams.get("Expires")).toBe(
      String(now.getTime() / 1000 + 300),
    );
  });
  it("encodes filename asterisks so the signed resource has no wildcard", () => {
    const signed = signer.sign("manual.pdf", 60, "report*.pdf");
    const resource = verifiedResource(signed);
    expect(resource).not.toContain("*");
    expect(resource).toContain("download=report%2A.pdf");
    expect(new URL(resource).searchParams.get("download")).toBe("report*.pdf");
  });
  it.each([
    "https://app.example.com/files",
    "https://downloads.example.com/private/objects",
  ])(
    "uses the configured base %s for both download methods without AWS credentials",
    async (baseUrl) => {
      const options = {
        region: "us-west-1",
        bucket: "private",
        useBucketInPath: false,
        downloadSigner: new CloudFrontDownloadSigner({
          baseUrl,
          keyPairId: "KEXAMPLE",
          privateKey,
          now: () => now,
        }),
      };
      const object = await new S3ObjectStorage(options).getSignedUrl(
        "avatars/hash.webp",
        60,
      );
      const attachment = await new S3DirectTransferStorage(
        options,
      ).presignAttachmentDownload({
        key: "manual.pdf",
        fileName: "Manual.pdf",
        expiresInSeconds: 60,
      });
      expect(verifiedResource(object)).toBe(`${baseUrl}/avatars/hash.webp`);
      const attachmentResource = new URL(verifiedResource(attachment));
      expect(`${attachmentResource.origin}${attachmentResource.pathname}`).toBe(
        `${baseUrl}/manual.pdf`,
      );
      expect(attachmentResource.searchParams.get("download")).toBe(
        "Manual.pdf",
      );
    },
  );
  it("rejects traversal, wildcard resources, temporary uploads and unbounded expiry", () => {
    for (const key of [
      "../secret",
      "x/../secret",
      "x/*",
      "x//y",
      "/secret",
      "quarantine/identity/x",
    ]) {
      expect(() => signer.sign(key, 60)).toThrow();
    }
    for (const expiry of [0, -1, 3601, Infinity, 1.5])
      expect(() => signer.sign("x", expiry)).toThrow();
  });
});
