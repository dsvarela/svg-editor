/**
 * Path data, serialised only when the geometry behind it changed.
 *
 * Serialising on every ask costs 112 ms of the 131 ms a render takes on 23 454
 * nodes, and most renders follow something that moved nothing.
 *
 * **Compare the numbers. Never object identity, never a revision counter.** The
 * store mutates in place, so a dragged node is the same object with different
 * numbers. A counter would need every call site touching geometry to bump it,
 * and its failure mode is a canvas that stops matching its own model.
 * Comparing costs 0.5 ms against 56 ms to serialise, so it pays even when it
 * fails. §29.
 */

import { serialisePath } from '../core/serialise';
import type { Subpath } from '../core/types';

/** Doubles per node in a signature: three points and a flag for which exist. */
const STRIDE = 7;
/** Doubles per subpath header: node count, and whether it is closed. */
const HEAD = 2;

interface Entry {
  sig: Float64Array;
  d: string;
}

/** How many doubles a signature for these subpaths needs. */
function sigLength(subpaths: Subpath[]): number {
  let n = 1; // the subpath count itself
  for (const sp of subpaths) n += HEAD + sp.nodes.length * STRIDE;
  return n;
}

/**
 * Flatten the geometry a `d` string is built from, and nothing else.
 *
 * Style, id and name are excluded: they are not in path data, so a colour
 * change must not throw the string away. Handle presence is a flag, not `NaN`
 * coordinates, or `NaN !== NaN` marks every straight segment changed. §29.
 */
function signature(subpaths: Subpath[]): Float64Array {
  const out = new Float64Array(sigLength(subpaths));
  let k = 0;
  out[k++] = subpaths.length;
  for (const sp of subpaths) {
    out[k++] = sp.nodes.length;
    out[k++] = sp.closed ? 1 : 0;
    for (const n of sp.nodes) {
      out[k++] = (n.hIn ? 1 : 0) + (n.hOut ? 2 : 0);
      out[k++] = n.pt[0];
      out[k++] = n.pt[1];
      out[k++] = n.hIn ? n.hIn[0] : 0;
      out[k++] = n.hIn ? n.hIn[1] : 0;
      out[k++] = n.hOut ? n.hOut[0] : 0;
      out[k++] = n.hOut ? n.hOut[1] : 0;
    }
  }
  return out;
}

/** Whether `sig` still describes `subpaths`. Exact, and exits at the first no. */
function matches(sig: Float64Array, subpaths: Subpath[]): boolean {
  if (sig.length !== sigLength(subpaths)) return false;
  let k = 0;
  if (sig[k++] !== subpaths.length) return false;
  for (const sp of subpaths) {
    if (sig[k++] !== sp.nodes.length) return false;
    if (sig[k++] !== (sp.closed ? 1 : 0)) return false;
    for (const n of sp.nodes) {
      if (sig[k++] !== (n.hIn ? 1 : 0) + (n.hOut ? 2 : 0)) return false;
      if (sig[k++] !== n.pt[0] || sig[k++] !== n.pt[1]) return false;
      if (n.hIn) {
        if (sig[k++] !== n.hIn[0] || sig[k++] !== n.hIn[1]) return false;
      } else {
        k += 2;
      }
      if (n.hOut) {
        if (sig[k++] !== n.hOut[0] || sig[k++] !== n.hOut[1]) return false;
      } else {
        k += 2;
      }
    }
  }
  return true;
}

export class PathCache {
  private entries = new Map<string, Entry>();

  /** Serialisations actually performed, for tests and measurement. */
  misses = 0;
  /** Answers given from the cache, for tests and measurement. */
  hits = 0;

  /**
   * The path data for a shape, from the cache when its geometry is unchanged.
   *
   * Called twice per render for every shape -- the artwork and the overlay's
   * hit target want the identical string -- so the second call is a hit by
   * construction, whatever the first one cost.
   */
  get(id: string, subpaths: Subpath[]): string {
    const hit = this.entries.get(id);
    if (hit && matches(hit.sig, subpaths)) {
      this.hits++;
      return hit.d;
    }
    this.misses++;
    const d = serialisePath(subpaths, { decimals: 6 });
    this.entries.set(id, { sig: signature(subpaths), d });
    return d;
  }

  /**
   * Forget shapes that are no longer in the document.
   *
   * Ids are never reused, so a stale entry could not be served by mistake --
   * this is about memory, which for a traced document is about a megabyte of
   * signature per copy.
   */
  keep(ids: Set<string>): void {
    // No `ids.size === entries.size` shortcut: one shape deleted and another
    // added in the same edit leaves the sizes equal and the contents different.
    // There is one entry per shape, so there is nothing here worth skipping.
    for (const id of this.entries.keys()) {
      if (!ids.has(id)) this.entries.delete(id);
    }
  }
}
