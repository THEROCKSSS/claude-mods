// The hub's signature: every mod as a light orbiting Claude Code. On is amber, off is ash,
// waiting on a reload is brass and breathes. Hover a light to find its card; click to open it.
// One owner per transform: the frame loop turns the rings; hover only scales a node.
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { useReducedMotion } from 'motion/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'

import type { ModRow } from './hub'

const AMBER = new THREE.Color('#e3a857')
const ASH = new THREE.Color('#5b554c')
const BRASS = new THREE.Color('#e8d27a')

type Props = {
  mods: ModRow[]
  pending: string[]
  highlight: string | null
  onHighlight: (id: string | null) => void
  onOpen: (id: string) => void
}

type Placed = { mod: ModRow; position: THREE.Vector3; ring: number }

// Two tilted rings: the first holds up to 9 mods, the rest go on the outer one.
function place(mods: ModRow[]): Placed[] {
  const inner = mods.slice(0, 9)
  const outer = mods.slice(9)
  const ring = (list: ModRow[], radius: number, index: number) =>
    list.map((mod, i) => {
      const a = (i / Math.max(1, list.length)) * Math.PI * 2 + index * 0.4
      return { mod, ring: index, position: new THREE.Vector3(Math.cos(a) * radius, Math.sin(a * 2) * 0.18, Math.sin(a) * radius) }
    })
  return [...ring(inner, 2.1, 0), ...ring(outer, 3.3, 1)]
}

function hasWebGL() {
  try {
    const c = document.createElement('canvas')
    return Boolean(c.getContext('webgl2') ?? c.getContext('webgl'))
  } catch {
    return false
  }
}

export function Constellation(props: Props) {
  const reduce = useReducedMotion() ?? false
  const [isVisible, setIsVisible] = useState(() => document.visibilityState === 'visible')
  const [canDraw] = useState(hasWebGL)

  useEffect(() => {
    const on = () => setIsVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])

  if (!canDraw) return <FlatConstellation {...props} />

  return (
    <Canvas
      // A hidden tab or reduced motion draws only on change: no idle GPU work.
      frameloop={isVisible && !reduce ? 'always' : 'demand'}
      dpr={[1, 1.75]}
      camera={{ position: [0, 3.4, 8.6], fov: 40 }}
      gl={{ antialias: true, alpha: true, powerPreference: 'low-power' }}
      aria-hidden
    >
      <ambientLight intensity={0.35} />
      <pointLight position={[0, 0, 0]} intensity={18} distance={9} color="#f2c07a" />
      <FitCamera />
      <Scene {...props} reduce={reduce} />
    </Canvas>
  )
}

function Scene({ mods, pending, highlight, onHighlight, onOpen, reduce }: Props & { reduce: boolean }) {
  const rings = useRef<THREE.Group>(null)
  const placed = useMemo(() => place(mods), [mods])
  const stars = useMemo(() => {
    const g = new THREE.BufferGeometry()
    const pts = new Float32Array(420 * 3)
    for (let i = 0; i < pts.length; i += 3) {
      const r = 7 + Math.random() * 6
      const t = Math.random() * Math.PI * 2
      const p = Math.acos(2 * Math.random() - 1)
      pts.set([r * Math.sin(p) * Math.cos(t), r * Math.cos(p) * 0.6, r * Math.sin(p) * Math.sin(t)], i)
    }
    g.setAttribute('position', new THREE.BufferAttribute(pts, 3))
    return g
  }, [])
  const spokes = useMemo(() => {
    const g = new THREE.BufferGeometry()
    const on = placed.filter(p => p.mod.enabled)
    const pts = new Float32Array(on.length * 6)
    on.forEach((p, i) => pts.set([0, 0, 0, p.position.x, p.position.y, p.position.z], i * 6))
    g.setAttribute('position', new THREE.BufferAttribute(pts, 3))
    return g
  }, [placed])
  useEffect(() => () => stars.dispose(), [stars])
  useEffect(() => () => spokes.dispose(), [spokes])

  useFrame((_, dt) => {
    if (!rings.current || reduce) return
    rings.current.rotation.y += dt * 0.08
  })

  return (
    <group rotation={[0.32, 0, -0.08]}>
      <points geometry={stars}>
        <pointsMaterial size={0.035} color="#c9b89a" transparent opacity={0.55} sizeAttenuation />
      </points>
      <Core />
      <group ref={rings}>
        <lineSegments geometry={spokes}>
          <lineBasicMaterial color="#e3a857" transparent opacity={0.16} />
        </lineSegments>
        <OrbitRing radius={2.1} />
        {placed.some(p => p.ring === 1) && <OrbitRing radius={3.3} />}
        {placed.map(p => (
          <Node
            key={p.mod.id}
            placed={p}
            isPending={pending.includes(p.mod.id)}
            isLit={highlight === p.mod.id}
            reduce={reduce}
            onHighlight={onHighlight}
            onOpen={onOpen}
          />
        ))}
      </group>
    </group>
  )
}

