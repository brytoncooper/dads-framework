import { getSignedUrl } from "@aws-sdk/cloudfront-signer";
import { createPrivateKey } from "node:crypto";

export type CloudFrontDownloadSignerOptions = {
  readonly baseUrl: string;
  readonly keyPairId: string;
  readonly privateKey: string;
  readonly now: () => Date;
};

/** Native CloudFront signatures cover the exact path and per-viewer filename. */
export class CloudFrontDownloadSigner {
  private readonly baseUrl: string;
  private readonly now: () => Date;

  constructor(private readonly options: CloudFrontDownloadSignerOptions) {
    const base = new URL(options.baseUrl);
    if (
      base.protocol !== "https:" ||
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      /[*?]/.test(base.pathname)
    ) {
      throw new Error(
        "CloudFront download base URL must be an HTTPS URL without credentials, query or fragment",
      );
    }
    this.baseUrl = base.href.replace(/\/$/, "");
    const privateKey = createPrivateKey(options.privateKey);
    if (
      privateKey.asymmetricKeyType !== "rsa" ||
      privateKey.asymmetricKeyDetails?.modulusLength !== 2048
    ) {
      throw new Error("CloudFront signing requires a 2048-bit RSA private key");
    }
    this.now = options.now;
  }

  sign(key: string, expiresInSeconds: number, fileName?: string): string {
    if (
      !Number.isInteger(expiresInSeconds) ||
      expiresInSeconds < 1 ||
      expiresInSeconds > 3600
    ) {
      throw new Error(
        "CloudFront download expiry must be between 1 and 3600 seconds",
      );
    }
    if (
      key
        .split("/")
        .some((part) => part === "" || part === "." || part === "..") ||
      containsForbiddenKeyCharacter(key) ||
      key.startsWith("quarantine/")
    ) {
      throw new Error("Object download key must identify one published object");
    }
    const url = new URL(
      `${this.baseUrl}/${key.split("/").map(encodeURIComponent).join("/")}`,
    );
    if (fileName !== undefined) url.searchParams.set("download", fileName);
    return getSignedUrl({
      url: url.href.replace(/\*/g, "%2A"),
      keyPairId: this.options.keyPairId,
      privateKey: this.options.privateKey,
      dateLessThan: new Date(
        this.now().getTime() + expiresInSeconds * 1000,
      ).toISOString(),
    });
  }
}

function containsForbiddenKeyCharacter(value: string): boolean {
  if (/[*?\\]/.test(value)) return true;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}
