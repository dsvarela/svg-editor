/* From `vitest/config` rather than `vite`: the same `defineConfig`, plus the
   types for the `test` block below. */
import { defineConfig } from 'vitest/config';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  // Everything inlines into one dist/index.html you can double-click.
  plugins: [viteSingleFile()],
  /* Vitest stubs stylesheets to nothing by default, which is right for a suite
     that never looks at one -- except `test/styles.test.ts`, which reads the
     stylesheet as text to check that every class the status line writes has a
     rule behind it. Without this, its `?raw` import arrives empty and the file
     passes by finding nothing to disagree with. */
  test: { css: true },
  build: {
    target: 'es2022',
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    reportCompressedSize: true,
  },
});
