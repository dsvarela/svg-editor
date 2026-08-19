/**
 * Wiring: document -> store -> canvas -> controller, plus the panels.
 */

import './ui/styles.css';
import { PathSyntaxError } from './core/parse';
import { drawsSomething, exportPathData, exportSvg, importSvg, xmlId } from './io/svg';
import { pngSize, renderPng, svgDataUri } from './io/pixels';
import type { BooleanOp } from './io/boolean';
import {
  docBBox,
  emptyDoc,
  findGroup,
  findShape,
  groupChain,
  dedupeIds,
  reserveIds,
  selectedRefs,
  selectedShapes,
  shapeFromPath,
  shapesInGroup,
} from './model/doc';
import { encode, read as readSession, toSession, whatIsMissing } from './io/session';
import type { Session } from './io/session';
import { SessionStore } from './io/storage';
/* Aliased: the DOM's own `Selection` is a global type, and an unaliased import
   here shadows it in a file that also uses `getSelection`. */
import type { Selection as Sel } from './model/doc';
import { cornerAt, filletAt, isPathEnd, latentHandle } from './model/ops';
import { continuityOf } from './core/types';
import type { Shape, Style, Subpath, ViewBox } from './core/types';
import { clampCorners, clampRatio } from './core/primitives';
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
import type { AlignTo, ZMove } from './model/arrange';
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

/* --------------------------------------------------------------- session */

/**
 * The session, restored before anything else reads the store.
 *
 * Order is the whole of this. Every checkbox below sets itself from
 * `store.state` once, at the moment it is bound, and never again -- the
 * subscriber redraws the canvas and the readouts, not the controls. So a
 * restore that ran after the wiring would put the drawing back and leave
 * fourteen switches showing the state it replaced.
 *
 * The starter document is still built above and still thrown away here when
 * there is something to restore. Building it either way costs one parse and
 * keeps the two paths from diverging: a first visit and a failed restore land
 * in exactly the same editor.
 */
const sessions = new SessionStore();

function applySession(sn: Session): void {
  reserveIds(sn.doc);
  /* And then §46: a file can carry two nodes or two shapes under one id, which
     is one click selecting both and one drag moving both. After `reserveIds`,
     never before, because a fresh id is only fresh once the counters are past
     what the document already holds. */
  dedupeIds(sn.doc);
  /* The history described the document this one replaces, and a snapshot is a
     whole document: undoing into one would put the old drawing back over the
     file that was just opened. Empty at startup, where this is the only
     session there has been. */
  store.forgetHistory();
  store.update((s) => {
    s.doc = sn.doc;
    s.camera = { ...sn.camera };
    s.guides = sn.guides;
    s.palette = sn.palette;
    /* Not restored: it is where you had got to, not how you work, and putting
       handles on screen nobody asked for is a worse first frame than none. */
    s.selection.shapes.clear();
    s.selection.nodes.clear();
    s.sourceError = null;
    /* Everything below belongs to the document being REPLACED, and a session
       carries none of it. Left alone, each outlived its drawing: the backdrop
       stayed on screen positioned in the old document's coordinates, with
       `whatIsMissing` warning the person who SAVED that the file does not carry
       one and nothing warning the person who opens it; and Repeat's matrix was
       computed about a centre in a document that is no longer here. */
    if (s.backdrop) {
      store.onOrphanImage?.(s.backdrop.src);
      s.backdrop = null;
    }
    s.lastTransform = null;
    Object.assign(s, sn.view);
  });
}

/** Held until the status line exists, which is after the panels are wired. */
let opening: { message: string; ok: boolean } | null = null;
/* Whether a restore supplied the camera and the switches, which two later
   decisions turn on: the opening `fit` would throw the camera away, and the
   coarse-pointer default for Touch buttons would overwrite a restored answer. */
let restored = false;
/**
 * Whether the autosave is stopped because a stored session could not be read.
 *
 * A separate fact from the latch it sets. The latch's own sentence tells you a
 * reload will start saving again, and here a reload finds the same entry and
 * stops again, so the readout has to say something else and name the way out.
 */
let keptUnread = false;

{
  const text = sessions.load();
  if (text !== null) {
    const r = readSession(text, toSession(store.state).view);
    if (typeof r === 'string') {
      /* Left where it is, with the autosave stopped so that nothing writes over
         it. Deleting is the only outcome available here that cannot be undone,
         and it is not the only one available: the build that wrote this entry
         can still read it, and it recovers the work by finding the entry still
         there. Deleting bought a message that does not repeat on the next load,
         which is not worth somebody's drawing.

         Stopping is the other half and is not optional. The autosave subscriber
         fires on the first notification after startup, so an entry that is kept
         and not protected is overwritten within the second. */
      sessions.stopped = true;
      keptUnread = true;
      opening = {
        message: `Your saved work could not be read: ${r}. It has been left alone, and nothing new is being saved.`,
        ok: false,
      };
    } else {
      applySession(r);
      restored = true;
      const n = r.doc.shapes.length;
      const what = `${n} shape${n === 1 ? '' : 's'}, and the guides and switches with them`;
      /* A refused write leaves the copy before it in place, so "where you left
         off" would name a drawing nobody left. The marker beside the entry is
         the only thing that can tell the two apart, because the session that
         would have said so is the one that failed to be written. */
      opening = sessions.stale
        ? {
            message: `Restored an earlier copy: ${what}. It is not the drawing you left, which grew too large to save.`,
            ok: false,
          }
        : { message: `Picked up where you left off: ${what}.`, ok: true };
    }
  }
}

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
 * Three tabs over eleven groups, split by what a control acts on: a shape, a
 * node, or the document.
 *
 * Nothing switches tab on its own -- a panel that jumps moves the button you
 * are reaching for. `hidden` rather than a class, so a control you cannot see
 * is out of the tab order too. §22 of `docs/ARCHITECTURE.md`.
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

const TOOLS = ['select', 'pen', 'ellipse', 'rect', 'poly', 'hand'] as const;
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
/**
 * How long a notice stays before the status line goes quiet again, in ms.
 *
 * It used to stay forever. "Nothing drawn yet, so there is nothing to fit the
 * canvas to." sat in the strip through every later action, describing a moment
 * that had passed and contradicting nothing, which is worse than saying nothing:
 * a reader cannot tell a stale notice from a current one.
 */
const NOTICE_MS = 6000;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;

const say = (message: string, ok: boolean): void => {
  const el = $('#status');
  el.textContent = message;
  el.className = ok ? 'st ok' : 'st err';
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    el.textContent = 'Ready.';
    el.className = 'st ok';
  }, NOTICE_MS);
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

/**
 * How a control that reads the store ONCE is told to read it again.
 *
 * A checkbox is set at bind time and never re-read: the subscriber redraws the
 * canvas and the readouts, not the controls, and nothing else has to, because a
 * checkbox is the only thing that writes the value it displays. Opening a
 * workspace broke that assumption -- it writes all 28 view fields at once -- and
 * 22 controls were left describing the session that had been replaced. Two of
 * them were worse than cosmetic: a box shown ticked over a store that said false
 * turned the first press into one that did nothing, and a restored
 * `touchButtons` put the touch row on screen with its own checkbox unticked.
 *
 * A registry rather than a rebuild, because the binding already knows how to
 * read its own value and nothing else does.
 */
const resyncers: (() => void)[] = [];
const resyncControls = (): void => {
  for (const r of resyncers) r();
};

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
    | 'minify'
    | 'touchButtons',
): void => {
  const input = $(id) as HTMLInputElement;
  input.checked = store.state[key];
  input.addEventListener('change', () => store.update((s) => ((s[key] as boolean) = input.checked)));
  resyncers.push(() => (input.checked = store.state[key]));
};

bindCheck('#showGrid', 'showGrid');
bindCheck('#showKeylines', 'showKeylines');
bindCheck('#showRulers', 'showRulers');
bindCheck('#showGuides', 'showGuides');
bindCheck('#guidesLocked', 'guidesLocked');
bindCheck('#smartGuides', 'smartGuides');
bindCheck('#snapAngles', 'snapToAngles');

/* On before the checkbox is bound, so the box shows what is already true.
   `pointer: coarse` is the primary input being imprecise, which is the same
   condition the 44px targets in `styles.css` answer to: those buttons exist for
   a finger, and a finger has no Ctrl+C. A mouse can turn them on here and a
   phone can turn them off; neither is guessed at twice.

   Guessed only on a first visit: a restored session already carries the answer
   somebody gave, and a media query is not entitled to overrule it. */
if (!restored) {
  store.update((s) => (s.touchButtons = window.matchMedia('(pointer: coarse)').matches));
}
bindCheck('#touchButtons', 'touchButtons');

