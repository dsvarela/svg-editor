/**
 * Wiring: document -> store -> canvas -> controller, plus the panels.
 */

import './ui/styles.css';
import { PathSyntaxError } from './core/parse';
import { drawsSomething, exportPathData, exportSvg, importSvg, xmlId } from './io/svg';
import type { BooleanOp } from './io/boolean';
import {
  docBBox,
  emptyDoc,
  findShape,
  selectedRefs,
  selectedShapes,
  shapeFromPath,
} from './model/doc';
/* Aliased: the DOM's own `Selection` is a global type, and an unaliased import
   here shadows it in a file that also uses `getSelection`. */
import type { Selection as Sel } from './model/doc';
import { isPathEnd, latentHandle } from './model/ops';
import { continuityOf } from './core/types';
import type { Shape, Style, Subpath, ViewBox } from './core/types';
import { serialisePath } from './core/serialise';
import type { Mark } from './core/serialise';
import { phaseInForce, phaseLabel } from './model/pixelfit';
import { keylinesFor } from './model/keylines';
import { Rulers } from './view/rulers';
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
import { Commands } from './tools/commands';
import { bindKeys } from './tools/keys';
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
/* The stage, not the canvas: the rulers take two tracks of the canvas grid, so
   the SVGs live in the cell that is left. With rulers off both tracks are zero
   wide and the stage is the whole canvas again. */
const canvasRoot = $('#stage');
const canvas = new Canvas(canvasRoot);
const controller = new Controller(store, canvas);
const commands = new Commands(store, () => controller.busy);
bindKeys(store, controller, commands);
const rulers = new Rulers($('#rulerH') as unknown as SVGSVGElement, $('#rulerV') as unknown as SVGSVGElement);
controller.attachRulers(rulers.h, rulers.v);

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

// Notices raised from inside a gesture or a command -- either is reached from
// both a button and a key, so they cannot be reported at the call site. One
// function, given to both, because the status line is one place.
const say = (message: string, ok: boolean): void => {
  const el = $('#status');
  el.textContent = message;
  el.className = ok ? 'st ok' : 'st err';
};
controller.onMessage = say;
commands.onMessage = say;

// Refused mid-gesture for the same reason the keyboard refuses it: the drag is
// standing on a checkpoint, and popping it makes the drag roll back the edit
// before it. A second finger can reach these while the first is still down.
on('#undo', () => !controller.busy && store.undo());
on('#redo', () => !controller.busy && store.redo());
on('#del', () => commands.deleteSelection());
on('#curve', () => commands.setSelectedSegmentsCurved(true));
on('#straight', () => commands.setSelectedSegmentsCurved(false));

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
    if (kind === 'rot90') commands.applyTransform('rotate', 90);
    else if (kind === 'rot-90') commands.applyTransform('rotate', -90);
    else if (kind === 'flipH') commands.applyTransform('flipH');
    else if (kind === 'flipV') commands.applyTransform('flipV');
  });
});

on('#rotate', () => commands.applyTransform('rotate', Number(($('#angle') as HTMLInputElement).value) || 0));
on('#scaleGo', () => {
  const v = Number(($('#scale') as HTMLInputElement).value);
  if (v > 0) commands.applyTransform('scale', v);
});

/* ------------------------------------------------------------- checkboxes */

