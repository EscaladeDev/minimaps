function makeRng(seed0){
  let seed = (seed0 >>> 0) || 0x9e3779b9
  return function(){
    seed ^= seed << 13; seed >>>= 0
    seed ^= seed >>> 17; seed >>>= 0
    seed ^= seed << 5; seed >>>= 0
    return (seed & 0x7fffffff) / 0x80000000
  }
}

function hexToRgb(hex, fallback = { r: 110, g: 184, b: 255 }){
  const raw = String(hex || '').trim()
  const m = raw.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (!m) return { ...fallback }
  let v = m[1]
  if (v.length === 3) v = v.split('').map(ch => ch + ch).join('')
  const n = parseInt(v, 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

function clampByte(v){
  return Math.max(0, Math.min(255, Math.round(v)))
}

function rgbaString(rgb, alpha = 1){
  return `rgba(${clampByte(rgb.r)}, ${clampByte(rgb.g)}, ${clampByte(rgb.b)}, ${Math.max(0, Math.min(1, alpha))})`
}

function shiftRgb(rgb, amount){
  return { r: clampByte(rgb.r + amount), g: clampByte(rgb.g + amount), b: clampByte(rgb.b + amount) }
}

function mixRgb(a, b, t){
  const u = Math.max(0, Math.min(1, t))
  return {
    r: clampByte(a.r + (b.r - a.r) * u),
    g: clampByte(a.g + (b.g - a.g) * u),
    b: clampByte(a.b + (b.b - a.b) * u)
  }
}

function scaleRgb(rgb, factor){
  return {
    r: clampByte(rgb.r * factor),
    g: clampByte(rgb.g * factor),
    b: clampByte(rgb.b * factor)
  }
}

function ensureWaterStyleDefaults(water){
  if (!Number.isFinite(Number(water.outlinePx))) water.outlinePx = 10
  if (!Number.isFinite(Number(water.ripplePx))) water.ripplePx = 7
  if (!Number.isFinite(Number(water.rippleSpacing))) water.rippleSpacing = 110
  if (!Number.isFinite(Number(water.glowStrength))) water.glowStrength = 1.28
  if (!Number.isFinite(Number(water.depthStrength))) water.depthStrength = 1.12
  if (!Number.isFinite(Number(water.sparkleAmount))) water.sparkleAmount = 0.34
  if (!Number.isFinite(Number(water.centerGlow))) water.centerGlow = 1.22
  if (!Number.isFinite(Number(water.seamBright))) water.seamBright = 1.34
  if (!Number.isFinite(Number(water.cellSize))) water.cellSize = 1.32
  return water
}

function makeDownscaledAlpha(rawWaterMaskCanvas, targetLongest = 900){
  const srcW = rawWaterMaskCanvas.width, srcH = rawWaterMaskCanvas.height
  const longest = Math.max(srcW, srcH)
  const scale = longest > targetLongest ? (targetLongest / longest) : 1
  const dw = Math.max(1, Math.round(srcW * scale))
  const dh = Math.max(1, Math.round(srcH * scale))
  const small = document.createElement('canvas')
  small.width = dw; small.height = dh
  const sctx = small.getContext('2d', { willReadFrequently: true })
  sctx.imageSmoothingEnabled = true
  sctx.drawImage(rawWaterMaskCanvas, 0, 0, dw, dh)
  const img = sctx.getImageData(0,0,dw,dh)
  const alpha = img.data
  const aAt = (x,y) => {
    const ix = Math.max(0, Math.min(dw-1, Math.round(x)))
    const iy = Math.max(0, Math.min(dh-1, Math.round(y)))
    return alpha[(iy*dw + ix)*4 + 3]
  }
  return { small, dw, dh, scaleX: srcW / dw, scaleY: srcH / dh, alpha, aAt }
}

function drawOuterRing(rawWaterMaskCanvas, outCtx, outlinePx, color, alpha = 1){
  const w = rawWaterMaskCanvas.width, h = rawWaterMaskCanvas.height
  const ring = document.createElement('canvas')
  ring.width = w; ring.height = h
  const rctx = ring.getContext('2d')
  rctx.imageSmoothingEnabled = true
  const rad = Math.max(2, outlinePx * 0.55)
  const steps = Math.max(16, Math.ceil(rad * 7))
  for (let i=0;i<steps;i++){
    const a = (i / steps) * Math.PI * 2
    const ox = Math.cos(a) * rad
    const oy = Math.sin(a) * rad
    rctx.drawImage(rawWaterMaskCanvas, ox, oy)
  }
  rctx.globalCompositeOperation = 'destination-out'
  rctx.drawImage(rawWaterMaskCanvas, 0, 0)
  rctx.globalCompositeOperation = 'source-in'
  rctx.globalAlpha = alpha
  rctx.fillStyle = color
  rctx.fillRect(0,0,w,h)
  rctx.globalAlpha = 1
  rctx.globalCompositeOperation = 'source-over'
  outCtx.drawImage(ring, 0, 0)
}

function buildInnerBand(maskCanvas, radiusPx){
  const w = maskCanvas.width, h = maskCanvas.height
  const band = document.createElement('canvas')
  band.width = w; band.height = h
  const bctx = band.getContext('2d')
  bctx.drawImage(maskCanvas, 0, 0)

  const eroded = document.createElement('canvas')
  eroded.width = w; eroded.height = h
  const ectx = eroded.getContext('2d')
  ectx.drawImage(maskCanvas, 0, 0)
  ectx.globalCompositeOperation = 'destination-in'
  const rad = Math.max(1.5, radiusPx)
  const steps = Math.max(12, Math.ceil(rad * 6))
  for (let i=0;i<steps;i++){
    const a = (i / steps) * Math.PI * 2
    const ox = Math.cos(a) * rad
    const oy = Math.sin(a) * rad
    ectx.drawImage(maskCanvas, ox, oy)
  }
  ectx.globalCompositeOperation = 'source-over'

  bctx.globalCompositeOperation = 'destination-out'
  bctx.drawImage(eroded, 0, 0)
  bctx.globalCompositeOperation = 'source-over'
  return band
}

function seedHashFromMask(srcW, srcH, filled){
  return (((filled * 2654435761) ^ (srcW << 7) ^ srcH) >>> 0)
}

function collectMaskBounds(ds){
  const { dw, dh, aAt } = ds
  let minx = dw, miny = dh, maxx = -1, maxy = -1, filled = 0
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      if (aAt(x, y) <= 18) continue
      filled++
      if (x < minx) minx = x
      if (y < miny) miny = y
      if (x > maxx) maxx = x
      if (y > maxy) maxy = y
    }
  }
  return { minx, miny, maxx, maxy, filled }
}

