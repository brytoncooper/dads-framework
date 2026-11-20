import { lt } from "drizzle-orm";
import type { DrizzleHandle } from "@dads-framework/postgres";
import { requestLog } from "../generated-tables/request-log.tables.js";
import type { RequestLogWriter } from "./request-log-writer.interface.js";

/** Drizzle adapter for the `request_log` retention sweep. */
export class DrizzleRequestLogWriter implements RequestLogWriter {
  constructor(private readonly db: DrizzleHandle) {}

  async deleteRecordedBefore(cutoff: Date): Promise<number> {
    const deleted = await this.db
      .delete(requestLog)
      .where(lt(requestLog.recordedAt, cutoff))
      .returning({ requestId: requestLog.requestId });
    return deleted.length;
  }
}
