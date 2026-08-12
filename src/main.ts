/**
 * Wiring: document -> store -> canvas -> controller, plus the panels.
 */

import './ui/styles.css';
import { PathSyntaxError } from './core/parse';
import { exportPathData, exportSvg, importSvg, xmlId } from './io/svg';
import type { BooleanOp } from './io/boolean';
import { docBBox, emptyDoc, findShape, nextId, parseNodeKey, selectedShapes, shapeFromPath } from './model/doc';
import { isPathEnd, latentHandle, transformShape } from './model/ops';
import { translate } from './core/affine';
import { cloneShape, continuityOf } from './core/types';
import type { Shape, Style, ViewBox } from './core/types';
import { serialisePath } from './core/serialise';
import { phaseInForce, phaseLabel } from './model/pixelfit';
import { snapLabel } from './model/snapping';
import { DEFAULT_TRACE, rasterFrom } from './model/trace';
import type { Placement, TraceOptions, TraceResult } from './model/trace';
import TraceWorker from './model/trace.worker?worker&inline';
import type { TraceReply, TraceRequest } from './model/trace.worker';
import { Store } from './model/store';
import type { Backdrop, EditorState } from './model/store';
import { Canvas } from './view/canvas';
import { fitAspect, fitBox, gridDisplayFor, screenToDoc, zoomAt } from './view/viewport';
import { Controller } from './tools/controller';
import type { AlignMode } from './model/ops';
import { $ } from './view/dom';
import { installTooltips } from './ui/tooltip';

/* A starter shape that exercises the whole import path: cubics, lines, an
   elliptical arc and a quadratic all become the same kind of node. */
const STARTER =
  'M 20 30 C 20 20 30 12 40 12 L 60 12 A 8 8 0 0 1 68 20 L 68 40 ' +
  'Q 68 52 56 52 L 32 52 C 24 52 20 46 20 38 Z';

const doc = emptyDoc();
doc.viewBox = { x: 0, y: 0, w: 88, h: 64 };
doc.shapes.push(shapeFromPath(STARTER, 'starter'));

const store = new Store(doc);
// The store keeps backdrops in the history so removing one can be undone, which
// means it, not the loader, decides when the bytes are no longer wanted.
store.onOrphanImage = (src) => URL.revokeObjectURL(src);
const canvasRoot = $('#canvas');
const canvas = new Canvas(canvasRoot);
const controller = new Controller(store, canvas);

/* ------------------------------------------------------------------ theme */

const themeBtn = $('#theme') as HTMLButtonElement;
themeBtn.addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme');
  const dark = cur ? cur === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.setAttribute('data-theme', dark ? 'light' : 'dark');
  controller.schedule();
});

/* ----------------------------------------------------------------- panels */

/* Which panels are open is view state, not document state: it does not belong
   in the store, and undo has no business restoring a drawer. The canvas gives
   up the space rather than the panel floating over it, so nothing on screen is
   ever hidden underneath one -- the controller's ResizeObserver picks up the
   new box and re-fits the camera aspect. */
const app = $('#app');
const toggleSrcBtn = $('#toggleSrc') as HTMLButtonElement;
const toggleRailBtn = $('#toggleRail') as HTMLButtonElement;

const sourcePanel = $('#sourcepanel') as HTMLElement;
const rail = $('#rail') as HTMLElement;

function setPanel(which: 'src' | 'rail', open: boolean): void {
  if (which === 'src') {
    app.classList.toggle('src-open', open);
    toggleSrcBtn.setAttribute('aria-pressed', String(open));
    toggleSrcBtn.setAttribute('aria-expanded', String(open));
    /* A collapsed panel is `height: 0; overflow: hidden`, which hides it from
       sight and from nobody else: its textarea and its Apply, Copy and Download
       buttons stayed in the tab order, so Tab landed on controls that were not
       on screen and the tooltip layer popped a tip for a button nobody could
       see. `inert` is the one thing that removes an element from focus, from
       hit-testing and from the accessibility tree at once. */
    sourcePanel.inert = !open;
    /* Catch up on whatever was skipped while it was shut, before the drawer is
       visible, so it never shows the old text even for a frame.

       Measured redundant, and kept anyway. Opening the drawer takes space from
       the canvas, which resizes it, which trips the controller's ResizeObserver,
       which refits the camera through `store.update`, which notifies, which
       refreshes the box -- so removing this line changes nothing observable and
       the scenario cannot tell the difference. That chain is four unrelated
       components long and none of them is about the source box. A layout that
       floated the drawer over the canvas instead of squeezing it would break
       every link at once, silently. */
    if (open) refreshSource();
    // The textarea keeps focus when the drawer closes under it, and the
    // subscriber skips refreshing a focused box, so reopening showed stale text.
    if (!open && sourcePanel.contains(document.activeElement)) {
      (document.activeElement as HTMLElement).blur();
    }
  } else {
    app.classList.toggle('no-rail', !open);
    toggleRailBtn.setAttribute('aria-pressed', String(open));
    toggleRailBtn.setAttribute('aria-expanded', String(open));
    rail.inert = !open;
    if (!open && rail.contains(document.activeElement)) {
      (document.activeElement as HTMLElement).blur();
    }
  }
}
const isOpen = (which: 'src' | 'rail'): boolean =>
  which === 'src' ? app.classList.contains('src-open') : !app.classList.contains('no-rail');

toggleSrcBtn.addEventListener('click', () => setPanel('src', !isOpen('src')));
toggleRailBtn.addEventListener('click', () => setPanel('rail', !isOpen('rail')));
$('#closeSrc').addEventListener('click', () => setPanel('src', false));

window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'e') {
    e.preventDefault();
    setPanel('src', !isOpen('src'));
  } else if (k === 'b') {
    e.preventDefault();
    setPanel('rail', !isOpen('rail'));
  }
});

/* ------------------------------------------------------------ rail tabs */

/**
 * Three tabs over eleven groups, because a single scrolling column had become
 * a list to hunt through rather than a panel to read.
 *
 * The split is by what a control acts on: a whole shape, a node, or the
 * document. Nothing switches tab on its own. An inspector that jumped to Node
 * the moment you clicked a point would move the button you were reaching for,
 * and the cost of a wrong guess is higher than the cost of one click.
 *
 * `hidden` rather than a class, so a control in a tab you cannot see is also out
 * of the tab order and out of the accessibility tree, the same reasoning as
 * `inert` on a closed panel.
 */
const tabs = [...document.querySelectorAll<HTMLButtonElement>('.tab')];

function selectTab(id: string): void {
  for (const tab of tabs) {
    const on = tab.id === id;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    ($(`#${tab.getAttribute('aria-controls')}`) as HTMLElement).hidden = !on;
  }
}

for (const [i, tab] of tabs.entries()) {
  tab.addEventListener('click', () => selectTab(tab.id));
  // The roving-tabindex pattern: one stop in the tab order, arrows move within.
  tab.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = tabs[(i + step + tabs.length) % tabs.length];
    selectTab(next.id);
    next.focus();
  });
}

/* ------------------------------------------------------------------ tools */

const TOOLS = ['select', 'pen', 'ellipse', 'rect', 'hand'] as const;
type Tool = (typeof TOOLS)[number];
const isTool = (v: string | null | undefined): v is Tool => TOOLS.includes(v as Tool);

const toolSeg = $('#tool');
toolSeg.addEventListener('click', (e) => {
  const v = (e.target as HTMLElement).closest('button')?.getAttribute('data-v');
  if (!isTool(v)) return;
  store.update((s) => (s.tool = v));
  // Leaving the pen for any other tool ends the path it was drawing, rather
  // than leaving it open to be extended by a click made with something else.
  if (v !== 'pen') controller.finishPen();
});

const on = (sel: string, fn: () => void): void => $(sel).addEventListener('click', fn);

// Notices raised from inside the controller -- reached from both the button and
// the keyboard, so they cannot be reported at the call site.
controller.onMessage = (message, ok) => {
  const el = $('#status');
  el.textContent = message;
  el.className = ok ? 'st ok' : 'st err';
};

