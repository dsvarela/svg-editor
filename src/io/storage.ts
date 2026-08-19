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
   * A latch rather than a stored preference. Leaving the subscriber running
   * after **Forget saved work** would write the session back inside the second
   * and make the button look broken; storing the choice would make one press
   * turn autosave off for good, which is a bigger promise than the button makes.
   * It lasts until the reload, which is when a fresh start takes effect anyway.
   */
  stopped = false;
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
      return window.localStorage.getItem(KEY);
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

  private write(text: string): boolean {
    if (this.stopped) return false;
    if (text.length > LIMIT) {
      this.blocked = 'too-big';
      return false;
    }
    try {
      window.localStorage.setItem(KEY, text);
      this.blocked = null;
      return true;
    } catch {
      /* A quota error and a blocked origin are the same class here: the write
         did not happen and nothing this code can do will make the next one
         work. `too-big` when the string is large enough to be the reason, so
         the message names the cause a person can act on. */
      this.blocked = text.length > LIMIT / 4 ? 'too-big' : 'no-storage';
      return false;
    }
  }

  forget(): void {
    try {
      window.localStorage.removeItem(KEY);
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
