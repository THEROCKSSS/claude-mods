// The logic graph in 3D: mods on a sphere, shared parts inside, edges as lines. Drag to orbit,
// scroll to zoom, hover to light a part's connections, click to focus. Same layout code as 2D.
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { useReducedMotion } from 'motion/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

import { layout, nodeColor, nodeSize, type Graph, type GraphNode } from '../../../mod-logic/shared/logic'

const SCALE = 3.2

type Props = { graph: Graph; lit: string | null; changedMod?: string; onHover: (id: string | null) => void; onPick: (id: string) => void }

export function Logic3D(props: Props) {
  const [label, setLabel] = useState<{ text: string; x: number; y: number } | null>(null)
  return (
    <div className="relative h-full w-full" onPointerLeave={() => setLabel(null)}>
      <Canvas dpr={[1, 1.75]} camera={{ position: [0, 1.6, 11], fov: 42 }} gl={{ antialias: true, alpha: true, powerPreference: 'low-power' }}>
        <ambientLight intensity={0.5} />
        <pointLight position={[0, 0, 0]} intensity={14} distance={12} color="#f2c07a" />
        <directionalLight position={[4, 6, 5]} intensity={0.8} />
        <Controls />
        <Scene {...props} onLabel={setLabel} />
      </Canvas>
      {label && (
        <div className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-md border bg-popover px-2 py-1 text-xs whitespace-nowrap text-popover-foreground shadow" style={{ left: label.x, top: label.y - 10 }}>
          {label.text}
        </div>
      )}
    </div>
  )
}

// Orbit, zoom and damped motion; auto-rotate unless reduced motion is asked for.
function Controls() {
  const { camera, gl, invalidate } = useThree()
  const reduce = useReducedMotion() ?? false
  const ref = useRef<OrbitControls | null>(null)
  useEffect(() => {
    const c = new OrbitControls(camera, gl.domElement)
    c.enableDamping = true
    c.minDistance = 3
    c.maxDistance = 16
    c.autoRotate = !reduce
    c.autoRotateSpeed = 0.5
    const redraw = () => invalidate()
    c.addEventListener('change', redraw)
    ref.current = c
    return () => {
      c.removeEventListener('change', redraw)
      c.dispose()
    }
  }, [camera, gl, invalidate, reduce])
  useFrame(() => ref.current?.update())
  return null
}

function Scene({ graph, lit, changedMod, onHover, onPick, onLabel }: Props & { onLabel: (l: { text: string; x: number; y: number } | null) => void }) {
  const pos = useMemo(() => {
    const p = layout(graph, 3)
    return Object.fromEntries(Object.entries(p).map(([id, v]) => [id, new THREE.Vector3(v[0] * SCALE, v[1] * SCALE, v[2] * SCALE)]))
  }, [graph])
  const near = useMemo(() => (lit ? new Set([lit, ...graph.edges.filter(e => e.from === lit || e.to === lit).flatMap(e => [e.from, e.to])]) : null), [lit, graph])

  // Every edge in one geometry; a second one holds the lit edges, drawn brighter on top.
  const [all, hot] = useMemo(() => {
    const build = (edges: Graph['edges']) => {
      const g = new THREE.BufferGeometry()
      const pts = new Float32Array(edges.length * 6)
      edges.forEach((e, i) => {
        const a = pos[e.from]
        const b = pos[e.to]
        if (a && b) pts.set([a.x, a.y, a.z, b.x, b.y, b.z], i * 6)
      })
      g.setAttribute('position', new THREE.BufferAttribute(pts, 3))
      return g
    }
    return [build(graph.edges), build(lit ? graph.edges.filter(e => e.from === lit || e.to === lit) : [])]
  }, [graph, pos, lit])
  useEffect(() => () => all.dispose(), [all])
  useEffect(() => () => hot.dispose(), [hot])

  return (
    <group>
      <lineSegments geometry={all}>
        <lineBasicMaterial color="#6b6152" transparent opacity={near ? 0.08 : 0.28} />
      </lineSegments>
      <lineSegments geometry={hot}>
        <lineBasicMaterial color="#e3a857" transparent opacity={0.9} />
      </lineSegments>
      {graph.nodes.map(n => (
        <Node key={n.id} node={n} at={pos[n.id]!} dim={near !== null && !near.has(n.id)} isLit={n.id === lit} isChanged={changedMod !== undefined && n.id === `mod:${changedMod}`} onHover={onHover} onPick={onPick} onLabel={onLabel} />
      ))}
    </group>
  )
}

function Node({ node, at, dim, isLit, isChanged, onHover, onPick, onLabel }: { node: GraphNode; at: THREE.Vector3; dim: boolean; isLit: boolean; isChanged: boolean; onHover: (id: string | null) => void; onPick: (id: string) => void; onLabel: (l: { text: string; x: number; y: number } | null) => void }) {
  const mesh = useRef<THREE.Mesh>(null)
  const reduce = useReducedMotion() ?? false
  const color = useMemo(() => new THREE.Color(nodeColor(node)), [node])
  const size = nodeSize(node) * (node.kind === 'mod' ? 0.016 : 0.02)
  useFrame(({ clock }) => {
    if (!mesh.current) return
    const pulse = isChanged && !reduce ? 1 + Math.sin(clock.elapsedTime * 5) * 0.25 : 1
    const target = (isLit ? 1.6 : 1) * pulse
    mesh.current.scale.setScalar(THREE.MathUtils.lerp(mesh.current.scale.x, target, 0.2))
  })
  const over = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    document.body.style.cursor = 'pointer'
    onHover(node.id)
    onLabel({ text: `${node.label}${node.kind === 'mod' ? '' : ` · ${node.mods.length} mod${node.mods.length === 1 ? '' : 's'}`}`, x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY })
  }
  const out = () => {
    document.body.style.cursor = ''
    onHover(null)
    onLabel(null)
  }
  return (
    <mesh ref={mesh} position={at} onPointerOver={over} onPointerMove={over} onPointerOut={out} onClick={e => (e.stopPropagation(), onPick(node.id))}>
      {node.kind === 'mod' ? <sphereGeometry args={[size, 24, 24]} /> : node.kind === 'event' ? <torusGeometry args={[size, size * 0.32, 10, 28]} /> : <boxGeometry args={[size * 1.5, size * 1.5, size * 1.5]} />}
      <meshStandardMaterial color={color} emissive={color} emissiveIntensity={isChanged ? 1.2 : node.kind === 'mod' ? 0.55 : 0.35} transparent opacity={dim ? 0.18 : 1} roughness={0.4} />
    </mesh>
  )
}
