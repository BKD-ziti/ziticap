import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// `base: './'` keeps every asset path relative, so the build works on any
// GitHub Pages URL (user.github.io/ziticap/ or a custom domain) without edits.
export default defineConfig({
  base: './',
  plugins: [preact()],
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
});
