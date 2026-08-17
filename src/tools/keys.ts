/**
 * What every key does.
 *
 * Every operation here also has a button in `main.ts`, because a shortcut is
 * the fast path to an operation and never the only way to reach one. The two
 * lists have to be read against each other, which is why this is a file of its
 * own rather than a method on either object it drives.
 *
 * Three destinations, and which one a key takes is the whole of the routing: a
 * key that ends a gesture goes through `Controller`, a key that changes the
 * document goes through `Commands`, and the tool letters are plain state.
 * §44 of `docs/ARCHITECTURE.md` has the argument for the boundary.
 */

import { emptySelection } from '../model/doc';
import type { Pt } from '../core/types';
import type { Store } from '../model/store';
import type { Commands } from './commands';
import type { Controller } from './controller';

/**
 * Whether a control holds text somebody could be midway through typing.
 *
 * The line matters for one chord. Text carries its own edit history, so
 * `Ctrl`+`Z` inside the source box or a shape's name is that text's undo and
 * never the document's. A number, a colour or a checkbox carries no history of
 * its own: every change one of them makes is already a single entry in the
 * document's history, so there the document's undo *is* the field's undo.
 */
function typingText(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement) return true;
  return target instanceof HTMLInputElement && target.type === 'text';
}

/** Attach the keyboard. Returns nothing: nothing detaches it for the life of the page. */
export function bindKeys(store: Store, controller: Controller, commands: Commands): void {
  const onKeyDown = (e: KeyboardEvent): void => {
    const mod = e.ctrlKey || e.metaKey;
    const undoKey = mod && e.key.toLowerCase() === 'z';

    /* A control consumes the keys it could be using: typing `v` into a name must
       not also switch to the select tool, and `Delete` in a spinner must not
       delete the selected nodes.

       Undo is the exception, which is why this is not one `return`. The rail is
       33 numbers, two colours and 21 checkboxes, none of which has an undo of
       its own, so a Ctrl+Z swallowed here is a Ctrl+Z that does nothing in the
       moment right after typing a value -- which is the moment it is most
       wanted. `typingText` names the controls that do own the chord. */
    const tag = (e.target as HTMLElement | null)?.tagName;
    const inControl = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    if (inControl && (typingText(e.target) || !undoKey)) return;

    /* Somebody nearer the event has already claimed this key. The inspector's
       tab strip and its shape list both handle the arrows and both call
       `preventDefault`, and this listener is on the window, so without this
       line arrowing through the shape list also nudged the drawing one grid
       step per press. */
    if (e.defaultPrevented) return;

    if (e.code === 'Space') {
      controller.holdSpace(true);
      return;
    }

    if (undoKey) {
      e.preventDefault();
      // Undoing mid-drag pops the checkpoint the drag is standing on, and the
      // gesture then rolls back somebody else's edit when it ends.
      if (controller.busy) return;
      /* Leaving the field first is what makes a mistyped number one press away
         from the value it replaced. A field commits on blur, so this files the
         pending edit and the undo below takes that edit back; a field nobody
         typed into commits nothing and the undo reaches past it. Undoing with
         focus still inside would roll the document back while the field kept
         uncommitted text, and that text would land again as soon as focus left. */
      if (inControl && e.target instanceof HTMLElement) e.target.blur();
      if (e.shiftKey) store.redo();
      else store.undo();
      return;
    }

    /* The clipboard. Cut and paste rewrite the document, so both are refused
       mid-drag for the reason the `rewrites` list below refuses its keys; copy
       reads and is always safe. Alt is excluded because Ctrl+Alt+letter is how
       several keyboard layouts type a character, and swallowing those would make
       the editor eat text it has no business seeing. */
    if (mod && !e.altKey && 'cxv'.includes(e.key.toLowerCase())) {
      e.preventDefault();
      const k = e.key.toLowerCase();
      if (k === 'c') commands.copySelection();
      else if (controller.busy) commands.onMessage?.('Finish the drag first.', false);
      else if (k === 'x') commands.cutSelection();
      else commands.paste();
      return;
    }

    /* Everything below is a bare key, with one exception. Ctrl+E belongs to the
       source drawer and Ctrl+R to the browser, and letting them through here
       switched the tool as a silent side effect of both. The arrows are the
       exception because Ctrl gives them a second meaning of their own: bend
       rather than nudge. Guarding them out too made that branch unreachable and
       quietly retired a documented shortcut. */
    if (mod && !e.key.startsWith('Arrow')) return;

    /* An operation that rewrites the document is refused while a drag is live,
       for the reason §16 refuses undo there: the drag holds node indices into
       an array the operation is about to splice, its edit folds silently into
       the drag's batch, and Escape then rolls back both with no redo. Delete
       had this hole from the beginning and Shift+F, Shift+B, Shift+J and
       Shift+M all widened it. Escape and Enter are deliberately still allowed
       -- ending a gesture is exactly what they are for.

       Every document operation below is a Shift+letter and so arrives as a
       capital, and every capital below is a document operation; the lower-case
       keys switch tools and touch nothing the drag is holding. Shift+P and
       Shift+K were added to the switch without joining this list, which is
       what `keyboard guard` in `test/controller.test.ts` now watches for. */
    const rewrites = [
      'Delete', 'Backspace',
      'A', 'B', 'C', 'F', 'I', 'J', 'K', 'M', 'P', 'R', 'S', 'Y',
    ];
    if (controller.busy && rewrites.includes(e.key)) {
      e.preventDefault();
      commands.onMessage?.('Finish the drag first.', false);
      return;
    }

    switch (e.key) {
      case 'Delete':
      case 'Backspace': {
        e.preventDefault();
        commands.deleteSelection();
        return;
      }
      case 'Escape': {
        // Abandoning a drag rolls back to the checkpoint it opened, which is
        // what genuinely leaves no trace of it in history. Not `undo`: that
        // leaves the abandoned shape on the redo stack. Every drag kind comes
        // through here, so Escape never falls past this into clearing the
        // selection while a drag is still running.
        if (controller.busy) {
          controller.abortDrag();
          return;
        }
        controller.finishPen();
        store.update((st) => (st.selection = emptySelection()));
        return;
      }
      case 'Enter': {
        controller.finishPen();
        return;
      }
      // Shift+B, the same binding Inkscape uses. Matched on the capital so it
      // cannot fire from a bare `b`.
      case 'B': {
        if (!e.shiftKey) return;
        e.preventDefault();
        commands.breakAtSelection();
        return;
      }
      /* `[` and `]` walk the node selection along the path, with Shift to
         extend. Without them the Node panel is pointer-only: every control in it
         is reachable by Tab and every one acts on selected nodes, so a selection
         that only a click can make strands the whole panel. */
      case '[':
      case ']':
      // With Shift held the browser reports the shifted character, so the
      // extend form arrives as a brace and never as a bracket.
      case '{':
      case '}': {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        e.preventDefault();
        const forward = e.key === ']' || e.key === '}';
        commands.stepNodeSelection(forward ? 1 : -1, e.shiftKey);
        return;
      }
      // Shift+I, the keyboard's version of double-clicking an outline.
      case 'I': {
        if (!e.shiftKey) return;
        e.preventDefault();
        commands.insertInSelection();
        return;
      }
      /* Shift+A, beside the three continuity keys. Ctrl+A is select-all in
         every browser, so the plain letter was never available. */
      case 'A': {
        if (!e.shiftKey) return;
        e.preventDefault();
        commands.setSelectedAuto();
        return;
      }
      // Shift+R, which is Inkscape's binding for the same thing.
      case 'R': {
        if (!e.shiftKey) return;
        e.preventDefault();
        commands.reverseSelection();
        return;
      }
      /* Shift+C, Shift+S and Shift+Y set a node's continuity outright, which
         double-clicking an anchor already cycles through. A cycle is fine for
         one node and no use for forty: it depends on where each of them
         started, so the same three double-clicks leave a mixed selection still
         mixed. These say which one you want. */
      case 'C':
      case 'S':
      case 'Y': {
        if (!e.shiftKey) return;
        e.preventDefault();
        commands.setSelectedContinuity(e.key === 'C' ? 'corner' : e.key === 'S' ? 'smooth' : 'symmetric');
        return;
      }
      // Shift+J spans the gap; Shift+M welds. Inkscape uses Shift+J for the
      // weld, but "join" reads as "draw the missing line" to anyone who has not
      // memorised Inkscape, and that is the non-destructive one.
      case 'J': {
        if (!e.shiftKey) return;
        e.preventDefault();
        commands.joinSelection('connect');
        return;
      }
      case 'M': {
        if (!e.shiftKey) return;
        e.preventDefault();
        commands.joinSelection('merge');
        return;
      }
      // Shift+F welds two adjacent nodes anywhere along a path, where Shift+M
      // only ever welds two free ends.
      case 'F': {
        if (!e.shiftKey) return;
        e.preventDefault();
        commands.fuseSelection();
        return;
      }
      /* Shift+P rather than TikZiT's Ctrl+P, which the browser has already
         taken for printing and will not give back from a page. It also joins
         the family every other path operation is already in. */
      case 'P': {
        if (!e.shiftKey) return;
        e.preventDefault();
        const r = commands.makeOneShape();
        commands.onMessage?.(r.message, r.ok);
        return;
      }
      /* Shift+K for the inverse. Inkscape puts Break Apart on Ctrl+Shift+K,
         and the letter is the only part of that worth borrowing: Shift+S is
         already smooth continuity, and every other operation here is Shift and
         a letter. */
      case 'K': {
        if (!e.shiftKey) return;
        e.preventDefault();
        const r = commands.splitShapes();
        commands.onMessage?.(r.message, r.ok);
        return;
      }
      case 'v': {
        store.update((st) => (st.tool = 'select'));
        controller.finishPen();
        return;
      }
      case 'p': {
        store.update((st) => (st.tool = 'pen'));
        return;
      }
      case 'h': {
        store.update((st) => (st.tool = 'hand'));
        controller.finishPen();
        return;
      }
      case 'e': {
        store.update((st) => (st.tool = 'ellipse'));
        controller.finishPen();
        return;
      }
      case 'r': {
        store.update((st) => (st.tool = 'rect'));
        controller.finishPen();
        return;
      }
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown': {
        e.preventDefault();
        // Ctrl turns the arrows into curve controls rather than nudges:
        // left/right bend, up/down tighten or loosen.
        if (mod) {
          const seg = commands.activeSegment();
          if (!seg) return;
          const step = e.shiftKey ? 1 : 5;
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            commands.adjustBend(e.key === 'ArrowRight' ? step : -step, 0);
          } else {
            commands.adjustBend(0, e.key === 'ArrowUp' ? 0.1 : -0.1);
          }
          return;
        }
        const s = store.state;
        const step = (e.shiftKey ? s.nudgeBig || 1 : 1) * (s.gridStep || 1);
        const d: Pt = [
          e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0,
          e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0,
        ];
        commands.nudge(d);
        return;
      }
    }
  };

  const onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === 'Space') controller.holdSpace(false);
  };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
}
