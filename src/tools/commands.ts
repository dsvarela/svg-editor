/**
 * What a button, a menu item or a shortcut does to the document.
 *
 * Every method here answers the same question -- the user asked for this, is
 * there anything to do, and what should the status line say -- and none of them
 * knows a pointer exists. That is the line between this file and
 * `controller.ts`: a gesture is a thing with a beginning, a middle and an end,
 * and a command is a thing that either happens or is declined with a reason.
 *
 * They are peers, not layers. `main.ts` holds both. A command that forwarded to
 * the controller would be a layer that changes no vocabulary, and the one fact
 * that genuinely crosses -- whether a drag is under way -- arrives as `busy`.
 */

import { about, flipX, flipY, rotate as rotMat, translate } from '../core/affine';
import type { Mat } from '../core/affine';
import { reasonFor } from '../core/parse';
import { cloneNode, cloneShape, cloneSubpath, continuityOf, segmentCount } from '../core/types';
import type { Group, NodeContinuity, PathNode, Pt, Shape, Style, Subpath } from '../core/types';
import {
  docBBox,
  emptySelection,
  findGroup,
  findShape,
  groupChain,
  makeShape,
  pruneGroups,
  nextId,
  reidentify,
  selectedNodes,
  selectedRefs,
  selectedSubpaths,
  selectedShapes,
  shapesInGroup,
  selectionBBox,
} from '../model/doc';
import type { HandlePart, NodeRef } from '../model/doc';
import {
  alignNodes,
  breakAt,
  deleteNode,
  deleteNodesSplitting,
  distributeNodes,
  connectEnds,
  fuseDegenerate,
  fuseNodes,
  isPathEnd,
  mergeEnds,
  latentHandle,
  moveAnchor,
  moveHandle,
  reverseSubpath,
  setContinuity,
  setSegmentBend,
  segmentBend,
  setSegmentCurved,
  snap as snapTo,
  captureNodes,
  transformCaptured,
  splitSegment,
  transformShape,
} from '../model/ops';
import {
  roundCorner,
  sharedCornerRadius,
  unroundCorner,
} from '../model/corner';
import type {
  AlignMode,
  FuseRefusal,
} from '../model/ops';
import type {
  RoundRefusal,
} from '../model/corner';
import {
  alignUnits,
  arrangeUnits,
  distributeUnits,
  dropShapes,
  reorderShapes,
  spaceUnits,
  unitsBox,
  viewBoxAsBox,
} from '../model/arrange';
import type { AlignTo, Unit, ZMove } from '../model/arrange';
import type { Box } from '../core/bezier';
import { simplifySubpath } from '../model/simplify';
import { invisibleAt, keepOnly, reduceToCount, removeRedundantNodes } from '../model/knots';
import { phaseInForce, phaseLabel } from '../model/pixelfit';
import { offsetSubpath, strokeOutline } from '../core/offset';
import { addGuide } from '../model/guides';
import type { GuideAxis } from '../model/guides';
import { traceImage } from '../model/trace';
import type { Placement, TraceOptions, TraceResult } from '../model/trace';
import type { RasterLike } from '../core/raster';
import { BOOLEAN_LABEL, booleanShapes, booleanSubpaths } from '../io/boolean';
import type { BooleanOp } from '../io/boolean';
import { FLAT, referencePoint } from '../model/transform';
import type { Store } from '../model/store';
import type { Bend } from '../core/bend';
import { fmt } from './readout';

/**
 * Whether two subpaths are the same geometry, node for node.
 *
 * Ids are deliberately not compared: un-rounding a corner and rounding it again
 * mints new nodes for the two tangent points, so a path that is geometrically
 * unchanged is never identical by identity. Positions and handles are what a
 * person can see, and they are what decides whether an edit happened.
 */
function samePath(a: Subpath, b: Subpath): boolean {
  if (a.closed !== b.closed || a.nodes.length !== b.nodes.length) return false;
  const near = (p: Pt | null, q: Pt | null): boolean =>
    p === null || q === null ? p === q : Math.abs(p[0] - q[0]) < 1e-9 && Math.abs(p[1] - q[1]) < 1e-9;
  return a.nodes.every((n, i) => {
    const m = b.nodes[i];
    return near(n.pt, m.pt) && near(n.hIn, m.hIn) && near(n.hOut, m.hOut);
  });
}

/**
 * How closely a fitted outline has to follow the curve it was derived from.
 *
 * The document's own precision, because fitting finer than the serialiser will
 * write is work nobody can see. Floored at 0.01, which is where a fitter stops
 * converging on real geometry and starts spending nodes on rounding.
 *
 * Not the tolerance knot removal uses. That one is `invisibleAt` with no floor,
 * by the argument at `simplifySelection`: it deletes nodes rather than placing
 * them, so anything the file cannot record is free to go.
 */
const outlineTolerance = (decimals: number): number => Math.max(invisibleAt(decimals), 0.01);

export class Commands {
  /** Where user-facing notices go. Set by the wiring, left unset in tests. */
  onMessage: ((message: string, ok: boolean) => void) | null = null;

  /**
   * What a paste would put back. Deliberately not in the store.
   *
   * The store's state is the document plus what is being looked at, and all of it
   * is snapshotted by history. A clipboard is neither: undoing a paste must not
   * empty it, and copying is not something to undo. Held here for the life of the
   * page, which is also the life of the editor's session.
   */
  private clipboard: Shape[] = [];

  /** How many times the current clipboard has been pasted, so each lands clear of the last. */
  private pastes = 0;

  constructor(
    private store: Store,
    /**
     * Whether a gesture is in progress.
     *
     * A toolbar button can be reached mid-drag -- by a second finger on a
     * touchscreen, or by a click while a capture was lost -- and an edit landing
     * on the checkpoint the drag is standing on makes the drag roll back
     * somebody else's work when it ends. Asked as a function because the answer
     * changes between the wiring and the press.
     */
    private busy: () => boolean,
  ) {}

  /** Place a guide by number, which is the keyboard-and-button route. */
  addGuideAt(axis: GuideAxis, at: number): boolean {
    const ok = this.store.tryEdit((st) => {
      const made = addGuide(st.guides, { axis, at });
      if (made) st.showGuides = true;
      return made;
    });
    this.onMessage?.(
      ok
        ? `Guide at ${axis} = ${fmt(at)}.`
        : `There is already a guide at ${axis} = ${fmt(at)}.`,
      ok,
    );
    return ok;
  }

  /* -------------------------------------------- the path a selection draws */

  /**
   * Draw a path parallel to each selected shape, at a distance.
   *
   * A new shape rather than a change to the old one: the original is almost
   * always still wanted -- an outline and its offset are a pair -- and an
   * operation that consumes its input to produce a near-copy is one undo away
   * from being useless and one step away from being a duplicate.
   */
  offsetSelection(d: number): boolean {
    const shapes = selectedShapes(this.store.state.doc, this.store.state.selection);
    if (!shapes.length) {
      this.onMessage?.('Select a shape to offset.', false);
      return false;
    }
    if (!Number.isFinite(d) || d === 0) {
      this.onMessage?.('Offset by how far? Zero is the shape you already have.', false);
      return false;
    }

    const made: string[] = [];
    let refused = 0;
    const ok = this.store.tryEdit((st) => {
      for (const shape of shapes) {
        const live = findShape(st.doc, shape.id);
        if (!live) continue;
        const tol = outlineTolerance(st.decimals);
        /* Flattened, because one subpath can offset into several: an inward
           offset of a notched shape comes apart into pieces, and each is a
           path of the same shape. */
        const subpaths = live.subpaths.flatMap((sp) => offsetSubpath(sp, d, tol) ?? []);
        if (!subpaths.length) {
          refused++;
          continue;
        }
        const next = makeShape(subpaths, `${live.name} offset`, live.style);
        st.doc.shapes.push(next);
        made.push(next.id);
      }
      if (!made.length) return false;
      st.selection = emptySelection();
      for (const id of made) st.selection.shapes.add(id);
      return true;
    });

    if (ok) {
      this.onMessage?.(
        `Offset ${made.length} ${made.length === 1 ? 'shape' : 'shapes'} by ${fmt(d)}.` +
          (refused ? ` ${refused} had no direction to offset along.` : ''),
        true,
      );
    } else {
      this.onMessage?.('Nothing there could be offset.', false);
    }
    return ok;
  }

  /**
   * Turn the selected shapes' strokes into filled outlines.
   *
   * The width comes from each shape's own style, so a 1-unit stroke cannot
   * become a 4-unit outline. The result replaces the original, filled with the
   * stroke's colour. No stroke is refused, not skipped. §40.
   */
  strokeToPath(cap: 'butt' | 'round' = 'butt'): boolean {
    const shapes = selectedShapes(this.store.state.doc, this.store.state.selection);
    if (!shapes.length) {
      this.onMessage?.('Select a shape to outline.', false);
      return false;
    }

    let done = 0;
    let noStroke = 0;
    let refused = 0;
    const ok = this.store.tryEdit((st) => {
      for (const shape of shapes) {
        const live = findShape(st.doc, shape.id);
        if (!live) continue;
        if (live.style.stroke === 'none' || !(live.style.strokeWidth > 0)) {
          noStroke++;
          continue;
        }
        const tol = outlineTolerance(st.decimals);
        const subpaths = live.subpaths.flatMap(
          (sp) => strokeOutline(sp, live.style.strokeWidth, cap, tol) ?? [],
        );
        if (!subpaths.length) {
          refused++;
          continue;
        }
        live.subpaths = subpaths;
        /* The outline is the stroke, so it is filled with the stroke's colour
           and stops being stroked itself. `evenodd` is what makes a closed
           path's two contours read as a band rather than a filled disc. */
        live.style = {
          ...live.style,
          fill: live.style.stroke,
          stroke: 'none',
          fillRule: 'evenodd',
        };
        done++;
      }
      return done > 0;
    });

    if (ok) {
      this.onMessage?.(
        `Outlined ${done} ${done === 1 ? 'shape' : 'shapes'}.` +
          (noStroke ? ` ${noStroke} had no stroke to outline.` : '') +
          (refused ? ` ${refused} came apart and were left alone.` : ''),
        true,
      );
    } else if (noStroke) {
      this.onMessage?.('That shape has no stroke to turn into a path.', false);
    } else {
      this.onMessage?.('That outline comes apart; nothing was changed.', false);
    }
    return ok;
  }

  /* ------------------------------------------------- which nodes there are */

  /**
   * Step the node selection along the path.
   *
   * The gap a keyboard survey cannot see. Every control in the Node panel is
   * reachable by Tab and every one acts on the selected nodes, so without a way
   * to select a node from the keyboard the whole panel is pointer-only however
   * tabbable its buttons are. This is that way.
   *
   * With a shape selected and no nodes, it takes the first. With one node it
   * moves. `extend` adds instead of replacing, which is how you get the two
   * adjacent nodes that Insert node and Fuse want.
   */
  stepNodeSelection(by: 1 | -1, extend = false): boolean {
    const s = this.store.state;
    const refs = selectedNodes(s.doc, s.selection);

    // Nothing chosen yet: start at the first node of the first selected shape.
    if (!refs.length) {
      const id = [...s.selection.shapes][0];
      const sp = id ? findShape(s.doc, id)?.subpaths[0] : null;
      if (!id || !sp?.nodes.length) {
        this.onMessage?.('Select a shape or a node first.', false);
        return false;
      }
      this.store.update((st) => {
        st.selection.nodes.clear();
        st.selection.nodes.add(sp.nodes[by > 0 ? 0 : sp.nodes.length - 1].id);
      });
      return true;
    }

    /* From the last one added, which is the one a run of presses is walking.
       Taking the lowest index instead would make Shift-extend collapse back on
       itself the moment the run passed a node with a smaller index. */
    const from = refs[refs.length - 1];
    const sp = findShape(s.doc, from.shape)?.subpaths[from.sp];
    if (!sp?.nodes.length) return false;

    const n = sp.nodes.length;
    /* Wrapping on a closed path and stopping at the ends of an open one, which
       is what the path itself does: there is no node past the end of an open
       path to step to. */
    let next = from.i + by;
    if (sp.closed) next = (next + n) % n;
    else if (next < 0 || next >= n) {
      this.onMessage?.(`That is the ${by > 0 ? 'last' : 'first'} node of the path.`, false);
      return false;
    }

    const key = sp.nodes[next].id;
    this.store.update((st) => {
      if (!extend) st.selection.nodes.clear();
      // Re-adding moves it to the end of the set, so a run of presses keeps
      // walking from where it just arrived rather than from where it started.
      st.selection.nodes.delete(key);
      st.selection.nodes.add(key);
      st.selection.shapes.clear();
    });
    return true;
  }

