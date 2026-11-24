import { expect, test, type Page } from "@playwright/test";

// Colours of multipage.pdf's bands, from scripts/generate-fixtures.mjs.
const PAGE_COLORS = [
  [0.8, 0.2, 0.2], [0.2, 0.55, 0.25], [0.15, 0.3, 0.75], [0.85, 0.6, 0.1],
  [0.55, 0.2, 0.65], [0.1, 0.6, 0.65], [0.7, 0.35, 0.15], [0.35, 0.35, 0.35],
];

declare global {
  interface Window {
    __luxebook: import("@vectoad/luxebook-core").LuxeBookViewer;
  }
}

const ready = (page: Page) =>
  page.waitForFunction(() => window.__luxebook?.state.status === "ready", null, { timeout: 20_000 });

/** Render the WebGL canvas and read one pixel at fractional coordinates. */
async function sample(page: Page, fx: number, fy: number): Promise<number[]> {
  return page.evaluate(
    ([fx, fy]) => {
      const gl = window.__luxebook.snapshot();
      const c = document.createElement("canvas");
      c.width = gl.width;
      c.height = gl.height;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(gl, 0, 0);
      return Array.from(ctx.getImageData(Math.round(gl.width * fx!), Math.round(gl.height * fy!), 1, 1).data.slice(0, 3));
    },
    [fx, fy],
  );
}

/** Which fixture page's colour band does this pixel come from? (cosine similarity, lighting-invariant) */
function pageOf(rgb: number[]): number {
  const norm = (v: number[]) => Math.hypot(...v);
  let best = 0;
  let bestSim = -1;
  PAGE_COLORS.forEach((c, i) => {
    const sim = (c[0]! * rgb[0]! + c[1]! * rgb[1]! + c[2]! * rgb[2]!) / (norm(c) * norm(rgb));
    if (sim > bestSim) [best, bestSim] = [i + 1, sim];
  });
  return best;
}

/** Fixture page numbers visible on the left and right. Textures stream in, so poll this. */
async function visiblePages(page: Page) {
  // Sample above the centred page numerals (y 0.5 hits the digit itself).
  return [pageOf(await sample(page, 0.3, 0.3)), pageOf(await sample(page, 0.7, 0.3))];
}

async function imageSignature(page: Page): Promise<string> {
  return page.evaluate(() => {
    const source = window.__luxebook.snapshot();
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const context = canvas.getContext("2d")!;
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    return Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data).join(",");
  });
}