function buildSeedField(ds, water, baseSeed){
  const { dw, dh, scaleX, scaleY, aAt } = ds
  const bounds = collectMaskBounds(ds)
  if (!bounds.filled) return { ...bounds, seeds: [], cellStepX: 1, cellStepY: 1, grid: new Map() }
  const { minx, miny, maxx, maxy } = bounds
  const inside = (x, y) => aAt(x, y) > 18
  const cellSizePx = Math.max(82, Number(water.rippleSpacing || 110) * Math.max(0.82, Math.min(2.05, Number(water.cellSize || 1.32))) * 1.28)
  const cellStepX = Math.max(12, cellSizePx / Math.max(1, scaleX))
  const cellStepY = Math.max(12, cellSizePx / Math.max(1, scaleY))
  const cols = Math.max(1, Math.ceil((maxx - minx + 1) / cellStepX))
  const rows = Math.max(1, Math.ceil((maxy - miny + 1) / cellStepY))
  const rng = makeRng(baseSeed)
  const seeds = []
  const grid = new Map()
  const gridKey = (gx, gy) => `${gx},${gy}`
  const registerSeed = (seed) => {
    const gx = Math.floor((seed.x - minx) / cellStepX)
    const gy = Math.floor((seed.y - miny) / cellStepY)
    const key = gridKey(gx, gy)
    const list = grid.get(key) || []
    list.push(seed)
    grid.set(key, list)
  }
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const cx = minx + (col + 0.5) * cellStepX
      const cy = miny + (row + 0.5) * cellStepY
      let placed = false
      for (let attempt = 0; attempt < 6; attempt++) {
        const jx = (rng() - 0.5) * cellStepX * 0.58
        const jy = (rng() - 0.5) * cellStepY * 0.58
        const sx = Math.max(minx, Math.min(maxx, cx + jx))
        const sy = Math.max(miny, Math.min(maxy, cy + jy))
        if (!inside(sx, sy)) continue
        const tone = (rng() - 0.5) * 22 - rng() * 8
        const bias = rng()
        const seed = { id: seeds.length, x: sx, y: sy, tone, bias }
        seeds.push(seed)
        registerSeed(seed)
        placed = true
        break
      }
      if (!placed && inside(cx, cy)) {
        const seed = { id: seeds.length, x: cx, y: cy, tone: (rng() - 0.5) * 14 - rng() * 6, bias: rng() }
        seeds.push(seed)
        registerSeed(seed)
      }
    }
  }
  return { ...bounds, seeds, cellStepX, cellStepY, grid, inside }
}

