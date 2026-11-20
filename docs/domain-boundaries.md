# Keep domains independent

Run `npx dad check boundaries` to validate imports in a Dads project. New
starters run the check in `npm run verify` and in CI. Existing projects can
add the command to their verification script.

| Location                                       | Imports                                                              |
| ---------------------------------------------- | -------------------------------------------------------------------- |
| `src/domains/<domain>` or `domains/<domain>`   | That domain's modules and public entries of neutral libraries        |
| `libraries/<library>`                          | That library's modules and public entries of other neutral libraries |
| `src/composition`, `apps/<app>`, or `assembly` | Public entries of domains and libraries, plus host wiring            |

The restrictions apply to project source. Packages installed as external
dependencies remain available. Domains can expose browser-facing exports through `web-client/index.ts`.
Other public entries are `index.ts` or
`src/index.ts` and their JavaScript and declaration counterparts. Keep
public exports in the entry point. The checker uses the importing file's
nearest `tsconfig.json` for resolution and checks static imports,
re-exports, type-only imports, and literal dynamic imports and requires.

For a project with different folders, put the ownership roots in
`dads.project.json`. A trailing `/*` gives each immediate subdirectory
its own owner. A plain path assigns the entire directory to one owner.

```json
{
  "domainBoundaries": {
    "domains": ["domains/*"],
    "libraries": ["libraries/*"],
    "composition": [
      "apps/customer/src/composition",
      "apps/staff/src/composition"
    ]
  }
}
```

Declare the interface in the domain that needs the capability. Give its
factory the interface as a dependency. The providing domain owns its
implementation and the composition root adapts it as needed.

For example, if a file under `domains/orders` imports
`../inventory/index.js`, the check fails even if the destination is Inventory's
public entry. Replace the import with an Orders-owned input port and bind
Inventory from `assembly`. Run `npx dad check boundaries` again to confirm
the dependency now flows through composition.

The [Orders and Inventory example](../fixtures/domain-boundaries/README.md)
shows this with an Orders-owned `ReserveStock` port. Inventory fulfills the
port and composition binds it. The two APIs expose different routes while the
customer can still place an order that reserves inventory.

If you declare a custom Dads verification task graph, give the composition
test both domains as source inputs, or add dependencies on their verification
tasks. Changes to the bound implementations can then select the API proof even
when the composition files did not change.