test.describe("PDF → texture → 3D book", () => {
  test("loads a real PDF and shows its first spread", async ({ page }) => {
    await page.goto("/?pdf=brochure.pdf&cover=0");
    await ready(page);
    await expect(page.locator("#doc-title")).toHaveText("The Headland — Sample Brochure");
    await expect(page.locator("#page-label")).toHaveText("1–2 / 6");
    const state = await page.evaluate(() => window.__luxebook.state);
    expect(state).toMatchObject({ status: "ready", pageCount: 6, spread: { left: 1, right: 2 } });
    await expect(page.locator("#stage canvas")).toHaveCount(1);
  });

  test("each side shows the correct PDF page content", async ({ page }) => {
    await page.goto("/?pdf=multipage.pdf&cover=0");
    await ready(page);
    await expect.poll(() => visiblePages(page)).toEqual([1, 2]);
  });

  test("navigates with buttons and keyboard and updates the textures", async ({ page }) => {
    await page.goto("/?pdf=multipage.pdf&cover=0");
    await ready(page);
    await page.click("#next");
    await expect(page.locator("#page-label")).toHaveText("3–4 / 8");
    await expect.poll(() => visiblePages(page)).toEqual([3, 4]);

    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("#page-label")).toHaveText("7–8 / 8");
    await expect(page.locator("#next")).toBeDisabled();
    await expect.poll(() => visiblePages(page)).toEqual([7, 8]);

    await page.keyboard.press("ArrowLeft");
    await expect(page.locator("#page-label")).toHaveText("5–6 / 8");
    await expect.poll(() => visiblePages(page)).toEqual([5, 6]);
  });

  test("goToPage jumps to the spread containing the page", async ({ page }) => {
    await page.goto("/?pdf=multipage.pdf&cover=0");
    await ready(page);
    await page.evaluate(() => window.__luxebook.goToPage(6));
    await expect(page.locator("#page-label")).toHaveText("5–6 / 8");
  });

  test("click on a half turns the page that way", async ({ page }) => {
    await page.goto("/?pdf=multipage.pdf&cover=0");
    await ready(page);
    const box = (await page.locator("#stage canvas").boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.8, box.y + box.height / 2);
    await expect(page.locator("#page-label")).toHaveText("3–4 / 8");
    await page.mouse.click(box.x + box.width * 0.2, box.y + box.height / 2);
    await expect(page.locator("#page-label")).toHaveText("1–2 / 8");
  });

  test("mouse wheel: down flips forward, up flips back, a strong scroll flips several", async ({ page }) => {
    await page.goto("/?pdf=multipage.pdf&cover=0");
    await ready(page);
    // Synthetic events in one go, so their timestamps form one gesture however slow the renderer is.
    const scroll = (deltas: number[]) =>
      page.evaluate((ds) => {
        const canvas = document.querySelector("#stage canvas")!;
        for (const deltaY of ds) canvas.dispatchEvent(new WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true }));
      }, deltas);
    await scroll([20, 20]); // a nudge: nothing
    await page.waitForTimeout(400);
    await expect(page.locator("#page-label")).toHaveText("1–2 / 8");
    await scroll([30, 30, 30, 30, 30, 30, 30, 30]); // gentle: one page
    await expect(page.locator("#page-label")).toHaveText("3–4 / 8");
    await page.waitForTimeout(400);
    await scroll([-80]);
    await expect(page.locator("#page-label")).toHaveText("1–2 / 8");
    await page.waitForTimeout(400);
    await scroll([100, 500, 500, 10]); // strong: three pages
    await expect(page.locator("#page-label")).toHaveText("7–8 / 8");
  });

  test("touch swipe turns pages", async ({ page }) => {
    await page.goto("/?pdf=multipage.pdf&cover=0");
    await ready(page);
    const swipe = (fromX: number, toX: number) =>
      page.evaluate(
        ([fromX, toX]) => {
          const c = document.querySelector("#stage canvas")!;
          const r = c.getBoundingClientRect();
          const y = r.top + r.height / 2;
          const ev = (type: string, x: number) =>
            new PointerEvent(type, { pointerId: 7, pointerType: "touch", isPrimary: true, button: 0, clientX: r.left + r.width * x, clientY: y, bubbles: true });
          c.dispatchEvent(ev("pointerdown", fromX!));
          c.dispatchEvent(ev("pointerup", toX!));
        },
        [fromX, toX],
      );
    await swipe(0.7, 0.3);
    await expect(page.locator("#page-label")).toHaveText("3–4 / 8");
    await swipe(0.3, 0.7);
    await expect(page.locator("#page-label")).toHaveText("1–2 / 8");
  });

  test("dragging a page deforms it before release completes the turn", async ({ page }) => {
    await page.goto("/?pdf=multipage.pdf&cover=0");
    await ready(page);
    await expect.poll(() => visiblePages(page)).toEqual([1, 2]);
    await page.waitForTimeout(800);
    const canvas = page.locator("#stage canvas");
    const box = (await canvas.boundingBox())!;
    const x = box.x + box.width * 0.86;
    const y = box.y + box.height * 0.5;
    const flat = await imageSignature(page);

    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.52, y, { steps: 6 });
    const curled = await imageSignature(page);
    expect(curled).not.toBe(flat);
    await expect(page.locator("#page-label")).toHaveText("1–2 / 8");

    await page.mouse.up();
    await expect(page.locator("#page-label")).toHaveText("3–4 / 8");
    await expect.poll(() => visiblePages(page)).toEqual([3, 4]);
  });

  test("dragging a corner folds the page under the pointer, uncovering the next page diagonally", async ({ page }) => {
    await page.goto("/?pdf=multipage.pdf&cover=0");
    await ready(page);
    await expect.poll(() => visiblePages(page)).toEqual([1, 2]);
    await page.waitForTimeout(300);
    const box = (await page.locator("#stage canvas").boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.9);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.6, { steps: 10 });
    // Bottom corner folded back: page 4 shows there; the top of page 2 hasn't moved.
    await expect.poll(async () => pageOf(await sample(page, 0.82, 0.78))).toBe(4);
    expect(pageOf(await sample(page, 0.82, 0.25))).toBe(2);
    await page.mouse.move(box.x + box.width * 0.88, box.y + box.height * 0.88, { steps: 5 });
    await page.mouse.up(); // barely moved: lays back down
    await expect.poll(() => visiblePages(page)).toEqual([1, 2]);
  });

  test("cover mode shows page 1 alone on the right", async ({ page }) => {
    await page.goto("/?pdf=multipage.pdf&cover=1");
    await ready(page);
    await expect(page.locator("#page-label")).toHaveText("1 / 8");
    await expect.poll(async () => pageOf(await sample(page, 0.5, 0.5))).toBe(1);
  });

  test("loads documents with mixed page sizes", async ({ page }) => {
    await page.goto("/?pdf=mixed-sizes.pdf");
    await ready(page);
    expect(await page.evaluate(() => window.__luxebook.state.pageCount)).toBe(3);
  });

  test("reports load errors without crashing", async ({ page }) => {
    await page.goto("/?src=/does-not-exist.pdf");
    await page.waitForFunction(() => window.__luxebook?.state.status === "error");
    await expect(page.locator("#message")).toContainText("Could not load PDF");
    // The viewer recovers when given a valid document.
    await page.evaluate(() => (window as any).__open("small.pdf"));
    await ready(page);
    await expect(page.locator("#page-label")).toHaveText("1 / 1");
  });

  test("destroy releases the canvas and rejects further use", async ({ page }) => {
    await page.goto("/?pdf=small.pdf");
    await ready(page);
    const code = await page.evaluate(async () => {
      window.__luxebook.destroy();
      try {
        await window.__luxebook.load("/x.pdf");
        return "no error";
      } catch (e) {
        return (e as { code: string }).code;
      }
    });
    expect(code).toBe("DESTROYED");
    await expect(page.locator("#stage canvas")).toHaveCount(0);
  });
});

