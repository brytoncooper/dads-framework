/**
 * Store a batch of reported client faults.
 *
 * The one rule worth stating at this level: **recording a fault may never
 * become a second fault.** A client reporting an error is already having a bad
 * time, and a report that fails to store must not answer 500 and invite a
 * retry loop that reports the failure to report. The route answers with how
 * many rows were stored; a storage failure is logged here and reported as
 * zero accepted.
 */

import { mintEntityId } from "@dads-framework/contract";
import type { ClientDiagnosticEvent } from "@dads-framework/contract";

import type { ClientDiagnosticWriter } from "../database/writers/client-diagnostic-writer.interface.js";
import { clientDiagnosticEventIdSchema } from "./client-diagnostic-event.ids.js";
import {
  clientDiagnosticRow,
  type ReportingActor,
} from "./logic/client-diagnostic-row.js";

/** The narrow logger this needs; the kit never holds a whole pino instance. */
export type ClientDiagnosticsLog = {
  error(entry: object, message: string): void;
};

export class RecordClientDiagnostics {
  constructor(
    private readonly writer: ClientDiagnosticWriter,
    private readonly log: ClientDiagnosticsLog,
  ) {}

  async execute(input: {
    readonly events: readonly ClientDiagnosticEvent[];
    readonly actor: ReportingActor;
  }): Promise<{ readonly accepted: number }> {
    const rows = input.events.map((event) =>
      clientDiagnosticRow({
        event,
        actor: input.actor,
        id: mintEntityId(clientDiagnosticEventIdSchema),
      }),
    );
    try {
      return { accepted: await this.writer.record(rows) };
    } catch (error) {
      this.log.error(
        {
          event: "client-diagnostics.store-failed",
          err: error,
          events: rows.length,
        },
        "client diagnostics could not be stored",
      );
      return { accepted: 0 };
    }
  }
}