// Refused mid-gesture for the same reason the keyboard refuses it: the drag is
// standing on a checkpoint, and popping it makes the drag roll back the edit
// before it. A second finger can reach these while the first is still down.
on('#undo', () => !controller.busy && store.undo());
on('#redo', () => !controller.busy && store.redo());
on('#del', () => controller.deleteSelection());
on('#curve', () => controller.setSelectedSegmentsCurved(true));
on('#straight', () => controller.setSelectedSegmentsCurved(false));

const zoom = (f: number): void =>
  store.update((s) => {
    s.camera = zoomAt(s.camera, f, [s.camera.x + s.camera.w / 2, s.camera.y + s.camera.h / 2]);
  });
on('#zoomin', () => zoom(1 / 1.25));
on('#zoomout', () => zoom(1.25));

const fit = (): void =>
  store.update((s) => {
    const b = docBBox(s.doc);
    if (b) s.camera = fitBox(b, canvas.overlay);
  });
on('#fit', fit);

/* Click the zoom readout to return to 1:1, keeping the centre of the view where
   it is. One doc unit per pixel is the scale icon work is checked at, and
   getting back to it by wheel alone is guesswork. */
on('#zoomval', () => {
  store.update((s) => {
    const box = canvas.overlay.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const cx = s.camera.x + s.camera.w / 2;
    const cy = s.camera.y + s.camera.h / 2;
    s.camera = { x: cx - box.width / 2, y: cy - box.height / 2, w: box.width, h: box.height };
  });
});

/* ------------------------------------------------------------- transforms */

document.querySelectorAll<HTMLButtonElement>('[data-tr]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const kind = btn.getAttribute('data-tr');
    if (kind === 'rot90') controller.applyTransform('rotate', 90);
    else if (kind === 'rot-90') controller.applyTransform('rotate', -90);
    else if (kind === 'flipH') controller.applyTransform('flipH');
    else if (kind === 'flipV') controller.applyTransform('flipV');
  });
});

on('#rotate', () => controller.applyTransform('rotate', Number(($('#angle') as HTMLInputElement).value) || 0));
on('#scaleGo', () => {
  const v = Number(($('#scale') as HTMLInputElement).value);
  if (v > 0) controller.applyTransform('scale', v);
});

/* ------------------------------------------------------------- checkboxes */

const bindCheck = (
  id: string,
  key:
    | 'showGrid'
    | 'snapToGrid'
    | 'snapToPoints'
    | 'snapToBoundary'
    | 'pixelFit'
    | 'showHandles'
    | 'filled'
    | 'wireframe'
    | 'minify',
): void => {
  const input = $(id) as HTMLInputElement;
  input.checked = store.state[key];
  input.addEventListener('change', () => store.update((s) => ((s[key] as boolean) = input.checked)));
};
bindCheck('#showGrid', 'showGrid');
bindCheck('#snapGrid', 'snapToGrid');
bindCheck('#snapPoints', 'snapToPoints');
bindCheck('#snapBoundary', 'snapToBoundary');
bindCheck('#pixelFit', 'pixelFit');
bindCheck('#showHandles', 'showHandles');
bindCheck('#filled', 'filled');
bindCheck('#wireframe', 'wireframe');
bindCheck('#minify', 'minify');

const gridInput = $('#gridStep') as HTMLInputElement;
gridInput.value = String(store.state.gridStep);
gridInput.addEventListener('input', () =>
  store.update((s) => (s.gridStep = Math.max(0, Number(gridInput.value) || 0))),
);

const nudgeBigInput = $('#nudgeBig') as HTMLInputElement;
nudgeBigInput.value = String(store.state.nudgeBig);
nudgeBigInput.addEventListener('input', () =>
  // Floored at 1: a multiplier below one would make Shift move things *less*
  // than a bare arrow key, which is the opposite of what the key is for.
  store.update((s) => (s.nudgeBig = Math.max(1, Number(nudgeBigInput.value) || 1))),
);

const radiusInput = $('#cornerRadius') as HTMLInputElement;
radiusInput.value = String(store.state.cornerRadius);
radiusInput.addEventListener('input', () =>
  store.update((s) => (s.cornerRadius = Math.max(0, Number(radiusInput.value) || 0))),
);

on('#circularise', () => controller.circulariseSelection());

/* Rounding an existing corner, which is what the rectangle tool's radius does
   while drawing and nothing could do afterwards. */
const roundR = $('#roundR') as HTMLInputElement;
on('#roundCorner', () => controller.roundSelection(Number(roundR.value)));

/**
 * Collapse a control's stream of `input` events into one undo entry.
 *
 * A typed number fires one per keystroke, a slider one per pixel, and a colour
 * picker one per pixel of a two-dimensional drag. Each would be its own step,
 * so choosing a shade of blue would cost twenty presses of Ctrl+Z to take back.
 * A batch opens on the first event and closes when the control settles.
 *
 * It closes on `change` as well as `blur`, because a slider or a picker never
 * gets a blur if you use it and then reach straight for the canvas.
 */
const openStreams = new Set<() => void>();

/* A number field only fires `change` when it loses focus, and pressing the
   pointer down on the canvas does not blur it until after `pointerdown` has been
   delivered. So a drag could begin while a field's batch was still open, which
   made the drag take no checkpoint of its own and put Escape in the position of
   rolling back the *field's* edit, with no redo offered. Closing every open
   stream at the start of any press elsewhere removes the overlap. */
window.addEventListener(
  'pointerdown',
  () => {
    for (const close of [...openStreams]) close();
  },
  true,
);

const streamed = (input: HTMLElement, fn: () => void): void => {
  let open = false;
  const close = (): void => {
    if (!open) return;
    open = false;
    openStreams.delete(close);
    store.endBatch();
  };
  input.addEventListener('input', () => {
    if (!open) {
      open = true;
      openStreams.add(close);
      store.beginBatch();
    }
    fn();
  });
  input.addEventListener('change', close);
  input.addEventListener('blur', close);
};

/**
 * Wire a numeric control to the state.
 *
 * A typed number fires `input` per keystroke and a dragged slider fires one per
 * pixel, which would be an undo entry each. A batch opens on the first of them
 * and closes when the control settles, so the whole adjustment is one step. It
 * closes on `change` as well as `blur`, because a range input never gets a blur
 * if you drag it and then reach straight for the canvas.
 *
 * `history: false` is for controls that change how something looks rather than
 * what it is. Those never enter the undo stack at all.
 */
const liveNum = (
  id: string,
  apply: (s: EditorState, v: number) => boolean,
  history = true,
): void => {
  const input = $(id) as HTMLInputElement;
  let open = false;
  const close = (): void => {
    if (!open) return;
    open = false;
    store.endBatch();
  };
  input.addEventListener('input', () => {
    const v = Number(input.value);
    if (!Number.isFinite(v)) return;
    if (!history) {
      store.update((s) => apply(s, v));
      return;
    }
    if (!open) {
      open = true;
      store.beginBatch();
    }
    store.tryEdit((s) => apply(s, v));
  });
  input.addEventListener('change', close);
  input.addEventListener('blur', close);
};

/* ----------------------------------------------------------------- style */

/**
 * Fill, stroke, width and fill rule.
 *
 * `<input type="color">` speaks only `#rrggbb`, and a document can hold any CSS
 * colour, `currentColor`, or a gradient reference. So the picker is written to
 * only when the stored value is a plain hex, and the document is written to only
 * when someone actually moves the picker. Anything else is shown as it is in the
 * group's header rather than silently rounded to black.
 */
const HEX = /^#[0-9a-f]{6}$/i;
/** `#f00` is as ordinary as `#ff0000`; the picker just cannot hold the short form. */
const SHORT_HEX = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const asHex = (c: string): string | null => {
  if (HEX.test(c)) return c;
  const m = SHORT_HEX.exec(c);
  return m ? `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}` : null;
};
const fillColour = $('#fillColour') as HTMLInputElement;
const strokeColour = $('#strokeColour') as HTMLInputElement;
const fillNone = $('#fillNone') as HTMLInputElement;
const strokeNone = $('#strokeNone') as HTMLInputElement;
const strokeWidthInput = $('#strokeWidth') as HTMLInputElement;

/** What the panel currently describes: the selection, or the next new shape. */
const styleShown = (): Style => {
  const s = store.state;
  const sel = selectedShapes(s.doc, s.selection);
  return sel.length ? sel[0].style : s.style;
};