function assignVoronoi(ds, field){
  const { dw, dh } = ds
  const { minx, miny, maxx, maxy, seeds, cellStepX, cellStepY, grid, inside } = field
  const idBuf = new Int32Array(dw * dh)
  idBuf.fill(-1)
  const distBuf = new Float32Array(dw * dh)
  distBuf.fill(1e9)
  const gridKey = (gx, gy) => `${gx},${gy}`
  const findNearestSeed = (x, y) => {
    const gx = Math.floor((x - minx) / cellStepX)
    const gy = Math.floor((y - miny) / cellStepY)
    let best = null
    let bestDist = Infinity
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const list = grid.get(gridKey(gx + ox, gy + oy))
        if (!list) continue
        for (const seed of list) {
          const dx = x - seed.x
          const dy = y - seed.y
          const dist = dx * dx + dy * dy
          if (dist < bestDist) {
            bestDist = dist
            best = seed
          }
        }
      }
    }
    if (best) return { seed: best, dist: bestDist }
    let fallback = seeds[0]
    bestDist = (x - fallback.x) ** 2 + (y - fallback.y) ** 2
    for (let i = 1; i < seeds.length; i++) {
      const seed = seeds[i]
      const dist = (x - seed.x) ** 2 + (y - seed.y) ** 2
      if (dist < bestDist) { bestDist = dist; fallback = seed }
    }
    return { seed: fallback, dist: bestDist }
  }
  for (let y = miny; y <= maxy; y++) {
    for (let x = minx; x <= maxx; x++) {
      if (!inside(x, y)) continue
      const { seed, dist } = findNearestSeed(x, y)
      const idx = y * dw + x
      idBuf[idx] = seed.id
      distBuf[idx] = dist
    }
  }
  const boundary = new Uint8Array(dw * dh)
  for (let y = miny; y <= maxy; y++) {
    for (let x = minx; x <= maxx; x++) {
      const idx = y * dw + x
      const id = idBuf[idx]
      if (id < 0) continue
      const right = (x < dw - 1) ? idBuf[idx + 1] : id
      const down = (y < dh - 1) ? idBuf[idx + dw] : id
      const diag = (x < dw - 1 && y < dh - 1) ? idBuf[idx + dw + 1] : id
      if ((right >= 0 && right !== id) || (down >= 0 && down !== id) || (diag >= 0 && diag !== id)) boundary[idx] = 1
    }
  }
  return { idBuf, distBuf, boundary }
}

