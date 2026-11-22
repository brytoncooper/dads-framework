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
  rename(
    documentId: string,
    title: string,
  ): Promise<{ id: string; title: string }>;
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
        return record ?? { id: params.documentId, title: "" };
      },
    }),
    patchRoute({
      route: { method: "PATCH", template: "/documents/:documentId" },
      summary: "Rename a document",
      access: canEditDocument,
      params: documentParams,
      body: renameBody,
      response: documentResponse,
      handler: ({ params, body }) =>
        repository.rename(params.documentId, body.title),
    }),
  ]);
}
