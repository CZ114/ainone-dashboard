import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    open: true,
    proxy: {
      '/api/chat': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/api/projects': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/api/abort': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/api/sessions': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/api/system': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/api/slash-commands': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/api/diary': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      // WebSocket proxy for the embedded terminal. `ws: true` tells
      // Vite to forward the HTTP Upgrade handshake to the backend
      // instead of handling it itself (otherwise WS requests to
      // localhost:5173/ws/shell would 404).
      '/ws/shell': {
        target: 'ws://localhost:3000',
        ws: true,
        changeOrigin: true,
      },
      '/api/serial': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/api/ble': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/api/audio': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/api/recording': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/api/recordings': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/api/extensions': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/api/system': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:8080',
        ws: true,
      },
    },
  },
})