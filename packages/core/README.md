# @vectoad/luxebook-core

Framework-free engine for a 3D page-flip PDF viewer, built on Three.js and PDF.js. Use it from plain JavaScript or wrap it for any framework. For React, use [`@vectoad/luxebook-react`](https://www.npmjs.com/package/@vectoad/luxebook-react).

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
