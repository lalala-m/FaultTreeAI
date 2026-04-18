import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { gsap } from 'gsap'

const NODE_W = {
  device: 220,
  fault: 220,
  solution: 260,
  pipeline: 220,
}

const NODE_H = {
  device: 86,
  fault: 86,
  solution: 96,
  pipeline: 86,
}

const NODE_STYLE = {
  device: { fill: 0xeaf4ff, stroke: 0x91caff, text: 0x1f2937 },
  fault: { fill: 0xfff7da, stroke: 0xffd666, text: 0x1f2937 },
  solution: { fill: 0xecffe2, stroke: 0x95de64, text: 0x1f2937 },
  pipeline: { fill: 0xcfe7ff, stroke: 0x1677ff, text: 0x1f2937 },
}

const hex = (v) => `#${Number(v || 0).toString(16).padStart(6, '0')}`

const measureTextUnits = (s) => {
  const str = String(s || '')
  let n = 0
  for (let i = 0; i < str.length; i += 1) {
    const code = str.charCodeAt(i)
    n += (code >= 0x2e80 ? 1 : 0.55)
  }
  return Math.max(1, n)
}

const computeNodeBox = (n, sc) => {
  const kind = n?.data?.kind || 'device'
  const emphasis = Number.isFinite(n?.data?.emphasis) ? n.data.emphasis : 1
  const baseWidth = (NODE_W[kind] || 220) * sc
  const baseHeight = (NODE_H[kind] || 86) * sc
  const fontSize = Math.max(12, 14 * sc) * Math.min(1.25, Math.max(0.85, emphasis))
  const padX = Math.max(10, 12 * sc)
  const padY = Math.max(8, 10 * sc)
  const units = measureTextUnits(n?.data?.label)
  const maxLines = kind === 'solution' ? 3 : 2

  let width = baseWidth * emphasis
  const maxWidth = width * 1.9
  for (let i = 0; i < 5; i += 1) {
    const usableW = Math.max(80, width - padX * 2)
    const charsPerLine = Math.max(4, Math.floor(usableW / Math.max(fontSize * 0.92, 1)))
    const lines = Math.max(1, Math.ceil(units / charsPerLine))
    if (lines <= maxLines) break
    width = Math.min(maxWidth, width * 1.15)
    if (width >= maxWidth - 0.5) break
  }

  const usableW = Math.max(80, width - padX * 2)
  const charsPerLine = Math.max(4, Math.floor(usableW / Math.max(fontSize * 0.92, 1)))
  const lines = Math.max(1, Math.ceil(units / charsPerLine))
  const contentH = padY * 2 + lines * fontSize * 1.35
  const nodeHeight = Math.max(baseHeight * emphasis, contentH)
  return { kind, emphasis, baseWidth, baseHeight, width, nodeHeight, fontSize }
}

