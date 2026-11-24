/**
 * Shared public types for LuxeBook. Every package depends on this one;
 * it depends on nothing.
 */

/** Anything PDF.js can open: a URL, or the raw bytes of a PDF. */
export type PdfSource = string | URL | ArrayBuffer | Uint8Array;

/** Page size in PDF points (1/72 in) with the page's /Rotate applied. */
export interface PageSize {
  width: number;
  height: number;
}

export interface DocumentInfo {
  pageCount: number;
  /** Size of page 1. The book's page shape is derived from it. */
  firstPageSize: PageSize;
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  creationDate?: Date;
  modificationDate?: Date;
}

/** A page rendered to a canvas, ready to be uploaded as a GPU texture. */
export interface RenderedPage {
  pageNumber: number;
  canvas: PageCanvas;
  /** Canvas size in device pixels. */
  width: number;
  height: number;
}

export type PageCanvas = HTMLCanvasElement | OffscreenCanvas;

/**
 * A two-page opening. `null` means that side is empty
 * (the right of a front cover, the left of a back cover).
 */
export interface Spread {
  left: number | null;
  right: number | null;
}

/**
 * What the closed front cover shows: PDF page 1, a plain cover in
 * `coverColor`, or an image URL (cropped to the page shape).
 */
export type BookCover = "first-page" | "plain" | { image: string };

/**
 * Look-and-feel options. Pass them to the constructor, or change them live
 * with `viewer.setOptions()` (the React component does this for you).
 */
export interface AppearanceOptions {
  /** Background colour behind the book (CSS colour). Default `#141312`. */
  background?: string;
  /** Background image URL drawn over `background`, covering the stage. Default none. */
  backgroundImage?: string | null;
  /** Background brightness: 0 black, 1 unchanged, 2 twice as bright. Default `1`. */
  backgroundBrightness?: number;
  /** Background blur in CSS pixels. Default `0`. */
  backgroundBlur?: number;
  /** Book shadow strength on the table, 0 (none) to 1. Default `0.5`. */
  shadowStrength?: number;
  /**
   * Light on the book. `"neutral"` keeps page colours exact (white stays
   * white); `"warm"` is a cosy paper-under-a-lamp look; `"cool"` is crisp;
   * `"dramatic"` is a strong spotlight with deep shadows. Default `"neutral"`.
   */
  lighting?: "neutral" | "warm" | "cool" | "dramatic";
  /**
   * Paper finish. `"matte"`: uncoated, no shine. `"silk"`: a soft satin
   * sheen. `"glossy"`: coated magazine stock that catches the light as a
   * page curls. Default `"glossy"`.
   */
  paper?: "matte" | "silk" | "glossy";
  /** Front cover content. Default `"first-page"`. */
  cover?: BookCover;
  /** Colour of the cover boards and spine edge (CSS colour). Default `#24211e`. */
  coverColor?: string;
  /** Paper-stack thickness multiplier. Default `1`. */
  thickness?: number;
  /** Cover board thickness multiplier, on top of `thickness`. Default `1`. */
  coverThickness?: number;
  /**
   * How the front cover opens and closes. `"soft"`: it folds like a page
   * (drag its corner, hover lifts it), a thin paperback cover. `"hard"`: a
   * stiff board that swings on its hinge. Default `"soft"`.
   */
  coverStyle?: "soft" | "hard";
  /**
   * Spine (hinge cover) width, as a multiple of the cover thickness; the
   * cover image wraps over it. `0` shows the bare paper edge. Default `1`.
   */
  spineWidth?: number;
  /** Speed multiplier for page turns, opening and camera moves. Default `1`. */
  turnSpeed?: number;
  /** Zoom level, 0.6 to 2.4. Default `1`. */
  zoom?: number;
  /** Tilt the book towards/away from the reader, in degrees (−60 to 60). Default `0`: seen straight from above. */
  rotateX?: number;
  /** Turn the book left/right, in degrees (−60 to 60). Default `0`. */
  rotateY?: number;
  /** Move the book across the stage: −1 (left edge) to 1 (right edge). Default `0`. */
  offsetX?: number;
  /** Move the book up/down: −1 (bottom) to 1 (top). Default `0`. */
  offsetY?: number;
  /**
   * A different look per book state. Values blend smoothly while the book
   * opens and closes, so e.g. a tilted, off-centre closed book glides to the
   * centre and straightens as it opens, and returns when closed.
   * Unset values fall back to the options above.
   * @example states: { closed: { rotateX: 28, rotateY: -22, offsetX: 0.35, zoom: 0.8 } }
   */
  states?: { closed?: StateLook; open?: StateLook };
  /**
   * `"double"`: two-page spreads. `"single"`: one page at a time, for phones
   * and narrow screens; the spine sits at the left edge and each page flips
   * over it out of view. `"auto"`: single while the viewer is portrait
   * (taller than wide), double otherwise; switches live on resize/rotate.
   * Default `"auto"`.
   */
  layout?: "auto" | "single" | "double";
}

