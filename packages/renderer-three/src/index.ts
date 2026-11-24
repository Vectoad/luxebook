import {
  AmbientLight,
  BackSide,
  BoxGeometry,
  BufferAttribute,
  Color,
  CanvasTexture,
  DataTexture,
  FrontSide,
  Group,
  Mesh,
  MeshDepthMaterial,
  MeshStandardMaterial,
  PCFShadowMap,
  RGBADepthPacking,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  Raycaster,
  Vector2,
  Scene,
  SpotLight,
  ShadowMaterial,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
  type Material,
  type Object3D,
  type Texture,
} from "three";
import { curlVertex, type CurlParams, type CurlResult } from "@vectoad/luxebook-page-physics";

export type PageImage = HTMLCanvasElement | OffscreenCanvas | ImageBitmap;
export type Side = "left" | "right";

export interface BookRendererOptions {
  shadows: boolean;
  maxPixelRatio: number;
}

/** Live-tunable look; every field is required (the viewer resolves defaults). */
export interface BookLook {
  background: string;
  backgroundImage: string | null;
  backgroundBrightness: number;
  backgroundBlur: number;
  shadowStrength: number;
  coverColor: string;
  thickness: number;
  /** Degrees. */
  rotateX: number;
  /** Degrees. */
  rotateY: number;
  /** Animation time multiplier. */
  speed: number;
  lighting: Lighting;
  /** Paper finish: how much the pages (and cover image) shine. */
  paper: Paper;
  /** Cover board thickness multiplier (on top of `thickness`). */
  coverThickness: number;
  /** Spine (hinge cover) width as a multiple of the cover thickness; 0 = bare paper edge. */
  spineWidth: number;
  /** Extra zoom on top of the dolly (per-state zoom). */
  zoomFactor: number;
  /** Book position on the stage, −1…1 of the half width/height. */
  offsetX: number;
  offsetY: number;
}

export type Lighting = "neutral" | "warm" | "cool" | "dramatic";

/** Key (spot) and ambient light per mood. Neutral renders page white as #fff. */
const LIGHTING: Record<Lighting, { key: number; keyI: number; amb: number; ambI: number }> = {
  neutral: { key: 0xffffff, keyI: 2.5, amb: 0xffffff, ambI: 1.03 },
  warm: { key: 0xfff7ee, keyI: 2.5, amb: 0xfbf9f6, ambI: 0.9 },
  cool: { key: 0xf2f6ff, keyI: 2.5, amb: 0xf4f7ff, ambI: 0.95 },
  dramatic: { key: 0xfff4e6, keyI: 4.2, amb: 0xffffff, ambI: 0.35 },
};

/**
 * World units: a page is 1 tall and `aspect` wide. The spine is the y axis,
 * the book lies on a "table" at z = 0 and the reader looks down −z.
 */
const SEGMENTS_X = 64; // the curl and the gutter curve; cheap for a static page
const SEGMENTS_Y = 24;
/** The turning leaf folds diagonally through a tight roll: it needs a finer grid in both directions. */
const TURN_SEGMENTS = [128, 96] as const;
const SHEET_THICKNESS = 0.005; // per leaf (2 pages) for the visible stack
const MAX_STACK = 0.12;
const COVER_THICKNESS = 0.012; // at thickness 1; scales with the paper like the stacks
const COVER_OVERHANG = 0; // cover and board match the page exactly: the PDF page is the whole visible surface
/** Height of the turning leaf's hinge above the board: just above the gutter floor. */
const TURN_HINGE = 0.0008;
const FOV = 30;
export type Paper = "matte" | "silk" | "glossy";
/**
 * Roughness lying flat, and at its shiniest while lifted and curling: a page
 * at rest keeps a gentle sheen (glare would wash out the print), a turning
 * page catches the light the way coated paper does.
 */
const PAPER_FINISH: Record<Paper, { rest: number; lifted: number }> = {
  matte: { rest: 0.82, lifted: 0.82 },
  silk: { rest: 0.66, lifted: 0.5 },
  // Not sharper than this: a tight highlight shimmers across the mesh of a moving curl.
  glossy: { rest: 0.58, lifted: 0.34 },
};
const WHITE = new Color(0xffffff); // low FOV: minimal perspective distortion of the page content

/**
 * One leaf of paper: a front and a back face sharing a subdivided geometry
 * whose local origin is on the spine. Rotating the pivot by π about y lays
 * it on the left with its back face up, exactly like a turned page.
 */
class Sheet {
  readonly pivot = new Group();
  readonly front: Mesh<PlaneGeometry, MeshStandardMaterial>;
  readonly back: Mesh<PlaneGeometry, MeshStandardMaterial>;
  private geometry: PlaneGeometry;
  private basePositions: Float32Array;
  private baseNormals: Float32Array;
  /** Gutter dip: how far (local z) the spine edge sinks, over what width (page fraction). */
  readonly gutter: Gutter = { lift: { value: 0 }, drop: { value: 0 }, width: { value: 0.1 }, aspect: { value: 1 } };

  constructor(geometry: PlaneGeometry, blank: Texture, gloss: { value: number }) {
    this.geometry = geometry;
    this.basePositions = Float32Array.from(geometry.attributes.position!.array);
    this.baseNormals = Float32Array.from(geometry.attributes.normal!.array);
    this.front = new Mesh(geometry, pageMaterial(blank, FrontSide, this.gutter, gloss));
    this.back = new Mesh(geometry, pageMaterial(blank, BackSide, this.gutter, gloss));
    for (const m of [this.front, this.back]) {
      m.castShadow = true;
      m.receiveShadow = true;
      m.customDepthMaterial = gutterDepthMaterial(this.gutter); // shadows follow the curve too
      this.pivot.add(m);
    }
  }

  setGutter(drop: number, width: number, aspect: number, lift = 0): void {
    this.gutter.lift.value = lift;
    this.gutter.drop.value = drop;
    this.gutter.width.value = width;
    this.gutter.aspect.value = aspect;
  }

  setGeometry(geometry: PlaneGeometry): void {
    this.geometry.dispose();
    this.geometry = geometry;
    this.basePositions = Float32Array.from(geometry.attributes.position!.array);
    this.baseNormals = Float32Array.from(geometry.attributes.normal!.array);
    this.front.geometry = geometry;
    this.back.geometry = geometry;
  }