/* Angular snap's three numbers. The step is clamped above zero because a step
   of 0 asks for infinitely many rays; the base is free, since any angle is a
   legitimate place for the first one. */
const angleStep = $('#angleStep') as HTMLInputElement;
angleStep.value = String(store.state.angleStep);
resyncers.push(() => (angleStep.value = String(store.state.angleStep)));
angleStep.addEventListener('input', () =>
  store.update((s) => (s.angleStep = Math.max(0, Number(angleStep.value) || 0))),
);
const angleBase = $('#angleBase') as HTMLInputElement;
angleBase.value = String(store.state.angleBase);
resyncers.push(() => (angleBase.value = String(store.state.angleBase)));
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
resyncers.push(() => (gridInput.value = String(store.state.gridStep)));
gridInput.addEventListener('input', () =>
  store.update((s) => (s.gridStep = Math.max(0, Number(gridInput.value) || 0))),
);

const nudgeBigInput = $('#nudgeBig') as HTMLInputElement;
nudgeBigInput.value = String(store.state.nudgeBig);
resyncers.push(() => (nudgeBigInput.value = String(store.state.nudgeBig)));
nudgeBigInput.addEventListener('input', () =>
  // Floored at 1: a multiplier below one would make Shift move things *less*
  // than a bare arrow key, which is the opposite of what the key is for.
  store.update((s) => (s.nudgeBig = Math.max(1, Number(nudgeBigInput.value) || 1))),
);

/* Rounding a corner. One control for it, reaching every corner the same way,
   rather than a second radius on the rectangle tool that no other tool read and
   nothing said so. */
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
const opacityInput = $('#opacity') as HTMLInputElement;

/** What the panel currently describes: the selection, or the next new shape. */
const styleShown = (): Style => {
  const s = store.state;
  const sel = selectedShapes(s.doc, s.selection);
  return sel.length ? sel[0].style : s.style;
};

/* ------------------------------------------------------------- the palette */

/** Which saved style is highlighted, so Delete style knows what to delete. */
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
  const sig = list
    .map((e) => [e.name, e.style.fill, e.style.stroke, e.style.strokeWidth, e.style.fillRule, e.style.opacity].join('\u0001'))
    .join('\u0002');
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
    b.title =
      `Fill ${entry.style.fill}, stroke ${entry.style.stroke} at ${entry.style.strokeWidth}` +
      (entry.style.opacity < 1 ? `, ${Math.round(entry.style.opacity * 100)}% opaque` : '');
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
    a.fill === b.fill &&
    a.stroke === b.stroke &&
    a.strokeWidth === b.strokeWidth &&
    a.fillRule === b.fillRule &&
    a.opacity === b.opacity;
  const already = store.state.palette.findIndex((e) => same(e.style, shown));
  if (already >= 0) {
    paletteAt = already;
    paintPalette();
    say(`Already saved as ${store.state.palette[already].name}.`, false);
    return;
  }
  store.update((st) => st.palette.push({ name: base, style: { ...shown } }));
  paletteAt = store.state.palette.length - 1;
  paintPalette();
  say(`Saved ${base}.`, true);
});

on('#paletteDrop', () => {
  const at = paletteAt;
  if (at < 0 || at >= store.state.palette.length) return;
  const gone = store.state.palette[at].name;
  store.update((st) => st.palette.splice(at, 1));
  paletteAt = -1;
  paintPalette();
  say(`Deleted ${gone}.`, true);
});

/* The key as well as the button, since a highlighted swatch is a selected thing
   and Delete is what removes a selected thing everywhere else here. Guarded on
   the palette having focus, or Delete anywhere in the panel would take a style
   away while you were looking at the canvas. */
paletteEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Delete' && e.key !== 'Backspace') return;
  if (paletteAt < 0) return;
  e.preventDefault();
  e.stopPropagation();
  ($('#paletteDrop') as HTMLButtonElement).click();
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

/* Typed as a percentage and stored as SVG's 0 to 1. Clamped rather than
   refused: `min` and `max` on the element only bind the spinner, and a pasted
   `400` is a number somebody meant as "all of it". */
streamed(opacityInput, () => {
  const v = Number(opacityInput.value);
  if (!Number.isFinite(v)) return;
  commands.setStyle({ opacity: Math.min(1, Math.max(0, v / 100)) });
});

/* ------------------------------------------------------------- polygon */

/**
 * What the polygon tool draws next.
 *
 * The ratio is typed as a percentage and stored as the fraction SVG geometry
 * wants, the same split as Opacity. Both numbers are clamped here as well as by
 * the element, because `min` and `max` bind the spinner and not a paste.
 */
const polyCorners = $('#polyCorners') as HTMLInputElement;
const polyRatio = $('#polyRatio') as HTMLInputElement;
const polyRatioRow = $('#polyRatioRow');

$('#polyKind').addEventListener('click', (e) => {
  const v = (e.target as HTMLElement).closest('button')?.getAttribute('data-pk');
  if (v === 'poly' || v === 'star') store.update((st) => (st.polygon.star = v === 'star'));
});
streamed(polyCorners, () => {
  const v = Number(polyCorners.value);
  if (!Number.isFinite(v)) return;
  store.update((st) => (st.polygon.corners = clampCorners(v)));
});
streamed(polyRatio, () => {
  const v = Number(polyRatio.value);
  if (!Number.isFinite(v)) return;
  store.update((st) => (st.polygon.ratio = clampRatio(v / 100)));
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
resyncers.push(() => (decInput.value = String(store.state.decimals)));
decInput.addEventListener('input', () =>
  store.update((s) => (s.decimals = Math.min(9, Math.max(0, Number(decInput.value) || 0)))),
);

/* -------------------------------------------------------- node inspector */

const nodeGroup = $('#nodegroup');
const nodeInfo = $('#nodeinfo');
const roundWhy = $('#roundwhy');
const handleWhy = $('#handlewhy');
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
  if (v === 'cusp' || v === 'smooth' || v === 'symmetric') commands.setSelectedContinuity(v);
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

/* Committed on `change`, not streamed on `input` like the canvas fields above.
   The matrix is derived from the box each time, so a stream of keystrokes
   scales through the widths a half-typed number spells: typing 120 passes
   through 1, and a selection below `FLAT` on an axis cannot be scaled back.
   §52. */
const boundFields: [string, 'x' | 'y' | 'w' | 'h'][] = [
  ['#selX', 'x'],
  ['#selY', 'y'],
  ['#selW', 'w'],
  ['#selH', 'h'],
];
for (const [id, part] of boundFields) {
  const input = $(id) as HTMLInputElement;
  input.addEventListener('change', () => {
    const v = Number(input.value);
    if (input.value.trim() !== '' && Number.isFinite(v)) commands.setSelectionBound(part, v);
    refreshBounds();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
  });
}

/**
 * Commit a half-typed size before the canvas takes the selection away.
 *
 * `change` fires on blur, and moving focus is the DEFAULT ACTION of a
 * pointerdown -- it happens after every pointerdown listener has run. So
 * pressing a shape on the canvas let the controller replace the selection
 * first, and the number then landed on the shape that had just been pressed:
 * type 50 into the width, press a different shape, and that shape is resized
 * mid-gesture while the one the field described is untouched. On bare canvas the
 * edit was dropped with `Nothing is selected.`
 *
 * Capture on the stage, so it runs before the overlay's own listener rather than
 * in registration order beside it. Every other route out of the field was always
 * correct: a panel button and a shape-list row both act on `click`, which comes
 * after the focus shift, which is why this is the only place that needs saying.
 */
canvasRoot.addEventListener(
  'pointerdown',
  () => {
    const el = document.activeElement;
    if (el instanceof HTMLInputElement && boundFields.some(([id]) => id === `#${el.id}`)) el.blur();
  },
  true,
);

function refreshBounds(): void {
  const b = commands.selectionBounds();
  for (const [id, part] of boundFields) {
    const el = $(id) as HTMLInputElement;
    el.disabled = !b;
    // Left alone while it has focus, so a number being typed is not overwritten
    // by the render the previous keystroke caused.
    if (document.activeElement === el) continue;
    el.value = b ? String(Math.round(b[part] * 1000) / 1000) : '';
  }
}

document.querySelectorAll<HTMLButtonElement>('[data-z]').forEach((b) =>
  b.addEventListener('click', () => commands.reorderSelection(b.getAttribute('data-z') as ZMove)),
);

/* Arranging whole shapes. Which frame the buttons work in is a standing
   preference like the delete mode, so it lives here rather than in the store:
   nothing about it belongs in an undo step, and no other module asks. */
let alignTo: AlignTo = 'selection';
const alignToSeg = $('#alignTo');
const spaceGap = $('#spaceGap') as HTMLInputElement;
const arrangeInfo = $('#arrangeinfo');

alignToSeg.addEventListener('click', (e) => {
  const v = (e.target as HTMLElement).closest('button')?.getAttribute('data-to');
  if (v !== 'selection' && v !== 'canvas') return;
  alignTo = v;
  for (const b of alignToSeg.querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.getAttribute('data-to') === alignTo));
  }
  refreshArrange();
});

