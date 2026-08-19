/**
 * Application state, change notification and undo history.
 *
 * History is whole-document snapshots rather than inverse operations. At logo
 * and icon scale a snapshot is a few kilobytes and cloning it costs
 * microseconds, and the correctness argument is decisive: an op-based history
 * has to get every inverse exactly right, and a single wrong one corrupts the
 * document silently. If a snapshot ever becomes too slow, that is a measurable
 * problem to solve later rather than a guess to design around now.
 */

import { cloneGroup, cloneShape, defaultStyle } from '../core/types';
import type { Doc, Style, ViewBox } from '../core/types';
import { reflowDoc } from './auto';
import { emptySelection, pruneGroups } from './doc';
import type { Selection } from './doc';
import type { Guide } from './guides';
import type { Mat } from '../core/affine';

/** One entry in the palette: a name and the four style values it stands for. */
export interface NamedStyle {
  name: string;
  style: Style;
}

/**
 * `ellipse` and `rect` are draw tools: drag on the canvas to create one. They
 * are tools rather than buttons because the size comes from the drag, and
 * because holding the tool lets you place several without going back to a menu.
 */
export type ToolName = 'select' | 'pen' | 'ellipse' | 'rect' | 'poly' | 'hand';

/**
 * What deleting a node does to the path around it.
 *
 * `fuse` joins the two neighbouring segments into one, so the path stays whole
 * — a pentagon becomes a quadrilateral. It is what every other editor does on
 * Delete, and it is approximate: two cubics cannot always be replaced by one.
 *
 * `split` leaves two ends instead. Exact for everything that survives, since no
 * segment is rebuilt, and the natural reading when you are cutting a path apart
 * rather than simplifying it.
 */
export type DeleteMode = 'fuse' | 'split';

/**
 * A raster image shown under the drawing, to trace over.
 *
 * **Not part of `Doc`, but it is part of the history.** Those are separate
 * questions, and conflating them once cost this editor an undoable backdrop.
 *
 * Out of `Doc`, so it *cannot* leak into an export and cannot be thrown away by
 * Apply replacing the document. In the history anyway, because `src` is an
 * object URL rather than the bytes: cloning this costs the same as cloning a
 * node.
 *
 * `opacity`, `visible` and `locked` ride along in the snapshot but are overlaid
 * with their current values on the way out. Undoing a node move should not flip
 * a checkbox you set afterwards.
 */
export interface Backdrop {
  /** Object URL for the loaded file. Revoked once no snapshot mentions it. */
  src: string;
  name: string;
  /** Placement in document coordinates. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Natural pixel size, kept so "fit" and scaling stay proportional. */
  naturalW: number;
  naturalH: number;
  opacity: number;
  visible: boolean;
  /**
   * While locked, a drag on empty canvas marquee-selects as usual. Unlocked, it
   * moves the backdrop instead. Explicit rather than modifier-based, because
   * lining a reference up is a mode you stay in for a while.
   */
  locked: boolean;
}

