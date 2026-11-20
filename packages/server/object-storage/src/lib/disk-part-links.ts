/**
 * The shape of a disk part link: what one signs, how its query reads back,
 * and the field list the HMAC covers. `DiskObjectStorage` owns the key and
 * does the signing; nothing here touches the disk.
 */

/** What a part link signs: one part of one open disk multipart upload. */
export type PartUploadLinkRequest = {
  readonly key: string;
  readonly storageUploadId: string;
  readonly partNumber: number;
  /** When given, the link accepts exactly this many bytes. */
  readonly byteSize?: number;
  readonly expiresInSeconds: number;
};

/** A part link's query values, as the file route received them. */
export type SignedPartUploadQuery = {
  readonly key: string;
  readonly upload: string;
  readonly part: string;
  /** Absent when the link was signed without a byte count. */
  readonly bytes?: string;
  readonly expires: string;
  readonly sig: string;
};

/** The part a checked link names; `byteSize` is null when it names no byte count. */
export type SignedPartUpload = {
  readonly key: string;
  readonly storageUploadId: string;
  readonly partNumber: number;
  readonly byteSize: number | null;
};

/** The values a part link signs, as query strings; `bytes` is "" for no byte count. */
export type PartLinkValues = {
  readonly key: string;
  readonly upload: string;
  readonly part: string;
  readonly bytes: string;
  readonly expires: string;
};

/** The disk twin's own upload ids: lowercase UUIDs, so one can never name a path. */
const STORAGE_UPLOAD_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** S3's part numbers: 1 to 10000. */
const PART_NUMBER = /^[1-9][0-9]{0,4}$/;
const MAX_PART_NUMBER = 10_000;
const BYTE_COUNT = /^(0|[1-9][0-9]{0,11})$/;
/** Signs a part link; no GET or write-once link starts with it. */
const PART_LINK_METHOD = "PUT-PART";

/** The values a new part link signs, expiring at `expires` (unix seconds). */
export function partLinkValues(
  request: PartUploadLinkRequest,
  expires: string,
): PartLinkValues {
  return {
    key: request.key,
    upload: request.storageUploadId,
    part: String(request.partNumber),
    bytes: request.byteSize === undefined ? "" : String(request.byteSize),
    expires,
  };
}

/** The link's query string; `bytes` is left out when the link names no byte count. */
export function partLinkQueryString(
  values: PartLinkValues,
  sig: string,
): string {
  return new URLSearchParams({
    key: values.key,
    upload: values.upload,
    part: values.part,
    ...(values.bytes === "" ? {} : { bytes: values.bytes }),
    expires: values.expires,
    sig,
  }).toString();
}

/** The fields the HMAC covers, in order. */
export function partSignedFields(values: PartLinkValues): string[] {
  return [
    PART_LINK_METHOD,
    values.key,
    values.upload,
    values.part,
    values.bytes,
    values.expires,
  ];
}

/**
 * The part a received query names when its upload id, part number and byte
 * count are in shape; null otherwise. It checks neither the key, the expiry
 * nor the signature: `DiskObjectStorage.readSignedPartUpload` does.
 */
export function partNamedByQuery(
  query: SignedPartUploadQuery,
): SignedPartUpload | null {
  const bytes = query.bytes ?? "";
  if (!STORAGE_UPLOAD_ID.test(query.upload)) return null;
  if (!PART_NUMBER.test(query.part) || Number(query.part) > MAX_PART_NUMBER)
    return null;
  if (bytes !== "" && !BYTE_COUNT.test(bytes)) return null;
  return {
    key: query.key,
    storageUploadId: query.upload,
    partNumber: Number(query.part),
    byteSize: bytes === "" ? null : Number(bytes),
  };
}
