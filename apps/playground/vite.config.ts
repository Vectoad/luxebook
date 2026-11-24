import { cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { defaultClientConditions, defineConfig } from "vite";

// Serve pdfjs-dist's cmaps/fonts/wasm straight from node_modules in dev.
const pdfjsDir = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));

export default defineConfig(({ command }) => ({
  // Consume workspace packages from source: instant HMR, no rebuild step.
  resolve: { conditions: ["luxebook-source", ...defaultClientConditions] },
  // Dev: serve from node_modules. Build: copy into dist/pdfjs/ (below).
  define: { __PDFJS_ASSETS__: JSON.stringify(command === "build" ? "./pdfjs/" : `/@fs${pdfjsDir}/`) },
  base: "./",
  plugins: [{
    name: "copy-pdfjs-assets",
    apply: "build",
    writeBundle({ dir }) {
      for (const d of ["cmaps", "standard_fonts", "wasm", "iccs"]) cpSync(join(pdfjsDir, d), join(dir!, "pdfjs", d), { recursive: true });
    },
  }],
}));