document.querySelectorAll<HTMLButtonElement>('[data-sal]').forEach((b) =>
  b.addEventListener('click', () =>
    commands.alignShapes(b.getAttribute('data-sal') as AlignMode, alignTo),
  ),
);
document.querySelectorAll<HTMLButtonElement>('[data-sdi]').forEach((b) =>
  b.addEventListener('click', () =>
    commands.distributeShapes(b.getAttribute('data-sdi') as AlignMode, alignTo),
  ),
);
document.querySelectorAll<HTMLButtonElement>('[data-ssp]').forEach((b) =>
  b.addEventListener('click', () => {
    /* An empty field asks for the gap that fills the frame, which is a different
       request from a gap of zero. Reading `.value` rather than `.valueAsNumber`
       is what keeps the two apart: the number is `NaN` for both. */
    const raw = spaceGap.value.trim();
    const axis = b.getAttribute('data-ssp') as 'h' | 'v';
    commands.spaceShapes(axis, alignTo, raw === '' ? null : Number(raw));
  }),
);

function refreshArrange(): void {
  const n = commands.arrangeCount;
  arrangeInfo.textContent = n === 0 ? 'none' : `${n} item${n === 1 ? '' : 's'}`;
  // Aligning one shape to the canvas is a real request; to the selection it is not.
  const leastToAlign = alignTo === 'canvas' ? 1 : 2;
  document.querySelectorAll<HTMLButtonElement>('[data-sal]').forEach((b) => (b.disabled = n < leastToAlign));
  document.querySelectorAll<HTMLButtonElement>('[data-sdi]').forEach((b) => (b.disabled = n < 3));
  document.querySelectorAll<HTMLButtonElement>('[data-ssp]').forEach((b) => (b.disabled = n < 2));
  spaceGap.disabled = n < 2;
}

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


/**
 * Whether the selected node's corner can be rounded, in three words.
 *
 * There are four reasons the corner control does not appear, and every one of
 * them was silent: the node ends an open path, a handle exists on either side,
 * nothing is selected, or two fillets have merged onto a shared node and
 * `filletAt` can no longer read either of them. A control that is simply absent
 * looks the same as a feature that is broken, and `Round` already owns sentences
 * for the first two while the canvas owned none.
 *
 * The wording is shorter than `Round`'s because this sits in a group header
 * beside the node's index, not in the status line. Both come from the same
 * `cornerAt`, so they cannot disagree about which corners are roundable.
 */
function roundability(sp: Subpath, i: number): string | null {
  if (filletAt(sp, i) || (i > 0 && filletAt(sp, i - 1))) return null;
  const c = cornerAt(sp, i);
  if (typeof c !== 'string') return null;
  return {
    end: 'No corner here: this node ends the path, so it has only one side.',
    curved: 'No corner here: Round needs a straight segment on both sides.',
    straight: 'No corner here: the path runs straight through this node.',
    tiny: 'No corner here: the sides are too short to cut.',
  }[c];
}

function refreshInspector(): void {
  const sel = commands.singleSelectedNode();
  const count = commands.selectionCount();

  nodeGroup.classList.toggle('disabled', count === 0);
  nodeInfo.textContent = sel ? `${sel.ref.sp}/${sel.ref.i}` : count ? `${count} selected` : 'none';

  /* Only when there is something to say. A roundable corner shows its control,
     so the line would be restating the canvas; an unroundable one shows nothing
     at all, which is the case this exists for. */
  const why = sel ? roundability(sel.subpath, sel.ref.i) : null;
  roundWhy.textContent = why ?? '';
  roundWhy.hidden = !why;
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

  /* All three derived from state every notification carries. Paste was not, and
     the reason given was that copying raises no notification -- which stopped
     being true when `copySelection` gained a `store.notify()` for exactly this,
     leaving the comment arguing for a design the line below had replaced. */
  const anything = count > 0 || store.state.selection.shapes.size > 0;
  ($('#copySel') as HTMLButtonElement).disabled = !anything;
  ($('#cutSel') as HTMLButtonElement).disabled = !anything;
  // Both derived from the selection, which every notification carries.
  ($('#groupShapes') as HTMLButtonElement).disabled = !commands.canGroup;
  ($('#ungroupShapes') as HTMLButtonElement).disabled = !commands.canUngroup;
  ($('#selectGroup') as HTMLButtonElement).disabled = !commands.canSelectGroup;
  ($('#repeatTransform') as HTMLButtonElement).disabled = !commands.canRepeatTransform;
  $('#repeatinfo').textContent = store.state.lastTransform?.what ?? 'nothing yet';
  /* Live for any selected shape, including one already at the front. Whether
     there is room to move is a question about the whole tree, and a button that
     greys out on the answer would flicker as the selection changed; pressing it
     with nowhere to go simply declines. */
  document.querySelectorAll<HTMLButtonElement>('[data-z]').forEach((b) => (b.disabled = !commands.canReorder));
  refreshArrange();
  refreshBounds();
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
  ($('#pasteSel') as HTMLButtonElement).disabled = !commands.canPaste;

  /* One node is the case this missed. Fuse welds two nodes that sit on the same
     point, or sweeps a whole shape for zero-length segments -- one node on its
     own is neither, so the button used to offer a press whose only outcome was
     "No two nodes there sit on the same point." */
  ($('#fuseNodes') as HTMLButtonElement).disabled =
    twoEnds || (count < 2 && store.state.selection.shapes.size === 0);

  const dp = store.state.decimals;
  let latent = false;
  for (const f of coordFields) {
    // Never clobber a field mid-edit.
    if (document.activeElement === f.input) continue;
    if (!sel) {
      f.input.value = '';
      f.input.disabled = true;
      f.input.classList.remove('ghost');
      continue;
    }
    const real = f.part === 'anchor' ? sel.node.pt : f.part === 'in' ? sel.node.hIn : sel.node.hOut;
    const pt = real ?? (f.part === 'anchor' ? null : latentHandle(sel.subpath, sel.ref.i, f.part));
    if (!pt) {
      // No segment on that side at all, so there is nothing to curve.
      f.input.value = '';
      f.input.disabled = true;
      f.input.classList.remove('ghost');
      continue;
    }
    /* A handle that is not there reads exactly like one that is, because
       `latentHandle` fills the field with where it would go. Two identically
       drawn shapes then differ for a reason nothing on this panel shows, and
       Round refuses one of them: `cornerAt` wants both sides straight, and a
       straight side is one with no handle on it. */
    f.input.classList.toggle('ghost', !real);
    if (!real) latent = true;
    f.input.disabled = false;
    f.input.value = (+pt[f.axis].toFixed(dp)).toString();
  }
  handleWhy.hidden = !sel || !latent;
  handleWhy.textContent = handleWhy.hidden
    ? ''
    : 'Dimmed: that handle does not exist. The number is where one would go.';
}

/* ----------------------------------------------------------------- source */

const src = $('#src') as HTMLTextAreaElement;
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
      say(`${what} draws nothing, so nothing was changed.`, false);
      return false;
    }

    store.edit((s) => {
      s.doc.shapes = r.shapes;
      // Taken with the shapes, not derived from them: `Shape.group` names ids that
      // only exist in this list, so replacing one without the other leaves every
      // shape pointing at a group the document does not have.
      s.doc.groups = r.groups;
      if (r.viewBox) s.doc.viewBox = r.viewBox;
      s.selection.nodes.clear();
      s.selection.shapes.clear();
      s.sourceError = null;
    });
    const n = r.shapes.length;
    say(
      `Imported ${n} shape${n === 1 ? '' : 's'}` +
        (r.warnings.length ? `. ${r.warnings.join('; ')}` : '.'),
      r.warnings.length === 0,
    );
    fit();
    return true;
  } catch (err) {
    const msg =
      err instanceof PathSyntaxError ? `${err.message} (at ${err.offset})` : (err as Error).message;
    say(msg, false);
    return false;
  }
}

