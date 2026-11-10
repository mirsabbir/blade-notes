import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In dev, the deployed site answers /api and /config.json, so no local backend is needed.
const target = process.env.NOTES_URL ?? 'https://notes.mirsabbiralam.com'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target, changeOrigin: true },
      '/config.json': { target, changeOrigin: true },
    },
  },
})
