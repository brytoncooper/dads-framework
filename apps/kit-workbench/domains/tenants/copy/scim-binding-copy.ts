import { defineCopy } from "@dads-framework/ui/copy";

export const scimBindingCopy = defineCopy({
  "tenants.scimBinding.tag": { en: "Tenant directory" },
  "tenants.scimBinding.summary": {
    en: "Link a directory user to an existing workspace membership",
  },
  "tenants.scimBinding.success": { en: "The directory user is linked." },
  "tenants.scimBinding.origin": { en: "The request origin is not allowed." },
  "tenants.scimBinding.invalid": { en: "Supply a directory user and account." },
  "tenants.scimBinding.unavailable": { en: "Resource not found" },
});