/**
 * Add the shapes from SVG or path-data text to the document.
 *
 * What a file does, where the source box replaces. The box shows the whole
 * document, so Apply meaning "the document is now this" is the only reading it
 * can have; a file is something you brought to a drawing you are already
 * working on, and replacing it threw that drawing away.
 *
 * Ids need no repair. `nextId` and `nextNodeId` are monotonic counters shared by
 * the importer and the document, so what arrives cannot collide with what is
 * here. Groups come with the shapes for the reason they do in `replaceDocument
 * From`: `Shape.group` names ids that exist only in that list.
 *
 * The viewBox is not taken. The document's own page is the one thing on screen
 * that an import has no claim on, and adopting the file's would resize the page
 * around whatever was already drawn on it. The camera is re-fitted instead, so
 * artwork that landed outside the page is at least visible.
 */
function addShapesFrom(text: string, what: string): boolean {
  try {
    const r = importSvg(text);
    if (!drawsSomething(r.shapes)) {
      say(`${what} draws nothing, so nothing was added.`, false);
      return false;
    }

    store.edit((s) => {
      s.doc.shapes.push(...r.shapes);
      if (r.groups.length) s.doc.groups = [...(s.doc.groups ?? []), ...r.groups];
      // Selected, because the next thing anyone does is move what just arrived.
      s.selection.nodes.clear();
      s.selection.shapes.clear();
      for (const sh of r.shapes) s.selection.shapes.add(sh.id);
      s.sourceError = null;
    });
    const n = r.shapes.length;
    say(
      `Added ${n} shape${n === 1 ? '' : 's'} from ${what}` +
        (r.warnings.length ? `. ${r.warnings.join('; ')}` : '.'),
      r.warnings.length === 0,
    );
    fit();
    return true;
  } catch (err) {
    const msg =
      err instanceof PathSyntaxError ? `${err.message} (at ${err.offset})` : (err as Error).message;
    say(msg, false);
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
      say('That draws nothing, so nothing was changed.', false);
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
    say(`Updated ${target.name}.`, true);
  } catch (err) {
    const msg =
      err instanceof PathSyntaxError ? `${err.message} (at ${err.offset})` : (err as Error).message;
    say(msg, false);
  }
}

/** What the document was last read from, for the panel header. */
let loadedName: string | null = null;

const importFile = $('#importFile') as HTMLInputElement;
on('#importSvg', () => importFile.click());
/**
 * Read an SVG file and add its shapes to the document.
 *
 * The same importer as the source box, the same refusal of something that draws
 * nothing, and the same single undo step. What differs is only that this one
 * adds: see `addShapesFrom`.
 */
importFile.addEventListener('change', () => {
  const f = importFile.files?.[0];
  // Reset first: choosing the same file twice fires no `change` otherwise, so
  // a failed import could not be retried by picking the same file again.
  importFile.value = '';
  if (!f) return;
  f.text()
    .then((text) => {
      /* Named before the import, not after. `addShapesFrom` notifies the
         store, which repaints the panel -- so setting it afterwards left the
         header saying `none opened` beside a document that had just been read
         from a file. Cleared again if the import refused. */
      const was = loadedName;
      loadedName = f.name;
      if (!addShapesFrom(text, f.name)) loadedName = was;
    })
    .catch(() => {
      say(`Could not read ${f.name}.`, false);
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
  say("Put back what the document says. Nothing was applied.", true);
});
src.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') applySource();
});

on('#copy', () => {
  void navigator.clipboard.writeText(currentSource()).then(
    () => {
      say('Copied.', true);
    },
    () => {
      say('Clipboard blocked by the browser.', false);
    },
  );
});

/* -------------------------------------------------------------- pixels */

/**
 * The drawing at the sizes an icon ships at, and the same drawing saved as one.
 *
 * Both go through `svgDataUri`, which writes the document with the Output
 * settings, so what these show is what the exported file draws rather than what
 * the editor holds.
 */
const previewGroup = [...document.querySelectorAll<HTMLButtonElement>('button.glabel')].find(
  (b) => b.querySelector('span')?.textContent === 'Preview',
);
const previewImgs: [HTMLImageElement, number][] = [16, 24, 32, 48].map((px) => [
  $(`#prev${px}`) as HTMLImageElement,
  px,
]);
const previewInfo = $('#previewinfo');

const previewOpen = (): boolean => previewGroup?.getAttribute('aria-expanded') === 'true';

function refreshPreview(): void {
  const s = store.state;
  const n = s.doc.shapes.length;
  previewInfo.textContent = `${n} shape${n === 1 ? '' : 's'}`;
  /* Shut means nothing to see, so nothing is serialised. The source drawer takes
     the same position for the same reason: a panel nobody is looking at should
     not cost a redraw.

     Held still during a drag too: pointing an `<img>` at a new data URI parses
     and rasters the whole document four times over, which stutters the drag it
     illustrates. The drag ends with a notification, which redraws these. §53. */
  if (!previewOpen() || controller.busy) return;
  const uri = svgDataUri(s.doc, { decimals: s.decimals, minify: s.minify });
  for (const [img, px] of previewImgs) {
    /* Shaped like the canvas rather than square, and by the same arithmetic the
       PNG uses. A square swatch of a wide document letterboxes the drawing, so
       the size under it would be describing the box and not the icon. */
    const { w, h } = pngSize(s.doc.viewBox, px);
    img.width = w;
    img.height = h;
    img.src = uri;
  }
}

previewGroup?.addEventListener('click', () => {
  // The class toggle runs on its own listener; this one only has to catch up
  // the images, which were left stale while the group was shut.
  refreshPreview();
});

