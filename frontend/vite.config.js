import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'fs'

export default defineConfig(({ mode }) => {
  const envLocal = loadEnv(mode, process.cwd(), '')
  const envRoot = loadEnv(mode, path.resolve(process.cwd(), '..'), '')
  const env = { ...envRoot, ...envLocal, ...process.env }

  let apiTarget = env.VITE_API_TARGET || env['\uFEFFVITE_API_TARGET'] || ''

  try {
    const rootEnvPath = path.resolve(process.cwd(), '..', '.env')
    if (fs.existsSync(rootEnvPath)) {
      const buf = fs.readFileSync(rootEnvPath)
      let raw = ''
      if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
        raw = buf.toString('utf16le')
      } else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
        const swapped = Buffer.allocUnsafe(buf.length)
        for (let i = 0; i < buf.length - 1; i += 2) {
          swapped[i] = buf[i + 1]
          swapped[i + 1] = buf[i]
        }
        raw = swapped.toString('utf16le')
      } else {
        const hasNull = buf.includes(0x00)
        raw = hasNull ? buf.toString('utf16le') : buf.toString('utf8')
      }
      const match = raw.match(/^[\uFEFF]*VITE_API_TARGET\s*=\s*(.*)\s*$/m)
      const rootValue = match?.[1]?.trim().replace(/^"(.*)"$/, '$1') || ''
      console.log('[vite] root .env:', rootEnvPath, 'VITE_API_TARGET:', rootValue || '(not set)')
      if (rootValue && rootValue !== apiTarget) {
        apiTarget = rootValue
      }
    } else {
      console.log('[vite] root .env:', rootEnvPath, 'not found')
    }
  } catch {
    // ignore
  }
  if (!apiTarget) apiTarget = 'http://127.0.0.1:8000'
  console.log('[vite] env VITE_API_TARGET:', env.VITE_API_TARGET || env['\uFEFFVITE_API_TARGET'] || '(not set)')
  console.log('[vite] api proxy target:', apiTarget)

  return {
    plugins: [react()],
    server: {
      port: 5173,
      host: true,
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
        },
      },
    },
    build: {
      chunkSizeWarningLimit: 1000,
      sourcemap: false,
      minify: 'terser',
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return
            // 将大型依赖拆分为独立 chunk，减少初始加载内存
            if (id.includes('reactflow')) return 'reactflow'
            if (id.includes('antd')) return 'antd'
            if (id.includes('@ant-design/icons')) return 'antd-icons'
            if (id.includes('axios')) return 'axios'
            if (id.includes('pixi.js')) return 'pixi'
            if (id.includes('gsap')) return 'gsap'
            if (id.includes('@byteplus/rtc')) return 'rtc'
            return 'vendor'
          },
        },
      },
    },
  }
})
