import workerSrc from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { LuxeBookViewer, PRESETS, type AppearanceOptions, type PdfSource, type PresetName, type StateLook, type ViewerOptions } from "@vectoad/luxebook-core";

declare const __PDFJS_ASSETS__: string;
const fixtures = import.meta.glob("../../../fixtures/*.pdf", { query: "?url", import: "default", eager: true }) as Record<string, string>;
const fixtureUrl = (name: string) => fixtures[`../../../fixtures/${name}`]!;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $("stage");
const message = $<HTMLParagraphElement>("message");
const label = $("page-label");
const prev = $<HTMLButtonElement>("prev");
const next = $<HTMLButtonElement>("next");

const params = new URLSearchParams(location.search);

// --- settings: the same shape a site passes as `options` -------------------
const DEFAULTS: Required<Omit<AppearanceOptions, "backgroundImage">> & Pick<ViewerOptions, "startOpen" | "backgroundImage"> = {
  cover: "first-page",
  coverColor: "#24211e",
  thickness: 1,
  startOpen: false,
  background: "#141312",
  backgroundImage: null,
  backgroundBrightness: 1,
  backgroundBlur: 0,
  shadowStrength: 0.5,
  turnSpeed: 1,
  zoom: 1,
  rotateX: 0,
  rotateY: 0,
  lighting: "neutral",
  paper: (params.get("paper") as AppearanceOptions["paper"]) ?? "glossy",
  offsetX: 0,
  offsetY: 0,
  states: {},
  coverThickness: 1,
  coverStyle: (params.get("coverStyle") as AppearanceOptions["coverStyle"]) ?? "soft",
  spineWidth: 1,
  layout: (params.get("layout") as AppearanceOptions["layout"]) ?? "auto",
};
/** A product-shot pose to start from when "Different look while closed" is ticked. */
const SHOWCASE_POSE: StateLook = { rotateX: 28, rotateY: -24, zoom: 0.85, offsetX: 0.3, offsetY: 0 };
const CLOSED_SLIDERS = ["rotateX", "rotateY", "zoom", "offsetX", "offsetY"] as const;
let settings = { ...DEFAULTS };
let coverImageUrl: string | null = null;
const SLIDERS = ["thickness", "coverThickness", "spineWidth", "backgroundBrightness", "backgroundBlur", "shadowStrength", "turnSpeed", "zoom", "rotateX", "rotateY", "offsetX", "offsetY"] as const;
const UNITS: Partial<Record<string, string>> = { backgroundBlur: "px", rotateX: "°", rotateY: "°", zoom: "×", turnSpeed: "×", thickness: "×", coverThickness: "×", spineWidth: "×" };

// --- viewer ----------------------------------------------------------------
let source: PdfSource = params.get("src") ?? fixtureUrl(params.get("pdf") ?? "brochure.pdf");
let viewer: LuxeBookViewer;

function createViewer() {
  viewer?.destroy();
  viewer = new LuxeBookViewer(stage, {
    workerSrc,
    pdfAssetsUrl: __PDFJS_ASSETS__,
    showCover: params.get("cover") !== "0",
    ...(params.get("lastPage") && { lastPage: Number(params.get("lastPage")) }), // preview mode: ?lastPage=4
    shadows: params.get("shadows") !== "0",
    ...settings,
  });
  if (params.get("form") !== "0") viewer.setOverlay(contactForm());
  // Exposed for Playwright and console experiments.
  Object.assign(window, { __luxebook: viewer });
  viewer.on("ready", (info) => {
    show("");
    $("doc-title").textContent = info.title ?? "";
  });
  viewer.on("pagechange", () => updateNav());
  viewer.on("bookstate", ({ state }) => {
    $("click-info").textContent = `Book: ${state}`;
    updateNav();
  });
  viewer.on("error", (err) => show(err.message, true));
  viewer.on("readingzoom", ({ scale }) => {
    $("click-info").textContent = scale > 1 ? `Reading zoom ${scale.toFixed(1)}× · drag to move · double-click or Esc to zoom out` : "Double-click a page to read up close";
  });
  // Example of overriding clicks: tapping the empty background closes the
  // settings sheet when it overlays the book (narrow screens).
  viewer.on("click", (e) => {
    $("click-info").textContent = `Clicked: ${e.target}${e.page ? ` · page ${e.page}` : ""}${e.side ? ` · ${e.side}` : ""}`;
    if (e.target === "background" && matchMedia("(max-width: 800px)").matches) setPanel(false);
  });
}

