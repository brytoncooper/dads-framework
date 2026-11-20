# UI, forms, and tables

Use the public subpaths documented by the [UI package](../../../packages/web/ui/README.md).
Install [Styles](../../../packages/web/styles/README.md) for the default theme
and use [Copy](../../../packages/web/copy/README.md) for localized text.

To add an action to a screen, import `Button` from `@dads-framework/ui/elements`.
Load `@dads-framework/styles/index.css` in your app stylesheet and tell
Tailwind where to find the installed components. The
[refresh button example](../../../packages/web/ui/README.md#try-it) includes
both the component and the stylesheet setup. Give it a callback, focus the
button with Tab, and press Enter. The callback should run once.

Start a table with the same contract that drives the request. Keep display
values separate from filter and sort wire values. Preserve accessible labels
and keyboard behavior when composing controls, and use the default theme
unless the app owns another theme.
