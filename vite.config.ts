import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  base: './',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'OpenQuire',
        short_name: 'OpenQuire',
        description: 'A free, open source PDF suite that runs entirely on your device.',
        start_url: './',
        scope: './',
        display: 'standalone',
        theme_color: '#282828',
        background_color: '#1c1c1c',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        // Installed, OpenQuire can open PDFs and images from the operating system.
        file_handlers: [
          { action: './', accept: { 'application/pdf': ['.pdf'], 'image/*': ['.png', '.jpg', '.jpeg', '.webp'] } },
        ],
      },
      workbox: {
        // The app and the MuPDF engine are cached on first visit; OCR files only once OCR is used.
        globPatterns: ['**/*.{js,css,html,wasm,png,svg}'],
        globIgnores: ['ocr/**'],
        maximumFileSizeToCacheInBytes: 16 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.includes('/ocr/'),
            handler: 'CacheFirst',
            options: { cacheName: 'openquire-ocr', expiration: { maxEntries: 12 } },
          },
        ],
      },
    }),
  ],
  // MuPDF loads its WebAssembly relative to its own module, so it must not be pre-bundled.
  optimizeDeps: { exclude: ['mupdf'] },
  worker: { format: 'es' },
  build: { target: 'es2022' },
  test: { environment: 'node', include: ['tests/**/*.test.ts'], testTimeout: 30_000 },
})
