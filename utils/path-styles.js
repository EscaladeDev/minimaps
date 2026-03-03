export const PATH_SHAPE_MODES = ["smooth", "jagged"]

export function getDefaultPathShapeSettings(style = {}){
  const amplitude = clamp(Number(style.pathJaggedAmplitude), 0, 3.5, null)
  const frequency = clamp(Number(style.pathJaggedFrequency), 0.4, 2.4, null)
  const legacyJaggedness = clamp(Number(style.pathJaggedness), 0, 3.5, 1)
  return {
    shapeMode: normalizeShapeMode(style.pathShapeMode),
    smoothness: clamp(Number(style.pathSmoothness), 0, 1, 0.6),
    amplitude: amplitude ?? legacyJaggedness,
    frequency: frequency ?? legacyFrequencyFromSettings(style, legacyJaggedness)
  }
}

export function normalizePathShapeSettings(value = {}, fallbackStyle = {}){
  const defaults = getDefaultPathShapeSettings(fallbackStyle)
  const amplitude = firstFinite(
    value.amplitude,
    value.jaggedAmplitude,
    value.jaggedness,
    defaults.amplitude
  )
  const legacyJaggedness = clamp(Number(value.jaggedness), 0, 2, defaults.amplitude)
  const frequency = firstFinite(
    value.frequency,
    value.jaggedFrequency,
    frequencyFromLegacySpacing(value.jaggedSpacing),
    legacyFrequencyFromSettings(value, legacyJaggedness),
    defaults.frequency
  )
  return {
    shapeMode: normalizeShapeMode(value.shapeMode, defaults.shapeMode),
    smoothness: clamp(Number(value.smoothness), 0, 1, defaults.smoothness),
    amplitude: clamp(Number(amplitude), 0, 3.5, defaults.amplitude),
    frequency: clamp(Number(frequency), 0.4, 2.4, defaults.frequency)
  }
}


function legacyFrequencyFromSettings(value = {}, jaggedness = 1){
  const legacySpacing = frequencyFromLegacySpacing(value?.jaggedSpacing)
  if (legacySpacing != null) return legacySpacing
  const amp = clamp(Number(jaggedness), 0, 2, 1)
  return clamp(0.8 + amp * 0.24, 0.4, 2.4, 1)
}

function frequencyFromLegacySpacing(spacing){
  const n = Number(spacing)
  if (!Number.isFinite(n) || n <= 0) return null
  return clamp(16 / n, 0.4, 2.4, 1)
}

