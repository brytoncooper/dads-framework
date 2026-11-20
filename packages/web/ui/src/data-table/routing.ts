/**
 * The table's URL state for route files: the search schema, its middlewares and
 * the loader's narrowing. Holds no component, so a route importing it keeps the
 * table widget (and its date picker and drag-and-drop) out of the startup
 * bundle. The widget lives in `./index.ts`.
 */
export * from "./lib/data-table-search-params.js";
