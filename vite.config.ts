import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  build: {
    assetsInlineLimit: 0,
    lib: {
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
      // Keep heavy deps external — consumers' bundler resolves them from
      // node_modules, letting it handle onnxruntime-web's internal dynamic
      // imports (ort-webgpu.mjs etc.) correctly.
      external: ['@huggingface/transformers', 'mediabunny', 'onnxruntime-web'],
    },
  },

  // Workers are ES modules (required for transferable streams etc.)
  // `?worker&inline` bundles each worker as a self-contained blob URL —
  // this is Vite-specific syntax and will not work with Next.js / Webpack.
  // See src/lib/bridge.ts for the Next.js migration path (constructor injection).
  worker: {
    format: 'es',
    rollupOptions: {
      external: ['@huggingface/transformers', 'mediabunny', 'onnxruntime-web'],
    },
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