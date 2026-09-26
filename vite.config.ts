import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icons/apple-touch-icon.png'],
      manifest: {
        name: 'InfraPulse — road condition from your drive',
        short_name: 'InfraPulse',
        description:
          'Detects road damage from your phone’s own sensors as you drive, and reports potholes to the works engineer.',
        // What people install is the driver app, so that is where it opens.
        // The engineer dashboard is a desktop screen reached from the web.
        start_url: '/app',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        // Matches the driver app's light theme, not the dark dashboard.
        background_color: '#F6F8FC',
        theme_color: '#F6F8FC',
        categories: ['navigation', 'utilities'],
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // The road network is a single 1.4MB file and the whole app is useless
        // without it, so it is precached rather than fetched on demand.
        globPatterns: ['**/*.{js,css,html,svg,png,mjs,geojson}'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        navigateFallbackDenylist: [/^\/data\//],
        runtimeCaching: [
          {
            // Basemap tiles: keep what has been seen, never block on them.
            urlPattern: /^https:\/\/tiles\.openfreemap\.org\/.*/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'openfreemap-tiles',
              expiration: { maxEntries: 600, maxAgeSeconds: 60 * 60 * 24 * 14 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    // react-map-gl and our own code must share one maplibre-gl instance, or
    // each gets its own worker pool and only the configured one works.
    dedupe: ['maplibre-gl'],
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // The driver screens need real DeviceMotion and GPS, which browsers only
    // expose over HTTPS or on the LAN host itself. `--host` plus a Vercel
    // preview covers phone testing in phase 7.
    host: true,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'shared/**/*.test.ts'],
  },
})
