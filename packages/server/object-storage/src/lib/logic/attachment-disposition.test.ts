/**
 * What: download links always carry an attachment disposition with a safe
 * quoted fallback and the exact UTF-8 name.
 * Why: a stored object must never render in the bucket's origin, and a file
 * name is user input that must not be able to end the header's quoted string.
 */
import { describe, expect, it } from "vitest";

import { attachmentDisposition } from "./attachment-disposition.js";

describe("attachmentDisposition", () => {
  it("keeps a plain ASCII name in both forms", () => {
    expect(attachmentDisposition("pump manual.pdf")).toBe(
      `attachment; filename="pump manual.pdf"; filename*=UTF-8''pump%20manual.pdf`,
    );
  });

  it("replaces quote, backslash and non-ASCII characters in the fallback", () => {
    const header = attachmentDisposition('Bomba "Ñ"\\(1).pdf');
    expect(header).toContain(`filename="Bomba ____(1).pdf"`);
    expect(header).toContain("filename*=UTF-8''Bomba%20%22%C3%91%22%5C%281%29.pdf");
  });

  it("falls back to a generic name when nothing printable remains", () => {
    expect(attachmentDisposition("")).toContain(`filename="download"`);
  });
});
