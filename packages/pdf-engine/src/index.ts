// Legacy build: same API, polyfilled for Safari < 18.2 / Chrome < 140 (see docs/adr/0003).
import {
  getDocument,
  GlobalWorkerOptions,
  PasswordException,
  RenderingCancelledException,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type RenderTask,
  version as pdfjsVersion,
} from "pdfjs-dist/legacy/build/pdf.mjs";

/**
 * Default home of the PDF.js worker and assets: jsDelivr, pinned to the exact
 * pdfjs-dist version bundled here, so they can never drift out of sync.
 * Sites with a strict CSP self-host instead (workerSrc / pdfAssetsUrl).
 */
export const PDFJS_CDN = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjsVersion}/`;
const inBrowser = typeof window !== "undefined";
import {
  LuxeBookError,
  type DocumentInfo,
  type PageCanvas,
  type PageSize,
  type PdfSource,
  type RenderedPage,
} from "@vectoad/luxebook-types";

export interface LoadOptions {
  /** URL of pdf.worker(.min).mjs. Default (browser): the pinned jsDelivr copy. */
  workerSrc?: string;
  /**
   * Base URL (trailing slash) where pdfjs-dist's `cmaps/`, `standard_fonts/`,
   * `wasm/` and `iccs/` folders are served. Needed for CJK/Arabic text, PDFs
   * with non-embedded standard fonts, and JPEG 2000 / JBIG2 images. Fetched
   * only when a PDF needs them. Default (browser): the pinned jsDelivr copy.
   */
  pdfAssetsUrl?: string;
  /** Rendered canvases kept in memory (LRU). Default 12. */
  cacheSize?: number;
  /** Canvas factory. Defaults to a DOM canvas; tests inject a Node canvas. */
  createCanvas?: (width: number, height: number) => PageCanvas;
}

export interface RenderBox {
  /** Output canvas size in pixels. The page is fitted inside, centred, aspect preserved. */
  width: number;
  height: number;
}

const defaultCreateCanvas = (width: number, height: number): PageCanvas => {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  return c;
};

export function isRenderCancelled(err: unknown): boolean {
  return err instanceof RenderingCancelledException;
}

/**
 * One open PDF. Renders pages on demand into canvases of a requested size,
 * caches the results (LRU) and lets the caller cancel renders that are no
 * longer needed. Nothing is rendered up front.
 */
export class PdfDocument {
  private readonly cache = new Map<string, RenderedPage>();
  private readonly inflight = new Map<string, Inflight>();
  private readonly sizes = new Map<number, PageSize>();
  private destroyed = false;

  private constructor(
    private readonly pdf: PDFDocumentProxy,
    private readonly destroyTask: () => Promise<void>,
    private readonly cacheSize: number,
    private readonly createCanvas: (w: number, h: number) => PageCanvas,
  ) {}

  static async load(source: PdfSource, options: LoadOptions = {}): Promise<PdfDocument> {
    if (options.workerSrc) GlobalWorkerOptions.workerSrc = options.workerSrc;
    else if (inBrowser && !GlobalWorkerOptions.workerSrc) GlobalWorkerOptions.workerSrc = `${PDFJS_CDN}legacy/build/pdf.worker.min.mjs`;
    const params =
      typeof source === "string" || source instanceof URL
        ? { url: source }
        : // Copy: PDF.js transfers (detaches) the buffer, and rejects Node Buffers.
          { data: source instanceof ArrayBuffer ? new Uint8Array(source.slice(0)) : new Uint8Array(source) };
    try {
      const base = options.pdfAssetsUrl ?? (inBrowser ? PDFJS_CDN : undefined);
      const task = getDocument({
        ...params,
        ...(base && {
          cMapUrl: `${base}cmaps/`,
          standardFontDataUrl: `${base}standard_fonts/`,
          wasmUrl: `${base}wasm/`,
          iccUrl: `${base}iccs/`,
        }),
      });
      const pdf = await task.promise.catch(async (err: unknown) => {
        await task.destroy();
        throw err;
      });
      return new PdfDocument(pdf, () => task.destroy(), options.cacheSize ?? 12, options.createCanvas ?? defaultCreateCanvas);
    } catch (err) {
      if (err instanceof PasswordException) {
        throw new LuxeBookError("PASSWORD_REQUIRED", "The PDF is password protected.", { cause: err });
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new LuxeBookError("DOCUMENT_LOAD_FAILED", `Could not load PDF: ${msg}`, { cause: err });
    }
  }

  get pageCount(): number {
    return this.pdf.numPages;
  }

  async getInfo(): Promise<DocumentInfo> {
    const [{ info }, firstPageSize] = await Promise.all([this.pdf.getMetadata(), this.getPageSize(1)]);
    const meta = (info ?? {}) as Record<string, unknown>;
    const str = (k: string) => (typeof meta[k] === "string" && meta[k] ? (meta[k] as string) : undefined);
    const result: DocumentInfo = { pageCount: this.pageCount, firstPageSize };
    const fields = { title: "Title", author: "Author", subject: "Subject", keywords: "Keywords", creator: "Creator", producer: "Producer" } as const;
    for (const [key, pdfKey] of Object.entries(fields)) {
      const v = str(pdfKey);
      if (v) result[key as keyof typeof fields] = v;
    }
    const created = parsePdfDate(str("CreationDate"));
    const modified = parsePdfDate(str("ModDate"));
    if (created) result.creationDate = created;
    if (modified) result.modificationDate = modified;
    return result;
  }

  async getPageSize(pageNumber: number): Promise<PageSize> {
    const cached = this.sizes.get(pageNumber);
    if (cached) return cached;
    const page = await this.getPage(pageNumber);
    const { width, height } = page.getViewport({ scale: 1 });
    const size = { width, height };
    this.sizes.set(pageNumber, size);
    return size;
  }

  /** Synchronous cache lookup; also marks the entry as recently used. */
  getCached(pageNumber: number, box: RenderBox): RenderedPage | undefined {
    const key = cacheKey(pageNumber, box);
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
    }
    return hit;
  }

  /**
   * Render a page fitted into `box`. Concurrent requests for the same page
   * and size share one render. Rejects with a cancellation error (see
   * `isRenderCancelled`) if `cancelExcept` drops it.
   */
  renderPage(pageNumber: number, box: RenderBox): Promise<RenderedPage> {
    this.assertAlive();
    const key = cacheKey(pageNumber, box);
    const hit = this.getCached(pageNumber, box);
    if (hit) return Promise.resolve(hit);
    const running = this.inflight.get(key);
    if (running) return running.promise;

    const entry = { page: pageNumber } as Inflight;
    entry.promise = (async () => {
      try {
        const page = await this.getPage(pageNumber);
        if (!this.inflight.has(key)) throw new RenderingCancelledException("cancelled before start");
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(box.width / base.width, box.height / base.height);
        const viewport = page.getViewport({ scale });
        const canvas = this.createCanvas(box.width, box.height);
        // Letterbox: centre the page in the box so differently sized pages
        // keep their aspect ratio on a uniformly sized book page.
        const dx = Math.round((box.width - viewport.width) / 2);
        const dy = Math.round((box.height - viewport.height) / 2);
        entry.task = page.render({
          canvas: canvas as HTMLCanvasElement,
          viewport,
          transform: dx || dy ? [1, 0, 0, 1, dx, dy] : undefined,
          background: "#ffffff",
        });
        await entry.task.promise;
        const rendered: RenderedPage = { pageNumber, canvas, width: box.width, height: box.height };
        this.remember(key, rendered);
        return rendered;
      } catch (err) {
        if (isRenderCancelled(err)) throw err;
        throw new LuxeBookError("PAGE_RENDER_FAILED", `Page ${pageNumber} failed to render.`, { cause: err });
      } finally {
        if (this.inflight.get(key) === entry) this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, entry);
    return entry.promise;
  }

  /** Drop cached renders of size `box` (e.g. large zoomed-in renders no longer needed). */
  evict(box: RenderBox): void {
    const suffix = `:${box.width}x${box.height}`;
    for (const key of [...this.cache.keys()]) if (key.endsWith(suffix)) this.cache.delete(key);
  }

  /** Cancel in-flight renders for pages not in `keep` (e.g. after fast navigation). */
  cancelExcept(keep: Iterable<number>): void {
    const keepSet = new Set(keep);
    for (const [key, entry] of this.inflight) {
      if (keepSet.has(entry.page)) continue;
      this.inflight.delete(key);
      entry.task?.cancel();
    }
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelExcept([]);
    this.cache.clear();
    await this.destroyTask();
  }

  private async getPage(pageNumber: number): Promise<PDFPageProxy> {
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > this.pageCount) {
      throw new LuxeBookError("INVALID_ARGUMENT", `Page ${pageNumber} is outside 1..${this.pageCount}.`);
    }
    return this.pdf.getPage(pageNumber); // PDF.js caches page proxies itself
  }

  private remember(key: string, page: RenderedPage): void {
    this.cache.set(key, page);
    while (this.cache.size > this.cacheSize) {
      const oldest = this.cache.keys().next().value as string;
      this.cache.delete(oldest);
    }
  }

  private assertAlive(): void {
    if (this.destroyed) throw new LuxeBookError("DESTROYED", "PdfDocument has been destroyed.");
  }
}

interface Inflight {
  page: number;
  task?: RenderTask;
  promise: Promise<RenderedPage>;
}

const cacheKey = (page: number, box: RenderBox) => `${page}:${box.width}x${box.height}`;

/** Parse a PDF date string, e.g. `D:20240131120000+02'00'`. */
export function parsePdfDate(s: string | undefined): Date | undefined {
  if (!s) return undefined;
  const m = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+-])?(\d{2})?'?(\d{2})?'?/.exec(s);
  if (!m) return undefined;
  const n = (v: string | undefined, d: number) => (v ? Number(v) : d);
  const utc = Date.UTC(n(m[1], 0), n(m[2], 1) - 1, n(m[3], 1), n(m[4], 0), n(m[5], 0), n(m[6], 0));
  const sign = m[7] === "+" ? 1 : m[7] === "-" ? -1 : 0;
  const offsetMin = sign * (n(m[8], 0) * 60 + n(m[9], 0));
  return new Date(utc - offsetMin * 60_000);
}
