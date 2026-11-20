/**
 * The house icon surface for the web world.
 *
 * `lucide-react` is a `bannedExternalImports` entry on the `scope:web`
 * boundary in the root eslint.config.mjs — apps and features import icons
 * from `@dads-framework/ui/icons`, never from the vendor. The primitive
 * libs are `scope:shared`, so they still reach lucide directly. Its own lib
 * rather than an entry point on a component barrel because lucide exports
 * `Table`, `Command`, `Calendar`, `Sidebar` and other names the primitive
 * libs also export.
 */
export * from "lucide-react";
