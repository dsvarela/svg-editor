/**
 * The document model. §1 of `docs/ARCHITECTURE.md` argues both decisions.
 *
 * **A path is nodes, not commands.** A subpath is a ring or run of nodes, each
 * owning its anchor and up to two handles in absolute coordinates. Commands
 * exist only in `parse.ts` and `serialise.ts`.
 *
 * **A handle is `null` when its segment is straight**, never a control point
 * collapsed onto the anchor, so "is this a line?" is a boolean rather than a
 * float comparison and `L`/`H`/`V` serialise losslessly.
 */

/** A point in document space. Tuple, not {x,y}: cheaper to clone, maps cleanly over matrices. */
export type Pt = [number, number];

/** A cubic bezier: start, control 1, control 2, end. Used by geometry, never stored. */
export type Cubic = [Pt, Pt, Pt, Pt];

/**
 * How a node's two handles currently relate.
 *
 * This is DERIVED from the handles, never stored. A node is just a node; what
 * it does when you drag a handle follows from where its handles already are:
 *
 *  - `cusp`      handles missing, or not collinear -- they move independently
 *  - `smooth`    handles collinear, different lengths -- direction is shared
 *  - `symmetric` handles collinear and equal length -- fully mirrored
 *
 * **`cusp` and not `corner`**, which is what this was called and what Inkscape
 * calls it too. `cornerAt` in `model/ops.ts` asks a different question -- two
 * straight sides meeting, which is what Round can cut -- and the two answers
 * disagree constantly: a node with two curved sides pulling different ways is a
 * cusp with no corner to round, and a square's corner is roundable while having
 * no handles to be a cusp about. One word for both made the interface say
 * "Corner" beside a corner control that was not there.
 *
 * Storing a flag instead would let it disagree with the geometry: a file could
 * claim `smooth` while its handles sat at 90 degrees, and an imported path --
 * which has no such flag to import -- would read as all-cusp even where it is
 * visibly smooth. Deriving it means what you see is always what you get.
 */
export type NodeContinuity = 'cusp' | 'smooth' | 'symmetric';

/**
 * One anchor and its handles.
 *
 * `hIn` governs the segment ARRIVING at this node, `hOut` the segment LEAVING
 * it. Both are absolute document coordinates, not offsets from `pt` -- absolute
 * costs one add when moving an anchor but saves a conversion on every hit-test,
 * render and transform, which are far more frequent.
 */
export interface PathNode {
  /**
   * Identity that survives the array this node sits in.
   *
   * The selection used to name a node by `shape/subpath/index`, and every
   * operation that splices a node out moved the meaning of every index after
   * it. Each caller grew its own repair for that -- rebuild to the returned
   * index, drop the whole selection, or re-walk and delete what dangles -- and
   * the three did not agree. An id cannot go stale: a node that is gone
   * resolves to nothing, which is a case worth handling, rather than to
   * whichever node inherited its index, which is not.
   *
   * Preserved by `cloneNode`, so a selection still means the same nodes after
   * an undo. Never written into a file: it is identity within one session, not
   * a name for the geometry.
   */
  id: string;
  pt: Pt;
  /** Control point of the incoming segment. `null` means that segment is straight. */
  hIn: Pt | null;
  /** Control point of the outgoing segment. `null` means that segment is straight. */
  hOut: Pt | null;
}

/**
 * A contiguous run of nodes; one `M ... (Z)` in path-data terms.
 *
 * Segment `i` runs from `nodes[i]` to `nodes[i + 1]`. When `closed`, a final
 * segment wraps from the last node back to `nodes[0]` -- so a closed subpath
 * has `nodes.length` segments and an open one has `nodes.length - 1`. **There
 * is no duplicated closing node**, so nothing has to hand-sync one point held
 * in two places, and there is no way for the two copies to disagree.
 */
export interface Subpath {
  nodes: PathNode[];
  closed: boolean;
}

