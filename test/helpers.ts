/**
 * Scaffolding the tests share, and production has no use for.
 *
 * A helper kept in `src/` alongside the code it exercises reads as part of the
 * interface: `code/unreached.mjs` reports it as reached only by tests, which is
 * the finding it exists to report.
 */

import { findShape } from '../src/model/doc';
import type { Doc } from '../src/core/types';

/**
 * The id of the node at a position, throwing if there is none.
 *
 * Throwing is why this is not production code. A test wants the position it
 * named to exist, and a `null` here would be asserted against in every caller.
 */
export function nodeIdAt(doc: Doc, shape: string, sp: number, i: number): string {
  const node = findShape(doc, shape)?.subpaths[sp]?.nodes[i];
  if (!node) throw new Error(`no node at ${shape}/${sp}/${i}`);
  return node.id;
}
