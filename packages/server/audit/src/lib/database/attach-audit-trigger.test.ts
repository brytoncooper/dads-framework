/**
 * WHAT: `attachAuditTrigger` emits the same `CREATE TRIGGER` statement the
 * installing migration's `pg_tables` loop emits.
 *
 * WHY the exact text is asserted: a future table's migration is the only
 * place that statement is written, and a drifted argument — a missing owner
 * column, key columns joined with `, ` instead of `,` — would not fail the
 * migration. It would produce audit rows with an empty `row_key` or a null
 * `owner_partition_id`, which reads as "nothing to say" rather than as a bug.
 */
import { describe, expect, it } from "vitest";
import {
  attachAuditTrigger,
  detachAuditTrigger,
  type AuditTriggerMigrationBuilder,
} from "./attach-audit-trigger.js";

function recordingMigrationBuilder(): {
  pgm: AuditTriggerMigrationBuilder;
  statements: string[];
} {
  const statements: string[] = [];
  return {
    pgm: {
      sql(statement: string): void {
        statements.push(statement);
      },
    },
    statements,
  };
}

describe("attachAuditTrigger", () => {
  it("emits the trigger with its key columns and owner column", () => {
    const { pgm, statements } = recordingMigrationBuilder();

    attachAuditTrigger(pgm, "orders", {
      keyColumns: ["id"],
      ownerColumn: "organization_id",
    });

    expect(statements).toEqual([
      `CREATE TRIGGER audit_record AFTER INSERT OR UPDATE OR DELETE ON "orders" FOR EACH ROW EXECUTE FUNCTION audit_record('id', 'organization_id')`,
    ]);
  });

  it("joins a composite key with commas and no spaces", () => {
    const { pgm, statements } = recordingMigrationBuilder();

    attachAuditTrigger(pgm, "order_party_roles", {
      keyColumns: ["order_id", "party_id", "role"],
    });

    expect(statements).toEqual([
      `CREATE TRIGGER audit_record AFTER INSERT OR UPDATE OR DELETE ON "order_party_roles" FOR EACH ROW EXECUTE FUNCTION audit_record('order_id,party_id,role', '')`,
    ]);
  });

  it("passes an empty key list for a table nothing keys", () => {
    const { pgm, statements } = recordingMigrationBuilder();

    attachAuditTrigger(pgm, "edge_device_reports", { keyColumns: [] });

    expect(statements).toEqual([
      `CREATE TRIGGER audit_record AFTER INSERT OR UPDATE OR DELETE ON "edge_device_reports" FOR EACH ROW EXECUTE FUNCTION audit_record('', '')`,
    ]);
  });

  it("refuses a name that is not a plain identifier", () => {
    const { pgm } = recordingMigrationBuilder();

    expect(() => {
      attachAuditTrigger(pgm, `orders"; DROP TABLE audit_log; --`, {
        keyColumns: ["id"],
      });
    }).toThrow(/is not a plain lowercase identifier/u);
    expect(() => {
      attachAuditTrigger(pgm, "orders", { keyColumns: ["id; --"] });
    }).toThrow(/is not a plain lowercase identifier/u);
    expect(() => {
      attachAuditTrigger(pgm, "orders", {
        keyColumns: ["id"],
        ownerColumn: "Organization_Id",
      });
    }).toThrow(/is not a plain lowercase identifier/u);
  });
});

describe("detachAuditTrigger", () => {
  it("drops the trigger by its fixed name", () => {
    const { pgm, statements } = recordingMigrationBuilder();

    detachAuditTrigger(pgm, "orders");

    expect(statements).toEqual([`DROP TRIGGER audit_record ON "orders"`]);
  });
});
