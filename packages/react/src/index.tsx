"use client";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { LuxeBookViewer } from "@vectoad/luxebook-core";
import { APPEARANCE_KEYS, type BookClickEvent, type BookState, type DocumentInfo, type LuxeBookError, type OverlayPage, type PageChangeEvent, type PdfSource, type ViewerOptions } from "@vectoad/luxebook-types";

export { PRESETS } from "@vectoad/luxebook-types";
export type { AppearanceOptions, BookClickEvent, BookCover, BookState, StateLook, LookPreset, PresetName, DocumentInfo, LuxeBookError, OverlayPage, PageChangeEvent, PdfSource, ViewerOptions } from "@vectoad/luxebook-types";

const isAppearanceKey = (k: string) => (APPEARANCE_KEYS as readonly string[]).includes(k);

export interface LuxeBookProps {
  /** PDF URL or bytes. Changing it loads the new document into the same viewer. */
  source: PdfSource;
  width?: number | string;
  height?: number | string;
  /**
   * Viewer config. Appearance options (background, cover, thickness, zoom,
   * rotation…) update live; changing any other option recreates the viewer.
   */
  options?: ViewerOptions;
  className?: string;
  style?: CSSProperties;
  onReady?: (info: DocumentInfo) => void;
  onPageChange?: (event: PageChangeEvent) => void;
  onError?: (error: LuxeBookError) => void;
  /**
   * A tap on the viewer: `e.target` is "page", "cover", "book" or "background".
   * Call `e.preventDefault()` to stop the default action (turning/opening).
   */
  onBookClick?: (event: BookClickEvent) => void;
  /** The book started/finished opening or closing: "opening", "open", "closing", "closed". */
  onBookStateChange?: (state: BookState) => void;
  /** Reading zoom changed (double-click/double-tap a page): 1 when zoomed out. */
  onReadingZoomChange?: (scale: number) => void;
  /**
   * Your own content (a contact form, a video…) laid on a page in
   * perspective. It's live React: state, inputs and handlers all work.
   * Hidden while that page turns or the book is closed.
   */
  overlay?: ReactNode;
  /** Where `overlay` goes: a page number, or `"end"` (the inside of the back cover). Default `"end"`. */
  overlayPage?: OverlayPage;
}

export interface LuxeBookHandle {
  next(): void;
  previous(): void;
  goToPage(page: number): void;
  /** Open the book (animated). */
  open(): void;
  /** Close the book (animated), returning it to its closed look. */
  close(): void;
  /** Reading zoom: `scale`× around a client point (default centre); `zoomTo(1)` zooms out. */
  zoomTo(scale: number, clientX?: number, clientY?: number): void;
  /** The underlying viewer, once created on the client. */
  readonly viewer: LuxeBookViewer | null;
}

/**
 * React 18 adapter. Renders a plain <div> (SSR-safe); the engine, Three.js
 * and PDF.js are imported in an effect, so they only ever load in the
 * browser and are code-split from the host bundle. React never sees
 * animation frames: the viewer owns its render loop.
 */
export const LuxeBook = forwardRef<LuxeBookHandle, LuxeBookProps>(function LuxeBook(
  { source, width = "100%", height = 600, options, className, style, onReady, onPageChange, onError, onBookClick, onBookStateChange, onReadingZoomChange, overlay, overlayPage = "end" },
  ref,
) {
  const container = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<LuxeBookViewer | null>(null);
  const viewerPromise = useRef<Promise<LuxeBookViewer | null> | null>(null);
  const callbacks = useRef({ onReady, onPageChange, onError, onBookClick, onBookStateChange, onReadingZoomChange });
  callbacks.current = { onReady, onPageChange, onError, onBookClick, onBookStateChange, onReadingZoomChange };

  // Options are compared by value so inline object literals don't recreate the viewer.
  const entries = Object.entries(options ?? {});
  const optionsKey = JSON.stringify(Object.fromEntries(entries.filter(([k]) => !isAppearanceKey(k))));
  const appearanceKey = JSON.stringify(Object.fromEntries(entries.filter(([k]) => isAppearanceKey(k))));
  const appearance = useRef(appearanceKey);
  appearance.current = appearanceKey;

  useEffect(() => {
    let alive = true;
    const el = container.current!;
    const created = import("@vectoad/luxebook-core").then(({ LuxeBookViewer }) => {
      if (!alive) return null;
      try {
        const viewer = new LuxeBookViewer(el, { ...JSON.parse(optionsKey), ...JSON.parse(appearance.current) } as ViewerOptions);
        viewer.on("ready", (info) => callbacks.current.onReady?.(info));
        viewer.on("pagechange", (e) => callbacks.current.onPageChange?.(e));
        viewer.on("error", (e) => callbacks.current.onError?.(e));
        viewer.on("click", (e) => callbacks.current.onBookClick?.(e));
        viewer.on("bookstate", (e) => callbacks.current.onBookStateChange?.(e.state));
        viewer.on("readingzoom", (e) => callbacks.current.onReadingZoomChange?.(e.scale));
        viewerRef.current = viewer;
        return viewer;
      } catch (err) {
        callbacks.current.onError?.(err as LuxeBookError);
        return null;
      }
    });
    viewerPromise.current = created;
    return () => {
      alive = false;
      viewerRef.current = null;
      void created.then((v) => v?.destroy());
    };
  }, [optionsKey]);

  useEffect(() => {
    void viewerPromise.current?.then((v) => {
      try {
        v?.setOptions(JSON.parse(appearanceKey));
      } catch (err) {
        callbacks.current.onError?.(err as LuxeBookError);
      }
    });
  }, [appearanceKey]);

  // Created after mount: portals can't render on the server.
  const [overlayHost, setOverlayHost] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const host = document.createElement("div");
    Object.assign(host.style, { width: "100%", height: "100%" });
    setOverlayHost(host);
  }, []);
  const hasOverlay = overlay != null && overlay !== false;
  useEffect(() => {
    void viewerPromise.current?.then((v) => {
      try {
        v?.setOverlay(hasOverlay ? overlayHost : null, { page: overlayPage });
      } catch (err) {
        callbacks.current.onError?.(err as LuxeBookError);
      }
    });
  }, [overlayHost, hasOverlay, overlayPage, optionsKey]);

  useEffect(() => {
    // Errors (other than superseded loads) arrive through the "error" event.
    void viewerPromise.current?.then((v) => v?.load(source).catch(() => undefined));
  }, [source, optionsKey]);

  useImperativeHandle(
    ref,
    () => ({
      next: () => viewerRef.current?.next(),
      previous: () => viewerRef.current?.previous(),
      goToPage: (page: number) => viewerRef.current?.goToPage(page),
      open: () => viewerRef.current?.open(),
      close: () => viewerRef.current?.close(),
      zoomTo: (scale: number, clientX?: number, clientY?: number) => viewerRef.current?.zoomTo(scale, clientX, clientY),
      get viewer() {
        return viewerRef.current;
      },
    }),
    [],
  );

  return (
    <div ref={container} className={className} style={{ position: "relative", width, height, ...style }}>
      {overlayHost && hasOverlay && createPortal(overlay, overlayHost)}
    </div>
  );
});
