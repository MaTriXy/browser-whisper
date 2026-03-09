import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
    // Output the compiled site to a distinct folder
    build: {
        outDir: 'dist-site',
        emptyOutDir: true,
        rollupOptions: {
            input: {
                main: resolve(__dirname, 'index.html'),
                demo: resolve(__dirname, 'demo/index.html'),
            },
        },
    },

    // Workers are ES modules
    worker: { format: 'es' },

    server: {
        headers: {
            // Required for SharedArrayBuffer (transformers.js threading)
            'Cross-Origin-Embedder-Policy': 'require-corp',
            'Cross-Origin-Opener-Policy': 'same-origin',
        },
    },

    optimizeDeps: {
        // Exclude WASM dependencies from Vite pre-bundling
        exclude: ['@huggingface/transformers', 'mediabunny'],
    },
});
