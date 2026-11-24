import { readFileSync } from "node:fs";
import { createCanvas, type Canvas } from "@napi-rs/canvas";
import { afterEach, describe, expect, it } from "vitest";
import { LuxeBookError, type PageCanvas } from "@vectoad/luxebook-types";
import { PdfDocument, isRenderCancelled, parsePdfDate } from "./index.js";

const fixture = (name: string) => readFileSync(new URL(`../../../fixtures/${name}`, import.meta.url));
const pdfAssetsUrl = new URL("../node_modules/pdfjs-dist/", import.meta.url).pathname;
const nodeCanvas = (w: number, h: number) => createCanvas(w, h) as unknown as PageCanvas;
const pixel = (c: PageCanvas, x: number, y: number) =>
  Array.from((c as unknown as Canvas).getContext("2d").getImageData(x, y, 1, 1).data.slice(0, 3));

const open: PdfDocument[] = [];
const load = async (name: string, cacheSize?: number) => {
  const doc = await PdfDocument.load(fixture(name), { createCanvas: nodeCanvas, pdfAssetsUrl, ...(cacheSize ? { cacheSize } : {}) });
  open.push(doc);
  return doc;
};
afterEach(async () => {
  await Promise.all(open.splice(0).map((d) => d.destroy()));
});

describe("PdfDocument loading and metadata", () => {
  it("reads page count and metadata", async () => {
    const doc = await load("multipage.pdf");
    expect(doc.pageCount).toBe(8);
    const info = await doc.getInfo();
    expect(info.pageCount).toBe(8);
    expect(info.title).toBe("LuxeBook Multi-page Fixture");
    expect(info.author).toBe("LuxeBook");
    expect(info.creationDate?.toISOString()).toBe("2026-01-15T09:30:00.000Z");
    expect(info.firstPageSize.width).toBeCloseTo(595.28, 1);
    expect(info.firstPageSize.height).toBeCloseTo(841.89, 1);
  });

  it("reports per-page dimensions for mixed-size documents", async () => {
    const doc = await load("mixed-sizes.pdf");
    expect(await doc.getPageSize(2)).toEqual({ width: 792, height: 612 });
    expect(await doc.getPageSize(3)).toEqual({ width: 600, height: 600 });
  });

  it("does not detach the caller's buffer", async () => {
    const bytes = new Uint8Array(fixture("small.pdf"));
    const doc = await PdfDocument.load(bytes, { createCanvas: nodeCanvas, pdfAssetsUrl });
    open.push(doc);
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  it("throws DOCUMENT_LOAD_FAILED for invalid data", async () => {
    const err = await PdfDocument.load(new TextEncoder().encode("not a pdf")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LuxeBookError);
    expect((err as LuxeBookError).code).toBe("DOCUMENT_LOAD_FAILED");
  });

  it("rejects out-of-range pages", async () => {
    const doc = await load("small.pdf");
    await expect(doc.getPageSize(2)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});

describe("PdfDocument rendering", () => {
  it("renders real page content into a canvas of the requested size", async () => {
    const doc = await load("multipage.pdf");
    const page = await doc.renderPage(1, { width: 300, height: 424 });
    expect(page).toMatchObject({ pageNumber: 1, width: 300, height: 424 });
    expect(page.canvas.width).toBe(300);
    // Centre of page 1 is its red band (0.8, 0.2, 0.2); the corner is white paper.
    const [r, g, b] = pixel(page.canvas, 80, 212) as [number, number, number];
    expect(r).toBeGreaterThan(180);
    expect(g).toBeLessThan(80);
    expect(b).toBeLessThan(80);
    expect(pixel(page.canvas, 2, 2)).toEqual([255, 255, 255]);
  });

  it("letterboxes pages whose aspect differs from the box", async () => {
    const doc = await load("mixed-sizes.pdf");
    // Landscape page into a portrait box: content is centred vertically, white above.
    const page = await doc.renderPage(2, { width: 600, height: 848 });
    expect(pixel(page.canvas, 300, 20)).toEqual([255, 255, 255]);
    // The page's black border sits just inside where the scaled page starts.
    const top = Math.round((848 - 600 * (612 / 792)) / 2);
    const column = Array.from({ length: 16 }, (_, i) => pixel(page.canvas, 300, top + i)[0] as number);
    expect(Math.min(...column)).toBeLessThan(60);
    expect(column[0]).toBeGreaterThan(200); // nothing drawn above the page
  });

  it("caches renders and shares concurrent requests", async () => {
    const doc = await load("multipage.pdf");
    const box = { width: 100, height: 141 };
    const [a, b] = await Promise.all([doc.renderPage(3, box), doc.renderPage(3, box)]);
    expect(a).toBe(b);
    expect(doc.getCached(3, box)).toBe(a);
    expect(doc.getCached(3, { width: 200, height: 282 })).toBeUndefined();
  });

  it("evicts least recently used renders", async () => {
    const doc = await load("multipage.pdf", 2);
    const box = { width: 50, height: 70 };
    await doc.renderPage(1, box);
    await doc.renderPage(2, box);
    doc.getCached(1, box); // touch 1 so 2 is the oldest
    await doc.renderPage(3, box);
    expect(doc.getCached(1, box)).toBeDefined();
    expect(doc.getCached(2, box)).toBeUndefined();
    expect(doc.getCached(3, box)).toBeDefined();
  });

  it("cancels obsolete renders", async () => {
    const doc = await load("multipage.pdf");
    const pending = doc.renderPage(5, { width: 400, height: 566 });
    doc.cancelExcept([1, 2]);
    const err = await pending.catch((e: unknown) => e);
    expect(isRenderCancelled(err)).toBe(true);
    expect(doc.getCached(5, { width: 400, height: 566 })).toBeUndefined();
  });

  it("refuses work after destroy", async () => {
    const doc = await load("small.pdf");
    await doc.destroy();
    expect(() => doc.renderPage(1, { width: 10, height: 10 })).toThrow(LuxeBookError);
  });
});

describe("parsePdfDate", () => {
  it.each([
    ["D:20260115093000Z", "2026-01-15T09:30:00.000Z"],
    ["D:20260115113000+02'00'", "2026-01-15T09:30:00.000Z"],
    ["D:2026", "2026-01-01T00:00:00.000Z"],
  ])("%s", (input, iso) => expect(parsePdfDate(input)?.toISOString()).toBe(iso));

  it("returns undefined for garbage", () => expect(parsePdfDate("yesterday")).toBeUndefined());
});
