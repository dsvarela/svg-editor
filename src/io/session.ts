/**
 * The session as one JSON value, and back again.
 *
 * The SVG carries the drawing. It cannot carry the guides you placed, the
 * keylines you turned on, where the camera is, which snaps are live or the
 * styles you saved, because none of those is geometry and an SVG has nowhere to
 * put them. So there are two things a person could mean by "save my work", and
 * exporting only answers the first.
 *
 * One reader serves both places that ask: the autosave in `storage.ts`, which
 * writes this on a timer, and the workspace file, which writes the same bytes
 * to disk. Two writers of one format would disagree the first time either was
 * extended, and the disagreement would surface as a file that opens in one of
 * them.
 *
 * **Nothing here trusts its input.** `read` rebuilds every object field by
 * field from whatever it is handed and returns `null` the moment something is
 * the wrong shape. The input is a string out of `localStorage` or off a disk,
 * both of which can be edited, truncated or written by an older build, and a
 * restore that throws at startup would brick the editor for as long as the
 * entry sat there.
 */

import { clampCorners, clampRatio } from '../core/primitives';
import type { Doc, Group, PathNode, Pt, Shape, Style, Subpath, ViewBox } from '../core/types';
import type { Guide } from '../model/guides';
import type { DeleteMode, EditorState, NamedStyle, ToolName } from '../model/store';

/**
 * Bumped when an old file can no longer be read as a new one.
 *
 * `read` refuses a version it does not know rather than guessing, which is the
 * only honest answer: a field that changed meaning reads as valid and restores
 * the wrong drawing, and that failure is silent.
 */
const SESSION_VERSION = 1;

/**
 * What is saved beside the drawing. Every field is a preference, not a document.
 *
 * Written as a `Pick` of the editor's own state rather than as a fresh list of
 * types, so a field that changes type there fails to compile here instead of
 * silently writing the old shape into every save. The names are still spelled
 * out: this is a wire format, and it must not grow a field because the editor
 * grew one.
 */
export type SessionView = Pick<
  EditorState,
  | 'tool'
  | 'deleteMode'
  | 'touchButtons'
  | 'gridStep'
  | 'nudgeBig'
  | 'wireframe'
  | 'filled'
  | 'showGrid'
  | 'showKeylines'
  | 'showHandles'
  | 'showRulers'
  | 'showGuides'
  | 'guidesLocked'
  | 'smartGuides'
  | 'snapToGrid'
  | 'snapToPoints'
  | 'snapToBoundary'
  | 'snapToIntersections'
  | 'snapToAngles'
  | 'pixelFit'
  | 'angleStep'
  | 'angleBase'
  | 'angleOrigin'
  | 'decimals'
  | 'minify'
  | 'sourceMode'
  | 'style'
  | 'polygon'
>;

export interface Session {
  version: number;
  doc: Doc;
  camera: ViewBox;
  guides: Guide[];
  palette: NamedStyle[];
  view: SessionView;
}

/* ------------------------------------------------------------------- write */

/**
 * Everything worth carrying across a reload, and nothing else.
 *
 * The selection is left out: it is where you had got to a second ago, not how
 * you work, and restoring it would put handles on screen nobody asked for. So
 * are `heldShift` and `heldAlt`, which are a key being held, and `sourceError`,
 * which is a complaint about text that is no longer in the box.
 *
 * **The backdrop is left out because it cannot go in.** It is an object URL over
 * bytes the browser drops on unload, so the field would restore as a reference
 * to nothing. Carrying the image itself means base64 in every save, which is
 * megabytes on a timer. `whatIsMissing` is what says so out loud.
 */
