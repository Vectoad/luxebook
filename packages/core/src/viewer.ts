import { Spring } from "@vectoad/luxebook-animations";
import { PageTurnPhysics, type TurnDirection } from "@vectoad/luxebook-page-physics";
import { PdfDocument, isRenderCancelled, type RenderBox } from "@vectoad/luxebook-pdf-engine";
import { BookRenderer, type Side } from "@vectoad/luxebook-renderer-three";
import {
  APPEARANCE_KEYS,
  STATE_LOOK_KEYS,
  LuxeBookError,
  type AppearanceOptions,
  type BookClickEvent,
  type BookState,
  type DocumentInfo,
  type OverlayPage,
  type PdfSource,
  type Spread,
  type ViewerEvents,
  type ViewerOptions,
  type ViewerState,
  type ViewerStatus,
} from "@vectoad/luxebook-types";
import { quadToMatrix3d } from "./overlay.js";
import { computeSingleSpreads, computeSpreads, leavesUnder, preloadOrder, spreadIndexOf } from "./spreads.js";

type Resolved = Required<Omit<ViewerOptions, "workerSrc" | "pdfAssetsUrl" | "lastPage">> &
  Pick<ViewerOptions, "workerSrc" | "pdfAssetsUrl" | "lastPage">;

const DEFAULTS: Omit<Resolved, "workerSrc" | "pdfAssetsUrl" | "lastPage"> = {
  shadows: true,
  preloadPages: 2,
  showCover: true,
  startOpen: false,
  maxPixelRatio: 2,
  maxTextureSize: 2048,
  progressive: true,
  background: "#141312",
  backgroundImage: null,
  backgroundBrightness: 1,
  backgroundBlur: 0,
  shadowStrength: 0.5,
  cover: "first-page",
  coverColor: "#24211e",
  thickness: 1,
  turnSpeed: 1,
  zoom: 1,
  rotateX: 0,
  rotateY: 0,
  lighting: "neutral",
  paper: "glossy",
  offsetX: 0,
  offsetY: 0,
  states: {},
  coverThickness: 1,
  coverStyle: "soft",
  spineWidth: 1,
  layout: "auto",
};

/** [min, max] for every numeric appearance option. */
const RANGES = {
  backgroundBrightness: [0, 3],
  backgroundBlur: [0, 100],
  shadowStrength: [0, 1],
  thickness: [0.1, 5],
  turnSpeed: [0.1, 5],
  zoom: [0.6, 2.4],
  rotateX: [-60, 60],
  rotateY: [-60, 60],
  offsetX: [-1, 1],
  offsetY: [-1, 1],
  coverThickness: [0.1, 5],
  spineWidth: [0, 5],
} as const;

const SIDES: readonly Side[] = ["left", "right"];
const EMPTY_SPREAD: Spread = { left: null, right: null };
const TAP_SLOP_PX = 8;
/** Reading zoom: double-click/double-tap scale, and the most the pinch/ctrl+wheel can reach. */
const READING_ZOOM = 2.5;
const MAX_READING_ZOOM = 5;
const DOUBLE_TAP_MS = 280;
const DOUBLE_TAP_PX = 30;
/** Seconds for a page turn started by a tap or key (eased in and out). */
const TURN_SECONDS = 0.8;

interface PointerDrag {
  id: number;
  x: number;
  y: number;
  side: Side;
  physics: PageTurnPhysics | null;
  /** Grabbed point minus the pointer (page-local): the grabbed edge keeps its distance from the pointer. */
  offsetX: number;
  offsetY: number;
  /** The side the held leaf is hinged on (where its coordinates are taken). */
  foldSide: Side;
  /** Holding a soft cover (not a page turn). */
  cover: boolean;
}

interface ActiveTurn {
  side: Side;
  targetIndex: number;
  physics: PageTurnPhysics;
  ready: Promise<void>;
  prepared: boolean;
  stop: (() => void) | null;
  /** Play on a fixed eased timeline rather than the release spring. */
  timed: boolean;
  /** A corner lifted under a hovering mouse: not a turn yet. A click or drag takes it over. */
  peek: boolean;
}

export function resolveOptions(options: ViewerOptions = {}): Resolved {
  const o = { ...DEFAULTS, ...stripUndefined(options) };
  const bad = (msg: string) => new LuxeBookError("INVALID_ARGUMENT", msg);
  if (!Number.isInteger(o.preloadPages) || o.preloadPages < 0) throw bad("preloadPages must be a non-negative integer.");
  if (!(o.maxPixelRatio > 0)) throw bad("maxPixelRatio must be > 0.");
  if (!(o.maxTextureSize >= 256)) throw bad("maxTextureSize must be >= 256.");
  if (o.lastPage !== undefined && !(Number.isInteger(o.lastPage) && o.lastPage >= 1)) throw bad("lastPage must be a positive integer.");
  validateAppearance(o);
  return o;
}

function validateAppearance(o: AppearanceOptions): void {
  const bad = (msg: string) => new LuxeBookError("INVALID_ARGUMENT", msg);
  for (const [key, [min, max]] of Object.entries(RANGES)) {
    const v = o[key as keyof typeof RANGES];
    if (v !== undefined && !(Number.isFinite(v) && v >= min && v <= max)) throw bad(`${key} must be between ${min} and ${max}.`);
  }
  if (o.lighting !== undefined && !["neutral", "warm", "cool", "dramatic"].includes(o.lighting)) {
    throw bad('lighting must be "neutral", "warm", "cool" or "dramatic".');
  }
  if (o.paper !== undefined && !["matte", "silk", "glossy"].includes(o.paper)) throw bad('paper must be "matte", "silk" or "glossy".');
  if (o.coverStyle !== undefined && !["soft", "hard"].includes(o.coverStyle)) throw bad('coverStyle must be "soft" or "hard".');
  if (o.layout !== undefined && !["auto", "single", "double"].includes(o.layout)) {
    throw bad('layout must be "auto", "single" or "double".');
  }
  if (o.states !== undefined) {
    if (typeof o.states !== "object" || o.states === null) throw bad("states must be { closed?, open? }.");
    for (const look of [o.states.closed, o.states.open]) if (look) validateAppearance(look);
  }
  const c = o.cover;
  if (c !== undefined && c !== "first-page" && c !== "plain" && typeof c?.image !== "string") {
    throw bad('cover must be "first-page", "plain" or { image: url }.');
  }
}

/**
 * The LuxeBook viewer: owns one WebGL renderer and at most one open PDF,
 * keeps the visible spread in sync with page textures, and exposes
 * navigation and events. Framework-agnostic; React wraps this.
 */
export class LuxeBookViewer {
  private readonly options: Resolved;
  private readonly renderer: BookRenderer;
  private readonly resizeObserver: ResizeObserver;
  private readonly listeners = new Map<keyof ViewerEvents, Set<(e: never) => void>>();
  private doc: PdfDocument | null = null;
  /** Decoded `cover.image`, and the URL it came from. */
  private coverImage: { url: string; image: Promise<HTMLImageElement> } | null = null;
  private spreads: Spread[] = [];
  private index = 0;
  private status: ViewerStatus = "idle";
  private loadToken = 0;
  private showToken = 0;
  private box: RenderBox = { width: 0, height: 0 };
  private aspect = 1 / Math.SQRT2;
  private resizeTimer: ReturnType<typeof setTimeout> | undefined;
  private pointer: PointerDrag | null = null;
  private activeTurn: ActiveTurn | null = null;
  private queuedIndex: number | null = null;
  private zoomLevelValue = 1;
  private revealStop: (() => void) | null = null;
  private openStop: (() => void) | null = null;
  private openingDolly: Spring | null = null;
  private openingTargetIndex: number | null = null;
  private bookOpen = false;
  private bookOpening = false;
  private bookClosing = false;
  /** How far the cover has swung open, 0–1 (drives per-state looks). */
  private openAmount = 0;
  private lastBookState: BookState = "closed";
  /** Reading zoom target (1 = zoomed out). */
  private readingScale = 1;
  private focusStop: (() => void) | null = null;
  /** Drag-to-pan while zoomed in. */
  private pan: { id: number; x: number; y: number; fx: number; fy: number } | null = null;
  /** The previous tap, to spot a double tap; its single-tap action waits in `timer`. */
  private lastTap: { time: number; x: number; y: number; timer?: ReturnType<typeof setTimeout> } | null = null;
  /** Texture size rendered for the zoom, evicted from the cache on zoom out. */
  private zoomBox: RenderBox | null = null;
  /** Single-page view in use (`layout` resolved). */
  private single = false;
  /** `setOverlay()` content: its positioned wrapper, and where it goes. */
  private overlay: { host: HTMLDivElement; page: OverlayPage } | null = null;

