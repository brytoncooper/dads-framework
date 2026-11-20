import { addLibraryRecipe } from "./add-library-recipe.js";
import { writeOutput } from "./cli-io.js";

export function addLibrary(args: readonly string[], json: boolean): void {
  const [name, ...flags] = args;
  if (
    !name ||
    flags.some((flag) => flag !== "--json" && flag !== "--dry-run")
  ) {
    throw new Error("Usage: dad add library <name> [--dry-run] [--json]");
  }
  writeOutput(
    {
      ok: true,
      result: addLibraryRecipe(
        process.cwd(),
        name,
        flags.includes("--dry-run"),
      ),
    },
    json,
  );
}