test("cover option: image, plain and first page", async ({ page }) => {
  await page.goto("/?pdf=multipage.pdf");
  await ready(page);
  const firstPage = await sample(page, 0.6, 0.5);
  const setCover = (cover: unknown) =>
    page.evaluate(async (cover) => {
      window.__luxebook.setOptions({ cover: cover as never });
      await new Promise((r) => setTimeout(r, 300)); // image decode
    }, cover);
  const green = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = c.height = 10;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#00ff00";
    ctx.fillRect(0, 0, 10, 10);
    return c.toDataURL();
  });
  await setCover({ image: green });
  const [r, g, b] = await sample(page, 0.6, 0.5);
  expect(g!).toBeGreaterThan(r! * 2);
  expect(g!).toBeGreaterThan(b! * 2);
  await setCover("plain");
  expect(await sample(page, 0.6, 0.5)).not.toEqual(firstPage);
  await setCover("first-page");
  // Back to the same image (within a step of rounding: the paper sheen is lit).
  const again = await sample(page, 0.6, 0.5);
  again.forEach((v, i) => expect(Math.abs(v - firstPage[i]!)).toBeLessThanOrEqual(2));
});

test("startOpen opens the book straight away; bad options are rejected", async ({ page }) => {
  await page.goto("/?pdf=multipage.pdf");
  await ready(page);
  await page.check("#startOpen");
  await ready(page);
  await expect(page.locator("#page-label")).toHaveText("2–3 / 8");
  const error = await page.evaluate(() => {
    try {
      window.__luxebook.setOptions({ zoom: 99 });
      return "no error";
    } catch (e) {
      return (e as Error).message;
    }
  });
  expect(error).toContain("zoom");
});

test("neutral lighting keeps a white page white; warm tints it", async ({ page }) => {
  await page.goto("/?pdf=white.pdf");
  await ready(page);
  await page.click("#next");
  await page.waitForTimeout(1500);
  const [r, g, b] = await sample(page, 0.3, 0.4);
  expect(Math.min(r!, g!, b!)).toBeGreaterThanOrEqual(248);
  expect(Math.max(r!, g!, b!) - Math.min(r!, g!, b!)).toBeLessThanOrEqual(2);
  await page.evaluate(() => window.__luxebook.setOptions({ lighting: "warm" }));
  const [wr, , wb] = await sample(page, 0.3, 0.4);
  expect(wr! - wb!).toBeGreaterThan(8);
});

