import Head from "next/head";
import { useMemo, useRef, useState } from "react";
import { LuxeBook, type LuxeBookHandle, type PageChangeEvent, type ViewerOptions } from "@vectoad/luxebook-react";

const DOCUMENTS = { brochure: "/brochure.pdf", multipage: "/multipage.pdf" } as const;

export default function Home() {
  const book = useRef<LuxeBookHandle>(null);
  const [doc, setDoc] = useState<keyof typeof DOCUMENTS>("brochure");
  const [page, setPage] = useState<PageChangeEvent | null>(null);
  const [status, setStatus] = useState("Loading…");
  // Stable reference isn't required (options compare by value), but it's good practice.
  // Appearance options (cover, background, zoom, rotation…) can change at any
  // time and update live; paste the playground's "Config" box in here.
  const options = useMemo<ViewerOptions>(
    () => ({
      // No workerSrc / pdfAssetsUrl needed: PDF.js loads from a pinned CDN copy.
      // Self-host only if your CSP blocks cdn.jsdelivr.net.
      preloadPages: 2,
      startOpen: false,
      cover: "first-page", // or "plain", or { image: "/cover.jpg" }
      coverColor: "#24211e",
      background: "#141312",
      backgroundBrightness: 1,
      backgroundBlur: 0,
      shadowStrength: 0.5,
      thickness: 1,
      turnSpeed: 1,
      zoom: 1,
      rotateX: 0,
      rotateY: 0,
    }),
    [],
  );

  return (
    <>
      <Head>
        <title>LuxeBook · Next.js 13 Pages Router</title>
      </Head>
      <main style={{ display: "grid", gridTemplateRows: "auto 1fr auto", height: "100vh" }}>
        <header style={bar}>
          <strong style={{ letterSpacing: "0.18em", fontWeight: 400 }}>LUXEBOOK</strong>
          <select aria-label="Document" value={doc} onChange={(e) => setDoc(e.target.value as keyof typeof DOCUMENTS)} style={control}>
            <option value="brochure">Brochure</option>
            <option value="multipage">Multi-page</option>
          </select>
          <span id="status" style={{ color: "#8a847a" }}>{status}</span>
        </header>
        <LuxeBook
          ref={book}
          source={DOCUMENTS[doc]}
          height="100%"
          options={options}
          onReady={(info) => {
            setStatus(info.title ?? "Ready");
            setPage({ page: 1, pageCount: info.pageCount, spread: { left: 1, right: 2 } });
          }}
          onPageChange={setPage}
          onError={(err) => setStatus(`Error: ${err.message}`)}
        />
        <footer style={{ ...bar, justifyContent: "center" }}>
          <button aria-label="Previous page" onClick={() => book.current?.previous()} style={control}>‹</button>
          <span id="page-label" style={{ minWidth: 100, textAlign: "center" }}>
            {page ? `${page.page} / ${page.pageCount}` : "–"}
          </span>
          <button aria-label="Next page" onClick={() => book.current?.next()} style={control}>›</button>
        </footer>
      </main>
    </>
  );
}

const bar = { display: "flex", alignItems: "center", gap: 16, padding: "12px 20px" } as const;
const control = { background: "transparent", color: "inherit", border: "1px solid rgba(233,227,216,.2)", padding: "6px 12px", cursor: "pointer" } as const;