on('#downloadPng', () => {
  const s = store.state;
  const width = Number(($('#pngWidth') as HTMLInputElement).value);
  if (!Number.isFinite(width) || width < 1) {
    say('A PNG needs a width of at least one pixel.', false);
    return;
  }
  const { w, h } = pngSize(s.doc.viewBox, width);
  say(`Drawing ${w} × ${h}…`, true);
  void renderPng(s.doc, width, { decimals: s.decimals, minify: s.minify }).then(
    (blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'drawing.png';
      a.click();
      URL.revokeObjectURL(url);
      say(`Saved ${w} × ${h}, ${Math.round(blob.size / 102.4) / 10} kB.`, true);
    },
    (err: unknown) => say(`No PNG: ${err instanceof Error ? err.message : String(err)}`, false),
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

/* ------------------------------------------------------- saving the session */

/**
 * Hand a string to the browser as a file. Three downloads did this by hand.
 *
 * The revoke is immediate, which reads wrong and is right: the click has
 * already started the download and holds its own reference to the blob, so
 * freeing the URL frees the name and not the bytes. §53 makes the same point
 * about the PNG, where the scenario reads the blob back after this has run.
 */
function download(text: string, name: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

on('#saveWorkspace', () => {
  download(encode(toSession(store.state)), 'workspace.json', 'application/json');
  const gone = whatIsMissing(store.state);
  say(gone ? `Saved the workspace. It does not carry ${gone}.` : 'Saved the workspace.', true);
});

const workspaceFile = $('#workspaceFile') as HTMLInputElement;
on('#openWorkspace', () => workspaceFile.click());

/**
 * Open a workspace, replacing the session.
 *
 * Replaces rather than adds, which is the opposite of what **Add an SVG** does
 * two rows above it, and the reason the two are under different headings. A
 * workspace is a whole session -- the camera, the guides, every switch -- and
 * there is no coherent way to merge two of those. Two cameras is not a camera.
 *
 * The history goes with the document it belonged to, in `applySession`. It is a
 * stack of edits to one drawing rather than a stack of drawings, so there is no
 * entry in it that means "opened a file" and nothing in it is true of the
 * drawing that arrived. The message says the session was replaced, which is
 * what an empty history then agrees with.
 */
workspaceFile.addEventListener('change', () => {
  const f = workspaceFile.files?.[0];
  workspaceFile.value = '';
  if (!f) return;
  void f.text().then(
    (text) => {
      const r = readSession(text, toSession(store.state).view);
      if (typeof r === 'string') {
        say(`${f.name} is not a workspace this build can open: ${r}.`, false);
        return;
      }
      /* Named BEFORE the apply, not after. `#fileinfo` is only ever written
         inside the store subscriber, so the notification `applySession` raises
         would carry the previous name and the panel would say the wrong file
         until some later unrelated edit. The import path two hundred lines up
         already had this rule and spells it out; this handler broke it. */
      loadedName = f.name;
      applySession(r);
      /* The rest of the reset lives here rather than in `applySession`, because
         it is only true of a session replacing a LIVE editor. At startup there
         is nothing to clear, and every name below is declared further down this
         file than the startup restore runs. */
      expanded.clear();
      seenGroups.clear();
      resyncControls();
      const n = r.doc.shapes.length;
      say(`Opened ${f.name}: ${n} shape${n === 1 ? '' : 's'}, and the session around them.`, true);
    },
    (err: unknown) => say(`Could not read ${f.name}: ${String(err)}`, false),
  );
});

/**
 * Keep a copy in this browser, so a reload does not lose the work.
 *
 * On a timer rather than on every notification: the store notifies once per
 * notch of a drag, and serialising a document sixty times a second is the kind
 * of autosave people go looking for the switch to turn off. `flush` on the way
 * out is what makes the last edit before a close the one that is kept, since
 * that is the edit still sitting in the timer.
 *
 * `pagehide` rather than `beforeunload`: the second is ignored on iOS and fires
 * a dialog nobody wants on the rest. `visibilitychange` catches the tab being
 * switched away from, which on a phone is how a page usually dies.
 */
store.subscribe(() => sessions.schedule(() => encode(toSession(store.state))));
window.addEventListener('pagehide', () => sessions.flush());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') sessions.flush();
});

on('#forgetSession', () => {
  sessions.forget();
  // The entry it was protecting is gone, so the ordinary latch sentence is true
  // again: a reload from here starts saving.
  keptUnread = false;
  /* Stopped, not paused: leaving the subscriber running would write the
     session back within the second and make the button look broken. It comes
     back on the next reload, which is also when a person would expect a fresh
     start to have taken effect. */
  sessions.stopped = true;
  say('Forgotten. This browser holds no copy, and none will be kept until you reload.', true);
  refreshSaveState();
});

const autosaveInfo = $('#autosaveinfo');
const autosaveWhy = $('#autosavewhy');

/**
 * Say whether the work is being kept, and never say it is when it is not.
 *
 * The whole point of the shopping-list entry this answers: opened from
 * `file://`, Chromium gives the page an opaque origin and every `localStorage`
 * access throws, so a tick that is always on would be a lie exactly where it
 * matters most. The reason is named, because "not saving" with no cause reads
 * as a bug in the editor rather than a rule of the browser.
 */
function refreshSaveState(): void {
  const state = keptUnread ? 'unread' : sessions.stopped ? 'stopped' : sessions.blocked;
  autosaveInfo.textContent =
    state === null ? 'saving' : state === 'stopped' ? 'stopped' : 'not saving';
  autosaveInfo.className = state === null ? 'gval' : 'gval warn';
  autosaveWhy.textContent =
    state === null
      ? 'The same workspace, kept in this browser and restored when you come back. It is not a backup: clearing site data removes it.'
      : state === 'stopped'
        ? 'Nothing is being kept until you reload. Save a workspace file if you want this drawing to survive.'
        : state === 'unread'
          ? 'A copy is here that this editor could not read, and it has been left alone rather than written over. Press Forget saved work to clear it, or open the build that saved it.'
          : state === 'too-big'
            ? 'This drawing is too large for the space a browser gives a page. Save a workspace file instead.'
            : 'This browser will not let a page opened from a file keep anything. Save a workspace file instead.';
}

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
    say(`Tracing over ${file.name}. It is not part of the drawing.`, true);
  };
  probe.onerror = () => {
    URL.revokeObjectURL(src);
    say('That file could not be read as an image.', false);
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
    say('Load an image in the Backdrop panel first.', false);
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
  say(`Tracing ${b.name}…`, true);
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
      say('The backdrop changed while tracing. Nothing was added.', false);
      return;
    }
    if (controller.busy) {
      say('Finish the drag first, then trace.', false);
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
      say('That image could not be traced.', false);
      return;
    }
    commands.applyTrace(result, place);
  } catch {
    say('That image could not be read for tracing.', false);
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

/** An SVG by type or by name: a file dragged from some places arrives typeless. */
const isSvgFile = (f: File): boolean => f.type === 'image/svg+xml' || /\.svg$/i.test(f.name);

// Dropping onto the canvas is the gesture people try first.
canvasRoot.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
});
canvasRoot.addEventListener('drop', (e) => {
  const f = e.dataTransfer?.files?.[0];
  if (!f) return;
  e.preventDefault();
  /* An SVG is editable, so it comes in as shapes. It is an `image/` type too --
     `image/svg+xml` -- so the test for it has to come first, or the one thing
     this program can actually open arrives as a picture to trace over. */
  if (isSvgFile(f)) {
    f.text()
      .then((text) => {
        const was = loadedName;
        loadedName = f.name;
        if (!addShapesFrom(text, f.name)) loadedName = was;
      })
      .catch(() => say(`Could not read ${f.name}.`, false));
    return;
  }
  if (f.type.startsWith('image/')) loadBackdrop(f);
  else say('Drop an SVG to open it, or an image to trace over.', false);
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
  say(locked ? 'Backdrop locked. Dragging the canvas selects again.' : 'Backdrop unlocked. Drag the canvas to move it.', true);
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
  say('Backdrop removed. Undo brings it back.', true);
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
    const li = twist.closest('li');
    const id = li?.getAttribute('data-group') ?? li?.getAttribute('data-id');
    if (id) setExpanded(id, !expanded.has(id));
    return;
  }

  const li = target.closest('li');

  /* A group row before a shape row. A group's `li` contains every row inside it, so
     `closest('li')` from a shape gives the shape -- but a press on the group's own
     line gives the group, and it carries no `data-id` for the branch below to read. */
  const groupId = li?.getAttribute('data-group');
  if (groupId) {
    selectRow({ id: groupId, sp: null, group: true }, (e as MouseEvent).shiftKey);
    return;
  }

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

/* ------------------------------------------ reordering a row by dragging it */

/**
 * Paint order, dragged. The four tiles and `Ctrl+[` do the same one step at a
 * time, and this is the same operation with the destination named directly.
 *
 * **A drop lands only among the row's own siblings.** The targets are the rows
 * in the `<ul>` the dragged row already sits in, so there is no gesture here
 * that takes a shape out of a group and §49's contiguity is never at risk.
 * Ungroup is how a shape leaves.
 *
 * Pointer events rather than HTML drag and drop, which no touch screen
 * implements. A finger has to be able to scroll this list as well as reorder it,
 * so a mouse starts the drag on movement and a finger on a hold.
 */
const ROW_HOLD_MS = 400;
const ROW_SLOP = 4;

const dropLine = document.createElement('div');
dropLine.className = 'dropline';
dropLine.setAttribute('aria-hidden', 'true');

/** A row's key in `doc.shapes` terms: a group id, or a shape id. */
const rowKey = (li: HTMLElement): string | null =>
  li.getAttribute('data-group') ?? li.getAttribute('data-id');

interface RowDrag {
  rows: HTMLElement[];
  parent: string | null;
  /** Client y of each boundary: `gaps[i]` is the line above `rows[i]`. */
  gaps: number[];
  at: number;
}
let rowDrag: RowDrag | null = null;
let armed: { key: string; y: number; pointer: number; timer: number } | null = null;

const disarm = (): void => {
  if (armed) clearTimeout(armed.timer);
  armed = null;
};

/** Where the line goes for a pointer at `y`, and drawing it there. */
function aimRowDrag(d: RowDrag, y: number): void {
  let best = 0;
  for (let i = 1; i < d.gaps.length; i++) {
    if (Math.abs(d.gaps[i] - y) < Math.abs(d.gaps[best] - y)) best = i;
  }
  d.at = best;
  const box = shapeList.getBoundingClientRect();
  dropLine.style.top = `${d.gaps[best] - box.top + shapeList.scrollTop}px`;
}

function beginRowDrag(key: string, y: number): void {
  /* Selected first, and the row found again afterwards: selecting notifies the
     store, and the list rebuilds itself from scratch on a notification. Rows
     captured before that are detached nodes by the time the pointer moves. */
  const first = shapeList.querySelector<HTMLElement>(`li[data-group="${key}"], li.shape[data-id="${key}"]`);
  if (!first) return;
  const already = rowShapes(rowOf(first)).every((id) => store.state.selection.shapes.has(id));
  if (!already) selectRow(rowOf(first), false);

  const row = shapeList.querySelector<HTMLElement>(`li[data-group="${key}"], li.shape[data-id="${key}"]`);
  const container = row?.parentElement;
  if (!row || !container) return;

  const rows = [...container.children].filter(
    (el): el is HTMLElement => el instanceof HTMLElement && el.matches('li.shape, li.group'),
  );
  if (rows.length < 2) return;

  const gaps = rows.map((r) => r.getBoundingClientRect().top);
  gaps.push(rows[rows.length - 1].getBoundingClientRect().bottom);

  rowDrag = {
    rows,
    // The `<ul>` a group owns lives inside that group's own row.
    parent: container.closest<HTMLElement>('li.group')?.getAttribute('data-group') ?? null,
    gaps,
    at: 0,
  };
  for (const r of rows) {
    if (rowShapes(rowOf(r)).every((id) => store.state.selection.shapes.has(id))) r.classList.add('lifted');
  }
  shapeList.append(dropLine);
  aimRowDrag(rowDrag, y);
}

/**
 * Keep the pointer reporting to the list once the drag has begun.
 *
 * Without capture, a pointer that leaves the list stops sending it moves, and
 * the drag freezes with the line wherever the pointer crossed the edge -- while
 * the release, delivered somewhere else entirely, never ends it at all.
 */
function captureRow(pointerId: number): void {
  try {
    shapeList.setPointerCapture(pointerId);
  } catch {
    // A pointer that has already gone. Nothing to capture and nothing to say.
  }
}

/** The `ListRow` a DOM row stands for, which is what the selection helpers take. */
function rowOf(li: HTMLElement): ListRow {
  const group = li.getAttribute('data-group');
  if (group) return { id: group, sp: null, group: true };
  return { id: li.getAttribute('data-id') ?? '', sp: null, group: false };
}

shapeList.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || renaming) return;
  const target = e.target as HTMLElement;
  // The disclosure triangle and the rename box own their own presses, and a
  // modifier means the press is extending a selection rather than moving one.
  if (target.closest('.twist') || target.closest('.rename')) return;
  if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
  /* A path row carries its shape's `data-id` and sits inside the shape's own
     row, so `closest` would read a press on a path as a press on the shape.
     A path is not a thing paint order holds. */
  if (target.closest('li.path')) return;
  const row = target.closest<HTMLElement>('li.shape, li.group');
  const key = row ? rowKey(row) : null;
  if (!key) return;

  disarm();
  const y = e.clientY;
  const id = e.pointerId;
  armed = {
    key,
    y,
    pointer: e.pointerId,
    /* A finger that stays put means to move the row; one that travels means to
       scroll the list, which is why touch waits and a mouse does not. */
    timer:
      e.pointerType === 'touch'
        ? window.setTimeout(() => {
            beginRowDrag(key, y);
            if (rowDrag) captureRow(id);
          }, ROW_HOLD_MS)
        : 0,
  };
});