export function toSession(s: EditorState): Session {
  return {
    version: SESSION_VERSION,
    doc: s.doc,
    camera: { ...s.camera },
    guides: s.guides.map((g) => ({ ...g })),
    palette: s.palette.map((p) => ({ name: p.name, style: { ...p.style } })),
    view: {
      tool: s.tool,
      deleteMode: s.deleteMode,
      touchButtons: s.touchButtons,
      gridStep: s.gridStep,
      nudgeBig: s.nudgeBig,
      wireframe: s.wireframe,
      filled: s.filled,
      showGrid: s.showGrid,
      showKeylines: s.showKeylines,
      showHandles: s.showHandles,
      showRulers: s.showRulers,
      showGuides: s.showGuides,
      guidesLocked: s.guidesLocked,
      smartGuides: s.smartGuides,
      snapToGrid: s.snapToGrid,
      snapToPoints: s.snapToPoints,
      snapToBoundary: s.snapToBoundary,
      snapToIntersections: s.snapToIntersections,
      snapToAngles: s.snapToAngles,
      pixelFit: s.pixelFit,
      angleStep: s.angleStep,
      angleBase: s.angleBase,
      angleOrigin: s.angleOrigin ? [s.angleOrigin[0], s.angleOrigin[1]] : null,
      decimals: s.decimals,
      minify: s.minify,
      sourceMode: s.sourceMode,
      style: { ...s.style },
      polygon: { ...s.polygon },
    },
  };
}

/**
 * What a save could not take with it, as a sentence, or `null` when it took
 * everything.
 *
 * Separate from `toSession` because the answer depends on what was open rather
 * than on the format: a session with no backdrop loses nothing, and telling
 * everybody about a limit that did not apply to them is noise on every save.
 *
 * The undo history is also gone, and is deliberately not mentioned. It is gone
 * from every save every time, so a sentence about it would appear on every
 * message this editor writes about saving, which is how a warning stops being
 * read. The manual says it once instead.
 */
export function whatIsMissing(s: EditorState): string | null {
  return s.backdrop ? 'the backdrop image' : null;
}

export const encode = (s: Session): string => JSON.stringify(s);

/* -------------------------------------------------------------------- read */

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isStr = (v: unknown): v is string => typeof v === 'string';
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const readPt = (v: unknown): Pt | null =>
  Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1]) ? [v[0], v[1]] : null;

/** A handle: a point, or `null` for the straight segment that is not a collapsed one. */
function readHandle(v: unknown): { ok: true; pt: Pt | null } | null {
  if (v === null || v === undefined) return { ok: true, pt: null };
  const p = readPt(v);
  return p ? { ok: true, pt: p } : null;
}

function readNode(v: unknown): PathNode | null {
  if (!isObj(v) || !isStr(v.id)) return null;
  const pt = readPt(v.pt);
  const hIn = readHandle(v.hIn);
  const hOut = readHandle(v.hOut);
  if (!pt || !hIn || !hOut) return null;
  return { id: v.id, pt, hIn: hIn.pt, hOut: hOut.pt, ...(v.auto === true ? { auto: true } : {}) };
}

function readSubpath(v: unknown): Subpath | null {
  if (!isObj(v) || !Array.isArray(v.nodes) || !isBool(v.closed)) return null;
  const nodes: PathNode[] = [];
  for (const n of v.nodes) {
    const node = readNode(n);
    if (!node) return null;
    nodes.push(node);
  }
  return { nodes, closed: v.closed };
}

function readStyle(v: unknown): Style | null {
  if (!isObj(v)) return null;
  if (!isStr(v.fill) || !isStr(v.stroke) || !isNum(v.strokeWidth)) return null;
  if (v.fillRule !== 'nonzero' && v.fillRule !== 'evenodd') return null;
  /* Defaulted rather than refused, because opacity arrived after the format
     did: a workspace written before it has no such field, and refusing one is
     refusing somebody's drawing over a number whose absence means opaque. */
  const opacity = isNum(v.opacity) ? Math.min(1, Math.max(0, v.opacity)) : 1;
  return { fill: v.fill, stroke: v.stroke, strokeWidth: v.strokeWidth, fillRule: v.fillRule, opacity };
}

function readShape(v: unknown): Shape | null {
  if (!isObj(v) || !isStr(v.id) || !isStr(v.name) || !Array.isArray(v.subpaths)) return null;
  const style = readStyle(v.style);
  if (!style) return null;
  const subpaths: Subpath[] = [];
  for (const sp of v.subpaths) {
    const s = readSubpath(sp);
    if (!s) return null;
    subpaths.push(s);
  }
  const group = isStr(v.group) ? v.group : null;
  return { id: v.id, name: v.name, subpaths, style, ...(group ? { group } : {}) };
}

