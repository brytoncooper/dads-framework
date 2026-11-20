# @dads-framework/ui

React controls, data tables, and application layouts with a neutral default theme.

## Try it

Install `@dads-framework/ui` and `@dads-framework/styles` in your React 19 app.
In the application's Tailwind CSS entry point, scan the installed UI package.
Adjust the source path relative to that stylesheet.

```css
@import "@dads-framework/styles/index.css";
@source "../node_modules/@dads-framework/ui/dist";
```

```tsx
import { Button } from "@dads-framework/ui/elements";

export function RefreshButton({ onRefresh }: { onRefresh: () => void }) {
  return <Button onClick={onRefresh}>Refresh</Button>;
}
```

## Use it

| Import path                             | Includes                                                  |
| --------------------------------------- | --------------------------------------------------------- |
| `@dads-framework/ui/elements`           | Buttons, badges, calendar, and class name utilities       |
| `@dads-framework/ui/forms`              | Inputs, fields, switches, checkbox, and combobox          |
| `@dads-framework/ui/display`            | Alert, empty state, scroll area, and table primitives     |
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
- `AttachmentViewer` accepts a URL or Blob from the caller's `loadSource`.
  For PDFs, serve the PDF.js WASM decoders at `/pdfjs/wasm/`. The caller owns
  the download handler.

## What it refuses to do

Application routes, loading, storage access for attachment sources, and product
copy belong to the host application.

[Third-party source notices](./THIRD_PARTY_NOTICES.md) identify the adapted
components and helpers included in this package.
