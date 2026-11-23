import { notFound } from "@dads-framework/core/errors";
import {
  getRoute,
  patchRoute,
  routeGroup,
  type HttpRoute,
} from "@dads-framework/http";
import { z } from "zod";

import { canEditDocument, canViewDocument } from "../access/index.js";

export type DocumentsRepository = {
  findById(documentId: string): Promise<{ id: string; title: string } | null>;
  /** Re-checks edit permission inside withProtectedPgTransaction before updating. */
  renameInProtectedTx(
    actorId: string,
    documentId: string,
    title: string,
  ): Promise<{ id: string; title: string } | null>;
};

const documentParams = z.object({ documentId: z.string().min(1) });
const documentResponse = z.object({ id: z.string(), title: z.string() });
const renameBody = z.object({ title: z.string().min(1).max(200) });

/** Routes stay database-free: guards run before Zod parsing and handlers. */
export function documentsRoutes(repository: DocumentsRepository): HttpRoute[] {
  return routeGroup("Documents", [
    getRoute({
      route: { method: "GET", template: "/documents/:documentId" },
      summary: "Get one document",
      access: canViewDocument,
      params: documentParams,
      response: documentResponse,
      handler: async ({ params }) => {
        const record = await repository.findById(params.documentId);
        if (record === null) throw notFound("Document", params.documentId);
        return record;
      },
    }),
    patchRoute({
      route: { method: "PATCH", template: "/documents/:documentId" },
      summary: "Rename a document",
      access: canEditDocument,
      params: documentParams,
      body: renameBody,
      response: documentResponse,
      handler: async ({ params, body, subject }) => {
        const updated = await repository.renameInProtectedTx(
          subject.id,
          params.documentId,
          body.title,
        );
        if (updated === null) throw notFound("Document", params.documentId);
        return updated;
      },
    }),
  ]);
}
