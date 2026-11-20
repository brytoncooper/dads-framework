# @dads-framework/styles

The default stylesheet for Dads React components and Tailwind CSS 4 apps.

## Try it

Install the stylesheet in an existing Tailwind CSS 4 app.

```sh
npm install @dads-framework/styles
```

Set your application's Tailwind CSS entry point to the following import. The
package loads Tailwind and the theme together.

```css
@import "@dads-framework/styles/index.css";
```

Add this markup to a page scanned by Tailwind and open it in the browser.

```html
<section class="bg-background p-4 text-foreground">Light theme</section>
<section class="dark">
  <div class="bg-background p-4 text-foreground">Dark theme</div>
</section>
```

The first block has a light background and dark text. The second has a dark
background and light text. To theme installed Dads UI controls as well, add the
source directive shown in the [UI quick start](../ui/README.md#try-it).

## Use it

`index.css` imports the palette, semantic roles, dark overrides, Tailwind
utilities, and fonts. Add `dark` to the application root for dark mode. To
customize the theme, override semantic CSS variables in your application after
the theme import. An element with `className="bg-background text-foreground"`
uses the same role names in both modes and changes colors when the root mode
changes.

## Contract

The CSS exposes roles such as `--primary`, `--background`, and
`--foreground`, alongside Tailwind utilities such as `bg-primary` and
`text-foreground`. The light and dark modes share those role names.

## What it refuses to do

Your application chooses the active mode and supplies product branding.

The font stylesheet imports the Latin IBM Plex Sans and Mono subsets from
Fontsource dependencies. The font software uses the SIL Open Font License
1.1 with reserved font name “Plex”. [IBM Plex license](https://github.com/IBM/plex/blob/master/LICENSE.txt)
