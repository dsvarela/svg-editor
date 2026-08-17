/**
 * The document model.
 *
 * The single decision that shapes everything else: a path is stored as NODES,
 * not as commands.
 *
 * yqnn's editor stores an array of command objects (MoveTo, CurveTo,
 * EllipticalArcTo...) and derives point positions by walking the whole path.
 * That is why its UI is a command table -- the model *is* a command table.
 * It also means every geometric operation has to special-case ten command
 * types (see its 28-line `EllipticalArcTo.scale` doing conic-section algebra
 * just to keep an ellipse an `A` command).
 *
 * Here, a subpath is a ring/run of nodes. Each node owns its anchor point and
 * up to two handles in ABSOLUTE coordinates. Commands exist only in `parse.ts`
 * (on the way in) and `serialise.ts` (on the way out). Nothing in between
 * knows they exist, so:
 *
 *   - transforms are one matrix applied to every point, no special cases;
 *   - there is no relative/absolute distinction to carry around;
 *   - arcs and shorthands cannot desynchronise from what is drawn.
 *
 * The second decision: a handle is `null` when the segment it governs is
 * straight, rather than a control point collapsed onto its anchor. This keeps
 * "is this segment a line?" an exact boolean instead of a float comparison,
 * which is what lets the serialiser emit `L`/`H`/`V` losslessly.
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
 *  - `corner`    handles missing, or not collinear -- they move independently
 *  - `smooth`    handles collinear, different lengths -- direction is shared
 *  - `symmetric` handles collinear and equal length -- fully mirrored
 *
 * Storing a flag instead would let it disagree with the geometry: a file could
 * claim `smooth` while its handles sat at 90 degrees, and an imported path --
 * which has no such flag to import -- would read as all-corner even where it is
 * visibly smooth. Deriving it means what you see is always what you get.
 */
export type NodeContinuity = 'corner' | 'smooth' | 'symmetric';

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
  /**
   * Keep re-deriving this node's handles from its neighbours.
   *
   * The one piece of stored node state in the whole model, and §6 argues at
   * length against exactly this. It earns the exception because it is not a
   * claim about the geometry -- which is what a stored `smooth` flag is, and
   * what can disagree with the handles -- but an instruction about the future.
   * "These handles are collinear" is checkable and so must be derived; "keep
   * recomputing me when a neighbour moves" is not something any arrangement of
   * control points can express.
   *
   * Optional, and absent on almost every node. It is never exported: a file has
   * no way to say it, and reading one back gives ordinary handles in exactly
   * the positions the auto node had computed.
   */
  auto?: boolean;
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
  ...(n.auto ? { auto: true } : {}),
});

let nodeSeq = 0;

/** A fresh node identity. Unique within the session, and meaningless outside it. */
export const nextNodeId = (): string => `n${++nodeSeq}`;

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
 * a corner. 1e-4 rad is ~0.006 degrees -- far below anything a person could
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
 * cusp folded back on itself) correctly reads as a corner rather than as a
 * perfectly smooth node.
 */
export function continuityOf(n: PathNode): NodeContinuity {
  const { pt, hIn, hOut } = n;
  if (!hIn || !hOut) return 'corner';

  const ax = pt[0] - hIn[0];
  const ay = pt[1] - hIn[1];
  const bx = hOut[0] - pt[0];
  const by = hOut[1] - pt[1];

  const la = Math.hypot(ax, ay);
  const lb = Math.hypot(bx, by);
  if (la < 1e-12 || lb < 1e-12) return 'corner';

  if ((ax * bx + ay * by) / (la * lb) <= 0) return 'corner';
  if (Math.abs((ax * by - ay * bx) / (la * lb)) > COLLINEAR_TOL) return 'corner';

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
});

/** Number of segments in a subpath. Closed subpaths have one more than open. */
export const segmentCount = (s: Subpath): number =>
  s.nodes.length < 2 ? 0 : s.closed ? s.nodes.length : s.nodes.length - 1;

/** Index of the node that segment `i` ends at, wrapping for closed subpaths. */
export const endNodeIndex = (s: Subpath, i: number): number => (i + 1) % s.nodes.length;

/**
 * Reconstruct segment `i` as a cubic.
 *
 * A straight segment (both governing handles `null`) is widened into a cubic
 * with its controls on the endpoints. Geometry code can then treat every
 * segment identically, while the model still remembers it was a line.
 */
export function segmentAsCubic(s: Subpath, i: number): Cubic {
  const a = s.nodes[i];
  const b = s.nodes[endNodeIndex(s, i)];
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
});
