import fs from 'fs'
import http from 'http'
import https from 'https'
import net from 'net'
import path from 'path'
import tls from 'tls'
import { fileURLToPath, pathToFileURL } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const frontendRoot = path.resolve(__dirname, '..')
const projectRoot = path.resolve(frontendRoot, '..')

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i]
    if (!item.startsWith('--')) continue
    const raw = item.slice(2)
    const eq = raw.indexOf('=')
    if (eq >= 0) {
      args[raw.slice(0, eq)] = raw.slice(eq + 1)
      continue
    }
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) args[raw] = 'true'
    else {
      args[raw] = next
      i += 1
    }
  }
  return args
}

function readTextFileMaybeUtf(pathname) {
  const buf = fs.readFileSync(pathname)
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le')
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.allocUnsafe(buf.length)
    for (let i = 0; i < buf.length - 1; i += 2) {
      swapped[i] = buf[i + 1]
      swapped[i + 1] = buf[i]
    }
    return swapped.toString('utf16le')
  }
  return buf.includes(0x00) ? buf.toString('utf16le') : buf.toString('utf8')
}

function parseEnvFile(pathname) {
  if (!fs.existsSync(pathname)) return {}
  const raw = readTextFileMaybeUtf(pathname)
  const out = {}
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf('=')
    if (idx < 0) continue
    const key = trimmed.slice(0, idx).replace(/^\uFEFF/, '').trim()
    const value = trimmed.slice(idx + 1).trim().replace(/^"(.*)"$/, '$1')
    if (key) out[key] = value
  }
  return out
}

function toUrl(value, fallback) {
  try {
    return new URL(String(value || fallback || '').trim())
  } catch (err) {
    throw new Error(`无效 URL: ${value || fallback}，${err.message}`)
  }
}

function isBackendPath(urlPath) {
  return (
    urlPath.startsWith('/api') ||
    urlPath.startsWith('/ws') ||
    urlPath === '/docs' ||
    urlPath.startsWith('/docs/') ||
    urlPath === '/redoc' ||
    urlPath === '/openapi.json' ||
    urlPath === '/health'
  )
}

function createRequestHeaders(req, target, forwardedProto) {
  const headers = { ...req.headers }
  headers.host = target.host
  headers['x-forwarded-host'] = req.headers.host || ''
  headers['x-forwarded-proto'] = forwardedProto
  headers['x-forwarded-for'] = req.socket.remoteAddress || ''
  return headers
}

function createUpgradeHeaders(req, target, forwardedProto) {
  const pairs = []
  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null) continue
    if (key.toLowerCase() === 'host') continue
    if (Array.isArray(value)) {
      for (const item of value) pairs.push(`${key}: ${item}`)
    } else {
      pairs.push(`${key}: ${value}`)
    }
  }
  pairs.push(`host: ${target.host}`)
  pairs.push(`x-forwarded-host: ${req.headers.host || ''}`)
  pairs.push(`x-forwarded-proto: ${forwardedProto}`)
  pairs.push(`x-forwarded-for: ${req.socket.remoteAddress || ''}`)
  return pairs
}

export function createLocalHttpsProxy(options = {}) {
  const rootEnv = parseEnvFile(path.resolve(projectRoot, '.env'))
  const args = parseArgs(process.argv.slice(2))

  const listenHost = String(options.listenHost || args.host || process.env.HTTPS_PROXY_HOST || '0.0.0.0')
  const listenPort = Number(options.listenPort || args.port || process.env.HTTPS_PROXY_PORT || 8443)

  const viteTarget = toUrl(
    options.viteTarget ||
      args['vite-target'] ||
      process.env.VITE_DEV_TARGET ||
      'http://127.0.0.1:5173',
    'http://127.0.0.1:5173'
  )

  const apiTarget = toUrl(
    options.apiTarget ||
      args['api-target'] ||
      process.env.HTTPS_PROXY_API_TARGET ||
      process.env.VITE_API_TARGET ||
      rootEnv.VITE_API_TARGET ||
      'http://127.0.0.1:8000',
    'http://127.0.0.1:8000'
  )

  const certPath = path.resolve(
    options.certPath ||
      args.cert ||
      process.env.HTTPS_PROXY_CERT ||
      path.resolve(projectRoot, 'ssl', 'cert.pem')
  )
  const keyPath = path.resolve(
    options.keyPath ||
      args.key ||
      process.env.HTTPS_PROXY_KEY ||
      path.resolve(projectRoot, 'ssl', 'key.pem')
  )

  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    throw new Error(`未找到 HTTPS 证书，请检查 ${certPath} 和 ${keyPath}`)
  }

  const tlsOptions = {
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath),
  }

  const server = https.createServer(tlsOptions, (req, res) => {
    const reqUrl = new URL(req.url || '/', 'https://local-proxy.invalid')
    const target = isBackendPath(reqUrl.pathname) ? apiTarget : viteTarget
    const client = target.protocol === 'https:' ? https : http
    const proxyReq = client.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        method: req.method,
        path: `${reqUrl.pathname}${reqUrl.search}`,
        headers: createRequestHeaders(req, target, 'https'),
        rejectUnauthorized: false,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers)
        proxyRes.pipe(res)
      }
    )

    proxyReq.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      }
      res.end(`HTTPS 代理请求失败: ${err.message}`)
    })

    req.pipe(proxyReq)
  })

  server.on('upgrade', (req, socket, head) => {
    const reqUrl = new URL(req.url || '/', 'https://local-proxy.invalid')
    const target = isBackendPath(reqUrl.pathname) ? apiTarget : viteTarget
    const targetPort = Number(target.port || (target.protocol === 'https:' ? 443 : 80))
    const upstream = target.protocol === 'https:'
      ? tls.connect({
          host: target.hostname,
          port: targetPort,
          rejectUnauthorized: false,
        })
      : net.connect(targetPort, target.hostname)

    const cleanup = () => {
      if (!socket.destroyed) socket.destroy()
      if (!upstream.destroyed) upstream.destroy()
    }

    upstream.on('connect', () => {
      const headers = createUpgradeHeaders(req, target, 'https')
      const requestHead = [
        `${req.method || 'GET'} ${reqUrl.pathname}${reqUrl.search} HTTP/${req.httpVersion}`,
        ...headers,
        '',
        '',
      ].join('\r\n')

      upstream.write(requestHead)
      if (head && head.length > 0) upstream.write(head)
      socket.pipe(upstream).pipe(socket)
    })

    upstream.on('error', cleanup)
    socket.on('error', cleanup)
  })

  return {
    server,
    listenHost,
    listenPort,
    viteTarget,
    apiTarget,
    certPath,
    keyPath,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const proxy = createLocalHttpsProxy()
    proxy.server.listen(proxy.listenPort, proxy.listenHost, () => {
      console.log(`[https-proxy] listen: https://${proxy.listenHost}:${proxy.listenPort}`)
      console.log(`[https-proxy] frontend -> ${proxy.viteTarget.href}`)
      console.log(`[https-proxy] backend  -> ${proxy.apiTarget.href}`)
      console.log(`[https-proxy] cert     -> ${proxy.certPath}`)
    })
  } catch (err) {
    console.error(`[https-proxy] 启动失败: ${err.message}`)
    process.exit(1)
  }
}
