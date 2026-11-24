// Copies the sample PDFs into public/. (PDF.js itself needs no copying: the
// library loads it from a pinned CDN copy by default.)
import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const pub = new URL("../public/", import.meta.url).pathname;
mkdirSync(pub, { recursive: true });
for (const pdf of ["brochure.pdf", "multipage.pdf"]) cpSync(new URL(`../../../fixtures/${pdf}`, import.meta.url).pathname, join(pub, pdf));
console.log("copied sample PDFs to public/");
