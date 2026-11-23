export { buildGrantableCatalog } from "./core/build-grantable-catalog.js";
export type {
  GrantableCatalogBinding,
  GrantableCatalogEntry,
  GrantableCatalogLabel,
  GrantableCatalogPlacement,
} from "./core/build-grantable-catalog.js";
export { catalogOnly, isCatalogOnlyCapability } from "./core/catalog-only.js";
export type { CatalogOnlyCapability } from "./core/catalog-only.js";
export { checkAccessConformance, missingGrantingAdvisories } from "./core/conformance.js";
export type { ConformanceFailure, MissingGrantingAdvisory } from "./core/conformance.js";
export { grantable, isGrantableRole } from "./core/grantable.js";
export type {
  GrantableDirectSubject,
  GrantableGroup,
  GrantableGroupSubject,
  GrantableLocalizedText,
  GrantableRisk,
  GrantableRole,
  GrantableScope,
  GrantableTargetKind,
} from "./core/grantable.js";
export { lifecycleTrigger } from "./core/lifecycle.js";
export type { LifecycleTrigger } from "./core/lifecycle.js";
