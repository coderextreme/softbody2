import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [],
  resolve: {
    alias: {
      'three/addons/': '/node_modules/three/examples/jsm/'
    }
  },
  optimizeDeps: {
    exclude: ['ammo.js']
  },
  server: {
    headers: {
      // Required for SharedArrayBuffer / multithreaded builds
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    }
  }
})
