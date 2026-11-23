import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";

import type { Locale } from "./localized-text.js";
import { followLocaleSignals, initializeLocaleProviderState, selectLocale } from "./logic/locale-provider-state.js";
import { DEFAULT_LOCALE, type LocaleSignals, resolveInitialLocale } from "./resolve-initial-locale.js";

/**
 * The one thing a copy hook reads from React: which language the reader reads.
 *
 * It is deliberately the ONLY thing in context. A feature's phrases are closed
 * over by its own hook (`createCopyHook`), so nothing every feature contributes
 * to is ever read at render time — which is what keeps an orders label edit
 * from touching products.
 *
 * Nothing here persists. The identity-owned user-settings document supplies a
 * saved preference through props; null means Automatic and therefore follows
 * the browser signal.
 */

export type LocaleSelection = {
  readonly locale: Locale;
  readonly setLocale: (locale: Locale) => void;
};

const LocaleContext = createContext<LocaleSelection | null>(null);

export type LocaleProviderProps = LocaleSignals & {
  readonly children: ReactNode;
};

export function LocaleProvider({ children, ...signals }: LocaleProviderProps): ReactNode {
  const signalLocale = resolveInitialLocale(signals);
  const [providerState, setProviderState] = useState(() => initializeLocaleProviderState(signalLocale));
  const activeState = followLocaleSignals(providerState, signalLocale);

  // React discards this render and retries before reconciling children, so a
  // changed saved setting never commits one frame in the previous language.
  if (activeState !== providerState) {
    setProviderState(activeState);
  }

  const setLocale = useCallback(
    (locale: Locale) => {
      setProviderState((currentState) => selectLocale(followLocaleSignals(currentState, signalLocale), locale));
    },
    [signalLocale],
  );
  const selection = useMemo<LocaleSelection>(
    () => ({ locale: activeState.selectedLocale, setLocale }),
    [activeState.selectedLocale, setLocale],
  );
  return <LocaleContext.Provider value={selection}>{children}</LocaleContext.Provider>;
}

/**
 * The reader's language.
 *
 * Answers `DEFAULT_LOCALE` outside a provider rather than throwing: a component
 * test that renders one screen should not have to mount app chrome to assert
 * what that screen says, and the app shell mounting the provider is proven
 * where the shell is composed. A missing provider is a composition bug with one
 * home, not a per-component hazard.
 */
export function useLocale(): Locale {
  return useContext(LocaleContext)?.locale ?? DEFAULT_LOCALE;
}

/** The reader's language and the way to change it — for a locale switcher. */
export function useLocaleSelection(): LocaleSelection {
  const selection = useContext(LocaleContext);
  if (selection === null) {
    throw new Error(
      "useLocaleSelection needs a <LocaleProvider> above it — only a mounted provider can change the reader's language",
    );
  }
  return selection;
}