shapeList.addEventListener('pointermove', (e) => {
  if (rowDrag) {
    e.preventDefault();
    aimRowDrag(rowDrag, e.clientY);
    return;
  }
  if (!armed || e.pointerId !== armed.pointer) return;
  if (Math.abs(e.clientY - armed.y) < ROW_SLOP) return;
  // A finger past the slop is scrolling, so it gives up its hold rather than
  // starting a drag it did not ask for.
  if (e.pointerType === 'touch') {
    disarm();
    return;
  }
  const { key, y } = armed;
  disarm();
  beginRowDrag(key, y);
  if (!rowDrag) return;
  captureRow(e.pointerId);
  aimRowDrag(rowDrag, e.clientY);
});

/** Set by a drag that ended, and read by the click that follows it. */
let dragged = false;

const endRowDrag = (drop: boolean): void => {
  disarm();
  const d = rowDrag;
  rowDrag = null;
  if (!d) return;
  for (const r of d.rows) r.classList.remove('lifted');
  dropLine.remove();
  dragged = true;
  if (!drop) return;
  /* The first row at or after the gap that is NOT being dragged. `dropShapes`
     looks its key up among the rows that are STAYING, so naming a row that is
     itself moving finds nothing, and the not-found fallback drops the selection
     at the end of the list. Aiming at a lifted row's own edge -- which is what
     a drag of a few pixels does -- therefore sent the selection to the front of
     the paint order instead of leaving it where it was, in one undoable step
     that looked like a real reorder. `null` means the end, which is what it
     already meant when the gap was past the last row. */
  let at = d.at;
  while (at < d.rows.length && d.rows[at].classList.contains('lifted')) at++;
  const before = at < d.rows.length ? rowKey(d.rows[at]) : null;
  commands.dropSelection(d.parent, before);
};

shapeList.addEventListener('pointerup', () => endRowDrag(true));
shapeList.addEventListener('pointercancel', () => endRowDrag(false));
/* A press that became a drag must not also arrive as a click, or the row now
   under the pointer takes the selection the drag just moved. Captured, so it
   never reaches the handler above rather than being undone by it. */
shapeList.addEventListener(
  'click',
  (e) => {
    if (!dragged) return;
    dragged = false;
    e.stopPropagation();
  },
  true,
);

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
on('#groupShapes', () => commands.groupSelection());
on('#ungroupShapes', () => commands.ungroupSelection());
on('#selectGroup', () => commands.selectGroup());
on('#repeatTransform', () => commands.repeatTransform());
on('#copySel', () => commands.copySelection());
on('#cutSel', () => commands.cutSelection());
on('#pasteSel', () => commands.paste());

/* --------------------------------------------------------------- combine */

const boolInfo = $('#boolinfo');
const boolBtns = [...document.querySelectorAll<HTMLButtonElement>('[data-bool]')];

for (const b of boolBtns) {
  b.addEventListener('click', () => {
    const r = commands.booleanSelection(b.getAttribute('data-bool') as BooleanOp);
    say(r.message, r.ok);
  });
}

const makeOneBtn = $('#makeone') as HTMLButtonElement;
makeOneBtn.addEventListener('click', () => {
  const r = commands.makeOneShape();
  say(r.message, r.ok);
});

const splitBtn = $('#splitshape') as HTMLButtonElement;
splitBtn.addEventListener('click', () => {
  const r = commands.splitShapes();
  say(r.message, r.ok);
});

function refreshCombine(): void {
  const n = store.state.selection.shapes.size;
  /* Not the shape count any more: two paths of one shape are operands too, and
     `canBoolean` is the one place that decides which of the two readings the
     selection is asking for. */
  for (const b of boolBtns) b.disabled = !commands.canBoolean;
  /* Still the shape count. Make one shape moves whole shapes into one, and the
     paths of one shape are already in one. */
  makeOneBtn.disabled = n < 2;
  /* A different requirement, so a different state. Split needs one shape that
     holds more than one path, which one selected shape can satisfy and four
     selected shapes can fail. Tying it to the count would offer it where it
     does nothing and withhold it where it works. */
  splitBtn.disabled = !commands.canSplitShapes;
  boolInfo.textContent =
    n >= 2 ? `${n} shapes` : commands.canBoolean ? 'paths of one shape' : 'needs 2+';
}

/**
 * Which shape's name is being edited, if any.
 *
 * The list is rebuilt from scratch on every notification, which would destroy
 * an open input mid-keystroke -- so while a rename is in flight the rebuild is
 * skipped entirely, the same guard the source box and the coordinate fields use.
 */
let renaming: string | null = null;

function startRename(id: string, isGroup = false): void {
  /* A group is renamed the same way and for the same reason: its name is what the
     exported `<g id>` carries, so it is the only thing about a group there is to
     edit. */
  const target = isGroup
    ? findGroup(store.state.doc, id)
    : store.state.doc.shapes.find((sh) => sh.id === id);
  // Deliberately NOT the element the event carried: the two clicks that make up
  // a double-click each select the shape, each notifies, and the list is rebuilt
  // from scratch every time -- so by now that element is detached, and editing
  // it would put the input somewhere no longer in the document.
  /* `> .nm`, because a shape's `li` now contains the rows for its paths and each
     of those carries a `.nm` of its own, and a group's holds every row inside it. */
  const nm = isGroup
    ? shapeList.querySelector(`li.group[data-group="${id}"] > .nm`)
    : shapeList.querySelector(`li.shape[data-id="${id}"] > .nm`);
  if (!target || !nm) return;
  const shape = target;

  renaming = id;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rename';
  input.value = shape.name;
  input.setAttribute('aria-label', isGroup ? 'Group name' : 'Shape name');
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
        const it = isGroup ? findGroup(st.doc, id) : st.doc.shapes.find((x) => x.id === id);
        if (it) it.name = name;
      });
      // The name is what the exported `id` carries, and an id is an XML Name --
      // so say when the export will not read back exactly as typed.
      const safe = xmlId(name);
      say(safe === name ? `Renamed to ${name}.` : `Renamed to ${name}. Exports as id="${safe}".`, true);
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
  const groupId = li?.getAttribute('data-group');
  if (groupId) {
    if (!renaming) startRename(groupId, true);
    return;
  }
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
  /** A shape id, or a group id when `group` is true. */
  id: string;
  sp: number | null;
  group?: boolean;
}

