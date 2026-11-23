import { PluginCompositionError } from "../lib/plugin-errors.js";
import { refuseDuplicates } from "../lib/refuse-duplicates.js";

/** A page as the kernel sees it: its path must be unique in the app. */
export type WebPage = { readonly path: string };

/**
 * The browser half of a plugin. It lives apart from `definePlugin` so a web
 * bundle never imports a plugin's routes, jobs, or migrations: a plugin
 * package exports it from its own `./web` entry point.
 */
export type WebPlugin<Name extends string, Page extends WebPage> = {
  readonly kind: "web-plugin";
  readonly name: Name;
  readonly pages: readonly Page[];
};

export function defineWebPlugin<const Name extends string, Page extends WebPage = never>(spec: {
  readonly name: Name;
  readonly pages?: readonly Page[];
}): WebPlugin<Name, Page> {
  return { kind: "web-plugin", name: spec.name, pages: spec.pages ?? [] };
}

/** Every page, in the order the app listed the plugins. */
export type ComposedWebApp<Page extends WebPage> = {
  readonly plugins: readonly string[];
  readonly pages: readonly Page[];
};

/** Compose web plugins; refuses a repeated plugin name or page path. */
export function composeWebApp<Name extends string, Page extends WebPage>(
  plugins: readonly WebPlugin<Name, Page>[],
): ComposedWebApp<Page> {
  const names = plugins.map((plugin) => plugin.name);
  if (new Set(names).size !== names.length) {
    throw new PluginCompositionError(`web plugins must have unique names; got ${names.join(", ")}`);
  }
  refuseDuplicates(
    "page",
    plugins.flatMap((plugin) => plugin.pages.map((page) => ({ key: page.path, pluginName: plugin.name }))),
  );
  return { plugins: names, pages: plugins.flatMap((plugin) => plugin.pages) };
}