// Dragging inside a colour picker fires `input` per pixel, so both of these go
// through the same batching as every other continuous control.
streamed(fillColour, () => controller.setStyle({ fill: fillColour.value }));
streamed(strokeColour, () => controller.setStyle({ stroke: strokeColour.value }));

/* Unticking `none` has to put a colour back, and the picker is the only place
   one is on offer: the stored value is the string `none`, which carries no hue
   to return to. */
fillNone.addEventListener('change', () =>
  controller.setStyle({ fill: fillNone.checked ? 'none' : fillColour.value }),
);
strokeNone.addEventListener('change', () =>
  controller.setStyle({ stroke: strokeNone.checked ? 'none' : strokeColour.value }),
);

streamed(strokeWidthInput, () => {
  const v = Number(strokeWidthInput.value);
  if (!Number.isFinite(v) || v < 0) return;
  controller.setStyle({ strokeWidth: v });
});

$('#fillRule').addEventListener('click', (e) => {
  const v = (e.target as HTMLElement).closest('button')?.getAttribute('data-fr');
  if (v === 'nonzero' || v === 'evenodd') controller.setStyle({ fillRule: v });
});

/* ---------------------------------------------------------------- canvas */

/**
 * The document's own frame: the `viewBox` the export writes.
 *
 * Editable, and never changed by anything else. Drawing outside it is allowed
 * and leaves it alone, which is right for icon work where the page is chosen
 * first and the margins matter, and was baffling while nothing on screen said
 * where the page was. It is drawn now, and this is where the numbers live.
 */
const vbNum = (id: string, axis: 'x' | 'y' | 'w' | 'h'): void =>
  liveNum(id, (s, v) => {
    // A canvas with no width has no export and no fit. Refusing is better than
    // accepting a number that makes the document unusable until it is undone.
    if ((axis === 'w' || axis === 'h') && !(v > 0)) return false;
    if (s.doc.viewBox[axis] === v) return false;
    s.doc.viewBox = { ...s.doc.viewBox, [axis]: v };
    return true;
  });
vbNum('#vbx', 'x');
vbNum('#vby', 'y');
vbNum('#vbw', 'w');
vbNum('#vbh', 'h');
on('#vbFit', () => controller.fitCanvasToDrawing());

/**
 * How far Simplify may move the drawing, in document units.
 *
 * A fixed default cannot work: 0.25 is a rounding error on a 1000 unit map and
 * a visible dent on a 16 unit icon. So it starts as a quarter of a percent of
 * the document's diagonal, which is roughly one screen pixel at fit-to-window,
 * and follows the document until the moment someone types their own number.
 * After that it is theirs.
 */
const simplifyTol = $('#simplifyTol') as HTMLInputElement;
let tolChosen = false;
const defaultTol = (vb: ViewBox): number => +(Math.hypot(vb.w, vb.h) * 0.0025).toPrecision(2);
simplifyTol.addEventListener('input', () => (tolChosen = true));
/* Whether Simplify may replace curves as well as remove nodes. Kept out of the
   store on purpose: it is a preference about the next command, not part of the
   document, and the store is what history snapshots. */
const redrawEl = $('#simplifyRedraw') as HTMLInputElement;
function paintRedraw(): void {
  /* Refitting needs a budget to fit inside, and Within 0 is the instruction to
     move nothing. Leaving the box tickable there would offer a choice that
     cannot act. */
  redrawEl.disabled = !(Number(simplifyTol.value) > 0);
}
simplifyTol.addEventListener('input', paintRedraw);
paintRedraw();

on('#simplify', () => controller.simplifySelection(Number(simplifyTol.value), redrawEl.checked));
on('#reverse', () => controller.reverseSelection());

const decInput = $('#decimals') as HTMLInputElement;
decInput.value = String(store.state.decimals);
decInput.addEventListener('input', () =>
  store.update((s) => (s.decimals = Math.min(9, Math.max(0, Number(decInput.value) || 0)))),
);

/* -------------------------------------------------------- node inspector */

const nodeGroup = $('#nodegroup');
const nodeInfo = $('#nodeinfo');
const alignInfo = $('#aligninfo');
const ntypeSeg = $('#ntype');

/** The six coordinate fields, tagged with which point and axis they drive. */
const coordFields: { input: HTMLInputElement; part: 'anchor' | 'in' | 'out'; axis: 0 | 1 }[] = [
  { input: $('#nx') as HTMLInputElement, part: 'anchor', axis: 0 },
  { input: $('#ny') as HTMLInputElement, part: 'anchor', axis: 1 },
  { input: $('#hix') as HTMLInputElement, part: 'in', axis: 0 },
  { input: $('#hiy') as HTMLInputElement, part: 'in', axis: 1 },
  { input: $('#hox') as HTMLInputElement, part: 'out', axis: 0 },
  { input: $('#hoy') as HTMLInputElement, part: 'out', axis: 1 },
];

for (const f of coordFields) {
  // `change` rather than `input`: committing on every keystroke would push an
  // undo entry per character and fight the field while a number is half-typed.
  f.input.addEventListener('change', () => {
    const v = Number(f.input.value);
    if (Number.isFinite(v)) controller.setNodeCoord(f.part, f.axis, v);
  });
  f.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') f.input.blur();
  });
}

ntypeSeg.addEventListener('click', (e) => {
  const v = (e.target as HTMLElement).closest('button')?.getAttribute('data-v');
  if (v === 'corner' || v === 'smooth' || v === 'symmetric') controller.setSelectedContinuity(v);
});

on('#breakPath', () => controller.breakAtSelection());
on('#joinPath', () => controller.joinSelection('connect'));
on('#mergePath', () => controller.joinSelection('merge'));
on('#fuseNodes', () => controller.fuseSelection());
on('#fitPixels', () => controller.fitToPixels());
on('#delNode', () => controller.deleteSelection());

const delModeSeg = $('#delmode');
delModeSeg.addEventListener('click', (e) => {
  const v = (e.target as HTMLElement).closest('button')?.getAttribute('data-dm');
  if (v === 'fuse' || v === 'split') store.update((s) => (s.deleteMode = v));
});

document.querySelectorAll<HTMLButtonElement>('[data-al]').forEach((b) =>
  b.addEventListener('click', () => controller.alignSelection(b.getAttribute('data-al') as AlignMode)),
);
document.querySelectorAll<HTMLButtonElement>('[data-di]').forEach((b) =>
  b.addEventListener('click', () => controller.distributeSelection(b.getAttribute('data-di') as 'h' | 'v')),
);

const bendAngle = $('#bendAngle') as HTMLInputElement;
const bendLoose = $('#bendLoose') as HTMLInputElement;
const bendInfo = $('#bendinfo');

const commitBend = (): void => {
  const seg = controller.activeSegment();
  if (!seg) return;
  const a = Number(bendAngle.value);
  const l = Number(bendLoose.value);
  if (!Number.isFinite(a) || !Number.isFinite(l)) return;
  controller.setActiveBend({ angle: a, looseness: Math.max(0.05, l) });
};
for (const inp of [bendAngle, bendLoose]) {
  inp.addEventListener('change', commitBend);
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') inp.blur();
  });
}
on('#bendFlat', () => controller.setActiveBend({ angle: 0, looseness: 1 }));
on('#bendFree', () => controller.freeActiveSegment());

function refreshBend(): void {
  const seg = controller.activeSegment();
  const on = !!seg;
  bendAngle.disabled = !on || !seg!.bend;
  bendLoose.disabled = !on || !seg!.bend;
  ($('#bendFlat') as HTMLButtonElement).disabled = !on;
  ($('#bendFree') as HTMLButtonElement).disabled = !on || !seg!.bend;

  if (!seg) {
    bendInfo.textContent = 'no segment';
    bendAngle.value = '';
    bendLoose.value = '';
    return;
  }
  if (!seg.bend) {
    bendInfo.textContent = 'free handles';
    bendAngle.value = '';
    bendLoose.value = '';
    return;
  }
  bendInfo.textContent = `seg ${seg.seg}`;
  if (document.activeElement !== bendAngle) bendAngle.value = (+seg.bend.angle.toFixed(2)).toString();
  if (document.activeElement !== bendLoose) bendLoose.value = (+seg.bend.looseness.toFixed(3)).toString();
}

