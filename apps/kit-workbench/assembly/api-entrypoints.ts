import { customerApp } from "../apps/customer/app.js";
import { staffApp } from "../apps/staff/app.js";

/** Entrypoints are statically imported so the host chooses every API's routes. */
export const apiEntrypoints = { customer: customerApp, staff: staffApp };

export type ApiName = keyof typeof apiEntrypoints;
