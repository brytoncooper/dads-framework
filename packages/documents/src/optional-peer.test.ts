import { describe, expect, it } from "vitest";

import { loadOptionalPeer } from "./optional-peer.js";
import { loadPdfRasterizerPeers } from "./pdf/lib/pdfjs-pdf-rasterizer.js";
import { loadPdfmake } from "./pdf/lib/pdfmake-pdf-renderer.js";
import { createWorkbook } from "./xlsx/lib/create-workbook.js";

function missingModuleError(
  message: string,
  code?: "ERR_MODULE_NOT_FOUND" | "MODULE_NOT_FOUND",
): Error {
  return Object.assign(new Error(message), code === undefined ? {} : { code });
}

describe("loadOptionalPeer (documents)", () => {
  it("wraps ERR_MODULE_NOT_FOUND with subpath, package name, install hint, and cause", async () => {
    const cause = missingModuleError(
      "Cannot find package 'pdfmake'",
      "ERR_MODULE_NOT_FOUND",
    );

    const error = await loadOptionalPeer(
      "@dads-framework/documents/pdf",
      "pdfmake",
      () => Promise.reject(cause),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("Expected Error");
    expect(error.message).toBe(
      '@dads-framework/documents/pdf requires optional peer dependency "pdfmake". Install it with: npm install pdfmake',
    );
    expect(error.cause).toBe(cause);
  });

  it("wraps MODULE_NOT_FOUND and Cannot find module/package errors", async () => {
    await expect(
      loadOptionalPeer("@dads-framework/documents/xlsx", "exceljs", () =>
        Promise.reject(
          missingModuleError(
            "Cannot find module 'exceljs'",
            "MODULE_NOT_FOUND",
          ),
        ),
      ),
    ).rejects.toThrow(
      '@dads-framework/documents/xlsx requires optional peer dependency "exceljs". Install it with: npm install exceljs',
    );

    await expect(
      loadOptionalPeer("@dads-framework/documents/pdf", "@napi-rs/canvas", () =>
        Promise.reject(new Error("Cannot find package '@napi-rs/canvas'")),
      ),
    ).rejects.toThrow(
      '@dads-framework/documents/pdf requires optional peer dependency "@napi-rs/canvas". Install it with: npm install @napi-rs/canvas',
    );
  });

  it("rethrows unrelated errors unchanged", async () => {
    const bug = new TypeError("Unexpected peer initialization crash");

    const caught = await loadOptionalPeer(
      "@dads-framework/documents/pdf",
      "pdfmake",
      () => Promise.reject(bug),
    ).catch((error: unknown) => error);

    expect(caught).toBe(bug);
  });

  it("throws a friendly error from loadPdfmake when pdfmake is missing and preserves other errors", async () => {
    const cause = missingModuleError(
      "Cannot find package 'pdfmake'",
      "ERR_MODULE_NOT_FOUND",
    );

    await expect(
      loadPdfmake(() => Promise.reject(cause)),
    ).rejects.toMatchObject({
      message:
        '@dads-framework/documents/pdf requires optional peer dependency "pdfmake". Install it with: npm install pdfmake',
      cause,
    });

    const unrelated = new Error("Font registry failed");
    await expect(loadPdfmake(() => Promise.reject(unrelated))).rejects.toBe(
      unrelated,
    );
  });

  it("throws a friendly error from loadPdfRasterizerPeers when pdfjs-dist or @napi-rs/canvas is missing", async () => {
    const pdfjsCause = missingModuleError(
      "Cannot find package 'pdfjs-dist'",
      "ERR_MODULE_NOT_FOUND",
    );

    await expect(
      loadPdfRasterizerPeers({
        loadPdfjs: () => Promise.reject(pdfjsCause),
      }),
    ).rejects.toMatchObject({
      message:
        '@dads-framework/documents/pdf requires optional peer dependency "pdfjs-dist". Install it with: npm install pdfjs-dist',
      cause: pdfjsCause,
    });

    const canvasCause = missingModuleError(
      "Cannot find package '@napi-rs/canvas'",
      "ERR_MODULE_NOT_FOUND",
    );

    await expect(
      loadPdfRasterizerPeers({
        loadCanvas: () => Promise.reject(canvasCause),
      }),
    ).rejects.toMatchObject({
      message:
        '@dads-framework/documents/pdf requires optional peer dependency "@napi-rs/canvas". Install it with: npm install @napi-rs/canvas',
      cause: canvasCause,
    });
  });

  it("throws a friendly error from createWorkbook when exceljs is missing and rethrows unrelated errors", async () => {
    const cause = missingModuleError(
      "Cannot find package 'exceljs'",
      "ERR_MODULE_NOT_FOUND",
    );

    await expect(
      createWorkbook(() => Promise.reject(cause)),
    ).rejects.toMatchObject({
      message:
        '@dads-framework/documents/xlsx requires optional peer dependency "exceljs". Install it with: npm install exceljs',
      cause,
    });

    const unrelated = new Error("Broken native addon");
    await expect(createWorkbook(() => Promise.reject(unrelated))).rejects.toBe(
      unrelated,
    );
  });
});