function refreshInspector(): void {
  const sel = controller.singleSelectedNode();
  const count = controller.selectionCount();

  nodeGroup.classList.toggle('disabled', count === 0);
  nodeInfo.textContent = sel ? `${sel.ref.sp}/${sel.ref.i}` : count ? `${count} selected` : 'none';
  alignInfo.textContent = count >= 2 ? `${count} nodes` : 'needs 2+';

  // These read out what the node's handles currently say, and clicking one
  // moves the handles to match. There is no mode being set, so the highlight
  // can never drift away from what is drawn.
  const cur = sel ? continuityOf(sel.node) : null;
  for (const b of ntypeSeg.querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.getAttribute('data-v') === cur));
  }
  document.querySelectorAll<HTMLButtonElement>('[data-al]').forEach((b) => (b.disabled = count < 2));
  document.querySelectorAll<HTMLButtonElement>('[data-di]').forEach((b) => (b.disabled = count < 3));

  // Break needs one node with a path on both sides of it. An endpoint has only
  // one, so there is nothing to split off.
  const atEnd = !!sel && !sel.subpath.closed && (sel.ref.i === 0 || sel.ref.i === sel.subpath.nodes.length - 1);
  ($('#breakPath') as HTMLButtonElement).disabled = !sel || atEnd;
  ($('#delNode') as HTMLButtonElement).disabled = count === 0;
  /* The group is greyed with `pointer-events: none`, which stops the mouse and
     not the keyboard: Tab still landed on these and Space still fired them.
     Every other control in the group was disabled explicitly and the newer ones
     were missed. */
  ($('#roundCorner') as HTMLButtonElement).disabled = count === 0;
  ($('#roundR') as HTMLInputElement).disabled = count === 0;
  for (const b of ntypeSeg.querySelectorAll('button')) b.disabled = !sel;

  // Join is the inverse: exactly two nodes, each a free end of an open path.
  const ends = [...store.state.selection.nodes].map(parseNodeKey).filter((r) => {
    const sp = findShape(store.state.doc, r.shape)?.subpaths[r.sp];
    return !!sp && isPathEnd(sp, r.i);
  });
  const twoEnds = count === 2 && ends.length === 2;
  ($('#joinPath') as HTMLButtonElement).disabled = !twoEnds;
  ($('#mergePath') as HTMLButtonElement).disabled = !twoEnds;
  /* Fuse takes either reading: two nodes to weld, or a wider selection to sweep
     for zero-length segments. Two free ends is the one case it declines, since
     that is Merge's, so the button goes with it rather than offering a press
     that can only answer back. */
  ($('#fuseNodes') as HTMLButtonElement).disabled =
    twoEnds || (count === 0 && store.state.selection.shapes.size === 0);

  const dp = store.state.decimals;
  for (const f of coordFields) {
    // Never clobber a field mid-edit.
    if (document.activeElement === f.input) continue;
    if (!sel) {
      f.input.value = '';
      f.input.disabled = true;
      continue;
    }
    const pt =
      f.part === 'anchor'
        ? sel.node.pt
        : (f.part === 'in' ? sel.node.hIn : sel.node.hOut) ??
          latentHandle(sel.subpath, sel.ref.i, f.part);
    if (!pt) {
      // No segment on that side at all, so there is nothing to curve.
      f.input.value = '';
      f.input.disabled = true;
      continue;
    }
    f.input.disabled = false;
    f.input.value = (+pt[f.axis].toFixed(dp)).toString();
  }
}

/* ----------------------------------------------------------------- source */

const src = $('#src') as HTMLTextAreaElement;
const status = $('#status');
const srcinfo = $('#srcinfo');

/* Apply the initial panel state through the same path, so `inert` and the ARIA
   attributes start out agreeing with the CSS rather than a frame behind it.
   Down here rather than beside `setPanel`, because opening the source drawer
   now refreshes its contents, and that reads `src` and `srcinfo` -- which are
   declared just above. Called any earlier it would work only for as long as the
   drawer happened to start closed. */
setPanel('src', isOpen('src'));
setPanel('rail', isOpen('rail'));
const srcHint = $('#srchint');

/**
 * The one shape the `d` box refers to, or `null` when it refers to everything.
 *
 * Path data has no way to express shape boundaries, so a concatenated `d` for
 * several shapes cannot be applied back without fusing them. Scoping the box to
 * a single selected shape makes the round trip lossless for the common case:
 * pick a shape, edit its `d`, apply it back to that shape alone.
 */
function scopedShape(): Shape | null {
  const s = store.state;
  const ids = new Set(s.selection.shapes);
  for (const key of s.selection.nodes) ids.add(parseNodeKey(key).shape);
  if (ids.size !== 1) return null;
  return s.doc.shapes.find((sh) => ids.has(sh.id)) ?? null;
}

/** What the source box should currently show. */
function currentSource(): string {
  const s = store.state;
  const opts = { decimals: s.decimals, minify: s.minify };
  if (s.sourceMode === 'svg') return exportSvg(s.doc, opts);
  const one = scopedShape();
  return one ? serialisePath(one.subpaths, opts) : exportPathData(s.doc, opts);
}

const srcModeSeg = $('#srcmode');
srcModeSeg.addEventListener('click', (e) => {
  const v = (e.target as HTMLElement).closest('button')?.getAttribute('data-v');
  if (v === 'd' || v === 'svg') store.update((s) => (s.sourceMode = v));
});

/**
 * Replace the document from the source box.
 *
 * `importSvg` sniffs the input, so either a bare `d` string or a whole `<svg>`
 * works. Importing markup keeps one shape per element -- the previous version
 * concatenated everything into a single `d`, so pressing Apply silently fused
 * every shape into one.
 */
function applySource(): void {
  try {
    const r = importSvg(src.value);
    /* "Nothing to import" has to mean nothing *drawable*, not zero elements.
       `M 0 0` and `M 0 0 Q Q Q` both parse without complaint to a shape holding
       no segment, and applying one over a selected shape emptied it, reported
       "Updated Star.", and left a `<path d="">` on the canvas. Text that draws
       nothing cannot have been what anybody meant to replace a drawing with. */
    const draws = r.shapes.some((sh) => sh.subpaths.some((sp) => sp.nodes.length >= 2));
    if (!draws) {
      status.textContent = 'That draws nothing, so nothing was changed.';
      status.className = 'st err';
      return;
    }

    // Editing one shape's path data writes back to that shape only, leaving
    // the rest of the document alone.
    const target = store.state.sourceMode === 'd' ? scopedShape() : null;
    if (target && r.shapes.length === 1) {
      const id = target.id;
      store.edit((s) => {
        const sh = s.doc.shapes.find((x) => x.id === id);
        if (sh) sh.subpaths = r.shapes[0].subpaths;
        s.selection.nodes.clear();
      });
      status.textContent = `Updated ${target.name}.`;
      status.className = 'st ok';
      return;
    }

    store.edit((s) => {
      s.doc.shapes = r.shapes;
      if (r.viewBox) s.doc.viewBox = r.viewBox;
      s.selection.nodes.clear();
      s.selection.shapes.clear();
      s.sourceError = null;
    });
    const n = r.shapes.length;
    status.textContent =
      `Imported ${n} shape${n === 1 ? '' : 's'}.` +
      (r.warnings.length ? `. ${r.warnings.join('; ')}` : '.');
    status.className = r.warnings.length ? 'st err' : 'st ok';
    fit();
  } catch (err) {
    const msg = err instanceof PathSyntaxError ? `${err.message} (at ${err.offset})` : (err as Error).message;
    status.textContent = msg;
    status.className = 'st err';
  }
}

on('#apply', applySource);

/**
 * Put the document's own text back in the box.
 *
 * A failed Apply used to leave the box holding text that parses to nothing and
 * no way back to what the document actually says: the box only rewrites itself
 * when the document changes, and a failed Apply changes nothing.
 *
 * A button rather than doing it automatically on failure. The error names an
 * offset into the text -- "unexpected 'q' (at 42)" -- so throwing that text
 * away is throwing away both the typing and the thing the message points at.
 * Whether the typo is worth keeping is the typist's call, not this function's.
 */
on('#revertSrc', () => {
  refreshSource();
  status.textContent = "Put back what the document says. Nothing was applied.";
  status.className = 'st ok';
});
src.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') applySource();
});

