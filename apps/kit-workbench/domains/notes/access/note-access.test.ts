import { compileAccess, emitZed } from "@dads-framework/access";
import { createAccessClient } from "@dads-framework/access/runtime";
import { FakeAuthorization } from "@dads-framework/access/testing";
import { mintEntityId } from "@dads-framework/core/contract";
import { tenantIdSchema } from "@dads-framework/identity/tenants";
import { describe, expect, expectTypeOf, it } from "vitest";

import { account, accountAccess, tenantAccess } from "../../../libraries/app-runtime/index.js";
import { noteIdSchema, type NoteId } from "../contract/wire.js";
import { note } from "./index.js";

describe("note access resource", () => {
  it("enforces branded NoteId on note(id) and compiles under tenant", () => {
    const noteId = mintEntityId(noteIdSchema);
    const tenantId = tenantIdSchema.parse("0194f4a0-1234-7000-8000-000000000002");
    const noteRef = note(noteId);
    const tenantRef = tenantAccess.tenant(tenantId);

    expectTypeOf(noteRef.id).toEqualTypeOf<NoteId>();
    expectTypeOf(note).parameter(0).toEqualTypeOf<NoteId>();
    expect(note.idSchema).toBe(noteIdSchema);
    expect(noteRef.id).toBe(noteId);
    expect(noteRef.view.resource).toEqual({ type: "note", id: noteId });
    expect(tenantRef.id).toBe(tenantId);

    const model = compileAccess([accountAccess, tenantAccess.tenant, note], {
      allowLookupResourcesOn: [tenantAccess.tenant],
    });
    const zed = emitZed(model);
    expect(zed).toContain("definition note {");
    expect(zed).toContain("relation tenant: tenants/tenant");
    expect(zed).toContain("permission view = tenant->view");
  });

  it("links a branded note to its parent tenant and denies unrelated accounts", async () => {
    const noteId = mintEntityId(noteIdSchema);
    const tenantId = tenantIdSchema.parse("0194f4a0-1234-7000-8000-000000000002");
    const fake = new FakeAuthorization({
      [tenantAccess.tenant.wireName]: { view: ["member"] },
    });
    const client = createAccessClient(fake);

    await client.add(tenantAccess.tenant(tenantId), note(noteId).tenant);
    await client.add(account("member-1"), tenantAccess.tenant(tenantId).member);

    expect(await client.can(account("member-1"), tenantAccess.tenant(tenantId).view)).toBe(true);
    expect(await client.can(account("outsider-1"), tenantAccess.tenant(tenantId).view)).toBe(false);
    expect(await client.listDirect(note(noteId).tenant)).toEqual([
      { type: tenantAccess.tenant.wireName, id: tenantId },
    ]);
  });
});
