# @vectoad/luxebook-core

**Turn any PDF into a realistic 3D book. Framework-free, works anywhere.**

[![npm](https://img.shields.io/npm/v/@vectoad/luxebook-core?color=c9a86a&style=flat-square)](https://www.npmjs.com/package/@vectoad/luxebook-core) [![license](https://img.shields.io/badge/license-MIT-c9a86a?style=flat-square)](https://github.com/Vectoad/luxebook/blob/main/LICENSE)

**[✨ Live demo](https://vectoad.github.io/luxebook/)** · **[GitHub](https://github.com/Vectoad/luxebook)**

[![Luxebook demo: a PDF brochure opening as a 3D book with turning pages](https://raw.githubusercontent.com/Vectoad/luxebook/main/.github/assets/demo.gif)](https://vectoad.github.io/luxebook/)

Hard or soft covers, paper thickness, matte/silk/glossy pages, four lighting moods, drag-to-turn corners, reading zoom, mobile single-page layout, and your own content on any page. Free, MIT, no watermark.

```sh
npm install @vectoad/luxebook-core
```

```ts
import { LuxeBookViewer } from "@vectoad/luxebook-core";

const viewer = new LuxeBookViewer(document.getElementById("book")!, {
  lighting: "warm",
  coverStyle: "hard",
});
viewer.on("ready", (info) => console.log(info));
await viewer.load("/brochure.pdf");

viewer.next();
viewer.goToPage(5);
```

- `load(source)` takes a URL or the PDF bytes.
- Controls: `next()`, `previous()`, `goToPage()`, `open()`, `close()`, `zoomIn()`, `zoomOut()`, `resetZoom()`.
- `setOptions()` updates appearance live; `setOverlay(element, { page })` places your own HTML on a page.
- Events: `ready`, `pagechange`, `error`, `click`, `bookstate`, `readingzoom`.
- Call `destroy()` when you're done.

MIT license. Source: https://github.com/Vectoad/luxebook