on('#copy', () => {
  void navigator.clipboard.writeText(currentSource()).then(
    () => {
      status.textContent = 'Copied.';
      status.className = 'st ok';
    },
    () => {
      status.textContent = 'Clipboard blocked by the browser.';
      status.className = 'st err';
    },
  );
});

on('#download', () => {
  const s = store.state;
  const text = exportSvg(s.doc, { decimals: s.decimals, minify: s.minify });
  const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'path.svg';
  a.click();
  URL.revokeObjectURL(url);
});

/* -------------------------------------------------------------- backdrop */

/**
 * Load a raster to trace over.
 *
 * The image is held as an object URL rather than a data URL: it stays out of
 * every string the editor serialises, and the browser holds the bytes once
 * however many history entries point at them. Nothing here revokes anything --
 * the store does that, when the last snapshot mentioning an image is gone. A
 * backdrop survives Apply, and does not survive a reload.
 */
const backFile = $('#backFile') as HTMLInputElement;
const backLock = $('#backLock') as HTMLInputElement;

function fitBackdrop(b: { naturalW: number; naturalH: number }): { x: number; y: number; w: number; h: number } {
  const vb = store.state.doc.viewBox;
  // Contain rather than cover: a reference you cannot see the edges of is hard
  // to line up against.
  const k = Math.min(vb.w / b.naturalW, vb.h / b.naturalH);
  const w = b.naturalW * k;
  const h = b.naturalH * k;
  return { x: vb.x + (vb.w - w) / 2, y: vb.y + (vb.h - h) / 2, w, h };
}

function loadBackdrop(file: File): void {
  const src = URL.createObjectURL(file);
  const probe = new Image();
  probe.onload = () => {
    // Loading is an edit, so Ctrl+Z takes the image back off and Ctrl+Shift+Z
    // brings it back. Opacity and the two switches carry over from whatever was
    // there before, since they say how you want to look at a reference rather
    // than which one you loaded.
    const was = store.state.backdrop;
    store.edit((s) => {
      const natural = { naturalW: probe.naturalWidth, naturalH: probe.naturalHeight };
      s.backdrop = {
        src,
        name: file.name,
        ...natural,
        ...fitBackdrop(natural),
        opacity: was?.opacity ?? 0.5,
        visible: true,
        locked: was?.locked ?? true,
      };
    });
    status.textContent = `Tracing over ${file.name}. It is not part of the drawing.`;
    status.className = 'st ok';
  };
  probe.onerror = () => {
    URL.revokeObjectURL(src);
    status.textContent = 'That file could not be read as an image.';
    status.className = 'st err';
  };
  probe.src = src;
}

/**
 * Hand a trace to a worker, or say there is no worker to hand it to.
 *
 * Returns `null` rather than throwing when one cannot be constructed, which is
 * the caller's signal to run the tracer here instead: a page served under a
 * `worker-src` policy that forbids `blob:` can still trace, slowly, rather than
 * losing the feature to a security header it never set.
 *
 * The raster is **copied**, not transferred. Transferring would save a 3 MB
 * clone on a 900 by 900 image, worth about two milliseconds against three
 * thousand, and it would detach the only copy of the pixels -- so a worker that
 * died after the post would take the fallback's input with it.
 */
function traceOffThread(req: TraceRequest): Promise<TraceResult> | null {
  let worker: Worker;
  try {
    worker = new TraceWorker();
  } catch {
    return null;
  }
  return new Promise<TraceResult>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<TraceReply>): void => {
      worker.terminate();
      if (e.data.ok) resolve(e.data.result);
      else reject(new Error(e.data.error));
    };
    worker.onerror = (): void => {
      worker.terminate();
      reject(new Error('the tracer stopped'));
    };
    worker.postMessage(req);
  });
}

/**
 * Trace the loaded backdrop.
 *
 * The image is re-decoded from its object URL rather than read off the
 * `<image>` on the canvas: that element is scaled to the backdrop's placement,
 * and tracing wants the pixels, which are the information, at their natural
 * size. `decode()` rather than `onload` so a failure is a rejected promise
 * instead of a callback nobody is holding.
 */
async function traceBackdrop(): Promise<void> {
  const b = store.state.backdrop;
  if (!b || tracing) {
    status.textContent = 'Load an image in the Backdrop panel first.';
    status.className = 'st err';
    return;
  }
  const num = (sel: string, fallback: number): number => {
    const v = Number(($(sel) as HTMLInputElement).value);
    return Number.isFinite(v) ? v : fallback;
  };

  /* A flag rather than writing `disabled` here, because the store subscriber
     writes it too -- it sets `disabled = !backdrop` on every notification. With
     both owners, any unrelated update during the await re-enabled the button,
     and a second click ran a second trace: two identical piles of shapes, one
     of which one undo could not reach. The subscriber now reads this flag, so
     there is one writer and no way for the two to disagree. */
  tracing = true;
  refreshTraceButton();
  /* Two frames before the work starts, so the status line and the disabled
     button are painted before anything long begins. The walk itself is off the
     thread now, but decoding and `getImageData` are not, and the fallback below
     is the old synchronous path in full. Two frames cost 32 ms against seconds.
  */
  status.textContent = `Tracing ${b.name}…`;
  status.className = 'st ok';
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  try {
    const img = new Image();
    img.src = b.src;
    await img.decode();
    /* The document may have moved on across the awaits: the backdrop can be
       removed, or a drag can be under way, and committing into either would put
       the trace inside somebody else's undo entry. Re-read rather than trust
       the `b` captured above. */
    const live = store.state.backdrop;
    if (!live || live.src !== b.src) {
      status.textContent = 'The backdrop changed while tracing. Nothing was added.';
      status.className = 'st err';
      return;
    }
    if (controller.busy) {
      status.textContent = 'Finish the drag first, then trace.';
      status.className = 'st err';
      return;
    }
    const raster = rasterFrom(img, live.naturalW, live.naturalH);
    const place: Placement = { x: live.x, y: live.y, w: live.w, h: live.h };
    const opts: TraceOptions = {
      colours: num('#traceColours', DEFAULT_TRACE.colours),
      tolerance: num('#traceTol', DEFAULT_TRACE.tolerance),
      minPoints: num('#traceNoise', DEFAULT_TRACE.minPoints),
    };

    const job = traceOffThread({ raster, place, opts });
    if (!job) {
      // No worker to be had. The old behaviour, freeze and all, which is still
      // better than refusing to trace.
      controller.traceBackdrop(raster, opts);
      return;
    }
    let result: TraceResult;
    try {
      result = await job;
    } catch {
      status.textContent = 'That image could not be traced.';
      status.className = 'st err';
      return;
    }
    controller.applyTrace(result, place);
  } catch {
    status.textContent = 'That image could not be read for tracing.';
    status.className = 'st err';
  } finally {
    tracing = false;
    refreshTraceButton();
  }
}

/** True while a trace is in flight. Read by the subscriber, written only here. */
let tracing = false;
const refreshTraceButton = (): void => {
  ($('#traceGo') as HTMLButtonElement).disabled = !store.state.backdrop || tracing;
};

on('#traceGo', () => void traceBackdrop());

on('#backPick', () => backFile.click());
backFile.addEventListener('change', () => {
  const f = backFile.files?.[0];
  if (f) loadBackdrop(f);
  // Cleared so choosing the same file twice fires `change` again.
  backFile.value = '';
});

// Dropping onto the canvas is the gesture people try first.
canvasRoot.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
});
canvasRoot.addEventListener('drop', (e) => {
  const f = e.dataTransfer?.files?.[0];
  if (!f) return;
  e.preventDefault();
  if (f.type.startsWith('image/')) loadBackdrop(f);
  else {
    status.textContent = 'Only image files can be used as a backdrop.';
    status.className = 'st err';
  }
});

/**
 * The same, for the backdrop, which may not be loaded.
 *
 * `history` draws the line between what the reference is and how you are
 * looking at it. Where it sits and how big it is are edits, and belong on the
 * undo stack next to everything else. Opacity is a view setting, like the grid.
 */
const backNum = (id: string, apply: (b: Backdrop, v: number) => boolean, history = true): void =>
  liveNum(id, (s, v) => (s.backdrop ? apply(s.backdrop, v) : false), history);
