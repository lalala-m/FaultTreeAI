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
    const width = baseWidth * emphasis
    const nodeHeight = baseHeight * emphasis
    const left = (n.position?.x ?? 0) * scale + offsetX - (width - baseWidth) / 2
    const top = (n.position?.y ?? 0) * scale + offsetY - (nodeHeight - baseHeight) / 2
    const style = NODE_STYLE[kind] || NODE_STYLE.device
    const radius = preset === 'v4' ? 14 : preset === 'v1' ? 20 : 999
    return { id: n.id, node: n, kind, width, nodeHeight, left, top, style, radius }
  }), [visibleNodes, scale, offsetX, offsetY])
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
    layoutNodes.forEach(({ id, node, left, top, width, nodeHeight }, i) => {
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
    prevLayoutRef.current = new Map(layoutNodes.map(({ id, left, top, width, nodeHeight }) => [
      id,
      { left, top, width, height: nodeHeight },
    ]))
    return () => {
      layoutNodes.forEach(({ id }) => {
        const el = nodeRefs.current.get(id)
        if (el) gsap.killTweensOf(el)
      })
    }
  }, [layoutNodes])

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
            const s = byId.get(e.source)
            const t = byId.get(e.target)
            if (!s || !t) return null
            const sk = s.data?.kind || 'device'
            const tk = t.data?.kind || 'device'
            const sx = ((s.position?.x ?? 0) + (NODE_W[sk] || 220) / 2) * scale + offsetX
            const sy = ((s.position?.y ?? 0) + (NODE_H[sk] || 86) / 2) * scale + offsetY
            const tx = ((t.position?.x ?? 0) + (NODE_W[tk] || 220) / 2) * scale + offsetX
            const ty = ((t.position?.y ?? 0) + (NODE_H[tk] || 86) / 2) * scale + offsetY
            return <line key={e.id} x1={sx} y1={sy} x2={tx} y2={ty} stroke={e.style?.stroke || '#91caff'} strokeWidth={1.2} opacity={0.88} />
          })}
        </svg>
        {layoutNodes.map(({ id, node, kind, width, nodeHeight, left, top, style, radius }, i) => {
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
