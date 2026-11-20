/**
 * Web entry point (`@dads-framework/plugin/web`): the browser half of a
 * plugin, importable without any server code.
 */
export {
  composeWebApp,
  defineWebPlugin,
  type ComposedWebApp,
  type WebPage,
  type WebPlugin,
} from "./web/define-web-plugin.js";
