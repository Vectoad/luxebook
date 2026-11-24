# @vectoad/luxebook-react

A 3D page-flip PDF viewer for React. Give it a PDF and it renders a realistic book: cover, thickness, paper, lighting, and page turns.

```sh
npm install @vectoad/luxebook-react
```

```tsx
import { LuxeBook } from "@vectoad/luxebook-react";

export default function Brochure() {
  return (
    <LuxeBook
      source="/brochure.pdf"
      height={600}
      options={{ lighting: "warm", paper: "glossy", coverStyle: "hard" }}
      onReady={(info) => console.log(info)}
      onPageChange={(e) => console.log(e.spread)}
    />
  );
}
```

- React 18. Server-side rendering safe: the 3D engine loads in the browser only.
- `source` is a URL or the PDF bytes.
- `options` covers appearance (background, cover, thickness, paper, lighting, zoom, rotation), layout (`"auto" | "single" | "double"`), and preview mode (`lastPage`).
- `overlay` puts your own React content (a contact form, for example) on a page.
- A `ref` gives you `next()`, `previous()`, `goToPage()`, `open()`, `close()` and `zoomTo()`.

Types for every option are included. Not using React? See [`@vectoad/luxebook-core`](https://www.npmjs.com/package/@vectoad/luxebook-core).

MIT license. Source: https://github.com/Vectoad/luxebook
