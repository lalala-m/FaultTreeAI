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

const _charUnit = (ch) => {
  const code = ch.codePointAt(0) || 0
  if (ch === ' ') return 0.35
  if (ch === '\t') return 0.6
  if (code >= 0x4e00 && code <= 0x9fff) return 1
  if (code >= 0x3040 && code <= 0x30ff) return 0.95
  if (code >= 0xac00 && code <= 0xd7af) return 1
  if (code >= 0x1100 && code <= 0x11ff) return 0.9
  if ((code >= 0x21 && code <= 0x7e) || (code >= 0xff01 && code <= 0xff60)) return 0.62
  return 0.8
}

const _textUnits = (text) => {
  const s = String(text || '')
  let sum = 0
  for (const ch of s) sum += _charUnit(ch)
  return sum
}

const _estimateNodeSizePx = (label, kind, minWidthPx, maxWidthPx, fontSizePx) => {
  const paddingX = 24
  const paddingY = 16
  const lineHeight = fontSizePx * 1.42
  const lines = String(label || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
  const safeLines = lines.length ? lines : ['']
  const maxLineUnits = Math.max(...safeLines.map(_textUnits), 0)
  const idealWidth = Math.ceil(maxLineUnits * fontSizePx + paddingX)
  const width = Math.max(minWidthPx, Math.min(maxWidthPx, idealWidth))
  const innerWidth = Math.max(1, width - paddingX)
  const unitsPerLine = Math.max(1, innerWidth / fontSizePx)
  const totalLines = safeLines.reduce((acc, line) => acc + Math.max(1, Math.ceil(_textUnits(line) / unitsPerLine)), 0)
  const height = Math.max(1, Math.ceil(totalLines * lineHeight + paddingY))
  return { width, height }
}

const _resolveNodeCollisions = (nodes, opts = {}) => {
  const arr = Array.isArray(nodes) ? nodes.map((n) => ({ ...n })) : []
  if (arr.length <= 1) return arr
  const padding = Number.isFinite(opts.padding) ? opts.padding : 10
  const iterations = Number.isFinite(opts.iterations) ? opts.iterations : 12
  const pinnedId = opts.pinnedId ? String(opts.pinnedId) : ''

  const isPinned = (n) => (pinnedId && String(n?.id) === pinnedId) || n?.node?.data?.pinned === true

  for (let it = 0; it < iterations; it += 1) {
    let moved = false
    for (let i = 0; i < arr.length; i += 1) {
      const a = arr[i]
      const acx = a.left + a.width / 2
      const acy = a.top + a.nodeHeight / 2
      for (let j = i + 1; j < arr.length; j += 1) {
        const b = arr[j]
        const bcx = b.left + b.width / 2
        const bcy = b.top + b.nodeHeight / 2

        const dx = bcx - acx
        const dy = bcy - acy
        const minDx = (a.width + b.width) / 2 + padding
        const minDy = (a.nodeHeight + b.nodeHeight) / 2 + padding
        if (Math.abs(dx) >= minDx || Math.abs(dy) >= minDy) continue

        const overlapX = minDx - Math.abs(dx)
        const overlapY = minDy - Math.abs(dy)

        const pinA = isPinned(a)
        const pinB = isPinned(b)
        const wa = pinA ? 0 : (pinB ? 1 : 0.5)
        const wb = pinB ? 0 : (pinA ? 1 : 0.5)
        if (wa === 0 && wb === 0) continue

        if (overlapX <= overlapY) {
          const dir = dx >= 0 ? 1 : -1
          const push = (overlapX + 0.5) * dir
          a.left -= push * wa
          b.left += push * wb
        } else {
          const dir = dy >= 0 ? 1 : -1
          const push = (overlapY + 0.5) * dir
          a.top -= push * wa
          b.top += push * wb
        }
        moved = true
      }
    }
    if (!moved) break
  }

  return arr
}

export default function PixiCloudGraph({ nodes, edges, onNodeClick, onPaneClick, height = 560, freezeView = false, onFrameChange, centerNodeId = null }) {
  const hostRef = useRef(null)
  const nodeRefs = useRef(new Map())
  const prevLayoutRef = useRef(new Map())
  const frameRef = useRef(null)
  const edgeTimerRef = useRef(null)
  const dragRef = useRef(null)
  const [viewTransform, setViewTransform] = useState({ panX: 0, panY: 0, zoom: 1 })
  const [isDragging, setIsDragging] = useState(false)
  const [edgesVisible, setEdgesVisible] = useState(false)

  const visibleNodes = useMemo(
    () => (Array.isArray(nodes) ? nodes : []).filter((n) => !n?.data?.hidden && n?.style?.opacity !== 0),
    [nodes]
  )
  const visibleEdges = useMemo(() => (Array.isArray(edges) ? edges : []), [edges])
  const byId = useMemo(() => new Map(visibleNodes.map((n) => [n.id, n])), [visibleNodes])
  const rawBounds = useMemo(() => {
    if (!visibleNodes.length) return { minX: 0, minY: 0, boxW: 1, boxH: 1 }
    const minX = Math.min(...visibleNodes.map((n) => n.position?.x ?? 0))
    const minY = Math.min(...visibleNodes.map((n) => n.position?.y ?? 0))
    const maxX = Math.max(...visibleNodes.map((n) => (n.position?.x ?? 0) + (NODE_W[n.data?.kind || 'device'] || 220)))
    const maxY = Math.max(...visibleNodes.map((n) => (n.position?.y ?? 0) + (NODE_H[n.data?.kind || 'device'] || 86)))
    return { minX, minY, boxW: Math.max(1, maxX - minX), boxH: Math.max(1, maxY - minY) }
  }, [visibleNodes])
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
    ? (viewW / 2) - (((centeredNode.position?.x ?? 0) + (NODE_W[centeredNode.data?.kind || 'device'] || 220) / 2) * scale)
    : activeFrame.offsetX
  const offsetY = centeredNode
    ? (height / 2) - (((centeredNode.position?.y ?? 0) + (NODE_H[centeredNode.data?.kind || 'device'] || 86) / 2) * scale)
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
    const kind = n.data?.kind || 'device'
    const preset = n.data?.preset || 'v2'
    const emphasis = Number.isFinite(n.data?.emphasis) ? n.data.emphasis : 1
    const baseWidth = (NODE_W[kind] || 220) * scale
    const baseHeight = (NODE_H[kind] || 86) * scale
    const minWidth = baseWidth * emphasis
    const minHeight = baseHeight * emphasis
    const fontSize = Math.max(12, 14 * scale)
    const maxWidth = minWidth * (kind === 'solution' ? 1.7 : 1.45)
    const estimated = _estimateNodeSizePx(n.data?.label, kind, minWidth, maxWidth, fontSize)
    const width = estimated.width
    const nodeHeight = Math.max(minHeight, estimated.height)
    const left = (n.position?.x ?? 0) * scale + offsetX - (width - baseWidth) / 2
    const top = (n.position?.y ?? 0) * scale + offsetY - (nodeHeight - baseHeight) / 2
    const style = NODE_STYLE[kind] || NODE_STYLE.device
    const radius = preset === 'v4' ? 14 : preset === 'v1' ? 20 : 999
    return { id: n.id, node: n, kind, width, nodeHeight, left, top, style, radius }
  }), [visibleNodes, scale, offsetX, offsetY])
  const resolvedLayoutNodes = useMemo(
    () => _resolveNodeCollisions(layoutNodes, { padding: 12, iterations: 14, pinnedId: centerNodeId }),
    [layoutNodes, centerNodeId]
  )
  const layoutById = useMemo(() => new Map(resolvedLayoutNodes.map((n) => [n.id, n])), [resolvedLayoutNodes])
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
          { x: 0, y: 0, scaleX: 1, scaleY: 1, duration: 0.7, ease: 'none' }
        )
        return
      }
      gsap.fromTo(
        el,
        { opacity: 0, scale: 0.86, y: 12, transformOrigin: '50% 50%' },
        { opacity: 1, scale: 1, y: 0, duration: 0.7, delay: i * 0.03, ease: 'power2.out' }
      )
    })
    prevLayoutRef.current = new Map(resolvedLayoutNodes.map(({ id, left, top, width, nodeHeight }) => [
      id,
      { left, top, width, height: nodeHeight },
    ]))
    return () => {
      resolvedLayoutNodes.forEach(({ id }) => {
        const el = nodeRefs.current.get(id)
        if (el) gsap.killTweensOf(el)
      })
    }
  }, [resolvedLayoutNodes])

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
            const sx = s.left + s.width / 2
            const sy = s.top + s.nodeHeight / 2
            const tx = t.left + t.width / 2
            const ty = t.top + t.nodeHeight / 2
            return <line key={e.id} x1={sx} y1={sy} x2={tx} y2={ty} stroke={e.style?.stroke || '#91caff'} strokeWidth={1.2} opacity={0.88} />
          })}
        </svg>
        {resolvedLayoutNodes.map(({ id, node, kind, width, nodeHeight, left, top, style, radius }, i) => {
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
                zIndex: node?.data?.raiseAbove ? 5 : 1,
                borderRadius: radius,
                border: `1.4px solid ${hex(style.stroke)}`,
                background: hex(style.fill),
                color: hex(style.text),
                fontWeight: 600,
                fontSize: Math.max(12, 14 * scale),
                boxShadow: '0 8px 24px rgba(0,0,0,0.08)',
                padding: '8px 12px',
                cursor: 'pointer',
                overflow: 'visible',
                userSelect: 'none',
                WebkitUserSelect: 'none',
                caretColor: 'transparent',
                outline: 'none',
                textAlign: 'center',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                lineHeight: 1.42,
              }}
            >
              <span style={{ display: 'block', lineHeight: 1.4, wordBreak: 'break-word' }}>{node.data?.label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
