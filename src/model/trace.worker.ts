/**
 * The tracer, off the main thread.
 *
 * `traceImage` is a pure function from plain data to plain data, which is what
 * makes this file three lines of real work: a raster clones across the boundary
 * and so does a `Shape`, with no DOM on either side. Nothing in `model/trace.ts`
 * or `core/raster.ts` knows this file exists.
 *
 * Built by Vite as `?worker&inline`, so the whole worker is a base64 blob inside
 * the one HTML file and the single-file build keeps its promise of no external
 * requests. Blob workers are constructed as **classic** scripts, not modules:
 * Chromium refuses a module worker from a `blob:` URL when the page came from
 * `file://`, and the whole point of the single-file build is that opening the
 * file from disk works. Vite's default worker format is `iife`, which is the
 * classic form, so this is what already happens -- but a future
 * `worker: { format: 'es' }` in the Vite config would break tracing for anyone
 * who opened the file rather than served it, silently, and only on disk.
 */

import { traceImage } from './trace';
import type { Placement, TraceOptions, TraceResult } from './trace';
import type { RasterLike } from '../core/raster';

export interface TraceRequest {
  raster: RasterLike;
  place: Placement;
  opts: TraceOptions;
}

export type TraceReply = { ok: true; result: TraceResult } | { ok: false; error: string };

self.onmessage = (e: MessageEvent<TraceRequest>): void => {
  let reply: TraceReply;
  try {
    const { raster, place, opts } = e.data;
    reply = { ok: true, result: traceImage(raster, place, opts) };
  } catch (err) {
    // The walk is integer work over whatever a file decoded to. A throw here
    // has to come back as a message: an unhandled error in a worker reaches the
    // page as an `error` event with no detail, and the caller is left waiting.
    reply = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  self.postMessage(reply);
};