function firstFinite(...values){
  for (const value of values) {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return null
}

export function getRenderedPathPoints(points, settings = {}, options = {}){
  const pts = sanitizePoints(points)
  if (pts.length < 2) return pts
  const normalized = normalizePathShapeSettings(settings)
  return smoothStyledPoints(pts, normalized, options)
}

export function getPathRenderGeometry(points, settings = {}, options = {}){
  const pts = sanitizePoints(points)
  if (pts.length < 2) return { kind: "stroke", points: pts }
  const normalized = normalizePathShapeSettings(settings)
  const shapeOptions = normalizeGeometryOptions(options)
  const smoothPoints = smoothStyledPoints(pts, normalized, shapeOptions)
  if (normalized.shapeMode === "jagged") {
    const polygon = buildJaggedCorridorPolygon(smoothPoints, normalized, shapeOptions)
    if (polygon.length >= 3) return { kind: "polygon", points: polygon, centerline: smoothPoints }
  }
  return { kind: "stroke", points: smoothPoints }
}

function smoothStyledPoints(points, settings, options){
  const width = Math.max(2, Number(options.width || 0) || 48)
  const strength = clamp(Number(settings.smoothness), 0, 1, 0.6)
  const preview = !!options.preview
  const pointBudget = Math.max(48, Number(options.pointBudget) || (preview ? 160 : 420))
  if (strength <= 0.001 || points.length < 3) return limitPointCount(points.slice(), pointBudget)
  const simplifyDist = Math.max(2, width * (preview ? (0.085 + strength * 0.05) : (0.035 + strength * 0.03)))
  const simplified = simplifyByDistance(points, simplifyDist)
  const iterations = strength >= 0.75 ? 2 : 1
  let out = simplified.length >= 2 ? simplified : points.slice()
  for (let k = 0; k < iterations; k++) {
    const next = [out[0]]
    for (let i = 0; i < out.length - 1; i++) {
      const p0 = out[i]
      const p1 = out[i + 1]
      const q = lerpPoint(p0, p1, 0.25)
      const r = lerpPoint(p0, p1, 0.75)
      next.push(q, r)
    }
    next.push(out[out.length - 1])
    out = next
  }
  return limitPointCount(out, pointBudget)
}

function buildJaggedCorridorPolygon(points, settings, options){
  const width = Math.max(2, Number(options.width || 0) || 48)
  const preview = !!options.preview
  const amplitude = clamp(Number(settings.amplitude), 0, 3.5, 1)
  const frequency = clamp(Number(settings.frequency), 0.4, 2.4, 1)
  const pathLen = polylineLength(points)
  if (pathLen < 2) return []

  const seedBase = hashString(String(options.seed ?? "")) || hashPoints(points)
  const half = width * 0.5
  const spacingBase = Math.max(width * 0.18, width * (0.96 - frequency * 0.28), 6)
  const railStep = Math.max(4, Math.min(width * (preview ? 0.18 : 0.14), spacingBase * 0.4, preview ? 12 : 10))
  const sourceSimplify = Math.max(1.5, width * (preview ? 0.028 : 0.018))
  const source = simplifyByDistance(points, sourceSimplify)
  const centerline = resamplePolyline(source, railStep)
  if (centerline.length < 2) return []

  const stations = buildStations(centerline)
  const totalLength = stations.totalLength
  if (totalLength < 2) return []

  const toothSpacing = Math.max(width * 0.16, spacingBase)
  const depthBase = half * (0.28 + amplitude * 0.44) * (preview ? 0.92 : 1)
  const widthBase = Math.max(toothSpacing * (1.65 + amplitude * 0.18), width * (1.4 + amplitude * 0.30))
  const shoulder = 0.22 + amplitude * 0.03

  const leftEvents = buildToothEvents(totalLength, {
    spacing: toothSpacing,
    widthBase,
    depthBase,
    shoulder,
    amplitude,
    frequency,
    seed: seedBase ^ 0x9e3779b9,
    preview
  })
  const rightEvents = buildToothEvents(totalLength, {
    spacing: toothSpacing,
    widthBase,
    depthBase,
    shoulder,
    amplitude,
    frequency,
    seed: seedBase ^ 0x85ebca6b,
    preview
  })

  const leftRail = []
  const rightRail = []
  const pointBudget = Math.max(140, Number(options.pointBudget) || (preview ? 420 : 1800))
  const displacementLookRadius = Math.max(widthBase * 0.72, toothSpacing * 2.1)

  for (let i = 0; i < stations.points.length; i++) {
    const s = stations.points[i].s
    const base = stations.points[i]
    const curvature = localCurvature(stations.points, i)
    const capFade = endCapFade(s, totalLength, half)

    const leftDisp = evaluateToothField(leftEvents, s, displacementLookRadius) * curvatureDepthFactor(curvature, amplitude) * capFade
    const rightDisp = evaluateToothField(rightEvents, s, displacementLookRadius) * curvatureDepthFactor(curvature, amplitude) * capFade

    leftRail.push({
      x: base.x + base.nx * (half + leftDisp),
      y: base.y + base.ny * (half + leftDisp)
    })
    rightRail.push({
      x: base.x - base.nx * (half + rightDisp),
      y: base.y - base.ny * (half + rightDisp)
    })
  }

  let polygon = buildClosedCorridorPolygon(leftRail, rightRail)
  polygon = cleanupJaggedPolygon(polygon, {
    minSeg: Math.max(2, width * (preview ? 0.03 : 0.022)),
    spikeArea: Math.max(7, width * width * (preview ? 0.01 : 0.008)),
    passes: preview ? 2 : 3
  })
  polygon = dedupeSequential(polygon)
  return limitPointCount(polygon, pointBudget)
}

function buildStations(points){
  const out = []
  let s = 0
  for (let i = 0; i < points.length; i++) {
    const prev = points[Math.max(0, i - 1)]
    const curr = points[i]
    const next = points[Math.min(points.length - 1, i + 1)]
    if (i > 0) s += Math.hypot(curr.x - points[i - 1].x, curr.y - points[i - 1].y)
    const tx = next.x - prev.x
    const ty = next.y - prev.y
    const tLen = Math.hypot(tx, ty) || 1
    const ux = tx / tLen
    const uy = ty / tLen
    out.push({ x: curr.x, y: curr.y, s, tx: ux, ty: uy, nx: -uy, ny: ux })
  }
  return { points: out, totalLength: s }
}

function buildToothEvents(totalLength, opts){
  const {
    spacing,
    widthBase,
    depthBase,
    shoulder = 0.34,
    amplitude = 1,
    frequency = 1,
    seed = 1,
    preview = false
  } = opts
  const events = []
  const clusterSpan = Math.max(widthBase * 1.55, spacing * 4.1)
  const minGap = Math.max(spacing * 0.12, widthBase * 0.04)
  const maxEvents = Math.min(preview ? 160 : 420, Math.max(10, Math.ceil(totalLength / Math.max(8, spacing * 0.54)) + 12))
  let cursor = spacing * (0.28 + seededUnit(seed + 7) * 0.4)
  let index = 0

  while (cursor < totalLength - spacing * 0.45 && events.length < maxEvents) {
    const clusterIndex = Math.floor(cursor / clusterSpan)
    const clusterSeed = seed + clusterIndex * 6151
    const clusterDensity = 0.68 + seededUnit(clusterSeed + 11) * 0.88
    const clusterWidth = 0.76 + seededUnit(clusterSeed + 29) * 0.94
    const clusterDepth = 0.84 + seededUnit(clusterSeed + 47) * 1.10
    const clusterCalm = seededUnit(clusterSeed + 71)

    const widthJitter = 0.74 + seededUnit(seed + index * 977 + 19) * (0.92 + amplitude * 0.28)
    const depthJitter = 0.82 + seededUnit(seed + index * 977 + 41) * (0.96 + amplitude * 0.42)
    const gapJitter = 0.72 + seededUnit(seed + index * 977 + 83) * (0.56 + frequency * 0.06)
    const shapeJitter = seededUnit(seed + index * 977 + 127)

    const width = widthBase * clusterWidth * widthJitter
    const depth = depthBase * clusterDepth * depthJitter
    const profile = shapeJitter < 0.48 ? "peak" : (shapeJitter < 0.78 ? "plateau" : "blunt")
    events.push({ center: cursor, width, depth, shoulder, profile })

    let gap = spacing * clusterDensity * gapJitter
    if (clusterCalm > 0.88) gap *= 1.22
    gap = Math.max(minGap, gap)
    cursor += width * (0.42 + seededUnit(seed + index * 977 + 163) * 0.10) + gap
    index += 1
  }
  return events
}

function evaluateToothField(events, s, radius){
  let value = 0
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]
    const dx = Math.abs(s - ev.center)
    const reach = ev.width * 0.5
    if (dx > radius + reach) continue
    const local = toothProfileValue(ev, dx)
    if (local > value) value = local
  }
  return value
}