// A box taller than it is wide (a phone) moves the camera back so the outer ring stays in frame.
function FitCamera() {
  const camera = useThree(t => t.camera)
  const aspect = useThree(t => t.size.width / Math.max(1, t.size.height))
  useEffect(() => {
    const k = aspect < 1.2 ? 1.2 / aspect : 1
    camera.position.set(0, 3.4 * k, 8.6 * k)
    camera.lookAt(0, 0, 0)
  }, [camera, aspect])
  return null
}

function Core() {
  const ref = useRef<THREE.Mesh>(null)
  useFrame((_, dt) => {
    if (ref.current) ref.current.rotation.y += dt * 0.25
  })
  return (
    <group>
      <mesh ref={ref}>
        <icosahedronGeometry args={[0.42, 1]} />
        <meshStandardMaterial color="#f0c27a" emissive="#c9852f" emissiveIntensity={1.4} flatShading roughness={0.4} />
      </mesh>
      <mesh>
        <sphereGeometry args={[0.7, 32, 32]} />
        <meshBasicMaterial color="#e3a857" transparent opacity={0.07} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
    </group>
  )
}

function OrbitRing({ radius }: { radius: number }) {
  return (
    <mesh rotation={[Math.PI / 2, 0, 0]}>
      <torusGeometry args={[radius, 0.004, 6, 160]} />
      <meshBasicMaterial color="#a08a66" transparent opacity={0.28} />
    </mesh>
  )
}

function Node({
  placed,
  isPending,
  isLit,
  reduce,
  onHighlight,
  onOpen,
}: {
  placed: Placed
  isPending: boolean
  isLit: boolean
  reduce: boolean
  onHighlight: (id: string | null) => void
  onOpen: (id: string) => void
}) {
  const mesh = useRef<THREE.Mesh>(null)
  const halo = useRef<THREE.Mesh>(null)
  const { mod, position } = placed
  const color = isPending ? BRASS : mod.enabled ? AMBER : ASH

  useFrame(({ clock }) => {
    if (!mesh.current || !halo.current) return
    const target = isLit ? 1.6 : 1
    const s = THREE.MathUtils.lerp(mesh.current.scale.x, target, 0.18)
    mesh.current.scale.setScalar(s)
    const breathe = isPending && !reduce ? 0.5 + Math.sin(clock.elapsedTime * 3) * 0.25 : mod.enabled ? 0.35 : 0.08
    const mat = halo.current.material as THREE.MeshBasicMaterial
    mat.opacity = isLit ? 0.5 : breathe * 0.6
    halo.current.scale.setScalar(s * 1.7)
  })

  const over = (ev: ThreeEvent<PointerEvent>) => {
    ev.stopPropagation()
    document.body.style.cursor = 'pointer'
    onHighlight(mod.id)
  }
  const out = () => {
    document.body.style.cursor = ''
    onHighlight(null)
  }

  return (
    <group position={position}>
      <mesh ref={mesh} onPointerOver={over} onPointerOut={out} onClick={() => onOpen(mod.id)}>
        <sphereGeometry args={[mod.isSelf ? 0.16 : 0.12, 24, 24]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={mod.enabled || isPending ? 1.1 : 0.15} roughness={0.35} />
      </mesh>
      <mesh ref={halo}>
        <sphereGeometry args={[0.12, 16, 16]} />
        <meshBasicMaterial color={color} transparent opacity={0.3} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
    </group>
  )
}

// Without WebGL: the same picture, flat and still, still hoverable and clickable.
function FlatConstellation({ mods, pending, highlight, onHighlight, onOpen }: Props) {
  const placed = place(mods)
  return (
    <svg viewBox="-4 -2.6 8 5.2" className="h-full w-full" role="img" aria-label={`${mods.length} mods, ${mods.filter(m => m.enabled).length} on`}>
      <circle r={0.42} fill="#e3a857" />
      {placed.map(p => {
        const color = pending.includes(p.mod.id) ? '#e8d27a' : p.mod.enabled ? '#e3a857' : '#5b554c'
        return (
          <g key={p.mod.id} transform={`translate(${p.position.x} ${p.position.z * 0.55})`} onMouseEnter={() => onHighlight(p.mod.id)} onMouseLeave={() => onHighlight(null)} onClick={() => onOpen(p.mod.id)} style={{ cursor: 'pointer' }}>
            <circle r={highlight === p.mod.id ? 0.22 : 0.13} fill={color} />
          </g>
        )
      })}
    </svg>
  )
}
