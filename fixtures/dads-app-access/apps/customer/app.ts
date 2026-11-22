import {
  composeApi,
  definePlugin,
  defineService,
  providePlugin,
} from "@dads-framework/plugin";
import type { PostgresAuthorization } from "@dads-framework/postgres-access";
import type { Pool } from "pg";

import { assembleAuthorization } from "../../assembly/authorization.js";
import { organization, user } from "../../domains/documents/access/index.js";
import {
  documentsRoutes,
  type DocumentsRepository,
} from "../../domains/documents/server/routes.js";

const appServices = defineService("customer-services").ofType<{
  readonly authorization: PostgresAuthorization;
  readonly documents: DocumentsRepository;
}>();

const documentsPlugin = definePlugin({
  name: "documents",
  requires: [appServices],
  contributes: { access: [user, organization] },
  setup: ({ use }) => ({
    routes: documentsRoutes(use(appServices).documents),
  }),
});

/** Composes the customer API from assembled services + domain plugins. */
export function buildCustomerApi(pool: Pool, documents: DocumentsRepository) {
  const servicesPlugin = providePlugin("host-services", appServices, () => ({
    authorization: assembleAuthorization(pool),
    documents,
  }));

  return composeApi("customer", {
    services: [servicesPlugin],
    routes: [documentsPlugin],
    jobs: [],
  });
}