function drawMaskedGradient(out, maskCanvas, bounds, water){
  const w = maskCanvas.width, h = maskCanvas.height
  const ctx = out.getContext('2d')
  ctx.clearRect(0, 0, w, h)
  ctx.drawImage(maskCanvas, 0, 0)
  ctx.globalCompositeOperation = 'source-in'

  const base = hexToRgb(water.color || '#6bb8ff', { r: 60, g: 182, b: 204 })
  const edgeDepth = Math.max(0.2, Math.min(1.8, Number(water.depthStrength || 0.95)))
  const glow = Math.max(0.2, Math.min(1.8, Number(water.centerGlow || 1.05)))
  const opacity = Math.max(0.08, Math.min(0.96, Number(water.opacity || 0.4)))

  const dark = mixRgb(scaleRgb(base, 0.22), { r: 0, g: 38, b: 48 }, 0.76)
  const deep = mixRgb(scaleRgb(base, 0.46), { r: 0, g: 88, b: 100 }, 0.44)
  const mid = mixRgb(base, { r: 18, g: 186, b: 196 }, 0.34)
  const bright = mixRgb(base, { r: 162, g: 255, b: 246 }, Math.max(0.54, glow * 0.62))
  const core = mixRgb(bright, { r: 238, g: 255, b: 251 }, Math.max(0.26, glow * 0.22))

  const cx = (bounds.minx + bounds.maxx) * 0.54
  const cy = (bounds.miny + bounds.maxy) * 0.42
  const maxR = Math.max(w, h) * (0.64 + edgeDepth * 0.04)
  const grad = ctx.createRadialGradient(
    cx,
    cy,
    Math.max(16, Math.min(w, h) * 0.05),
    cx,
    cy,
    maxR
  )
  grad.addColorStop(0, rgbaString(core, 1))
  grad.addColorStop(0.14, rgbaString(bright, 1))
  grad.addColorStop(0.34, rgbaString(mid, 1))
  grad.addColorStop(0.68, rgbaString(deep, 1))
  grad.addColorStop(1, rgbaString(dark, 1))
  ctx.globalAlpha = Math.min(0.98, opacity * 1.15)
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, w, h)

  const edgeShade = buildInnerBand(maskCanvas, Math.max(14, Number(water.outlinePx || 10) * (2.7 + edgeDepth * 0.9)))
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = 0.22 + edgeDepth * 0.22
  ctx.drawImage(edgeShade, 0, 0)
  ctx.globalCompositeOperation = 'source-in'
  ctx.fillStyle = rgbaString(mixRgb(dark, { r: 0, g: 62, b: 72 }, 0.3), 0.96)
  ctx.fillRect(0, 0, w, h)

  const coreGlow = document.createElement('canvas')
  coreGlow.width = w; coreGlow.height = h
  const gctx = coreGlow.getContext('2d')
  const glowGrad = gctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.42)
  glowGrad.addColorStop(0, rgbaString({ r: 236, g: 255, b: 250 }, 0.9))
  glowGrad.addColorStop(0.22, rgbaString(bright, 0.42 + glow * 0.12))
  glowGrad.addColorStop(0.58, rgbaString(base, 0.08 + glow * 0.03))
  glowGrad.addColorStop(1, 'rgba(0,0,0,0)')
  gctx.fillStyle = glowGrad
  gctx.fillRect(0, 0, w, h)
  gctx.globalCompositeOperation = 'destination-in'
  gctx.drawImage(maskCanvas, 0, 0)
  gctx.globalCompositeOperation = 'source-over'
  ctx.globalCompositeOperation = 'screen'
  ctx.globalAlpha = 0.42 + glow * 0.12
  ctx.drawImage(coreGlow, 0, 0)

  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
  return out
}

