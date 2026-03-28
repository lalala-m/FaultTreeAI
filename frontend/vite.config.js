import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8000'
    }
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (id.includes('reactflow')) return 'reactflow'
          if (id.includes('antd')) return 'antd'
          if (id.includes('axios')) return 'axios'
          return
        },
      },
    },
  },
})
