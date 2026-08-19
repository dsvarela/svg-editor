/**
 * @vitest-environment jsdom
 *
 * Keeping the session in `localStorage`, and the two ways that does not happen.
 *
 * The happy path is one `setItem` and the browser scenario already walks it.
 * What is worth a test is everything around it, because both failures are
 * silent by nature: a page whose origin has no storage and a quota that is full
 * both look exactly like a save that worked, unless something reports them.
 *
 * `blocked` is what the interface reads to say so, and the distinction it draws
 * is the point -- one of the two is fixed by drawing less and the other cannot
 * be fixed from the page at all, so naming the wrong one sends somebody to
 * shrink a drawing that was never the problem.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionStore } from '../src/io/storage';

/** A `localStorage` that behaves, or throws whatever it is handed. */
function install(throwing: unknown = null): Map<string, string> {
  const map = new Map<string, string>();
  const guard = (): void => {
    if (throwing) throw throwing;
  };
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => {
        guard();
        return map.get(k) ?? null;
      },
      setItem: (k: string, v: string) => {
        guard();
        map.set(k, v);
      },
      removeItem: (k: string) => {
        guard();
        map.delete(k);
      },
    },
  });
  return map;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('when storage works', () => {
  it('writes what it is given and reads it back', () => {
    install();
    const s = new SessionStore();
    expect(s.save('{"a":1}')).toBe(true);
    expect(s.blocked).toBeNull();
    expect(s.load()).toBe('{"a":1}');
  });

  it('reads null for a page that has never saved', () => {
    install();
    expect(new SessionStore().load()).toBeNull();
    expect(new SessionStore().blocked).toBeNull();
  });

  it('reports every attempt, so the interface can say what happened', () => {
    install();
    const s = new SessionStore();
    const seen: (string | null)[] = [];
    s.onState = () => seen.push(s.blocked);
    s.save('{}');
    s.save('{}');
    expect(seen).toEqual([null, null]);
  });
});

describe('when the origin has no storage at all', () => {
  /* Opened from `file://`, Chromium gives the page an opaque origin and every
     access throws. A build of this editor is one file you double-click, so this
     is the path a large share of its use takes. */
  const denied = new DOMException('The operation is insecure.', 'SecurityError');

  it('latches on the read, rather than throwing out of startup', () => {
    install(denied);
    const s = new SessionStore();
    expect(s.load()).toBeNull();
    expect(s.blocked).toBe('no-storage');
  });

  it('latches on the write and says the write did not happen', () => {
    install(denied);
    const s = new SessionStore();
    expect(s.save('{}')).toBe(false);
    expect(s.blocked).toBe('no-storage');
  });

  /* The size heuristic this replaced called a blocked origin `too-big` for any
     drawing over a quarter of the limit, which is a sentence about a drawing
     that is not too big and an instruction nobody can act on. */
  it('does not blame the drawing for an origin that refuses every write', () => {
    install(denied);
    const s = new SessionStore();
    s.save('x'.repeat(900_000));
    expect(s.blocked).toBe('no-storage');
  });

  it('does not throw when asked to forget', () => {
    install(denied);
    const s = new SessionStore();
    expect(() => s.forget()).not.toThrow();
    expect(s.blocked).toBe('no-storage');
  });
});

describe('when there is no room', () => {
  it('refuses a string past the limit without asking the browser', () => {
    const map = install();
    const s = new SessionStore();
    expect(s.save('x'.repeat(2_000_001))).toBe(false);
    expect(s.blocked).toBe('too-big');
    expect(map.size).toBe(0);
  });

  it.each(['QuotaExceededError', 'NS_ERROR_DOM_QUOTA_REACHED'])(
    'names the drawing when the browser refuses with %s',
    (name) => {
      install(new DOMException('no room', name));
      const s = new SessionStore();
      expect(s.save('{}')).toBe(false);
      expect(s.blocked).toBe('too-big');
    },
  );

  it('clears the complaint once a write succeeds again', () => {
    const s = new SessionStore();
    install(new DOMException('no room', 'QuotaExceededError'));
    s.save('{}');
    expect(s.blocked).toBe('too-big');
    install();
    s.save('{}');
    expect(s.blocked).toBeNull();
  });
});

describe('the timer', () => {
  it('serialises once for a burst of edits rather than once each', () => {
    install();
    const s = new SessionStore();
    let built = 0;
    const make = (): string => {
      built++;
      return '{}';
    };
    for (let i = 0; i < 60; i++) s.schedule(make, 800);
    expect(built).toBe(0);
    vi.advanceTimersByTime(800);
    expect(built).toBe(1);
  });

  it('writes the last state asked for, not the first', () => {
    const map = install();
    const s = new SessionStore();
    s.schedule(() => '"first"', 800);
    s.schedule(() => '"last"', 800);
    vi.advanceTimersByTime(800);
    expect([...map.values()]).toEqual(['"last"']);
  });

  /* The edit before somebody closes the tab is the one they most want kept, and
     it is the one still sitting in this timer. */
  it('writes immediately on a flush, and not again when the timer would have run', () => {
    const map = install();
    const s = new SessionStore();
    let built = 0;
    s.schedule(() => {
      built++;
      return '{}';
    }, 800);
    s.flush();
    expect(built).toBe(1);
    expect(map.size).toBe(1);
    vi.advanceTimersByTime(2000);
    expect(built).toBe(1);
  });

  it('does nothing on a flush with nothing pending', () => {
    const map = install();
    const s = new SessionStore();
    s.flush();
    expect(map.size).toBe(0);
  });

  it('schedules again after a flush', () => {
    const map = install();
    const s = new SessionStore();
    s.schedule(() => '"one"', 800);
    s.flush();
    s.schedule(() => '"two"', 800);
    vi.advanceTimersByTime(800);
    expect([...map.values()]).toEqual(['"two"']);
  });
});

describe('forget saved work', () => {
  it('removes what was there', () => {
    const map = install();
    const s = new SessionStore();
    s.save('{}');
    s.forget();
    expect(map.size).toBe(0);
  });

  /* A latch, because leaving the subscriber running would write the session
     back inside the second and make the button look broken. */
  it('holds, so a later save does not put it straight back', () => {
    const map = install();
    const s = new SessionStore();
    s.forget();
    s.stopped = true;
    expect(s.save('{}')).toBe(false);
    expect(map.size).toBe(0);
  });

  it('holds against the timer too', () => {
    const map = install();
    const s = new SessionStore();
    s.stopped = true;
    s.schedule(() => '{}', 800);
    vi.advanceTimersByTime(800);
    expect(map.size).toBe(0);
  });
});
