import { and, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { requestIdSchema } from "@dads-framework/http";
import type { DrizzleHandle } from "@dads-framework/postgres";

import { requestLog } from "../generated-tables/request-log.tables.js";
import type { RequestLogReader } from "./request-log-reader.interface.js";
import {
  type RefusedRequest,
  type RefusedRequestFilter,
  type RequestLogCursor,
  type RequestLogEntry,
} from "./request-log-reader.interface.js";

/** The decisions that mean the request was refused rather than served or broken. */
const REFUSAL_DECISIONS = ["denied", "not-found", "unauthenticated"];

/**
 * A refusal worth reading has someone behind it. Requests before sign-in
 * (`anonymous`, no actor id) are mostly sign-in pages and probes, and would
 * bury the refusals of people who were signed in.
 */
const SIGNED_IN_ACTOR = [ne(requestLog.actorKind, "anonymous"), ne(requestLog.actorId, "")];

/** A refusal must come from this application's enforcement. */
const LOCAL_ENFORCEMENT = eq(requestLog.imported, false);

const RECORDED_AT_EXACT = sql<string>`to_char(${requestLog.recordedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * Drizzle adapter for reading `request_log`: one request by its primary key
 * for an audit entry's detail, and the refusals in a bounded window. The
 * window keeps the refusal read on `request_log_recorded_at_idx`; the table is
 * pruned to 90 days, so it never reaches further back than that.
 */
export class DrizzleRequestLogReader implements RequestLogReader {
  constructor(private readonly db: DrizzleHandle) {}

  async findRequest(requestId: string): Promise<RequestLogEntry | null> {
    // A value that is not a request id names no request.
    const parsed = requestIdSchema.safeParse(requestId);
    if (!parsed.success) return null;
    const [row] = await this.db
      .select({
        requestId: requestLog.requestId,
        recordedAt: requestLog.recordedAt,
        method: requestLog.method,
        routeId: requestLog.routeId,
        status: requestLog.status,
        ip: requestLog.ip,
        userAgent: requestLog.userAgent,
        clientContext: requestLog.clientContext,
      })
      .from(requestLog)
      .where(eq(requestLog.requestId, parsed.data))
      .limit(1);
    return row ?? null;
  }

  async listRefusals(
    filter: RefusedRequestFilter,
    olderThan: RequestLogCursor | null,
    limit: number,
  ): Promise<readonly RefusedRequest[]> {
    const rows = await this.db
      .select({
        requestId: requestLog.requestId,
        recordedAt: requestLog.recordedAt,
        recordedAtExact: RECORDED_AT_EXACT,
        actorKind: requestLog.actorKind,
        actorId: requestLog.actorId,
        decision: requestLog.decision,
        permission: requestLog.permission,
        routeId: requestLog.routeId,
        method: requestLog.method,
      })
      .from(requestLog)
      .where(
        and(
          gte(requestLog.recordedAt, filter.since),
          inArray(requestLog.decision, REFUSAL_DECISIONS),
          ...SIGNED_IN_ACTOR,
          LOCAL_ENFORCEMENT,
          userCondition(filter.userId),
          olderThanRequestCursor(olderThan),
        ),
      )
      .orderBy(desc(requestLog.recordedAt), desc(requestLog.requestId))
      .limit(limit);
    return rows.map(({ recordedAtExact, ...row }) => ({
      ...row,
      cursor: { recordedAt: recordedAtExact, requestId: row.requestId },
    }));
  }
}

/** Restrict refusals to an authenticated user. */
function userCondition(userId: string | undefined): SQL | undefined {
  if (userId === undefined) return undefined;
  return and(eq(requestLog.actorKind, "user"), eq(requestLog.actorId, userId));
}

function olderThanRequestCursor(olderThan: RequestLogCursor | null): SQL | undefined {
  if (olderThan === null) return undefined;
  if (olderThan.requestId === null) {
    return sql`${requestLog.recordedAt} < ${olderThan.recordedAt}::timestamptz`;
  }
  return sql`(${requestLog.recordedAt}, ${requestLog.requestId}) < (${olderThan.recordedAt}::timestamptz, ${olderThan.requestId})`;
}