const bindCheck = (
  id: string,
  key:
    | 'showGrid'
    | 'showKeylines'
    | 'showRulers'
    | 'showGuides'
    | 'guidesLocked'
    | 'smartGuides'
    | 'snapToAngles'
    | 'snapToGrid'
    | 'snapToPoints'
    | 'snapToBoundary'
    | 'snapToIntersections'
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
bindCheck('#showKeylines', 'showKeylines');
bindCheck('#showRulers', 'showRulers');
bindCheck('#showGuides', 'showGuides');
bindCheck('#guidesLocked', 'guidesLocked');
bindCheck('#smartGuides', 'smartGuides');
bindCheck('#snapAngles', 'snapToAngles');

/* Angular snap's three numbers. The step is clamped above zero because a step
   of 0 asks for infinitely many rays; the base is free, since any angle is a
   legitimate place for the first one. */
const angleStep = $('#angleStep') as HTMLInputElement;
angleStep.value = String(store.state.angleStep);
angleStep.addEventListener('input', () =>
  store.update((s) => (s.angleStep = Math.max(0, Number(angleStep.value) || 0))),
);
const angleBase = $('#angleBase') as HTMLInputElement;
angleBase.value = String(store.state.angleBase);
angleBase.addEventListener('input', () =>
  store.update((s) => (s.angleBase = Number(angleBase.value) || 0)),
);
on('#angleFromSel', () => commands.setAngleOrigin());
on('#angleClear', () => commands.clearAngleOrigin());

/* Guides by number, which is the route that does not need a pointer and the
   only one that is exact. The field is one value used by two buttons, because
   "12" means the same thing on both axes and two fields would be two things to
   keep in step. */
const guideAt = $('#guideAt') as HTMLInputElement;
on('#guideAddV', () => commands.addGuideAt('x', Number(guideAt.value)));
on('#guideAddH', () => commands.addGuideAt('y', Number(guideAt.value)));
on('#guideClear', () => commands.clearGuides());
bindCheck('#snapGrid', 'snapToGrid');
bindCheck('#snapPoints', 'snapToPoints');
bindCheck('#snapBoundary', 'snapToBoundary');
bindCheck('#snapCross', 'snapToIntersections');
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

on('#circularise', () => commands.circulariseSelection());

/* Rounding an existing corner, which is what the rectangle tool's radius does
   while drawing and nothing could do afterwards. */
const roundR = $('#roundR') as HTMLInputElement;
on('#roundCorner', () => commands.roundSelection(Number(roundR.value)));

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
 * Reads the field, and leaves the undo batching to `streamed`.
 *
 * `history: false` is for controls that change how something looks rather than
 * what it is. Those never enter the undo stack at all, so they take no batch.
 */
const liveNum = (
  id: string,
  apply: (s: EditorState, v: number) => boolean,
  history = true,
): void => {
  const input = $(id) as HTMLInputElement;
  if (!history) {
    input.addEventListener('input', () => {
      const v = Number(input.value);
      if (Number.isFinite(v)) store.update((s) => apply(s, v));
    });
    return;
  }
  /* Through `streamed` rather than opening its own batch, so these controls
     join `openStreams` and the pointerdown drain covers them. While this held
     a second copy of the same open-and-close, the drain reached three controls
     and these seven kept a batch open into the drag that followed. A value
     that is mid-typing and not yet a number opens a batch that takes no
     checkpoint, which costs nothing: an entry appears only when an edit does. */
  streamed(input, () => {
    const v = Number(input.value);
    if (!Number.isFinite(v)) return;
    store.tryEdit((s) => apply(s, v));
  });
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

/* ------------------------------------------------------------- the palette */

/** Which saved style is highlighted, so Forget knows what to forget. */
let paletteAt = -1;

const paletteEl = $('#palette');

/**
 * Redraw the swatches, and only when their content actually changed.
 *
 * The shape list learned this the hard way and recorded it: rebuilding on every
 * click replaces the element the second click of a double-click was about to
 * land on, so the browser never fires `dblclick` and renaming cannot start.
 *
 * What fixes it here is that clicking a swatch updates the highlight in place
 * rather than rebuilding -- the highlight changes on exactly the click that
 * must not rebuild. The signature check is insurance against the other route:
 * any unrelated state change that reaches the subscriber between the two
 * clicks. Nothing exercises that path today, so nothing tests it.
 */
let paletteSig: string | null = null;

function paintHighlight(): void {
  [...paletteEl.children].forEach((el, i) => el.setAttribute('aria-selected', String(i === paletteAt)));
  ($('#paletteDrop') as HTMLButtonElement).disabled =
    paletteAt < 0 || paletteAt >= store.state.palette.length;
}

function paintPalette(): void {
  const list = store.state.palette;
  const sig = list.map((e) => [e.name, e.style.fill, e.style.stroke, e.style.strokeWidth, e.style.fillRule].join('\u0001')).join('\u0002');
  $('#paletteinfo').textContent = list.length ? `${list.length}` : 'none';
  if (sig === paletteSig) {
    paintHighlight();
    return;
  }
  paletteSig = sig;

  paletteEl.replaceChildren();
  list.forEach((entry, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'option');
    b.title = `Fill ${entry.style.fill}, stroke ${entry.style.stroke} at ${entry.style.strokeWidth}`;
    const sw = document.createElement('span');
    sw.className = 'sw';
    const inner = document.createElement('i');
    /* Fill over stroke, drawn as a fill with a ring: two colours in one small
       square, which is what you pick a saved style by. `none` shows the chequer
       underneath rather than a white square. */
    inner.style.background = entry.style.fill === 'none' ? 'transparent' : entry.style.fill;
    inner.style.boxShadow =
      entry.style.stroke === 'none' ? 'none' : `inset 0 0 0 2px ${entry.style.stroke}`;
    sw.append(inner);
    const label = document.createElement('span');
    label.textContent = entry.name;
    b.append(sw, label);
    b.addEventListener('click', () => {
      paletteAt = i;
      commands.setStyle({ ...entry.style });
      paintHighlight();
    });
    paletteEl.append(b);
  });
  paintHighlight();
}

/* Renaming is delegated to the container rather than bound per button, because
   the first click of a double-click applies the style, which repaints the whole
   row -- so a listener on the button is on a detached element by the time the
   second click lands. Delegation survives the repaint. */
paletteEl.addEventListener('dblclick', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (!b || !paletteEl.contains(b) || b.querySelector('.rename')) return;
  const i = [...paletteEl.children].indexOf(b);
  const entry = store.state.palette[i];
  if (!entry) return;
  e.preventDefault();

  const label = b.querySelector('span:not(.sw)');
  if (!label) return;
  const field = document.createElement('input');
  field.className = 'rename';
  field.value = entry.name;
  field.size = Math.max(6, entry.name.length);
  label.replaceWith(field);
  field.focus();
  field.select();
  field.addEventListener('click', (ev) => ev.stopPropagation());
  field.addEventListener('blur', () => {
    const next = field.value.trim();
    if (next) store.update((st) => (st.palette[i].name = next));
    paintPalette();
  });
  field.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') field.blur();
    else if (ev.key === 'Escape') {
      field.value = entry.name;
      field.blur();
    }
  });
});

on('#paletteSave', () => {
  const shown = styleShown();
  /* Named after what it is, since that is the only thing the editor knows.
     Someone who wants "danger" can double-click the name; someone who wants
     three greys gets three distinguishable defaults rather than three copies
     of the word "Style". */
  const base = `${shown.fill === 'none' ? 'no fill' : shown.fill}, ${shown.stroke === 'none' ? 'no stroke' : shown.stroke}`;
  const same = (a: Style, b: Style): boolean =>
    a.fill === b.fill && a.stroke === b.stroke && a.strokeWidth === b.strokeWidth && a.fillRule === b.fillRule;
  const already = store.state.palette.findIndex((e) => same(e.style, shown));
  if (already >= 0) {
    paletteAt = already;
    paintPalette();
    status.textContent = `Already saved as ${store.state.palette[already].name}.`;
    status.className = 'st err';
    return;
  }
  store.update((st) => st.palette.push({ name: base, style: { ...shown } }));
  paletteAt = store.state.palette.length - 1;
  paintPalette();
  status.textContent = `Saved ${base}.`;
  status.className = 'st ok';
});

