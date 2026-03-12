import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  // CRITICAL: Disable ALL asset inlining to ensure the 60MB .wasm
  // files are NEVER converted to base64 strings inside the bundle.
  // We don't care about the extra files being generated in `/dist/assets/`
  // because transformers.js is hardcoded to fetch them from jsdelivr CDN anyway.
  build: {
    assetsInlineLimit: 0,
    lib: {
      // Main entry – workers are added via rollupOptions.input below
      entry: resolve(__dirname, 'src/index.ts'),
      formats: ['es'],
      fileName: 'index',
    },
    target: 'es2022',
    rollupOptions: {
      output: {
        assetFileNames: (assetInfo) => {
          if (assetInfo.name?.endsWith('.wasm')) {
            return 'assets/[name]-[hash][extname]';
          }
          return 'assets/[name]-[hash][extname]';
        }
      },
      // Externalize dependencies so they aren't bundled in the MAIN thread
      external: ['@huggingface/transformers', 'mediabunny', 'onnxruntime-web'],
    },
  },

  worker: {
    format: 'es',
    // Prevent Vite's worker plugin from base64-inlining WASM assets
    // that are imported by transformers.js / onnxruntime-web
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      }
    }
  },

  resolve: {
    alias: [
      {
        find: /\.wasm(\?url)?$/,
        replacement: resolve(__dirname, 'src/lib/empty-wasm.js')
      }
    ]
  },

  server: {
    headers: {
      // Required for SharedArrayBuffer (transformers.js threading)
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
  },

  optimizeDeps: {
    // Exclude from pre-bundling – both are WASM/ESM and must stay as-is
    exclude: ['@huggingface/transformers', 'mediabunny', 'onnxruntime-web'],
  },
})