function readGroup(v: unknown): Group | null {
  if (!isObj(v) || !isStr(v.id) || !isStr(v.name)) return null;
  return { id: v.id, name: v.name, parent: isStr(v.parent) ? v.parent : null };
}

function readBox(v: unknown): ViewBox | null {
  if (!isObj(v) || !isNum(v.x) || !isNum(v.y) || !isNum(v.w) || !isNum(v.h)) return null;
  if (v.w <= 0 || v.h <= 0) return null;
  return { x: v.x, y: v.y, w: v.w, h: v.h };
}

function readDoc(v: unknown): Doc | null {
  if (!isObj(v) || !Array.isArray(v.shapes)) return null;
  const viewBox = readBox(v.viewBox);
  if (!viewBox) return null;
  const shapes: Shape[] = [];
  for (const sh of v.shapes) {
    const s = readShape(sh);
    if (!s) return null;
    shapes.push(s);
  }
  let groups: Group[] | undefined;
  if (v.groups !== undefined) {
    if (!Array.isArray(v.groups)) return null;
    groups = [];
    for (const g of v.groups) {
      const grp = readGroup(g);
      if (!grp) return null;
      groups.push(grp);
    }
  }
  /* A shape pointing at a group that is not here would be invisible in the
     list and unselectable, and §49's contiguity rule has nothing to hold it in
     place. Drop the pointer rather than the shape: the geometry is what the
     person drew, and being loose is a state the document already allows. */
  const known = new Set(groups?.map((g) => g.id) ?? []);
  for (const s of shapes) if (s.group && !known.has(s.group)) delete s.group;
  /* The same repair one level up, and it is the more important of the two. A
     `parent` naming no group, or two groups naming each other, puts a shape in a
     tree whose walk from the root never reaches it -- which is a shape that
     paints nowhere and lists nowhere. Rooting the group is the smallest repair
     that puts it back on screen, and it loses only a nesting that was already
     unreadable. */
  for (const g of groups ?? []) {
    if (g.parent && !known.has(g.parent)) g.parent = null;
  }
  for (const g of groups ?? []) {
    const walked = new Set<string>([g.id]);
    let at = g.parent;
    while (at) {
      if (walked.has(at)) {
        g.parent = null;
        break;
      }
      walked.add(at);
      at = groups?.find((o) => o.id === at)?.parent ?? null;
    }
  }
  return { shapes, viewBox, ...(groups ? { groups } : {}) };
}

function readGuides(v: unknown): Guide[] | null {
  if (!Array.isArray(v)) return null;
  const out: Guide[] = [];
  for (const g of v) {
    if (!isObj(g) || !isNum(g.at)) return null;
    if (g.axis !== 'x' && g.axis !== 'y') return null;
    out.push({ axis: g.axis, at: g.at });
  }
  return out;
}

function readPalette(v: unknown): NamedStyle[] | null {
  if (!Array.isArray(v)) return null;
  const out: NamedStyle[] = [];
  for (const p of v) {
    if (!isObj(p) || !isStr(p.name)) return null;
    const style = readStyle(p.style);
    if (!style) return null;
    out.push({ name: p.name, style });
  }
  return out;
}

/**
 * Every value each of these three fields is allowed to hold.
 *
 * Keyed objects rather than arrays, and that is the whole reason they are here:
 * a `ToolName[]` accepts any subset of the union, so a tool added to `ToolName`
 * is missing from the list without anything failing, and every session written
 * with it restores as a different tool. Nothing is wrong at the type level and
 * nothing is wrong at run time -- the fallback is a legal value, so it is not an
 * error, it is a preference quietly changing on its own. A `Record` keyed by the
 * union refuses to compile until the new member is listed.
 *
 * `Object.hasOwn` rather than `in`, because `in` finds `constructor` and
 * `toString` on any object, and these are asked about a string out of a file.
 */
const TOOLS: Record<ToolName, true> = {
  select: true,
  pen: true,
  ellipse: true,
  rect: true,
  poly: true,
  hand: true,
};
const DELETE_MODES: Record<DeleteMode, true> = { fuse: true, split: true };
const SOURCE_MODES: Record<EditorState['sourceMode'], true> = { svg: true, d: true };

const oneOf = <T extends string>(table: Record<T, true>, v: unknown): v is T =>
  typeof v === 'string' && Object.hasOwn(table, v);