/** Demo overlay: a contact form on the inside of the back cover (?form=0 turns it off). */
function contactForm(): HTMLElement {
  const form = document.createElement("form");
  form.className = "back-form";
  form.innerHTML = `
    <h3>Request a viewing</h3>
    <input name="name" placeholder="Name" required>
    <input name="email" type="email" placeholder="Email" required>
    <textarea name="message" rows="3" placeholder="Message"></textarea>
    <button>Send</button>`;
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    form.innerHTML = "<h3>Thank you, we'll be in touch.</h3>";
  });
  return form;
}

const show = (text: string, isError = false) => {
  message.textContent = text;
  message.hidden = !text;
  message.classList.toggle("error", isError);
};

function updateNav() {
  const { spread, pageCount, status, layout } = viewer.state;
  const pages = (layout === "single" ? [spread.right] : [spread.left, spread.right]).filter((p) => p !== null);
  label.textContent = status === "ready" ? `${pages.join("–")} / ${pageCount}` : "–";
  prev.disabled = status !== "ready" || pages.includes(1);
  next.disabled = status !== "ready" || pages.includes(pageCount);
}

async function open(src: PdfSource) {
  source = src;
  show("Loading…");
  try {
    await viewer.load(src);
  } catch {
    // reported through the "error" event
  }
  updateNav();
}

/** Apply `patch`: live through setOptions, or rebuild the viewer for startOpen. */
function update(patch: Partial<typeof settings>) {
  settings = { ...settings, ...patch };
  if ("startOpen" in patch) {
    createViewer();
    void open(source);
  } else {
    viewer.setOptions(settings);
  }
  syncPanel();
}

// --- panel -----------------------------------------------------------------
const presetButtons = Object.keys(PRESETS).map((name) => {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.value = name;
  btn.textContent = name[0]!.toUpperCase() + name.slice(1);
  btn.onclick = () => update({ ...PRESETS[name as PresetName] });
  return btn;
});
$("presets").append(...presetButtons);
$<HTMLSelectElement>("lighting").onchange = (e) => update({ lighting: (e.target as HTMLSelectElement).value as AppearanceOptions["lighting"] });

$<HTMLInputElement>("showcase").onchange = (e) =>
  update({ states: (e.target as HTMLInputElement).checked ? { closed: { ...SHOWCASE_POSE } } : {} });
for (const key of CLOSED_SLIDERS) {
  $<HTMLInputElement>(`closed-${key}`).oninput = (e) =>
    update({ states: { ...settings.states, closed: { ...settings.states.closed, [key]: Number((e.target as HTMLInputElement).value) } } });
}
$<HTMLSelectElement>("paper").onchange = (e) => update({ paper: (e.target as HTMLSelectElement).value as AppearanceOptions["paper"] });
$<HTMLSelectElement>("coverStyle").onchange = (e) => update({ coverStyle: (e.target as HTMLSelectElement).value as AppearanceOptions["coverStyle"] });
$<HTMLSelectElement>("layout").onchange = (e) => update({ layout: (e.target as HTMLSelectElement).value as AppearanceOptions["layout"] });
$("open-book").onclick = () => viewer.open();
$("close-book").onclick = () => viewer.close();

function syncPanel() {
  for (const key of SLIDERS) {
    const input = $<HTMLInputElement>(key);
    input.value = String(settings[key]);
    document.querySelector(`output[for="${key}"]`)?.replaceChildren(`${settings[key]}${UNITS[key] ?? ""}`);
  }
  $<HTMLSelectElement>("lighting").value = settings.lighting;
  $<HTMLSelectElement>("layout").value = settings.layout;
  $<HTMLSelectElement>("coverStyle").value = settings.coverStyle;
  $<HTMLSelectElement>("paper").value = settings.paper;
  const closed = settings.states.closed;
  $<HTMLInputElement>("showcase").checked = !!closed;
  $<HTMLFieldSetElement>("closed-look").disabled = !closed;
  for (const key of CLOSED_SLIDERS) {
    const value = closed?.[key] ?? settings[key];
    $<HTMLInputElement>(`closed-${key}`).value = String(value);
    document.querySelector(`output[for="closed-${key}"]`)?.replaceChildren(`${value}${UNITS[key] ?? ""}`);
  }
  for (const btn of presetButtons) {
    const look = PRESETS[btn.value as PresetName];
    const active = Object.entries(look).every(([k, v]) => settings[k as keyof typeof settings] === v);
    btn.setAttribute("aria-pressed", String(active));
  }
  $<HTMLInputElement>("coverColor").value = settings.coverColor;
  $<HTMLInputElement>("background").value = settings.background;
  $<HTMLInputElement>("startOpen").checked = settings.startOpen ?? false;
  const mode = typeof settings.cover === "object" ? "image" : settings.cover;
  document.querySelector<HTMLInputElement>(`input[name=cover][value="${mode}"]`)!.checked = true;
  $("bg-clear").hidden = !settings.backgroundImage;
  // Only what differs from the library defaults: that's all a site needs to pass.
  const diff = Object.fromEntries(Object.entries(settings).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(DEFAULTS[k as keyof typeof DEFAULTS])));
  $("config").textContent = JSON.stringify(diff, null, 2);
}