/**
 * The DOM id of the element a row is drawn as.
 *
 * One function, called both where the rows are built and where
 * `aria-activedescendant` names one of them, because a name that has to agree
 * with itself across two files agrees until somebody edits one of them.
 *
 * The prefix keeps these out of the way of the ids in `index.html`: a shape id
 * is `prefix-n` from `nextId`, and nothing stops a document from holding a
 * shape whose id spells a control's.
 */
const rowDomId = (row: ListRow): string => `row-${row.id}${row.sp === null ? '' : `-p${row.sp}`}`;

/**
 * The rows in the order they are drawn, with anything shut left out.
 *
 * Walked over `doc.shapes` in paint order rather than over the groups, because that
 * array *is* the order and a group's place in it is the place of the shapes in it.
 * A group opens when its first shape is reached, which is well defined precisely
 * because a group's shapes are contiguous.
 */
function visibleRows(): ListRow[] {
  const doc = store.state.doc;
  const out: ListRow[] = [];
  let open: string[] = [];
  for (const sh of doc.shapes) {
    const chain = groupChain(doc, sh.group)
      .map((g) => g.id)
      .reverse();
    let shared = 0;
    while (shared < open.length && shared < chain.length && open[shared] === chain[shared]) shared++;
    open = chain;
    // A shut group hides everything below it, itself included in nothing further.
    let hidden = false;
    for (let i = 0; i < chain.length; i++) {
      if (hidden) break;
      if (i >= shared) out.push({ id: chain[i], sp: null, group: true });
      if (!expanded.has(chain[i])) hidden = true;
    }
    if (hidden) continue;

    out.push({ id: sh.id, sp: null });
    if (sh.subpaths.length > 1 && expanded.has(sh.id)) {
      sh.subpaths.forEach((_, i) => out.push({ id: sh.id, sp: i }));
    }
  }
  return out;
}

/** Every shape a row stands for: one, or all of a group's. */
function rowShapes(row: ListRow): string[] {
  if (!row.group) return [row.id];
  return shapesInGroup(store.state.doc, row.id).map((sh) => sh.id);
}

/**
 * Which row the selection last landed on, or -1.
 *
 * A group row wins over the shape rows inside it when every one of them is selected,
 * because that is the selection a press on the group row makes and arrowing on from
 * it should leave the group rather than walk its contents.
 */
function rowAtCursor(rows: ListRow[]): number {
  const s = store.state;
  const shapes = [...s.selection.shapes];
  const last = shapes[shapes.length - 1];
  if (last !== undefined) {
    const whole = rows.findIndex(
      (r) => r.group && groupIsSelected(r.id) && rowShapes(r).includes(last),
    );
    if (whole >= 0) return whole;
    return rows.findIndex((r) => !r.group && r.sp === null && r.id === last);
  }
  /* No shape selected, so look for a path whose nodes are all selected. Read
     rather than remembered, so arrowing on from a path row selected by a click
     starts where the click left off. */
  return rows.findIndex((r) => {
    if (r.sp === null) return false;
    const sp = findShape(s.doc, r.id)?.subpaths[r.sp];
    return !!sp && pathIsSelected(sp, s.selection);
  });
}

/**
 * Whether a group reads as selected: every shape in it is.
 *
 * Derived rather than stored, so it cannot disagree with the shapes. §49.
 */
function groupIsSelected(id: string): boolean {
  const ids = shapesInGroup(store.state.doc, id);
  return ids.length > 0 && ids.every((sh) => store.state.selection.shapes.has(sh.id));
}