function toothProfileValue(event, dx){
  const half = Math.max(1, event.width * 0.5)
  if (dx >= half) return 0
  const u = dx / half
  if (event.profile === "peak") {
    const rise = 0.34
    if (u <= rise) {
      const k = u / Math.max(0.001, rise)
      return event.depth * (0.22 + 0.78 * Math.sin(k * Math.PI * 0.5))
    }
    const k = (u - rise) / Math.max(0.001, 1 - rise)
    return event.depth * Math.pow(1 - k, 0.8)
  }
  if (event.profile === "plateau") {
    const flat = 0.16
    if (u <= flat) return event.depth
    const k = (u - flat) / Math.max(0.001, 1 - flat)
    return event.depth * Math.pow(1 - k, 1.05)
  }
  return event.depth * Math.pow(1 - u, 0.95)
}

function endCapFade(s, totalLength, halfWidth){
  const capLen = Math.max(halfWidth * 0.9, 10)
  const start = smoothstep(0, capLen, s)
  const end = smoothstep(0, capLen, totalLength - s)
  return Math.min(start, end)
}

function curvatureDepthFactor(curvature, amplitude){
  const scaled = Math.max(0, curvature)
  const soften = 1 / (1 + scaled * (18 + amplitude * 10))
  return clamp(0.58 + soften * 0.42, 0.58, 1, 1)
}

