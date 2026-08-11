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

import { cloneShape } from '../core/types';
import type { Doc, ViewBox } from '../core/types';
import { emptySelection } from './doc';
import type { Selection } from './doc';

/**
 * `ellipse` and `rect` are draw tools: drag on the canvas to create one. They
 * are tools rather than buttons because the size comes from the drag, and
 * because holding the tool lets you place several without going back to a menu.
 */
export type ToolName = 'select' | 'pen' | 'ellipse' | 'rect';

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

export interface EditorState {
  doc: Doc;
  /** What the canvas is currently showing. Not part of the document. */
  camera: ViewBox;
  selection: Selection;
  tool: ToolName;
  deleteMode: DeleteMode;
  /** Corner radius the rect tool draws with, in document units. 0 is square. */
  cornerRadius: number;
  /** Grid step in document units; 0 disables both grid and snapping. */
  gridStep: number;
  snapToGrid: boolean;
  snapToPoints: boolean;
  showGrid: boolean;
  showHandles: boolean;
  /** Render fills as well as outlines. */
  filled: boolean;
  decimals: number;
  minify: boolean;
  /** Whether the source box shows bare path data or a whole SVG document. */
  sourceMode: 'd' | 'svg';
  /** Set when the source box holds text that will not parse. */
  sourceError: string | null;
}

interface Snapshot {
  doc: Doc;
  selection: Selection;
}

const cloneDoc = (d: Doc): Doc => ({
  shapes: d.shapes.map(cloneShape),
  viewBox: { ...d.viewBox },
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

  constructor(doc: Doc) {
    this.state = {
      doc,
      camera: { ...doc.viewBox },
      selection: emptySelection(),
      tool: 'select',
      deleteMode: 'fuse',
      cornerRadius: 0,
      gridStep: 1,
      snapToGrid: true,
      snapToPoints: true,
      showGrid: true,
      showHandles: true,
      filled: false,
      decimals: 3,
      minify: false,
      sourceMode: 'd',
      sourceError: null,
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
    return { doc: cloneDoc(this.state.doc), selection: cloneSelection(this.state.selection) };
  }

  /**
   * Record an undo point. Safe to call repeatedly inside one `edit` -- only the
   * first call in a batch takes a snapshot, so a drag that mutates on every
   * pointermove still collapses to a single undo step.
   */
  checkpoint(): void {
    if (this.batch > 0 && this.batchTook) return;
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
    if (this.batch > 0) this.batchTook = true;
  }

  /** Mutate state and notify, without touching history. */
  update(fn: (s: EditorState) => void): void {
    fn(this.state);
    this.notify();
  }

  /** Checkpoint, mutate, notify. The normal way to make a discrete change. */
  edit(fn: (s: EditorState) => void): void {
    this.checkpoint();
    fn(this.state);
    this.notify();
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

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(this.snapshot());
    this.state.doc = prev.doc;
    this.state.selection = prev.selection;
    this.notify();
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.snapshot());
    this.state.doc = next.doc;
    this.state.selection = next.selection;
    this.notify();
  }
}