/** The animatable part of the look, set per book state. */
export type StateLook = Pick<AppearanceOptions,
  "rotateX" | "rotateY" | "zoom" | "offsetX" | "offsetY" | "shadowStrength" | "backgroundBrightness" | "backgroundBlur">;

export const STATE_LOOK_KEYS = [
  "rotateX", "rotateY", "zoom", "offsetX", "offsetY", "shadowStrength", "backgroundBrightness", "backgroundBlur",
] as const satisfies readonly (keyof StateLook)[];

/** Where the book is: shut (the initial pose), animating, or open. */
export type BookState = "closed" | "opening" | "open" | "closing";

/** Keys of `AppearanceOptions`: everything `setOptions()` can change live. */
export const APPEARANCE_KEYS = [
  "background", "backgroundImage", "backgroundBrightness", "backgroundBlur", "shadowStrength",
  "cover", "coverColor", "thickness", "turnSpeed", "zoom", "rotateX", "rotateY", "lighting", "paper", "offsetX", "offsetY", "states", "coverThickness", "coverStyle", "spineWidth", "layout",
] as const satisfies readonly (keyof AppearanceOptions)[];

/** The look of a preset: everything except content (cover, background image) and behaviour. */
export type LookPreset = Required<Pick<AppearanceOptions,
  "lighting" | "background" | "backgroundBrightness" | "backgroundBlur" | "shadowStrength" | "coverColor" | "rotateX" | "rotateY">>;

/**
 * Ready-made looks. Spread one into your options and override what you like:
 * `options={{ ...PRESETS.gallery, cover: { image: "/cover.jpg" } }}`
 */
export const PRESETS = {
  /** True colour on a soft dark backdrop. The default look. */
  studio: { lighting: "neutral", background: "#141312", backgroundBrightness: 1, backgroundBlur: 0, shadowStrength: 0.5, coverColor: "#24211e", rotateX: 0, rotateY: 0 },
  /** Bright, airy, true colour: a book on a white gallery table. */
  gallery: { lighting: "neutral", background: "#f3f1ed", backgroundBrightness: 1, backgroundBlur: 0, shadowStrength: 0.28, coverColor: "#2b2b2d", rotateX: 0, rotateY: 0 },
  /** Warm, cosy paper under a reading lamp. */
  classic: { lighting: "warm", background: "#1c1814", backgroundBrightness: 1, backgroundBlur: 0, shadowStrength: 0.55, coverColor: "#4a2f1f", rotateX: 0, rotateY: 0 },
  /** Strong spotlight, deep shadow, slight angle. */
  night: { lighting: "dramatic", background: "#08080a", backgroundBrightness: 1, backgroundBlur: 0, shadowStrength: 0.95, coverColor: "#121214", rotateX: 14, rotateY: -8 },
  /** Cool light on deep electric blue, tilted for depth. */
  electric: { lighting: "cool", background: "#0a1a5c", backgroundBrightness: 1.15, backgroundBlur: 0, shadowStrength: 0.75, coverColor: "#1f4dff", rotateX: 18, rotateY: -14 },
  /** Product-shot angle on a neutral grey. */
  showcase: { lighting: "neutral", background: "#cfccc6", backgroundBrightness: 1, backgroundBlur: 0, shadowStrength: 0.6, coverColor: "#1e1e20", rotateX: 24, rotateY: -20 },
} as const satisfies Record<string, LookPreset>;

export type PresetName = keyof typeof PRESETS;