on('#paletteDrop', () => {
  const at = paletteAt;
  if (at < 0 || at >= store.state.palette.length) return;
  const gone = store.state.palette[at].name;
  store.update((st) => st.palette.splice(at, 1));
  paletteAt = -1;
  paintPalette();
  status.textContent = `Forgot ${gone}.`;
  status.className = 'st ok';
});

// Dragging inside a colour picker fires `input` per pixel, so both of these go
// through the same batching as every other continuous control.
streamed(fillColour, () => commands.setStyle({ fill: fillColour.value }));
streamed(strokeColour, () => commands.setStyle({ stroke: strokeColour.value }));

/* Unticking `none` has to put a colour back, and the picker is the only place
   one is on offer: the stored value is the string `none`, which carries no hue
   to return to. */
fillNone.addEventListener('change', () =>
  commands.setStyle({ fill: fillNone.checked ? 'none' : fillColour.value }),
);
strokeNone.addEventListener('change', () =>
  commands.setStyle({ stroke: strokeNone.checked ? 'none' : strokeColour.value }),
);

streamed(strokeWidthInput, () => {
  const v = Number(strokeWidthInput.value);
  if (!Number.isFinite(v) || v < 0) return;
  commands.setStyle({ strokeWidth: v });
});

$('#fillRule').addEventListener('click', (e) => {
  const v = (e.target as HTMLElement).closest('button')?.getAttribute('data-fr');
  if (v === 'nonzero' || v === 'evenodd') commands.setStyle({ fillRule: v });
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
on('#vbFit', () => commands.fitCanvasToDrawing());

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

on('#keepGo', () => commands.simplifyToCount(Number(($('#keepCount') as HTMLInputElement).value)));
on('#keepThese', () => commands.keepSelectedNodes());
on('#strokeButt', () => commands.strokeToPath('butt'));
on('#strokeRound', () => commands.strokeToPath('round'));
on('#offsetGo', () => commands.offsetSelection(Number(($('#offsetBy') as HTMLInputElement).value)));
on('#simplify', () => commands.simplifySelection(Number(simplifyTol.value), redrawEl.checked));
on('#reverse', () => commands.reverseSelection());

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
    if (Number.isFinite(v)) commands.setNodeCoord(f.part, f.axis, v);
  });
  f.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') f.input.blur();
  });
}

ntypeSeg.addEventListener('click', (e) => {
  const v = (e.target as HTMLElement).closest('button')?.getAttribute('data-v');
  if (v === 'corner' || v === 'smooth' || v === 'symmetric') commands.setSelectedContinuity(v);
  else if (v === 'auto') commands.setSelectedAuto();
});

on('#breakPath', () => commands.breakAtSelection());
on('#joinPath', () => commands.joinSelection('connect'));
on('#mergePath', () => commands.joinSelection('merge'));
on('#fuseNodes', () => commands.fuseSelection());
on('#fitPixels', () => commands.fitToPixels());
on('#delNode', () => commands.deleteSelection());
on('#findSrc', () => findInSource());
on('#prevNode', () => commands.stepNodeSelection(-1));
on('#nextNode', () => commands.stepNodeSelection(1));
on('#insertNode', () => commands.insertInSelection());

const delModeSeg = $('#delmode');
delModeSeg.addEventListener('click', (e) => {
  const v = (e.target as HTMLElement).closest('button')?.getAttribute('data-dm');
  if (v === 'fuse' || v === 'split') store.update((s) => (s.deleteMode = v));
});

/* The two held keys. `update` rather than `edit`: which keys are held is input
   state, so it belongs in no undo step. */
const modSeg = $('#mods');
modSeg.addEventListener('click', (e) => {
  const v = (e.target as HTMLElement).closest('button')?.getAttribute('data-mod');
  if (v === 'shift') store.update((s) => (s.heldShift = !s.heldShift));
  if (v === 'alt') store.update((s) => (s.heldAlt = !s.heldAlt));
});

document.querySelectorAll<HTMLButtonElement>('[data-al]').forEach((b) =>
  b.addEventListener('click', () => commands.alignSelection(b.getAttribute('data-al') as AlignMode)),
);
document.querySelectorAll<HTMLButtonElement>('[data-di]').forEach((b) =>
  b.addEventListener('click', () => commands.distributeSelection(b.getAttribute('data-di') as 'h' | 'v')),
);

const bendAngle = $('#bendAngle') as HTMLInputElement;
const bendLoose = $('#bendLoose') as HTMLInputElement;
const bendInfo = $('#bendinfo');

const commitBend = (): void => {
  const seg = commands.activeSegment();
  if (!seg) return;
  const a = Number(bendAngle.value);
  const l = Number(bendLoose.value);
  if (!Number.isFinite(a) || !Number.isFinite(l)) return;
  commands.setActiveBend({ angle: a, looseness: Math.max(0.05, l) });
};
for (const inp of [bendAngle, bendLoose]) {
  inp.addEventListener('change', commitBend);
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') inp.blur();
  });
}
on('#bendFlat', () => commands.setActiveBend({ angle: 0, looseness: 1 }));
on('#bendFree', () => commands.freeActiveSegment());

