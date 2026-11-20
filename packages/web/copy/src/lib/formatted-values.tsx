import type { ReactNode } from "react";
import type { ExplicitDateTimeFormatOptions } from "./locale-formatting.js";
import { useLocaleFormatting } from "./use-locale-formatting.js";

export type FormattedDateTimeProps = ExplicitDateTimeFormatOptions & {
  readonly value: Date | number | string;
};

/** Render an instant in the reader locale and the caller's explicit zone. */
export function FormattedDateTime({
  value,
  ...options
}: FormattedDateTimeProps): ReactNode {
  const formatting = useLocaleFormatting();
  return formatting.formatDateTime(value, options);
}

/** Render a whole presentation number in the reader locale. */
export function FormattedInteger({
  value,
}: {
  readonly value: number | bigint;
}): ReactNode {
  return useLocaleFormatting().formatInteger(value);
}

/** Render a decimal string without floating-point coercion or lost scale. */
export function FormattedExactDecimal({
  value,
}: {
  readonly value: string;
}): ReactNode {
  return useLocaleFormatting().formatExactDecimal(value);
}