function localCurvature(points, index){
  if (index <= 0 || index >= points.length - 1) return 0
  const a = points[index - 1]
  const b = points[index]
  const c = points[index + 1]
  const abx = b.x - a.x, aby = b.y - a.y
  const bcx = c.x - b.x, bcy = c.y - b.y
  const lab = Math.hypot(abx, aby)
  const lbc = Math.hypot(bcx, bcy)
  if (lab < 0.0001 || lbc < 0.0001) return 0
  const dot = clamp((abx * bcx + aby * bcy) / (lab * lbc), -1, 1, 1)
  const angle = Math.acos(dot)
  return angle / Math.max(8, (lab + lbc) * 0.5)
}

function buildClosedCorridorPolygon(leftRail, rightRail){
  const left = dedupeSequential(leftRail)
  const right = dedupeSequential(rightRail)
  if (left.length < 2 || right.length < 2) return []
  const polygon = []
  for (let i = 0; i < left.length; i++) polygon.push(left[i])
  for (let i = right.length - 1; i >= 0; i--) polygon.push(right[i])
  return polygon
}

function resamplePolyline(points, step){
  if (!Array.isArray(points) || points.length < 2) return Array.isArray(points) ? points.slice() : []
  const total = polylineLength(points)
  const distStep = Math.max(2, Number(step) || 0)
  if (total <= distStep * 1.2) return points.slice()
  const out = [{ ...points[0] }]
  let t = distStep
  while (t < total) {
    out.push(pointAtLength(points, t))
    t += distStep
  }
  out.push({ ...points[points.length - 1] })
  return dedupeSequential(out)
}

function cleanupJaggedPolygon(points, opts = {}){
  let out = dedupeSequential(points)
  if (out.length < 4) return out
  const minSeg = Math.max(1, Number(opts.minSeg) || 0)
  const spikeArea = Math.max(1, Number(opts.spikeArea) || 0)
  const passes = Math.max(1, Math.min(4, Number(opts.passes) || 1))
  for (let pass = 0; pass < passes; pass++) {
    out = removeTinySegments(out, minSeg)
    out = removeNeedleSpikes(out, spikeArea)
    out = dedupeSequential(out)
    if (out.length < 4) break
  }
  return out
}

function removeTinySegments(points, minSeg){
  if (!Array.isArray(points) || points.length < 4) return Array.isArray(points) ? points.slice() : []
  const out = [points[0]]
  for (let i = 1; i < points.length - 1; i++) {
    const prev = out[out.length - 1]
    const curr = points[i]
    const next = points[i + 1]
    if (distanceSq(prev, curr) < minSeg * minSeg || distanceSq(curr, next) < minSeg * minSeg) continue
    out.push(curr)
  }
  out.push(points[points.length - 1])
  return out
}

function removeNeedleSpikes(points, areaThreshold){
  if (!Array.isArray(points) || points.length < 4) return Array.isArray(points) ? points.slice() : []
  const out = [points[0]]
  for (let i = 1; i < points.length - 1; i++) {
    const a = out[out.length - 1]
    const b = points[i]
    const c = points[i + 1]
    const area2 = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x))
    const base = Math.hypot(c.x - a.x, c.y - a.y)
    const height = base < 0.0001 ? 0 : area2 / base
    const ab = Math.hypot(b.x - a.x, b.y - a.y)
    const bc = Math.hypot(c.x - b.x, c.y - b.y)
    const acute = dotUnit(a, b, c)
    if (height * Math.max(ab, bc) < areaThreshold && acute > 0.84) continue
    out.push(b)
  }
  out.push(points[points.length - 1])
  return out
}