  /**
   * Insert a node in the middle of the selected segment.
   *
   * Double-clicking the outline already does this and needs a pointer to aim.
   * Two adjacent selected nodes name a segment exactly, so this is the same
   * operation with the keyboard's way of saying where.
   */
  insertInSelection(): boolean {
    const s = this.store.state;
    const refs = selectedNodes(s.doc, s.selection);
    if (refs.length !== 2 || refs[0].shape !== refs[1].shape || refs[0].sp !== refs[1].sp) {
      this.onMessage?.('Select the two nodes either side of a segment.', false);
      return false;
    }
    const sp = findShape(s.doc, refs[0].shape)?.subpaths[refs[0].sp];
    if (!sp) return false;

    const n = sp.nodes.length;
    const a = Math.min(refs[0].i, refs[1].i);
    const b = Math.max(refs[0].i, refs[1].i);
    /* Adjacent, or the pair that wraps: on a closed path the last node and the
       first are neighbours too, and that segment has as much right to a node
       as any other. */
    const seg = b - a === 1 ? a : sp.closed && a === 0 && b === n - 1 ? n - 1 : -1;
    if (seg < 0) {
      this.onMessage?.('Those two nodes are not the ends of one segment.', false);
      return false;
    }

    let at = -1;
    const ok = this.store.tryEdit((st) => {
      const live = findShape(st.doc, refs[0].shape)?.subpaths[refs[0].sp];
      if (!live) return false;
      at = splitSegment(live, seg, 0.5);
      if (at < 0) return false;
      st.selection.nodes.clear();
      st.selection.nodes.add(live.nodes[at].id);
      return true;
    });
    this.onMessage?.(ok ? 'Node inserted, and the curve is unchanged.' : 'Nothing to insert into.', ok);
    return ok;
  }

  /* ------------------------------------------------------- rays and guides */