  /**
   * Fold the sheet (`null`: flat). `land` (0–1) blends it towards lying
   * turned over on the other side (mirrored, face down), so a page held
   * near the end of a turn already rests into the gutter like the page it
   * becomes, with no crease at the spine and nothing to snap on release.
   */
  setCurl(params: CurlParams | null, out: CurlResult, land = 0): void {
    const positions = this.geometry.attributes.position!;
    const normals = this.geometry.attributes.normal!;
    if (!params && land <= 0) {
      positions.array.set(this.basePositions);
      normals.array.set(this.baseNormals);
      this.geometry.computeBoundingSphere();
    } else {
      const k = 1 - land;
      for (let i = 0; i < positions.count; i++) {
        const x = this.basePositions[i * 3]!;
        const y = this.basePositions[i * 3 + 1]!;
        const v = params ? curlVertex(x, y, params, out) : Object.assign(out, { x, y, z: 0, nx: 0, ny: 0, nz: 1 });
        const nx = v.nx * k;
        const ny = v.ny * k;
        const nz = v.nz * k - land;
        const n = Math.hypot(nx, ny, nz) || 1;
        positions.setXYZ(i, v.x * k - x * land, v.y * k + y * land, v.z * k);
        normals.setXYZ(i, nx / n, ny / n, nz / n);
      }
      this.geometry.computeBoundingSphere();
    }
    positions.needsUpdate = true;
    normals.needsUpdate = true;
  }

  /** Swap a face's texture. The previous texture is disposed unless it's the shared blank. */
  setImage(face: "front" | "back", image: PageImage | null, blank: Texture, anisotropy: number): void {
    const material = this[face].material;
    const previous = material.map;
    if (image) {
      const tex = new CanvasTexture(image);
      tex.colorSpace = SRGBColorSpace;
      tex.anisotropy = anisotropy;
      if (face === "back") {
        // Seen from behind, u runs right-to-left; mirror it so content reads correctly.
        tex.repeat.x = -1;
        tex.offset.x = 1;
      }
      material.map = tex;
    } else {
      material.map = blank;
    }
    if (previous && previous !== blank) previous.dispose();
  }

  dispose(blank: Texture): void {
    for (const m of [this.front, this.back]) {
      if (m.material.map && m.material.map !== blank) m.material.map.dispose();
      m.material.dispose();
      m.customDepthMaterial?.dispose();
    }
    this.geometry.dispose();
  }
}

/**
 * Page-block edge: paper colour with fine page lines across its thickness.
 * Lit sides of a box only get ambient light, so a little emissive keeps
 * the edges reading as paper rather than grey. `uLines` = lines across the box.
 */
function edgeMaterial(): MeshStandardMaterial & { userData: { lines: { value: number } } } {
  const m = new MeshStandardMaterial({ color: 0xf2eee6, roughness: 0.95, emissive: 0x6f6c66 });
  const lines = { value: 1 };
  m.userData.lines = lines;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uLines = lines;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float aLuxZ;\nvarying float vLuxZ;\nvarying float vLuxTop;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvLuxZ = aLuxZ;\nvLuxTop = abs(normal.z);");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform float uLines;\nvarying float vLuxZ;\nvarying float vLuxTop;")
      .replace(
        "#include <map_fragment>",
        `#include <map_fragment>
        float luxT = vLuxZ * uLines;
        float luxW = fwidth(luxT);
        // Thin dark line per page; fades out when lines get denser than pixels (no moiré).
        float luxLine = 1.0 - smoothstep(0.0, max(luxW, 0.001) * 1.2, abs(fract(luxT) - 0.5) * 2.0 - 0.6);
        luxLine *= 1.0 - smoothstep(0.35, 0.6, luxW);
        diffuseColor.rgb *= 1.0 - 0.13 * luxLine * (1.0 - vLuxTop);`,
      );
  };
  m.customProgramCacheKey = () => "luxebook-edge";
  return m as MeshStandardMaterial & { userData: { lines: { value: number } } };
}

/**
 * Front-cover face. Over the spine strip (u < 0) it repeats the image's
 * colour from a few pixels in, so the cover wraps the spine without a seam.
 */
function coverFaceMaterial(minU: { value: number }): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uLuxMinU = minU;
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform float uLuxMinU;")
      .replace("#include <map_fragment>", `#ifdef USE_MAP
        diffuseColor *= texture2D( map, vec2( max( vMapUv.x, uLuxMinU ), vMapUv.y ) );
      #endif`);
  };
  m.customProgramCacheKey = () => "luxebook-cover-face";
  return m;
}

interface Gutter {
  /** Raise the whole sheet (local z); with drop = lift the spine edge stays put. */
  lift: { value: number };
  drop: { value: number };
  width: { value: number };
  aspect: { value: number };
}

/**
 * Pages curve down into the hinge: near the spine a page sinks by
 * drop·(1 − u/width)², u = distance from the spine as a page fraction.
 * (Same profile as `gutterDip` below, used for the paper blocks.)
 */
const GUTTER_GLSL = {
  head: "attribute float aLuxU;\nuniform float uLuxDrop;\nuniform float uLuxW;\nuniform float uLuxA;\nuniform float uLuxLift;",
  // aLuxU: where on the paper (0 spine … 1 edge), wherever a fold has moved it.
  body: `float luxU = aLuxU;
    float luxT = max(1.0 - luxU / max(uLuxW, 1e-4), 0.0);
    transformed.z += uLuxLift - uLuxDrop * luxT * luxT;`,
};

function useGutter(shader: { uniforms: Record<string, unknown>; vertexShader: string }, g: Gutter): void {
  shader.uniforms.uLuxDrop = g.drop;
  shader.uniforms.uLuxW = g.width;
  shader.uniforms.uLuxA = g.aspect;
  shader.uniforms.uLuxLift = g.lift;
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", `#include <common>\n${GUTTER_GLSL.head}`)
    .replace("#include <begin_vertex>", `#include <begin_vertex>\n${GUTTER_GLSL.body}`);
}

function gutterDepthMaterial(g: Gutter): MeshDepthMaterial {
  const m = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
  m.onBeforeCompile = (shader) => {
    useGutter(shader, g);
    // Only paper lifted off the page casts: a sheet lying flat would just
    // darken the gutter it already shades (a second, harder shadow at the spine).
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying float vLuxLifted;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvLuxLifted = abs(position.z);");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vLuxLifted;")
      .replace("void main() {", "void main() {\n  if (vLuxLifted < 0.004) discard;");
  };
  m.customProgramCacheKey = () => "luxebook-page-depth";
  return m;
}

/** Same dip as GUTTER_GLSL, as a 0–1 factor at distance u from the spine. */
function gutterDip(u: number, width: number): number {
  const t = Math.max(1 - u / Math.max(width, 1e-4), 0);
  return t * t;
}

