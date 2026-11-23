// @vitest-environment jsdom
import { it } from "vitest";

import { runEmailDocumentRendererLaws } from "../../../test-support/email-document-renderer-laws.js";
import { openPreviewEmailDocumentRenderer } from "../../../test-support/preview-email-document-renderer.js";
import { createReactEmailDocumentRenderer } from "./email-document-renderer.js";

runEmailDocumentRendererLaws(
  () => createReactEmailDocumentRenderer(),
  (name, run) => {
    it(`React Email ${name}`, async () => {
      await run();
    });
  },
);

runEmailDocumentRendererLaws(
  () => openPreviewEmailDocumentRenderer(),
  (name, run) => {
    it(`independent preview ${name}`, async () => {
      await run();
    });
  },
);
