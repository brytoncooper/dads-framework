/**
 * The day-picker calendar, outside the barrel: it carries react-day-picker and
 * date-fns, which the shell's buttons and inputs must not drag into the
 * startup bundle.
 */
export * from "./components/ui/calendar.js";
