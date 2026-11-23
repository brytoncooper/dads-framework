import { z } from "zod";

import type { ScopeAnswer, SubjectRef } from "@dads-framework/access/runtime";
import {
  type ListOperationContract,
  type OperationPathParamsShape,
  type PaginationMeta,
  paginationMetaSchema,
} from "@dads-framework/core/contract";

import { HttpWiringError } from "../http-errors.js";
import type {
  PermissionAccess,
  PublicAccess,
  RouteAccess,
  ScopedAccess,
  SessionAccess,
  VisibilityAccess,
} from "./access.js";
import {
  resolveListOperationConfig,
  type ErasedListConfig,
  type ErasedOperationVerbConfig,
  type OperationVerbCommon,
} from "./operation-route.js";
import {
  buildDefinition,
  type PathParamsShape,
  resolveVerbRoute,
  type RouteBlueprint,
  type RouteHandlerContext,
  type SchemaOutput,
  type VerbCommon,
  type VerbParams,
  type VerbRouteSource,
} from "./route-definition.js";

/**
 * LIST — the collection verb (locked with Bryton, 2026-07-09). Pagination
 * is COMPILE-ENFORCED: the query schema's output must carry
 * `page`/`perPage` (extend `paginationQuerySchema`), and the kit assembles
 * the `{ data, meta }` envelope itself — handlers return `{ items, total }`
 * and never echo page/perPage (that ceremony was the old boilerplate).
 * `getRoute` refuses array responses, so a collection cannot dodge this.
 */

/** What a list handler returns — the kit builds data + meta from it. */
export type ListResult<ItemSchema extends z.ZodType> = {
  readonly items: readonly z.input<ItemSchema>[];
  readonly total: number;
};

/**
 * A list's own meta beyond `{ total, page, perPage }`: a route that declares
 * a `meta` schema (extending `paginationMetaSchema`) returns its other
 * fields as `meta`; the kit still fills the page window and total.
 */
export type ListMetaSchema = z.ZodType<PaginationMeta>;

type ListMetaExtra<MetaSchema extends ListMetaSchema | undefined> = MetaSchema extends ListMetaSchema
  ? {
      readonly meta: Omit<z.input<MetaSchema>, keyof PaginationMeta>;
    }
  : unknown;

/** Parsed inputs and subject available to a named list handler module. */
export type ListRouteHandlerContext<
  Params,
  Query,
  Subject,
  Context extends object = Record<never, never>,
> = RouteHandlerContext<Params, Query, undefined, Subject> & Context;

/** The one result shape a named list handler returns before the kit envelopes it. */
export type ListRouteHandlerResult<ItemSchema extends z.ZodType> = ListResult<ItemSchema>;

/** The query must parse to at least `{ page, perPage }`. */
type PaginatedQuerySchema = z.ZodType<{ page: number; perPage: number }>;

type PaginatedOperationQuery = z.ZodType<Record<string, unknown> & { page: number; perPage: number }>;

export type ListRouteConfig<
  Path extends string,
  Access extends RouteAccess,
  Subject,
  ItemSchema extends z.ZodType,
  QuerySchema extends PaginatedQuerySchema,
  ParamsSchema extends z.ZodType<PathParamsShape<Path>> | undefined,
  BodySchema extends z.ZodType | undefined,
  Ctx extends object = Record<never, never>,
  MetaSchema extends ListMetaSchema | undefined = undefined,
> = VerbCommon<"GET", Path, Access> & {
  /** The ELEMENT schema — the kit wraps it in an array for the wire. */
  readonly item: ItemSchema;
  /** Must extend paginationQuerySchema (page/perPage compile-enforced). */
  readonly query: QuerySchema;
  /** Optional: a meta schema extending `paginationMetaSchema`; the handler returns its extra fields. */
  readonly meta?: MetaSchema;
  readonly handler: (
    ctx: RouteHandlerContext<SchemaOutput<ParamsSchema>, SchemaOutput<QuerySchema>, SchemaOutput<BodySchema>, Subject> &
      Ctx,
  ) =>
    Promise<ListResult<ItemSchema> & ListMetaExtra<MetaSchema>> | (ListResult<ItemSchema> & ListMetaExtra<MetaSchema>);
} & VerbParams<Path, ParamsSchema>;

type ListRouteContractSource<
  Path extends string,
  ItemSchema extends z.ZodType,
  QuerySchema extends PaginatedQuerySchema,
  ParamsSchema extends z.ZodType<PathParamsShape<Path>> | undefined,
  MetaSchema extends ListMetaSchema | undefined,
> =
  | (VerbRouteSource<"GET", Path> & {
      readonly operation?: never;
      /** The ELEMENT schema — the kit wraps it in an array for the wire. */
      readonly item: ItemSchema;
      /** Must extend paginationQuerySchema (page/perPage compile-enforced). */
      readonly query: QuerySchema;
      /** Optional: a meta schema extending `paginationMetaSchema`; the handler returns its extra fields. */
      readonly meta?: MetaSchema;
    } & VerbParams<Path, ParamsSchema>)
  | {
      readonly route?: never;
      readonly path?: never;
      readonly operation: ListOperationContract<
        Path,
        ItemSchema,
        Extract<QuerySchema, PaginatedOperationQuery>,
        ParamsSchema & (z.ZodType<OperationPathParamsShape<Path>> | undefined),
        MetaSchema
      >;
    };

