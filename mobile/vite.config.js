import { defineConfig } from 'vite';

// Capacitor loads the built files from the app bundle, so asset paths are relative.
export default defineConfig({
  base: './',
  build: { outDir: 'dist', target: 'es2022', chunkSizeWarningLimit: 1500 },
  server: { host: true, port: 5180 },
});
