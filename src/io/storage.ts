/**
 * The session, written to `localStorage` so a reload does not lose the work.
 *
 * Everything here is about the two ways this fails, because the happy path is
 * one `setItem`.
 *
 * **Storage is not always there.** Opened from `file://`, Chromium gives the
 * page an opaque origin and every access to `localStorage` throws a
 * `SecurityError`; Firefox allows it. A build of this editor is one file you can
 * double-click, so that is not an edge case, it is half the audience. Every
 * access goes through a `try`, and the first failure latches: `blocked` is what
 * the interface reads to say the work is not being saved, rather than showing a
 * tick nothing is behind.
 *
 * **Storage is small.** The quota is a few megabytes and a drawing has no upper
 * bound. `save` measures the string before writing and refuses one that is too
 * big, which turns "your work stopped being saved twenty minutes ago" into a
 * sentence at the moment it stops.
 */

const KEY = 'path.session.v1';

/**
 * Written beside the session when a write is refused, and removed by the next
 * one that succeeds.
 *
 * A refused write leaves the previous copy in place, and that copy is a real
 * session from an earlier moment: nothing in it says it is not the drawing that
 * was on screen. Without this the next load announces a different drawing with
 * a sentence asserting it is the one you left.
 *
 * A separate key rather than a field inside the session, because the write that
 * would have carried the field is the write that did not happen. This one is a
 * dozen bytes, and the size refusal is decided before storage is touched, so
 * there is room for it exactly when it is needed.
 */
const STALE = `${KEY}.stale`;

/**
 * A drawing this size is not going in a few megabytes of quota with room to
 * spare, so refuse it while there is still something to say.
 *
 * Two under the smallest quota anyone ships, because the quota counts UTF-16
 * code units rather than bytes and everything else on the origin shares it.
 */
const LIMIT = 2_000_000;

export type Blocked = 'no-storage' | 'too-big' | null;

export class SessionStore {
  /** Why the last write did not happen, or `null` if it did. */
  blocked: Blocked = null;
  /**
   * Set when somebody has asked for the copy to be forgotten.
   *
   * A latch, not a stored preference: it lasts until the reload, which is when
   * a fresh start takes effect anyway. §59 of `docs/ARCHITECTURE.md` argues why
   * **Forget saved work** promises exactly that much and no more.
   */
  stopped = false;
  /**
   * Whether what `load` returned is older than the drawing that produced it.
   *
   * Read once, at startup, by the sentence that says the work came back. Only
   * ever true after a write was refused in an earlier session.
   */
  stale = false;
  /** Called after every write attempt, so the interface can say what happened. */
  onState: (() => void) | null = null;
  private timer: number | null = null;
  private pending: (() => string) | null = null;

  /**
   * Read what is there, or `null` for nothing and for a storage that refuses.
   *
   * The two are one answer on purpose. A caller that cannot restore has the same
   * work to do either way, and `blocked` is where the difference is recorded for
   * the one place that reports it.
   */
  load(): string | null {
    try {
      const text = window.localStorage.getItem(KEY);
      this.stale = text !== null && window.localStorage.getItem(STALE) !== null;
      return text;
    } catch {
      this.blocked = 'no-storage';
      return null;
    }
  }

  /** Write now. Returns whether it happened, and sets `blocked` when it did not. */
  save(text: string): boolean {
    const done = this.write(text);
    this.onState?.();
    return done;
  }

  /**
   * Say, beside the session, whether it still matches the drawing.
   *
   * Best effort by construction: it runs on the path where writing has just
   * failed, and a marker that cannot be written leaves exactly the behaviour
   * there was before it existed.
   */
  private mark(stale: boolean): void {
    try {
      if (stale) window.localStorage.setItem(STALE, '1');
      else window.localStorage.removeItem(STALE);
    } catch {
      /* Nothing to add: the caller has already recorded why storage refused. */
    }
  }

  private write(text: string): boolean {
    if (this.stopped) return false;
    if (text.length > LIMIT) {
      this.blocked = 'too-big';
      this.mark(true);
      return false;
    }
    try {
      window.localStorage.setItem(KEY, text);
      this.blocked = null;
      this.mark(false);
      return true;
    } catch (err) {
      /* The two causes have different answers, so they must not be guessed
         apart by size. A quota that is full is fixed by drawing less or by
         **Forget saved work**; an origin with no storage cannot be fixed from
         here at all, and telling somebody their drawing is too big when it is
         not sends them to shrink a drawing that was never the problem.
         `QuotaExceededError` is the name the Web Storage specification gives
         the first. `NS_ERROR_DOM_QUOTA_REACHED` is what Gecko calls the same
         condition, and this editor's own browser tools drive Firefox. */
      const full =
        err instanceof DOMException &&
        (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED');
      this.blocked = full ? 'too-big' : 'no-storage';
      this.mark(true);
      return false;
    }
  }

  forget(): void {
    try {
      window.localStorage.removeItem(KEY);
      window.localStorage.removeItem(STALE);
    } catch {
      this.blocked = 'no-storage';
    }
  }

  /**
   * Write once the drawing has been still for a moment.
   *
   * The store notifies on every notch of a drag, and serialising a document per
   * frame is the kind of autosave people turn off. The callback is not run until
   * the timer fires, so a drag costs one `JSON.stringify` rather than sixty.
   *
   * `flush` exists because the last edit before somebody closes the tab is the
   * one they most want kept, and it is the one still sitting in this timer.
   */
  schedule(make: () => string, delay = 800): void {
    this.pending = make;
    if (this.timer !== null) return;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      const fn = this.pending;
      this.pending = null;
      if (fn) this.save(fn());
    }, delay);
  }

  flush(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    const fn = this.pending;
    this.pending = null;
    if (fn) this.save(fn());
  }
}
