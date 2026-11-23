import {
  defineCopy,
  resolveLocalizedText,
  type LocalizedText,
} from "@dads-framework/ui/copy";

const accountMailTitles: Readonly<Record<string, LocalizedText>> = defineCopy({
  "verify-email": { en: "Verify your email address" },
  "reset-password": { en: "Reset your password" },
  "account-invitation": { en: "Accept your account invitation" },
  "tenant-invitation": { en: "Accept your tenant invitation" },
});

const fallbackTitle = { en: "Continue to Dads" };

export const accountMailDescription =
  "Delivers account and tenant links for the Dads starter.";

export function accountMailTitle(kind: string): string {
  return resolveLocalizedText(accountMailTitles[kind] ?? fallbackTitle, "en");
}