export interface Style {
  fill: string;
  stroke: string;
  strokeWidth: number;
  fillRule: 'nonzero' | 'evenodd';
  /**
   * How much of the shape shows through, 0 to 1. SVG's `opacity`.
   *
   * **One number, and deliberately not three.** SVG also has `fill-opacity` and
   * `stroke-opacity`, and every editor that offers all three has to explain
   * which one wins when they disagree: they multiply, so a shape at 50% with a
   * fill at 50% draws its fill at 25% and its stroke at 50%. That is a rule
   * about compositing, not about the drawing. One number composites the whole
   * shape and needs no rule. §60 of `docs/ARCHITECTURE.md` has the argument.
   *
   * A colour with alpha in it is the other way to say this, and is refused for
   * the same reason: `#ff000080` would put the fill's transparency somewhere the
   * stroke's could not follow, and the colour picker cannot show it.
   */
  opacity: number;
}

/** A drawable object: one `<path>` on export. */
export interface Shape {
  id: string;
  name: string;
  subpaths: Subpath[];
  style: Style;
  /**
   * The group this shape belongs to, or `null` for none.
   *
   * A parent pointer rather than a tree of children, so `Doc.shapes` stays the one
   * flat statement of paint order that everything else reads. §49 of
   * `docs/ARCHITECTURE.md` has the argument, and the invariant that goes with it:
   * the shapes of a group are contiguous in that array.
   */
  group?: string | null;
  /**
   * Not drawn, not exported as anything you can see, and not selectable.
   *
   * On the shape rather than beside the selection, which is the opposite call
   * from the lock (§66). A lock is about editing and cannot reach a file; this
   * is about the drawing, and SVG already spells it `display="none"`, so it
   * writes and reads back with no field the export has to remember.
   */
  hidden?: boolean;
}

/**
 * A named set of shapes, exported as one `<g>`.
 *
 * It carries no transform and no style. Transforms are baked into coordinates
 * everywhere here (§5), and a group that stored one would be the hidden coordinate
 * system §5 exists to refuse. So this is grouping as organisation: the shapes move
 * together because moving a selection moves everything in it, not because a matrix
 * above them changed.
 *
 * `parent` nests. Which shapes a group holds is not written here -- it is read off
 * `Shape.group`, so there is one statement of the relation and not two.
 */
export interface Group {
  id: string;
  name: string;
  parent: string | null;
  /** Not drawn, and nor is anything under it. `<g display="none">` on the way out. */
  hidden?: boolean;
}

export interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Doc {
  shapes: Shape[];
  viewBox: ViewBox;
  /**
   * Every group in the document, in no particular order.
   *
   * Order lives in `shapes`: a group's place in the paint order is the place of the
   * shapes in it. Optional so that a document written before groups existed, or a
   * fixture that has no use for them, still reads as a `Doc`.
   */
  groups?: Group[];
}

/* ---------------------------------------------------------------- helpers */

export const clonePt = (p: Pt): Pt => [p[0], p[1]];

export const clonePtOrNull = (p: Pt | null): Pt | null => (p ? [p[0], p[1]] : null);

export const cloneNode = (n: PathNode): PathNode => ({
  id: n.id,
  pt: clonePt(n.pt),
  hIn: clonePtOrNull(n.hIn),
  hOut: clonePtOrNull(n.hOut),
});

let nodeSeq = 0;

/** A fresh node identity. Unique within the session, and meaningless outside it. */
export const nextNodeId = (): string => `n${++nodeSeq}`;

/**
 * Move the counter past an id that arrived from outside this session.
 *
 * The counter starts at zero on a fresh page, so a document restored from
 * storage or opened from a workspace file brings ids the counter is about to
 * hand out again. The first node drawn after a restore would be `n1` for the
 * second time, and §46's rule is that an id naming two nodes is two nodes no
 * selection can separate. `reserveIds` in `model/doc.ts` walks a whole document
 * through this and its own counter.
 */
