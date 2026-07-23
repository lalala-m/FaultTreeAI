import { spawn, execSync } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'
import { createLocalHttpsProxy } from './local-https-proxy.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const frontendRoot = path.resolve(__dirname, '..')

const isWindows = process.platform === 'win32'
const npmCmd = 'npm'
const viteArgs = ['run', 'dev', '--', '--host', '0.0.0.0', '--port', '5173', '--strictPort']

const PROXY_PORT = 8443
const VITE_PORT = 5173

function killPortOccupiers(ports) {
  try {
    const portList = (Array.isArray(ports) ? ports : [ports]).join(',')
    if (isWindows) {
      const psCommand = `Get-NetTCPConnection -LocalPort ${portList} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess | Where-Object { $_ -match '^\\d+$' } | Sort-Object -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }`
      try {
        execSync(`powershell.exe -NoProfile -Command "${psCommand}"`, { stdio: 'ignore' })
      } catch {}
    } else {
      for (const port of (Array.isArray(ports) ? ports : [ports])) {
        try {
          execSync('lsof -ti:' + port + ' | xargs -r kill -9', { stdio: 'ignore' })
        } catch {}
      }
    }
  } catch {
    // 清理失败不影响启动
  }
}

// 启动前自动清理历史残留进程，避免 EADDRINUSE
killPortOccupiers([PROXY_PORT, VITE_PORT])

let viteProcess = null
let proxyServer = null
let closing = false

function shutdown(code = 0) {
  if (closing) return
  closing = true

  if (proxyServer) {
    proxyServer.close(() => {
      proxyServer = null
    })
  }

  if (viteProcess && !viteProcess.killed) {
    viteProcess.kill('SIGTERM')
  }

  setTimeout(() => process.exit(code), 150)
}

try {
  viteProcess = spawn(npmCmd, viteArgs, {
    cwd: frontendRoot,
    stdio: 'inherit',
    // Windows 下 npm 实际是 npm.cmd，需要通过 shell 启动，否则会触发 spawn EINVAL
    shell: isWindows,
  })

  viteProcess.on('error', (err) => {
    console.error(`[dev:https] Vite 启动失败: ${err.message}`)
    shutdown(1)
  })

  viteProcess.on('exit', (code) => {
    if (!closing) {
      console.error(`[dev:https] Vite 已退出，code=${code ?? 0}`)
      shutdown(code ?? 0)
    }
  })

  const proxy = createLocalHttpsProxy()
  proxyServer = proxy.server
  proxyServer.listen(proxy.listenPort, proxy.listenHost, () => {
    console.log('[dev:https] 已启动本地 HTTPS 代理')
    console.log(`[dev:https] App 入口: https://127.0.0.1:${proxy.listenPort}`)
    console.log(`[dev:https] 局域网访问: https://<你的电脑IP>:${proxy.listenPort}`)
    console.log(`[dev:https] 前端开发服务: ${proxy.viteTarget.href}`)
    console.log(`[dev:https] 后端代理目标: ${proxy.apiTarget.href}`)
  })

  process.on('SIGINT', () => shutdown(0))
  process.on('SIGTERM', () => shutdown(0))
} catch (err) {
  console.error(`[dev:https] 启动失败: ${err.message}`)
  shutdown(1)
}