  /**
   * Pin the rays to the middle of the selection, or report that there is none.
   *
   * Not an edit: where the rays come from is a property of how you are working,
   * not of the drawing, so it records no undo step -- the same reasoning that
   * keeps the grid step and the style-for-new-shapes out of the history.
   */
  setAngleOrigin(): boolean {
    const s = this.store.state;
    const box = selectionBBox(s.doc, s.selection);
    if (!box) {
      this.onMessage?.('Select something to put the origin on.', false);
      return false;
    }
    const at: Pt = [(box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2];
    this.store.update((st) => {
      st.angleOrigin = [at[0], at[1]];
      st.snapToAngles = true;
    });
    this.onMessage?.(`Angles from ${fmt(at[0])}, ${fmt(at[1])}.`, true);
    return true;
  }

  /** Back to radiating from wherever the gesture starts. */
  clearAngleOrigin(): void {
    this.store.update((st) => (st.angleOrigin = null));
    this.onMessage?.('Angles from wherever a gesture starts.', true);
  }

  /** Remove every guide, in one undo step. */
  clearGuides(): boolean {
    const n = this.store.state.guides.length;
    const ok = this.store.tryEdit((st) => {
      st.guides = [];
      return n > 0;
    });
    if (ok) this.onMessage?.(`Removed ${n} ${n === 1 ? 'guide' : 'guides'}.`, true);
    return ok;
  }

  /**
   * Reduce the selected paths to a node count.
   *
   * The other question the same machinery answers. `Within` asks what can go
   * for a given cost; this asks what goes first, and stops when the count is
   * right. It reports how far the drawing moved rather than promising it did
   * not, because at a low enough count it certainly did.
   */
  simplifyToCount(target: number): boolean {
    if (!Number.isFinite(target) || target < 2) {
      this.onMessage?.('Keep how many? Two is the fewest a path can have.', false);
      return false;
    }
    const s = this.store.state;
    const targets = selectedSubpaths(s.doc, s.selection);
    if (!targets.size) {
      this.onMessage?.('Select a shape, or some of its nodes, first.', false);
      return false;
    }

    let paths = 0;
    let before = 0;
    let after = 0;
    let moved = 0;
    const ok = this.store.tryEdit((st) => {
      for (const [id, sps] of targets) {
        const shape = findShape(st.doc, id);
        for (const i of sps) {
          const sp = shape?.subpaths[i];
          if (!sp) continue;
          const r = reduceToCount(sp, target);
          if (r.after === r.before) continue;
          paths++;
          before += r.before;
          after += r.after;
          moved = Math.max(moved, r.cost);
        }
      }
      if (paths) st.selection.nodes.clear();
      return paths > 0;
    });

    this.onMessage?.(
      ok
        ? `Kept ${after} of ${before} nodes across ${paths} ${paths === 1 ? 'path' : 'paths'}. Nothing moved further than ${fmt(moved)}.`
        : 'Those paths are already at or below that many nodes.',
      ok,
    );
    return ok;
  }

  /**
   * Remove everything except the selected nodes.
   *
   * The same run again, with the stopping condition replaced by a set. A
   * separate operation rather than a mode on Simplify: selecting nodes already
   * means "work within these", and one gesture cannot also mean "keep these"
   * without the other reading quietly changing under anyone who relied on it.
   */
  keepSelectedNodes(): boolean {
    const s = this.store.state;
    const refs = selectedNodes(s.doc, s.selection);
    if (refs.length < 2) {
      this.onMessage?.('Select the nodes to keep. Two is the fewest a path can have.', false);
      return false;
    }

    // Grouped by the subpath they belong to; a path with none selected is left
    // alone rather than reduced to nothing.
    const byPath = new Map<string, { shape: string; sp: number; keep: Set<number> }>();
    for (const r of refs) {
      const key = `${r.shape}/${r.sp}`;
      const entry = byPath.get(key);
      if (entry) entry.keep.add(r.i);
      else byPath.set(key, { shape: r.shape, sp: r.sp, keep: new Set([r.i]) });
    }

    let paths = 0;
    let before = 0;
    let after = 0;
    let moved = 0;
    let tooFew = 0;
    const ok = this.store.tryEdit((st) => {
      for (const { shape, sp: spI, keep } of byPath.values()) {
        const sp = findShape(st.doc, shape)?.subpaths[spI];
        if (!sp) continue;
        if (keep.size < (sp.closed ? 3 : 2)) {
          tooFew++;
          continue;
        }
        const r = keepOnly(sp, keep);
        if (r.after === r.before) continue;
        paths++;
        before += r.before;
        after += r.after;
        moved = Math.max(moved, r.cost);
      }
      if (paths) st.selection.nodes.clear();
      return paths > 0;
    });

    this.onMessage?.(
      ok
        ? `Kept ${after} of ${before} nodes across ${paths} ${paths === 1 ? 'path' : 'paths'}. Nothing moved further than ${fmt(moved)}.`
        : tooFew
          ? 'A closed path needs three nodes kept, and an open one two.'
          : 'Nothing else could go.',
      ok,
    );
    return ok;
  }

  /**
   * Refit the selected subpaths with as few nodes as the tolerance allows.
   *
   * The selection is dropped afterwards. Node selections are keyed by index,
   * and after a refit index 7 is a different point on the drawing than the one
   * that was highlighted a moment ago; keeping them would leave the panel
   * editing coordinates nobody chose.
   */
  simplifySelection(tol: number, redraw = false): boolean {
    if (!(tol >= 0) || !Number.isFinite(tol)) {
      this.onMessage?.('Within has to be a number, and not a negative one.', false);
      return false;
    }

    const s = this.store.state;
    const targets = selectedSubpaths(s.doc, s.selection);
    if (!targets.size) {
      this.onMessage?.('Select a shape, or some of its nodes, first.', false);
      return false;
    }

    /* Zero is a real value, not a refusal. It says "move nothing", and the
       budget that honours it is the export precision: a node whose removal
       cannot change a character of the saved file has moved nothing that can
       be observed. Making the tolerance continuous down to zero is what let
       three modes collapse into one number and one checkbox. */
    const floor = invisibleAt(this.store.state.decimals);
    const budget = tol > 0 ? Math.max(tol, floor) : floor;

    let paths = 0;
    let before = 0;
    let after = 0;
    let error = 0;
    this.store.tryEdit((st) => {
      for (const [id, sps] of targets) {
        const shape = findShape(st.doc, id);
        for (const i of sps) {
          const sp = shape?.subpaths[i];
          if (!sp) continue;

          /* Knot removal first in every mode. It takes out what is provably
             free, so the refit is only ever asked to approximate the nodes
             that are actually carrying the shape. Running it after would be
             pointless: a refit leaves nothing redundant behind. */
          const k = removeRedundantNodes(sp, budget);
          let n = k.after;
          let moved = k.cost;

          // Refitting needs a budget to fit inside. At zero there is none, and
          // the checkbox is disabled in the panel for the same reason.
          if (redraw && tol > 0) {
            const r = simplifySubpath(sp, tol);
            if (r) {
              n = r.after;
              moved = Math.max(moved, r.error);
            }
          }

          if (n === k.before) continue;
          paths++;
          before += k.before;
          after += n;
          error = Math.max(error, moved);
        }
      }
      if (paths) st.selection = emptySelection();
      return paths > 0;
    });

    if (!paths) {
      this.onMessage?.(
        tol > 0
          ? 'Nothing to simplify. Raise Within to give up more of the shape.'
          : 'Every node here is carrying the shape. Raise Within to remove some anyway.',
        false,
      );
      return false;
    }

    const dp = (v: number): string => (+v.toFixed(3)).toString();
    this.onMessage?.(
      `Simplified ${paths} path${paths === 1 ? '' : 's'}: ${before} nodes to ${after}. ` +
        `Nothing moved further than ${dp(error)}.`,
      true,
    );
    return true;
  }

  /**
   * Round the selected corners with an arc of `radius`.
   *
   * Each rounded corner becomes two nodes, so the indices after it all shift.
   * Working from the highest index down means the ones still to do keep the
   * positions they were found at, which is the whole reason this is not a loop
   * over the selection in the order the selection happens to iterate.
   *
   * The selection is dropped afterwards, for the same reason Simplify drops it:
   * the node that was index 3 is a different point now.
   */
  roundSelection(radius: number): boolean {
    if (!(radius > 0)) {
      this.onMessage?.('Round needs a radius above zero.', false);
      return false;
    }

    const s = this.store.state;
    /* `selectedNodes`, not `selectedRefs`: a selected shape means all of its
       nodes here, the same rule a corner control dragged with nothing picked out
       follows. Reading the node selection alone made Round the one operation in
       the rail that answered "select one or more nodes" to a selected shape. */
    /* By id rather than by index, because both of the things below splice nodes:
       un-rounding a corner replaces a pair with one node, and rounding it
       replaces one with a pair. An index is true at the instant it was read
       (§46), and the drag has always worked this way. */
    const byPath = new Map<string, string[]>();
    for (const r of selectedNodes(s.doc, s.selection)) {
      const id = findShape(s.doc, r.shape)?.subpaths[r.sp]?.nodes[r.i]?.id;
      if (!id) continue;
      const k = `${r.shape}/${r.sp}`;
      byPath.set(k, [...(byPath.get(k) ?? []), id]);
    }
    if (!byPath.size) {
      this.onMessage?.('Select a shape, or some of its nodes, to round.', false);
      return false;
    }

    /* A corner that already holds an arc goes back to being a corner before it
       can be rounded to a different radius. The arc left a smooth node at each
       end and neither is a cusp, so `cornerAt` reports no corner there and the
       radius field would be dead on anything the drag had already rounded and
       on every rectangle drawn with one. The drag does the same on a copy at
       the press.

       The limit is measured on the un-rounded copy too. An existing fillet has
       already eaten into the sides it sits between, so a limit read off the
       live path is the room left beside the arc rather than the room the corner
       has. */
    const sharpen = (sp: Subpath, ids: readonly string[]): string[] => {
      const kept: string[] = [];
      for (const id of ids) {
        const at = sp.nodes.findIndex((n) => n.id === id);
        /* Gone: un-rounding an earlier corner consumed this node as the other
           half of its pair. */
        if (at < 0) continue;
        kept.push(sp.nodes[unroundCorner(sp, at) ?? at].id);
      }
      return kept;
    };

    /* One radius for the whole selection, decided before anything is cut: the
       largest every corner asked for can hold at once. Rounding each to its own
       limit instead gave one request several answers -- "Rounded 4 corners. 3
       clamped to r 8.284 by the shorter side" is a rectangle with one corner
       rounder than the other three, and no way to ask for the four to match. */
    let use = radius;
    for (const [key, ids] of byPath) {
      const [shapeId, spIdx] = key.split('/');
      const live = findShape(s.doc, shapeId)?.subpaths[Number(spIdx)];
      if (!live) continue;
      const sharp = cloneSubpath(live);
      const fits = sharedCornerRadius(sharp, sharpen(sharp, ids));
      if (fits > 0) use = Math.min(use, fits);
    }
    const held = use < radius;

    /* Two counts, because they answer two questions. `cut` is how many corners
       the operation could act on at all, which is what decides whether to
       explain a refusal. `done` is how many sat on a path that actually
       changed, which is what decides whether this is an edit. */
    let cut = 0;
    let done = 0;
    const refused: Record<RoundRefusal, number> = { end: 0, straight: 0, tiny: 0 };

    this.store.tryEdit((st) => {
      for (const [key, ids] of byPath) {
        const [shapeId, spIdx] = key.split('/');
        const live = findShape(st.doc, shapeId)?.subpaths[Number(spIdx)];
        if (!live) continue;
        /* Built beside the path and swapped in only if something rounded. A
           selection where every corner refuses must leave the path alone rather
           than un-round it, which is a change nobody asked for. */
        const next = cloneSubpath(live);
        let hit = 0;
        /* Highest index first. Rounding a corner splices a second node in
           beside it, and where two tangent points meet the neighbour is reused
           rather than doubled -- so which corner is cut first decides which node
           the closed path starts at. Descending is the order this has always
           used; the id lookup is what makes it safe while the indices move. */
        const order = sharpen(next, ids).sort(
          (a, b) => next.nodes.findIndex((n) => n.id === b) - next.nodes.findIndex((n) => n.id === a),
        );
        for (const id of order) {
          const at = next.nodes.findIndex((n) => n.id === id);
          if (at < 0) continue;
          const r = roundCorner(next, at, use);
          if (typeof r === 'string') {
            refused[r]++;
            continue;
          }
          hit++;
        }
        cut += hit;
        if (!hit) continue;
        /* Compared, not counted. `hit` says how many corners were cut, which is
           not the same question as whether the path changed: un-rounding a
           corner and rounding it to the radius it already had reproduces it
           exactly, so a second press at the same radius cut four corners and
           altered nothing. That is the class this same pass gave `tryEdit` to
           Align, Distribute and Space for, and it applies here for the same
           reason -- a press that does nothing must not cost a press of Ctrl+Z
           that also does nothing. Cheap: this runs once per subpath per press,
           never per frame. */
        if (samePath(live, next)) continue;
        live.nodes = next.nodes;
        live.closed = next.closed;
        done += hit;
      }
      if (done) st.selection = emptySelection();
      return done > 0;
    });

    /* Cut every corner it was asked to and moved nothing: the shapes are already
       rounded to this radius. A success, said in one clause, and no history
       entry -- the same answer `reorderSelection` gives a shape already at the
       front. Explaining a refusal here would be explaining the wrong thing,
       since nothing refused. */
    if (!done && cut) {
      this.onMessage?.(`Already rounded to r ${(+use.toFixed(3)).toString()}.`, true);
      return true;
    }

    if (!done) {
      // One reason, chosen by what actually happened, rather than a list of
      // everything that could have gone wrong.
      const why = refused.end
        ? 'That node ends the path, so it has only one side.'
        : refused.straight
          ? 'The path runs straight through that node. There is no corner to round.'
          : 'Those nodes cannot be rounded.';
      this.onMessage?.(why, false);
      return false;
    }

    const dp = (v: number): string => (+v.toFixed(3)).toString();
    const skipped = Object.values(refused).reduce((a, b) => a + b, 0);
    this.onMessage?.(
      `Rounded ${done} corner${done === 1 ? '' : 's'} to r ${dp(use)}.` +
        (held ? ' The shortest side allowed no more.' : '') +
        (skipped ? ` Skipped ${skipped}.` : ''),
      true,
    );
    return true;
  }

  /* -------------------------------------------------- the tracing backdrop */

  /**
   * Turn the loaded backdrop into shapes.
   *
   * One undo step, and the raster is left exactly where it was: tracing does
   * not consume the reference, because the first thing anyone does after a trace
   * is compare it against the original. Hiding the backdrop afterwards would
   * also be a view change smuggled into an edit, which §18 keeps apart.
   *
   * The traced shapes land on top of the backdrop in document space, so the two
   * can be flicked between. Ids are assigned here rather than in the tracer,
   * which knows nothing about the document it is going into.
   */
  traceBackdrop(raster: RasterLike, opts: TraceOptions): boolean {
    const s = this.store.state;
    const b = s.backdrop;
    if (!b) {
      this.onMessage?.('Load an image in the Backdrop panel first.', false);
      return false;
    }
    const place: Placement = { x: b.x, y: b.y, w: b.w, h: b.h };

    let r: TraceResult;
    try {
      r = traceImage(raster, place, opts);
    } catch {
      // The walk is exact integer work and should not throw, but it runs over
      // whatever a file decoded to. A failure here leaves the document alone.
      this.onMessage?.('That image could not be traced.', false);
      return false;
    }

    return this.applyTrace(r, place);
  }

  /**
   * Commit a finished trace, wherever it was computed.
   *
   * Split from `traceBackdrop` because the tracer usually runs in a worker
   * (`model/trace.worker.ts`), so seconds pass between asking for a trace and
   * getting one back. The main thread stays live throughout, and the person can
   * move the backdrop, delete it, or start a drag while the walk is running. Every one of those makes the result wrong
   * rather than late, so this checks the world it was computed against is still
   * the world it is landing in.
   *
   * The placement comparison is exact on purpose. §Class 4's lesson was that a
   * question about *geometry* needs a tolerance, and this is not one: it asks
   * whether these numbers were changed, and a backdrop nudged by a
   * ten-thousandth is still a backdrop that moved under a trace that assumed
   * otherwise.
   */
  applyTrace(r: TraceResult, place: Placement): boolean {
    const b = this.store.state.backdrop;
    if (!b) {
      this.onMessage?.('The backdrop was removed while tracing. Nothing was added.', false);
      return false;
    }
    if (b.x !== place.x || b.y !== place.y || b.w !== place.w || b.h !== place.h) {
      this.onMessage?.('The backdrop moved while tracing. Nothing was added.', false);
      return false;
    }
    if (this.busy()) {
      this.onMessage?.('Finish the drag first, then trace.', false);
      return false;
    }

    if (!r.shapes.length) {
      this.onMessage?.('Nothing to trace. Every region was smaller than the noise floor.', false);
      return false;
    }

    const ok = this.store.tryEdit((st) => {
      for (const shape of r.shapes) {
        shape.id = nextId('trace');
        st.doc.shapes.push(shape);
      }
      st.selection = emptySelection();
      for (const shape of r.shapes) st.selection.shapes.add(shape.id);
      return true;
    });
    if (!ok) return false;

    this.onMessage?.(
      `Traced ${r.colours} colour${r.colours === 1 ? '' : 's'} into ${r.paths} path${r.paths === 1 ? '' : 's'}: ` +
        `${r.nodesBefore} nodes fitted to ${r.nodesAfter}.`,
      true,
    );
    return true;
  }

  /* ----------------------------------------------------- the pixel lattice */

  /**
   * Move the selection onto the pixel lattice it should already be on.
   *
   * The other half of pixel fit. Snapping only helps what you place next, and an
   * icon that already exists -- imported, traced, or drawn before the switch was
   * found -- needs the same lattice applied to what is there. Anchors move;
   * handles ride along, so a curve keeps its shape rather than being flattened
   * towards the grid.
   *
   * Deliberately not automatic. Nothing here rewrites coordinates the user did
   * not ask about, and a preference that silently moved the drawing the moment
   * it was ticked would be the worst version of this feature.
   */
  fitToPixels(): boolean {
    const s = this.store.state;
    const step = s.gridStep > 0 ? s.gridStep : 1;
    const phase = phaseInForce(s.doc, s.selection, s.style);
    if (phase === null) {
      this.onMessage?.(
        'Those shapes have different stroke widths, so no one lattice fits them all. Fit them one at a time.',
        false,
      );
      return false;
    }

    const targets = selectedSubpaths(s.doc, s.selection);
    if (!targets.size) {
      this.onMessage?.('Select a shape, or some of its nodes, to fit.', false);
      return false;
    }

    let moved = 0;
    let count = 0;
    this.store.tryEdit((st) => {
      for (const [id, sps] of targets) {
        const shape = findShape(st.doc, id);
        for (const i of sps) {
          const sp = shape?.subpaths[i];
          if (!sp) continue;
          sp.nodes.forEach((_, j) => {
            const from = sp.nodes[j].pt;
            const to = snapTo(from, step, phase);
            const d = Math.hypot(to[0] - from[0], to[1] - from[1]);
            if (d === 0) return;
            moveAnchor(sp, j, to);
            moved = Math.max(moved, d);
            count++;
          });
        }
      }
      return count > 0;
    });

    if (!count) {
      this.onMessage?.('Already on the pixel grid. Nothing to move.', false);
      return false;
    }
    const dp = (v: number): string => (+v.toFixed(3)).toString();
    this.onMessage?.(
      `Fitted ${count} node${count === 1 ? '' : 's'} to ${phaseLabel(phase)}. ` +
        `The furthest moved ${dp(moved)}.`,
      true,
    );
    return true;
  }

  /* -------------------------------------------------- joining and breaking */

  /**
   * Weld nodes together in the middle of a path.
   *
   * Two readings, and the selection says which one is meant. With exactly two
   * nodes picked it welds that pair; with a shape or a run of nodes it sweeps
   * for zero-length segments and welds those. The sweep is the repair half: a
   * path can arrive carrying one from an import, and a path carrying one can
   * never be simplified again, because a zero chord leaves the fitter with no
   * tangent to work from.
   *
   * `Merge ends` covers the other case, two free ends, and is pointed at rather
   * than quietly stood in for: welding the two ends of an open path is a
   * topology change and deserves the keystroke that says so.
   */
  fuseSelection(): boolean {
    const s = this.store.state;
    const refs = selectedRefs(s.doc, s.selection);

    if (refs.length === 2) return this.fusePair(refs[0], refs[1]);

    const targets = selectedSubpaths(s.doc, s.selection);
    if (!targets.size) {
      this.onMessage?.('Select two adjacent nodes, or a shape to sweep.', false);
      return false;
    }

    let gone = 0;
    this.store.tryEdit((st) => {
      for (const [id, sps] of targets) {
        const shape = findShape(st.doc, id);
        for (const i of sps) {
          const sp = shape?.subpaths[i];
          if (sp) gone += fuseDegenerate(sp);
        }
      }
      if (gone) st.selection = emptySelection();
      return gone > 0;
    });

    if (!gone) {
      this.onMessage?.('No two nodes there sit on the same point.', false);
      return false;
    }
    this.onMessage?.(`Fused ${gone} zero-length segment${gone === 1 ? '' : 's'} away.`, true);
    return true;
  }

  /** The two-node half of `fuseSelection`, split out to keep both readable. */
  private fusePair(ra: NodeRef, rb: NodeRef): boolean {
    const s = this.store.state;
    if (ra.shape !== rb.shape || ra.sp !== rb.sp) {
      this.onMessage?.('Fuse works within one path. Those two nodes are on different ones.', false);
      return false;
    }
    const sp = findShape(s.doc, ra.shape)?.subpaths[ra.sp];
    if (!sp) return false;

    if (isPathEnd(sp, ra.i) && isPathEnd(sp, rb.i)) {
      this.onMessage?.('Those are the two ends of the path. Merge ends welds them.', false);
      return false;
    }

    let moved = 0;
    let why: FuseRefusal | null = null;
    this.store.tryEdit((st) => {
      const live = findShape(st.doc, ra.shape)?.subpaths[ra.sp];
      if (!live) return false;
      const r = fuseNodes(live, ra.i, rb.i);
      if (typeof r === 'string') {
        why = r;
        return false;
      }
      moved = r.moved;
      st.selection = emptySelection();
      return true;
    });

    if (why) {
      this.onMessage?.(
        why === 'apart'
          ? 'Fuse needs two nodes next to each other along the path.'
          : why === 'tiny'
            ? 'That path is too short to fuse. Two nodes is the least that draws.'
            : 'Pick two different nodes.',
        false,
      );
      return false;
    }

    const dp = (v: number): string => (+v.toFixed(3)).toString();
    this.onMessage?.(
      moved > 0
        ? `Fused the two nodes. Each moved ${dp(moved)} to meet.`
        : 'Fused the two nodes. They were already on the same point.',
      true,
    );
    return true;
  }

  /* ------------------------------------------------------ style and canvas */

  /**
   * Set fill, stroke, width or fill rule.
   *
   * With something selected this restyles it, one undo step. With nothing
   * selected it sets what the next shape you draw will look like, and records no
   * history: that is a statement about the future, and `Ctrl+Z` should not walk
   * back through the colours you considered.
   *
   * A node selection restyles the shape it belongs to. Style is a property of
   * the whole path in SVG, so there is no smaller thing to change.
   */
  setStyle(patch: Partial<Style>): boolean {
    const s = this.store.state;
    const targets = selectedShapes(s.doc, s.selection);

    if (!targets.length) {
      this.store.update((st) => Object.assign(st.style, patch));
      return true;
    }

    return this.store.tryEdit((st) => {
      let changed = false;
      for (const shape of selectedShapes(st.doc, st.selection)) {
        for (const [k, v] of Object.entries(patch)) {
          if (shape.style[k as keyof Style] === v) continue;
          Object.assign(shape.style, { [k]: v });
          changed = true;
        }
      }
      return changed;
    });
  }

  /**
   * Wrap the document's canvas around whatever has been drawn.
   *
   * The canvas never follows the drawing on its own, and should not: an icon is
   * drawn to a page, and a page that resized itself every time a node moved
   * would make the margins you were aiming for impossible to hold. But nothing
   * else could change it either, which left a drawing sitting in the corner of a
   * canvas nobody chose with no way to say so.
   *
   * Rounded outwards to whole grid steps, so the result is a page with tidy
   * numbers rather than the drawing's exact extent to three decimals. The
   * rounding always grows the box, never crops it.
   */
  fitCanvasToDrawing(): boolean {
    const s = this.store.state;
    const b = docBBox(s.doc);
    if (!b) {
      this.onMessage?.('Nothing drawn yet, so there is nothing to fit the canvas to.', false);
      return false;
    }

    const step = s.gridStep > 0 ? s.gridStep : 0;
    const down = (v: number): number => (step ? Math.floor(v / step) * step : v);
    const up = (v: number): number => (step ? Math.ceil(v / step) * step : v);
    const x = down(b.x0);
    const y = down(b.y0);
    // A drawing with no width at all, such as one straight vertical line, still
    // needs a page it can be seen on.
    const w = Math.max(up(b.x1) - x, step || 1);
    const h = Math.max(up(b.y1) - y, step || 1);

    const changed = this.store.tryEdit((st) => {
      const vb = st.doc.viewBox;
      if (vb.x === x && vb.y === y && vb.w === w && vb.h === h) return false;
      st.doc.viewBox = { x, y, w, h };
      return true;
    });

    if (!changed) {
      this.onMessage?.('The canvas already fits the drawing.', false);
      return false;
    }
    const dp = (v: number): string => (+v.toFixed(3)).toString();
    this.onMessage?.(`Canvas is now ${dp(w)} × ${dp(h)} at ${dp(x)}, ${dp(y)}.`, true);
    return true;
  }

  /* ----------------------------------------------- moving what is selected */

  nudge(d: Pt): void {
    const s = this.store.state;
    const refs = selectedNodes(s.doc, s.selection);
    if (!refs.length) return;
    this.store.edit((st) => {
      for (const r of refs) {
        const sp = findShape(st.doc, r.shape)?.subpaths[r.sp];
        if (!sp?.nodes[r.i]) continue;
        moveAnchor(sp, r.i, [sp.nodes[r.i].pt[0] + d[0], sp.nodes[r.i].pt[1] + d[1]]);
      }
      st.lastTransform = { m: translate(d[0], d[1]), what: `move ${fmt(d[0])}, ${fmt(d[1])}` };
    });
  }

  /**
   * Delete whatever is selected. It always deletes; there is no case where it
   * quietly does less than it was asked.
   *
   * `state.deleteMode` decides what happens to the path around the node.
   * `fuse` makes the two segments either side into one; `split` leaves the path
   * open at the gap, which is exact because no segment is rebuilt. Neither is
   * `breakAtSelection`, which keeps the node and duplicates it.
   *
   * A leftover subpath below two nodes is pruned: it has no segments and
   * serialises to nothing, so it would be an invisible shape. Only subpaths
   * this deletion touched -- a one-node subpath elsewhere is the pen
   * mid-stroke.
   */
  deleteSelection(): { deleted: number; blocked: number } {
    const s = this.store.state;

    if (s.selection.shapes.size > 0) {
      const n = s.selection.shapes.size;
      this.store.edit((st) => {
        st.doc.shapes = st.doc.shapes.filter((sh) => !st.selection.shapes.has(sh.id));
        st.selection = emptySelection();
      });
      return { deleted: n, blocked: 0 };
    }

    const refs = selectedRefs(s.doc, s.selection);
    if (!refs.length) return { deleted: 0, blocked: 0 };

    // Grouped by subpath, because "all of them" and "some of them" mean
    // different things and only the group knows which this is.
    const groups = new Map<string, { shape: string; sp: number; idx: number[] }>();
    for (const r of refs) {
      const key = `${r.shape}/${r.sp}`;
      const g = groups.get(key) ?? { shape: r.shape, sp: r.sp, idx: [] };
      g.idx.push(r.i);
      groups.set(key, g);
    }

    let deleted = 0;
    let blocked = 0;

    this.store.edit((st) => {
      // What each touched subpath becomes, applied only once the loop is done:
      // splicing as we go would shift the indices the remaining groups hold.
      const replace = new Map<string, Subpath[]>();

      for (const g of groups.values()) {
        const shape = findShape(st.doc, g.shape);
        const sp = shape?.subpaths[g.sp];
        if (!shape || !sp) continue;

        const idx = [...new Set(g.idx)].filter((i) => i >= 0 && i < sp.nodes.length);
        if (!idx.length) continue;
        const key = `${g.shape}/${g.sp}`;

        // Everything selected: the subpath goes, in either mode. Removing the
        // nodes one at a time reaches the same place; this skips the work.
        if (idx.length === sp.nodes.length) {
          replace.set(key, []);
          deleted += idx.length;
          continue;
        }

        if (st.deleteMode === 'split') {
          replace.set(key, deleteNodesSplitting(sp, new Set(idx)));
          deleted += idx.length;
          continue;
        }

        // Highest index first, so the lower ones stay valid as we go.
        for (const i of idx.sort((a, b) => b - a)) {
          if (deleteNode(sp, i)) deleted++;
          else blocked++;
        }
        replace.set(key, sp.nodes.length >= 2 ? [sp] : []);
      }

      // Untouched subpaths pass through whatever their size, so a one-node
      // stroke the pen is still drawing survives a deletion somewhere else.
      for (const sh of st.doc.shapes) {
        sh.subpaths = sh.subpaths.flatMap((sp, i) => replace.get(`${sh.id}/${i}`) ?? [sp]);
      }
      st.doc.shapes = st.doc.shapes.filter((sh) => sh.subpaths.length > 0);
      st.selection = emptySelection();
    });

    // `blocked` can now only mean a stale index -- a ref pointing past the end
    // of a subpath something else already shortened. It is kept as a return
    // value rather than a message because it is a bug signal, not user-facing.
    return { deleted, blocked };
  }

  /**
   * Break the path at the selected node, leaving two ends.
   *
   * The counterpart to deleting a node, and lossless where deleting is not:
   * the node is duplicated, so both new ends sit exactly where it was and the
   * drawing does not move. Deleting has to fuse two cubics into one, which
   * cannot be exact across an inflection.
   *
   * A closed path opens at that node. An open one becomes two, in the same
   * shape, so they keep one style and one entry in the shape list.
   */
  breakAtSelection(): boolean {
    const sel = this.singleSelectedNode();
    if (!sel) {
      this.onMessage?.('Break needs exactly one node selected.', false);
      return false;
    }

    const ref = sel.ref;
    const pieces = breakAt(sel.subpath, ref.i);
    if (!pieces) {
      this.onMessage?.('That node already ends the path.', false);
      return false;
    }

    this.store.edit((st) => {
      const shape = findShape(st.doc, ref.shape);
      if (!shape?.subpaths[ref.sp]) return;
      shape.subpaths.splice(ref.sp, 1, ...pieces);
      st.selection = emptySelection();
    });

    this.onMessage?.(
      pieces.length === 1 ? 'Opened the path at that node.' : 'Broke the path into two.',
      true,
    );
    return true;
  }

  /**
   * Weld two selected free ends into one node.
   *
   * The inverse of `Break here`, and the answer to "I drew this in two pieces
   * and now I want one path". Ends that already sit on top of each other do not
   * move; ends apart meet in the middle.
   */
  joinSelection(mode: 'connect' | 'merge' = 'connect'): boolean {
    const s = this.store.state;
    const refs = selectedRefs(s.doc, s.selection);
    const verb = mode === 'merge' ? 'Merge' : 'Connect';
    if (refs.length !== 2) {
      this.onMessage?.(`${verb} needs exactly two nodes selected.`, false);
      return false;
    }

    const [ra, rb] = refs;
    const resolve = (r: NodeRef): Subpath | null =>
      findShape(s.doc, r.shape)?.subpaths[r.sp] ?? null;
    const spa = resolve(ra);
    const spb = resolve(rb);
    if (!spa || !spb) return false;

    if (!isPathEnd(spa, ra.i) || !isPathEnd(spb, rb.i)) {
      this.onMessage?.(
        `${verb} needs two free ends. Both nodes have to start or finish an open path.`,
        false,
      );
      return false;
    }
    const sameSubpath = ra.shape === rb.shape && ra.sp === rb.sp;
    if (sameSubpath && spa.nodes.length < (mode === 'merge' ? 3 : 2)) {
      this.onMessage?.('That path is too short to close.', false);
      return false;
    }

    let closed = false;
    const ok = this.store.tryEdit((st) => {
      const shapeA = findShape(st.doc, ra.shape);
      const shapeB = findShape(st.doc, rb.shape);
      const a = shapeA?.subpaths[ra.sp];
      const b = shapeB?.subpaths[rb.sp];
      if (!shapeA || !shapeB || !a || !b) return false;

      const join = mode === 'merge' ? mergeEnds : connectEnds;
      const joined = join({ sp: a, i: ra.i }, { sp: b, i: rb.i });
      if (!joined) return false;

      if (sameSubpath) {
        closed = true;
      } else {
        shapeA.subpaths[ra.sp] = joined;
        shapeB.subpaths.splice(rb.sp, 1);
        // A shape with no subpaths left draws nothing and serialises to
        // nothing, so it goes rather than lingering in the list.
        if (!shapeB.subpaths.length) {
          st.doc.shapes = st.doc.shapes.filter((sh) => sh.id !== shapeB.id);
        }
      }
      st.selection = emptySelection();
      return true;
    });

    if (!ok) {
      this.onMessage?.(`Those two ends cannot be ${mode === 'merge' ? 'merged' : 'connected'}.`, false);
      return false;
    }
    this.onMessage?.(
      closed
        ? 'Closed the path.'
        : mode === 'merge'
          ? 'Merged the two ends into one node.'
          : 'Connected the two ends with a segment.',
      true,
    );
    return true;
  }

  /* ------------------------------------------------- the selection's box */

  /**
   * Where the selection is and how big, as four numbers.
   *
   * The same box the transform handles are drawn on, so the panel and the canvas
   * cannot disagree about what is being measured. `null` when nothing is
   * selected, which is what leaves the fields empty rather than showing zeroes.
   */
  selectionBounds(): { x: number; y: number; w: number; h: number } | null {
    const s = this.store.state;
    const b = selectionBBox(s.doc, s.selection);
    if (!b) return null;
    /* `x` and `y` are the reference point, not the corner, because that is what
       typing into them moves. A readout that named one point while the field
       moved another is the disagreement §67 exists to remove. */
    const [x, y] = referencePoint(b, s.reference);
    return { x, y, w: b.x1 - b.x0, h: b.y1 - b.y0 };
  }

  /**
   * Move or resize the selection by typing one of its four numbers.
   *
   * The typed version of dragging a box handle, and it moves exactly what a drag
   * would: the selected nodes, which for a selected shape is all of them.
   *
   * The matrix is derived from the box as it is now, every time, rather than
   * composed onto whatever the last edit did. §5 bakes transforms into
   * coordinates, so there is no stored size to correct: a width typed twice has
   * to reach the same answer both times, and composing would let rounding
   * accumulate across a run of edits.
   *
   * Width and height scale about the top-left corner, so setting one leaves the
   * other three numbers alone. Anchoring the centre would move X and Y as a side
   * effect of typing W.
   */
  setSelectionBound(part: 'x' | 'y' | 'w' | 'h', value: number): boolean {
    if (!Number.isFinite(value)) return false;
    const s = this.store.state;
    const box = selectionBBox(s.doc, s.selection);
    if (!box) {
      this.onMessage?.('Nothing is selected.', false);
      return false;
    }

    const w = box.x1 - box.x0;
    const h = box.y1 - box.y0;
    /* What stays put, and what `at` names. Both used to be the top-left with
       nothing saying so, while rotate and flip held the centre: two answers to
       one question in one panel. §67. */
    const ref = referencePoint(box, s.reference);
    let m: Mat;
    if (part === 'x') m = translate(value - ref[0], 0);
    else if (part === 'y') m = translate(0, value - ref[1]);
    else {
      if (value <= 0) {
        this.onMessage?.('A size has to be greater than zero.', false);
        return false;
      }
      /* A selection can genuinely be flat: one row of nodes, or a straight
         horizontal line. Dividing by that side would send every point to
         infinity, so the axis with no length simply does not scale. */
      const along = part === 'w' ? w : h;
      if (Math.abs(along) < FLAT) {
        this.onMessage?.(`This selection has no ${part === 'w' ? 'width' : 'height'} to scale.`, false);
        return false;
      }
      const k = value / along;
      m = about(part === 'w' ? [k, 0, 0, 1, 0, 0] : [1, 0, 0, k, 0, 0], ref[0], ref[1]);
    }

    const saved = captureNodes(s.doc, selectedNodes(s.doc, s.selection));
    if (!saved.length) return false;
    const what =
      part === 'x' || part === 'y'
        ? `move ${part === 'x' ? 'X' : 'Y'} to ${value}`
        : `set ${part === 'w' ? 'width' : 'height'} to ${value}`;
    return this.store.tryEdit((st) => {
      transformCaptured(st.doc, saved, m);
      st.lastTransform = { m, what };
      return true;
    });
  }

  /**
   * Do the last transform again, to whatever is selected now.
   *
   * Duplicate, move, repeat is how a row of things is built, and duplicate,
   * rotate, repeat is how a radial one is. Both are cheap here precisely because
   * §5 bakes transforms into coordinates: the last matrix is the whole of what
   * has to be remembered, and applying it again is the same call.
   *
   * **The matrix, not the gesture.** Illustrator's Transform Again repeats what
   * you did; this repeats the matrix that came out of it, which is the same
   * thing for a rotate about a centre and deliberately not the same thing for a
   * scale typed as a width. `set width to 40` on a 20-wide selection produced a
   * doubling, and doing it again doubles whatever is selected now rather than
   * setting it to 40. The label says which one you have.
   *
   * Applied through the node capture rather than `transformShape`, so it moves
   * exactly what a drag would: the selected nodes, which for a selected shape is
   * all of them. A whole-shape version would silently widen a node selection.
   */
  repeatTransform(): boolean {
    /* Guarded here rather than at the call site, because there are two: the
       button and Shift+T. The key had the guard through the `rewrites` list in
       `keys.ts` and the button had none, so the same operation was refused
       mid-drag from the keyboard and allowed from the panel. A drag holds
       captured geometry from the press, and an edit landing under it makes the
       next frame rebuild from a document that has moved. */
    if (this.busy()) {
      this.onMessage?.('Finish the drag first.', false);
      return false;
    }
    const s = this.store.state;
    const last = s.lastTransform;
    if (!last) {
      this.onMessage?.('Nothing to repeat: move, rotate or scale something first.', false);
      return false;
    }
    const saved = captureNodes(s.doc, selectedNodes(s.doc, s.selection));
    if (!saved.length) {
      this.onMessage?.('Repeat needs something selected.', false);
      return false;
    }
    /* Read before the edit and put back after it. `store.edit` is what records
       the history entry, and the matrix has to survive that entry so a run of
       presses keeps repeating the same thing rather than the last one being
       overwritten by nothing. It is not overwritten by anything here, but
       saying so is cheaper than the next reader wondering. */
    const done = this.store.tryEdit((st) => {
      transformCaptured(st.doc, saved, last.m);
      return true;
    });
    if (done) this.onMessage?.(`Again: ${last.what}.`, true);
    return done;
  }

  /** Whether Repeat would do anything, for the button that offers it. */
  get canRepeatTransform(): boolean {
    const s = this.store.state;
    return !!s.lastTransform && selectedNodes(s.doc, s.selection).length > 0;
  }

  /* ---------------------------------------------------------- whole shapes */

  /** Rotate, flip or scale the selection about its own centre. */
  applyTransform(kind: 'rotate' | 'flipH' | 'flipV' | 'scale', amount = 0): void {
    const s = this.store.state;
    const shapes = selectedShapes(s.doc, s.selection);
    const targets = shapes.length ? shapes : s.doc.shapes;
    if (!targets.length) return;

    const box = selectionBBox(s.doc, s.selection) ?? null;
    let cx = 0;
    let cy = 0;
    if (box) {
      // The point the panel is set to hold still, which is the centre unless
      // somebody chose otherwise. §67.
      [cx, cy] = referencePoint(box, s.reference);
    } else {
      const all = targets.flatMap((sh) => sh.subpaths.flatMap((sp) => sp.nodes.map((n) => n.pt)));
      cx = all.reduce((a, p) => a + p[0], 0) / all.length;
      cy = all.reduce((a, p) => a + p[1], 0) / all.length;
    }

    const m =
      kind === 'rotate'
        ? about(rotMat(amount), cx, cy)
        : kind === 'flipH'
          ? about(flipX(), cx, cy)
          : kind === 'flipV'
            ? about(flipY(), cx, cy)
            : about([amount, 0, 0, amount, 0, 0], cx, cy);

    const ids = new Set(targets.map((t) => t.id));
    this.store.edit((st) => {
      for (const shape of st.doc.shapes) if (ids.has(shape.id)) transformShape(shape, m);
      st.lastTransform = {
        m,
        what:
          kind === 'rotate'
            ? `rotate ${amount}°`
            : kind === 'scale'
              ? `scale ${amount}`
              : kind === 'flipH'
                ? 'flip across the vertical'
                : 'flip across the horizontal',
      };
    });
  }

  /**
   * Combine the selected shapes into one.
   *
   * Whole-shape selection only. A boolean operates on regions, and a region is
   * a shape -- inferring one from a couple of selected nodes would be a guess
   * about which shape the user meant, made silently and destructively.
   *
   * Order is document order, which is paint order: the first (bottom-most)
   * shape survives, keeping its id, name and style, and the rest are consumed.
   * That makes `subtract` bottom-minus-the-rest, which is what Inkscape's
   * Difference and Illustrator's Minus Front both do, and it means the result
   * keeps the appearance of the shape it visually replaced.
   *
   * Returns a message rather than touching the DOM, so the caller decides where
   * to say it and this stays testable without a page.
   */
  booleanSelection(op: BooleanOp): { ok: boolean; message: string } {
    const s = this.store.state;
    const operands = s.doc.shapes.filter((sh) => s.selection.shapes.has(sh.id));
    const label = BOOLEAN_LABEL[op];
    if (operands.length < 2) {
      /* One shape's own paths, which §47 made selectable and this used to make
         you split apart first. Only when the shapes are not the operands: two
         selected shapes is a question about shapes whatever their paths are
         doing, and asking the other one would be guessing. */
      const within = this.subpathOperands();
      if (within) return this.booleanWithin(within.shape, within.indices, op);
      return {
        ok: false,
        message: `${label} needs two or more selected shapes, or two paths of one shape.`,
      };
    }

    let result: Subpath[] | null;
    try {
      result = booleanShapes(operands, op);
    } catch (err) {
      // Either the library threw, or it handed back geometry that failed the
      // finite check. Both leave the document untouched.
      return { ok: false, message: `${label} failed: ${reasonFor(err)}` };
    }
    if (!result) {
      return { ok: false, message: `${label} left nothing. The document is unchanged.` };
    }

    const subpaths = result;
    const keep = operands[0].id;
    const consumed = new Set(operands.slice(1).map((sh) => sh.id));

    this.store.edit((st) => {
      const target = findShape(st.doc, keep);
      if (!target) return;
      target.subpaths = subpaths;
      st.doc.shapes = st.doc.shapes.filter((sh) => !consumed.has(sh.id));
      st.selection = emptySelection();
      st.selection.shapes.add(keep);
    });

    const n = subpaths.length;
    return {
      ok: true,
      message: `${label}: ${operands.length} shapes → ${n} path${n === 1 ? '' : 's'}.`,
    };
  }

  /**
   * The one shape whose own paths the selection is asking about, or `null`.
   *
   * Two or more paths of exactly one shape, and that shape not selected whole:
   * a whole-shape selection is a question about the shape, and answering it
   * with its own paths would turn Unite on one shape into something it has
   * never done. `selectedSubpaths` fills in every subpath of a selected shape,
   * which is why the shape set is checked as well as the map.
   */
  private subpathOperands(): { shape: Shape; indices: number[] } | null {
    const s = this.store.state;
    if (s.selection.shapes.size) return null;
    const map = selectedSubpaths(s.doc, s.selection);
    if (map.size !== 1) return null;
    const [id, set] = [...map][0];
    if (set.size < 2) return null;
    const shape = findShape(s.doc, id);
    if (!shape) return null;
    return { shape, indices: [...set].sort((a, b) => a - b) };
  }

  /** Whether a boolean would have operands, for the buttons that offer one. */
  get canBoolean(): boolean {
    return this.store.state.selection.shapes.size >= 2 || this.subpathOperands() !== null;
  }

  /**
   * Combine some paths of one shape, leaving the rest of the shape alone.
   *
   * The result replaces the chosen paths where the first of them was, so a
   * shape of four paths that unites two of them has three, in the order it had.
   * Nothing about the shape changes: same id, same name, same style, and the
   * paths that were not selected are untouched.
   */
  private booleanWithin(shape: Shape, indices: number[], op: BooleanOp): { ok: boolean; message: string } {
    const label = BOOLEAN_LABEL[op];
    let result: Subpath[] | null;
    try {
      result = booleanSubpaths(shape, indices, op);
    } catch (err) {
      return { ok: false, message: `${label} failed: ${reasonFor(err)}` };
    }
    if (!result) {
      return { ok: false, message: `${label} left nothing. The document is unchanged.` };
    }

    const made = result;
    const id = shape.id;
    const at = indices[0];
    const drop = new Set(indices);
    this.store.edit((st) => {
      const target = findShape(st.doc, id);
      if (!target) return;
      const kept = target.subpaths.filter((_, i) => !drop.has(i));
      /* `at` counts in the original array and in `kept` alike, because it is
         the SMALLEST chosen index: nothing before it was removed. That is not
         true of `dropShapes`, which has to count in the rows that are staying
         precisely because the row it is landing before may sit after ones that
         went. Written out because the two look like the same problem. */
      target.subpaths = [...kept.slice(0, at), ...made, ...kept.slice(at)];
      st.selection = emptySelection();
      st.selection.shapes.add(id);
    });

    const n = made.length;
    return {
      ok: true,
      message: `${label}: ${indices.length} paths of ${shape.name} → ${n} path${n === 1 ? '' : 's'}.`,
    };
  }

  /**
   * Put the selected shapes into one shape, without touching their geometry.
   *
   * Where `Unite` rebuilds the outline and destroys every node that fell
   * inside, this moves the paths and changes nothing about them. So a ring
   * inside a disc stays two rings and the fill rule decides whether the middle
   * is a hole -- the only way to draw one here.
   *
   * Labelled **Make one shape**, not "Make path": `docs/STYLE.md` reserves
   * "path" for a run of nodes and "shape" for a row in the list.
   *
   * Same conventions as `booleanSelection`: whole shapes only, document order,
   * bottom-most survives with its id, name and style.
   */
  makeOneShape(): { ok: boolean; message: string } {
    const s = this.store.state;
    const operands = s.doc.shapes.filter((sh) => s.selection.shapes.has(sh.id));
    if (operands.length < 2) {
      return { ok: false, message: 'Make one shape needs two or more selected shapes.' };
    }

    const keep = operands[0];
    const keepId = keep.id;
    const consumed = new Set(operands.slice(1).map((sh) => sh.id));
    const subpaths = operands.flatMap((sh) => sh.subpaths);
    const n = subpaths.length;

    /* Worth saying out loud, because it is the one thing that is lost. Every
       other shape's fill, stroke and width go with it, and a silent recolour
       is the kind of change people notice three steps later and blame on
       something else. */
    const differs = operands
      .slice(1)
      .some(
        (sh) =>
          sh.style.fill !== keep.style.fill ||
          sh.style.stroke !== keep.style.stroke ||
          sh.style.strokeWidth !== keep.style.strokeWidth,
      );

    this.store.edit((st) => {
      const target = findShape(st.doc, keepId);
      if (!target) return;
      /* The same subpath objects, not copies. Filtering a shape out of
         `doc.shapes` drops the shape, not the paths inside it, and each one
         ends up in exactly one place, so nothing is aliased. A hand-written
         deep copy would also quietly drop any field a future `PathNode`
         gains, which is a worse failure than the one it guards against. */
      target.subpaths = subpaths;
      st.doc.shapes = st.doc.shapes.filter((sh) => !consumed.has(sh.id));
      st.selection = emptySelection();
      st.selection.shapes.add(keepId);
    });

    const rule = keep.style.fillRule === 'evenodd' ? 'Even-odd' : 'Nonzero';
    return {
      ok: true,
      message: differs
        ? `${keep.name} now holds ${n} paths. The other colours are gone, and the rule is ${rule}.`
        : `${keep.name} now holds ${n} paths. The rule is ${rule}.`,
    };
  }

  /** Whether anything in the selection has more than one path to split. */
  get canSplitShapes(): boolean {
    const s = this.store.state;
    return s.doc.shapes.some((sh) => s.selection.shapes.has(sh.id) && sh.subpaths.length > 1);
  }

  /**
   * Give every path in the selected shapes a shape of its own.
   *
   * The inverse of `makeOneShape`, and the reason that one is safe to use.
   * Not an exact inverse and cannot be: this works on a shape that was never
   * combined, and cannot restore a name or colour it discarded. Undo is the
   * exact inverse.
   *
   * Each new shape takes the original's style, so a ring split out of an
   * even-odd shape becomes a filled disc. A hole is a relationship between two
   * paths in one shape, and in two shapes there is no relationship left.
   *
   * The original keeps its id, name and first path; the rest go directly behind
   * it, so paint order does not change.
   */
  splitShapes(): { ok: boolean; message: string } {
    const s = this.store.state;
    const targets = s.doc.shapes.filter(
      (sh) => s.selection.shapes.has(sh.id) && sh.subpaths.length > 1,
    );
    if (!targets.length) {
      /* Two different refusals, because "nothing selected" and "the thing you
         selected is already one path" call for different next moves. A single
         message covering both would be right about neither. */
      const anySelected = s.selection.shapes.size > 0;
      return {
        ok: false,
        message: anySelected
          ? 'Split needs a shape holding two or more paths. These hold one each.'
          : 'Split needs a shape selected. It gives each of its paths a shape of its own.',
      };
    }

    const ids = new Set(targets.map((sh) => sh.id));
    let made = 0;

    this.store.edit((st) => {
      const out: Shape[] = [];
      const selected = new Set<string>();
      for (const sh of st.doc.shapes) {
        if (!ids.has(sh.id)) {
          out.push(sh);
          continue;
        }
        const [first, ...rest] = sh.subpaths;
        // The original, reduced to its first path. Keeping the object rather
        // than replacing it is what preserves the id the export carries.
        sh.subpaths = [first];
        out.push(sh);
        selected.add(sh.id);
        rest.forEach((sp, i) => {
          const copy = makeShape([sp], `${sh.name} ${i + 2}`, sh.style);
          out.push(copy);
          selected.add(copy.id);
          made++;
        });
      }
      st.doc.shapes = out;
      st.selection = emptySelection();
      for (const id of selected) st.selection.shapes.add(id);
    });

    const from = targets.length;
    return {
      ok: true,
      message:
        from === 1
          ? `${targets[0].name} split into ${made + 1} shapes.`
          : `${from} shapes split into ${from + made}.`,
    };
  }

  /* --------------------------------------------------------------- groups */

  /**
   * Put the selected shapes in a group.
   *
   * **Brings them together in the paint order**, which is the part that is not
   * optional. A group is one `<g>` on export and a `<g>` holds its children
   * contiguously, so shapes scattered through the z-order cannot be one group
   * without something moving. They move to where the topmost of them already was,
   * keeping their order among themselves, which is what every editor does and what
   * leaves the drawing looking the same afterwards.
   *
   * A group carries no transform. §5 bakes transforms into coordinates, and a group
   * that stored one would be the hidden coordinate system §5 exists to refuse. So
   * this groups for organisation and for export, and the shapes move together
   * because moving a selection already moves everything in it.
   */
  groupSelection(): boolean {
    const s = this.store.state;
    const chosen = s.doc.shapes.filter((sh) => s.selection.shapes.has(sh.id));
    if (chosen.length < 2) {
      this.onMessage?.('Group needs two or more shapes selected.', false);
      return false;
    }

    const ids = new Set(chosen.map((sh) => sh.id));
    const name = `group of ${chosen.length}`;
    let made = '';

    this.store.edit((st) => {
      const group: Group = { id: nextId('group'), name, parent: null };
      made = group.id;

      /* Nested where every one of them was already in one group together: grouping
         two shapes out of a group of five makes a group inside it rather than
         breaking them out of it, which is the answer that keeps the outer group
         whole. Otherwise the new group sits at the top. */
      const parents = new Set(chosen.map((sh) => sh.group ?? null));
      group.parent = parents.size === 1 ? ([...parents][0] ?? null) : null;

      st.doc.groups = [...(st.doc.groups ?? []), group];

      const moving = st.doc.shapes.filter((sh) => ids.has(sh.id));
      const rest = st.doc.shapes.filter((sh) => !ids.has(sh.id));
      for (const sh of moving) sh.group = group.id;

      /* Reinserted where the topmost of them was. Counting in `rest` rather than in
         the original array: the index of the last selected shape means nothing once
         the earlier selected ones have been taken out. */
      const lastIndex = st.doc.shapes.reduce((at, sh, i) => (ids.has(sh.id) ? i : at), -1);
      const before = st.doc.shapes.slice(0, lastIndex + 1).filter((sh) => !ids.has(sh.id)).length;
      st.doc.shapes = [...rest.slice(0, before), ...moving, ...rest.slice(before)];
    });

    this.onMessage?.(`Grouped ${chosen.length} shapes.`, true);
    void made;
    return true;
  }

  /**
   * Take the selected shapes out of their group, innermost first.
   *
   * One level at a time, so ungrouping twice unwraps two levels rather than
   * flattening everything at once. Nothing moves in the paint order: the shapes are
   * already contiguous, and leaving them where they are is what makes this look like
   * the inverse of grouping rather than a re-sort.
   */
  ungroupSelection(): boolean {
    const s = this.store.state;
    const chosen = s.doc.shapes.filter((sh) => s.selection.shapes.has(sh.id));
    const grouped = chosen.filter((sh) => sh.group);
    if (!grouped.length) {
      this.onMessage?.(
        chosen.length ? 'Nothing selected is in a group.' : 'Ungroup needs a shape selected.',
        false,
      );
      return false;
    }

    const freed = new Set(grouped.map((sh) => sh.group!));
    this.store.edit((st) => {
      for (const sh of st.doc.shapes) {
        if (!sh.group || !freed.has(sh.group)) continue;
        // Out to whatever held the group, which is `null` at the top. One level.
        sh.group = findGroup(st.doc, sh.group)?.parent ?? null;
      }
      for (const g of st.doc.groups ?? []) {
        if (g.parent && freed.has(g.parent)) g.parent = findGroup(st.doc, g.parent)?.parent ?? null;
      }
      pruneGroups(st.doc);
    });

    this.onMessage?.(
      freed.size === 1 ? 'Ungrouped.' : `Ungrouped ${freed.size} groups.`,
      true,
    );
    return true;
  }

  /**
   * Widen the selection to the group it is in, one level per press.
   *
   * The one thing a click on the canvas could not do. A shape inside a group
   * selects as itself here, which is what makes nudging one shape inside a
   * group possible and is deliberately not Illustrator's default -- and it left
   * the group reachable only by its row in the list. This is the way back up.
   *
   * **The level is derived, not stored.** Illustrator keeps a mode: you are
   * inside a group until you press Escape, and what a click means depends on
   * where you have been. Here the answer comes from the selection itself -- the
   * nearest ancestor group that is not already wholly selected -- so pressing it
   * again goes one level further out and nothing has to be remembered between
   * presses. Selecting by hand and pressing this gives the same result as
   * arriving at that selection any other way, which a mode cannot promise.
   *
   * Not an edit: the document is untouched, so this takes no undo step, the same
   * as clicking a shape.
   */
  selectGroup(): boolean {
    /* Both entry points, for the reason `repeatTransform` gives. Here the
       hazard is the one named beside `case 'G'` in `keys.ts`: a drag holds refs
       into the selection it started with, so widening that selection mid-drag
       hands the gesture shapes it never picked up. */
    if (this.busy()) {
      this.onMessage?.('Finish the drag first.', false);
      return false;
    }
    const s = this.store.state;
    const chosen = s.doc.shapes.filter((sh) => s.selection.shapes.has(sh.id));
    if (!chosen.length) {
      this.onMessage?.('Select group needs a shape selected.', false);
      return false;
    }

    const ids = new Set(chosen.map((sh) => sh.id));
    const widened = new Set(ids);
    const levels = new Set<string>();
    for (const sh of chosen) {
      const chain = groupChain(s.doc, sh.group);
      const g = chain.find((grp) => !shapesInGroup(s.doc, grp.id).every((m) => ids.has(m.id)));
      if (!g) continue;
      levels.add(g.id);
      for (const m of shapesInGroup(s.doc, g.id)) widened.add(m.id);
    }

    if (!levels.size) {
      const anyGroup = chosen.some((sh) => sh.group);
      this.onMessage?.(
        anyGroup ? 'That is already the whole group.' : 'Nothing selected is in a group.',
        false,
      );
      return false;
    }

    this.store.update((st) => {
      st.selection.shapes = widened;
      /* Cleared, because the node selection was about the shapes you had. The
         node panel reading a shape you did not choose is worse than it reading
         nothing. */
      st.selection.nodes.clear();
    });
    const n = widened.size;
    this.onMessage?.(
      levels.size === 1
        ? `Selected the group: ${n} shape${n === 1 ? '' : 's'}.`
        : `Selected ${levels.size} groups: ${n} shapes.`,
      true,
    );
    return true;
  }

  /** Whether Select group would widen anything, for the button that offers it. */
  get canSelectGroup(): boolean {
    const s = this.store.state;
    const ids = s.selection.shapes;
    return s.doc.shapes.some(
      (sh) =>
        ids.has(sh.id) &&
        groupChain(s.doc, sh.group).some(
          (g) => !shapesInGroup(s.doc, g.id).every((m) => ids.has(m.id)),
        ),
    );
  }

  /**
   * Whether Group would do anything, for the button that offers it.
   *
   * Counted over the live shapes, the same way `groupSelection` counts them. The
   * selection is a set of ids and an id can outlive the shape it names, so a
   * count of the set is a count of what was selected rather than of what is
   * there -- and a button enabled from one number and refused by the other reads
   * as a button that does not work.
   */
  get canGroup(): boolean {
    const s = this.store.state;
    return s.doc.shapes.filter((sh) => s.selection.shapes.has(sh.id)).length >= 2;
  }

  /** Whether Ungroup would do anything. */
  get canUngroup(): boolean {
    const s = this.store.state;
    return s.doc.shapes.some((sh) => s.selection.shapes.has(sh.id) && !!sh.group);
  }

  /* -------------------------------------------------- copying and pasting */

  /**
   * Put the selection somewhere a later paste can find it.
   *
   * The editor's own clipboard, not the system's. A shape here is nodes and
   * handles, and the system clipboard carries text, so going through it would
   * mean serialising to path data and parsing it back -- which loses nothing
   * except the thing that makes a paste feel like a paste, since the round trip
   * cannot preserve a node's identity or a subpath's place in a shape. The
   * source drawer's **Copy** button is the way out to other programs, and it is
   * text on purpose.
   *
   * With shapes selected it takes those shapes whole. With only nodes selected
   * it takes the runs of two or more adjacent nodes, one open path each, which
   * is the copy that means "this piece of the outline" rather than "this list of
   * points". A lone node contributes nothing: a path of one node has no segment,
   * and pasting one would put a shape on the canvas that draws nothing.
   */
  copySelection(): boolean {
    const s = this.store.state;
    /* `sel.shapes` and not `selectedShapes`, which widens to the shapes that any
       selected node belongs to. That is the right reading for a transform, where
       touching a node means acting on its shape, and the wrong one here: it would
       make every node copy take the whole outline the node sits on, and the run
       branch below unreachable. */
    const shapes = s.doc.shapes.filter((sh) => s.selection.shapes.has(sh.id));

    const taken = shapes.length ? shapes.map((sh) => cloneShape(sh)) : this.nodeRunsAsShapes();
    if (!taken.length) {
      this.onMessage?.(
        s.selection.nodes.size
          ? 'Copy needs two nodes next to each other on a path, or a whole shape.'
          : 'Nothing selected to copy.',
        false,
      );
      return false;
    }

    this.clipboard = taken;
    this.pastes = 0;
    /* The clipboard is not in the store, so filling it raises nothing and the
       Paste button, which is greyed out until there is something to paste,
       would stay grey until an unrelated edit redrew the rail. */
    this.store.notify();
    const what = shapes.length
      ? `${taken.length} ${taken.length === 1 ? 'shape' : 'shapes'}`
      : `${taken.length} ${taken.length === 1 ? 'piece' : 'pieces'} of path`;
    this.onMessage?.(`Copied ${what}.`, true);
    return true;
  }

  /** Copy, then delete what was copied. One history entry, because only the delete edits. */
  cutSelection(): boolean {
    if (!this.copySelection()) return false;
    const { deleted } = this.deleteSelection();
    if (!deleted) {
      this.onMessage?.('Copied, but nothing could be removed.', false);
      return false;
    }
    this.onMessage?.('Cut.', true);
    return true;
  }

  /**
   * Put the clipboard back, offset, and select what landed.
   *
   * Each paste steps further from the last so that pasting twice never hides one
   * copy exactly under another. The step is the grid's, so a paste lands on the
   * lattice if what was copied was on it.
   *
   * Every shape is reidentified on the way in. Without that a paste is an alias:
   * the copy answers to the original's node ids, so clicking a node of one
   * selects the node of the other and dragging moves both.
   *
   * **A copy lands outside any group**, here and in `duplicateSelection`. Both append
   * to the end of `doc.shapes`, and a copy that kept its original's group would sit at
   * the end claiming to be in a group whose other shapes are in the middle -- which
   * breaks the contiguity §49 rests on, and makes the export open the same group
   * twice. Landing at the top is visible and can be undone by grouping; a `<g>`
   * written twice is a wrong file with nothing to say so.
   */
  paste(): boolean {
    if (!this.clipboard.length) {
      this.onMessage?.('Nothing copied yet.', false);
      return false;
    }

    const step = this.store.state.gridStep || 1;
    this.pastes++;
    const away = step * 2 * this.pastes;
    const landed: Shape[] = this.clipboard.map((sh) => {
      const copy = reidentify(cloneShape(sh));
      copy.name = `${sh.name} copy`;
      copy.group = null;
      transformShape(copy, translate(away, away));
      return copy;
    });

    this.store.edit((st) => {
      st.doc.shapes.push(...landed);
      st.selection = emptySelection();
      for (const sh of landed) st.selection.shapes.add(sh.id);
    });

    this.onMessage?.(
      `Pasted ${landed.length} ${landed.length === 1 ? 'shape' : 'shapes'}.`,
      true,
    );
    return true;
  }

  /**
   * Whether a paste would do anything, for the button that offers it.
   *
   * A getter, like every other capability probe here. There were briefly two of
   * these -- this and a `hasClipboard()` method -- answering one question, with
   * the button reading one and the tests the other. Two names for one fact is
   * two things to remember to change.
   */
  get canPaste(): boolean {
    return this.clipboard.length > 0;
  }

  /**
   * A copy of each selected shape, beside the original.
   *
   * The same operation as copy-then-paste with the clipboard left alone, which is
   * why it lives beside them rather than being spelled out at the button. It
   * shares the rule that matters: a duplicate answering to the original's node
   * ids is one drag away from moving both, so it is reidentified.
   */
  duplicateSelection(): boolean {
    const s = this.store.state;
    // Whole shapes only, and `sel.shapes` says which: duplicating what a node
    // happens to sit on is a different operation from duplicating a shape.
    const shapes = s.doc.shapes.filter((sh) => s.selection.shapes.has(sh.id));
    if (!shapes.length) {
      this.onMessage?.('Select a shape to duplicate.', false);
      return false;
    }

    const step = s.gridStep || 1;
    const copies = shapes.map((sh) => {
      const copy = reidentify(cloneShape(sh));
      copy.name = `${sh.name} copy`;
      copy.group = null;
      // Offset so the duplicate is visible rather than exactly underneath.
      transformShape(copy, translate(step * 2, step * 2));
      return copy;
    });

    this.store.edit((st) => {
      st.doc.shapes.push(...copies);
      st.selection = emptySelection();
      for (const c of copies) st.selection.shapes.add(c.id);
    });
    return true;
  }

  /**
   * The selected nodes as open paths, one per run of adjacent ones.
   *
   * Adjacency is what makes this a copy of a piece of outline rather than a bag
   * of points: two nodes next to each other bring the segment between them, and
   * the handles at the outer ends are dropped because the segments they governed
   * are not coming. A closed subpath wraps, so selecting three corners of a
   * square that straddle node 0 gives one run and not two.
   */
  private nodeRunsAsShapes(): Shape[] {
    const s = this.store.state;
    const chosen = new Map<string, Set<number>>();
    for (const r of selectedRefs(s.doc, s.selection)) {
      const key = `${r.shape}/${r.sp}`;
      const set = chosen.get(key) ?? new Set<number>();
      set.add(r.i);
      chosen.set(key, set);
    }

    const out: Shape[] = [];
    for (const [key, indices] of chosen) {
      const [shapeId, spIdx] = key.split('/');
      const shape = findShape(s.doc, shapeId);
      const sp = shape?.subpaths[Number(spIdx)];
      if (!shape || !sp) continue;
      const n = sp.nodes.length;

      // A wholly selected closed path stays closed; there is no run to cut.
      if (sp.closed && indices.size === n) {
        out.push(makeShape([cloneSubpath(sp)], `${shape.name} copy`, shape.style));
        continue;
      }

      /* Started at the first unselected node so a run cannot be split across the
         end of the array. There is one when the whole path is not selected, and
         the closed case above is the only way for that to be false. */
      const start = sp.closed ? [...Array(n).keys()].find((i) => !indices.has(i)) ?? 0 : 0;
      const runs: number[][] = [];
      let run: number[] = [];
      for (let k = 0; k < n; k++) {
        const i = sp.closed ? (start + k) % n : k;
        if (indices.has(i)) run.push(i);
        else {
          if (run.length) runs.push(run);
          run = [];
        }
      }
      if (run.length) runs.push(run);

      for (const r of runs.filter((x) => x.length >= 2)) {
        const nodes = r.map((i) => cloneNode(sp.nodes[i]));
        nodes[0].hIn = null;
        nodes[nodes.length - 1].hOut = null;
        out.push(makeShape([{ nodes, closed: false }], `${shape.name} piece`, shape.style));
      }
    }
    return out;
  }

  /* ---------------------------------------------- what the inspector reads */

  /** How many anchors are selected, counting whole-shape selections. */
  selectionCount(): number {
    const s = this.store.state;
    /* With nothing selected by key there is nothing for the union in
       `selectedNodeRefs` to dedupe, so the count is just the selected shapes'
       nodes and can be added up instead of materialised. That matters because
       this is called twice on every notification, and a traced document
       selects seven shapes holding 23 454 nodes: the general path builds 23 454
       ref objects and 23 454 dedupe keys to answer "how many", twice, on every
       pointermove, at a measured 13.5 ms per notification. */
    if (s.selection.nodes.size === 0) {
      let n = 0;
      for (const id of s.selection.shapes) {
        const shape = findShape(s.doc, id);
        if (shape) for (const sp of shape.subpaths) n += sp.nodes.length;
      }
      return n;
    }
    return selectedNodes(s.doc, s.selection).length;
  }

  /**
   * The single selected node, or `null` unless exactly one is selected.
   * The inspector edits one node at a time; align handles the rest.
   */
  singleSelectedNode(): { ref: NodeRef; node: PathNode; subpath: Subpath } | null {
    // Asked first, because it can answer "not one" without building the list.
    if (this.selectionCount() !== 1) return null;
    const s = this.store.state;
    const refs = selectedNodes(s.doc, s.selection);
    if (refs.length !== 1) return null;
    const r = refs[0];
    const sp = findShape(this.store.state.doc, r.shape)?.subpaths[r.sp];
    const node = sp?.nodes[r.i];
    return sp && node ? { ref: r, node, subpath: sp } : null;
  }

  /**
   * Set one coordinate of the selected node's anchor or a handle.
   *
   * Setting a handle that does not exist yet creates it, which is the typed
   * equivalent of dragging the hollow ghost out on canvas.
   */
  setNodeCoord(part: HandlePart, axis: 0 | 1, value: number): void {
    const sel = this.singleSelectedNode();
    if (!sel || !Number.isFinite(value)) return;
    const ref = sel.ref;

    this.store.edit((st) => {
      const sp = findShape(st.doc, ref.shape)?.subpaths[ref.sp];
      const n = sp?.nodes[ref.i];
      if (!sp || !n) return;

      if (part === 'anchor') {
        const p: Pt = [n.pt[0], n.pt[1]];
        p[axis] = value;
        moveAnchor(sp, ref.i, p);
        return;
      }

      const existing = part === 'in' ? n.hIn : n.hOut;
      const seed = existing ?? latentHandle(sp, ref.i, part);
      if (!seed) return;
      const p: Pt = [seed[0], seed[1]];
      p[axis] = value;
      moveHandle(sp, ref.i, part, p);
    });
  }

  alignSelection(mode: AlignMode): void {
    const s = this.store.state;
    const refs = selectedNodes(s.doc, s.selection);
    if (refs.length < 2) return;
    this.store.tryEdit((st) => alignNodes(st.doc, refs, mode));
  }

  distributeSelection(axis: 'h' | 'v'): void {
    const s = this.store.state;
    const refs = selectedNodes(s.doc, s.selection);
    if (refs.length < 3) return;
    this.store.tryEdit((st) => distributeNodes(st.doc, refs, axis));
  }

  /* --------------------------------------------- arranging whole shapes */

  /**
   * How many things the arrange controls would move, a group counting as one.
   *
   * What the buttons are enabled from, and what the readout says. Derived on
   * every ask rather than cached, because the answer changes with the selection,
   * with grouping, and with a shape being deleted out from under it.
   */
  get arrangeCount(): number {
    const s = this.store.state;
    return arrangeUnits(s.doc, s.selection.shapes).length;
  }

  /** The box an arrangement happens in: the selection's own, or the canvas. */
  private arrangeFrame(units: Unit[], to: AlignTo): Box | null {
    const s = this.store.state;
    return to === 'canvas' ? viewBoxAsBox(s.doc.viewBox) : unitsBox(units);
  }

  /**
   * Align whole shapes to one edge of the selection or of the canvas.
   *
   * One shape is enough against the canvas -- centring a single icon on it is
   * the commonest reason anyone opens this -- and needs two against the
   * selection, where one shape is already aligned with itself.
   */
  alignShapes(mode: AlignMode, to: AlignTo): boolean {
    const s = this.store.state;
    const units = arrangeUnits(s.doc, s.selection.shapes);
    const least = to === 'canvas' ? 1 : 2;
    if (units.length < least) {
      this.onMessage?.(
        to === 'canvas' ? 'Align needs a shape selected.' : 'Align needs two shapes selected.',
        false,
      );
      return false;
    }
    const ids = new Set(s.selection.shapes);
    /* `tryEdit`, for the reason `reorderSelection` gives: an arrangement that
       moved nothing is not an edit, and pressing Align Left three times should
       not cost two presses of Ctrl+Z that do nothing. The button still reports
       success, because the shapes are where it was asked to put them. */
    this.store.tryEdit((st) => {
      const live = arrangeUnits(st.doc, ids);
      const frame = this.arrangeFrame(live, to);
      return frame ? alignUnits(live, mode, frame) : false;
    });
    return true;
  }

  /** Space the chosen edge of three or more shapes evenly. */
  distributeShapes(mode: AlignMode, to: AlignTo): boolean {
    const s = this.store.state;
    const units = arrangeUnits(s.doc, s.selection.shapes);
    if (units.length < 3) {
      this.onMessage?.('Distribute needs three shapes selected.', false);
      return false;
    }
    const ids = new Set(s.selection.shapes);
    this.store.tryEdit((st) => {
      const live = arrangeUnits(st.doc, ids);
      const frame = this.arrangeFrame(live, to);
      return frame ? distributeUnits(live, mode, frame) : false;
    });
    return true;
  }

  /**
   * Move the selection through the paint order.
   *
   * `tryEdit` rather than `edit`, because a shape already at the front declines
   * and an undo entry for that would cost a press of Ctrl+Z that does nothing.
   * The refusal is silent for the same reason a button at the end of its travel
   * is: nothing has gone wrong, and there is nowhere left to go.
   */
  reorderSelection(move: ZMove): boolean {
    const s = this.store.state;
    if (s.selection.shapes.size === 0) {
      this.onMessage?.('Order needs a shape selected.', false);
      return false;
    }
    const ids = new Set(s.selection.shapes);
    return this.store.tryEdit((st) => reorderShapes(st.doc, ids, move));
  }

  /**
   * Drop the selected shapes before `before` among `parent`'s children.
   *
   * The other half of `reorderSelection`: that one steps, this one lands. The
   * list's own drag calls it with a target it took from the row's siblings, so
   * nothing here has to decide what a legal drop is -- there is no position in
   * one parent's list that breaks §49.
   */
  dropSelection(parent: string | null, before: string | null): boolean {
    const s = this.store.state;
    if (s.selection.shapes.size === 0) return false;
    const ids = new Set(s.selection.shapes);
    return this.store.tryEdit((st) => dropShapes(st.doc, ids, parent, before));
  }

  /** Whether the selection could move through the paint order at all. */
  get canReorder(): boolean {
    return this.store.state.selection.shapes.size > 0;
  }

  /**
   * Put the same gap between neighbouring shapes.
   *
   * A `gap` of `null` means whatever fills the frame, which is the answer when
   * the field is left empty. Anything not finite is treated the same way rather
   * than refused, because a half-typed number in a spin box is not a request.
   */
  spaceShapes(axis: 'h' | 'v', to: AlignTo, gap: number | null): boolean {
    const s = this.store.state;
    const units = arrangeUnits(s.doc, s.selection.shapes);
    if (units.length < 2) {
      this.onMessage?.('Spacing needs two shapes selected.', false);
      return false;
    }
    const g = gap !== null && Number.isFinite(gap) ? gap : null;
    const ids = new Set(s.selection.shapes);
    this.store.tryEdit((st) => {
      const live = arrangeUnits(st.doc, ids);
      const frame = this.arrangeFrame(live, to);
      return frame ? spaceUnits(live, axis, frame, g) : false;
    });
    return true;
  }

  /* ------------------------------------------------- one segment at a time */

  /**
   * The one segment both of whose endpoints are selected, if there is exactly
   * one. Same rule the bend controls and Curve/Straighten use.
   */
  activeSegment(): { shape: string; sp: number; seg: number; bend: Bend | null } | null {
    const s = this.store.state;
    if (this.selectionCount() < 2) return null;
    const sel = s.selection;

    /* Membership is asked one node at a time rather than by materialising the
       whole selection into a Set of keys first. The answer here is `null` the
       moment a second segment qualifies, so with a whole shape selected this
       looks at two segments. Building the Set costs 23 454 refs and 23 454
       strings before the first question is even asked, which measured 12.3 ms on
       every notification: most of what a pointermove costs. */
    const picked = (shape: Shape, spI: number, i: number): boolean =>
      sel.shapes.has(shape.id) || sel.nodes.has(shape.subpaths[spI].nodes[i].id);
    // Shapes with nothing selected in them cannot contribute a segment, and
    // skipping them keeps this off the other 23 000 nodes entirely.
    const touched = new Set(sel.shapes);
    for (const r of selectedRefs(s.doc, sel)) touched.add(r.shape);

    let found: { shape: string; sp: number; seg: number; bend: Bend | null } | null = null;
    for (const shape of s.doc.shapes) {
      if (!touched.has(shape.id)) continue;
      for (let spI = 0; spI < shape.subpaths.length; spI++) {
        const sp = shape.subpaths[spI];
        for (let seg = 0; seg < segmentCount(sp); seg++) {
          if (!picked(shape, spI, seg)) continue;
          if (!picked(shape, spI, (seg + 1) % sp.nodes.length)) continue;
          if (found) return null; // ambiguous: more than one segment qualifies
          found = { shape: shape.id, sp: spI, seg, bend: segmentBend(sp, seg) };
        }
      }
    }
    return found;
  }

  /** Set the active segment's bend outright. */
  setActiveBend(bend: Bend): void {
    const seg = this.activeSegment();
    if (!seg) return;
    this.store.edit((st) => {
      const sp = findShape(st.doc, seg.shape)?.subpaths[seg.sp];
      if (sp && seg.seg < segmentCount(sp)) setSegmentBend(sp, seg.seg, bend);
    });
  }

  /**
   * Drop the active segment out of bend mode and back to free handles.
   *
   * A bend exists only while the two handles stay mirrored, so leaving it means
   * making them genuinely unequal -- there is no flag to clear. Lengthening one
   * by a tenth of a percent is the smallest edit that does it: below what the
   * eye can see, above the tolerance `bendOf` uses to call a pair symmetric.
   */
  freeActiveSegment(): void {
    const seg = this.activeSegment();
    if (!seg?.bend) return;
    this.store.edit((st) => {
      const sp = findShape(st.doc, seg.shape)?.subpaths[seg.sp];
      if (!sp || seg.seg >= segmentCount(sp)) return;
      const n = sp.nodes[seg.seg];
      if (!n.hOut) return;
      n.hOut = [n.pt[0] + (n.hOut[0] - n.pt[0]) * 1.001, n.pt[1] + (n.hOut[1] - n.pt[1]) * 1.001];
    });
  }

  /** Nudge the active segment's bend, for keyboard control. */
  adjustBend(dAngle: number, dLoose: number): void {
    const seg = this.activeSegment();
    if (!seg || !seg.bend) return;
    this.setActiveBend({
      angle: seg.bend.angle + dAngle,
      looseness: Math.max(0.05, seg.bend.looseness + dLoose),
    });
  }

  /* ------------------------------------------------ handles and continuity */

  /**
   * Turn the selected subpaths round.
   *
   * A selected shape means all of its subpaths; selected nodes mean the
   * subpaths they sit in. Both at once is a union, so selecting a shape and one
   * of its own nodes reverses each subpath once rather than twice.
   *
   * The selection needs no repair. It names nodes, and reversing an array
   * moves nodes about without changing which node is which. While it named
   * positions this method carried a remap -- `i` became `n - 1 - i` in an open
   * subpath and `n - i` in a closed one -- and without that remap the highlight
   * stayed on the index while the node moved out from under it.
   */
  reverseSelection(): boolean {
    const s = this.store.state;
    const targets = new Set<string>();
    // A shape id holds no slash, so this pair reads back unambiguously.
    const key = (shape: string, sp: number): string => `${shape}/${sp}`;

    for (const id of s.selection.shapes) {
      const shape = findShape(s.doc, id);
      shape?.subpaths.forEach((_, spI) => targets.add(key(id, spI)));
    }
    for (const r of selectedRefs(s.doc, s.selection)) targets.add(key(r.shape, r.sp));

    if (!targets.size) {
      this.onMessage?.('Select a shape or some nodes to reverse.', false);
      return false;
    }

    let done = 0;
    const ok = this.store.tryEdit((st) => {
      for (const t of targets) {
        const [shapeId, spText] = t.split('/');
        const sp = findShape(st.doc, shapeId)?.subpaths[Number(spText)];
        if (!sp || sp.nodes.length < 2) continue;
        reverseSubpath(sp);
        done++;
      }
      return done > 0;
    });
    if (!ok) return false;

    this.onMessage?.(`Reversed ${done} subpath${done === 1 ? '' : 's'}.`, true);
    return true;
  }

  /** Force every selected anchor into a continuity by moving its handles. */
  setSelectedContinuity(kind: NodeContinuity): void {
    const s = this.store.state;
    const refs = selectedNodes(s.doc, s.selection);
    if (!refs.length) return;

    let changed = 0;
    let alreadySymmetric = 0;
    let atEnd = 0;
    let alreadySo = 0;

    this.store.tryEdit((st) => {
      for (const r of refs) {
        const sp = findShape(st.doc, r.shape)?.subpaths[r.sp];
        const node = sp?.nodes[r.i];
        if (!sp || !node) continue;

        const before = continuityOf(node);
        // An end of an open subpath has a segment on one side only, so there is
        // no pair to line up and smooth/symmetric cannot apply.
        const oneSided =
          kind !== 'cusp' &&
          !sp.closed &&
          (r.i === 0 || r.i === sp.nodes.length - 1) &&
          (!node.hIn || !node.hOut);

        if (setContinuity(sp, r.i, kind)) changed++;
        else if (oneSided) atEnd++;
        else if (kind === 'smooth' && before === 'symmetric') alreadySymmetric++;
        else alreadySo++;
      }
      return changed > 0;
    });

    // A button that does nothing and says nothing reads as broken, so every
    // way of changing nothing below has to reach a message.
    if (changed) return;
    if (alreadySymmetric) {
      this.onMessage?.(
        'Already smooth. Symmetric is smooth with equal handle lengths; drag one to differ.',
        true,
      );
    } else if (atEnd) {
      this.onMessage?.(
        'That node ends the path. There is no second handle to line up with.',
        false,
      );
    } else if (alreadySo) {
      const word = kind === 'cusp' ? 'a cusp' : kind === 'smooth' ? 'smooth' : 'symmetric';
      this.onMessage?.(
        `Already ${word}.`,
        true,
      );
    }
  }

  /**
   * Curve or straighten the segments *between* selected anchors.
   *
   * Acting on segments whose BOTH endpoints are selected is the unambiguous
   * reading: selecting two adjacent nodes and pressing Curve affects exactly
   * the one segment joining them, never the ones trailing off either end.
   */
  setSelectedSegmentsCurved(curved: boolean): void {
    const s = this.store.state;
    const selected = new Set(
      selectedNodes(s.doc, s.selection).map((r) => `${r.shape}/${r.sp}/${r.i}`),
    );
    if (!selected.size) return;

    this.store.edit((st) => {
      for (const shape of st.doc.shapes) {
        shape.subpaths.forEach((sp, spI) => {
          for (let seg = 0; seg < segmentCount(sp); seg++) {
            const a = `${shape.id}/${spI}/${seg}`;
            const b = `${shape.id}/${spI}/${(seg + 1) % sp.nodes.length}`;
            if (selected.has(a) && selected.has(b)) setSegmentCurved(sp, seg, curved);
          }
        });
      }
    });
    void s;
  }

  countNodes(): number {
    return this.store.state.doc.shapes.reduce(
      (a, sh) => a + sh.subpaths.reduce((b, sp) => b + sp.nodes.length, 0),
      0,
    );
  }

  countSegments(): number {
    return this.store.state.doc.shapes.reduce(
      (a, sh) => a + sh.subpaths.reduce((b, sp) => b + segmentCount(sp), 0),
      0,
    );
  }
}