export interface EditorState {
  doc: Doc;
  /** What the canvas is currently showing. Not part of the document. */
  camera: ViewBox;
  selection: Selection;
  tool: ToolName;
  deleteMode: DeleteMode;
  /**
   * Show the buttons for operations a keyboard already reaches: Duplicate,
   * Delete, Copy, Cut, Paste and node stepping.
   *
   * On wherever the pointer is coarse, which is the same condition the 44px
   * targets answer to and for the same reason: a finger has no Ctrl+C. Set from
   * the media query at startup and a checkbox after that.
   */
  touchButtons: boolean;
  /**
   * The last matrix put on the selection, and what to call it.
   *
   * Session state, not document state: it describes the gesture you just made,
   * not the drawing. Undoing that gesture leaves it here on purpose -- undo
   * takes back what happened, and what you were about to do again is a
   * different question.
   *
   * The label travels with the matrix rather than being derived from it. A
   * matrix cannot say whether `[1,0,0,1,20,0]` was a nudge, a drag or a typed
   * X, and the readout beside the button is the only thing telling you what a
   * press is about to do.
   */
  lastTransform: { m: Mat; what: string } | null;
  /**
   * What the polygon tool draws next: how many corners, and whether it is a star.
   *
   * The style-for-new-shapes argument (see `style`): carried in the editor so
   * choosing a hexagon once draws three hexagons, and out of the history because
   * setting it is not an edit to the drawing. A shape already drawn keeps no
   * memory of these -- it is nodes and handles from the moment it exists, the
   * same as the ellipse and the rectangle -- so there is nothing here that can
   * disagree with what is on the canvas.
   */
  polygon: { corners: number; star: boolean; ratio: number };
  /** Grid step in document units; 0 disables both grid and snapping. */
  gridStep: number;
  /**
   * What Shift multiplies an arrow-key nudge by.
   *
   * The fine step is the grid step, so a nudge always lands somewhere the tools
   * would snap to; this is the coarse tier. Settable because 10 is right for a
   * step of 1 and much too far for a step of 5.
   */
  nudgeBig: number;
  /**
   * Draw every shape as a plain outline, ignoring its own style.
   *
   * Not the same switch as `filled`, which turns fills off and leaves each
   * shape's stroke alone -- so a shape with `stroke: none` and a fill is
   * *invisible* with fills off, which is the case this exists for. A view
   * switch: it changes nothing in the document and nothing in the export.
   */
  wireframe: boolean;
  snapToGrid: boolean;
  /**
   * Shift and Alt, held down without a keyboard.
   *
   * Seven pointer gestures change what they mean under a modifier: adding to
   * the selection, keeping a scale's proportions, snapping a rotation to 15°,
   * drawing a square or a circle, scaling from the centre, breaking a handle
   * pair, and bending a segment without keeping it symmetric. On a phone there
   * is no key to hold, so all seven were unreachable. These latch instead: they
   * stay on until pressed again, which is visible in the button, rather than
   * clearing after one gesture, which would not be.
   *
   * Input state and nothing else. It never reaches the document, the history or
   * the export, and the controller reads it beside the real key rather than
   * instead of it, so holding Shift still works and does the same thing.
   */
  heldShift: boolean;
  heldAlt: boolean;
  /** Snap to an anchor already in the drawing: the 0-D tier. */
  snapToPoints: boolean;
  /**
   * Snap to a point ON an existing curve rather than only to its anchors: the
   * 1-D tier. See `model/snapping.ts` for how the three tiers resolve.
   */
  snapToBoundary: boolean;
  /**
   * Snap where two outlines cross: a 0-D target like an anchor.
   *
   * Its own switch rather than riding on `snapToPoints`, because it is the one
   * target that has to be computed instead of looked up. Off by default for
   * the same reason.
   */
  snapToIntersections: boolean;
  /**
   * Shift the snap lattice so strokes land on whole pixels rather than anchors.
   *
   * A view-and-input preference like `snapToGrid`, not part of the document: it
   * changes where the next thing you place lands, and nothing already placed.
   * See `model/pixelfit.ts` for what the shift is.
   */
  pixelFit: boolean;
  showGrid: boolean;
  /**
   * Draw the icon keyline grid, and let the tools snap to it.
   *
   * A view-and-input preference like `showGrid`, and for the same reason not
   * part of `Doc`: the keylines are derived from the viewBox every frame (see
   * `model/keylines.ts`), so there is no geometry to keep in step and nothing
   * that could reach a saved file.
   */
  showKeylines: boolean;
  showHandles: boolean;
  /**
   * The style a newly drawn shape gets.
   *
   * Carried in the editor rather than fixed in `makeShape`, so choosing red once
   * makes the next three shapes red. Editing it is not an edit to the document,
   * so it stays out of the history: it describes what you are about to draw, and
   * undoing your way past the moment you picked a colour would be a strange
   * thing for `Ctrl+Z` to do.
   */
  style: Style;
  /**
   * Show each shape's fill. Off draws everything as an outline.
   *
   * A view switch, not a property of the drawing. It decides whether the fills
   * that exist are drawn, and never invents one for a shape whose fill is
   * `none`: that would make "is this shape filled?" unanswerable from the
   * screen.
   */
  filled: boolean;
  decimals: number;
  minify: boolean;
  /** Whether the source box shows bare path data or a whole SVG document. */
  sourceMode: 'd' | 'svg';
  /** Set when the source box holds text that will not parse. */
  sourceError: string | null;
  /**
   * Named fill/stroke sets you can reapply.
   *
   * Session state, not document state and not history: a palette is how you
   * are working, the same as the grid step or the style-for-new-shapes. Undoing
   * a node move has no business forgetting a colour you saved, and a palette
   * cannot be expressed in SVG anyway -- what leaves the editor is the style on
   * each shape, which is what a named style puts there.
   */
  palette: NamedStyle[];
  /** Tracing reference under the artwork. See `Backdrop`. */
  backdrop: Backdrop | null;
  /**
   * Lines you placed, to aim at. Not part of `Doc`, but part of the history.
   *
   * The same split as the backdrop and for the same two reasons: the export is
   * built from the model, so a guide cannot leak into a file; and Apply in the
   * source box replaces the document wholesale, so guides living there would be
   * thrown away as a side effect of editing the path text. Unlike the backdrop
   * they restore wholesale on undo, because a guide has no view switches of its
   * own -- `showGuides` and `guidesLocked` belong to the session, not to the
   * line. See `model/guides.ts`.
   */
  guides: Guide[];
  /** Draw the rulers, and with them the only way to drag a new guide out. */
  showRulers: boolean;
  /** Draw the guides, and let the tools snap to them. */
  showGuides: boolean;
  /** Stop guides being dragged, so a press near one edits the drawing instead. */
  guidesLocked: boolean;
  /**
   * Show alignment lines while dragging, and hold the drag to them.
   *
   * Not a guide and not a snap tier: see `model/smart.ts`. A view-and-input
   * preference, so it stays out of the history like the rest of them.
   */
  smartGuides: boolean;
  /** Hold the pointer to rays from a point. See `model/angles.ts`. */
  snapToAngles: boolean;
  /** Degrees between rays, and where the first one sits. */
  angleStep: number;
  angleBase: number;
  /**
   * Where the rays radiate from, or null to use whatever the gesture started
   * at -- the node being dragged from, or the pen's last point.
   */
  angleOrigin: [number, number] | null;
}

