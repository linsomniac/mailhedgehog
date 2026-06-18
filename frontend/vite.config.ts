import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { svelteTesting } from '@testing-library/svelte/vite';

// AIDEV-NOTE: Vite config for mailhedgehog Svelte 5 SPA.
// Output goes to src/mailhedgehog/static/app/ which is committed (hatchling auto-packages it).
// Stable (non-hashed) filenames so git diffs stay clean.
// svelteTesting plugin sets the 'browser' resolve condition so Svelte 5 client
// code is used during vitest runs (avoids "mount is not available on server" errors).
export default defineConfig({
  base: '/static/app/',
  plugins: [
    tailwindcss(),
    svelte(),
    svelteTesting(),
  ],
  build: {
    outDir: '../src/mailhedgehog/static/app',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        entryFileNames: 'app.js',
        chunkFileNames: 'app-[name].js',
        assetFileNames: 'app.[ext]',
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
  },
});
