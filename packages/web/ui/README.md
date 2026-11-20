# @dads-framework/ui

React controls, data tables, and application layouts with a neutral default theme.

## Try it

Install the components and default theme in a React 19 TypeScript app with
Tailwind CSS 4 configured.

```sh
npm install @dads-framework/ui @dads-framework/styles react@^19 react-dom@^19
```

Set your Tailwind CSS entry point to the following. This example assumes the
stylesheet lives in `src/`. Resolve the source path from your stylesheet to
the location of the installed UI package.

```css
@import "@dads-framework/styles/index.css";
@source "../node_modules/@dads-framework/ui/dist";
```

Render `<StockCounter />` on a page that loads that stylesheet.

<!-- dads:check-example -->

```tsx
import { useState } from "react";
import { Button } from "@dads-framework/ui/elements";

export function StockCounter() {
  const [units, setUnits] = useState(0);

  return (
    <>
      <Button type="button" onClick={() => setUnits((count) => count + 1)}>
        Add unit
      </Button>
      <p role="status">Units in stock: {units}</p>
    </>
  );
}
```

The page shows a themed **Add unit** button and a count of zero. Press Tab
to focus the button, then Enter to increment the count.

The [starter's note forms](../../../apps/kit-workbench/apps/web/note-forms.tsx)
use the shared `Button` and disable form submission while a request is pending.

## Use it

| Import path                             | Includes                                                  |
| --------------------------------------- | --------------------------------------------------------- |
| `@dads-framework/ui/elements`           | Buttons, badges, calendar, and class name utilities       |
| `@dads-framework/ui/forms`              | Inputs, fields, switches, checkbox, and combobox          |
| `@dads-framework/ui/display`            | Alerts, empty states, tables, and permission decisions    |
| `@dads-framework/ui/overlays`           | Dialogs, menus, sheets, tooltips, and attachment previews |
| `@dads-framework/ui/data-table`         | Responsive data table, toolbar, filters, and sorting      |
| `@dads-framework/ui/data-table/routing` | Table search schemas and helpers for route files          |
| `@dads-framework/ui/page`               | Page layout, list tabs, and master-detail views           |
| `@dads-framework/ui/shell`              | Sidebar, breadcrumb, and mobile detection                 |
| `@dads-framework/ui/icons`              | Named icon exports                                        |

The elements subpaths `/elements/calendar` and
`/elements/css-custom-properties` expose the standalone calendar and CSS
property types.

## Contract

- `MasterDetailRow` uses a native link by default. Pass a `linkComponent`
  accepting `MasterDetailLinkProps` for router navigation. It receives the
  destination as `href` and the list search values separately as `search`.
- Pass a stable `tableId` to `useDataTable` to remember visible columns on the
  device. Without an ID, column preferences last for the current visit.
- `PermissionDecisionTable` renders permission labels and decisions supplied by
  the host. Provide a stable ID for each decision and localized column and
  status labels. The host obtains decisions through its authorized API.
- `AttachmentViewer` accepts a URL or Blob from the caller's `loadSource`.
  For PDFs, serve the PDF.js WASM decoders at `/pdfjs/wasm/`. The caller owns
  the download handler.

## What it refuses to do

Application routes, loading, storage access for attachment sources, and product
copy belong to the host application.

[Third-party source notices](./THIRD_PARTY_NOTICES.md) identify the adapted
components and helpers included in this package.