function drawSubmergedBlobs(destCtx, rawMaskCanvas, water, seed){
  const w = rawMaskCanvas.width, h = rawMaskCanvas.height
  const blobCanvas = document.createElement('canvas')
  blobCanvas.width = w; blobCanvas.height = h
  const bctx = blobCanvas.getContext('2d')
  const rng = makeRng(seed ^ 0x6d2b79f5)
  const count = Math.max(12, Math.round((w * h) / 135000) + 12)
  bctx.globalCompositeOperation = 'source-over'
  for (let i = 0; i < count; i++) {
    const edgeBias = rng() < 0.78
    const x = edgeBias ? (rng() < 0.5 ? rng() * w * 0.2 : w - rng() * w * 0.2) : rng() * w
    const y = edgeBias ? (rng() < 0.5 ? rng() * h * 0.2 : h - rng() * h * 0.2) : rng() * h
    const rx = Math.max(18, (18 + rng() * 54) * (0.9 + rng() * 1.1))
    const ry = Math.max(10, (12 + rng() * 34) * (0.8 + rng() * 1.2))
    bctx.save()
    bctx.translate(x, y)
    bctx.rotate((rng() - 0.5) * Math.PI)
    const grad = bctx.createRadialGradient(0, 0, Math.min(rx, ry) * 0.18, 0, 0, Math.max(rx, ry))
    grad.addColorStop(0, `rgba(0, 104, 118, ${0.24 + rng() * 0.16})`)
    grad.addColorStop(0.5, `rgba(0, 82, 96, ${0.14 + rng() * 0.08})`)
    grad.addColorStop(1, 'rgba(0, 70, 82, 0)')
    bctx.fillStyle = grad
    bctx.beginPath()
    bctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2)
    bctx.fill()
    bctx.restore()
  }
  bctx.globalCompositeOperation = 'destination-in'
  bctx.drawImage(rawMaskCanvas, 0, 0)
  bctx.globalCompositeOperation = 'source-over'
  destCtx.globalAlpha = 0.56 + Math.max(0, Math.min(1.8, Number(water.depthStrength || 1.12))) * 0.22
  destCtx.drawImage(blobCanvas, 0, 0)
  destCtx.globalAlpha = 1
}

function drawSparkles(destCtx, rawMaskCanvas, water, seed){
  const w = rawMaskCanvas.width, h = rawMaskCanvas.height
  const sparkCanvas = document.createElement('canvas')
  sparkCanvas.width = w; sparkCanvas.height = h
  const sctx = sparkCanvas.getContext('2d')
  const rng = makeRng(seed ^ 0xa5a5a5a5)
  const amount = Math.max(0, Math.min(1.5, Number(water.sparkleAmount || 0.45)))
  const count = Math.round((w * h) / 290000 * (5 + amount * 10))
  for (let i = 0; i < count; i++) {
    const x = rng() * w
    const y = rng() * h
    const r = 1.4 + rng() * (1.8 + amount * 1.8)
    const alpha = 0.18 + rng() * 0.28
    const grad = sctx.createRadialGradient(x, y, 0, x, y, r * 3.2)
    grad.addColorStop(0, `rgba(220,255,250,${alpha})`)
    grad.addColorStop(0.45, `rgba(190,255,245,${alpha * 0.65})`)
    grad.addColorStop(1, 'rgba(190,255,245,0)')
    sctx.fillStyle = grad
    sctx.beginPath()
    sctx.arc(x, y, r * 3.2, 0, Math.PI * 2)
    sctx.fill()
  }
  sctx.globalCompositeOperation = 'destination-in'
  sctx.drawImage(rawMaskCanvas, 0, 0)
  sctx.globalCompositeOperation = 'source-over'
  destCtx.drawImage(sparkCanvas, 0, 0)
}