/** Unit paper block, finely divided along x so its top can curve into the gutter. */
function stackGeometry(): BoxGeometry {
  const g = new BoxGeometry(1, 1, 1, 96, 1, 1);
  const pos = g.attributes.position!;
  // Height within the block (0 bottom … 1 top), kept as the dip squeezes it: page lines follow the curve.
  const h = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) h[i] = pos.getZ(i) + 0.5;
  g.setAttribute("aLuxZ", new BufferAttribute(h, 1));
  g.userData.base = Float32Array.from(pos.array);
  g.userData.key = "";
  return g;
}

/**
 * Sink the block's face (`top`, or `bottom` for the carried block, whose
 * bottom faces up once the cover lands) towards the spine at local x
 * `spineX`. `amount` 1 closes the block to zero height at the spine.
 */
function dipStack(g: BoxGeometry, spineX: number, top: boolean, amount: number, width: number): void {
  const key = `${spineX}|${top}|${amount.toFixed(4)}|${width.toFixed(4)}`;
  if (g.userData.key === key) return;
  g.userData.key = key;
  const base = g.userData.base as Float32Array;
  const pos = g.attributes.position!;
  for (let i = 0; i < pos.count; i++) {
    const x = base[i * 3]!;
    const z = base[i * 3 + 2]!;
    const onFace = top ? z > 0 : z < 0;
    const d = onFace ? gutterDip(Math.abs(x - spineX), width) * amount : 0;
    pos.setZ(i, top ? z - d : z + d);
  }
  pos.needsUpdate = true;
  g.computeBoundingSphere();
}

/**
 * Paper material with a gutter shadow baked into the shader (darkens towards
 * the spine). `gloss`: roughness of paper lifted off the page. Flat paper
 * keeps the material's own roughness; the shine grows smoothly with height,
 * so a turn never switches the finish of the whole sheet (no flash).
 */
function pageMaterial(map: Texture, side: typeof FrontSide | typeof BackSide, gutter: Gutter, gloss: { value: number }): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ map, side, roughness: 0.82, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    useGutter(shader, gutter);
    shader.uniforms.uLuxGloss = gloss;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying float vLuxSpine;\nvarying float vLuxLift;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvLuxSpine = uv.x;\nvLuxLift = abs(position.z);");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vLuxSpine;\nvarying float vLuxLift;\nuniform float uLuxGloss;")
      .replace(
        "#include <roughnessmap_fragment>",
        "#include <roughnessmap_fragment>\n  roughnessFactor = mix(roughnessFactor, uLuxGloss, smoothstep(0.002, 0.04, vLuxLift));",
      )
      .replace(
        "#include <map_fragment>",
        `#include <map_fragment>
        float luxGutter = 1.0 - smoothstep(0.0, 0.11, vLuxSpine);
        diffuseColor.rgb *= 1.0 - 0.32 * luxGutter * luxGutter;
        diffuseColor.rgb *= 1.0 - 0.05 * smoothstep(0.975, 1.0, vLuxSpine);`,
      );
  };
  m.customProgramCacheKey = () => "luxebook-page";
  return m;
}

