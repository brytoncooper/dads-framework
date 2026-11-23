/**
 * What: the provider resolves the reader's language from live signals and lets
 * a switcher change it; a component outside a provider still renders.
 * Why: the fallback is the load-bearing choice here. If `useLocale` threw
 * outside a provider, every feature's component test would have to mount app
 * chrome to assert one heading — so the fallback is deliberate and pinned, and
 * the loud failure belongs to the hook that CHANGES the language instead.
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  LocaleProvider,
  useLocale,
  useLocaleSelection,
} from "./locale-provider.js";

afterEach(cleanup);

function ReaderLanguage() {
  return <output>{useLocale()}</output>;
}

function LanguageSwitcher() {
  const { locale, setLocale } = useLocaleSelection();
  return (
    <button
      type="button"
      onClick={() => {
        setLocale(locale);
      }}
    >
      {locale}
    </button>
  );
}

describe("LocaleProvider", () => {
  it("resolves the reader's language from the signals it was given", () => {
    render(
      <LocaleProvider preferred="en" browserLanguages={["fr-FR"]}>
        <ReaderLanguage />
      </LocaleProvider>,
    );

    expect(screen.getByRole("status").textContent).toBe("en");
  });

  it("answers English when no signal names a language it speaks", () => {
    render(
      <LocaleProvider browserLanguages={["fr-FR", "de"]}>
        <ReaderLanguage />
      </LocaleProvider>,
    );

    expect(screen.getByRole("status").textContent).toBe("en");
  });

  it("hands a switcher the language and a way to change it", () => {
    render(
      <LocaleProvider>
        <LanguageSwitcher />
      </LocaleProvider>,
    );

    const button = screen.getByRole("button");
    expect(button.textContent).toBe("en");
    fireEvent.click(button);
    expect(button.textContent).toBe("en");
  });
});

describe("useLocale outside a provider", () => {
  it("renders in the default language rather than failing", () => {
    render(<ReaderLanguage />);

    expect(screen.getByRole("status").textContent).toBe("en");
  });
});

describe("useLocaleSelection outside a provider", () => {
  it("fails loudly — only a mounted provider can change the language", () => {
    expect(() => render(<LanguageSwitcher />)).toThrow(/LocaleProvider/);
  });
});
