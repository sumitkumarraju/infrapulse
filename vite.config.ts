import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // react-map-gl and our own code must share one maplibre-gl instance, or
    // each gets its own worker pool and only the configured one works.
    dedupe: ['maplibre-gl'],
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
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
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
})
