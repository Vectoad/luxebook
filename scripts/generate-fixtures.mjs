// Generates the PDF fixtures in /fixtures. Deterministic; run with `pnpm fixtures`.
// Uses pdf-lib (MIT, dev-only) and a minimal PNG encoder for procedural "photographs".
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const out = new URL("../fixtures/", import.meta.url);
mkdirSync(out, { recursive: true });
const FIXED_DATE = new Date(Date.UTC(2026, 0, 15, 9, 30, 0));

/** Distinct, saturated colours so e2e tests can tell pages apart by sampling pixels. */
const PAGE_COLORS = [
  [0.80, 0.20, 0.20], [0.20, 0.55, 0.25], [0.15, 0.30, 0.75], [0.85, 0.60, 0.10],
  [0.55, 0.20, 0.65], [0.10, 0.60, 0.65], [0.70, 0.35, 0.15], [0.35, 0.35, 0.35],
];

async function save(doc, name, title) {
  doc.setTitle(title);
  doc.setAuthor("LuxeBook");
  doc.setCreator("LuxeBook fixture generator");
  doc.setProducer("pdf-lib");
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);
  const bytes = await doc.save({ useObjectStreams: false });
  writeFileSync(new URL(name, out), bytes);
  console.log(`fixtures/${name}  ${doc.getPageCount()} pages  ${(bytes.length / 1024).toFixed(0)} KB`);
}

// --- small.pdf: one A4 page of text ---------------------------------------
{
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  const page = doc.addPage([595.28, 841.89]);
  page.drawText("LuxeBook", { x: 72, y: 740, size: 42, font });
  page.drawText("A single-page fixture.", { x: 72, y: 700, size: 16, font });
  await save(doc, "small.pdf", "LuxeBook Small Fixture");
}

// --- multipage.pdf: 8 A4 pages, each with a unique colour band -------------
{
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  PAGE_COLORS.forEach(([r, g, b], i) => {
    const page = doc.addPage([595.28, 841.89]);
    // Colour fills the middle 70% of the page so samples at the page centre hit it.
    page.drawRectangle({ x: 60, y: 120, width: 475, height: 600, color: rgb(r, g, b) });
    page.drawText(String(i + 1), { x: 250, y: 380, size: 120, font, color: rgb(1, 1, 1) });
  });
  await save(doc, "multipage.pdf", "LuxeBook Multi-page Fixture");
}

// --- mixed-sizes.pdf: portrait, landscape and square pages -----------------
{
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const [w, h, label] of [[595.28, 841.89, "A4 portrait"], [792, 612, "Letter landscape"], [600, 600, "Square"]]) {
    const page = doc.addPage([w, h]);
    page.drawRectangle({ x: 10, y: 10, width: w - 20, height: h - 20, borderColor: rgb(0, 0, 0), borderWidth: 4 });
    page.drawText(label, { x: 40, y: h / 2, size: 32, font });
  }
  await save(doc, "mixed-sizes.pdf", "LuxeBook Mixed Sizes Fixture");
}

