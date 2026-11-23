import type { getSignedUrl } from "@aws-sdk/cloudfront-signer";

import { requireAwsSdk, resolveAwsSdk } from "./optional-aws-sdk.js";

type CloudFrontSigner = {
  readonly getSignedUrl: typeof getSignedUrl;
};

let signer: CloudFrontSigner | undefined;

export function loadCloudFrontSigner(): CloudFrontSigner {
  if (!signer) {
    resolveAwsSdk("@aws-sdk/cloudfront-signer", "CloudFront download signing");
    const sdk: unknown = requireAwsSdk("@aws-sdk/cloudfront-signer");
    if (!isCloudFrontSigner(sdk)) {
      throw new Error("@aws-sdk/cloudfront-signer must export getSignedUrl");
    }
    signer = sdk;
  }
  return signer;
}

function isCloudFrontSigner(sdk: unknown): sdk is CloudFrontSigner {
  return typeof sdk === "object" && sdk !== null && "getSignedUrl" in sdk && typeof sdk.getSignedUrl === "function";
}