/** A handler's extra meta, when its route declared a meta schema; the response schema checks it. */
function extraMetaOf(result: object): object {
  if (!("meta" in result)) return {};
  const { meta } = result;
  return typeof meta === "object" && meta !== null ? meta : {};
}

/** Reads the page window back out of the parsed query for the meta echo. */
function pageWindowOf(query: unknown): { page: number; perPage: number } {
  if (
    typeof query === "object" &&
    query !== null &&
    "page" in query &&
    "perPage" in query &&
    typeof query.page === "number" &&
    typeof query.perPage === "number"
  ) {
    return { page: query.page, perPage: query.perPage };
  }
  // The query schema's output type guarantees these — reaching this line
  // means the schema lied about its output (a wiring bug, loud 500).
  throw new HttpWiringError(
    "listRoute query parsed without page/perPage — the query schema must extend paginationQuerySchema",
  );
}

type ListRouteAccess = SessionAccess | PermissionAccess | VisibilityAccess | ScopedAccess | PublicAccess;

type ListRouteSubject<Access extends ListRouteAccess> = Access extends PublicAccess ? SubjectRef | null : SubjectRef;

type ListRouteContext<Access extends ListRouteAccess> = Access extends VisibilityAccess
  ? { readonly visibleIds: readonly string[] }
  : Access extends ScopedAccess
    ? { readonly scope: ScopeAnswer }
    : Record<never, never>;

/**
 * LIST handler context follows the declared access. Public handlers accept a
 * nullable subject; visibility handlers additionally receive visible ids, and
 * scoped handlers the scope answers they render with `scopePredicate`.
 */
export function listRoute<
  Path extends string,
  Access extends ListRouteAccess,
  ItemSchema extends z.ZodType,
  QuerySchema extends PaginatedQuerySchema,
  ParamsSchema extends z.ZodType<PathParamsShape<Path>> | undefined = undefined,
  BodySchema extends z.ZodType | undefined = undefined,
  MetaSchema extends ListMetaSchema | undefined = undefined,
>(
  config: ListRouteContractSource<Path, ItemSchema, QuerySchema, ParamsSchema, MetaSchema> &
    OperationVerbCommon<Access> & {
      readonly handler: (
        ctx: RouteHandlerContext<
          SchemaOutput<ParamsSchema>,
          SchemaOutput<QuerySchema>,
          SchemaOutput<BodySchema>,
          ListRouteSubject<Access>
        > &
          ListRouteContext<Access>,
      ) =>
        | Promise<ListResult<ItemSchema> & ListMetaExtra<MetaSchema>>
        | (ListResult<ItemSchema> & ListMetaExtra<MetaSchema>);
    },
): RouteBlueprint;
export function listRoute(config: ErasedListConfig | ErasedOperationVerbConfig): RouteBlueprint {
  const normalized = resolveListOperationConfig(config);
  const resolvedRoute = resolveVerbRoute(normalized, "GET");
  return buildDefinition({
    ...resolvedRoute,
    summary: normalized.summary,
    access: normalized.access,
    ...(normalized.bodyLimitBytes === undefined ? {} : { bodyLimitBytes: normalized.bodyLimitBytes }),
    ...(normalized.capabilities === undefined ? {} : { capabilities: normalized.capabilities }),
    ...(normalized.params === undefined ? {} : { params: normalized.params }),
    query: normalized.query,
    response: z.array(normalized.item),
    meta: normalized.meta ?? paginationMetaSchema,
    handler: async (ctx) => {
      if (normalized.access.kind === "visibility") {
        const visibleIds = ctx.visibleIds ?? [];
        if (visibleIds.length === 0) {
          // Fail-closed by construction: an empty visible set is an empty
          // page — the handler (and its reader) never see an empty IN ().
          return { data: [], meta: { total: 0, ...pageWindowOf(ctx.query) } };
        }
      }
      if (normalized.access.kind === "scoped" && ctx.scope === undefined) {
        // No answers means no scope to render: refuse rather than list
        // unscoped. An empty answer is still an answer and reaches the SQL.
        throw new HttpWiringError(`scoped list route ${resolvedRoute.path} ran without a scope answer`);
      }
      const result = await normalized.handler(ctx);
      if (typeof result !== "object" || result === null || !("items" in result) || !("total" in result)) {
        throw new HttpWiringError(`list route ${resolvedRoute.path} must return { items, total }`);
      }
      const window = pageWindowOf(ctx.query);
      return {
        data: result.items,
        meta: { ...extraMetaOf(result), total: result.total, ...window },
      };
    },
  });
}
