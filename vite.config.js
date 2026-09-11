import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// The build emits ONE self-contained dist/index.html with every script, style
// and asset inlined. That shape is deliberate and serves both targets:
//
//   web  -- scp dist/index.html to the server, exactly as dotdashindex.html was
//           copied before. No new hosting needs, no asset paths to get wrong.
//   iOS  -- Capacitor's webDir points at dist/ and requires its entry point to
//           be named index.html, which this already is. The old www/ staging
//           copy is gone.
//
// It also removes the five CDNs the app used to need before it could render.
// Offline, or on bad hotel wifi, the old build was a white screen with nothing
// to explain it; this one opens.
export default defineConfig({
  root: 'app',
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    // Inlining defeats chunking anyway, and the warning is just noise here.
    chunkSizeWarningLimit: 4000,
  },
});
