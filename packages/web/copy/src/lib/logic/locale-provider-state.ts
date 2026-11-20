/** The provider's last resolved signals and the active in-session choice. */
export type LocaleProviderState<TLocale extends string> = {
  readonly signalLocale: TLocale;
  readonly selectedLocale: TLocale;
};

/** Begin with the locale resolved from account/browser signals. */
export function initializeLocaleProviderState<TLocale extends string>(
  signalLocale: TLocale,
): LocaleProviderState<TLocale> {
  return { signalLocale, selectedLocale: signalLocale };
}

/** Apply an explicit in-session selection without changing its signal origin. */
export function selectLocale<TLocale extends string>(
  state: LocaleProviderState<TLocale>,
  selectedLocale: TLocale,
): LocaleProviderState<TLocale> {
  if (state.selectedLocale === selectedLocale) return state;
  return { ...state, selectedLocale };
}

/** Follow a changed saved/browser signal; unchanged signals keep local choice. */
export function followLocaleSignals<TLocale extends string>(
  state: LocaleProviderState<TLocale>,
  signalLocale: TLocale,
): LocaleProviderState<TLocale> {
  if (state.signalLocale === signalLocale) return state;
  return { signalLocale, selectedLocale: signalLocale };
}