backNum(
  '#backOpacity',
  (b, v) => {
    b.opacity = Math.min(1, Math.max(0, v / 100));
    return true;
  },
  false,
);
backNum('#backX', (b, v) => {
  if (b.x === v) return false;
  b.x = v;
  return true;
});
backNum('#backY', (b, v) => {
  if (b.y === v) return false;
  b.y = v;
  return true;
});
// Width drives height, so the image cannot be squashed by accident.
backNum('#backScale', (b, v) => {
  if (v <= 0 || b.w === v) return false;
  b.h = (v * b.naturalH) / b.naturalW;
  b.w = v;
  return true;
});

backLock.addEventListener('change', (e) => {
  const locked = (e.target as HTMLInputElement).checked;
  store.update((s) => {
    if (s.backdrop) s.backdrop.locked = locked;
  });
  status.textContent = locked
    ? 'Backdrop locked. Dragging the canvas selects again.'
    : 'Backdrop unlocked. Drag the canvas to move it.';
  status.className = 'st ok';
});

$('#backShow').addEventListener('change', (e) => {
  const on = (e.target as HTMLInputElement).checked;
  store.update((s) => {
    if (s.backdrop) s.backdrop.visible = on;
  });
});

on('#backFit', () => {
  store.tryEdit((s) => {
    if (!s.backdrop) return false;
    const box = fitBackdrop(s.backdrop);
    const b = s.backdrop;
    if (b.x === box.x && b.y === box.y && b.w === box.w && b.h === box.h) return false;
    Object.assign(b, box);
    return true;
  });
});

on('#backClear', () => {
  // The image is not revoked here. It is still on the undo stack, and taking
  // this back has to bring the picture with it rather than a broken link.
  const had = store.state.backdrop !== null;
  store.tryEdit((s) => {
    if (!s.backdrop) return false;
    s.backdrop = null;
    return true;
  });
  if (!had) return;
  status.textContent = 'Backdrop removed. Undo brings it back.';
  status.className = 'st ok';
});

/* ------------------------------------------------------------ shape list */

const shapeList = $('#shapelist');
const shapeCount = $('#shapecount');

shapeList.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  // The rename input lives inside the row, so `closest('li')` matched it and
  // clicking to move the caret changed the selection underneath the edit.
  if (target.closest('.rename')) return;

  const li = target.closest('li');
  const id = li?.getAttribute('data-id');
  if (!id) return;
  store.update((s) => {
    if (!(e as MouseEvent).shiftKey) {
      /* A plain click selects; only Shift toggles. Toggling on a plain click
         meant the second click of a double-click deselected the shape, so you
         finished renaming with nothing selected and the Combine, Transform and
         Delete panels had quietly gone back to empty. */
      s.selection.shapes.clear();
      s.selection.nodes.clear();
      s.selection.shapes.add(id);
      return;
    }
    if (s.selection.shapes.has(id)) s.selection.shapes.delete(id);
    else s.selection.shapes.add(id);
  });
});

on('#delShape', () => {
  const ids = new Set(store.state.selection.shapes);
  if (!ids.size) return;
  store.edit((s) => {
    s.doc.shapes = s.doc.shapes.filter((sh) => !ids.has(sh.id));
    s.selection.shapes.clear();
    s.selection.nodes.clear();
  });
});

on('#dupShape', () => {
  const ids = new Set(store.state.selection.shapes);
  if (!ids.size) return;
  store.edit((s) => {
    const copies = s.doc.shapes.filter((sh) => ids.has(sh.id)).map((sh) => {
      const c = cloneShape(sh);
      c.id = nextId();
      c.name = `${sh.name} copy`;
      return c;
    });
    // Offset so the duplicate is visible rather than exactly underneath.
    const step = s.gridStep || 1;
    for (const c of copies) transformShape(c, translate(step * 2, step * 2));
    s.doc.shapes.push(...copies);
    s.selection.shapes = new Set(copies.map((c) => c.id));
    s.selection.nodes.clear();
  });
});

/* --------------------------------------------------------------- combine */

const boolInfo = $('#boolinfo');
const boolBtns = [...document.querySelectorAll<HTMLButtonElement>('[data-bool]')];

for (const b of boolBtns) {
  b.addEventListener('click', () => {
    const r = controller.booleanSelection(b.getAttribute('data-bool') as BooleanOp);
    status.textContent = r.message;
    status.className = r.ok ? 'st ok' : 'st err';
  });
}

const makeOneBtn = $('#makeone') as HTMLButtonElement;
makeOneBtn.addEventListener('click', () => {
  const r = controller.makeOneShape();
  status.textContent = r.message;
  status.className = r.ok ? 'st ok' : 'st err';
});

const splitBtn = $('#splitshape') as HTMLButtonElement;
splitBtn.addEventListener('click', () => {
  const r = controller.splitShapes();
  status.textContent = r.message;
  status.className = r.ok ? 'st ok' : 'st err';
});

function refreshCombine(): void {
  const n = store.state.selection.shapes.size;
  for (const b of boolBtns) b.disabled = n < 2;
  // Same requirement as the booleans, so the same disabled state.
  makeOneBtn.disabled = n < 2;
  /* A different requirement, so a different state. Split needs one shape that
     holds more than one path, which one selected shape can satisfy and four
     selected shapes can fail. Tying it to the count would offer it where it
     does nothing and withhold it where it works. */
  splitBtn.disabled = !controller.canSplitShapes();
  boolInfo.textContent = n < 2 ? 'needs 2+' : `${n} shapes`;
}

/**
 * Which shape's name is being edited, if any.
 *
 * The list is rebuilt from scratch on every notification, which would destroy
 * an open input mid-keystroke -- so while a rename is in flight the rebuild is
 * skipped entirely, the same guard the source box and the coordinate fields use.
 */
let renaming: string | null = null;

function startRename(id: string): void {
  const shape = store.state.doc.shapes.find((sh) => sh.id === id);
  // Deliberately NOT the element the event carried: the two clicks that make up
  // a double-click each select the shape, each notifies, and the list is rebuilt
  // from scratch every time -- so by now that element is detached, and editing
  // it would put the input somewhere no longer in the document.
  const nm = shapeList.querySelector(`li[data-id="${id}"] .nm`);
  if (!shape || !nm) return;

  renaming = id;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rename';
  input.value = shape.name;
  input.setAttribute('aria-label', 'Shape name');
  nm.replaceWith(input);
  input.focus();
  input.select();

  let settled = false;
  const finish = (commit: boolean): void => {
    if (settled) return;
    settled = true;
    const name = input.value.trim();
    renaming = null;
    if (commit && name && name !== shape.name) {
      store.edit((st) => {
        const sh = st.doc.shapes.find((x) => x.id === id);
        if (sh) sh.name = name;
      });
      // The name is what the exported `id` carries, and an id is an XML Name --
      // so say when the export will not read back exactly as typed.
      const safe = xmlId(name);
      status.textContent =
        safe === name ? `Renamed to ${name}.` : `Renamed to ${name}. Exports as id="${safe}".`;
      status.className = 'st ok';
    } else {
      listSig = null; // the row was replaced by an input; force it back
      refreshShapeList();
    }
  };

  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // V and P are tool shortcuts; not while typing a name
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

shapeList.addEventListener('dblclick', (e) => {
  const id = (e.target as HTMLElement).closest('li')?.getAttribute('data-id');
  if (id && !renaming) startRename(id);
});

/* A keyboard route into the list, which had none at all: rows are not focusable
   and double-click was the only way to rename. Arrows move the selection, F2 and
   Enter rename the way they do in every file manager. */
shapeList.addEventListener('keydown', (e) => {
  if (renaming) return;
  const shapes = store.state.doc.shapes;
  if (!shapes.length) return;

  const selected = [...store.state.selection.shapes];
  const at = shapes.findIndex((sh) => sh.id === selected[selected.length - 1]);

  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const step = e.key === 'ArrowDown' ? 1 : -1;
    const next = Math.max(0, Math.min(shapes.length - 1, (at < 0 ? (step > 0 ? -1 : 0) : at) + step));
    store.update((st) => {
      if (!e.shiftKey) {
        st.selection.shapes.clear();
        st.selection.nodes.clear();
      }
      st.selection.shapes.add(shapes[next].id);
    });
    return;
  }
  if ((e.key === 'F2' || e.key === 'Enter') && at >= 0) {
    e.preventDefault();
    startRename(shapes[at].id);
  }
});