export function buildWaterFillWorld(visibleWaterMaskCanvas, dungeon) {
  const water = ensureWaterStyleDefaults(dungeon.style?.water || {})
  if (water.enabled === false || !visibleWaterMaskCanvas) return null
  const w = visibleWaterMaskCanvas.width, h = visibleWaterMaskCanvas.height
  const out = document.createElement('canvas')
  out.width = w; out.height = h
  const ds = makeDownscaledAlpha(visibleWaterMaskCanvas, 360)
  const bounds = collectMaskBounds(ds)
  return drawMaskedGradient(out, visibleWaterMaskCanvas, bounds, water)
}

export function buildWaterEdgesWorld(rawWaterMaskCanvas, dungeon){
  const water = ensureWaterStyleDefaults(dungeon.style?.water || {})
  if (water.enabled === false || (water.outlineEnabled === false && water.ripplesEnabled === false)) return null
  const srcW = rawWaterMaskCanvas.width, srcH = rawWaterMaskCanvas.height
  if (srcW < 2 || srcH < 2) return null

  const edge = document.createElement('canvas')
  edge.width = srcW; edge.height = srcH
  const ectx = edge.getContext('2d')
  ectx.lineCap = 'round'
  ectx.lineJoin = 'round'

  const outlinePx = Math.max(8, Number(water.outlinePx || 12))
  const seamPx = Math.max(2.6, Number(water.ripplePx || 7) * 0.8)
  const glowStrength = Math.max(0.2, Math.min(1.8, Number(water.glowStrength || 1.28)))
  const seamBright = Math.max(0.25, Math.min(1.8, Number(water.seamBright || 1.34)))
  const edgeDepth = Math.max(0.2, Math.min(1.8, Number(water.depthStrength || 1.12)))
  const baseColor = hexToRgb(water.color || '#6bb8ff', { r: 60, g: 182, b: 204 })
  const glowColor = mixRgb(baseColor, { r: 228, g: 255, b: 250 }, 0.92)
  const seamColor = mixRgb(baseColor, { r: 245, g: 255, b: 252 }, Math.max(0.72, Math.min(1, seamBright * 0.86)))
  const outlineColor = mixRgb(hexToRgb(water.outlineColor || '#1f2933', { r: 31, g: 41, b: 51 }), { r: 0, g: 102, b: 110 }, 0.38)

  if (water.outlineEnabled !== false) {
    drawOuterRing(rawWaterMaskCanvas, ectx, outlinePx, rgbaString(outlineColor, 0.42), 1)
  }

  if (water.ripplesEnabled === false) return edge

  const ds = makeDownscaledAlpha(rawWaterMaskCanvas, 720)
  const field = buildSeedField(ds, water, seedHashFromMask(srcW, srcH, collectMaskBounds(ds).filled))
  if (!field.seeds.length) return edge
  const { dw, dh } = ds
  const { idBuf, distBuf, boundary } = assignVoronoi(ds, field)

  const mosaic = document.createElement('canvas')
  mosaic.width = dw; mosaic.height = dh
  const mctx = mosaic.getContext('2d', { willReadFrequently: true })
  const img = mctx.createImageData(dw, dh)
  const out = img.data
  const localR = Math.max(12, 0.72 * Math.min(field.cellStepX, field.cellStepY))

  for (let i = 0; i < idBuf.length; i++) {
    const id = idBuf[i]
    if (id < 0) continue
    const seed = field.seeds[id]
    const dist = Math.sqrt(distBuf[i])
    const t = Math.max(0, Math.min(1, dist / localR))
    const rounded = Math.pow(1 - t, 0.58)
    const depthTint = 1 - Math.pow(t, 1.45)
    const contour = Math.pow(Math.max(0, 1 - Math.abs(0.58 - t) / 0.58), 1.4)
    const tone = seed.tone + rounded * (18 + glowStrength * 4.5) - edgeDepth * 7 + seed.bias * 3 - contour * 6
    const rgb = mixRgb(shiftRgb(baseColor, tone), glowColor, depthTint * (0.18 + glowStrength * 0.05))
    const alpha = 0.24 + rounded * 0.30
    const di = i * 4
    out[di] = rgb.r
    out[di + 1] = rgb.g
    out[di + 2] = rgb.b
    out[di + 3] = clampByte(alpha * 255)
  }

  // Do not stamp raw raster boundary pixels directly into the mosaic image.
  // That crisp overwrite is what leaves the visible stair-step pattern after upscaling.
  // The seam network is rendered separately below as a smoothed glow layer.

  mctx.putImageData(img, 0, 0)

  const expanded = document.createElement('canvas')
  expanded.width = srcW; expanded.height = srcH
  const xctx = expanded.getContext('2d')
  xctx.imageSmoothingEnabled = true
  xctx.clearRect(0, 0, srcW, srcH)
  xctx.save()
  xctx.filter = 'blur(0.55px)'
  xctx.drawImage(mosaic, 0, 0, srcW, srcH)
  xctx.restore()

  const seamMask = document.createElement('canvas')
  seamMask.width = dw; seamMask.height = dh
  const smctx = seamMask.getContext('2d', { willReadFrequently: true })
  const simg = smctx.createImageData(dw, dh)
  const sdat = simg.data
  const rng = makeRng(seedHashFromMask(srcW, srcH, field.filled) ^ 0x1d872b41)
  for (let i = 0; i < boundary.length; i++) {
    if (!boundary[i]) continue
    const di = i * 4
    const mod = 0.65 + rng() * 0.55
    const keep = rng() > 0.08
    if (!keep) continue
    sdat[di] = glowColor.r
    sdat[di + 1] = glowColor.g
    sdat[di + 2] = glowColor.b
    sdat[di + 3] = clampByte((0.54 + glowStrength * 0.18 + seamBright * 0.16) * mod * 255)
  }
  smctx.putImageData(simg, 0, 0)

  const smoothSeams = document.createElement('canvas')
  smoothSeams.width = srcW; smoothSeams.height = srcH
  const ssctx = smoothSeams.getContext('2d')
  ssctx.imageSmoothingEnabled = true
  ssctx.save()
  ssctx.filter = `blur(${Math.max(2.2, seamPx * 0.58)}px)`
  ssctx.drawImage(seamMask, 0, 0, srcW, srcH)
  ssctx.restore()

  xctx.save()
  xctx.filter = `blur(${Math.max(3.8, seamPx * (1.52 + glowStrength * 0.24))}px)`
  xctx.globalAlpha = 0.88 + glowStrength * 0.18
  xctx.drawImage(smoothSeams, 0, 0)
  xctx.restore()

  xctx.save()
  xctx.globalAlpha = 0.76 + seamBright * 0.08
  xctx.drawImage(smoothSeams, 0, 0)
  xctx.restore()

  const innerGlowBand = buildInnerBand(rawWaterMaskCanvas, Math.max(14, outlinePx * (2.05 + glowStrength * 0.24)))
  xctx.globalCompositeOperation = 'source-over'
  xctx.globalAlpha = 0.38 + glowStrength * 0.18
  xctx.drawImage(innerGlowBand, 0, 0)
  xctx.globalCompositeOperation = 'source-in'
  xctx.fillStyle = rgbaString(glowColor, 0.98)
  xctx.fillRect(0, 0, srcW, srcH)
  xctx.globalCompositeOperation = 'screen'
  xctx.globalAlpha = 0.18 + glowStrength * 0.08
  xctx.drawImage(innerGlowBand, 0, 0)
  xctx.globalCompositeOperation = 'source-over'
  xctx.globalAlpha = 1

  // Removed submerged dark blob pass to keep the water cleaner and avoid muddy smudges.
  drawSparkles(xctx, rawWaterMaskCanvas, water, seedHashFromMask(srcW, srcH, field.filled))

  xctx.globalCompositeOperation = 'destination-in'
  xctx.drawImage(rawWaterMaskCanvas, 0, 0)
  xctx.globalCompositeOperation = 'source-over'
  ectx.drawImage(expanded, 0, 0)
  return edge
}
