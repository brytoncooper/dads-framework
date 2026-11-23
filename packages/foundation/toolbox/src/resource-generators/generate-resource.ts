import { addResourceGuards } from "./access-generator.js";
import type { GenerationPlan } from "./generation-plan.js";
import { resourceContract } from "./resource-contract.js";
import { resourcePages } from "./resource-pages.js";
import { resourceProof } from "./resource-proof.js";
import { resourceRoutes } from "./resource-routes.js";
import { resourceStore } from "./resource-store.js";
import { addTable } from "./table-generator.js";

export function addResource(plan: GenerationPlan, root: string, domain: string, name: string): void {
  addTable(plan, root, domain, name);
  addResourceGuards(plan, domain, name);
  resourceContract(plan, domain, name);
  resourceStore(plan, domain, name);
  resourceRoutes(plan, domain, name);
  resourcePages(plan, domain, name);
  resourceProof(plan, domain, name);
}
