/**
 * What: a provider follows changed account/browser signals immediately while
 * still allowing an in-session selection between signal changes.
 * Why: the authenticated settings query arrives and can later change after a
 * save; keeping the provider's mount-time locale would leave the UI in the
 * previous language until a full reload.
 */
import { describe, expect, it } from "vitest";
import {
  followLocaleSignals,
  initializeLocaleProviderState,
  selectLocale,
} from "./locale-provider-state.js";

describe("locale provider state", () => {
  it("follows a changed preferred-locale prop before children read it", () => {
    const initial = initializeLocaleProviderState("en");
    const manuallySelected = selectLocale(initial, "es");

    expect(followLocaleSignals(manuallySelected, "fr")).toEqual({
      signalLocale: "fr",
      selectedLocale: "fr",
    });
  });

  it("keeps an in-session selection while the parent signals are unchanged", () => {
    const initial = initializeLocaleProviderState("en");
    const manuallySelected = selectLocale(initial, "es");

    expect(followLocaleSignals(manuallySelected, "en")).toBe(manuallySelected);
  });
});
