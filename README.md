# Luxebook

A 3D page-flip PDF viewer for the web: turn any PDF into a realistic book with cover, thickness, paper finishes, lighting and smooth page turns.

| Package | Use it for |
| --- | --- |
| [`@vectoad/luxebook-react`](packages/react) | React 18 component |
| [`@vectoad/luxebook-core`](packages/core) | Framework-free viewer |

The other packages (`types`, `pdf-engine`, `renderer-three`, `page-physics`, `animations`) are internal building blocks.

```sh
npm install @vectoad/luxebook-react
```

```tsx
<LuxeBook source="/brochure.pdf" height={600} options={{ lighting: "warm" }} />
```

See the package READMEs for the full API. Develop with `pnpm install`, `pnpm build`, `pnpm test`.

MIT license.