  constructor(
    private readonly container: HTMLElement,
    options: ViewerOptions = {},
  ) {
    this.options = resolveOptions(options);
    try {
      this.renderer = new BookRenderer(container, {
        shadows: this.options.shadows,
        maxPixelRatio: this.options.maxPixelRatio,
      });
    } catch (err) {
      throw new LuxeBookError("WEBGL_UNAVAILABLE", "WebGL could not be initialised.", { cause: err });
    }
    const canvas = this.renderer.canvas;
    canvas.style.opacity = "0";
    canvas.style.transition = "opacity 700ms ease";
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerCancel);
    canvas.addEventListener("pointerleave", this.onPointerLeave);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });

    this.resizeObserver = new ResizeObserver(() => this.onResize());
    this.resizeObserver.observe(container);
    this.renderer.resize(container.clientWidth, container.clientHeight);
    this.zoomLevelValue = this.options.zoom;
    this.renderer.onRender = () => this.syncOverlay();
    this.applyLook();
    this.applyLayout();
  }

  /** Current options, with defaults filled in. */
  get config(): Readonly<Resolved> {
    return { ...this.options };
  }

  /**
   * Change appearance options live (background, cover, thickness, speed,
   * zoom, rotation…). Other keys are ignored: they need a new viewer.
   */
  setOptions(options: AppearanceOptions): void {
    this.assertAlive();
    const next = stripUndefined(Object.fromEntries(
      APPEARANCE_KEYS.filter((k) => k in options).map((k) => [k, options[k]]),
    ) as AppearanceOptions);
    validateAppearance(next);
    const coverChanged = "cover" in next && JSON.stringify(next.cover) !== JSON.stringify(this.options.cover);
    Object.assign(this.options, next);
    if (next.zoom !== undefined) this.setZoomLevel(next.zoom);
    this.applyLook();
    if (next.layout !== undefined) this.applyLayout();
    if (coverChanged && this.doc && this.options.showCover) void this.paintCover();
  }

  private setOpen(progress: number): void {
    this.openAmount = progress;
    this.renderer.setBookOpenProgress(progress);
    this.applyLook();
  }

  /** Emit "bookstate" when the open/closed state changes. */
  private syncBookState(): void {
    const state = this.bookState;
    if (state === this.lastBookState) return;
    this.lastBookState = state;
    this.emit("bookstate", { state });
  }

  private applyLook(): void {
    const o = this.options;
    // Blend each state's look by how far the book is open.
    const t = this.openAmount;
    const look = Object.fromEntries(STATE_LOOK_KEYS.map((k) => {
      const closed = o.states.closed?.[k] ?? o[k];
      const open = o.states.open?.[k] ?? o[k];
      return [k, closed + (open - closed) * t];
    })) as Record<(typeof STATE_LOOK_KEYS)[number], number>;
    this.renderer.setLook({
      background: o.background,
      backgroundImage: o.backgroundImage,
      backgroundBrightness: look.backgroundBrightness,
      backgroundBlur: look.backgroundBlur,
      shadowStrength: o.shadows ? look.shadowStrength : 0,
      coverColor: o.coverColor,
      thickness: o.thickness,
      rotateX: look.rotateX,
      rotateY: look.rotateY,
      speed: o.turnSpeed,
      lighting: o.lighting,
      paper: o.paper,
      // Per-state zoom is relative to the base zoom (which the zoom buttons change).
      zoomFactor: look.zoom / o.zoom,
      offsetX: look.offsetX,
      offsetY: look.offsetY,
      // A soft cover is a paperback's: card, not board.
      coverThickness: o.coverThickness * (o.coverStyle === "soft" ? 0.3 : 1),
      spineWidth: o.spineWidth,
    });
  }

  get state(): ViewerState {
    return {
      status: this.status,
      pageCount: this.pageCount,
      spread: this.spreads[this.index] ?? EMPTY_SPREAD,
      bookState: this.bookState,
      layout: this.single ? "single" : "double",
    };
  }

  /** "closed" (initial pose), "opening", "open" or "closing". */
  get bookState(): BookState {
    if (this.bookOpening) return "opening";
    if (this.bookClosing) return "closing";
    return this.bookOpen ? "open" : "closed";
  }

  /** Open the book (animated). Same as tapping the cover. */
  open(): void {
    this.assertAlive();
    this.openBook();
  }

  /** Close the book (animated) and return it to its closed look. */
  close(): void {
    this.assertAlive();
    this.zoomOutForNavigation();
    if (this.options.showCover) this.closeBook();
  }

  /** Current reading zoom: 1 when zoomed out. */
  get readingZoom(): number {
    return this.readingScale;
  }

  /**
   * Reading zoom: magnify the open book `scale`× (1–5), keeping the point at
   * (clientX, clientY) under the pointer (default: the centre). `zoomTo(1)`
   * zooms back out. Double-click/double-tap on a page does this for the reader;
   * while zoomed in, drag or scroll pans and navigation zooms out first.
   */
  zoomTo(scale: number, clientX?: number, clientY?: number): void {
    this.assertAlive();
    if (!Number.isFinite(scale)) throw new LuxeBookError("INVALID_ARGUMENT", `Invalid zoom: ${scale}`);
    let s = Math.min(MAX_READING_ZOOM, Math.max(1, scale));
    if (s < 1.05) s = 1; // a pinch that ends near 1 means "zoomed out"
    if (s > 1 && !this.bookOpen) return;
    const rect = this.renderer.canvas.getBoundingClientRect();
    const qx = clientX === undefined ? 0.5 : (clientX - rect.left) / rect.width;
    const qy = clientY === undefined ? 0.5 : (clientY - rect.top) / rect.height;
    // The content under the pointer (as a fraction of the unzoomed view) stays under it at every scale.
    const from = this.renderer.focus;
    const px = from.x + (qx - 0.5) / from.scale;
    const py = from.y + (qy - 0.5) / from.scale;
    const at = (k: number) => this.renderer.setFocus(k, px - (qx - 0.5) / k, py - (qy - 0.5) / k);

    this.focusStop?.();
    this.focusStop = null;
    if (s !== this.readingScale) {
      this.readingScale = s;
      this.renderer.canvas.style.cursor = s > 1 ? "grab" : "";
      this.emit("readingzoom", { scale: s });
    }
    if (globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      at(s);
      this.sharpenForZoom();
      return;
    }
    const spring = new Spring(from.scale, { stiffness: 140, damping: 2 * Math.sqrt(140) });
    spring.target = s;
    this.focusStop = this.renderer.animate((dt) => {
      const done = stepVisible(spring, dt);
      at(spring.value);
      if (!done) return false;
      this.focusStop = null;
      this.sharpenForZoom(); // once settled, so a pinch doesn't re-render at every step
      return true;
    });
  }

  private zoomOutForNavigation(): void {
    if (this.readingScale > 1) this.zoomTo(1);
  }

  get zoomLevel(): number {
    return this.zoomLevelValue;
  }

  on<K extends keyof ViewerEvents>(type: K, handler: (event: ViewerEvents[K]) => void): () => void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(handler as (e: never) => void);
    return () => set.delete(handler as (e: never) => void);
  }

  /**
   * Open a PDF, replacing any current one. Resolves once the first spread is
   * on screen. A load superseded by a newer `load` rejects with code `ABORTED`.
   */
  async load(source: PdfSource): Promise<DocumentInfo> {
    this.assertAlive();
    const token = ++this.loadToken;
    this.showToken++;
    this.cancelActiveTurn();
    this.openStop?.();
    this.openStop = null;
    this.openingDolly = null;
    this.openingTargetIndex = null;
    this.bookOpen = false;
    this.bookOpening = false;
    this.bookClosing = false;
    this.syncBookState();
    this.renderer.setBookCoverImage(null);
    this.renderer.setCoverInsideImage(null);
    this.setOpen(0);
    this.renderer.setDolly(this.renderer.closedDolly / this.zoomLevelValue);
    this.pointer = null;
    this.queuedIndex = null;
    this.resetReadingZoom();
    this.status = "loading";
    const previous = this.doc;
    this.doc = null;
    this.spreads = [];
    void previous?.destroy();

    try {
      const doc = await PdfDocument.load(source, {
        ...(this.options.workerSrc && { workerSrc: this.options.workerSrc }),
        ...(this.options.pdfAssetsUrl && { pdfAssetsUrl: this.options.pdfAssetsUrl }),
        cacheSize: 4 * (this.options.preloadPages + 2),
      });
      if (token !== this.loadToken) {
        void doc.destroy();
        throw new LuxeBookError("ABORTED", "Superseded by a newer load().");
      }
      const info = await doc.getInfo();
      if (token !== this.loadToken) {
        void doc.destroy();
        throw new LuxeBookError("ABORTED", "Superseded by a newer load().");
      }
      this.doc = doc;
      this.aspect = info.firstPageSize.width / info.firstPageSize.height;
      this.renderer.setPageAspect(this.aspect);
      this.box = this.computeBox();
      this.spreads = this.makeSpreads(this.pageCount);
      await this.showSpread(0);
      if (this.options.showCover && this.pageCount > 0) await this.paintCover();
      if (token !== this.loadToken) throw new LuxeBookError("ABORTED", "Superseded by a newer load().");
      this.status = "ready";
      // No cover: there is no closed state to show, so start on the open spread (page 1 | page 2).
      if (this.options.startOpen || !this.options.showCover) this.openBook(true);
      this.reveal();
      this.emit("ready", info);
      return info;
    } catch (err) {
      const error =
        err instanceof LuxeBookError
          ? err
          : new LuxeBookError("DOCUMENT_LOAD_FAILED", String(err), { cause: err });
      if (error.code !== "ABORTED" && token === this.loadToken) {
        this.status = "error";
        this.emit("error", error);
      }
      throw error;
    }
  }

  private async paintCover(): Promise<void> {
    const doc = this.doc!;
    const token = this.loadToken;
    const cover = this.options.cover;
    let image: HTMLCanvasElement | OffscreenCanvas | null = null;
    try {
      if (typeof cover === "object") image = cropToPage(await this.loadCoverImage(cover.image), this.box);
      else if (cover === "first-page") image = (doc.getCached(1, this.box) ?? await doc.renderPage(1, this.box)).canvas;
    } catch (err) {
      this.emit("error", new LuxeBookError("PAGE_RENDER_FAILED", "Could not load the cover image.", { cause: err }));
    }
    // Ignore if a newer load or cover change happened meanwhile.
    if (token === this.loadToken && this.doc === doc && cover === this.options.cover) this.renderer.setBookCoverImage(image);
  }

  private loadCoverImage(url: string): Promise<HTMLImageElement> {
    if (this.coverImage?.url !== url) {
      const img = new Image();
      img.crossOrigin = "anonymous"; // a cross-origin image must allow CORS to be used as a texture
      img.src = url;
      this.coverImage = { url, image: img.decode().then(() => img) };
    }
    return this.coverImage.image;
  }

  next(): void {
    this.zoomOutForNavigation();
    this.requestNavigation("forward");
  }

  previous(): void {
    this.zoomOutForNavigation();
    this.requestNavigation("backward");
  }

  zoomIn(): void {
    this.setZoomLevel(Math.min(2.4, this.zoomLevelValue * 1.2));
  }

  zoomOut(): void {
    this.setZoomLevel(Math.max(0.6, this.zoomLevelValue / 1.2));
  }

  resetZoom(): void {
    this.setZoomLevel(1);
  }

  goToPage(page: number): void {
    if (!Number.isInteger(page)) throw new LuxeBookError("INVALID_ARGUMENT", `Invalid page: ${page}`);
    if (!this.doc) return;
    this.zoomOutForNavigation();
    const i = spreadIndexOf(this.spreads, page);
    if (!this.bookOpen && this.status === "ready") {
      this.queuedIndex = null;
      this.openingTargetIndex = i;
      this.openBook();
      return;
    }
    if (this.closesBook(i)) {
      this.closeBook();
      return;
    }
    if (i !== this.index) {
      this.queuedIndex = null;
      this.cancelActiveTurn();
      void this.showSpread(i);
    }
  }

  /**
   * Put your own HTML (a contact form, a video, buttons) on a page: it sits
   * on the page in perspective, follows camera moves and reading zoom, and
   * fades out while that page turns or the book closes (HTML can't curl).
   * Default page: `"end"`. Pass `null` to remove it. Size it with CSS
   * `width/height: 100%`: the wrapper is exactly the page.
   */
  setOverlay(element: HTMLElement | null, options: { page?: OverlayPage } = {}): void {
    this.assertAlive();
    const page = options.page ?? "end";
    if (page !== "end" && !Number.isInteger(page)) throw new LuxeBookError("INVALID_ARGUMENT", `Invalid overlay page: ${page}`);
    if (this.overlay && this.overlay.host.firstChild !== element) {
      this.overlay.host.remove();
      this.overlay = null;
    }
    if (!element) return;
    if (!this.overlay) {
      const host = document.createElement("div");
      Object.assign(host.style, {
        position: "absolute", left: "0", top: "0", transformOrigin: "0 0", overflow: "hidden",
        opacity: "0", visibility: "hidden", transition: "opacity 250ms ease, visibility 250ms",
      });
      host.append(element);
      this.renderer.root.append(host);
      this.overlay = { host, page };
    }
    this.overlay.page = page;
    this.syncOverlay();
  }

  /** The side the overlay's page lies on right now, or null while it shouldn't show. */
  private overlaySide(page: OverlayPage): Side | null {
    const spread = this.spreads[this.index];
    if (!spread || this.status !== "ready" || this.bookState !== "open" || this.activeTurn) return null;
    if (page === "end" && this.options.lastPage !== undefined) page = this.pageCount; // the preview page
    if (page === "end") {
      const last = this.index === this.spreads.length - 1;
      return !this.single && last && spread.left !== null && spread.right === null ? "right" : null;
    }
    if (spread.right === page) return "right";
    return !this.single && spread.left === page ? "left" : null;
  }

  private syncOverlay(): void {
    const o = this.overlay;
    if (!o) return;
    const side = this.overlaySide(o.page);
    Object.assign(o.host.style, { opacity: side ? "1" : "0", visibility: side ? "visible" : "hidden" });
    if (!side) return; // keep the last position while fading out
    const q = this.renderer.pageQuad(side);
    // Lay out at the unzoomed page size: reading zoom magnifies the overlay instead of reflowing it.
    const s = this.renderer.focus.scale;
    const w = Math.max(1, Math.round(Math.hypot(q[1]!.x - q[0]!.x, q[1]!.y - q[0]!.y) / s));
    const h = Math.max(1, Math.round(Math.hypot(q[3]!.x - q[0]!.x, q[3]!.y - q[0]!.y) / s));
    Object.assign(o.host.style, { width: `${w}px`, height: `${h}px`, transform: quadToMatrix3d(q, w, h) });
  }

  destroy(): void {
    if (this.status === "destroyed") return;
    this.status = "destroyed";
    this.loadToken++;
    this.showToken++;
    clearTimeout(this.resizeTimer);
    this.resizeObserver.disconnect();
    this.revealStop?.();
    this.revealStop = null;
    this.openStop?.();
    this.openStop = null;
    this.openingDolly = null;
    this.focusStop?.();
    clearTimeout(this.lastTap?.timer);
    const canvas = this.renderer.canvas;
    canvas.removeEventListener("pointerdown", this.onPointerDown);
    canvas.removeEventListener("pointermove", this.onPointerMove);
    canvas.removeEventListener("pointerup", this.onPointerUp);
    canvas.removeEventListener("pointercancel", this.onPointerCancel);
    canvas.removeEventListener("pointerleave", this.onPointerLeave);
    canvas.removeEventListener("wheel", this.onWheel);
    this.cancelActiveTurn();
    this.overlay = null;
    this.renderer.onRender = null;
    this.renderer.dispose();
    void this.doc?.destroy();
    this.doc = null;
    this.listeners.clear();
  }

  /** Test hook: render synchronously and return the WebGL canvas. */
  snapshot(): HTMLCanvasElement {
    this.renderer.renderNow();
    return this.renderer.canvas;
  }

  // --- internals -----------------------------------------------------------

  private async showSpread(
    index: number,
    opts: { resolutionUpgrade?: boolean; preserveTurn?: ActiveTurn; skipPreload?: boolean } = {},
  ): Promise<void> {
    if (this.activeTurn !== opts.preserveTurn) this.cancelActiveTurn();
    const doc = this.doc;
    const spread = this.spreads[index];
    if (!doc || !spread) return;
    const token = ++this.showToken;
    const changed = index !== this.index || !opts.resolutionUpgrade;
    this.index = index;

    const leaves = leavesUnder(spread, this.pageCount);
    // Closed book: the cover carries its own leaf, so the block under it has one fewer.
    if (this.options.showCover && index === 0 && this.spreads.length > 1) leaves.right = Math.max(0, leaves.right - 1);
    this.renderer.setStack(leaves.left, leaves.right);
    for (const side of SIDES) this.renderer.setPageVisible(side, spread[side] !== null);

    const visible = SIDES.map((s) => spread[s]).filter((p): p is number => p !== null);
    const preload = preloadOrder(spread, this.readablePages, this.options.preloadPages);
    doc.cancelExcept([...visible, ...preload]);
    if (changed && this.status === "ready") {
      this.emit("pagechange", { spread, page: this.pageOf(spread), pageCount: this.pageCount });
    }

    await Promise.all(SIDES.map((side) => this.paint(doc, side, spread[side], token, !opts.resolutionUpgrade)));

    // Pre-render neighbours one at a time, nearest first, so they never
    // compete with the visible pages for the PDF worker.
    if (!opts.skipPreload) {
      for (const page of preload) {
        if (token !== this.showToken) return;
        await doc.renderPage(page, this.box).catch(() => undefined);
      }
    }
  }

  private async paint(doc: PdfDocument, side: Side, page: number | null, token: number, fresh: boolean): Promise<void> {
    const current = () => token === this.showToken && doc === this.doc;
    if (page === null || page > this.readablePages) {
      this.renderer.setPageImage(side, null);
      return;
    }
    const box = this.box;
    const cached = doc.getCached(page, box);
    if (cached) {
      this.renderer.setPageImage(side, cached.canvas);
      return;
    }
    try {
      if (fresh) {
        this.renderer.setPageImage(side, null); // blank paper rather than the wrong page
        if (this.options.progressive) {
          const preview = { width: Math.ceil(box.width / 4), height: Math.ceil(box.height / 4) };
          const low = await doc.renderPage(page, preview);
          if (!current()) return;
          this.renderer.setPageImage(side, low.canvas);
        }
      }
      const full = await doc.renderPage(page, box);
      if (current()) this.renderer.setPageImage(side, full.canvas);
    } catch (err) {
      if (isRenderCancelled(err) || !current()) return;
      this.emit("error", err instanceof LuxeBookError ? err : new LuxeBookError("PAGE_RENDER_FAILED", String(err), { cause: err }));
    }
  }

  /**
   * Texture size for one page: about the page's on-screen size in device
   * pixels, snapped to 128 px steps (stable cache keys during resizes) and
   * clamped to the configured and GPU limits.
   */
  private computeBox(): RenderBox {
    const dpr = Math.min(globalThis.devicePixelRatio || 1, this.options.maxPixelRatio);
    const w = this.container.clientWidth || 800;
    const h = this.container.clientHeight || 600;
    const zoom = this.readingScale;
    const onScreen = (Math.min(h, w / ((this.single ? 1 : 2) * this.aspect)) / 1.1) * dpr * zoom;
    // Zoomed in, allow up to twice the usual cap so small print gets sharp.
    const limit = Math.min(this.options.maxTextureSize * (zoom > 1 ? 2 : 1), this.renderer.maxTextureSize);
    const height = Math.min(limit, Math.max(256, Math.ceil(onScreen / 128) * 128));
    return { width: Math.round(height * this.aspect), height };
  }

  /** Re-render the visible pages for the current reading zoom; drop the big renders when zoomed out. */
  private sharpenForZoom(): void {
    const doc = this.doc;
    if (!doc) return;
    const box = this.computeBox();
    if (this.readingScale > 1) {
      if (box.height <= this.box.height) return;
      if (this.zoomBox) doc.evict(this.zoomBox);
      this.box = this.zoomBox = box;
      void this.showSpread(this.index, { resolutionUpgrade: true, skipPreload: true });
    } else if (this.zoomBox) {
      doc.evict(this.zoomBox); // the on-screen textures keep their copy
      this.zoomBox = null;
      this.box = box;
    }
  }

  /** Jump straight back to the unzoomed view (new document). */
  private resetReadingZoom(): void {
    this.focusStop?.();
    this.focusStop = null;
    this.pan = null;
    this.zoomBox = null;
    this.renderer.setFocus(1, 0.5, 0.5);
    this.renderer.canvas.style.cursor = "";
    if (this.readingScale !== 1) {
      this.readingScale = 1;
      this.emit("readingzoom", { scale: 1 });
    }
  }

  /** PDF pages the reader can see: all of them, or up to `lastPage`. */
  private get readablePages(): number {
    const n = this.doc?.pageCount ?? 0;
    return this.options.lastPage === undefined ? n : Math.min(n, this.options.lastPage);
  }

  /** Pages in the book: with `lastPage`, one blank preview page follows the last readable one. */
  private get pageCount(): number {
    return this.options.lastPage === undefined || !this.doc ? this.readablePages : this.readablePages + 1;
  }

  private makeSpreads(pageCount: number): Spread[] {
    return this.single ? computeSingleSpreads(pageCount) : computeSpreads(pageCount, this.options.showCover);
  }

  /** The page a reader is on: the right one in single layout, else the lowest visible. */
  private pageOf(spread: Spread): number {
    if (this.single) return spread.right ?? 1;
    return Math.min(...[spread.left, spread.right].filter((p): p is number => p !== null));
  }

  /**
   * Switch between the spread and the single-page view when `layout` (or,
   * for "auto", the viewer's shape) calls for it, staying on the same page.
   */
  private applyLayout(): void {
    const { layout } = this.options;
    const single = layout === "single" || (layout === "auto" && this.container.clientWidth < this.container.clientHeight);
    if (single === this.single) return;
    const spread = this.spreads[this.index];
    const page = spread ? this.pageOf(spread) : 1;
    this.single = single;
    this.renderer.setPagesAcross(single ? 1 : 2);
    if (this.openingDolly) this.openingDolly.target = (this.bookOpening ? 1 : this.renderer.closedDolly) / this.zoomLevelValue;
    else this.renderer.setDolly((this.bookOpen ? 1 : this.renderer.closedDolly) / this.zoomLevelValue);
    const doc = this.doc;
    if (!doc) return;
    this.cancelActiveTurn();
    this.queuedIndex = null;
    this.pointer = null;
    this.resetReadingZoom();
    const box = this.computeBox();
    if (box.height > this.box.height) this.box = box; // one page fills more of the screen
    this.spreads = this.makeSpreads(this.pageCount);
    void this.showSpread(spreadIndexOf(this.spreads, page));
  }

  private onResize(): void {
    this.renderer.resize(this.container.clientWidth, this.container.clientHeight);
    this.applyLayout();
    if (!this.doc) return;
    clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      const box = this.computeBox();
      // Only re-render when the view got meaningfully bigger; a sharper texture is fine when shrinking.
      if (box.height > this.box.height) {
        this.box = box;
        void this.showSpread(this.index, { resolutionUpgrade: true });
      }
    }, 200);
  }

  /** Fade in and settle the camera: restrained, and skipped for reduced motion. */
  private reveal(): void {
    const canvas = this.renderer.canvas;
    const reduced = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (canvas.style.opacity === "1" || reduced) {
      this.renderer.setDolly((this.bookOpen ? 1 : this.renderer.closedDolly) / this.zoomLevelValue);
      canvas.style.opacity = "1";
      return;
    }
    const dolly = new Spring(0.9 / this.zoomLevelValue, { stiffness: 18, damping: 2 * Math.sqrt(18) });
    dolly.target = (this.bookOpen ? 1 : this.renderer.closedDolly) / this.zoomLevelValue;
    this.renderer.setDolly(dolly.value);
    canvas.style.opacity = "1";
    this.revealStop = this.renderer.animate((dt) => {
      const done = dolly.step(dt);
      this.renderer.setDolly(dolly.value);
      if (done) this.revealStop = null;
      return done;
    });
  }

  private setZoomLevel(level: number): void {
    if (level === this.zoomLevelValue) return;
    this.revealStop?.();
    this.revealStop = null;
    this.zoomLevelValue = level;
    if (this.openingDolly) this.openingDolly.target = (this.bookOpening ? 1 : this.renderer.closedDolly) / level;
    else this.renderer.setDolly((this.bookOpen ? 1 : this.renderer.closedDolly) / level);
  }

  // Mouse and touch share one model: drag a page, or tap a half to turn.
  private readonly onPointerDown = (e: PointerEvent): void => {
    if (this.readingScale > 1) {
      // Zoomed in: the pointer pans instead of turning pages.
      if (e.button !== 0 || this.pan) return;
      const f = this.renderer.focus;
      this.pan = { id: e.pointerId, x: e.clientX, y: e.clientY, fx: f.x, fy: f.y };
      this.renderer.canvas.style.cursor = "grabbing";
      if (e.isTrusted) this.renderer.canvas.setPointerCapture(e.pointerId);
      return;
    }
    const peek = this.peeking;
    if (e.button !== 0 || this.pointer || (this.activeTurn && !peek) || this.status !== "ready") return;
    const rect = this.renderer.canvas.getBoundingClientRect();
    this.pointer = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      side: e.clientX < rect.left + rect.width / 2 ? "left" : "right",
      physics: null,
      offsetX: 0,
      offsetY: 0,
      foldSide: "right",
      cover: false,
    };
    if (peek) {
      // Pick up the lifted corner where it is.
      peek.peek = false;
      this.grab(this.pointer, peek.physics, peek.side);
    }
    if (e.isTrusted) this.renderer.canvas.setPointerCapture(e.pointerId);
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    const pan = this.pan;
    if (pan?.id === e.pointerId) {
      if (this.focusStop) return; // let a running zoom finish first
      const rect = this.renderer.canvas.getBoundingClientRect();
      const s = this.renderer.focus.scale;
      this.renderer.setFocus(s, pan.fx - (e.clientX - pan.x) / rect.width / s, pan.fy - (e.clientY - pan.y) / rect.height / s);
      return;
    }
    const pointer = this.pointer;
    if (!pointer) {
      this.updatePeek(e);
      return;
    }
    if (pointer.id !== e.pointerId) return;
    if (pointer.physics) {
      this.updatePointerTurn(pointer, e.clientX, e.clientY);
      return;
    }
    if (!this.bookOpen) {
      // Soft cover: pull it open by the edge.
      if (this.softCover && e.clientX - pointer.x < -TAP_SLOP_PX && this.status === "ready" && !this.bookOpening && !this.bookClosing) {
        const physics = this.coverPhysics("forward", pointer);
        this.openBook(false, physics);
        if (!this.bookOpening) pointer.physics = null; // didn't start
      }
      return;
    }
    const dx = e.clientX - pointer.x;
    if (dx < -TAP_SLOP_PX) this.beginPointerTurn(pointer, "forward", e.clientX, e.clientY);
    else if (dx > TAP_SLOP_PX) this.beginPointerTurn(pointer, "backward", e.clientX, e.clientY);
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    const pan = this.pan;
    if (pan?.id === e.pointerId) {
      this.pan = null;
      this.renderer.canvas.style.cursor = this.readingScale > 1 ? "grab" : "";
      // A double tap while zoomed in zooms back out.
      if (Math.hypot(e.clientX - pan.x, e.clientY - pan.y) < TAP_SLOP_PX && this.isDoubleTap(e)) this.zoomTo(1, e.clientX, e.clientY);
      return;
    }
    const pointer = this.pointer;
    if (!pointer || pointer.id !== e.pointerId) return;
    this.pointer = null;
    if (pointer.cover && pointer.physics) {
      this.updatePointerTurn(pointer, e.clientX, e.clientY);
      pointer.physics.release();
      return;
    }
    if (!this.bookOpen) {
      const moved = Math.hypot(e.clientX - pointer.x, e.clientY - pointer.y) >= TAP_SLOP_PX;
      // Swiping anywhere opens the book; a tap opens it only on the book itself.
      if (moved || this.click(e)?.target === "cover") this.openBook();
      return;
    }
    if (pointer.physics) {
      const turn = this.activeTurn;
      this.updatePointerTurn(pointer, e.clientX, e.clientY);
      if (turn && Math.hypot(e.clientX - pointer.x, e.clientY - pointer.y) < TAP_SLOP_PX) {
        // A click on a lifted corner turns the page, smoothly from where it is (unless a listener says no).
        const go = this.click(e) !== null;
        turn.timed = go;
        this.settleTurn(turn, go);
      } else {
        this.settleTurn(turn);
      }
      return;
    }
    const dx = e.clientX - pointer.x;
    const dy = e.clientY - pointer.y;
    if (dx < -TAP_SLOP_PX || dx > TAP_SLOP_PX) {
      this.beginPointerTurn(pointer, dx < 0 ? "forward" : "backward", e.clientX, e.clientY);
      this.settleTurn(this.activeTurn);
    } else if (Math.hypot(dx, dy) < TAP_SLOP_PX) {
      if (this.isDoubleTap(e)) {
        // Double tap on a page: zoom in there to read (the first tap's turn was cancelled).
        if (this.renderer.hitTest(e.clientX, e.clientY)?.target === "page") this.zoomTo(READING_ZOOM, e.clientX, e.clientY);
        return;
      }
      const hit = this.click(e);
      if (hit?.target === "page") {
        // Wait briefly: a second tap means "zoom in", not "turn".
        this.lastTap!.timer = setTimeout(() => (hit.side === "right" ? this.next() : this.previous()), DOUBLE_TAP_MS);
      }
    }
  };

  /** Is this tap the second of a double tap? Otherwise it becomes the "previous tap". */
  private isDoubleTap(e: PointerEvent): boolean {
    const now = performance.now();
    const last = this.lastTap;
    if (last && now - last.time < DOUBLE_TAP_MS && Math.hypot(e.clientX - last.x, e.clientY - last.y) < DOUBLE_TAP_PX) {
      clearTimeout(last.timer);
      this.lastTap = null;
      return true;
    }
    this.lastTap = { time: now, x: e.clientX, y: e.clientY };
    return false;
  }

  /** Trackpad pinch (or ctrl+wheel) zooms; plain scrolling pans while zoomed in. */
  private readonly onWheel = (e: WheelEvent): void => {
    if (e.ctrlKey) {
      if (!this.bookOpen) return;
      e.preventDefault();
      this.zoomTo(this.readingScale * Math.exp(-Math.max(-50, Math.min(50, e.deltaY)) * 0.01), e.clientX, e.clientY);
    } else if (this.readingScale > 1 && !this.focusStop) {
      e.preventDefault();
      const rect = this.renderer.canvas.getBoundingClientRect();
      const f = this.renderer.focus;
      this.renderer.setFocus(f.scale, f.x + e.deltaX / rect.width / f.scale, f.y + e.deltaY / rect.height / f.scale);
    } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      // Scroll down flips toward the end, up toward the start; a harder scroll flips more pages.
      // ponytail: fixed thresholds; make them options if readers find it too fast/slow.
      const FIRST = 60; // px to the first flip of a gesture
      const STEP = 500; // px per extra page after that
      e.preventDefault();
      const dy = e.deltaY * (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1); // lines/pages → px
      // A new gesture (or a reversal) starts STEP − FIRST in, so it flips after FIRST px.
      if (e.timeStamp - this.lastWheel > 250 || Math.sign(dy) !== this.wheelDir) this.wheelAcc = Math.sign(dy) * (STEP - FIRST);
      this.wheelAcc += dy;
      this.wheelDir = Math.sign(dy);
      this.lastWheel = e.timeStamp;
      for (; Math.abs(this.wheelAcc) >= STEP; this.wheelAcc -= Math.sign(this.wheelAcc) * STEP) {
        if (this.wheelAcc > 0) this.next();
        else this.previous();
      }
    }
  };
  private lastWheel = -Infinity;
  private wheelAcc = 0;
  private wheelDir = 0;

  /**
   * Emit a "click" for a tap. Returns what was hit, or null when a listener
   * called preventDefault() or nothing actionable was hit.
   */
  private click(e: PointerEvent): { target: BookClickEvent["target"]; side: Side | null } | null {
    const hit = this.renderer.hitTest(e.clientX, e.clientY);
    const spread = this.spreads[this.index];
    if (hit?.target === "page" && this.single) {
      // One page on screen: its left half goes back, its right half forward.
      const rect = this.renderer.canvas.getBoundingClientRect();
      hit.side = e.clientX < rect.left + rect.width / 2 ? "left" : "right";
    }
    let prevented = false;
    const event: BookClickEvent = {
      target: hit?.target ?? "background",
      side: hit?.side ?? null,
      page: hit?.target === "cover" ? 1 : hit?.target === "page" ? ((this.single ? spread?.right : spread?.[hit.side]) ?? null) : null,
      originalEvent: e,
      get defaultPrevented() {
        return prevented;
      },
      preventDefault() {
        prevented = true;
      },
    };
    this.emit("click", event);
    return prevented || !hit ? null : { target: hit.target, side: hit.side };
  }

  private readonly onPointerCancel = (e: PointerEvent): void => {
    if (this.pan?.id === e.pointerId) this.pan = null;
    if (!this.pointer || this.pointer.id !== e.pointerId) return;
    if (this.pointer.cover) this.pointer.physics?.release(false);
    else if (this.pointer.physics) this.settleTurn(this.activeTurn, false);
    this.pointer = null;
  };

  private beginPointerTurn(pointer: PointerDrag, direction: TurnDirection, x: number, y: number): void {
    const side: Side = direction === "forward" ? "right" : "left";
    const targetIndex = this.index + (direction === "forward" ? 1 : -1);
    if (!this.spreads[targetIndex]) return;
    if (this.closesBook(targetIndex)) {
      // Soft cover: pull it shut by the edge; a hard cover just swings shut.
      this.closeBook(this.softCover ? this.coverPhysics("backward", pointer) : undefined);
      return;
    }
    // Take the leaf by its outer edge at the height it was grabbed (by the corner near the top or bottom).
    const down = this.renderer.pageLocal(side, pointer.x, pointer.y) ?? { x: this.aspect, y: 0 };
    const physics = new PageTurnPhysics(this.aspect);
    physics.begin(direction, this.aspect, down.y, performance.now());
    const turn = this.createTurn(side, targetIndex, physics);
    this.activeTurn = turn;
    this.grab(pointer, physics, side);
    this.updatePointerTurn(pointer, x, y);
    // The leaf eases after the pointer every frame, not only when it moves.
    void turn.ready.then(() => this.runTurnAnimation(turn));
  }

  /** The pointer holds a leaf hinged on `side`: the grabbed point keeps its offset from the pointer. */
  private grab(pointer: PointerDrag, physics: PageTurnPhysics, side: Side): void {
    const down = this.renderer.pageLocal(side, pointer.x, pointer.y);
    pointer.physics = physics;
    pointer.foldSide = side;
    pointer.offsetX = down ? physics.cornerX - down.x : 0;
    pointer.offsetY = down ? physics.cornerY - down.y : 0;
  }

  private get softCover(): boolean {
    return this.options.coverStyle === "soft" && this.options.showCover;
  }

  /**
   * A fold for the soft cover: held by `pointer` (by its edge, where it was
   * grabbed), or, without one, a timed turn lifting the bottom corner.
   */
  private coverPhysics(direction: TurnDirection, pointer?: PointerDrag): PageTurnPhysics {
    const side: Side = direction === "forward" ? "right" : "left";
    const physics = new PageTurnPhysics(this.aspect);
    const down = pointer && this.renderer.pageLocal(side, pointer.x, pointer.y);
    physics.begin(direction, this.aspect, down ? down.y : -0.5, performance.now());
    if (pointer) {
      this.grab(pointer, physics, side);
      pointer.cover = true;
    } else {
      physics.release(true);
    }
    return physics;
  }

  /** The hover-lifted corner, while it is only that. */
  private get peeking(): ActiveTurn | null {
    const turn = this.activeTurn;
    return turn?.peek && turn.physics.phase === "dragging" ? turn : null;
  }

  /** A mouse over a page corner lifts it a little, inviting a click or drag; leaving lays it back. */
  private updatePeek(e: PointerEvent): void {
    const peek = this.peeking;
    if (this.activeTurn && !peek) return; // a real turn is running
    const corner = e.pointerType === "mouse" && this.bookOpen && this.status === "ready" && !this.pan && this.readingScale === 1
      ? this.cornerAt(e.clientX, e.clientY)
      : null;
    if (peek && corner?.side !== peek.side) this.endPeek();
    if (!corner) return;
    let turn = this.peeking;
    if (!turn) {
      const physics = new PageTurnPhysics(this.aspect);
      physics.begin(corner.side === "right" ? "forward" : "backward", this.aspect, Math.sign(corner.y) * 0.5, performance.now());
      turn = this.createTurn(corner.side, this.index + (corner.side === "right" ? 1 : -1), physics);
      turn.peek = true;
      this.activeTurn = turn;
      const started = turn;
      void turn.ready.then(() => this.runTurnAnimation(started));
      this.renderer.canvas.style.cursor = "pointer";
    }
    // The corner lifts towards the page, a little ahead of the pointer.
    turn.physics.drag(Math.min(corner.x, this.aspect) - this.aspect * 0.08, corner.y - Math.sign(corner.y) * 0.05, performance.now());
  }

  private endPeek(): void {
    const peek = this.peeking;
    if (!peek) return;
    this.renderer.canvas.style.cursor = "";
    this.settleTurn(peek, false);
  }

  private readonly onPointerLeave = (): void => {
    if (!this.pointer) this.endPeek();
  };

  /** A page corner (outer edge, top or bottom) under a client point, with the page-local point; only where a turn can go. */
  private cornerAt(clientX: number, clientY: number): { side: Side; x: number; y: number } | null {
    const a = this.aspect;
    for (const side of this.single ? (["right"] as const) : (["left", "right"] as const)) {
      const target = this.index + (side === "right" ? 1 : -1);
      if (!this.spreads[target] || this.closesBook(target) || this.spreads[this.index]?.[side] === null) continue;
      const p = this.renderer.pageLocal(side, clientX, clientY);
      if (p && p.x > a * 0.82 && p.x < a * 1.02 && Math.abs(p.y) > 0.36 && Math.abs(p.y) < 0.52) return { side, ...p };
    }
    return null;
  }

  private updatePointerTurn(pointer: PointerDrag, x: number, y: number): void {
    const physics = pointer.physics;
    if (!physics) return;
    const p = this.renderer.pageLocal(pointer.foldSide, x, y);
    if (p) physics.drag(p.x + pointer.offsetX, p.y + pointer.offsetY, performance.now());
  }

  private startNavigationTurn(direction: TurnDirection): void {
    if (this.activeTurn) return;
    const side: Side = direction === "forward" ? "right" : "left";
    const targetIndex = this.index + (direction === "forward" ? 1 : -1);
    if (!this.spreads[targetIndex]) return;
    if (this.closesBook(targetIndex)) {
      this.closeBook();
      return;
    }
    // Like a reader's hand: lift the bottom corner and roll the page over.
    const physics = new PageTurnPhysics(this.aspect);
    physics.begin(direction, this.aspect, -0.5, performance.now());
    physics.release(true);
    const turn = this.createTurn(side, targetIndex, physics, true);
    this.activeTurn = turn;
    void turn.ready.then(() => this.runTurnAnimation(turn));
  }

  private createTurn(side: Side, targetIndex: number, physics: PageTurnPhysics, timed = false): ActiveTurn {
    const turn: ActiveTurn = { side, targetIndex, physics, ready: Promise.resolve(), prepared: false, stop: null, timed, peek: false };
    turn.ready = this.prepareTurnBack(turn);
    return turn;
  }

  private async prepareTurnBack(turn: ActiveTurn): Promise<void> {
    const doc = this.doc;
    const source = this.spreads[this.index];
    const target = this.spreads[turn.targetIndex];
    if (!doc || !source || !target) return;
    const frontPage = turn.side === "right" ? source.right : target.right;
    const backPage = turn.side === "right" ? target.left : source.left;
    const underlaySide: Side = turn.side === "right" ? "right" : "left";
    const underlayPage = turn.side === "right" ? target.right : target.left;
    try {
      const [front, back, underlay] = await Promise.all([
        frontPage === null || frontPage > this.readablePages ? null : doc.renderPage(frontPage, this.box),
        backPage === null || backPage > this.readablePages ? null : doc.renderPage(backPage, this.box),
        underlayPage === null || underlayPage > this.readablePages ? null : doc.renderPage(underlayPage, this.box),
      ]);
      if (this.activeTurn !== turn || this.doc !== doc) return;
      this.renderer.setPageImage(underlaySide, underlay?.canvas ?? null);
      // No page under the turning leaf (end of the book): show the bare board now, not blank paper until the turn ends.
      if (underlayPage === null) this.renderer.setPageVisible(underlaySide, false);
      this.renderer.prepareTurn(turn.side, front?.canvas ?? null, back?.canvas ?? null);
      turn.prepared = true;
      if (turn.physics.phase === "dragging") this.renderer.setTurnCurl(turn.side, turn.physics.curl, turn.physics.progress);
    } catch (err) {
      if (isRenderCancelled(err) || this.activeTurn !== turn) return;
      this.emit("error", err instanceof LuxeBookError ? err : new LuxeBookError("PAGE_RENDER_FAILED", String(err), { cause: err }));
    }
  }

  private settleTurn(turn: ActiveTurn | null, forceCommit?: boolean): void {
    if (!turn || this.activeTurn !== turn) return;
    turn.physics.release(forceCommit);
    void turn.ready.then(() => this.runTurnAnimation(turn));
  }

  private runTurnAnimation(turn: ActiveTurn): void {
    if (this.activeTurn !== turn || turn.stop) return;
    if (!turn.prepared) {
      this.cancelActiveTurn();
      return;
    }
    turn.stop = this.renderer.animate((dt) => {
      // More pages queued behind this one (a strong scroll, held key) → turn faster; the last one eases in at normal speed.
      const pending = this.queuedIndex === null ? 0 : Math.abs(this.queuedIndex - turn.targetIndex);
      const speed = Math.min(4, 1 + pending);
      const done = turn.timed ? turn.physics.stepTimed(dt * speed, TURN_SECONDS) : turn.physics.step(dt);
      this.renderer.setTurnCurl(turn.side, turn.physics.curl, turn.physics.progress);
      if (!done) return false;
      turn.stop = null;
      if (this.activeTurn === turn) {
        if (turn.physics.phase === "completed") {
          void this.showSpread(turn.targetIndex, { preserveTurn: turn, skipPreload: true }).then(() => {
            if (this.activeTurn !== turn) return;
            this.activeTurn = null;
            this.renderer.clearTurn();
            this.continueQueuedNavigation();
          });
        } else {
          // Back where it started: keep the leaf (it shows that page) until the
          // page under it is painted again, so nothing flashes on the way.
          this.queuedIndex = null;
          void this.showSpread(this.index, { preserveTurn: turn, skipPreload: true }).then(() => {
            if (this.activeTurn !== turn) return;
            this.activeTurn = null;
            this.renderer.clearTurn();
          });
        }
      }
      return true;
    });
  }

  private requestNavigation(direction: TurnDirection): void {
    if (!this.bookOpen && !this.bookOpening) {
      this.openBook();
      return;
    }
    const peek = this.peeking;
    if (peek) {
      if (peek.side === (direction === "forward" ? "right" : "left")) {
        // That corner is already lifted: carry on from there.
        peek.peek = false;
        peek.timed = true;
        this.renderer.canvas.style.cursor = "";
        this.settleTurn(peek, true);
        return;
      }
      this.cancelActiveTurn();
    }
    const from = this.queuedIndex ?? this.activeTurn?.targetIndex ?? this.index;
    const target = from + (direction === "forward" ? 1 : -1);
    if (target < 0 || target >= this.spreads.length) return;
    if (this.bookOpening) {
      this.queuedIndex = target;
      return;
    }
    if (this.activeTurn) {
      this.queuedIndex = target;
      return;
    }
    this.startNavigationTurn(direction);
  }

  private continueQueuedNavigation(): void {
    const target = this.queuedIndex;
    if (target === null) return;
    if (target === this.index) {
      this.queuedIndex = null;
      return;
    }
    this.startNavigationTurn(target > this.index ? "forward" : "backward");
  }

  private openBook(instant = false, fold?: PageTurnPhysics): void {
    if (this.status !== "ready" || this.bookOpen || this.bookOpening || this.bookClosing) return;
    this.revealStop?.();
    this.revealStop = null;
    this.renderer.setDolly(this.renderer.closedDolly / this.zoomLevelValue);

    // Lay the destination spread under the cover now, so opening reveals it
    // instead of swapping pages once the cover has landed.
    const target = this.openingTargetIndex ?? (this.options.showCover && this.spreads.length > 1 ? 1 : this.index);
    this.openingTargetIndex = null;
    if (this.queuedIndex === target) this.queuedIndex = null;
    if (target !== this.index) void this.showSpread(target);
    this.paintCoverInside(this.spreads[target]?.left ?? null);

    const reduced = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced || instant) {
      this.setOpen(1);
      this.renderer.setDolly(1 / this.zoomLevelValue);
      this.bookOpen = true;
      this.syncBookState();
      this.continueQueuedNavigation();
      return;
    }

    if (this.softCover) {
      this.foldCover(true, fold ?? this.coverPhysics("forward"), !fold, () => undefined);
      return;
    }
    const progress = new Spring(0, { stiffness: 42, damping: 2 * Math.sqrt(42) });
    progress.target = 1;
    const dolly = new Spring(this.renderer.closedDolly / this.zoomLevelValue, { stiffness: 32, damping: 2 * Math.sqrt(32) });
    dolly.target = 1 / this.zoomLevelValue;
    this.openingDolly = dolly;
    this.bookOpening = true;
    this.syncBookState();
    this.openStop = this.renderer.animate((dt) => {
      const progressDone = stepVisible(progress, dt);
      const dollyDone = stepVisible(dolly, dt);
      this.setOpen(progress.value);
      this.renderer.setDolly(dolly.value);
      if (!progressDone || !dollyDone) return false;
      this.openStop = null;
      this.openingDolly = null;
      this.bookOpening = false;
      this.bookOpen = true;
      this.syncBookState();
      this.continueQueuedNavigation();
      return true;
    });
  }

  /** In cover mode the first spread is the closed book, so going back to it shuts the cover. */
  private closesBook(targetIndex: number): boolean {
    return targetIndex === 0 && this.options.showCover && this.bookOpen && this.spreads.length > 1;
  }

  /** Reverse of `openBook`: swing the cover back over the current spread, then settle on the cover. */
  private closeBook(fold?: PageTurnPhysics): void {
    if (!this.bookOpen) return;
    this.queuedIndex = null;
    if (!fold) this.pointer = null; // the gesture that closed the book must not reopen it on release
    this.cancelActiveTurn();
    this.revealStop?.();
    this.revealStop = null;
    this.bookOpen = false;
    this.bookClosing = true;
    this.syncBookState();
    this.paintCoverInside(this.spreads[this.index]?.left ?? null);
    const finish = () => {
      this.openStop = null;
      this.openingDolly = null;
      this.bookClosing = false;
      this.syncBookState();
      void this.showSpread(0);
    };

    const reduced = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      this.setOpen(0);
      this.renderer.setDolly(this.renderer.closedDolly / this.zoomLevelValue);
      finish();
      return;
    }
    if (this.softCover) {
      this.foldCover(false, fold ?? this.coverPhysics("backward"), !fold, finish);
      return;
    }
    const progress = new Spring(1, { stiffness: 42, damping: 2 * Math.sqrt(42) });
    progress.target = 0;
    const dolly = new Spring(1 / this.zoomLevelValue, { stiffness: 32, damping: 2 * Math.sqrt(32) });
    dolly.target = this.renderer.closedDolly / this.zoomLevelValue;
    this.openingDolly = dolly;
    this.openStop = this.renderer.animate((dt) => {
      const progressDone = stepVisible(progress, dt);
      const dollyDone = stepVisible(dolly, dt);
      this.setOpen(progress.value);
      this.renderer.setDolly(dolly.value);
      if (!progressDone || !dollyDone) return false;
      finish();
      return true;
    });
  }

  /**
   * Soft cover: fold it open (or shut) like a page, the book sliding and the
   * camera moving with it. `timed`: a tap or key; otherwise a drag in
   * progress, which may also be dropped back where it started.
   */
  private foldCover(opening: boolean, physics: PageTurnPhysics, timed: boolean, closed: () => void): void {
    const side: Side = opening ? "right" : "left";
    if (opening) {
      this.bookOpening = true;
      this.syncBookState();
    }
    this.openStop = this.renderer.animate((dt) => {
      const done = timed ? physics.stepTimed(dt, TURN_SECONDS) : physics.step(dt);
      const open = opening ? physics.progress : 1 - physics.progress;
      const closedDolly = this.renderer.closedDolly;
      this.setOpen(open);
      this.renderer.setDolly((closedDolly + (1 - closedDolly) * open) / this.zoomLevelValue);
      this.renderer.setCoverFold({ side, curl: physics.curl, progress: physics.progress });
      if (!done) return false;
      this.openStop = null;
      this.renderer.setCoverFold(null);
      const completed = physics.phase === "completed";
      if (opening) {
        this.bookOpening = false;
        this.bookOpen = completed;
        this.syncBookState();
        if (completed) {
          this.continueQueuedNavigation();
        } else {
          this.queuedIndex = null;
          void this.showSpread(0);
        }
      } else if (completed) {
        closed();
      } else {
        // Dropped before it shut: lay it back open.
        this.bookClosing = false;
        this.bookOpen = true;
        this.syncBookState();
      }
      return true;
    });
  }

  /** The cover's inside shows the page that will lie on the left once it lands. */
  private paintCoverInside(page: number | null): void {
    const doc = this.doc;
    this.renderer.setCoverInsideImage(null, page !== null);
    if (!doc || page === null) return;
    doc.renderPage(page, this.box).then(
      (img) => { if (this.doc === doc && !this.bookOpen) this.renderer.setCoverInsideImage(img.canvas); },
      () => undefined, // a failed render surfaces through the static left page
    );
  }

  private cancelActiveTurn(): void {
    const turn = this.activeTurn;
    if (!turn) return;
    this.activeTurn = null;
    turn.stop?.();
    this.renderer.clearTurn();
  }

  private emit<K extends keyof ViewerEvents>(type: K, event: ViewerEvents[K]): void {
    for (const fn of this.listeners.get(type) ?? []) (fn as (e: ViewerEvents[K]) => void)(event);
  }

  private assertAlive(): void {
    if (this.status === "destroyed") throw new LuxeBookError("DESTROYED", "The viewer has been destroyed.");
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * Step a spring, but call it done once the rest of the motion is invisible
 * (a critically damped spring otherwise creeps for seconds toward 1e-4).
 */
function stepVisible(spring: Spring, dt: number): boolean {
  const done = spring.step(dt) || (Math.abs(spring.target - spring.value) < 0.003 && Math.abs(spring.velocity) < 0.05);
  if (done) {
    spring.value = spring.target;
    spring.velocity = 0;
  }
  return done;
}

/** Draw `src` into a page-sized canvas, cropped like CSS object-fit: cover. */
function cropToPage(src: HTMLImageElement, box: RenderBox): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(box.width));
  c.height = Math.max(1, Math.round(box.height));
  const scale = Math.max(c.width / src.naturalWidth, c.height / src.naturalHeight);
  const w = src.naturalWidth * scale;
  const h = src.naturalHeight * scale;
  c.getContext("2d")!.drawImage(src, (c.width - w) / 2, (c.height - h) / 2, w, h);
  return c;
}