/**
 * What the list would draw, ignoring which rows are selected.
 *
 * Selection changes on every click and geometry changes on every frame of a
 * drag, but neither alters the rows themselves. Rebuilding anyway churned the
 * DOM constantly and broke double-click outright: the first click of the pair
 * replaced the row the second was about to land on, so the `dblclick` never
 * reached a live element and renaming could not start.
 */
const listSignature = (): string =>
  store.state.doc.shapes
    .map((sh) =>
      [sh.id, sh.name, sh.subpaths.reduce((a, sp) => a + sp.nodes.length, 0), swatchOf(sh)].join('\u0001'),
    )
    .join('\u0002');

const swatchOf = (sh: Shape): string => (sh.style.fill !== 'none' ? sh.style.fill : sh.style.stroke);

let listSig: string | null = null;

function refreshShapeList(): void {
  if (renaming) return;
  const s = store.state;
  shapeCount.textContent = String(s.doc.shapes.length);

  const sig = listSignature();
  if (sig === listSig) {
    for (const li of shapeList.querySelectorAll('li[data-id]')) {
      li.setAttribute('aria-selected', String(s.selection.shapes.has(li.getAttribute('data-id')!)));
    }
    return;
  }
  listSig = sig;
  shapeList.replaceChildren();

  if (s.doc.shapes.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.setAttribute('role', 'presentation');
    li.textContent = 'no shapes';
    shapeList.append(li);
    return;
  }

  for (const sh of s.doc.shapes) {
    const li = document.createElement('li');
    li.setAttribute('data-id', sh.id);
    /* `aria-selected` is ignored on a plain list item, so the visual state and
       the announced state disagreed. A listbox of options is the role that
       actually carries it. */
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(s.selection.shapes.has(sh.id)));

    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = swatchOf(sh);

    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = sh.name;

    const ct = document.createElement('span');
    ct.className = 'ct';
    ct.textContent = String(sh.subpaths.reduce((a, sp) => a + sp.nodes.length, 0));

    li.append(sw, nm, ct);
    shapeList.append(li);
  }
}

/* ------------------------------------------------------------ live readout */

const stats = $('#stats');
const selinfo = $('#selinfo');
const gridval = $('#gridval');
const gridreadout = $('#gridreadout');
const drawinfo = $('#drawinfo');
const zoomnum = $('#zoomnum');
const backinfo = $('#backinfo');
const outval = $('#outval');
const cursorEl = $('#cursor');
const snapKindEl = $('#snapkind');
const measureEl = $('#measure');
const measureLabel = $('#measure i');
const measureVal = $('#measure span');
const undoBtn = $('#undo') as HTMLButtonElement;
const redoBtn = $('#redo') as HTMLButtonElement;

/**
 * The document readout, and whether the overlay is drawing markers.
 *
 * Written from two places, which is why it is a function. The document half
 * changes when the document does; the marker half is only true after a render,
 * so `controller.onRender` writes it again with an answer that has happened.
 */
function refreshStats(): void {
  const s = store.state;
  const vb = s.doc.viewBox;
  const round = (v: number): string => (+v.toFixed(3)).toString();
  // The canvas size leads, because it is the one number about the document that
  // was invisible and that decides what the exported file looks like. The
  // marker note goes last: the overlay stops drawing node markers above a
  // density where they are neither aimable nor affordable, and a person whose
  // nodes vanished with no explanation would reasonably think the document had
  // lost them. Here rather than in the status line, which is for the last thing
  // that happened and is overwritten by the next.
  stats.textContent =
    `${round(vb.w)} × ${round(vb.h)} · ${s.doc.shapes.length} shape${s.doc.shapes.length === 1 ? '' : 's'}` +
    ` · ${controller.countNodes()} nodes · ${controller.countSegments()} segments` +
    (canvas.markersCapped ? ' · markers off, too dense' : '');
}
controller.onRender = refreshStats;

store.subscribe((s) => {
  for (const b of toolSeg.querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.getAttribute('data-v') === s.tool));
  }
  for (const b of delModeSeg.querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.getAttribute('data-dm') === s.deleteMode));
  }
  $('#delmodeinfo').textContent = s.deleteMode === 'split' ? 'leaves two ends' : 'keeps it whole';
  undoBtn.disabled = !store.canUndo;
  redoBtn.disabled = !store.canRedo;

  refreshStats();

  const selCount = s.selection.nodes.size;
  selinfo.textContent = s.selection.shapes.size
    ? `${s.selection.shapes.size} shape${s.selection.shapes.size === 1 ? '' : 's'}`
    : selCount
      ? `${selCount} node${selCount === 1 ? '' : 's'}`
      : 'all';

  refreshInspector();
  refreshBend();

  // Every line on screen is a snap position, but when zoomed out not every snap
  // position gets a line. Saying which is drawn keeps that asymmetry visible
  // rather than leaving the user to wonder why the grid coarsened.
  const g = gridDisplayFor(s.gridStep, s.camera, canvas.widthPx);
  gridval.textContent = !s.gridStep
    ? 'off'
    : g && g.multiple > 1
      ? `${s.gridStep} · every ${g.multiple} drawn`
      : `${s.gridStep}`;
  /* `drawn only` claimed the grid was on screen when Show grid was off, which
     was one readout describing two settings and getting both wrong. */
  gridreadout.textContent = !s.gridStep
    ? 'off'
    : s.snapToGrid && s.showGrid
      ? 'snapping'
      : s.snapToGrid
        ? 'snapping, hidden'
        : s.showGrid
          ? 'drawn only'
          : 'off, step kept';
  /* Pixel fit shifts the lattice, so the readout has to say which one is in
     force -- a grid that says "1" while sitting on half-integers is the same
     lie §9 was written to stop. `mixed widths` is a real answer: two shapes half
     a unit apart in phase have no lattice that serves both, so the plain grid
     stands and the readout says why. */
  const pnote = $('#pixelnote') as HTMLElement;
  const pfit = $('#fitPixels') as HTMLButtonElement;
  pnote.hidden = !s.pixelFit;
  pfit.hidden = !s.pixelFit;
  /* Disabled on a mixed-width selection too. The phase is already computed two
     lines below for the readout, and offering a button whose only possible
     answer is "no one lattice fits them all" is the Class 9 pattern again. */
  pfit.disabled =
    (s.selection.shapes.size === 0 && s.selection.nodes.size === 0) ||
    phaseInForce(s.doc, s.selection, s.style) === null;
  if (s.pixelFit && s.gridStep) {
    gridreadout.textContent += ` · ${phaseLabel(phaseInForce(s.doc, s.selection, s.style))}`;
  }
  // Declared in the markup and never written to until now, so the Draw group
  // was the one panel whose header value was permanently blank.
  /* The style panel shows the first selected shape, or what the next new shape
     will get. The header says which, since "red" means two different things
     depending on whether anything is selected. */
  const styled = selectedShapes(s.doc, s.selection);
  const shown = styleShown();
  const odd = [shown.fill, shown.stroke].filter((c) => c !== 'none' && asHex(c) === null);
  $('#styleinfo').textContent = !styled.length
    ? 'for new shapes'
    : odd.length
      ? odd.join(' ')
      : styled.length > 1
        ? `${styled.length} shapes, first shown`
        : '';

  fillNone.checked = shown.fill === 'none';
  strokeNone.checked = shown.stroke === 'none';
  /* The pickers stay live while `none` is ticked. Disabling them was the first
     version and it made giving an unfilled shape a fill a two-step dance:
     untick, which commits some arbitrary colour, then pick the one you wanted.
     Reaching for the colour is the whole gesture, so it clears `none` itself. */
  // Only ever written with something the picker can hold. A named colour or a
  // gradient reference would round to black, and reading that back on the next
  // interaction would quietly change the drawing.
  const fillHex = asHex(shown.fill);
  const strokeHex = asHex(shown.stroke);
  if (fillHex) fillColour.value = fillHex;
  if (strokeHex) strokeColour.value = strokeHex;
  if (document.activeElement !== strokeWidthInput) {
    strokeWidthInput.value = String(shown.strokeWidth);
  }
  for (const b of $('#fillRule').querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.getAttribute('data-fr') === shown.fillRule));
  }

  drawinfo.textContent = s.cornerRadius > 0 ? `r ${s.cornerRadius}` : 'square corners';
  if (!tolChosen) simplifyTol.value = String(defaultTol(s.doc.viewBox));
  /* Here rather than only on `input`, because the line above sets the value
     programmatically and that fires no event. Without this the box started
     disabled and stayed disabled until somebody typed in Within, which is the
     one thing a person who wanted the box would not think to do. */
  paintRedraw();

  const canvasBox = s.doc.viewBox;
  for (const [id, v] of [
    ['#vbx', canvasBox.x],
    ['#vby', canvasBox.y],
    ['#vbw', canvasBox.w],
    ['#vbh', canvasBox.h],
  ] as [string, number][]) {
    const el = $(id) as HTMLInputElement;
    if (document.activeElement !== el) el.value = String(Math.round(v * 1000) / 1000);
  }
  /* Said here rather than in the status strip, because this is where the button
     that fixes it lives. Content outside the canvas is allowed and is sometimes
     what you want mid-edit; it is only a surprise at export time, which is
     exactly when nobody is looking at the drawing. */
  const drawn = docBBox(s.doc);
  const spills =
    drawn !== null &&
    (drawn.x0 < canvasBox.x - 1e-9 ||
      drawn.y0 < canvasBox.y - 1e-9 ||
      drawn.x1 > canvasBox.x + canvasBox.w + 1e-9 ||
      drawn.y1 > canvasBox.y + canvasBox.h + 1e-9);
  const canvasInfo = $('#canvasinfo');
  canvasInfo.textContent = spills ? 'drawing goes outside' : '';
  canvasInfo.className = spills ? 'gval warn' : 'gval';

  const b = s.backdrop;
  backinfo.textContent = !b ? 'none' : b.visible ? (b.locked ? b.name : `${b.name} · unlocked`) : 'hidden';
  for (const id of ['#backOpacity', '#backX', '#backY', '#backScale', '#backFit', '#backClear', '#backShow', '#backLock', '#traceColours', '#traceTol', '#traceNoise']) {
    ($(id) as HTMLInputElement).disabled = !b;
  }
  // One writer, so a trace in flight and a backdrop being removed cannot leave
  // the button enabled by racing each other.
  refreshTraceButton();
  /* The size traced is the image's own, not the size it has been scaled to on
     screen: the pixels are the information and the placement is not, so a
     reference shrunk to line something up still traces at full detail. */
  $('#traceinfo').textContent = b ? `${b.naturalW} × ${b.naturalH} px` : 'no image';
  if (b) {
    // Never clobber a field the pointer is in the middle of editing.
    const set = (id: string, v: number): void => {
      const el = $(id) as HTMLInputElement;
      if (document.activeElement !== el) el.value = String(Math.round(v * 100) / 100);
    };
    set('#backOpacity', b.opacity * 100);
    set('#backX', b.x);
    set('#backY', b.y);
    set('#backScale', b.w);
    (($('#backShow') as HTMLInputElement)).checked = b.visible;
    backLock.checked = b.locked;
  }

  /* The strip said where the pointer was and never how big the view is, so
     there was no way to tell 1:1 from 10:1. `scale` is document units per
     pixel, so its reciprocal is the magnification. */
  const k = canvas.scale(s.camera);
  const pct = 100 / k;
  zoomnum.textContent = pct >= 1000 ? `${Math.round(pct / 100) * 100}%` : pct >= 100 ? `${Math.round(pct)}%` : `${pct.toFixed(pct < 10 ? 1 : 0)}%`;
  app.classList.toggle('tool-hand', s.tool === 'hand');
  outval.textContent = `${s.decimals} dp${s.minify ? ' · min' : ''}`;

  refreshShapeList();
  refreshCombine();
  const scoped = s.sourceMode === 'd' ? scopedShape() : null;
  srcHint.textContent =
    s.sourceMode === 'svg'
      ? 'Apply replaces the whole document.'
      : scoped
        ? `Apply updates ${scoped.name} only.`
        : s.doc.shapes.length > 1
          ? `Apply would merge all ${s.doc.shapes.length} shapes. Select one first, or switch to SVG.`
          : 'Apply replaces the document.';
  for (const b of srcModeSeg.querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.getAttribute('data-v') === s.sourceMode));
  }

  // Do not clobber the box while it is being typed into.
  if (document.activeElement !== src) refreshSource();
});

