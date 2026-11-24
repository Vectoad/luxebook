<div align="center">

# 📖 Luxebook

### Turn any PDF into a real 3D book. One line of code.

Hard covers, paper thickness, glossy pages that catch the light, and page turns you can grab by the corner.<br/>
Built on Three.js and PDF.js. Works in React or plain JavaScript.

[![npm](https://img.shields.io/npm/v/@vectoad/luxebook-react?color=c9a86a&label=npm&style=flat-square)](https://www.npmjs.com/package/@vectoad/luxebook-react)
[![downloads](https://img.shields.io/npm/dm/@vectoad/luxebook-core?color=c9a86a&style=flat-square)](https://www.npmjs.com/package/@vectoad/luxebook-core)
[![bundle](https://img.shields.io/badge/types-included-c9a86a?style=flat-square)](packages/types/src/index.ts)
[![license](https://img.shields.io/badge/license-MIT-c9a86a?style=flat-square)](LICENSE)

**[✨ Live demo](https://vectoad.github.io/luxebook/)** · **[Quick start](#quick-start)** · **[Options](#make-it-yours)** · **[Examples](examples)**

<a href="https://vectoad.github.io/luxebook/"><img src=".github/assets/demo.gif" alt="A PDF brochure rendered as a 3D book: the hard cover swings open, pages curl and turn, and a contact form sits on the last page" width="100%"/></a>

</div>

---

## Why Luxebook?

Flat PDF embeds look like a scanned photocopy. Most flipbook tools are paid, closed SaaS with a watermark and an iframe. Luxebook is a free, MIT-licensed component that renders **your PDF as a physical object**, on your own site.

|  |  |
| --- | --- |
| 🎨 **Looks real** | True 3D geometry: page stack thickness, cover boards, spine, soft shadows on the table. |
| ✋ **Feels real** | Drag a page corner and it bends under your cursor. Release and it settles. |
| 💡 **Lighting & paper** | `neutral` · `warm` · `cool` · `dramatic` light, on `matte` · `silk` · `glossy` stock. |
| 📕 **Soft or hard cover** | Paperback cover that folds like a page, or a stiff board that swings on its hinge. |
| 🎬 **Cinematic states** | Show the closed book tilted and off-centre; it glides to the centre as it opens. |
| 📱 **Mobile-ready** | Two-page spreads on desktop, single page on portrait screens, switching live. |
| 🔍 **Reading zoom** | Double-click a page for sharp small print, re-rendered at higher resolution. |
| 🧩 **Your content on a page** | Drop a React element or HTML (a lead form, a CTA, a video) onto any page. |
| 🔒 **Preview mode** | `lastPage: 4` ends the book early, with a "contact us for the full brochure" page. |
| ⚡ **Fast** | Progressive rendering, pages rasterized on demand with a small preload window, SSR-safe. |

## Quick start

### React

```sh
npm install @vectoad/luxebook-react
```

```tsx
import { LuxeBook } from "@vectoad/luxebook-react";

export default function Brochure() {
  return <LuxeBook source="/brochure.pdf" height={600} options={{ lighting: "warm", coverStyle: "hard" }} />;
}
```

### Vanilla JS, Vue, Svelte, anything

```sh
npm install @vectoad/luxebook-core
```

```ts
import { LuxeBookViewer } from "@vectoad/luxebook-core";

const book = new LuxeBookViewer(document.getElementById("book")!, { paper: "glossy" });
await book.load("/brochure.pdf");
```

That's it. No API keys, no hosting, no watermark.

## Make it yours

Start from a preset and override anything:

```tsx
import { LuxeBook, PRESETS } from "@vectoad/luxebook-react";

<LuxeBook
  source="/catalogue.pdf"
  options={{
    ...PRESETS.showcase,        // studio · gallery · classic · night · electric · showcase
    paper: "silk",
    coverStyle: "hard",
    cover: { image: "/cover.jpg" },
    thickness: 1.4,
    states: {
      closed: { rotateX: 28, rotateY: -22, offsetX: 0.35, zoom: 0.8 }, // product-shot pose
      open: { rotateX: 0, rotateY: 0 },                                // flat for reading
    },
  }}
/>
```

Every option is typed and documented in your editor. The **[live demo](https://vectoad.github.io/luxebook/)** has a settings panel that shows the config for whatever you dial in, so you can copy it straight into your code.

<details>
<summary><b>All appearance options</b></summary>

| Option | Values | Default |
| --- | --- | --- |
| `lighting` | `"neutral"` `"warm"` `"cool"` `"dramatic"` | `"neutral"` |
| `paper` | `"matte"` `"silk"` `"glossy"` | `"glossy"` |
| `cover` | `"first-page"` `"plain"` `{ image: url }` | `"first-page"` |
| `coverStyle` | `"soft"` `"hard"` | `"soft"` |
| `coverColor` | CSS colour | `#24211e` |
| `layout` | `"auto"` `"single"` `"double"` | `"auto"` |
| `background` / `backgroundImage` | CSS colour / URL | `#141312` / none |
| `backgroundBrightness` / `backgroundBlur` | number | `1` / `0` |
| `thickness` / `coverThickness` / `spineWidth` | multiplier | `1` |
| `shadowStrength` | `0`–`1` | `0.5` |
| `zoom` | `0.6`–`2.4` | `1` |
| `rotateX` / `rotateY` | degrees, `-60`–`60` | `0` |
| `offsetX` / `offsetY` | `-1`–`1` | `0` |
| `turnSpeed` | multiplier | `1` |
| `states` | `{ closed?, open? }` per-state look | none |
| `lastPage` | page number (preview mode) | whole PDF |
| `startOpen` | boolean | `false` |

</details>

## Control it

```tsx
const book = useRef<LuxeBookHandle>(null);

<LuxeBook ref={book} source="/brochure.pdf" onPageChange={(e) => track(e.spread)} />

book.current.next();
book.current.goToPage(12);
book.current.zoomTo(2);
```

Events: `onReady`, `onPageChange`, `onBookStateChange`, `onBookClick`, `onReadingZoomChange`, `onError`.

## Great for

Real-estate brochures · product catalogues · magazines · lookbooks · portfolios · menus · annual reports · wedding albums · children's books.

## Packages

| Package | |
| --- | --- |
| [`@vectoad/luxebook-react`](packages/react) | React 18 component |
| [`@vectoad/luxebook-core`](packages/core) | Framework-free viewer |

`types`, `pdf-engine`, `renderer-three`, `page-physics` and `animations` are internal building blocks, installed for you.

## Contributing

```sh
pnpm install
pnpm dev        # playground at localhost:5173
pnpm test       # unit tests
pnpm test:e2e   # browser tests
```

Issues and PRs welcome. If Luxebook made your PDFs look good, **[give it a ⭐](https://github.com/Vectoad/luxebook)**, it really helps.

<div align="center">

MIT © Vectoad

</div>
