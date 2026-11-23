import type { GenerationPlan } from "./generation-plan.js";
import { camel, pascal } from "./names.js";

export function resourceStore(plan: GenerationPlan, domain: string, name: string): void {
  const base = `domains/${domain}/server`;
  plan.create(`${base}/${name}-store.ts`, ports(name));
  plan.create(`${base}/${name}-reader.ts`, reader(name));
  plan.create(`${base}/${name}-writer.ts`, writer(name));
}

function ports(name: string): string {
  const record = pascal(name);
  return `import type { SubjectRef } from "@dads-framework/access/runtime";

import type { ${record}, ${record}Update } from "../contract/${name}-resource.js";

export type ${record}Reader = {
  list(input: { readonly tenantId: string; readonly page: number; readonly perPage: number }): Promise<{
    readonly items: readonly ${record}[];
    readonly total: number;
  }>;
  read(tenantId: string, id: string): Promise<${record} | undefined>;
};

export type ${record}Writer = {
  save(subject: SubjectRef, tenantId: string, id: string, input: ${record}Update): Promise<${record} | undefined>;
};
`;
}

function reader(name: string): string {
  const record = pascal(name);
  const item = camel(name);
  return `import { loadPageAndTotal, sqlOffsetForPage, type DrizzleHandle } from "@dads-framework/postgres";
import { and, count, eq } from "drizzle-orm";

import type { ${record}Reader } from "./${name}-store.js";
import { ${item}Table } from "./${name}-table.js";

const fields = {
  id: ${item}Table.id,
  title: ${item}Table.title,
  rowVersion: ${item}Table.rowVersion,
};

export function ${item}Reader(db: DrizzleHandle): ${record}Reader {
  return {
    async read(tenantId, id) {
      const [row] = await db.select(fields).from(${item}Table).where(and(eq(${item}Table.id, id), eq(${item}Table.tenantId, tenantId))).limit(1);
      return row;
    },
    async list({ tenantId, page, perPage }) {
      const scope = eq(${item}Table.tenantId, tenantId);
      const { rows, total } = await loadPageAndTotal(
        db.select(fields).from(${item}Table).where(scope).orderBy(${item}Table.id).limit(perPage).offset(sqlOffsetForPage(page, perPage)),
        db.select({ total: count() }).from(${item}Table).where(scope),
      );
      return { items: rows, total };
    },
  };
}
`;
}

function writer(name: string): string {
  const record = pascal(name);
  const item = camel(name);
  return `import { updateAtRowVersion } from "@dads-framework/postgres";
import { sql } from "drizzle-orm";

import type { WriteWithPermission } from "../../../libraries/app-runtime/index.js";
import { ${item}EditPermission } from "../access/${name}-guards.js";
import type { ${record}Writer } from "./${name}-store.js";
import { ${item}Table } from "./${name}-table.js";

export function ${item}Writer(writeWithPermission: WriteWithPermission): ${record}Writer {
  return {
    save(subject, tenantId, id, input) {
      return writeWithPermission({ subject, permission: ${item}EditPermission, resourceId: tenantId }, async (tx) => {
        const [saved] = await updateAtRowVersion(tx, ${item}Table, {
          where: sql\`\${${item}Table.id} = \${id} AND \${${item}Table.tenantId} = \${tenantId}\`,
          expectedRowVersion: input.expectedRowVersion,
          changes: { title: input.title },
        });
        if (saved === undefined) return undefined;
        return { id, title: input.title, rowVersion: saved.rowVersion };
      });
    },
  };
}
`;
}