export function reserveNodeId(id: string): void {
  const m = /^n(\d+)$/.exec(id);
  if (m) nodeSeq = Math.max(nodeSeq, Number(m[1]));
}

/** Convenience constructor; most nodes are born with no handles. */
export const makeNode = (pt: Pt, hIn: Pt | null = null, hOut: Pt | null = null): PathNode => ({
  id: nextNodeId(),
  pt,
  hIn,
  hOut,
});

/**
 * Angular slack, in radians, for calling two handles collinear.
 *
 * Not an epsilon on the raw numbers: a rotation is exact in theory and only
 * nearly exact in floating point, so a hand-mirrored pair that survives a
 * rotate-and-bake would fail a tight test and the node would silently turn into
 * a cusp. 1e-4 rad is ~0.006 degrees -- far below anything a person could
 * place by eye, far above the drift a few baked transforms introduce.
 */
const COLLINEAR_TOL = 1e-4;

/** Relative slack for calling two handle lengths equal. */
const LENGTH_TOL = 1e-6;

/**
 * Read a node's continuity off its geometry.
 *
 * The two vectors compared both point "forward" along the path: from `hIn`
 * towards the anchor, and from the anchor towards `hOut`. For a smooth node
 * they are parallel and same-signed, which is why an anti-parallel pair (a
 * cusp folded back on itself) correctly reads as one rather than as a perfectly
 * smooth node.
 */
export function continuityOf(n: PathNode): NodeContinuity {
  const { pt, hIn, hOut } = n;
  if (!hIn || !hOut) return 'cusp';

  const ax = pt[0] - hIn[0];
  const ay = pt[1] - hIn[1];
  const bx = hOut[0] - pt[0];
  const by = hOut[1] - pt[1];

  const la = Math.hypot(ax, ay);
  const lb = Math.hypot(bx, by);
  if (la < 1e-12 || lb < 1e-12) return 'cusp';

  if ((ax * bx + ay * by) / (la * lb) <= 0) return 'cusp';
  if (Math.abs((ax * by - ay * bx) / (la * lb)) > COLLINEAR_TOL) return 'cusp';

  return Math.abs(la - lb) <= LENGTH_TOL * Math.max(la, lb) ? 'symmetric' : 'smooth';
}

export const cloneSubpath = (s: Subpath): Subpath => ({
  nodes: s.nodes.map(cloneNode),
  closed: s.closed,
});

export const cloneGroup = (g: Group): Group => ({ ...g });

export const cloneShape = (s: Shape): Shape => ({
  id: s.id,
  name: s.name,
  subpaths: s.subpaths.map(cloneSubpath),
  style: { ...s.style },
  // Carried, so a shape survives a history snapshot still in its group. A copy that
  // is going to live beside its original clears it instead -- see `paste` -- because
  // a copy lands at the end of the paint order and a group's shapes have to be
  // contiguous.
  ...(s.group ? { group: s.group } : {}),
  ...(s.hidden ? { hidden: true } : {}),
});

/** Number of segments in a subpath. Closed subpaths have one more than open. */
export const segmentCount = (s: Subpath): number =>
  s.nodes.length < 2 ? 0 : s.closed ? s.nodes.length : s.nodes.length - 1;

/** Index of the node that segment `i` ends at, wrapping for closed subpaths. */
export const endNodeIndex = (s: Subpath, i: number): number => (i + 1) % s.nodes.length;

/**
 * Reconstruct segment `i` as a cubic.
 *
 * A straight segment (both governing handles `null`) is widened into a cubic so
 * geometry code can treat every segment identically, while the model still
 * remembers it was a line.
 *
 * **A line's controls go on the thirds, so `t` is the fraction along it**, which
 * is what `splitSegment` means by `t` and what every caller assumes. On the
 * endpoints, the obvious reading of a `null` handle, the same line is
 * parameterised `3t^2 - 2t^3` and the two disagree everywhere but the middle.
 * §69.
 *
 * A half-collapsed segment, one handle `null` and the other not, is left alone:
 * that is a curve somebody drew, and moving its live control would change the
 * shape.
 */