export interface ViewerOptions extends AppearanceOptions {
  /** Enable the shadow map at all. Default `true`. Use `shadowStrength` to tune it. */
  shadows?: boolean;
  /** Pages before and after the visible spread to pre-render. Default `2`. */
  preloadPages?: number;
  /**
   * Use page 1 as the closed front cover; opening starts at page 2.
   * Default `true` (set `false` to start with page 1 | page 2).
   */
  showCover?: boolean;
  /**
   * Preview mode: the book ends after this page. One blank preview page
   * follows it, and the `"end"` overlay (e.g. a "contact us for the full
   * book" form) sits on that page, in both layouts. Default: the whole PDF.
   */
  lastPage?: number;
  /** Start with the book already open instead of on the closed cover. Default `false`. */
  startOpen?: boolean;
  /** Device pixel ratio cap for the WebGL canvas. Default `2`. */
  maxPixelRatio?: number;
  /**
   * Max page texture height in pixels (clamped to the GPU limit). Default `2048`.
   * Reading zoom (double-click a page) renders up to twice this, for sharp small print.
   */
  maxTextureSize?: number;
  /** Show a quick low-resolution render before the sharp one. Default `true`. */
  progressive?: boolean;
  /**
   * URL of `pdf.worker.min.mjs`. Optional: defaults to a jsDelivr copy pinned
   * to the bundled PDF.js version. Self-host it if your CSP blocks jsDelivr.
   */
  workerSrc?: string;
  /**
   * Base URL (trailing slash) serving pdfjs-dist's `cmaps/`, `standard_fonts/`,
   * `wasm/` and `iccs/` (CJK/Arabic text, non-embedded fonts, JPEG 2000).
   * Optional: defaults to the same pinned jsDelivr copy; fetched only when needed.
   */
  pdfAssetsUrl?: string;
}

/**
 * Where `setOverlay()` puts your HTML: on a page number, or `"end"`, the
 * empty inside of the back cover facing the last page (two-page layout,
 * when the last page sits alone on the left).
 */
export type OverlayPage = number | "end";

export type ViewerStatus = "idle" | "loading" | "ready" | "error" | "destroyed";

export interface ViewerState {
  status: ViewerStatus;
  bookState: BookState;
  pageCount: number;
  spread: Spread;
  /** The layout in use (`"auto"` resolved). In `"single"`, the visible page is `spread.right`. */
  layout: "single" | "double";
}

export interface PageChangeEvent {
  spread: Spread;
  /** The page to show in a "page N of M" label: the lowest visible one (the only one in single layout). */
  page: number;
  pageCount: number;
}

/**
 * A tap/click on the viewer (not a drag). `target` says what was hit:
 * - `"page"`: an open page (`page` is its number)
 * - `"cover"`: the closed book
 * - `"book"`: another part of the book (page edges, boards)
 * - `"background"`: empty space around the book
 *
 * Default actions: page → turn that way, cover → open, book/background → nothing.
 * Call `preventDefault()` to skip the default action and do your own.
 */
export interface BookClickEvent {
  target: "page" | "cover" | "book" | "background";
  /** Page number under the pointer, when known. */
  page: number | null;
  side: "left" | "right" | null;
  originalEvent: PointerEvent;
  readonly defaultPrevented: boolean;
  preventDefault(): void;
}

export interface ViewerEvents {
  ready: DocumentInfo;
  pagechange: PageChangeEvent;
  error: LuxeBookError;
  click: BookClickEvent;
  /** The book started/finished opening or closing. */
  bookstate: { state: BookState };
  /**
   * Reading zoom changed: `scale` is 1 when zoomed out. Double-click/double-tap
   * a page (or `zoomTo()`) zooms in at that spot; drag or scroll to pan.
   */
  readingzoom: { scale: number };
}

export type LuxeBookErrorCode =
  | "DOCUMENT_LOAD_FAILED"
  | "PASSWORD_REQUIRED"
  | "PAGE_RENDER_FAILED"
  | "WEBGL_UNAVAILABLE"
  | "INVALID_ARGUMENT"
  | "DESTROYED"
  | "ABORTED";

export class LuxeBookError extends Error {
  override readonly name = "LuxeBookError";
  constructor(
    readonly code: LuxeBookErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}