export class BookRenderer {
  readonly canvas: HTMLCanvasElement;
  /** Wraps the background layer and the (transparent) canvas; HTML overlays go in here too. */
  readonly root: HTMLDivElement;
  /** Called after every rendered frame (keeps HTML overlays on the page). */
  onRender: (() => void) | null = null;
  private readonly backdrop: HTMLDivElement;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(FOV, 1, 0.05, 50);
  private readonly blank: DataTexture;
  private readonly anisotropy: number;
  private readonly book = new Group();
  private readonly left: Sheet;
  private readonly right: Sheet;
  private readonly turning: Sheet;
  private readonly stacks: Record<Side, Mesh<BoxGeometry, ReturnType<typeof edgeMaterial>>>;
  /** Leaves carried by the front cover while it swings (they become the left stack). */
  private readonly carried: Mesh<BoxGeometry, ReturnType<typeof edgeMaterial>>;
  /** Turn in progress: which side the leaf leaves from, and how far (0–1). */
  private turnShift: { side: Side; progress: number } | null = null;
  private readonly raycaster = new Raycaster();
  private readonly cover: Mesh<BoxGeometry, MeshStandardMaterial>;
  private readonly coverFace: Mesh<PlaneGeometry, MeshStandardMaterial>;
  /** Inside of the front cover: the page that lands on the left as the book opens. */
  private readonly coverInside: Sheet;
  private readonly coverPivot = new Group();
  private readonly board: Mesh<BoxGeometry, MeshStandardMaterial>;
  /** Cover material wrapping the spine (the hinge edge) of the closed book. */
  private readonly spine: Mesh<BoxGeometry, MeshStandardMaterial>;
  private readonly table: Mesh<PlaneGeometry, ShadowMaterial>;
  private readonly key: SpotLight;
  private readonly ambient = new AmbientLight(0xffffff, 1);
  private readonly curlOut: CurlResult = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 1 };
  private aspect = 1 / Math.SQRT2;
  private stackDepth: Record<Side, number> = { left: SHEET_THICKNESS, right: SHEET_THICKNESS };
  private leaves: Record<Side, number> = { left: 1, right: 1 };
  private thickness = 1;
  private tilt = 0;
  private yaw = 0;
  private speed = 1;
  private zoomFactor = 1;
  private coverMul = 1;
  /** Leftmost texture u the cover samples; the spine strip repeats the colour there. */
  private readonly coverMinU = { value: 0 };
  /** Images for a soft cover's fold: the cover, and the page inside it. */
  private coverSource: PageImage | null = null;
  private coverInsideSource: PageImage | null = null;
  /** How far the turning leaf has settled into its landed pose (0–1). */
  private turnLand = 0;
  /** Roughness of paper lifted off the page (the page shader blends to it with height). */
  private readonly gloss = { value: PAPER_FINISH.matte.lifted };
  private turnProgress = 0;
  /** A soft cover is folding (on the turning leaf), from this side. */
  private coverFold: { side: Side } | null = null;
  private spineMul = 1;
  private offset = { x: 0, y: 0 };
  /** Reading zoom: `scale`× around a centre given as fractions of the canvas. */
  private focusView = { scale: 1, x: 0.5, y: 0.5 };
  private size = { width: 1, height: 1 };
  private pageVisible: Record<Side, boolean> = { left: false, right: false };
  private openProgress = 0;
  private dolly = 1;
  /** Page widths the view frames: 2 (spread) or 1 (single page, spine at its left edge). */
  private pagesAcross: 1 | 2 = 2;
  /** Single page: nothing left of the spine is drawn (the turned pages, the opened cover). */
  private readonly spineClip = new Plane(new Vector3(1, 0, 0), 0);
  private readonly bookMaterials: Material[] = [];
  private readonly frameCallbacks = new Set<(dt: number) => boolean>();
  private rafId = 0;
  private lastTime = 0;
  private disposed = false;

  constructor(container: HTMLElement, private readonly options: BookRendererOptions) {
    // Transparent canvas over a DOM backdrop: background colour/image,
    // brightness and blur are then plain CSS, not shader work.
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    const r = this.renderer;
    r.outputColorSpace = SRGBColorSpace;
    r.setClearColor(0x000000, 0);
    r.shadowMap.enabled = options.shadows;
    r.shadowMap.type = PCFShadowMap;
    this.anisotropy = Math.min(8, r.capabilities.getMaxAnisotropy());

    this.root = document.createElement("div");
    Object.assign(this.root.style, { position: "relative", width: "100%", height: "100%", overflow: "hidden" });
    this.backdrop = document.createElement("div");
    Object.assign(this.backdrop.style, { position: "absolute", backgroundSize: "cover", backgroundPosition: "center" });
    this.canvas = r.domElement;
    Object.assign(this.canvas.style, { position: "relative", display: "block", width: "100%", height: "100%", touchAction: "none" });
    this.root.append(this.backdrop, this.canvas);
    container.appendChild(this.root);

    this.blank = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    this.blank.colorSpace = SRGBColorSpace;
    this.blank.needsUpdate = true;

    this.left = new Sheet(this.makePageGeometry(), this.blank, this.gloss);
    this.right = new Sheet(this.makePageGeometry(), this.blank, this.gloss);
    this.turning = new Sheet(this.makePageGeometry(TURN_SEGMENTS), this.blank, this.gloss);
    this.coverInside = new Sheet(this.makePageGeometry(), this.blank, this.gloss);
    this.coverInside.pivot.visible = false;
    this.left.pivot.rotation.y = Math.PI;
    // Pages lying open don't shade each other: the right page would cast a hard
    // band into the left gutter. The gutter shade is in their material; the
    // turning leaf and the paper blocks still cast.
    for (const sheet of [this.left, this.right]) sheet.front.castShadow = sheet.back.castShadow = false;
    this.turning.pivot.visible = false;

    this.stacks = {
      left: new Mesh(stackGeometry(), edgeMaterial()),
      right: new Mesh(stackGeometry(), edgeMaterial()),
    };
    this.carried = new Mesh(stackGeometry(), edgeMaterial());
    this.cover = new Mesh(
      new BoxGeometry(1, 1, 1),
      new MeshStandardMaterial({ color: 0x24211e, roughness: 0.7 }),
    );
    this.cover.castShadow = true;
    this.cover.receiveShadow = true;
    this.coverPivot.add(this.cover);
    this.coverFace = new Mesh(new PlaneGeometry(1, 1), coverFaceMaterial(this.coverMinU));
    this.coverFace.visible = false;
    this.coverFace.receiveShadow = true;
    this.coverPivot.add(this.coverFace, this.coverInside.pivot, this.carried);
    this.board = new Mesh(
      new BoxGeometry(1, 1, 1),
      new MeshStandardMaterial({ color: 0x24211e, roughness: 0.7 }),
    );
    this.board.castShadow = true;
    this.board.receiveShadow = true;
    this.spine = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: 0x24211e, roughness: 0.7 }));
    this.spine.castShadow = true;
    this.spine.receiveShadow = true;
    // Shadow-only table: invisible except where the book shades it.
    this.table = new Mesh(new PlaneGeometry(40, 40), new ShadowMaterial({ opacity: 0.5 }));
    this.table.position.z = -0.0005;
    this.table.receiveShadow = true;
    for (const m of [this.stacks.left, this.stacks.right, this.cover, this.carried]) {
      m.castShadow = true;
      m.receiveShadow = true;
    }
    this.book.add(
      this.left.pivot,
      this.right.pivot,
      this.turning.pivot,
      this.stacks.left,
      this.stacks.right,
      this.board,
      this.coverPivot,
      this.spine,
    );
    this.scene.add(this.book, this.table);
    // Single-page clipping is per material (global planes skip the shadow pass), so what is cut off casts no shadow.
    r.localClippingEnabled = true;
    const turningMaterials: Material[] = [this.turning.front.material, this.turning.back.material];
    this.book.traverse((o) => {
      // The turning leaf is never cut: in single page it flips over fully and fades out instead.
      if (o instanceof Mesh && !turningMaterials.includes(o.material as Material)) {
        (o.material as Material).clipShadows = true;
        this.bookMaterials.push(o.material as Material);
      }
    });

    // Key light from upper left; its cone falls off on the table to give a
    // natural vignette while the book itself sits in even light.
    const key = (this.key = new SpotLight(0xffffff, 2.5, 0, 0.5, 0.55, 0));
    key.position.set(-1.4, 1.9, 4.2);
    key.castShadow = options.shadows;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.004;
    key.shadow.radius = 6;
    key.shadow.camera.near = 2;
    key.shadow.camera.far = 8;
    this.scene.add(key, key.target, this.ambient);

    this.layout();
    this.setBookOpenProgress(0);
  }

  /** Largest texture side the GPU accepts. */
  get maxTextureSize(): number {
    return this.renderer.capabilities.maxTextureSize;
  }

  /** Projected width of what the view frames (the spread, or one page) in CSS pixels. */
  get bookWidth(): number {
    const half = (this.aspect * this.pagesAcross) / 2;
    const left = new Vector3(-half, 0, this.coverThickness).project(this.camera).x;
    const right = new Vector3(half, 0, this.coverThickness).project(this.camera).x;
    return Math.abs(right - left) * this.canvas.clientWidth * 0.5;
  }

  /** Page width / height. Rebuilds page geometry (rare: once per document). */
  setPageAspect(aspect: number): void {
    if (Math.abs(aspect - this.aspect) < 1e-6) return;
    this.aspect = aspect;
    this.left.setGeometry(this.makePageGeometry());
    this.right.setGeometry(this.makePageGeometry());
    this.turning.setGeometry(this.makePageGeometry(TURN_SEGMENTS));
    this.coverInside.setGeometry(this.makePageGeometry());
    this.layout();
  }

  /** Show `image` on the visible face of a side, or blank paper for `null`. */
  setPageImage(side: Side, image: PageImage | null): void {
    // The left page is the back of a turned leaf; the right page is a leaf's front.
    if (side === "left") this.left.setImage("back", image, this.blank, this.anisotropy);
    else this.right.setImage("front", image, this.blank, this.anisotropy);
    this.invalidate();
  }

  /** Show the first PDF page on the closed front cover. */
  setBookCoverImage(image: PageImage | null): void {
    this.coverSource = image;
    const previous = this.coverFace.material.map;
    if (image) {
      const texture = new CanvasTexture(image);
      texture.colorSpace = SRGBColorSpace;
      texture.anisotropy = this.anisotropy;
      this.coverFace.material.map = texture;
      this.layout(); // sets how the image maps over the spine strip
    } else {
      this.coverFace.material.map = null;
    }
    this.coverFace.visible = image !== null;
    if (previous) previous.dispose();
    this.invalidate();
  }

  /** Show `image` on the inside of the front cover; it lands as the left page when the book opens. */
  setCoverInsideImage(image: PageImage | null, visible = image !== null): void {
    this.coverInsideSource = image;
    if (this.coverFold) this.turning.setImage("back", image, this.blank, this.anisotropy);
    this.coverInside.setImage("back", image, this.blank, this.anisotropy);
    this.coverInside.pivot.visible = visible;
    this.invalidate();
  }

  /**
   * Soft cover: the cover folds over like a page, on the turning leaf (cover
   * image in front, the inside cover behind), instead of swinging as a board.
   * `side`: where it lies at the start ("right" opening, "left" closing).
   * Pass `null` when it has landed.
   */
  setCoverFold(fold: { side: Side; curl: CurlParams | null; progress: number } | null): void {
    if (!fold) {
      if (!this.coverFold) return;
      this.coverFold = null;
      this.clearTurn();
      this.layout();
      return;
    }
    if (this.coverFold?.side !== fold.side) {
      this.prepareTurn(fold.side, this.coverSource, this.coverInsideSource);
      // A plain cover is the board colour; an image cover is the image.
      this.turning.front.material.color.copy(this.coverSource ? WHITE : this.cover.material.color);
      this.coverFold = { side: fold.side };
    }
    this.setTurnCurl(fold.side, fold.curl, fold.progress);
    this.turnShift = null; // its leaf is already counted in the stacks
    this.layout();
  }

  /** Prepare a separate turning leaf while both static spread pages stay visible underneath. */
  prepareTurn(side: Side, front: PageImage | null, back: PageImage | null): void {
    this.turning.setImage("front", front, this.blank, this.anisotropy);
    this.turning.setImage("back", back, this.blank, this.anisotropy);
    this.turning.pivot.rotation.y = side === "left" ? Math.PI : 0;
    this.turning.pivot.position.z = this.coverThickness + TURN_HINGE;
    this.turning.setCurl(null, this.curlOut);
    this.turning.pivot.visible = true;
    this.fadeTurning(side, 0);
    this.layout(); // gutter dip for the new leaf
  }

  /**
   * Fold the turning leaf (`null`: lying flat) without disturbing either
   * static page. It stays hinged on its own side; the fold carries it over.
   * `progress` (0–1) moves its thickness between the stacks.
   */
  setTurnCurl(side: Side, params: CurlParams | null, progress: number): void {
    // Lands only in the last stretch, so the page keeps its curl while it turns
    // (not a flat sheet sliding over); held across, it lies exactly where it will rest.
    const t = Math.min(1, Math.max(0, (progress - 0.85) / 0.12));
    this.turnLand = t * t * (3 - 2 * t);
    this.turnProgress = progress;
    this.turning.setCurl(params, this.curlOut, this.turnLand);
    this.fadeTurning(side, progress);
    // The leaf's thickness moves from one stack to the other as it turns.
    this.turnShift = { side, progress };
    this.layout();
  }

  /**
   * Single page: the left half is out of view, so the leaf fades out as it
   * lands there (and fades in as it lifts off it, turning back).
   */
  private fadeTurning(side: Side, progress: number): void {
    const leftness = side === "right" ? progress : 1 - progress;
    const t = Math.min(1, Math.max(0, (leftness - 0.55) / 0.4));
    const opacity = this.pagesAcross === 1 ? 1 - t * t * (3 - 2 * t) : 1;
    for (const m of [this.turning.front, this.turning.back]) {
      m.material.opacity = opacity;
      m.castShadow = opacity > 0.35;
    }
  }

  clearTurn(): void {
    this.turnLand = 0;
    this.turnProgress = 0;
    this.turning.front.material.color.copy(WHITE);
    this.fadeTurning("right", 0);
    this.turnShift = null;
    this.turning.setCurl(null, this.curlOut);
    this.turning.pivot.rotation.y = 0;
    this.turning.pivot.position.z = 0;
    this.turning.pivot.visible = false;
    this.invalidate();
  }

  /** Hide a side entirely (front cover open on the right only, back cover on the left only). */
  setPageVisible(side: Side, visible: boolean): void {
    this.pageVisible[side] = visible;
    this.updatePageVisibility();
    this.invalidate();
  }

  /** Animate the closed front cover into the left-hand open position. */
  setBookOpenProgress(progress: number): void {
    this.openProgress = Math.max(0, Math.min(1, progress));
    this.layout();
    this.updatePageVisibility();
  }

  /**
   * Frame the two-page spread (2) or just the right-hand page (1): the
   * single-page view, where the left half lies out of view past the spine.
   */
  setPagesAcross(pages: 1 | 2): void {
    if (pages === this.pagesAcross) return;
    this.pagesAcross = pages;
    for (const m of this.bookMaterials) m.clippingPlanes = pages === 1 ? [this.spineClip] : null;
    for (const m of [this.turning.front.material, this.turning.back.material]) {
      m.transparent = pages === 1;
      m.needsUpdate = true;
    }
    this.layout();
    this.updatePageVisibility();
  }

  /** Paper-stack depth from the number of leaves under each visible page. */
  setStack(leftLeaves: number, rightLeaves: number): void {
    this.leaves = { left: leftLeaves, right: rightLeaves };
    this.turnShift = null; // the new counts already include any finished turn
    this.layout();
  }

  /** Cover/board thickness: follows the paper thickness so the book stays in proportion. */
  private get coverThickness(): number {
    return COVER_THICKNESS * this.thickness * this.coverMul;
  }

  private depth(leaves: number): number {
    const t = this.thickness;
    return Math.min(MAX_STACK * t, Math.max(1, leaves) * SHEET_THICKNESS * t);
  }

  /** Apply background, shadow, cover colour, thickness, camera angle and speed. */
  setLook(look: BookLook): void {
    const blur = look.backgroundBlur;
    Object.assign(this.backdrop.style, {
      // Oversize the blurred layer so its edges don't fade to transparent.
      inset: `${-2 * blur}px`,
      backgroundColor: look.background,
      backgroundImage: look.backgroundImage ? `url(${JSON.stringify(look.backgroundImage)})` : "none",
      filter: `brightness(${look.backgroundBrightness}) blur(${blur}px)`,
    });
    this.table.material.opacity = look.shadowStrength;
    this.table.visible = look.shadowStrength > 0;
    this.cover.material.color.set(look.coverColor);
    this.board.material.color.set(look.coverColor);
    this.spine.material.color.set(look.coverColor);
    this.tilt = (look.rotateX * Math.PI) / 180;
    this.yaw = (look.rotateY * Math.PI) / 180;
    this.speed = look.speed;
    this.zoomFactor = look.zoomFactor;
    this.coverMul = look.coverThickness;
    this.spineMul = look.spineWidth;
    this.offset = { x: look.offsetX, y: look.offsetY };
    // Paper finish: coated stock is smoother, so the light glints off it.
    const finish = PAPER_FINISH[look.paper];
    for (const sheet of [this.left, this.right, this.turning, this.coverInside]) {
      sheet.front.material.roughness = sheet.back.material.roughness = finish.rest;
    }
    this.gloss.value = finish.lifted;
    this.coverFace.material.roughness = finish.rest;
    const light = LIGHTING[look.lighting];
    this.key.color.set(light.key);
    this.key.intensity = light.keyI;
    this.ambient.color.set(light.amb);
    this.ambient.intensity = light.ambI;
    this.thickness = look.thickness;
    this.layout(); // depths, cover and spine all depend on the thickness values
    this.updateCamera();
    this.invalidate();
  }

  /** Camera distance multiplier; 1 frames the open book. Used by intro animations. */
  setDolly(factor: number): void {
    this.dolly = factor;
    this.updateCamera();
    this.invalidate();
  }

  /**
   * Magnify the view `scale`× (≥ 1) around (x, y), fractions of the canvas.
   * A 2D crop of the camera's view: the book, shadows and hit tests stay exact.
   * The centre is clamped so the view never leaves the canvas; read it back from `focus`.
   */
  setFocus(scale: number, x: number, y: number): void {
    const s = Math.max(1, scale);
    const half = 0.5 / s;
    const clamp = (v: number) => Math.min(1 - half, Math.max(half, v));
    this.focusView = { scale: s, x: clamp(x), y: clamp(y) };
    this.updateCamera();
    this.invalidate();
  }

  get focus(): Readonly<{ scale: number; x: number; y: number }> {
    return this.focusView;
  }

  resize(width: number, height: number): void {
    if (width === 0 || height === 0) return;
    this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, this.options.maxPixelRatio));
    this.renderer.setSize(width, height, false);
    this.size = { width, height };
    this.camera.aspect = width / height;
    this.updateCamera();
    this.renderNow();
  }

  /**
   * Run `step(dt)` every frame until it returns true. The loop only runs
   * while something is animating; an idle book costs no GPU time.
   */
  animate(step: (dt: number) => boolean): () => void {
    this.frameCallbacks.add(step);
    this.invalidate();
    return () => this.frameCallbacks.delete(step);
  }

  /** Schedule a single render on the next animation frame. */
  invalidate(): void {
    if (!this.rafId && !this.disposed) this.rafId = requestAnimationFrame(this.tick);
  }

  /** Render synchronously (e.g. before reading pixels back). */
  renderNow(): void {
    if (this.disposed) return;
    this.renderer.render(this.scene, this.camera);
    this.onRender?.();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    this.frameCallbacks.clear();
    this.left.dispose(this.blank);
    this.right.dispose(this.blank);
    this.turning.dispose(this.blank);
    this.coverInside.dispose(this.blank);
    this.blank.dispose();
    const meshes = [this.stacks.left, this.stacks.right, this.carried, this.cover, this.board, this.spine, this.table];
    for (const m of meshes) {
      m.geometry.dispose();
      (m.material as Material).dispose();
    }
    this.coverFace.geometry.dispose();
    this.coverFace.material.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss(); // browsers cap live contexts (~16); free ours now
    this.root.remove();
  }

  private readonly tick = (now: number): void => {
    // rafId stays set while callbacks run, so their invalidate() calls are
    // absorbed into this frame instead of starting a second loop.
    const dt = ((this.lastTime ? now - this.lastTime : 1000 / 60) / 1000) * this.speed;
    for (const step of this.frameCallbacks) if (step(dt)) this.frameCallbacks.delete(step);
    this.renderer.render(this.scene, this.camera);
    this.onRender?.();
    if (this.frameCallbacks.size > 0) {
      this.lastTime = now;
      this.rafId = requestAnimationFrame(this.tick);
    } else {
      this.rafId = 0;
      this.lastTime = 0;
    }
  };

  private makePageGeometry(segments: readonly [number, number] = [SEGMENTS_X, SEGMENTS_Y]): PlaneGeometry {
    const g = new PlaneGeometry(this.aspect, 1, segments[0], segments[1]);
    g.translate(this.aspect / 2, 0, 0); // spine at x = 0
    g.setAttribute("aLuxU", new BufferAttribute(Float32Array.from(g.attributes.uv!.array.filter((_, i) => i % 2 === 0)), 1));
    return g;
  }

  /** Position stacks, pages and cover from aspect and stack depths. */
  private layout(): void {
    const a = this.aspect;
    const tc = this.coverThickness;
    const leaf = SHEET_THICKNESS * this.thickness;
    // Spread: the closed book is centred and slides right as it opens. Single page: the right page is always centred.
    this.book.position.x = this.pagesAcross === 1 ? -a / 2 : -a * (1 - this.openProgress) / 2;


    // Stack depths; while a leaf turns, its thickness flows from one side to the other.
    const lerp = (x: number, y: number, t: number) => x + (y - x) * t;
    let dl = this.depth(this.leaves.left);
    let dr = this.depth(this.leaves.right);
    if (this.turnShift) {
      const { side } = this.turnShift;
      // The sheet's thickness moves over as it passes upright, mid-turn: a
      // corner lifting (or just landing) leaves both blocks where they are.
      const m = Math.min(1, Math.max(0, (this.turnShift.progress - 0.3) / 0.4));
      const progress = m * m * (3 - 2 * m);
      const from = side === "left" ? this.leaves.left : this.leaves.right;
      const to = side === "left" ? this.leaves.right : this.leaves.left;
      const fromD = lerp(this.depth(from), this.depth(from - 1), progress);
      const toD = lerp(this.depth(to), this.depth(to + 1), progress);
      [dl, dr] = side === "left" ? [fromD, toD] : [toD, fromD];
    }
    this.stackDepth = { left: dl, right: dr };
    for (const side of ["left", "right"] as const) {
      const d = this.stackDepth[side];
      const stack = this.stacks[side];
      stack.scale.set(a, 1, d);
      stack.position.set(side === "left" ? -a / 2 : a / 2, 0, tc + d / 2);
      stack.material.userData.lines.value = d / leaf;
      // Page sits a hair above its stack to avoid z-fighting.
      (side === "left" ? this.left : this.right).pivot.position.z = tc + d + 0.0004;
    }
    if (this.turning.pivot.visible) this.turning.pivot.position.z = tc + TURN_HINGE;

    // The back board stays under the right half while the cover swings; the
    // left half is the front cover itself, so it only joins once the cover lands.
    // (Single page: the left half never joins; it is out of view.)
    const landed = this.openProgress >= 1 && this.pagesAcross === 2 ? 1 : 0;
    // Closed, both boards also wrap the spine strip x ∈ [-w, 0].
    // The spine wraps the closed book only: it slides away during the first
    // part of opening so pages and cover meet directly at the hinge (no strip).
    const w = tc * this.spineMul * (1 - Math.min(1, this.openProgress / 0.15));
    // Single page: nothing left of the spine is drawn (pages turned past it, the opened
    // cover), except the closed book's spine strip.
    this.spineClip.constant = a / 2 + w + 1e-4;
    this.board.scale.set(a * (1 + landed) + w + 2 * COVER_OVERHANG, 1 + 2 * COVER_OVERHANG, tc);
    this.board.position.set((a * (1 - landed) - w) / 2, 0, tc / 2);

    // Front cover + the leaves that will lie on the left, hinged at the
    // spine like a real book. Closed, they sit on the right stack:
    //   z ∈ [tc+dr, tc+dr+C] leaves, [tc+dr+C, 2tc+dr+C] cover board.
    // Rotating π about a hinge at mid-block height lands them on the left as
    //   z ∈ [0, tc] cover (the left board), [tc, tc+C] the left stack.
    const c = dl; // carried leaves = what the left stack will be
    const hinge = tc + (dr + c) / 2;
    this.carried.scale.set(a, 1, c);
    this.carried.position.set(a / 2, 0, tc + dr + c / 2 - hinge);
    this.carried.material.userData.lines.value = c / leaf;
    this.cover.scale.set(a + w + 2 * COVER_OVERHANG, 1 + 2 * COVER_OVERHANG, tc);
    this.cover.position.set((a - w) / 2, 0, tc + dr + c + tc / 2 - hinge);
    // The cover image runs over the spine strip too. Its proportions stay
    // exact: the image fills [0, a] and its edge colour continues over the spine.
    this.coverFace.scale.set(a + w, 1, 1);
    this.coverFace.position.set((a - w) / 2, 0, 2 * tc + dr + c + 0.0002 - hinge);
    const map = this.coverFace.material.map;
    if (map) {
      map.repeat.x = (a + w) / a;
      map.offset.x = -w / a;
      // Skip the page's outermost pixels (anti-aliased edge) so the strip has no seam line.
      this.coverMinU.value = 3 / ((map.image as { width?: number }).width || 1000);
    }
    this.coverInside.pivot.position.z = tc + dr - 0.0004 - hinge;
    this.coverPivot.position.set(0, 0, hinge);
    // Spine: cover material across the hinge edge, from the back board to the
    // front cover. It flattens away as the book opens so the open gutter stays clear.
    // Its top and bottom end inside the boards (which also span the strip),
    // so no spine edge touches the cover surface (that z-fights as a line).
    // A swinging hard cover turns about the middle of the block, so its edge
    // moves out past the spine: the spine follows that edge (to the middle of
    // the board) all the way over, keeping the cover joined to the book.
    let spineTop = lerp(1.5 * tc + dr + c, tc, this.openProgress);
    let spineW = w;
    if (!this.coverFold) {
      const angle = Math.PI * this.openProgress;
      const r = tc + dr + c - hinge + tc / 2; // board middle, from the hinge
      spineTop = Math.max(tc, r * Math.cos(angle) + hinge);
      spineW = Math.max(w, (r + tc / 2) * Math.sin(angle));
    }
    const spineBottom = tc / 2;
    this.spine.scale.set(Math.max(spineW, 1e-6), 1, Math.max(spineTop - spineBottom, 1e-6));
    this.spine.position.set(-spineW / 2, 0, (spineTop + spineBottom) / 2);
    this.spine.visible = this.openProgress < 1 && spineW > 1e-5;

    // Gutter: open pages curve down into the hinge instead of sitting as flat
    // slabs. Eases in as the cover opens (a closed book is flat). Wider and
    // deeper for thicker blocks; blocks and pages share one profile.
    const k = 0.98 * this.openProgress; // keep a sliver of block at the spine
    const reach = (d: number) => Math.min(0.45, Math.max(0.05, (0.06 + 2 * d) / a));
    const wl = reach(dl);
    const wr = reach(dr);
    dipStack(this.stacks.right.geometry, -0.5, true, k, wr);
    dipStack(this.stacks.left.geometry, 0.5, true, k, wl);
    dipStack(this.carried.geometry, -0.5, false, k, wl); // its bottom faces up once landed
    this.right.setGutter(dr * k, wr, a);
    this.left.setGutter(-dl * k, wl, a); // flipped sheet: local +z points down
    this.coverInside.setGutter(-c * k, wl, a);
    // The turning leaf lifts clear of the stacks (local z flips with the side
    // it is hinged on: cos) and curves into the gutter like the page it lies
    // on, its spine edge always a hair above that page's: never under it,
    // whatever the stack depth, so the page beneath can't show through.
    const sign = Math.cos(this.turning.pivot.rotation.y);
    // It crosses from one stack to the other, so it clears the thicker one
    // (open, the difference is a hair; nearly closed, a soft cover would
    // otherwise end up under the pages of the deeper side).
    // It starts exactly where the page it takes over lay, and lands exactly
    // where the page it becomes will lie (a hair above each), so nothing
    // shifts as a turn starts or ends; in between it rises clear of both.
    const fromSide = this.turnShift?.side ?? this.coverFold?.side ?? "right";
    const [dFrom, wFrom, dTo, wTo] = fromSide === "right" ? [dr, wr, dl, wl] : [dl, wl, dr, wr];
    const r0 = Math.min(1, Math.max(0, (this.turnProgress - 0.12) / 0.28)); // only once it nears the other side
    const rise = r0 * r0 * (3 - 2 * r0);
    const land = this.turnLand;
    const at = (from: number, clear: number, to: number) => lerp(lerp(from, clear, rise), to, land);
    const dMax = Math.max(dl, dr);
    const lift = at(dFrom + 0.0005, dMax + 0.002, dTo + 0.0005) - TURN_HINGE;
    const spineHeight = at(dFrom * (1 - k) + 0.0005, dMax * (1 - k) + 0.0008, dTo * (1 - k) + 0.0005) - TURN_HINGE; // above the pivot
    const width = at(wFrom, Math.max(wl, wr), wTo);
    this.turning.setGutter((lift - spineHeight) * sign, width, a, lift * sign);

    this.coverPivot.rotation.y = -Math.PI * this.openProgress;
    this.coverPivot.visible = this.openProgress < 1 && !this.coverFold;
    this.updateCamera();
    this.invalidate();
  }

  private updatePageVisibility(): void {
    for (const side of ["left", "right"] as const) {
      // The left side stays empty until the cover lands there; the cover's inside stands in for its page.
      const shown = side === "left" ? this.openProgress >= 1 && this.pagesAcross === 2 : this.openProgress > 0;
      const visible = shown && this.pageVisible[side];
      (side === "left" ? this.left : this.right).pivot.visible = visible;
      // The right page block is part of the closed book too.
      this.stacks[side].visible = side === "right" ? this.pageVisible.right : visible;
    }
  }

  /**
   * What is under a point on the canvas (client pixels): a page (with its
   * side), the closed cover, another part of the book, or nothing.
   */
  hitTest(clientX: number, clientY: number): { target: "page" | "cover" | "book"; side: Side } | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const shown = (o: Object3D): boolean => {
      for (let n: Object3D | null = o; n; n = n.parent) if (!n.visible) return false;
      return true;
    };
    const hit = this.raycaster.intersectObject(this.book, true).find((h) => shown(h.object));
    if (!hit) return null;
    const side: Side = this.book.worldToLocal(hit.point.clone()).x < 0 ? "left" : "right";
    if (this.openProgress < 1) return { target: "cover", side };
    const pages = [this.left.front, this.left.back, this.right.front, this.right.back];
    return { target: pages.includes(hit.object as never) ? "page" : "book", side };
  }

  /**
   * A client point on the plane of the open pages, in the leaf coordinates
   * of `side` (spine at x = 0, the page's outer edge at x = aspect, y up,
   * ±0.5 at its top and bottom). Null if the ray misses the plane.
   */
  pageLocal(side: Side, clientX: number, clientY: number): { x: number; y: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const z = (side === "left" ? this.left : this.right).pivot.position.z;
    const normal = new Vector3(0, 0, 1).transformDirection(this.book.matrixWorld);
    const plane = new Plane().setFromNormalAndCoplanarPoint(normal, this.book.localToWorld(new Vector3(0, 0, z)));
    const hit = this.raycaster.ray.intersectPlane(plane, new Vector3());
    if (!hit) return null;
    const p = this.book.worldToLocal(hit);
    return { x: side === "left" ? -p.x : p.x, y: p.y };
  }

  /**
   * Screen corners of a page lying flat (top-left, top-right, bottom-right,
   * bottom-left) in CSS pixels from the canvas's top-left. A hidden page
   * reports the board under it. Valid after a render (matrices up to date).
   */
  pageQuad(side: Side): { x: number; y: number }[] {
    const a = this.aspect;
    const sheet = side === "left" ? this.left : this.right;
    const z = sheet.pivot.visible ? sheet.pivot.position.z : this.coverThickness;
    const x0 = side === "left" ? -a : 0;
    const { clientWidth: w, clientHeight: h } = this.canvas;
    return [[x0, 0.5], [x0 + a, 0.5], [x0 + a, -0.5], [x0, -0.5]].map(([x, y]) => {
      const p = this.book.localToWorld(new Vector3(x, y, z)).project(this.camera);
      return { x: ((p.x + 1) / 2) * w, y: ((1 - p.y) / 2) * h };
    });
  }

  /** Camera distance that fits `pages` page widths side by side. */
  private fitDistance(pages: number): number {
    const w = pages * this.aspect + 2 * COVER_OVERHANG;
    const h = 1 + 2 * COVER_OVERHANG;
    const tanHalf = Math.tan((FOV * Math.PI) / 360);
    return Math.max(h / 2 / tanHalf, w / 2 / (tanHalf * this.camera.aspect));
  }

  /**
   * Dolly that frames the closed book (one page) as snugly as the open
   * spread: up to 22% closer, but never so close the cover is cropped.
   */
  get closedDolly(): number {
    if (this.pagesAcross === 1) return 1; // already framing one page
    return Math.max(0.78, this.fitDistance(1) / this.fitDistance(2));
  }

  private updateCamera(): void {
    // Rotating brings the near edge towards the camera; back off by about
    // how far it comes forward so the tilted book still fits.
    const lean = 1 + 1.1 * (this.aspect * Math.abs(Math.sin(this.yaw)) + 0.5 * Math.abs(Math.sin(this.tilt)));
    const d = (this.fitDistance(this.pagesAcross) * 1.1 * this.dolly * lean) / this.zoomFactor;
    // Orbit the camera rather than move the book: lighting, shadows and the
    // table stay put, and the book never dips through the table.
    const c = Math.cos(this.tilt);
    this.camera.position.set(Math.sin(this.yaw) * c * d, -Math.sin(this.tilt) * d, Math.cos(this.yaw) * c * d);
    this.camera.lookAt(0, 0, this.coverThickness);
    // Slide the book across the stage in screen space (no extra perspective skew).
    const { width, height } = this.size;
    const { scale, x, y } = this.focusView;
    if (this.offset.x || this.offset.y || scale !== 1) {
      const w = width / scale;
      const h = height / scale;
      this.camera.setViewOffset(
        width, height,
        (-this.offset.x * width) / 2 + x * width - w / 2,
        (this.offset.y * height) / 2 + y * height - h / 2,
        w, h,
      );
    } else {
      this.camera.clearViewOffset();
    }
    this.camera.updateProjectionMatrix();
  }
}
