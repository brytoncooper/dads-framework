# UI, forms, and tables

The Notes starter uses `Label` and `Textarea` from
`@dads-framework/ui/forms`. The label's `htmlFor` matches the field's
`id`, so selecting **New note** focuses the text area. The form reads the
submitted value by its `name`.

[Notes form](../../../apps/kit-workbench/apps/web/note-forms.tsx)

<!-- dads:excerpt {"path": "apps/kit-workbench/apps/web/note-forms.tsx", "language": "tsx", "from": "            <Label htmlFor=\"note-text\">{t(\"workbench.notes.new\")}</Label>", "through": "            />"} -->

The form holds the submit button disabled while the API request is pending.
After a successful response it resets the text area, announces **Note
saved.**, and refreshes the list. In the running starter, use Tab to reach
the field, enter a note, then Tab to **Add note** and press Enter. Confirm
that the field clears and the note appears once.
[Run the starter](./quickstart.md)

## Use the components in your app

Use the public subpaths in the [UI reference](../../../packages/web/ui/README.md).
Import `@dads-framework/styles/index.css` in your Tailwind stylesheet and
point `@source` at the installed UI package's `dist` directory. Resolve
the source path relative to your stylesheet. Run `npm run build:web` in the
starter to compile the web bundle. The [starter stylesheet](../../../apps/kit-workbench/apps/web/styles.css)
shows both the generated app path and the source monorepo path.

When adding a table, use the request contract for filter and sort values.
For example, send a status key defined by the API and render its localized
label in the cell. Give the table a stable `tableId` if you want
`useDataTable` to remember visible columns across visits.
[Table and routing subpaths](../../../packages/web/ui/README.md#use-it) ·
[Copy](../../../packages/web/copy/README.md)
