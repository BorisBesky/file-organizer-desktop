import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
  },
  server: {
    port: 8083,
    strictPort: true,
    // open: true, // Do not open browser
    proxy: {
      '/lm': {
        target: 'http://localhost:1234',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/lm/, ''),
      },
    },
  },
  resolve: {
    alias: {
      '@': '/src',
    },
  },
})