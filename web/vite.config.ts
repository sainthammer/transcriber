import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // 127.0.0.1, not localhost: the backend listens on IPv4 only.
    proxy: { '/api': 'http://127.0.0.1:8000' },
  },
})
