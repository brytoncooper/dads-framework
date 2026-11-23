import { defineCopy } from "@dads-framework/ui/copy";

export const auditExportCopy = defineCopy({
  "tenants.auditExport.tag": { en: "Tenant audit export" },
  "tenants.auditExport.summary": {
    en: "Download one page of tenant audit metadata",
  },
  "tenants.auditExport.beforeRecordedAt": {
    en: "Exact UTC cursor timestamp, to six fractional digits. Supply with beforePosition.",
  },
  "tenants.auditExport.beforePosition": {
    en: "Cursor position. Supply with beforeRecordedAt.",
  },
  "tenants.auditExport.success": {
    en: "A page of newline-delimited audit records",
  },
  "tenants.auditExport.continuation": {
    en: "Continuation URL when another page exists",
  },
  "tenants.auditExport.invalidInput": { en: "Invalid export input" },
  "tenants.auditExport.authenticationRequired": {
    en: "Authentication required",
  },
  "tenants.auditExport.tenantUnavailable": { en: "Tenant unavailable" },
});
