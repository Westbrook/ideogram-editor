import { defineConfig } from 'vite';
import { buildEvidence } from './tooling/build-evidence.js';

// P1a.1 compiles only the qualification fixture. The production shell follows separately.
export default defineConfig({
  plugins: [buildEvidence()],
  root: 'tests/consumer/fixture',
  build: { outDir: '../../../dist/consumer', emptyOutDir: true, manifest: true, target: 'es2022' },
  server: { host: '127.0.0.1' },
  preview: { host: '127.0.0.1' },
});