interface Snapshot {
  doc: Doc;
  selection: Selection;
  backdrop: Backdrop | null;
  guides: Guide[];
}

const cloneDoc = (d: Doc): Doc => ({
  shapes: d.shapes.map(cloneShape),
  viewBox: { ...d.viewBox },
  ...(d.groups ? { groups: d.groups.map(cloneGroup) } : {}),
});

const cloneSelection = (s: Selection): Selection => ({
  shapes: new Set(s.shapes),
  nodes: new Set(s.nodes),
});

type Listener = (state: EditorState) => void;

const HISTORY_LIMIT = 200;

export class Store {
  state: EditorState;
  private listeners = new Set<Listener>();
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  /** Depth counter so nested edits produce a single history entry. */
  private batch = 0;
  private batchTook = false;
  /**
   * Called with a backdrop's `src` once nothing can reach it again. Set by
   * whoever created the URL, since freeing it is their business, not the
   * model's.
   */
  onOrphanImage: ((src: string) => void) | null = null;
  /** Images a `tryEdit` has provisionally orphaned. See `take`. */
  private deferred: (Backdrop | null)[] = [];

  constructor(doc: Doc) {
    this.state = {
      doc,
      camera: { ...doc.viewBox },
      selection: emptySelection(),
      tool: 'select',
      deleteMode: 'fuse',
      touchButtons: false,
      lastTransform: null,
      // Five points at 0.382 is the star everybody draws; the polygon half of
      // the tool ignores the ratio until Star is on.
      polygon: { corners: 5, star: false, ratio: 0.382 },
      gridStep: 1,
      nudgeBig: 10,
      wireframe: false,
      snapToGrid: true,
      heldShift: false,
      heldAlt: false,
      snapToPoints: true,
      snapToBoundary: true,
      snapToIntersections: false,
      pixelFit: false,
      showGrid: true,
      showKeylines: false,
      showHandles: true,
      style: defaultStyle(),
      filled: true,
      decimals: 3,
      minify: false,
      sourceMode: 'd',
      sourceError: null,
      backdrop: null,
      palette: [],
      guides: [],
      showRulers: false,
      showGuides: true,
      guidesLocked: false,
      smartGuides: true,
      snapToAngles: false,
      angleStep: 45,
      angleBase: 0,
      angleOrigin: null,
    };
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notify(): void {
    for (const fn of this.listeners) fn(this.state);
  }

  private snapshot(): Snapshot {
    return {
      doc: cloneDoc(this.state.doc),
      selection: cloneSelection(this.state.selection),
      backdrop: this.state.backdrop ? { ...this.state.backdrop } : null,
      guides: this.state.guides.map((g) => ({ ...g })),
    };
  }

  /**
   * Put a snapshot's backdrop back, keeping the view switches as they are now.
   *
   * Which image is loaded and where it sits is part of the drawing session and
   * belongs in the history. How hard you are looking at it does not: undo is for
   * taking back an edit, not for restoring the state of a checkbox.
   */
  private restoreBackdrop(next: Backdrop | null): void {
    const cur = this.state.backdrop;
    if (!next) {
      this.state.backdrop = null;
      return;
    }
    if (cur) {
      this.state.backdrop = {
        ...next,
        opacity: cur.opacity,
        visible: cur.visible,
        locked: cur.locked,
      };
      return;
    }
    /* Coming back from having none, so there are no current switches to keep.
       `visible` is forced rather than restored: hiding an image and then
       removing it snapshots `visible: false`, and undoing that put the record
       back while leaving the canvas empty -- a Remove that announces "undo
       brings it back" and then appears to do nothing. Presence is what was
       undone, so presence is what comes back. */
    this.state.backdrop = { ...next, visible: true };
  }

  /**
   * Every object URL the state or the history can still reach.
   *
   * Cheap by construction: at most 401 records, each contributing one string.
   */
  private liveImages(): Set<string> {
    const out = new Set<string>();
    if (this.state.backdrop) out.add(this.state.backdrop.src);
    for (const s of this.undoStack) if (s.backdrop) out.add(s.backdrop.src);
    for (const s of this.redoStack) if (s.backdrop) out.add(s.backdrop.src);
    return out;
  }

  /**
   * Free the bytes behind backdrops that just fell out of reach.
   *
   * Holding an object URL alive is what makes undoing **Remove** possible, so
   * the URL cannot be revoked when the image leaves the screen -- only when the
   * last snapshot mentioning it is gone. That happens in exactly two places: a
   * history longer than the limit drops its oldest entry, and a fresh edit
   * clears the redo stack. Both call this with what they discarded.
   *
   * The store does not know what an object URL is; `onOrphanImage` is set by the
   * layer that made one.
   */
  private reap(discarded: (Backdrop | null)[]): void {
    const drop = this.onOrphanImage;
    // The overwhelmingly common case is a drawing with no backdrop at all, and
    // there is no reason for it to walk two history stacks on every edit.
    if (!drop || !discarded.some(Boolean)) return;

    const live = this.liveImages();
    const done = new Set<string>();
    for (const b of discarded) {
      if (!b || live.has(b.src) || done.has(b.src)) continue;
      done.add(b.src);
      drop(b.src);
    }
  }

  /**
   * Record an undo point. Safe to call repeatedly inside one `edit` -- only the
   * first call in a batch takes a snapshot, so a drag that mutates on every
   * pointermove still collapses to a single undo step.
   *
   * Returns whether an entry was actually pushed, which `tryEdit` needs.
   */
  checkpoint(): boolean {
    return this.take(false);
  }

  /**
   * The body of `checkpoint`. `defer` parks the freeing of orphaned images in
   * `deferred` instead of doing it now, because `tryEdit` may be about to put
   * the redo stack back and must not have revoked what is on it.
   */
  private take(defer: boolean): boolean {
    if (this.batch > 0 && this.batchTook) return false;
    this.undoStack.push(this.snapshot());
    const dropped = this.undoStack.length > HISTORY_LIMIT ? this.undoStack.shift() : undefined;
    const stale = this.redoStack.splice(0);
    if (this.batch > 0) this.batchTook = true;

    const discarded = [dropped?.backdrop ?? null, ...stale.map((s) => s.backdrop)];
    if (defer) this.deferred = discarded;
    else this.reap(discarded);
    return true;
  }

  /** Mutate state and notify, without touching history. */
  update(fn: (s: EditorState) => void): void {
    fn(this.state);
    this.notify();
  }

  /**
   * Checkpoint, mutate, notify. The normal way to make a discrete change.
   *
   * The auto-smooth sweep runs here rather than at each of the several sites
   * that can disturb an auto node's neighbour, because a site that gets its
   * indices wrong leaves a stale handle that reads as a rendering bug. One pass
   * over nodes about to be redrawn anyway.
   *
   * `pruneGroups` is here for the same reason: eight places remove shapes, any
   * can empty a group, and an empty group is a row in the list and a `<g>` in
   * the export.
   *
   * `update` does not sweep -- it is for camera, tool and selection, and the
   * geometry has not changed.
   */
  edit(fn: (s: EditorState) => void): void {
    this.checkpoint();
    fn(this.state);
    reflowDoc(this.state.doc);
    pruneGroups(this.state.doc);
    this.notify();
  }

  /**
   * `edit`, for operations that may turn out to have nothing to do.
   *
   * `edit` checkpoints first and asks questions later, which is right for a
   * drag — you cannot know where it will end — and wrong for a button, because
   * an operation that declines still lands an empty entry on the undo stack and
   * throws the redo stack away. Pressing a dead button five times then costs
   * five presses of Ctrl+Z, none of which visibly do anything.
   *
   * So the mutation reports whether it changed the document, and a `false`
   * takes the checkpoint back. The redo stack is restored with it: it was only
   * cleared on the assumption that an edit was about to happen.
   *
   * At exactly `HISTORY_LIMIT` entries the push that this cancels has already
   * shifted the oldest one off, which is not recoverable. Losing the far end of
   * a 200-deep history is a fair price for not corrupting the near end.
   */
  tryEdit(fn: (s: EditorState) => boolean): boolean {
    const redo = this.redoStack.slice();
    const took = this.batchTook;
    this.deferred = [];
    const pushed = this.take(true);
    const orphans = this.deferred;
    this.deferred = [];

    const changed = fn(this.state);
    if (changed) {
      reflowDoc(this.state.doc);
      pruneGroups(this.state.doc);
      // After the mutation, so an image the edit itself replaced is seen.
      this.reap(orphans);
      this.notify();
      return true;
    }

    if (pushed) {
      this.undoStack.pop();
      this.redoStack = redo;
      this.batchTook = took;
      /* Reap after putting the redo stack back, not instead of it. `orphans`
         also holds whatever `HISTORY_LIMIT` shifted off the far end, and the pop
         above does not bring that back -- so skipping the reap entirely leaked
         that image for the life of the page. Running it here is safe because
         `reap` recomputes what is reachable from the stacks as they now are. */
      this.reap(orphans);
    }
    return false;
  }

  /**
   * Group a sequence of mutations under one undo entry. Used by drags: begin on
   * pointerdown, mutate freely on move, end on pointerup.
   */
  beginBatch(): void {
    this.batch++;
  }

  endBatch(): void {
    this.batch = Math.max(0, this.batch - 1);
    if (this.batch === 0) this.batchTook = false;
  }

  /**
   * Whether the batch currently open has already taken a checkpoint.
   *
   * A gesture that abandons itself has to know whether it has anything of its
   * own to roll back. Since drags stopped checkpointing on pointerdown, an
   * abandoned press that never moved holds an open batch and no entry, and
   * rolling back regardless would pop whatever the previous edit left there.
   */
  get batchDirty(): boolean {
    return this.batch > 0 && this.batchTook;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /**
   * Abandon the last checkpoint, restoring it without offering a redo.
   *
   * `undo` is for a user who may change their mind, so it keeps what it undid.
   * Cancelling a gesture is not that: the half-drawn thing was never wanted,
   * and leaving it one Ctrl+Shift+Z away means an abandoned shape can come back
   * from a keystroke aimed at something else. So this discards rather than
   * undoing, and Escape must route here and not to `undo`.
   */
  rollback(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    const abandoned = this.state.backdrop;
    this.state.doc = prev.doc;
    this.state.selection = prev.selection;
    this.state.guides = prev.guides;
    this.restoreBackdrop(prev.backdrop);
    // Nothing kept a copy of what the abandoned gesture was holding.
    this.reap([abandoned]);
    this.notify();
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(this.snapshot());
    this.state.doc = prev.doc;
    this.state.selection = prev.selection;
    this.state.guides = prev.guides;
    this.restoreBackdrop(prev.backdrop);
    this.notify();
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.snapshot());
    this.state.doc = next.doc;
    this.state.selection = next.selection;
    this.state.guides = next.guides;
    this.restoreBackdrop(next.backdrop);
    this.notify();
  }
}
