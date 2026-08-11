/**
 * Wiring: document -> store -> canvas -> controller, plus the panels.
 */

import './ui/styles.css';
import { PathSyntaxError } from './core/parse';
import { exportPathData, exportSvg, importSvg, xmlId } from './io/svg';
import type { BooleanOp } from './io/boolean';
import { docBBox, emptyDoc, nextId, parseNodeKey, shapeFromPath } from './model/doc';
import { latentHandle, transformShape } from './model/ops';
import { translate } from './core/affine';
import { cloneShape, continuityOf } from './core/types';
import type { Shape } from './core/types';
import { serialisePath } from './core/serialise';
import { Store } from './model/store';
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
const canvas = new Canvas($('#canvas'));
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

function setPanel(which: 'src' | 'rail', open: boolean): void {
  if (which === 'src') {
    app.classList.toggle('src-open', open);
    toggleSrcBtn.setAttribute('aria-pressed', String(open));
  } else {
    app.classList.toggle('no-rail', !open);
    toggleRailBtn.setAttribute('aria-pressed', String(open));
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

/* ------------------------------------------------------------------ tools */

const TOOLS = ['select', 'pen', 'ellipse', 'rect'] as const;
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

on('#undo', () => store.undo());
on('#redo', () => store.redo());
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

const bindCheck = (id: string, key: 'showGrid' | 'snapToGrid' | 'snapToPoints' | 'showHandles' | 'filled' | 'minify'): void => {
  const input = $(id) as HTMLInputElement;
  input.checked = store.state[key];
  input.addEventListener('change', () => store.update((s) => ((s[key] as boolean) = input.checked)));
};
bindCheck('#showGrid', 'showGrid');
bindCheck('#snapGrid', 'snapToGrid');
bindCheck('#snapPoints', 'snapToPoints');
bindCheck('#showHandles', 'showHandles');
bindCheck('#filled', 'filled');
bindCheck('#minify', 'minify');

const gridInput = $('#gridStep') as HTMLInputElement;
gridInput.value = String(store.state.gridStep);
gridInput.addEventListener('input', () =>
  store.update((s) => (s.gridStep = Math.max(0, Number(gridInput.value) || 0))),
);

const radiusInput = $('#cornerRadius') as HTMLInputElement;
radiusInput.value = String(store.state.cornerRadius);
radiusInput.addEventListener('input', () =>
  store.update((s) => (s.cornerRadius = Math.max(0, Number(radiusInput.value) || 0))),
);

on('#circularise', () => controller.circulariseSelection());

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
    if (r.shapes.length === 0) {
      status.textContent = 'Nothing to import.';
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

/* ------------------------------------------------------------ shape list */

const shapeList = $('#shapelist');
const shapeCount = $('#shapecount');

shapeList.addEventListener('click', (e) => {
  const li = (e.target as HTMLElement).closest('li');
  const id = li?.getAttribute('data-id');
  if (!id) return;
  store.update((s) => {
    if (!(e as MouseEvent).shiftKey) {
      s.selection.shapes.clear();
      s.selection.nodes.clear();
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

function refreshCombine(): void {
  const n = store.state.selection.shapes.size;
  for (const b of boolBtns) b.disabled = n < 2;
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
    li.textContent = 'no shapes';
    shapeList.append(li);
    return;
  }

  for (const sh of s.doc.shapes) {
    const li = document.createElement('li');
    li.setAttribute('data-id', sh.id);
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
const outval = $('#outval');
const cursorEl = $('#cursor');
const undoBtn = $('#undo') as HTMLButtonElement;
const redoBtn = $('#redo') as HTMLButtonElement;

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

  const nodes = controller.countNodes();
  const segs = controller.countSegments();
  stats.textContent = `${s.doc.shapes.length} shape${s.doc.shapes.length === 1 ? '' : 's'} · ${nodes} nodes · ${segs} segments`;

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
  gridreadout.textContent = !s.gridStep ? 'off' : s.snapToGrid ? 'snapping' : 'drawn only';
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
  if (document.activeElement !== src) {
    const text = currentSource();
    if (src.value !== text) src.value = text;
    srcinfo.textContent = `${text.length} chars`;
  }
});

/* The pointer's position in document coordinates, which is the one number a
   grid editor should never make you guess. Written straight to the strip rather
   than through the store: it changes on every mouse move and has nothing to do
   with the document. */
canvas.overlay.addEventListener('pointermove', (e) => {
  const p = screenToDoc(canvas.overlay, e.clientX, e.clientY);
  const dp = Math.min(3, store.state.decimals);
  cursorEl.textContent = `${p[0].toFixed(dp)}, ${p[1].toFixed(dp)}`;
});
canvas.overlay.addEventListener('pointerleave', () => (cursorEl.textContent = ''));

/* -------------------------------------------------------------------- boot */

installTooltips();

requestAnimationFrame(() => {
  store.update((s) => {
    s.camera = fitAspect(s.camera, canvas.overlay);
  });
  fit();
});
