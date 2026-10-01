import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: './',
  plugins: [react()],
  // MuPDF loads its WebAssembly relative to its own module, so it must not be pre-bundled.
  optimizeDeps: { exclude: ['mupdf'] },
  worker: { format: 'es' },
  build: { target: 'es2022' },
  test: { environment: 'node', include: ['tests/**/*.test.ts'], testTimeout: 30_000 },
})