test("clicks report their target; background does nothing; preventDefault stops a turn", async ({ page }) => {
  await page.goto("/?pdf=multipage.pdf");
  await ready(page);
  await page.evaluate(() => {
    (window as any).__clicks = [];
    window.__luxebook.on("click", (e) => (window as any).__clicks.push([e.target, e.page, e.side]));
  });
  const box = (await page.locator("#stage canvas").boundingBox())!;
  const clicks = () => page.evaluate(() => (window as any).__clicks.splice(0));
  const rightPage = () => page.mouse.click(box.x + box.width * 0.62, box.y + box.height / 2);
  // Empty background while closed: reported, book stays shut.
  await page.mouse.click(box.x + 8, box.y + 8);
  expect(await clicks()).toEqual([["background", null, null]]);
  await page.waitForTimeout(300);
  await expect(page.locator("#page-label")).toHaveText("1 / 8");
  // The closed cover opens the book.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  expect((await clicks())[0]?.slice(0, 2)).toEqual(["cover", 1]);
  await expect(page.locator("#page-label")).toHaveText("2–3 / 8");
  await page.waitForTimeout(1500);
  // Background when open: nothing turns.
  await page.mouse.click(box.x + 8, box.y + 8);
  expect(await clicks()).toEqual([["background", null, null]]);
  await expect(page.locator("#page-label")).toHaveText("2–3 / 8");
  // Right page: reported with its number, then turns forward.
  await rightPage();
  expect(await clicks()).toEqual([["page", 3, "right"]]);
  await expect(page.locator("#page-label")).toHaveText("4–5 / 8");
  await page.waitForTimeout(1200);
  // preventDefault: reported, but no turn.
  await page.evaluate(() => window.__luxebook.on("click", (e) => e.preventDefault()));
  await rightPage();
  expect(await clicks()).toEqual([["page", 5, "right"]]);
  await page.waitForTimeout(800);
  await expect(page.locator("#page-label")).toHaveText("4–5 / 8");
});

test("book states: events, open()/close(), and the closed look returns after closing", async ({ page }) => {
  await page.goto("/?pdf=multipage.pdf");
  await ready(page);
  const states = await page.evaluate(async () => {
    const v = window.__luxebook;
    const seen: string[] = [];
    v.on("bookstate", (e) => seen.push(e.state));
    v.setOptions({ states: { closed: { rotateY: -30, offsetX: 0.4 } } });
    const wait = (s: string) => new Promise<void>((r) => { const off = v.on("bookstate", (e) => e.state === s && (off(), r())); });
    v.open();
    await wait("open");
    v.close();
    await wait("closed");
    return { seen, final: v.state.bookState };
  });
  expect(states).toEqual({ seen: ["opening", "open", "closing", "closed"], final: "closed" });
  await expect(page.evaluate(() => window.__luxebook.setOptions({ states: { closed: { offsetX: 5 } } }))).rejects.toThrow(/offsetX/);
});

test("playground panel: presets apply without duplicating controls", async ({ page }) => {
  await page.goto("/?pdf=small.pdf");
  await ready(page);
  for (const name of ["Gallery", "Night", "Studio"]) await page.click(`#presets button:has-text("${name}")`);
  await page.selectOption("#lighting", "warm");
  await expect(page.locator("#presets button")).toHaveCount(6);
  await expect(page.locator('#presets button[aria-pressed="true"]')).toHaveCount(0); // warm ≠ Studio's neutral
  await page.selectOption("#lighting", "neutral");
  await expect(page.locator('#presets button[aria-pressed="true"]')).toHaveText("Studio");
});

test("reading zoom: double-click zooms in at the spot, drag pans, navigation zooms out", async ({ page }) => {
  await page.goto("/?pdf=multipage.pdf&cover=0");
  await ready(page);
  await page.evaluate(() => window.__luxebook.open());
  await page.waitForFunction(() => window.__luxebook.bookState === "open");
  const box = (await page.locator("#stage canvas").boundingBox())!;
  const at = (fx: number) => [box.x + box.width * fx, box.y + box.height / 2] as const;
  const zoom = () => page.evaluate(() => window.__luxebook.readingZoom);

  // Double-click: zooms in and does not turn.
  await page.mouse.dblclick(...at(0.7));
  await expect.poll(zoom).toBe(2.5);
  await page.waitForTimeout(600);
  await expect(page.locator("#page-label")).toHaveText("1–2 / 8");

  // Drag pans the view; a single click while zoomed does nothing.
  const before = await imageSignature(page);
  await page.mouse.move(...at(0.5));
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5 - 200, box.y + box.height / 2 - 100, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => imageSignature(page)).not.toBe(before);
  await page.mouse.click(...at(0.8));
  await page.waitForTimeout(500);
  await expect(page.locator("#page-label")).toHaveText("1–2 / 8");

  // Double-click zooms out; Esc does too.
  await page.mouse.dblclick(...at(0.6));
  await expect.poll(zoom).toBe(1);
  await page.mouse.dblclick(...at(0.3));
  await expect.poll(zoom).toBe(2.5);
  await page.keyboard.press("Escape");
  await expect.poll(zoom).toBe(1);

  // Navigating while zoomed zooms out and turns.
  await page.mouse.dblclick(...at(0.3));
  await expect.poll(zoom).toBe(2.5);
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#page-label")).toHaveText("3–4 / 8");
  await expect.poll(zoom).toBe(1);

  // A single click still turns the page (after the double-click window).
  await page.waitForTimeout(800);
  await page.mouse.click(...at(0.8));
  await expect(page.locator("#page-label")).toHaveText("5–6 / 8");
});