// --- brochure.pdf: text + photography, the playground's demo document ------
{
  const doc = await PDFDocument.create();
  const serif = await doc.embedFont(StandardFonts.TimesRoman);
  const serifItalic = await doc.embedFont(StandardFonts.TimesRomanItalic);
  const sans = await doc.embedFont(StandardFonts.Helvetica);
  const W = 595.28, H = 841.89;
  const ink = rgb(0.13, 0.12, 0.11), muted = rgb(0.45, 0.42, 0.38), accent = rgb(0.55, 0.45, 0.3);
  const photo = async (seed, w, h) => doc.embedPng(encodePng(w, h, landscape(w, h, seed)));

  const body =
    "Set above the water on a quiet headland, the residence is arranged around a single idea: " +
    "that light should move through every room as the day turns. Limestone floors run uninterrupted " +
    "from the entrance gallery to the terrace, and the principal suite opens to a private garden.";

  const textBlock = (page, text, x, y, width, size = 10.5, font = sans, color = muted) => {
    let line = "";
    for (const word of text.split(" ")) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) > width) {
        page.drawText(line, { x, y, size, font, color });
        y -= size * 1.6;
        line = word;
      } else line = next;
    }
    if (line) page.drawText(line, { x, y, size, font, color });
  };
  const folio = (page, n) => page.drawText(String(n), { x: W / 2 - 4, y: 36, size: 9, font: sans, color: muted });

  // 1. Cover: full-bleed photograph
  let page = doc.addPage([W, H]);
  page.drawImage(await photo(1, 600, 850), { x: 0, y: 0, width: W, height: H });
  page.drawText("THE HEADLAND", { x: 60, y: 140, size: 34, font: serif, color: rgb(1, 1, 1) });
  page.drawText("A private residence", { x: 60, y: 112, size: 14, font: serifItalic, color: rgb(1, 1, 1) });

  // 2. Introduction
  page = doc.addPage([W, H]);
  page.drawText("Introduction", { x: 60, y: 700, size: 30, font: serif, color: ink });
  page.drawLine({ start: { x: 60, y: 680 }, end: { x: 140, y: 680 }, thickness: 0.8, color: accent });
  textBlock(page, body, 60, 640, 380);
  textBlock(page, body, 60, 540, 380);
  folio(page, 2);

  // 3. Half-page photograph + caption
  page = doc.addPage([W, H]);
  page.drawImage(await photo(2, 600, 450), { x: 0, y: H - 446, width: W, height: 446 });
  page.drawText("The terrace at dusk", { x: 60, y: 340, size: 22, font: serif, color: ink });
  textBlock(page, body, 60, 305, 420);
  folio(page, 3);

  // 4. Specifications
  page = doc.addPage([W, H]);
  page.drawText("Specifications", { x: 60, y: 700, size: 30, font: serif, color: ink });
  const specs = [["Interior", "1,240 m²"], ["Plot", "4,800 m²"], ["Bedrooms", "6"], ["Bathrooms", "8"], ["Pool", "25 m, heated"], ["Completion", "Q3 2027"]];
  specs.forEach(([k, v], i) => {
    const y = 640 - i * 44;
    page.drawText(k.toUpperCase(), { x: 60, y, size: 9, font: sans, color: muted });
    page.drawText(v, { x: 260, y: y - 2, size: 16, font: serif, color: ink });
    page.drawLine({ start: { x: 60, y: y - 16 }, end: { x: 535, y: y - 16 }, thickness: 0.4, color: rgb(0.85, 0.83, 0.8) });
  });
  folio(page, 4);

  // 5. Two photographs
  page = doc.addPage([W, H]);
  page.drawImage(await photo(3, 500, 340), { x: 60, y: 440, width: 475, height: 323 });
  page.drawImage(await photo(4, 500, 340), { x: 60, y: 90, width: 475, height: 323 });
  folio(page, 5);

  // 6. Back cover
  page = doc.addPage([W, H]);
  page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: rgb(0.11, 0.105, 0.1) });
  page.drawText("THE HEADLAND", { x: W / 2 - 80, y: H / 2, size: 22, font: serif, color: rgb(0.85, 0.8, 0.72) });

  await save(doc, "brochure.pdf", "The Headland — Sample Brochure");
}

// --- Procedural "photograph": dusk sky, sea, headland, film grain ----------
function landscape(w, h, seed) {
  let s = seed * 9301 + 49297;
  const rand = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const px = new Uint8Array(w * h * 3);
  const horizon = h * (0.55 + 0.1 * rand());
  const hills = Array.from({ length: 4 }, () => [rand() * w, 0.15 + rand() * 0.2, 0.2 + rand() * 0.3]);
  const sunX = w * (0.25 + rand() * 0.5);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r, g, b;
      if (y < horizon) {
        const t = y / horizon; // 0 top .. 1 horizon
        r = 40 + 190 * t ** 1.6; g = 50 + 120 * t ** 2; b = 90 + 40 * t;
        const d = Math.hypot(x - sunX, y - horizon * 0.92) / w;
        const glow = Math.exp(-d * 9) * 120;
        r += glow; g += glow * 0.75; b += glow * 0.3;
        let ridge = horizon;
        for (const [cx, hh, ww] of hills) ridge -= h * hh * 0.4 * Math.exp(-(((x - cx) / (w * ww)) ** 2));
        if (y > ridge) { r = 28; g = 26; b = 30; }
      } else {
        const t = (y - horizon) / (h - horizon);
        r = 70 - 40 * t; g = 70 - 30 * t; b = 95 - 30 * t;
        const shimmer = Math.abs(x - sunX) < w * 0.08 * (1 - t) && Math.sin(y * 0.9 + x * 0.05) > 0.3;
        if (shimmer) { r += 90; g += 60; b += 20; }
      }
      const grain = (rand() - 0.5) * 14;
      const i = (y * w + x) * 3;
      px[i] = clamp(r + grain); px[i + 1] = clamp(g + grain); px[i + 2] = clamp(b + grain);
    }
  }
  return px;
}
function clamp(v) { return Math.max(0, Math.min(255, Math.round(v))); }

function encodePng(w, h, rgbPixels) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0; // filter: none
    Buffer.from(rgbPixels.buffer, y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0)),
  ]);
}
function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