export default function PixiCloudGraph({ nodes, edges, onNodeClick, onPaneClick, height = 560, freezeView = false, onFrameChange, centerNodeId = null }) {
  const hostRef = useRef(null)
  const nodeRefs = useRef(new Map())
  const prevLayoutRef = useRef(new Map())
  const frameRef = useRef(null)
  const edgeTimerRef = useRef(null)
  const measureTimerRef = useRef(null)
  const dragRef = useRef(null)
  const animatingRef = useRef(false)
  const [viewTransform, setViewTransform] = useState({ panX: 0, panY: 0, zoom: 1 })
  const [isDragging, setIsDragging] = useState(false)
  const [edgesVisible, setEdgesVisible] = useState(false)
  const [measuredSizes, setMeasuredSizes] = useState({})

  const visibleNodes = useMemo(
    () => (Array.isArray(nodes) ? nodes : []).filter((n) => !n?.data?.hidden && n?.style?.opacity !== 0),
    [nodes]
  )
  const visibleEdges = useMemo(() => (Array.isArray(edges) ? edges : []), [edges])
  const byId = useMemo(() => new Map(visibleNodes.map((n) => [n.id, n])), [visibleNodes])
  const spreadFactor = useMemo(() => {
    const n = visibleNodes.length
    if (n <= 12) return 1
    if (n <= 24) return 1.12
    if (n <= 40) return 1.25
    if (n <= 60) return 1.4
    return 1.55
  }, [visibleNodes.length])
  const spreadAnchor = useMemo(() => {
    const center = centerNodeId ? byId.get(centerNodeId) : null
    const pipeline = visibleNodes.find((n) => n?.data?.kind === 'pipeline') || null
    const root = center || pipeline || visibleNodes[0] || null
    const x = root?.position?.x ?? 0
    const y = root?.position?.y ?? 0
    return { x, y }
  }, [centerNodeId, byId, visibleNodes])
  const spreadPos = (pos) => {
    const x0 = pos?.x ?? 0
    const y0 = pos?.y ?? 0
    return {
      x: spreadAnchor.x + (x0 - spreadAnchor.x) * spreadFactor,
      y: spreadAnchor.y + (y0 - spreadAnchor.y) * spreadFactor,
    }
  }

  const posById = useMemo(() => {
    const m = new Map()
    visibleNodes.forEach((n) => {
      m.set(n.id, spreadPos(n.position))
    })

    if (!visibleNodes.length || !visibleEdges.length) return m

    const degree = new Map()
    visibleEdges.forEach((e) => {
      const s = e?.source
      const t = e?.target
      if (!s || !t) return
      degree.set(s, (degree.get(s) || 0) + 1)
      degree.set(t, (degree.get(t) || 0) + 1)
    })

    const pipelineId = visibleNodes.find((n) => n?.data?.kind === 'pipeline')?.id || null
    let rootId = centerNodeId || pipelineId || null
    if (!rootId) {
      let best = null
      degree.forEach((d, id) => {
        if (!best || d > best.d) best = { id, d }
      })
      rootId = best?.id || null
    }
    if (!rootId) return m

    const neighbors = new Set()
    visibleEdges.forEach((e) => {
      if (e?.source === rootId && e?.target) neighbors.add(e.target)
      else if (e?.target === rootId && e?.source) neighbors.add(e.source)
    })
    const k = neighbors.size
    const nTotal = visibleNodes.length
    const rootDeg = degree.get(rootId) || 0
    const looksStar = k >= 6 && rootDeg >= Math.max(6, Math.floor(nTotal * 0.3))
    if (!looksStar) return m

    const rootPos = m.get(rootId) || { x: spreadAnchor.x, y: spreadAnchor.y }
    const items = Array.from(neighbors).map((id) => {
      const p = m.get(id) || { x: rootPos.x, y: rootPos.y }
      const dx = (p.x ?? 0) - (rootPos.x ?? 0)
      const dy = (p.y ?? 0) - (rootPos.y ?? 0)
      const angRaw = Math.atan2(dy, dx)
      const ang = angRaw < 0 ? angRaw + Math.PI * 2 : angRaw
      const r = Math.hypot(dx, dy)
      const node = byId.get(id)
      const label = node?.data?.label || node?.data?.name || node?.label || ''
      const units = measureTextUnits(label)
      const w = 1 + Math.min(2.4, units / 10)
      return { id, ang, r, w }
    })

    items.sort((a, b) => a.ang - b.ang)

    let startAngle = items[0]?.ang || 0
    if (items.length > 2) {
      let maxGap = -1
      let maxIdx = 0
      for (let i = 0; i < items.length; i += 1) {
        const a0 = items[i].ang
        const a1 = items[(i + 1) % items.length].ang + (i + 1 === items.length ? Math.PI * 2 : 0)
        const gap = a1 - a0
        if (gap > maxGap) {
          maxGap = gap
          maxIdx = i
        }
      }
      startAngle = items[(maxIdx + 1) % items.length].ang
    }

    const totalW = items.reduce((s, it) => s + (Number(it.w) || 1), 0) || 1
    const minR = 240 * spreadFactor + Math.min(360, totalW * 12)
    let acc = 0
    items.forEach((it) => {
      const frac = (Number(it.w) || 1) / totalW
      const step = Math.PI * 2 * frac
      const a = startAngle + acc + step / 2
      acc += step
      const r = Math.max(minR, it.r || 0)
      m.set(it.id, {
        x: (rootPos.x ?? 0) + Math.cos(a) * r,
        y: (rootPos.y ?? 0) + Math.sin(a) * r,
      })
    })

    return m
  }, [visibleNodes, visibleEdges, spreadFactor, spreadAnchor.x, spreadAnchor.y, centerNodeId])
  const rawBounds = useMemo(() => {
    if (!visibleNodes.length) return { minX: 0, minY: 0, boxW: 1, boxH: 1 }
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    visibleNodes.forEach((n) => {
      const ms = measuredSizes?.[n?.id]
      const { baseWidth, baseHeight, width: w0, nodeHeight: h0 } = computeNodeBox(n, 1)
      const width = Math.max(w0, Number(ms?.w || 0) || 0)
      const nodeHeight = Math.max(h0, Number(ms?.h || 0) || 0)
      const p = posById.get(n.id) || spreadPos(n.position)
      const x = (p.x ?? 0) - (width - baseWidth) / 2
      const y = (p.y ?? 0) - (nodeHeight - baseHeight) / 2
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x + width)
      maxY = Math.max(maxY, y + nodeHeight)
    })
    return { minX, minY, boxW: Math.max(1, maxX - minX), boxH: Math.max(1, maxY - minY) }
  }, [visibleNodes, measuredSizes, spreadFactor, spreadAnchor.x, spreadAnchor.y, posById])
  const viewW = hostRef.current?.clientWidth || 1000
  const nextScale = Math.max(0.35, Math.min(0.92, (viewW - 40) / rawBounds.boxW, (height - 40) / rawBounds.boxH))
  const nextOffsetX = (viewW - rawBounds.boxW * nextScale) / 2 - rawBounds.minX * nextScale
  const nextOffsetY = (height - rawBounds.boxH * nextScale) / 2 - rawBounds.minY * nextScale
  const baseFrame = (!freezeView || !frameRef.current) ? {
    bounds: rawBounds,
    scale: nextScale,
    offsetX: nextOffsetX,
    offsetY: nextOffsetY,
  } : frameRef.current
  const activeFrame = baseFrame || {
    bounds: rawBounds,
    scale: nextScale,
    offsetX: nextOffsetX,
    offsetY: nextOffsetY,
  }
  const scale = activeFrame.scale
  const centeredNode = centerNodeId ? byId.get(centerNodeId) : null
  const offsetX = centeredNode
    ? (() => {
      const p = posById.get(centeredNode.id) || spreadPos(centeredNode.position)
      return (viewW / 2) - (((p.x ?? 0) + (NODE_W[centeredNode.data?.kind || 'device'] || 220) / 2) * scale)
    })()
    : activeFrame.offsetX
  const offsetY = centeredNode
    ? (() => {
      const p = posById.get(centeredNode.id) || spreadPos(centeredNode.position)
      return (height / 2) - (((p.y ?? 0) + (NODE_H[centeredNode.data?.kind || 'device'] || 86) / 2) * scale)
    })()
    : activeFrame.offsetY
  if (!freezeView || !frameRef.current) {
    frameRef.current = {
      bounds: rawBounds,
      scale,
      offsetX,
      offsetY,
    }
  }
  useEffect(() => {
    onFrameChange?.({ scale, offsetX, offsetY, viewW, viewH: height })
  }, [scale, offsetX, offsetY, viewW, height, onFrameChange])
  const layoutNodes = useMemo(() => visibleNodes.map((n) => {
    const preset = n.data?.preset || 'v2'
    const ms = measuredSizes?.[n?.id]
    const { kind, baseWidth, baseHeight, width: w0, nodeHeight: h0, fontSize } = computeNodeBox(n, scale)
    const width = Math.max(w0, Number(ms?.w || 0) || 0)
    const nodeHeight = Math.max(h0, Number(ms?.h || 0) || 0)
    const p = posById.get(n.id) || spreadPos(n.position)
    const left = (p.x ?? 0) * scale + offsetX - (width - baseWidth) / 2
    const top = (p.y ?? 0) * scale + offsetY - (nodeHeight - baseHeight) / 2
    const style = NODE_STYLE[kind] || NODE_STYLE.device
    const radius = preset === 'v4' ? 14 : preset === 'v1' ? 20 : 999
    return { id: n.id, node: n, kind, width, nodeHeight, left, top, style, radius, fontSize }
  }), [visibleNodes, scale, offsetX, offsetY, spreadFactor, spreadAnchor.x, spreadAnchor.y, measuredSizes, posById])
  const resolvedLayoutNodes = useMemo(() => {
    const n = layoutNodes.length
    if (n <= 1) return layoutNodes
    if (n > 140) return layoutNodes

    const pinnedId = centerNodeId || layoutNodes.find((x) => x?.node?.data?.kind === 'pipeline')?.id || null
    const margin = Math.max(6, 10 * scale)
    const items = layoutNodes.map((x) => ({
      ...x,
      cx: x.left + x.width / 2,
      cy: x.top + x.nodeHeight / 2,
      pinned: pinnedId && x.id === pinnedId,
    }))

    const overlapsAny = () => {
      for (let i = 0; i < items.length; i += 1) {
        const a = items[i]
        const ax1 = a.cx - a.width / 2 - margin
        const ax2 = a.cx + a.width / 2 + margin
        const ay1 = a.cy - a.nodeHeight / 2 - margin
        const ay2 = a.cy + a.nodeHeight / 2 + margin
        for (let j = i + 1; j < items.length; j += 1) {
          const b = items[j]
          const bx1 = b.cx - b.width / 2 - margin
          const bx2 = b.cx + b.width / 2 + margin
          const by1 = b.cy - b.nodeHeight / 2 - margin
          const by2 = b.cy + b.nodeHeight / 2 + margin
          if (ax1 < bx2 && ax2 > bx1 && ay1 < by2 && ay2 > by1) return true
        }
      }
      return false
    }

    if (!overlapsAny()) return layoutNodes

    const iterations = n > 80 ? 10 : 14
    for (let iter = 0; iter < iterations; iter += 1) {
      let pushed = false
      for (let i = 0; i < items.length; i += 1) {
        const a = items[i]
        for (let j = i + 1; j < items.length; j += 1) {
          const b = items[j]
          const dx = b.cx - a.cx
          const dy = b.cy - a.cy
          const ox = (a.width / 2) + (b.width / 2) + margin - Math.abs(dx)
          const oy = (a.nodeHeight / 2) + (b.nodeHeight / 2) + margin - Math.abs(dy)
          if (ox <= 0 || oy <= 0) continue

          const push = Math.min(ox, oy) * 0.55
          if (ox < oy) {
            const dir = dx >= 0 ? 1 : -1
            if (a.pinned && !b.pinned) b.cx += dir * push
            else if (!a.pinned && b.pinned) a.cx -= dir * push
            else if (!a.pinned && !b.pinned) { a.cx -= dir * (push / 2); b.cx += dir * (push / 2) }
          } else {
            const dir = dy >= 0 ? 1 : -1
            if (a.pinned && !b.pinned) b.cy += dir * push
            else if (!a.pinned && b.pinned) a.cy -= dir * push
            else if (!a.pinned && !b.pinned) { a.cy -= dir * (push / 2); b.cy += dir * (push / 2) }
          }
          pushed = true
        }
      }
      if (!pushed) break
    }

    return items.map((x) => ({
      ...x,
      left: x.cx - x.width / 2,
      top: x.cy - x.nodeHeight / 2,
    }))
  }, [layoutNodes, scale, centerNodeId])

  const layoutById = useMemo(() => new Map(resolvedLayoutNodes.map((n) => [
    n.id,
    { ...n, cx: n.left + n.width / 2, cy: n.top + n.nodeHeight / 2 },
  ])), [resolvedLayoutNodes])
  const graphIdentity = useMemo(
    () => [
      visibleNodes.map((n) => n.id).join('|'),
      visibleEdges.map((e) => e.id).join('|'),
      centerNodeId || '',
    ].join('::'),
    [visibleNodes, visibleEdges, centerNodeId]
  )

  useEffect(() => {
    setViewTransform({ panX: 0, panY: 0, zoom: 1 })
    setMeasuredSizes({})
  }, [graphIdentity])

  useEffect(() => {
    setEdgesVisible(false)
    if (edgeTimerRef.current) clearTimeout(edgeTimerRef.current)
    edgeTimerRef.current = setTimeout(() => {
      setEdgesVisible(true)
      edgeTimerRef.current = null
    }, visibleNodes.length ? 220 : 0)
    return () => {
      if (edgeTimerRef.current) {
        clearTimeout(edgeTimerRef.current)
        edgeTimerRef.current = null
      }
    }
  }, [graphIdentity, visibleNodes.length])

  useLayoutEffect(() => {
    const prevLayout = prevLayoutRef.current
    animatingRef.current = true
    const count = resolvedLayoutNodes.length
    const moveDur = count > 40 ? 0.36 : 0.6
    const enterDur = count > 40 ? 0.4 : 0.7
    const enterStagger = count > 40 ? 0.008 : 0.02
    const enterDelayCap = count > 40 ? 0.12 : 0.24
    const settleDelay = Math.max(moveDur, enterDur + enterDelayCap) + 0.06
    const settleTimer = setTimeout(() => {
      animatingRef.current = false
    }, Math.round(settleDelay * 1000))
    resolvedLayoutNodes.forEach(({ id, node, left, top, width, nodeHeight }, i) => {
      const el = nodeRefs.current.get(id)
      if (!el) return
      const prev = prevLayout.get(id)
      gsap.killTweensOf(el)
      if (node?.data?.disableLayoutTween) {
        gsap.set(el, { x: 0, y: 0, scaleX: 1, scaleY: 1, opacity: 1, transformOrigin: '50% 50%' })
        return
      }
      if (prev) {
        const dx = prev.left - left
        const dy = prev.top - top
        const sx = prev.width / Math.max(width, 1)
        const sy = prev.height / Math.max(nodeHeight, 1)
        gsap.fromTo(
          el,
          { x: dx, y: dy, scaleX: sx, scaleY: sy, opacity: 1, transformOrigin: '50% 50%' },
          { x: 0, y: 0, scaleX: 1, scaleY: 1, duration: moveDur, ease: 'none' }
        )
        return
      }
      gsap.fromTo(
        el,
        { opacity: 0, scale: 0.86, y: 12, transformOrigin: '50% 50%' },
        { opacity: 1, scale: 1, y: 0, duration: enterDur, delay: Math.min(i * enterStagger, enterDelayCap), ease: 'power2.out' }
      )
    })
    prevLayoutRef.current = new Map(resolvedLayoutNodes.map(({ id, left, top, width, nodeHeight }) => [
      id,
      { left, top, width, height: nodeHeight },
    ]))
    return () => {
      clearTimeout(settleTimer)
      animatingRef.current = false
      resolvedLayoutNodes.forEach(({ id }) => {
        const el = nodeRefs.current.get(id)
        if (el) gsap.killTweensOf(el)
      })
    }
  }, [resolvedLayoutNodes])

  useEffect(() => {
    if (!resolvedLayoutNodes.length) return undefined
    if (measureTimerRef.current) clearTimeout(measureTimerRef.current)

    const delay = resolvedLayoutNodes.length > 40 ? 260 : 120
    const schedule = () => {
      measureTimerRef.current = setTimeout(() => {
        if (animatingRef.current) {
          schedule()
          return
        }
        setMeasuredSizes((prev) => {
          let changed = false
          const next = { ...(prev || {}) }
          const alive = new Set(resolvedLayoutNodes.map((n) => n.id))
          Object.keys(next).forEach((k) => {
            if (!alive.has(k)) {
              delete next[k]
              changed = true
            }
          })

          resolvedLayoutNodes.forEach(({ id, width, nodeHeight, kind, node }) => {
            const el = nodeRefs.current.get(id)
            if (!el) return
            const label = String(node?.data?.label || '')
            if (label.length < 10 && nodeHeight <= (NODE_H[kind || 'device'] || 86) * (scale || 1) + 2) return

            const neededW = Math.ceil(el.scrollWidth || 0)
            const neededH = Math.ceil(el.scrollHeight || 0)
            if (!neededW || !neededH) return
            if (neededW <= width + 1 && neededH <= nodeHeight + 1) return

            const baseW = (NODE_W[kind || 'device'] || 220) * (scale || 1)
            const baseH = (NODE_H[kind || 'device'] || 86) * (scale || 1)
            const maxW = Math.min(Math.max(baseW * 3.0, baseW + 180), 1400)
            const maxH = Math.min(Math.max(baseH * 6.0, 220), 1400)
            const w = Math.min(maxW, Math.max(neededW, baseW))
            const h = Math.min(maxH, Math.max(neededH, baseH))

            const p = next[id] || {}
            const pw = Number(p.w || 0) || 0
            const ph = Number(p.h || 0) || 0
            if (w > pw + 1 || h > ph + 1) {
              next[id] = { w, h }
              changed = true
            }
          })

          return changed ? next : prev
        })
      }, delay)
    }

    schedule()
    return () => {
      if (measureTimerRef.current) {
        clearTimeout(measureTimerRef.current)
        measureTimerRef.current = null
      }
    }
  }, [resolvedLayoutNodes, scale])

  useEffect(() => {
    if (!isDragging) return undefined
    const onMove = (e) => {
      const drag = dragRef.current
      if (!drag) return
      const dx = e.clientX - drag.startX
      const dy = e.clientY - drag.startY
      drag.moved = drag.moved || Math.abs(dx) > 3 || Math.abs(dy) > 3
      setViewTransform((prev) => ({
        ...prev,
        panX: drag.originPanX + dx,
        panY: drag.originPanY + dy,
      }))
    }
    const onUp = () => {
      const drag = dragRef.current
      if (drag && !drag.moved && drag.startedOnPane) onPaneClick?.()
      dragRef.current = null
      setIsDragging(false)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [isDragging, onPaneClick])

  const handleWheel = (e) => {
    e.preventDefault()
    const rect = hostRef.current?.getBoundingClientRect?.()
    if (!rect) return
    const cx = e.clientX - rect.left
    const cy = e.clientY - rect.top
    setViewTransform((prev) => {
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12
      const nextZoom = Math.max(0.7, Math.min(2.4, prev.zoom * factor))
      const contentX = (cx - prev.panX) / prev.zoom
      const contentY = (cy - prev.panY) / prev.zoom
      return {
        zoom: nextZoom,
        panX: cx - contentX * nextZoom,
        panY: cy - contentY * nextZoom,
      }
    })
  }

  const handlePaneMouseDown = (e) => {
    if (e.target !== e.currentTarget) return
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      originPanX: viewTransform.panX,
      originPanY: viewTransform.panY,
      moved: false,
      startedOnPane: true,
    }
    setIsDragging(true)
  }

  return (
    <div
      ref={hostRef}
      style={{ width: '100%', height, position: 'relative', overflow: 'hidden' }}
      onWheel={handleWheel}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          transform: `translate(${viewTransform.panX}px, ${viewTransform.panY}px) scale(${viewTransform.zoom})`,
          transformOrigin: '0 0',
          cursor: isDragging ? 'grabbing' : 'grab',
        }}
        onMouseDown={handlePaneMouseDown}
      >
        <svg
          width="100%"
          height={height}
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            opacity: edgesVisible ? 1 : 0,
            transition: 'opacity 180ms ease',
          }}
        >
          {visibleEdges.map((e) => {
            const s = layoutById.get(e.source)
            const t = layoutById.get(e.target)
            if (!s || !t) return null
            return <line key={e.id} x1={s.cx} y1={s.cy} x2={t.cx} y2={t.cy} stroke={e.style?.stroke || '#91caff'} strokeWidth={1.2} opacity={0.88} />
          })}
        </svg>
        {resolvedLayoutNodes.map(({ id, node, width, nodeHeight, left, top, style, radius, fontSize }, i) => {
          return (
            <button
              key={id}
              ref={(el) => {
                if (el) nodeRefs.current.set(id, el)
                else nodeRefs.current.delete(id)
              }}
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onNodeClick?.(null, { ...node, data: node.data || {}, positionAbsolute: node.position })
              }}
              style={{
                position: 'absolute',
                left,
                top,
                width,
                height: nodeHeight,
                borderRadius: radius,
                border: `1.4px solid ${hex(style.stroke)}`,
                background: hex(style.fill),
                color: hex(style.text),
                fontWeight: 600,
                fontSize,
                boxShadow: '0 8px 24px rgba(0,0,0,0.08)',
                padding: '8px 12px',
                cursor: 'pointer',
                overflow: 'hidden',
                userSelect: 'none',
                WebkitUserSelect: 'none',
                caretColor: 'transparent',
                outline: 'none',
              }}
            >
              <span style={{ display: 'block', lineHeight: 1.4, wordBreak: 'break-word', whiteSpace: 'normal' }}>{node.data?.label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