/** Select one row, replacing the selection or adding to it. */
function selectRow(row: ListRow, additive: boolean): void {
  if (row.sp !== null) {
    selectPath(row.id, row.sp, additive);
    return;
  }
  const ids = rowShapes(row);
  store.update((st) => {
    if (!additive) {
      st.selection.shapes.clear();
      st.selection.nodes.clear();
      for (const id of ids) st.selection.shapes.add(id);
      return;
    }
    // A group toggles as a whole, so Shift on a lit group row puts all of it out.
    const on = ids.every((id) => st.selection.shapes.has(id));
    for (const id of ids) {
      if (on) st.selection.shapes.delete(id);
      else st.selection.shapes.add(id);
    }
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

  /* Right opens a shut row and steps into an open one; Left shuts an open row and
     steps out of it. The standard tree bindings, and the only way to reach a group's
     contents or a shape's paths without a pointer. */
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    const row = at >= 0 ? rows[at] : rows[0];
    if (!row) return;
    e.preventDefault();
    const open = expanded.has(row.id);
    /* What "has something to open" means depends on the row: a group always does,
       and a shape does only when it holds more than one path. */
    const opens = row.group || (findShape(store.state.doc, row.id)?.subpaths.length ?? 0) > 1;

    if (e.key === 'ArrowRight') {
      if (row.sp !== null) return; // already as deep as the tree goes
      if (opens && !open) setExpanded(row.id, true);
      else if (opens) {
        // Into it: the row after this one is its first child, by construction.
        const next = rows[rows.indexOf(row) + 1];
        if (next) selectRow(next, false);
      }
      return;
    }
    if (row.sp !== null) {
      selectRow({ id: row.id, sp: null }, false);
      return;
    }
    if (open) {
      setExpanded(row.id, false);
      return;
    }
    /* Out to whatever holds it. Nothing to shut and nowhere to go is the top of the
       tree, where Left is a press that correctly does nothing. */
    const holder = row.group
      ? findGroup(store.state.doc, row.id)?.parent
      : findShape(store.state.doc, row.id)?.group;
    if (holder) selectRow({ id: holder, sp: null, group: true }, false);
    return;
  }

  if (e.key === 'F2' || e.key === 'Enter') {
    e.preventDefault();
    /* With nothing selected, take the first. The route existed and had a dead
       first step: Tab reaches the list on the very first press, and F2 there
       did nothing until an arrow key had chosen a row -- which reads as the
       key not working rather than as a precondition. */
    const row = at >= 0 ? rows[at] : rows[0];
    if (!row) return;
    // A path has no name. Renaming the shape it sits in would answer a question
    // nobody asked, so the shape is selected instead and named on the next press.
    if (at < 0 || row.sp !== null) selectRow({ id: row.id, sp: null, ...(row.group ? { group: true } : {}) }, false);
    if (row.sp !== null) return;
    startRename(row.id, row.group === true);
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
        /* The chain of groups above the shape, by name and by open state. A group's
           row exists because a shape in it exists, so what the list draws changes
           when a shape's chain does -- and grouping moves no geometry, so nothing
           else here would notice. */
        groupChain(store.state.doc, sh.group)
          .map((g) => `${g.id}:${g.name}:${expanded.has(g.id) ? 'open' : 'shut'}`)
          .join('>'),
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
 * Groups the list has already drawn once.
 *
 * A group appears open the first time it appears, and remembers being shut after
 * that. Shut by default would mean that grouping two shapes made them vanish from
 * the list, which reads as having lost them rather than as having grouped them; and
 * a rule of "always open" would reopen everything on the next unrelated edit.
 */
const seenGroups = new Set<string>();

/** Open any group nobody has seen yet. Returns whether that changed anything. */
function openNewGroups(): boolean {
  let fresh = false;
  for (const g of store.state.doc.groups ?? []) {
    if (seenGroups.has(g.id)) continue;
    seenGroups.add(g.id);
    expanded.add(g.id);
    fresh = true;
  }
  return fresh;
}

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

  // Before the signature is taken, since opening a group changes what it should be.
  openNewGroups();
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
    // The row it named has just been removed, and a dangling reference is read
    // as an empty name rather than as no name.
    shapeList.removeAttribute('aria-activedescendant');
    return;
  }

  /* A stack of containers, so the nesting the accessibility tree reads is the DOM's
     own and not an indent that looks like one. `at[0]` is the list; a group pushes
     the `<ul>` it owns and its last shape pops it.

     Walked over `doc.shapes` in paint order, opening a group when its first shape is
     reached. That is well defined only because a group's shapes are contiguous,
     which is the invariant `groupSelection` maintains and §49 argues for. */
  let at: HTMLElement[] = [shapeList];
  let open: string[] = [];

  for (const sh of s.doc.shapes) {
    const chain = groupChain(s.doc, sh.group)
      .map((g) => g.id)
      .reverse();
    let shared = 0;
    while (shared < open.length && shared < chain.length && open[shared] === chain[shared]) shared++;
    at = at.slice(0, shared + 1);
    for (let i = shared; i < chain.length; i++) {
      const g = findGroup(s.doc, chain[i]);
      if (!g) continue;
      const row = document.createElement('li');
      row.className = 'group';
      row.id = rowDomId({ id: g.id, sp: null, group: true });
      row.setAttribute('role', 'treeitem');
      row.setAttribute('aria-level', String(i + 1));
      row.setAttribute('data-group', g.id);
      const isOpen = expanded.has(g.id);
      row.setAttribute('aria-expanded', String(isOpen));

      const gt = document.createElement('button');
      gt.type = 'button';
      gt.className = 'twist';
      gt.textContent = '▸';
      gt.setAttribute('aria-expanded', String(isOpen));
      const held = shapesInGroup(s.doc, g.id).length;
      gt.setAttribute('aria-label', `${isOpen ? 'Hide' : 'Show'} the ${held} shapes in ${g.name}`);

      const gn = document.createElement('span');
      gn.className = 'nm';
      gn.textContent = g.name;

      const gc = document.createElement('span');
      gc.className = 'ct';
      gc.textContent = `${held} ${held === 1 ? 'shape' : 'shapes'}`;

      row.append(gt, gn, gc);
      at[at.length - 1].append(row);

      /* A shut group draws its own row and nothing under it, which means not pushing
         a container for the rows that would go there. The depth check below reads
         `at` rather than `chain` for exactly this: a stack shorter than the chain is
         how it knows a group above this shape is shut. */
      if (!isOpen) break;

      const kids = document.createElement('ul');
      kids.setAttribute('role', 'group');
      row.append(kids);
      at.push(kids);
    }
    open = chain;

    /* Inside a shut group: the row for this shape is not drawn at all. Reading the
       depth back off the stack rather than off `chain`, because the loop above stops
       pushing at the first group that is shut. */
    if (at.length - 1 < chain.length) continue;

    const li = document.createElement('li');
    li.className = 'shape';
    li.id = rowDomId({ id: sh.id, sp: null });
    li.setAttribute('data-id', sh.id);
    /* `aria-selected` is ignored on a plain list item, so the visual state and
       the announced state disagreed. A treeitem is the role that carries it, and
       the role a shape holding paths needs anyway. */
    li.setAttribute('role', 'treeitem');
    li.setAttribute('aria-level', String(chain.length + 1));

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
        row.id = rowDomId({ id: sh.id, sp: i });
        row.setAttribute('role', 'treeitem');
        row.setAttribute('aria-level', String(chain.length + 2));
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

    at[at.length - 1].append(li);
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
  for (const row of shapeList.querySelectorAll<HTMLElement>('li.group')) {
    row.setAttribute('aria-selected', String(groupIsSelected(row.getAttribute('data-group')!)));
  }
  for (const row of shapeList.querySelectorAll<HTMLElement>('li.path')) {
    const shape = findShape(s.doc, row.getAttribute('data-id')!);
    const sp = shape?.subpaths[Number(row.getAttribute('data-sp'))];
    row.setAttribute('aria-selected', String(!!sp && pathIsSelected(sp, s.selection)));
  }
  markActiveRow();
}

/**
 * Which row the tree reports as the one the keyboard is on.
 *
 * The list is one tab stop with arrows moving inside it, and that pattern is
 * only half built without this: `aria-selected` says which rows are in the
 * selection and nothing said which of them the arrows would move from, so a
 * screen reader announced the list on entry and then nothing at all as the
 * cursor walked it.
 *
 * The row is `rowAtCursor`'s, the same answer the arrow keys act on, so the two
 * cannot come apart. Scrolled into view only while the list holds focus,
 * because a selection made on the canvas moves this too and must not yank the
 * panel about under a pointer.
 */
function markActiveRow(): void {
  const rows = visibleRows();
  const at = rowAtCursor(rows);
  if (at < 0) {
    shapeList.removeAttribute('aria-activedescendant');
    return;
  }
  const id = rowDomId(rows[at]);
  shapeList.setAttribute('aria-activedescendant', id);
  if (!shapeList.contains(document.activeElement)) return;
  document.getElementById(id)?.scrollIntoView({ block: 'nearest' });
}

/* ------------------------------------------------------------ live readout */

const stats = $('#stats');
const selinfo = $('#selinfo');
const gridval = $('#gridval');
const gridreadout = $('#gridreadout');
const fillruleinfo = $('#fillruleinfo');
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
  refreshPreview();

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
      e.style.fillRule === shown.fillRule &&
      e.style.opacity === shown.opacity,
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
  /* Rounded on the way to the box and not in the model: an imported 0.333 is
     33% here and stays 0.333 in the file, so reading the panel never rewrites
     a number nobody touched. */
  if (document.activeElement !== opacityInput) {
    opacityInput.value = String(Math.round(shown.opacity * 100));
  }
  for (const b of $('#fillRule').querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.getAttribute('data-fr') === shown.fillRule));
  }
  // On the collapsed header, so the setting reads without being opened.
  fillruleinfo.textContent = shown.fillRule === 'evenodd' ? 'even-odd' : 'nonzero';

  const poly = s.polygon;
  for (const b of $('#polyKind').querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String((b.getAttribute('data-pk') === 'star') === poly.star));
  }
  /* Hidden rather than disabled while Star is off: a disabled number is a
     control that looks like it has something to say, and the inner radius has
     nothing to say about a polygon. */
  polyRatioRow.hidden = !poly.star;
  if (document.activeElement !== polyCorners) polyCorners.value = String(poly.corners);
  if (document.activeElement !== polyRatio) polyRatio.value = String(Math.round(poly.ratio * 100));
  $('#polyinfo').textContent = poly.star
    ? `${poly.corners}-point star`
    : `${poly.corners} sides`;

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
  /* On the body rather than on `#app`, because the class has to reach the rail
     and everything else the panel may grow later, and `#app` is not the only
     ancestor those share. */
  document.body.classList.toggle('touchbtns', s.touchButtons);
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
    say('Select a node first.', false);
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
    say('That node has no command of its own: the path closes onto it.', false);
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
  say(`Node ${ref.sp}/${ref.i} is the ${text.slice(mark.start, mark.end).trim().split(/\s/)[0]} at character ${mark.start}.`, true);
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
 * Session state: which groups are open is how you are working, so it is not in
 * the store, the history, or storage.
 *
 * `hidden` takes a shut group's controls out of the tab order as well as off
 * the screen, so it costs one Tab stop rather than however many it holds.
 * `tools/keys.mjs` checks nothing became unreachable. §41.
 */
for (const head of document.querySelectorAll<HTMLButtonElement>('button.glabel')) {
  /* By relationship, not by position. This read `head.nextElementSibling`, which
     was true only while the header was the body's immediate sibling, and stopped
     being true the moment the header gained a `?` beside it in a `.ghead`. */
  const body = head.closest('.group')?.querySelector<HTMLElement>(':scope > .gbody') ?? null;
  if (!body) continue;
  /* Open where the group acts on what is selected, shut otherwise. Everything
     shut is an empty rail and everything open is what we already had. File is
     the exception: it acts on nothing selected, and it is where the drawing
     leaves the editor, so landing on the Document tab and finding every group
     shut would put Download SVG two presses from anywhere. */
  const group = head.closest('.group');
  const keepOpen = ['Style', 'Node', 'Shapes', 'File'].includes(head.querySelector('span')?.textContent ?? '');
  const set = (open: boolean): void => {
    head.setAttribute('aria-expanded', String(open));
    body.hidden = !open;
  };
  set(keepOpen);
  head.addEventListener('click', () => set(head.getAttribute('aria-expanded') !== 'true'));
  void group;
}

/**
 * The `?` beside a group's name, which discloses the sentence explaining it.
 *
 * Those sentences were 573 px of the rail across the three tabs, permanently on
 * screen, and every one of them is read once. They are not deleted, because the
 * manual does not carry most of them and the build is one file that opens from
 * `file://` with no manual to link to. So they are hidden and one press away.
 *
 * A press, never a hover: a tooltip may enrich and must never inform, and this
 * is the only place several of these facts are written down.
 */
for (const help of document.querySelectorAll<HTMLButtonElement>('button.ghelp')) {
  const id = help.getAttribute('aria-controls');
  const hint = id ? document.getElementById(id) : null;
  if (!hint) continue;
  help.addEventListener('click', () => {
    const open = help.getAttribute('aria-expanded') !== 'true';
    help.setAttribute('aria-expanded', String(open));
    hint.hidden = !open;
  });
}

installTooltips();

sessions.onState = refreshSaveState;
refreshSaveState();

requestAnimationFrame(() => {
  store.update((s) => {
    s.camera = fitAspect(s.camera, canvas.overlay);
  });
  /* A restored camera is where somebody left the view, so fitting the drawing
     over the top of it would throw away the one piece of the session that took
     a gesture to set. The aspect correction above still runs, because the
     window is a different shape from the one that saved it. */
  if (!restored) fit();
  if (opening) say(opening.message, opening.ok);
});