/**
 * Rewrite the source box, if anybody could be looking at it.
 *
 * This is a full serialisation of the document -- a third one per notification,
 * after the artwork and the overlay -- and it ran whether or not the drawer was
 * open. On a traced document that is 56 ms of work on every pointermove to
 * update a textarea of `height: 0`. The drawer is closed on load and stays
 * closed for most of a session, so the common case was paying the most.
 *
 * Deferred rather than dropped: `setPanel` calls this when the drawer opens, so
 * it catches up on everything skipped before anybody can see it.
 */
function refreshSource(): void {
  if (!isOpen('src')) return;
  const text = currentSource();
  if (src.value !== text) src.value = text;
  srcinfo.textContent = `${text.length} chars`;
}

/* The pointer's position in document coordinates, which is the one number a
   grid editor should never make you guess. Written straight to the strip rather
   than through the store: it changes on every mouse move and has nothing to do
   with the document. */
canvas.overlay.addEventListener('pointermove', (e) => {
  const p = screenToDoc(canvas.overlay, e.clientX, e.clientY);
  const dp = Math.min(3, store.state.decimals);
  /* A node or an outline within reach is shown at ITS coordinates, with what
     claimed it, because that is where a point put down here would go and it is
     worth knowing before you commit to the click. The grid is not shown that
     way: with a step of 1 the readout would lock to integers and stop being a
     pointer position at all, for a lattice that is already drawn on screen. */
  /* Not during a drag. `snapPreview` deliberately passes no exclusions, which
     is right for a hover -- a point that does not exist yet may land on any
     node -- and wrong the moment something is being dragged, because the node
     under the pointer is the one the drag itself excludes. It read `on a node`
     for the whole of every node drag, naming that node's own coordinates. */
  const snap = controller.busy ? null : controller.snapPreview(p);
  const claimed = snap && (snap.kind === 'vertex' || snap.kind === 'boundary');
  const at = claimed ? snap.pt : p;
  const label = claimed ? snapLabel(snap.kind) : null;
  cursorEl.textContent = `${at[0].toFixed(dp)}, ${at[1].toFixed(dp)}`;
  // Its own element, to the left of the coordinates rather than appended to
  // them. Appended, the name of a tier coming into reach lengthened the string
  // and shoved the digits sideways mid-gesture.
  snapKindEl.textContent = label ?? '';
  showMeasure();
});
canvas.overlay.addEventListener('pointerleave', () => {
  cursorEl.textContent = '';
  snapKindEl.textContent = '';
});

/* How far the live drag has come, and which way.
   Hidden whenever nothing is being dragged, rather than showing a stale number
   or a row of zeroes: an empty slot says "not measuring" and 0 says "measured
   zero", and those are different claims. */
function showMeasure(): void {
  const m = controller.measure();
  if (!m) {
    measureEl.hidden = true;
    return;
  }
  const dp = Math.min(3, store.state.decimals);
  if (m.kind === 'box') {
    measureLabel.textContent = 'size';
    measureVal.textContent = `${m.w.toFixed(dp)} × ${m.h.toFixed(dp)}`;
  } else {
    // The angle keeps one decimal whatever the document's setting. It is
    // degrees, not document units, and the two have no reason to agree.
    measureLabel.textContent = 'drag';
    measureVal.textContent = `${m.len.toFixed(dp)} at ${+m.deg.toFixed(1)}°`;
  }
  measureEl.hidden = false;
}

/* The last move of a drag arrives before the release, so without this the
   readout would keep the final number on screen until the pointer moved
   again. Window rather than overlay: a release outside the canvas still ends
   the drag, and `onStrayUp` in the controller exists for the same reason. */
window.addEventListener('pointerup', showMeasure);
window.addEventListener('pointercancel', showMeasure);

/* -------------------------------------------------------------------- boot */

installTooltips();

requestAnimationFrame(() => {
  store.update((s) => {
    s.camera = fitAspect(s.camera, canvas.overlay);
  });
  fit();
});
