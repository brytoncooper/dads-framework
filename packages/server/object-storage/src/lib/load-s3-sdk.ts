import type * as S3Sdk from "@aws-sdk/client-s3";
import type * as S3Presigner from "@aws-sdk/s3-request-presigner";

import { resolveAwsSdk } from "./optional-aws-sdk.js";

let sdk: Promise<typeof S3Sdk> | undefined;
let presigner: Promise<typeof S3Presigner> | undefined;

export function loadS3Sdk() {
  if (!sdk) {
    resolveAwsSdk("@aws-sdk/client-s3", "S3 object storage");
    sdk = import("@aws-sdk/client-s3");
  }
  return sdk;
}

export function loadS3Presigner() {
  if (!presigner) {
    resolveAwsSdk("@aws-sdk/s3-request-presigner", "S3 URL signing");
    presigner = import("@aws-sdk/s3-request-presigner");
  }
  return presigner;
}