export function segmentAsCubic(s: Subpath, i: number): Cubic {
  const a = s.nodes[i];
  const b = s.nodes[endNodeIndex(s, i)];
  if (a.hOut === null && b.hIn === null) {
    const dx = b.pt[0] - a.pt[0];
    const dy = b.pt[1] - a.pt[1];
    return [
      clonePt(a.pt),
      [a.pt[0] + dx / 3, a.pt[1] + dy / 3],
      [a.pt[0] + (dx * 2) / 3, a.pt[1] + (dy * 2) / 3],
      clonePt(b.pt),
    ];
  }
  return [clonePt(a.pt), clonePt(a.hOut ?? a.pt), clonePt(b.hIn ?? b.pt), clonePt(b.pt)];
}

/** True when segment `i` is a straight line rather than a curve. */
export function segmentIsLine(s: Subpath, i: number): boolean {
  return s.nodes[i].hOut === null && s.nodes[endNodeIndex(s, i)].hIn === null;
}

/**
 * The join and cap every stroke is drawn with.
 *
 * Not fields on `Style`, because no control writes them: a style field nothing
 * can set drifts from what is drawn and gives the export a value to disagree
 * with. They are named here rather than written inline because the canvas and
 * the exporter both have to say them, and while only the canvas did, a stroke
 * rendered round on screen and mitred in the saved file.
 */
export const STROKE_JOIN = 'round';
export const STROKE_CAP = 'round';

/**
 * How many decimals an exported `opacity` keeps.
 *
 * Its own number, deliberately not the serialiser's `decimals`. That setting is
 * offered from 0 and is described as trading file size against a coarser shape,
 * which is a true statement about coordinates and a false one about opacity: at
 * 0 decimals every shape below half opacity rounded to `opacity="0"` and was
 * invisible in the saved file. Three is more than a percentage typed as a whole
 * number can need, which is all the panel produces.
 */
export const OPACITY_DECIMALS = 3;

/**
 * Distance below which two anchors are one anchor.
 *
 * The cases this decides put the two points at bit-identical coordinates, so
 * `===` would answer them. It is still the wrong test: a rounded rectangle one
 * ulp wider than twice its radius misses the clamp and leaves the two ends of
 * its vanished side 4.4e-16 apart, and both get emitted. What that costs is a
 * zero-length command in the exported path, and a path carrying one can never
 * be simplified again, because a zero chord gives the fitter no tangent to work
 * from. Exactness is the wrong test for a predicate about geometry.
 *
 * Named here because three modules ask it -- the rounded-rectangle generator,
 * the fillet, and the offset's merge of fitted curve ends -- and two of them
 * had spelled it out separately under the same name. Not `DEGENERATE` in
 * `ops.ts`, which is deliberately looser and says why.
 */
export const MEET = 1e-9;

export const defaultStyle = (): Style => ({
  fill: 'none',
  stroke: '#2563d8',
  strokeWidth: 1,
  fillRule: 'nonzero',
  opacity: 1,
});

/**
 * Below this, two coordinates are the same place.
 *
 * Not a tolerance on any operation: it is the width of the arithmetic. Moving a
 * point to a target computed from it lands within an ulp of the target rather
 * than on it, so an operation asked whether it moved anything answers yes to a
 * residue of about 1e-14 at the scale this editor works at. Document
 * coordinates are tens to hundreds of units and the serialiser stops at nine
 * decimals, so nothing this size can reach a file or a screen.
 *
 * Shared by `alignNodes`/`distributeNodes` in `model/ops.ts` and by
 * `translateUnit` in `model/arrange.ts`, which had a copy each with the same
 * eight-line argument written out twice.
 */
export const SAME_PLACE = 1e-9;