test("single-page layout: phone shows one page at a time and switches with orientation", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?pdf=multipage.pdf");
  await ready(page);
  const layout = () => page.evaluate(() => window.__luxebook.state.layout);
  const stageIsPortrait = await page.evaluate(() => {
    const s = document.getElementById("stage")!;
    return s.clientWidth < s.clientHeight;
  });
  test.skip(!stageIsPortrait, "playground stage is not portrait at this size");
  expect(await layout()).toBe("single");

  await page.evaluate(() => window.__luxebook.open());
  await page.waitForFunction(() => window.__luxebook.bookState === "open");
  await expect(page.locator("#page-label")).toHaveText("2 / 8");
  // The whole view is page 2, not a spread.
  await expect.poll(() => visiblePages(page)).toEqual([2, 2]);

  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#page-label")).toHaveText("3 / 8");
  await expect.poll(() => visiblePages(page)).toEqual([3, 3]);

  // Tapping the left half goes back.
  const box = (await page.locator("#stage canvas").boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.25, box.y + box.height / 2);
  await expect(page.locator("#page-label")).toHaveText("2 / 8");

  // Rotate to landscape: back to the spread, on the same page.
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect.poll(layout).toBe("double");
  await expect(page.locator("#page-label")).toHaveText("2–3 / 8");
  await expect.poll(() => visiblePages(page)).toEqual([2, 3]);
});

test("overlay: live HTML on the back cover, hidden while turning away", async ({ page }) => {
  await page.goto("/?pdf=multipage.pdf");
  await ready(page);
  await page.evaluate(() => {
    const form = document.createElement("form");
    form.id = "e2e-form";
    form.innerHTML = `<input id="e2e-name" placeholder="Name">`;
    window.__luxebook.setOverlay(form);
  });
  const form = page.locator("#e2e-form");
  await expect(form).toBeHidden(); // closed book
  await page.evaluate(() => window.__luxebook.goToPage(8));
  await expect(page.locator("#page-label")).toHaveText("8 / 8");
  await expect(form).toBeVisible();
  // It sits on the empty right half of the stage.
  const box = (await form.boundingBox())!;
  const stage = (await page.locator("#stage").boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(stage.x + stage.width / 2 - 2);
  await page.fill("#e2e-name", "Ada");
  await expect(page.locator("#e2e-name")).toHaveValue("Ada");
  await page.evaluate(() => window.__luxebook.previous());
  await expect(form).toBeHidden();
  await expect(page.locator("#page-label")).toHaveText("6–7 / 8");
});

test("lastPage: the book ends there, the overlay goes on the blank preview page", async ({ page }) => {
  await page.goto("/?pdf=multipage.pdf&lastPage=5&layout=double");
  await ready(page);
  await page.evaluate(() => {
    const form = document.createElement("form");
    form.id = "e2e-preview";
    form.innerHTML = `<input placeholder="Email">`;
    window.__luxebook.setOverlay(form);
  });
  await page.evaluate(() => window.__luxebook.goToPage(8)); // clamped to the end
  await expect(page.locator("#page-label")).toHaveText("6 / 6");
  await expect(page.locator("#e2e-preview")).toBeVisible();
  // Page 6 (the preview page) lies on the left; it's blank, not the PDF's page 6.
  const box = (await page.locator("#e2e-preview").boundingBox())!;
  const stage = (await page.locator("#stage").boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(stage.x + stage.width / 2 + 2);
});