/**
 * The preferences, each falling back to the running editor's own value.
 *
 * Lenient where `readDoc` is strict: a missing or malformed preference falls
 * back, a bad coordinate refuses the file. A wrong boolean costs a press and a
 * wrong coordinate is somebody's drawing. §59 of `docs/ARCHITECTURE.md` has the
 * argument for the split.
 */
function readView(v: unknown, now: SessionView): SessionView {
  const o = isObj(v) ? v : {};
  const bool = (k: keyof SessionView, d: boolean): boolean => (isBool(o[k]) ? (o[k] as boolean) : d);
  const num = (k: keyof SessionView, d: number): number => (isNum(o[k]) ? (o[k] as number) : d);
  return {
    tool: oneOf(TOOLS, o.tool) ? o.tool : now.tool,
    deleteMode: oneOf(DELETE_MODES, o.deleteMode) ? o.deleteMode : now.deleteMode,
    touchButtons: bool('touchButtons', now.touchButtons),
    gridStep: num('gridStep', now.gridStep),
    nudgeBig: num('nudgeBig', now.nudgeBig),
    wireframe: bool('wireframe', now.wireframe),
    filled: bool('filled', now.filled),
    showGrid: bool('showGrid', now.showGrid),
    showKeylines: bool('showKeylines', now.showKeylines),
    showHandles: bool('showHandles', now.showHandles),
    showRulers: bool('showRulers', now.showRulers),
    showGuides: bool('showGuides', now.showGuides),
    guidesLocked: bool('guidesLocked', now.guidesLocked),
    smartGuides: bool('smartGuides', now.smartGuides),
    snapToGrid: bool('snapToGrid', now.snapToGrid),
    snapToPoints: bool('snapToPoints', now.snapToPoints),
    snapToBoundary: bool('snapToBoundary', now.snapToBoundary),
    snapToIntersections: bool('snapToIntersections', now.snapToIntersections),
    snapToAngles: bool('snapToAngles', now.snapToAngles),
    pixelFit: bool('pixelFit', now.pixelFit),
    angleStep: num('angleStep', now.angleStep),
    angleBase: num('angleBase', now.angleBase),
    /* `null` is a value here rather than an absence: it means angles are
       measured from where the gesture started. So an explicit null is kept and
       anything else unreadable falls back, like every other field. */
    angleOrigin: readPt(o.angleOrigin) ?? (o.angleOrigin === null ? null : now.angleOrigin),
    decimals: num('decimals', now.decimals),
    minify: bool('minify', now.minify),
    sourceMode: oneOf(SOURCE_MODES, o.sourceMode) ? o.sourceMode : now.sourceMode,
    style: readStyle(o.style) ?? { ...now.style },
    polygon: readPolygon(o.polygon) ?? { ...now.polygon },
  };
}

/** What the polygon tool draws next. Clamped to the range the generator accepts. */
function readPolygon(v: unknown): SessionView['polygon'] | null {
  if (!isObj(v) || !isNum(v.corners) || !isNum(v.ratio) || !isBool(v.star)) return null;
  return { corners: clampCorners(v.corners), star: v.star, ratio: clampRatio(v.ratio) };
}

/**
 * Parse text into a session, or say why it is not one.
 *
 * Returns the reason as a string rather than throwing, because both callers
 * have somewhere to put a sentence and neither has anything useful to do with
 * a stack trace.
 */
export function read(text: string, now: SessionView): Session | string {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return 'that is not JSON';
  }
  if (!isObj(raw)) return 'that is not a workspace';
  if (raw.version !== SESSION_VERSION) {
    return `that workspace is version ${String(raw.version)}, and this build reads ${SESSION_VERSION}`;
  }
  const doc = readDoc(raw.doc);
  if (!doc) return 'the drawing in it is malformed';
  const guides = readGuides(raw.guides ?? []);
  if (!guides) return 'the guides in it are malformed';
  const palette = readPalette(raw.palette ?? []);
  if (!palette) return 'the saved styles in it are malformed';
  const camera = readBox(raw.camera) ?? { ...doc.viewBox };
  return { version: SESSION_VERSION, doc, camera, guides, palette, view: readView(raw.view, now) };
}