for (const key of SLIDERS) $<HTMLInputElement>(key).oninput = (e) => update({ [key]: Number((e.target as HTMLInputElement).value) });
$<HTMLInputElement>("coverColor").oninput = (e) => update({ coverColor: (e.target as HTMLInputElement).value });
$<HTMLInputElement>("background").oninput = (e) => update({ background: (e.target as HTMLInputElement).value });
$<HTMLInputElement>("startOpen").onchange = (e) => update({ startOpen: (e.target as HTMLInputElement).checked });

const coverFile = $<HTMLInputElement>("cover-file");
for (const radio of document.querySelectorAll<HTMLInputElement>("input[name=cover]")) {
  radio.onchange = () => {
    if (radio.value !== "image") return update({ cover: radio.value as "first-page" | "plain" });
    if (coverImageUrl) return update({ cover: { image: coverImageUrl } });
    syncPanel(); // nothing uploaded yet: keep the old choice and ask for an image
    coverFile.click();
  };
}

/** Read a picked file as a blob: URL, freeing the previous one. */
function pickFile(input: HTMLInputElement, previous: string | null, use: (url: string) => void) {
  input.onchange = () => {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    if (previous) URL.revokeObjectURL(previous);
    use((previous = URL.createObjectURL(file)));
  };
}
pickFile(coverFile, null, (url) => {
  coverImageUrl = url;
  update({ cover: { image: url } });
  viewer.goToPage(1); // the cover only shows while the book is closed
});
pickFile($("bg-file"), null, (url) => update({ backgroundImage: url }));
$("bg-clear").onclick = () => update({ backgroundImage: null });
$("reset").onclick = () => update({ ...DEFAULTS, startOpen: settings.startOpen });

$<HTMLInputElement>("pdf-file").onchange = async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (file) await open(await file.arrayBuffer());
};
stage.ondragover = (e) => { e.preventDefault(); stage.classList.add("dragging"); };
stage.ondragleave = () => stage.classList.remove("dragging");
stage.ondrop = async (e) => {
  e.preventDefault();
  stage.classList.remove("dragging");
  const file = e.dataTransfer?.files[0];
  if (file?.type === "application/pdf") await open(await file.arrayBuffer());
};

$("copy").onclick = async () => {
  await navigator.clipboard.writeText($("config").textContent ?? "");
  $("copy").textContent = "Copied";
  setTimeout(() => ($("copy").textContent = "Copy"), 1200);
};

const panelToggle = $<HTMLButtonElement>("panel-toggle");
const setPanel = (openPanel: boolean) => {
  document.body.classList.toggle("panel-closed", !openPanel);
  panelToggle.setAttribute("aria-expanded", String(openPanel));
};
setPanel(!matchMedia("(max-width: 800px)").matches);
panelToggle.onclick = () => setPanel(document.body.classList.contains("panel-closed"));

prev.onclick = () => viewer.previous();
next.onclick = () => viewer.next();
addEventListener("keydown", (e) => {
  if ((e.target as HTMLElement).matches("input, select, textarea")) return;
  if (e.key === "ArrowRight") viewer.next();
  if (e.key === "ArrowLeft") viewer.previous();
  if (e.key === "Escape") viewer.zoomTo(1);
});

createViewer();
syncPanel();
void open(source);
// Exposed for e2e: recover from an error by loading a fixture.
Object.assign(window, { __open: (name: string) => open(fixtureUrl(name)) });