function refreshBend(): void {
  const seg = commands.activeSegment();
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
  const sel = commands.singleSelectedNode();
  const count = commands.selectionCount();

  nodeGroup.classList.toggle('disabled', count === 0);
  nodeInfo.textContent = sel ? `${sel.ref.sp}/${sel.ref.i}` : count ? `${count} selected` : 'none';
  alignInfo.textContent = count >= 2 ? `${count} nodes` : 'needs 2+';

  // These read out what the node's handles currently say, and clicking one
  // moves the handles to match. There is no mode being set, so the highlight
  // can never drift away from what is drawn.
  /* `auto` is the one reading that is not derived, so it is asked of the node
     rather than of its handles -- and it takes precedence in the display,
     because an auto node is always collinear and would otherwise light up as
     `smooth` while a second button was also pressed. */
  const cur = sel ? (sel.node.auto ? 'auto' : continuityOf(sel.node)) : null;
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
  /* Stepping works from a selected shape as well as from a node, since that is
     how you get the first node without a pointer. */
  const canStep = count > 0 || store.state.selection.shapes.size > 0;
  ($('#prevNode') as HTMLButtonElement).disabled = !canStep;
  ($('#nextNode') as HTMLButtonElement).disabled = !canStep;
  ($('#insertNode') as HTMLButtonElement).disabled = count !== 2;
  ($('#findSrc') as HTMLButtonElement).disabled = count === 0;

  /* Copy and Cut are derived from the selection, which every notification
     carries. Paste is deliberately not derived from the clipboard: copying does
     not edit the document and so raises no notification, and a Paste greyed out
     until the next unrelated edit is a button lying about what it would do. It
     stays live and says what is wrong when there is nothing to put back. */
  const anything = count > 0 || store.state.selection.shapes.size > 0;
  ($('#copySel') as HTMLButtonElement).disabled = !anything;
  ($('#cutSel') as HTMLButtonElement).disabled = !anything;
  /* The group is greyed with `pointer-events: none`, which stops the mouse and
     not the keyboard: Tab still landed on these and Space still fired them.
     Every other control in the group was disabled explicitly and the newer ones
     were missed. */
  ($('#roundCorner') as HTMLButtonElement).disabled = count === 0;
  ($('#roundR') as HTMLInputElement).disabled = count === 0;
  for (const b of ntypeSeg.querySelectorAll('button')) b.disabled = !sel;

  // Join is the inverse: exactly two nodes, each a free end of an open path.
  const ends = selectedRefs(store.state.doc, store.state.selection).filter((r) => {
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
  for (const r of selectedRefs(s.doc, s.selection)) ids.add(r.shape);
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
 * Replace the whole document from SVG or path-data text.
 *
 * Split out of `applySource` when the file picker arrived, because the two
 * routes differ only in where the text came from and in what to call it when
 * something is wrong with it. Everything after that -- refusing text that draws
 * nothing, replacing the document, reporting what came in, re-fitting the view
 * -- is one behaviour, and having it in one place is what stops the two drifting
 * apart the first time either is changed.
 *
 * `what` names the source in the message, since "that draws nothing" is a
 * different sentence when it is a file you chose than when it is a box you
 * typed into.
 */
function replaceDocumentFrom(text: string, what: string): boolean {
  try {
    const r = importSvg(text);
    // "Nothing to import" means nothing drawable, not zero elements.
    if (!drawsSomething(r.shapes)) {
      status.textContent = `${what} draws nothing, so nothing was changed.`;
      status.className = 'st err';
      return false;
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
      `Imported ${n} shape${n === 1 ? '' : 's'}` +
      (r.warnings.length ? `. ${r.warnings.join('; ')}` : '.');
    status.className = r.warnings.length ? 'st err' : 'st ok';
    fit();
    return true;
  } catch (err) {
    const msg =
      err instanceof PathSyntaxError ? `${err.message} (at ${err.offset})` : (err as Error).message;
    status.textContent = msg;
    status.className = 'st err';
    return false;
  }
}

/**
 * Replace the document from the source box.
 *
 * `importSvg` sniffs the input, so either a bare `d` string or a whole `<svg>`
 * works. **Importing markup keeps one shape per element.** Concatenating them
 * into a single `d` first makes Apply silently fuse every shape into one, and
 * the geometry survives that while the shape boundaries do not.
 */
function applySource(): void {
  /* Editing one shape's path data writes back to that shape only, leaving the
     rest of the document alone. Anything else replaces the document, which is
     the shared route. */
  const target = store.state.sourceMode === 'd' ? scopedShape() : null;
  if (!target) {
    replaceDocumentFrom(src.value, 'That');
    return;
  }

  try {
    const r = importSvg(src.value);
    if (!drawsSomething(r.shapes)) {
      status.textContent = 'That draws nothing, so nothing was changed.';
      status.className = 'st err';
      return;
    }
    if (r.shapes.length !== 1) {
      replaceDocumentFrom(src.value, 'That');
      return;
    }
    const id = target.id;
    store.edit((s) => {
      const sh = s.doc.shapes.find((x) => x.id === id);
      if (sh) sh.subpaths = r.shapes[0].subpaths;
      s.selection.nodes.clear();
    });
    status.textContent = `Updated ${target.name}.`;
    status.className = 'st ok';
  } catch (err) {
    const msg =
      err instanceof PathSyntaxError ? `${err.message} (at ${err.offset})` : (err as Error).message;
    status.textContent = msg;
    status.className = 'st err';
  }
}

/** What the document was last read from, for the panel header. */
let loadedName: string | null = null;

const importFile = $('#importFile') as HTMLInputElement;
on('#importSvg', () => importFile.click());
/**
 * Open an SVG file and make it the document.
 *
 * The same route as pasting one into the source box, which is deliberate: a
 * file has no more claim on the document than text does, and it goes through
 * the same importer, the same refusal to accept something that draws nothing,
 * and the same single undo step. What it adds is only the reading.
 */
importFile.addEventListener('change', () => {
  const f = importFile.files?.[0];
  // Reset first: choosing the same file twice fires no `change` otherwise, so
  // a failed import could not be retried by picking the same file again.
  importFile.value = '';
  if (!f) return;
  f.text()
    .then((text) => {
      /* Named before the import, not after. `replaceDocumentFrom` notifies the
         store, which repaints the panel -- so setting it afterwards left the
         header saying `none opened` beside a document that had just been read
         from a file. Cleared again if the import refused. */
      loadedName = f.name;
      if (!replaceDocumentFrom(text, f.name)) loadedName = null;
    })
    .catch(() => {
      status.textContent = `Could not read ${f.name}.`;
      status.className = 'st err';
    });
});

on('#apply', applySource);

/**
 * Put the document's own text back in the box.
 *
 * The box rewrites itself only when the document changes, and a failed Apply
 * changes nothing. Without this, text that parses to nothing has no way back to
 * what the document actually says.
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
      // No worker to be had, so trace on this thread. It freezes the page for
      // the duration, which is still better than refusing to trace.
      commands.traceBackdrop(raster, opts);
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
    commands.applyTrace(result, place);
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

/** Open or shut a shape's paths. Rebuilds, because the rows themselves change. */
function setExpanded(id: string, open: boolean): void {
  if (open) expanded.add(id);
  else expanded.delete(id);
  listSig = null;
  refreshShapeList();
}

/**
 * Select one path of a shape, by selecting every node in it.
 *
 * A path is not a kind of selection and must not become one, which is what keeps
 * the operations that act on whole paths working here unchanged. §47 of
 * `docs/ARCHITECTURE.md` has the argument.
 */
function selectPath(shapeId: string, sp: number, additive: boolean): void {
  const shape = findShape(store.state.doc, shapeId);
  const path = shape?.subpaths[sp];
  if (!path) return;
  const ids = path.nodes.map((n) => n.id);
  store.update((s) => {
    if (!additive) {
      s.selection.shapes.clear();
      s.selection.nodes.clear();
      for (const id of ids) s.selection.nodes.add(id);
      return;
    }
    // Toggling the whole path, so Shift-clicking a lit row puts it out rather
    // than leaving it lit and doing nothing visible.
    const on = ids.every((id) => s.selection.nodes.has(id));
    for (const id of ids) {
      if (on) s.selection.nodes.delete(id);
      else s.selection.nodes.add(id);
    }
  });
}

shapeList.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  // The rename input lives inside the row, so `closest('li')` matched it and
  // clicking to move the caret changed the selection underneath the edit.
  if (target.closest('.rename')) return;

  /* The disclosure before the row, because it sits inside the row it opens and
     `closest('li')` would otherwise read the press as a selection as well. */
  const twist = target.closest<HTMLElement>('.twist');
  if (twist) {
    const id = twist.closest('li')?.getAttribute('data-id');
    if (id) setExpanded(id, !expanded.has(id));
    return;
  }

  const li = target.closest('li');
  const id = li?.getAttribute('data-id');
  if (!id) return;

  /* A path row before its shape row: a path row is nested inside the shape's
     `li` and carries the same `data-id`, so the shape branch below would claim
     every press meant for a path. */
  const sp = li?.getAttribute('data-sp');
  if (sp !== null && sp !== undefined) {
    selectPath(id, Number(sp), (e as MouseEvent).shiftKey);
    return;
  }

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

on('#dupShape', () => commands.duplicateSelection());
on('#copySel', () => commands.copySelection());
on('#cutSel', () => commands.cutSelection());
on('#pasteSel', () => commands.paste());

/* --------------------------------------------------------------- combine */

const boolInfo = $('#boolinfo');
const boolBtns = [...document.querySelectorAll<HTMLButtonElement>('[data-bool]')];

for (const b of boolBtns) {
  b.addEventListener('click', () => {
    const r = commands.booleanSelection(b.getAttribute('data-bool') as BooleanOp);
    status.textContent = r.message;
    status.className = r.ok ? 'st ok' : 'st err';
  });
}

const makeOneBtn = $('#makeone') as HTMLButtonElement;
makeOneBtn.addEventListener('click', () => {
  const r = commands.makeOneShape();
  status.textContent = r.message;
  status.className = r.ok ? 'st ok' : 'st err';
});

const splitBtn = $('#splitshape') as HTMLButtonElement;
splitBtn.addEventListener('click', () => {
  const r = commands.splitShapes();
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
  splitBtn.disabled = !commands.canSplitShapes();
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
  /* `> .nm`, because a shape's `li` now contains the rows for its paths and each
     of those carries a `.nm` of its own. */
  const nm = shapeList.querySelector(`li.shape[data-id="${id}"] > .nm`);
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
      listSig = null; // an input stands where the row was; force the row back
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
  const li = (e.target as HTMLElement).closest('li');
  // A path has no name to edit, and it carries its shape's `data-id`, so without
  // this a double-click on one renamed the shape it belongs to.
  if (li?.hasAttribute('data-sp')) return;
  const id = li?.getAttribute('data-id');
  if (id && !renaming) startRename(id);
});

/**
 * A row of the list, as the keyboard sees it.
 *
 * `sp` of `null` is a shape. The list is a tree now, so walking it means walking
 * what is on screen rather than walking `doc.shapes`: a shape with its paths
 * showing has rows between it and the next shape, and arrowing past them would
 * skip rows a person can see.
 */
interface ListRow {
  id: string;
  sp: number | null;
}

/** The rows in the order they are drawn, shut disclosures left out. */
function visibleRows(): ListRow[] {
  const out: ListRow[] = [];
  for (const sh of store.state.doc.shapes) {
    out.push({ id: sh.id, sp: null });
    if (sh.subpaths.length > 1 && expanded.has(sh.id)) {
      sh.subpaths.forEach((_, i) => out.push({ id: sh.id, sp: i }));
    }
  }
  return out;
}

/** Which row the selection last landed on, or -1. */
function rowAtCursor(rows: ListRow[]): number {
  const s = store.state;
  const shapes = [...s.selection.shapes];
  const last = shapes[shapes.length - 1];
  if (last !== undefined) return rows.findIndex((r) => r.sp === null && r.id === last);
  /* No shape selected, so look for a path whose nodes are all selected. Read
     rather than remembered, so arrowing on from a path row selected by a click
     starts where the click left off. */
  return rows.findIndex((r) => {
    if (r.sp === null) return false;
    const sp = findShape(s.doc, r.id)?.subpaths[r.sp];
    return !!sp && pathIsSelected(sp, s.selection);
  });
}

/** Select one row, replacing the selection or adding to it. */
function selectRow(row: ListRow, additive: boolean): void {
  if (row.sp !== null) {
    selectPath(row.id, row.sp, additive);
    return;
  }
  store.update((st) => {
    if (!additive) {
      st.selection.shapes.clear();
      st.selection.nodes.clear();
    }
    st.selection.shapes.add(row.id);
  });
}

/* A keyboard route into the list, which had none at all: rows are not focusable
   and double-click was the only way to rename. Arrows move the selection, the
   sideways pair opens and shuts a shape's paths, and F2 and Enter rename the way
   they do in every file manager. */
shapeList.addEventListener('keydown', (e) => {
  if (renaming) return;
  const shapes = store.state.doc.shapes;
  if (!shapes.length) return;

  const rows = visibleRows();
  const at = rowAtCursor(rows);

  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const step = e.key === 'ArrowDown' ? 1 : -1;
    const from = at < 0 ? (step > 0 ? -1 : 0) : at;
    selectRow(rows[Math.max(0, Math.min(rows.length - 1, from + step))], e.shiftKey);
    return;
  }

  /* Right opens a shut shape and steps into an open one; Left shuts an open shape
     and steps out from a path. The standard tree bindings, and the only way to
     reach a path row without a pointer. */
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    const row = at >= 0 ? rows[at] : rows[0];
    const shape = findShape(store.state.doc, row.id);
    if (!shape) return;
    e.preventDefault();
    const many = shape.subpaths.length > 1;
    const open = expanded.has(row.id);

    if (e.key === 'ArrowRight') {
      if (row.sp !== null) return; // already as deep as the tree goes
      if (many && !open) setExpanded(row.id, true);
      else if (many) selectRow({ id: row.id, sp: 0 }, false);
      return;
    }
    if (row.sp !== null) {
      selectRow({ id: row.id, sp: null }, false);
      return;
    }
    if (open) setExpanded(row.id, false);
    return;
  }

  if (e.key === 'F2' || e.key === 'Enter') {
    e.preventDefault();
    /* With nothing selected, take the first. The route existed and had a dead
       first step: Tab reaches the list on the very first press, and F2 there
       did nothing until an arrow key had chosen a row -- which reads as the
       key not working rather than as a precondition. */
    const row = at >= 0 ? rows[at] : rows[0];
    // A path has no name. Renaming the shape it sits in would answer a question
    // nobody asked, so the shape is selected instead and named on the next press.
    if (at < 0 || row.sp !== null) selectRow({ id: row.id, sp: null }, false);
    if (row.sp !== null) return;
    startRename(row.id);
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
      [
        sh.id,
        sh.name,
        swatchOf(sh),
        /* Both of these change which rows exist: the count decides whether there
           is a disclosure at all, and the flag whether its rows are drawn. */
        sh.subpaths.length,
        expanded.has(sh.id) ? 'open' : 'shut',
        /* Per path rather than one total, because a break or a delete can move a
           node from one path to another and leave the total alone. */
        sh.subpaths.map((sp) => `${sp.nodes.length}${sp.closed ? 'z' : ''}`).join(','),
      ].join('\u0001'),
    )
    .join('\u0002');

const swatchOf = (sh: Shape): string => (sh.style.fill !== 'none' ? sh.style.fill : sh.style.stroke);

let listSig: string | null = null;

/**
 * Which shapes are showing the paths inside them.
 *
 * Not in the store, for the reason the open panels are not: it is what you are
 * looking at rather than what you have drawn, and undo has no business shutting a
 * disclosure. An id whose shape has gone is harmless, because nothing reads this
 * except by asking about a shape it already has in hand.
 */
const expanded = new Set<string>();

/**
 * Whether every node of one path is selected, which is what a lit path row means.
 *
 * A path is not a thing the selection can hold -- `Selection` is shapes and node
 * ids, and §46 is the argument for not adding a third kind that would have to be
 * kept in step with the second. So a path row selects its nodes, and reads itself
 * back off them. Selecting the path on the canvas by other means lights the row
 * too, which is the behaviour that falls out of deriving rather than storing.
 */
function pathIsSelected(sp: Subpath, sel: Sel): boolean {
  return sp.nodes.length > 0 && sp.nodes.every((n) => sel.nodes.has(n.id));
}

function refreshShapeList(): void {
  if (renaming) return;
  const s = store.state;
  shapeCount.textContent = String(s.doc.shapes.length);

  const sig = listSignature();
  if (sig === listSig) {
    paintListSelection();
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
    li.className = 'shape';
    li.setAttribute('data-id', sh.id);
    /* `aria-selected` is ignored on a plain list item, so the visual state and
       the announced state disagreed. A treeitem is the role that carries it, and
       the role a shape holding paths needs anyway. */
    li.setAttribute('role', 'treeitem');
    li.setAttribute('aria-level', '1');

    /* The disclosure is present on every row and hidden where there is nothing
       to disclose, so the names line up. A row that had no button at all shifted
       its swatch left by 22 px and made the list look ragged. */
    const twist = document.createElement('button');
    twist.type = 'button';
    twist.className = sh.subpaths.length > 1 ? 'twist' : 'twist none';
    twist.textContent = '▸';
    if (sh.subpaths.length > 1) {
      const open = expanded.has(sh.id);
      twist.setAttribute('aria-expanded', String(open));
      li.setAttribute('aria-expanded', String(open));
      twist.setAttribute('aria-label', `${open ? 'Hide' : 'Show'} the ${sh.subpaths.length} paths in ${sh.name}`);
    } else {
      twist.tabIndex = -1;
      twist.setAttribute('aria-hidden', 'true');
    }

    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = swatchOf(sh);

    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = sh.name;

    const ct = document.createElement('span');
    ct.className = 'ct';
    /* The path count where there is more than one, and the node count otherwise.
       Both at once is two numbers with no units in a 288 px column, and which of
       the two matters is exactly whether the shape holds more than one path. */
    ct.textContent =
      sh.subpaths.length > 1
        ? `${sh.subpaths.length} paths`
        : String(sh.subpaths.reduce((a, sp) => a + sp.nodes.length, 0));

    li.append(twist, sw, nm, ct);

    if (sh.subpaths.length > 1 && expanded.has(sh.id)) {
      const kids = document.createElement('ul');
      kids.setAttribute('role', 'group');
      sh.subpaths.forEach((sp, i) => {
        const row = document.createElement('li');
        row.className = 'path';
        row.setAttribute('role', 'treeitem');
        row.setAttribute('aria-level', '2');
        row.setAttribute('data-id', sh.id);
        row.setAttribute('data-sp', String(i));

        const label = document.createElement('span');
        label.className = 'nm';
        label.textContent = `Path ${i + 1}`;

        const count = document.createElement('span');
        count.className = 'ct';
        // Closed or open is the fact that decides what most path operations do
        // with it, and it is not readable from a node count.
        count.textContent = `${sp.nodes.length}${sp.closed ? '' : ' open'}`;

        row.append(label, count);
        kids.append(row);
      });
      li.append(kids);
    }

    shapeList.append(li);
  }
  paintListSelection();
}

/**
 * Which rows read as selected.
 *
 * Split out because the selection changes far more often than the rows do, and
 * the rebuild above is skipped whenever the signature says the rows would be
 * identical. Both paths through `refreshShapeList` end here.
 */
function paintListSelection(): void {
  const s = store.state;
  for (const li of shapeList.querySelectorAll<HTMLElement>('li.shape')) {
    li.setAttribute('aria-selected', String(s.selection.shapes.has(li.getAttribute('data-id')!)));
  }
  for (const row of shapeList.querySelectorAll<HTMLElement>('li.path')) {
    const shape = findShape(s.doc, row.getAttribute('data-id')!);
    const sp = shape?.subpaths[Number(row.getAttribute('data-sp'))];
    row.setAttribute('aria-selected', String(!!sp && pathIsSelected(sp, s.selection)));
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
    ` · ${commands.countNodes()} nodes · ${commands.countSegments()} segments` +
    (canvas.markersCapped ? ' · markers off, too dense' : '');
}
controller.onRender = refreshStats;

/* Where the pointer is, for the rulers' own mark. Kept out of the store because
   it changes on every mouse move and nothing else needs it -- the same reasoning
   the coordinate readout is written straight to the strip.

   Declared above the subscriber that reads it, not next to the handler that
   writes it. It was below, and stayed safe only because `showRulers` defaults
   to false and nothing notifies the store between the two: a `let` read from a
   function defined earlier is in the temporal dead zone until its line runs, so
   flipping that default would have been a blank page and a ReferenceError. */
let rulerAt: [number, number] | null = null;

store.subscribe((s) => {
  for (const b of toolSeg.querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.getAttribute('data-v') === s.tool));
  }
  for (const b of delModeSeg.querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.getAttribute('data-dm') === s.deleteMode));
  }
  for (const b of modSeg.querySelectorAll('button')) {
    const on = b.getAttribute('data-mod') === 'shift' ? s.heldShift : s.heldAlt;
    b.setAttribute('aria-pressed', String(on));
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
  /* The keyline sizes, because someone drawing to them wants the numbers and
     the numbers depend on the page. `on a 24 grid` rather than the ratios: the
     published grid is what people know, and this says which one they have. */
  const kl = keylinesFor(s.doc.viewBox);
  const round2 = (v: number): string => String(Math.round(v * 100) / 100);
  $('#keylineinfo').textContent = !s.showKeylines
    ? 'off'
    : !kl
      ? 'no canvas'
      : `on a ${round2(kl.grid)} grid · circle ${round2(kl.sizes.circle)} · ` +
        `square ${round2(kl.sizes.square)} · rect ${round2(kl.sizes.short)}×${round2(kl.sizes.long)}`;

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
  // The Draw group's header value is declared in the markup and filled only
  // here. Nothing else writes it, so dropping this line blanks it permanently.
  /* The style panel shows the first selected shape, or what the next new shape
     will get. The header says which, since "red" means two different things
     depending on whether anything is selected. */
  const styled = selectedShapes(s.doc, s.selection);
  const shown = styleShown();
  /* The highlight follows the style actually in force, so it lets go the
     moment you change a colour by hand -- a swatch still lit while the panel
     shows something else would be claiming the shape has a style it does not. */
  const matches = s.palette.findIndex(
    (e) =>
      e.style.fill === shown.fill &&
      e.style.stroke === shown.stroke &&
      e.style.strokeWidth === shown.strokeWidth &&
      e.style.fillRule === shown.fillRule,
  );
  if (matches !== paletteAt) {
    paletteAt = matches;
    paintPalette();
  }
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
  /* The pickers stay live while `none` is ticked. Disabling them turns giving an
     unfilled shape a fill into a two-step dance: untick, which commits some
     arbitrary colour, then pick the one you wanted. Reaching for the colour is
     the whole gesture, so it clears `none` itself. */
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
  app.classList.toggle('rulers', s.showRulers);
  app.classList.toggle('guides-locked', s.guidesLocked);
  if (s.showRulers) rulers.render(s.camera, s.gridStep, rulerAt);

  /* What the rays are doing, and where from. `free` is a real answer: the
     origin follows the gesture, which is different from having none. */
  $('#fileinfo').textContent = loadedName ?? 'none opened';
  $('#angleinfo').textContent = !s.snapToAngles
    ? 'off'
    : !(s.angleStep > 0)
      ? 'no step'
      : s.angleOrigin
        ? `every ${s.angleStep}° from ${+s.angleOrigin[0].toFixed(2)}, ${+s.angleOrigin[1].toFixed(2)}`
        : `every ${s.angleStep}° · origin free`;

  /* How many guides there are, and why you cannot see them if you cannot. A
     count alone would say `2 guides` while both were hidden by a checkbox two
     rows up, which is the same class of lie the grid readout was fixed for. */
  const gn = s.guides.length;
  $('#guideinfo').textContent = !gn
    ? 'none'
    : !s.showGuides
      ? `${gn} hidden`
      : s.guidesLocked
        ? `${gn} locked`
        : `${gn}`;
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
 * Open the source on the command that drew the selected node.
 *
 * The other direction is free -- the drawing is on screen and you can point at
 * it -- and this one is not: a path of forty nodes is a wall of numbers with
 * nothing in it to say which is which.
 *
 * It forces `d` mode and scopes to the node's own shape. The offsets come from
 * the serialiser, so they are only true of the exact string it just produced,
 * and in SVG mode that string is embedded in a document with attributes and
 * other shapes around it. Rather than track where, this asks for the one form
 * whose offsets it can trust and says so in the status line.
 */
function findInSource(): void {
  const ref = selectedRefs(store.state.doc, store.state.selection)[0];
  if (!ref) {
    status.textContent = 'Select a node first.';
    status.className = 'st err';
    return;
  }
  const shape = store.state.doc.shapes.find((sh) => sh.id === ref.shape);
  if (!shape) return;

  // Scope the box to this shape alone and to path data, then let the normal
  // refresh produce the text these offsets belong to.
  store.update((s) => {
    s.sourceMode = 'd';
    s.selection.shapes = new Set([ref.shape]);
  });
  setPanel('src', true);

  const marks: Mark[] = [];
  const text = serialisePath(shape.subpaths, { decimals: store.state.decimals, minify: store.state.minify }, marks);
  src.value = text;
  const mark = marks.find((m) => m.sp === ref.sp && m.i === ref.i);
  if (!mark) {
    status.textContent = 'That node has no command of its own: the path closes onto it.';
    status.className = 'st err';
    return;
  }
  src.focus();
  src.setSelectionRange(mark.start, mark.end);
  /* Scroll the selection into view. A textarea will not do it for a range set
     programmatically, and the one reliable lever is the caret: blurring and
     refocusing after the range is set leaves the browser to reveal it. */
  src.blur();
  src.focus();
  src.setSelectionRange(mark.start, mark.end);
  status.textContent = `Node ${ref.sp}/${ref.i} is the ${text.slice(mark.start, mark.end).trim().split(/\s/)[0]} at character ${mark.start}.`;
  status.className = 'st ok';
}

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
  if (store.state.showRulers) {
    rulerAt = [p[0], p[1]];
    rulers.render(store.state.camera, store.state.gridStep, rulerAt);
  }
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
  const label = claimed ? snapLabel(snap.via) : null;
  cursorEl.textContent = `${at[0].toFixed(dp)}, ${at[1].toFixed(dp)}`;
  // Its own element, to the left of the coordinates rather than appended to
  // them. Appended, the name of a tier coming into reach lengthened the string
  // and shoved the digits sideways mid-gesture.
  snapKindEl.textContent = label ?? '';
  showMeasure();
});
canvas.overlay.addEventListener('pointerleave', () => {
  rulerAt = null;
  if (store.state.showRulers) rulers.render(store.state.camera, store.state.gridStep, null);
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
  } else if (m.kind === 'radius') {
    // `radius` rather than `r`, because this slot is prose and the rect tool's own
    // `r 3` readout is a different thing in a different place.
    measureLabel.textContent = 'radius';
    measureVal.textContent = m.r.toFixed(dp);
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

paintPalette();
/* Collapsing groups.
 *
 * Independent toggles rather than an accordion. The snapping aids are used
 * together -- that is the whole point of them being separate tiers of one rule
 * -- so shutting Grid every time Guides opened would be the interface arguing
 * with the feature.
 *
 * Session state, not document state: which groups are open is how you are
 * working, so it is not in the store and not in the history, the same as which
 * panels are open. It is not persisted across a reload either, because nothing
 * in this editor is and one thing that was would be a surprise.
 *
 * Collapsing takes controls out of the tab order as well as off the screen,
 * because `hidden` does both -- so a shut group costs one Tab stop instead of
 * however many controls it holds. `tools/keys.mjs` is what checks that nothing
 * becomes unreachable: it walks the order and reports any live control it never
 * arrives at.
 */
for (const head of document.querySelectorAll<HTMLButtonElement>('button.glabel')) {
  const body = head.nextElementSibling as HTMLElement | null;
  if (!body?.classList.contains('gbody')) continue;
  /* Open where the group acts on what is selected, shut otherwise. Everything
     shut is an empty rail and everything open is what we already had. */
  const group = head.closest('.group');
  const keepOpen = ['Style', 'Node', 'Shapes'].includes(head.querySelector('span')?.textContent ?? '');
  const set = (open: boolean): void => {
    head.setAttribute('aria-expanded', String(open));
    body.hidden = !open;
  };
  set(keepOpen);
  head.addEventListener('click', () => set(head.getAttribute('aria-expanded') !== 'true'));
  void group;
}

installTooltips();

requestAnimationFrame(() => {
  store.update((s) => {
    s.camera = fitAspect(s.camera, canvas.overlay);
  });
  fit();
});