function dotUnit(a, b, c){
  const abx = a.x - b.x, aby = a.y - b.y
  const cbx = c.x - b.x, cby = c.y - b.y
  const lab = Math.hypot(abx, aby)
  const lcb = Math.hypot(cbx, cby)
  if (lab < 0.0001 || lcb < 0.0001) return 1
  return (abx * cbx + aby * cby) / (lab * lcb)
}

function polylineLength(points){
  let total = 0
  for (let i = 0; i < points.length - 1; i++) total += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y)
  return total
}

function pointAtLength(points, target){
  if (!points.length) return { x: 0, y: 0 }
  if (target <= 0) return { ...points[0] }
  let acc = 0
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]
    const b = points[i + 1]
    const segLen = Math.hypot(b.x - a.x, b.y - a.y)
    if (acc + segLen >= target) {
      const t = segLen < 0.0001 ? 0 : (target - acc) / segLen
      return lerpPoint(a, b, t)
    }
    acc += segLen
  }
  return { ...points[points.length - 1] }
}

function simplifyByDistance(points, minDist){
  if (!Array.isArray(points) || points.length < 3 || minDist <= 0.001) return points.slice()
  const out = [points[0]]
  const minDistSq = minDist * minDist
  for (let i = 1; i < points.length - 1; i++) {
    if (distanceSq(out[out.length - 1], points[i]) >= minDistSq) out.push(points[i])
  }
  out.push(points[points.length - 1])
  return out
}

function dedupeSequential(points){
  if (!Array.isArray(points) || points.length < 2) return Array.isArray(points) ? points.slice() : []
  const out = [points[0]]
  for (let i = 1; i < points.length; i++) {
    if (distanceSq(out[out.length - 1], points[i]) > 0.001) out.push(points[i])
  }
  return out
}

function distanceSq(a, b){
  const dx = (a?.x || 0) - (b?.x || 0)
  const dy = (a?.y || 0) - (b?.y || 0)
  return dx * dx + dy * dy
}

function sanitizePoints(points){
  if (!Array.isArray(points)) return []
  const out = []
  for (const pt of points) {
    const x = Number(pt?.x)
    const y = Number(pt?.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    if (out.length) {
      const prev = out[out.length - 1]
      if (Math.abs(prev.x - x) < 0.001 && Math.abs(prev.y - y) < 0.001) continue
    }
    out.push({ x, y })
  }
  return out
}

function lerpPoint(a, b, t){
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

function smoothstep(edge0, edge1, x){
  if (edge1 <= edge0) return x >= edge1 ? 1 : 0
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1, 0)
  return t * t * (3 - 2 * t)
}

function hashPoints(points){
  let h = 2166136261 >>> 0
  for (const p of points) {
    h ^= ((Math.round(p.x * 10) * 73856093) ^ (Math.round(p.y * 10) * 19349663)) >>> 0
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function hashString(str){
  let h = 2166136261 >>> 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function seededUnit(seed){
  let x = (seed >>> 0) || 1
  x ^= x << 13
  x ^= x >>> 17
  x ^= x << 5
  return ((x >>> 0) % 1000) / 1000
}

function normalizeGeometryOptions(options = {}){
  const preview = options.preview === true
  const pointBudget = Number(options.pointBudget)
  return {
    ...options,
    preview,
    pointBudget: Number.isFinite(pointBudget) ? pointBudget : (preview ? 220 : 520)
  }
}

function limitPointCount(points, maxPoints){
  if (!Array.isArray(points) || points.length <= 2) return Array.isArray(points) ? points.slice() : []
  const budget = Math.max(8, Math.floor(Number(maxPoints) || 0))
  if (points.length <= budget) return points.slice()
  const out = [points[0]]
  const interior = points.length - 2
  const take = budget - 2
  for (let i = 1; i <= take; i++) {
    const idx = 1 + Math.round((i * interior) / Math.max(1, take + 1))
    out.push(points[Math.min(points.length - 2, idx)])
  }
  out.push(points[points.length - 1])
  return dedupeSequential(out)
}

function normalizeShapeMode(value, fallback = "smooth"){
  if (value === "raw") return "smooth"
  return PATH_SHAPE_MODES.includes(value) ? value : fallback
}

function clamp(value, min, max, fallback){
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, value))
}
