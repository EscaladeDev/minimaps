import { drawGrid } from "./grid.js"

import { contoursFromAlpha } from "../utils/marching_squares.js"
import { getPathRenderGeometry, normalizePathShapeSettings } from "../utils/path-styles.js"
import { buildWaterFillWorld, buildWaterEdgesWorld } from "./water-style.js"

function ensureCanvas(holder, key, w, h) {
  if (!holder[key]) holder[key] = document.createElement("canvas")
  const c = holder[key]
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h }
  return c
}

const __waterDecorCache = {
  visibleMaskKey: "",
  visibleMaskCanvas: null,
  fillKey: "",
  fillCanvas: null,
  edgeKey: "",
  edgeCanvas: null
}

function cloneCanvas(src){
  if (!src) return null
  const out = document.createElement("canvas")
  out.width = src.width; out.height = src.height
  const octx = out.getContext("2d")
  octx.drawImage(src, 0, 0)
  return out
}

function canvasHasAlpha(canvas){
  if (!canvas || canvas.width < 1 || canvas.height < 1) return false
  try {
    const ctx = canvas.getContext("2d", { willReadFrequently: true })
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 8) return true
    }
  } catch (_err) {}
  return false
}

function buildVisibleWaterMask(rawWaterMaskCanvas, interiorMaskCanvas){
  const w = rawWaterMaskCanvas.width, h = rawWaterMaskCanvas.height
  const out = document.createElement("canvas")
  out.width = w; out.height = h
  const octx = out.getContext("2d", { willReadFrequently: true })
  octx.clearRect(0, 0, w, h)
  octx.drawImage(rawWaterMaskCanvas, 0, 0)
  if (canvasHasAlpha(interiorMaskCanvas)) {
    octx.globalCompositeOperation = "destination-in"
    octx.drawImage(interiorMaskCanvas, 0, 0)
    octx.globalCompositeOperation = "source-over"
  }
  return out
}

function getWaterDecorCache(rawWaterMaskCanvas, interiorMaskCanvas, dungeon, bounds, ppu){
  const water = dungeon.style?.water || {}
  const w = rawWaterMaskCanvas.width, h = rawWaterMaskCanvas.height
  const versions = dungeon.__versions || {}
  const waterVersion = Number(versions.water || 0)
  const interiorVersion = Number(versions.interior || 0)
  const sizeKey = [w, h, ppu.toFixed(4), bounds.minx, bounds.miny, bounds.maxx, bounds.maxy, waterVersion, interiorVersion].join("|")

  if (__waterDecorCache.visibleMaskKey !== sizeKey) {
    __waterDecorCache.visibleMaskCanvas = buildVisibleWaterMask(rawWaterMaskCanvas, interiorMaskCanvas)
    __waterDecorCache.visibleMaskKey = sizeKey
    __waterDecorCache.fillKey = ""
    __waterDecorCache.edgeKey = ""
  }

  const fillKey = [sizeKey, water.enabled !== false, water.color || "#6bb8ff", Number(water.opacity || 0.4), Number(water.centerGlow || 0.72), Number(water.depthStrength || 0.7)].join("|")
  if (__waterDecorCache.fillKey !== fillKey) {
    __waterDecorCache.fillCanvas = buildWaterFillWorld(__waterDecorCache.visibleMaskCanvas, dungeon)
    __waterDecorCache.fillKey = fillKey
  }

  const edgeKey = [
    sizeKey,
    water.enabled !== false,
    water.outlineEnabled !== false,
    water.ripplesEnabled !== false,
    water.color || '#6bb8ff',
    water.outlineColor || '#1f2933',
    Number(water.outlinePx || 10),
    water.rippleColor || water.outlineColor || '#1f2933',
    Number(water.ripplePx || 7),
    Number(water.rippleSpacing || 110),
    Number(water.glowStrength || 0.9),
    Number(water.depthStrength || 0.7),
    Number(water.sparkleAmount || 0.45),
    Number(water.centerGlow || 0.72),
    Number(water.seamBright || 0.95),
    Number(water.cellSize || 1.15),
    Number(water.rippleInsetMin || 18),
    Number(water.rippleInsetMax || 54),
    Number(water.rippleLengthMin || 28),
    Number(water.rippleLengthMax || 62)
  ].join("|")
  if (__waterDecorCache.edgeKey !== edgeKey) {
    __waterDecorCache.edgeCanvas = buildWaterEdgesWorld(__waterDecorCache.visibleMaskCanvas, dungeon)
    __waterDecorCache.edgeKey = edgeKey
  }

  return {
    visibleMaskCanvas: __waterDecorCache.visibleMaskCanvas,
    waterFillCanvas: __waterDecorCache.fillCanvas,
    waterEdgeCanvas: __waterDecorCache.edgeCanvas
  }
}

function worldBoundsFromDungeon(dungeon) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity
  const eat = (p) => {
    if (!p) return
    if (p.x < minx) minx = p.x
    if (p.y < miny) miny = p.y
    if (p.x > maxx) maxx = p.x
    if (p.y > maxy) maxy = p.y
  }
  for (const s of dungeon.spaces) for (const p of (s.polygon || [])) eat(p)
  for (const pth of dungeon.paths) {
    const width = Math.max(2, Number(pth?.width || dungeon.style?.corridorWidth || 48))
    const geometry = getPathRenderGeometry(pth?.points || [], normalizePathShapeSettings(pth || {}, dungeon.style || {}), { width, seed: pth?.id || pth?.seq || 0 })
    const pad = width * 0.5
    for (const p of (geometry.points || [])) {
      eat({ x: p.x - pad, y: p.y - pad })
      eat({ x: p.x + pad, y: p.y + pad })
    }
  }
  for (const sh of dungeon.shapes) for (const p of (sh._poly || [])) eat(p)
  for (const wp of ((dungeon.water && dungeon.water.paths) || [])) for (const p of (wp.points || [])) eat(p)
  if (!isFinite(minx)) return null
  return { minx, miny, maxx, maxy }
}

function drawWorldMask(maskCtx, dungeon, bounds, ppu) {
  const w = maskCtx.canvas.width, h = maskCtx.canvas.height
  maskCtx.clearRect(0,0,w,h)
  maskCtx.save()
  maskCtx.setTransform(ppu, 0, 0, ppu, -bounds.minx * ppu, -bounds.miny * ppu)

  maskCtx.fillStyle = "rgba(0,0,0,1)"
  maskCtx.strokeStyle = "rgba(0,0,0,1)"
  maskCtx.lineCap = "round"
  maskCtx.lineJoin = "round"

  // Build a single ordered edit stream across rectangles, paths, and polygons.
  // This fixes cross-tool subtract/add interactions (e.g. rectangle erase over paths).
  const ops = []
  let fallbackSeq = 1

  for (const s of (dungeon.spaces || [])) {
    const poly = s && s.polygon
    if (!poly || poly.length < 3) continue
    const seq = Number.isFinite(Number(s.seq)) ? Number(s.seq) : (fallbackSeq++)
    ops.push({ seq, mode: (s.mode || "add"), kind: "fillPoly", poly })
  }

  for (const sh of (dungeon.shapes || [])) {
    const poly = sh && sh._poly
    if (!poly || poly.length < 3) continue
    const seq = Number.isFinite(Number(sh.seq)) ? Number(sh.seq) : (fallbackSeq++)
    ops.push({ seq, mode: (sh.mode || "add"), kind: "fillPoly", poly })
  }

  for (const path of (dungeon.paths || [])) {
    const pts = path && path.points
    if (!pts || pts.length < 2) continue
    const seq = Number.isFinite(Number(path.seq)) ? Number(path.seq) : (fallbackSeq++)
    const width = Math.max(2, Number(path.width || dungeon.style?.corridorWidth || 48))
    const geometry = getPathRenderGeometry(pts, normalizePathShapeSettings(path, dungeon.style || {}), { width, seed: path.id || seq })
    if (!geometry?.points || geometry.points.length < 2) continue
    ops.push({ seq, mode: (path.mode || "add"), kind: geometry.kind === "polygon" ? "fillPoly" : "strokePath", width, points: geometry.points, poly: geometry.points })
  }

  ops.sort((a,b) => a.seq - b.seq)

  for (const op of ops) {
    maskCtx.globalCompositeOperation = (op.mode === "subtract") ? "destination-out" : "source-over"

    if (op.kind === "fillPoly") {
      const poly = op.poly
      maskCtx.beginPath()
      for (let i=0;i<poly.length;i++){
        const p = poly[i]
        i===0 ? maskCtx.moveTo(p.x,p.y) : maskCtx.lineTo(p.x,p.y)
      }
      maskCtx.closePath()
      maskCtx.fill()
      continue
    }

    if (op.kind === "strokePath") {
      const pts = op.points
      maskCtx.lineWidth = Math.max(2, Number(op.width || dungeon.style?.corridorWidth || 48))
      maskCtx.lineCap = "round"
      maskCtx.lineJoin = "round"
      maskCtx.beginPath()
      for (let i=0;i<pts.length;i++){
        const p = pts[i]
        i===0 ? maskCtx.moveTo(p.x,p.y) : maskCtx.lineTo(p.x,p.y)
      }
      maskCtx.stroke()
      continue
    }
  }

  maskCtx.restore()
  maskCtx.globalCompositeOperation = "source-over"
}


function drawWaterMask(maskCtx, dungeon, bounds, ppu) {
  const w = maskCtx.canvas.width, h = maskCtx.canvas.height
  maskCtx.clearRect(0,0,w,h)
  maskCtx.save()
  maskCtx.setTransform(ppu, 0, 0, ppu, -bounds.minx * ppu, -bounds.miny * ppu)
  maskCtx.strokeStyle = "rgba(0,0,0,1)"
  maskCtx.lineCap = "round"
  maskCtx.lineJoin = "round"
  const ops = []
  let fallbackSeq = 1
  for (const path of ((dungeon.water && dungeon.water.paths) || [])) {
    const pts = path && path.points
    if (!pts || pts.length < 2) continue
    const seq = Number.isFinite(Number(path.seq)) ? Number(path.seq) : (fallbackSeq++)
    ops.push({ seq, mode: (path.mode || "add"), width: Number(path.width || dungeon.style?.water?.width || 52), points: pts })
  }
  ops.sort((a,b)=>a.seq-b.seq)
  for (const op of ops){
    maskCtx.globalCompositeOperation = (op.mode === "subtract") ? "destination-out" : "source-over"
    maskCtx.lineWidth = Math.max(2, op.width)
    maskCtx.beginPath()
    for (let i=0;i<op.points.length;i++){
      const pt = op.points[i]
      i===0 ? maskCtx.moveTo(pt.x, pt.y) : maskCtx.lineTo(pt.x, pt.y)
    }
    maskCtx.stroke()
  }
  maskCtx.restore()
  maskCtx.globalCompositeOperation = "source-over"
}

function buildWaterEdgesFallbackFromPaths(rawWaterMaskCanvas, dungeon){
  return buildWaterEdgesWorld(rawWaterMaskCanvas, dungeon)
}

function buildShadowWorld(maskCanvas, dungeon, ppu) {
  const w = maskCanvas.width, h = maskCanvas.height
  const shadow = dungeon.style.shadow
  if (!shadow.enabled || shadow.opacity <= 0 || shadow.length <= 0.1) return null

  // Quantize offsets to pixel grid to avoid subpixel interpolation artifacts.
  const rawDx = shadow.dir.x * shadow.length * ppu
  const rawDy = shadow.dir.y * shadow.length * ppu
  const dx = Math.round(rawDx)
  const dy = Math.round(rawDy)
  if (dx === 0 && dy === 0) return null

  // Build OUTSIDE mask once (binary-ish canvas): outside = full - interior.
  const outsideC = document.createElement("canvas")
  outsideC.width = w; outsideC.height = h
  const octx0 = outsideC.getContext("2d")
  octx0.clearRect(0,0,w,h)
  octx0.fillStyle = "#000"
  octx0.fillRect(0,0,w,h)
  octx0.globalCompositeOperation = "destination-out"
  octx0.drawImage(maskCanvas, 0, 0)
  octx0.globalCompositeOperation = "source-over"

  // Corner-aware angled shadow band:
  // band = interior ∩ UNION_t( outside shifted along shadow ray )
  // This creates a diagonal wedge at corners and reaches all the way to the wall (t=0 included).
  const unionC = document.createElement("canvas")
  unionC.width = w; unionC.height = h
  const uctx = unionC.getContext("2d")
  uctx.clearRect(0,0,w,h)
  uctx.imageSmoothingEnabled = false

  const steps = Math.max(8, Math.min(64, Math.round(Math.hypot(dx, dy))))
  let lastX = null, lastY = null
  for (let i = 0; i <= steps; i++) {
    const ox = Math.round((dx * i) / steps)
    const oy = Math.round((dy * i) / steps)
    // Skip duplicate offsets from rounding to keep render cheaper
    if (ox === lastX && oy === lastY) continue
    lastX = ox; lastY = oy
    uctx.drawImage(outsideC, ox, oy)
  }

  // Clip shadow candidates to interior only
  uctx.globalCompositeOperation = "destination-in"
  uctx.drawImage(maskCanvas, 0, 0)
  uctx.globalCompositeOperation = "source-over"

  // Optional 1px AA soften only (preserves uniform tone and wall contact)
  const bandC = document.createElement("canvas")
  bandC.width = w; bandC.height = h
  const bctx = bandC.getContext("2d")
  const aa = Math.max(0.35, ppu * 0.25)
  bctx.filter = `blur(${aa}px)`
  bctx.drawImage(unionC, 0, 0)
  bctx.filter = "none"
  bctx.globalCompositeOperation = "destination-in"
  bctx.drawImage(maskCanvas, 0, 0)
  bctx.globalCompositeOperation = "source-over"

  // Ensure contact to wall is solid (no blur gap): OR original band back in after AA.
  bctx.globalCompositeOperation = "source-over"
  bctx.drawImage(unionC, 0, 0)

  // Uniform shade fill clipped to the shadow band
  const out = document.createElement("canvas")
  out.width = w; out.height = h
  const octx = out.getContext("2d")
  octx.clearRect(0,0,w,h)
  const shadowCss = shadow.color || "#000000"
  octx.fillStyle = shadowCss
  octx.globalAlpha = Math.max(0, Math.min(1, shadow.opacity ?? 0.34))
  octx.fillRect(0,0,w,h)
  octx.globalAlpha = 1
  octx.globalCompositeOperation = "destination-in"
  octx.drawImage(bandC, 0, 0)
  octx.globalCompositeOperation = "source-over"

  return out
}

function buildWallsWorld(contoursPx, maskCanvas, dungeon, ppu) {
  const w = maskCanvas.width, h = maskCanvas.height
  const wall = { color: dungeon.style.wallColor, width: dungeon.style.wallWidth * ppu }

  const wc = document.createElement("canvas")
  wc.width = w; wc.height = h
  const oc = document.createElement("canvas")
  oc.width = w; oc.height = h
  const wctx = wc.getContext("2d")
  const octx = oc.getContext("2d")

  // outside mask = full - interior
  octx.clearRect(0,0,w,h)
  octx.fillStyle = "rgba(0,0,0,1)"
  octx.fillRect(0,0,w,h)
  octx.globalCompositeOperation = "destination-out"
  octx.drawImage(maskCanvas, 0, 0)
  octx.globalCompositeOperation = "source-over"

  // thick stroke centered on contour, then keep outside half only
  wctx.clearRect(0,0,w,h)
  wctx.strokeStyle = wall.color
  wctx.lineWidth = wall.width * 2
  wctx.lineCap = "round"
  wctx.lineJoin = "round"
  for (const poly of contoursPx) {
    if (!poly || poly.length < 2) continue
    wctx.beginPath()
    wctx.moveTo(poly[0].x, poly[0].y)
    for (let i=1;i<poly.length;i++) wctx.lineTo(poly[i].x, poly[i].y)
    wctx.stroke()
  }
  wctx.globalCompositeOperation = "destination-in"
  wctx.drawImage(oc, 0, 0)
  wctx.globalCompositeOperation = "source-over"

  // crisp outer edge only (keep interior grid/fill clean)
  const edgeC = document.createElement("canvas")
  edgeC.width = w; edgeC.height = h
  const ectx = edgeC.getContext("2d")
  ectx.strokeStyle = wall.color
  ectx.lineWidth = Math.max(1, wall.width * 0.35)
  ectx.lineCap = "round"
  ectx.lineJoin = "round"
  for (const poly of contoursPx) {
    if (!poly || poly.length < 2) continue
    ectx.beginPath()
    ectx.moveTo(poly[0].x, poly[0].y)
    for (let i=1;i<poly.length;i++) ectx.lineTo(poly[i].x, poly[i].y)
    ectx.stroke()
  }
  ectx.globalCompositeOperation = "destination-in"
  ectx.drawImage(oc, 0, 0)
  ectx.globalCompositeOperation = "source-over"
  wctx.drawImage(edgeC, 0, 0)

  return wc
}

function buildHatchWorld(contoursPx, maskCanvas, dungeon, ppu) {
  const hatch = dungeon.style.hatch
  if (!hatch.enabled || hatch.density <= 0 || hatch.opacity <= 0 || hatch.depth <= 0) return null
  const w = maskCanvas.width, h = maskCanvas.height
  const hc = document.createElement("canvas")
  hc.width = w; hc.height = h
  const hctx = hc.getContext("2d")
  hctx.clearRect(0,0,w,h)

  function xorshift32(x){
    x >>>= 0
    x ^= (x << 13) >>> 0
    x ^= (x >>> 17) >>> 0
    x ^= (x << 5) >>> 0
    return x >>> 0
  }
  function rand01(seedObj){
    seedObj.v = xorshift32(seedObj.v)
    return (seedObj.v & 0xFFFFFF) / 0x1000000
  }

  hctx.strokeStyle = (hatch.color || "#1f2933")
  hctx.lineWidth = Math.max(3.2, ppu * 2.25) // thicker/cartoony
  hctx.lineCap = "round"

  const half = hatch.depth * ppu
  const inset = hatch.inset * ppu
  const density = Math.max(0.001, Number(hatch.density) || 0.001)
  const angleRange = hatch.angleRange
  const minLen = hatch.minLen * ppu
  const maxLen = hatch.maxLen * ppu

  for (let pi=0; pi<contoursPx.length; pi++){
    const poly = contoursPx[pi]
    if (!poly || poly.length < 2) continue
    for (let i=0;i<poly.length-1;i++){
      const A = poly[i], B = poly[i+1]
      const vx = B.x - A.x, vy = B.y - A.y
      const segLen = Math.hypot(vx,vy) || 1
      const tx = vx/segLen, ty = vy/segLen
      const nx = ty, ny = -tx
      const rng = { v: (pi*2654435761 ^ i*97531 ^ 0x9e3779b9) >>> 0 }

      const dFull = Math.floor(density)
      const dFrac = density - dFull
      const dPasses = dFull + (dFrac > 0 ? 1 : 0)
      for (let k=0;k<dPasses;k++){
        if (k >= dFull && rand01(rng) > dFrac) continue
        const u = rand01(rng)
        const d = u * segLen
        const bx = A.x + tx*d, by = A.y + ty*d

        const dep = (rand01(rng)*2-1) * half
        const ox = bx + nx*dep, oy = by + ny*dep

        const wob = (rand01(rng)*2-1) * (3.2 * ppu)
        const baseAng = (rand01(rng)*2-1) * angleRange

        function drawStroke(extraAng, extraWob){
          const ang = baseAng + extraAng
          const ca = Math.cos(ang), sa = Math.sin(ang)
          const dx = tx*ca - ty*sa
          const dy = tx*sa + ty*ca
          const L = minLen + rand01(rng)*(maxLen - minLen)
          const x1 = ox - dx*L/2, y1 = oy - dy*L/2
          const x2 = ox + dx*L/2, y2 = oy + dy*L/2
          const clamp = inset + half + 2*ppu
          const t1 = ( (x1-A.x)*nx + (y1-A.y)*ny )
          const t2 = ( (x2-A.x)*nx + (y2-A.y)*ny )
          if (Math.abs(t1) > clamp || Math.abs(t2) > clamp) return

          const mx = (x1+x2)/2 + (-dy)*(wob + extraWob)
          const my = (y1+y2)/2 + ( dx)*(wob + extraWob)

          hctx.globalAlpha = hatch.opacity * (0.9 + rand01(rng)*0.25)
          hctx.beginPath()
          hctx.moveTo(x1,y1)
          hctx.quadraticCurveTo(mx,my,x2,y2)
          hctx.stroke()
        }

        drawStroke(0, 0)
        drawStroke(Math.PI*0.55, (rand01(rng)*2-1)*(2.5*ppu))
      }
    }
  }

  // clip hatch to OUTSIDE only (strict, stable)
  const outsideC = document.createElement("canvas")
  outsideC.width = w; outsideC.height = h
  const octx = outsideC.getContext("2d")
  octx.fillStyle = "rgba(0,0,0,1)"
  octx.fillRect(0,0,w,h)
  octx.globalCompositeOperation = "destination-out"
  octx.drawImage(maskCanvas, 0, 0)
  octx.globalCompositeOperation = "source-over"

  hctx.globalAlpha = 1
  hctx.globalCompositeOperation = "destination-in"
  hctx.drawImage(outsideC, 0, 0)
  hctx.globalCompositeOperation = "source-over"
  return hc
}

function contoursPxToWorld(contoursPx, bounds, ppu) {
  return contoursPx.map(poly => poly.map(p => ({
    x: bounds.minx + p.x / ppu,
    y: bounds.miny + p.y / ppu
  })))
}


function getPlacedPropRenderSizeStatic(prop, gridSize = 32){
  const fallbackW = Math.max(1, Number(prop?.w || gridSize || 32))
  const fallbackH = Math.max(1, Number(prop?.h || gridSize || 32))
  const baseW = Math.max(1, Number(prop?.baseW || fallbackW))
  const baseH = Math.max(1, Number(prop?.baseH || fallbackH))
  const scale = Math.max(0.05, Number(prop?.scale || 1))
  return { w: baseW * scale, h: baseH * scale }
}
export function compileWorldCache(dungeon, placedProps = [], getPropMeta = () => null) {
  const content = worldBoundsFromDungeon(dungeon)
  if (!content) return null

  const shadow = dungeon.style.shadow
  const hatch = dungeon.style.hatch
  const pad = Math.ceil(
    Math.max(
      dungeon.style.corridorWidth * 0.75,
      dungeon.style.wallWidth * 2,
      (shadow?.length || 0) + 16,
      (hatch?.depth || 0) + (hatch?.maxLen || 0) + 20
    )
  )

  const bounds = {
    minx: content.minx - pad,
    miny: content.miny - pad,
    maxx: content.maxx + pad,
    maxy: content.maxy + pad
  }
  const worldW = Math.max(1, bounds.maxx - bounds.minx)
  const worldH = Math.max(1, bounds.maxy - bounds.miny)

  const desiredPPU = 3.0
  const maxDim = 6144
  let ppu = desiredPPU
  ppu = Math.min(ppu, maxDim / worldW, maxDim / worldH)
  ppu = Math.max(0.5, ppu)

  const w = Math.max(1, Math.ceil(worldW * ppu))
  const h = Math.max(1, Math.ceil(worldH * ppu))

  const maskCanvas = document.createElement("canvas")
  maskCanvas.width = w; maskCanvas.height = h
  const maskCtx = maskCanvas.getContext("2d", { willReadFrequently: true })
  drawWorldMask(maskCtx, dungeon, bounds, ppu)

  const img = maskCtx.getImageData(0,0,w,h)
  const step = Math.max(1, Math.round(1.5)) // stable contour res
  const contoursPx = contoursFromAlpha(img, w, h, step, 1)
  const contoursWorld = contoursPxToWorld(contoursPx, bounds, ppu)

  const rawWaterMaskCanvas = document.createElement("canvas")
  rawWaterMaskCanvas.width = w; rawWaterMaskCanvas.height = h
  const rawWaterMaskCtx = rawWaterMaskCanvas.getContext("2d", { willReadFrequently: true })
  drawWaterMask(rawWaterMaskCtx, dungeon, bounds, ppu)
  const waterDecor = getWaterDecorCache(rawWaterMaskCanvas, maskCanvas, dungeon, bounds, ppu)
  const waterFillCanvas = waterDecor.waterFillCanvas
  const waterEdgeCanvas = waterDecor.waterEdgeCanvas

  const shadowCanvas = buildShadowWorld(maskCanvas, dungeon, ppu)
  const hatchCanvas = buildHatchWorld(contoursPx, maskCanvas, dungeon, ppu)
  const wallCanvas = buildWallsWorld(contoursPx, maskCanvas, dungeon, ppu)

  return {
    bounds,
    contentBounds: content,
    ppu,
    maskCanvas,
    rawWaterMaskCanvas,
    waterFillCanvas,
    waterEdgeCanvas,
    shadowCanvas,
    hatchCanvas,
    wallCanvas,
    contoursPx,
    contoursWorld
  }
}

function drawWorldLayer(ctx, camera, layerCanvas, bounds, ppu) {
  if (!layerCanvas) return
  const tl = camera.worldToScreen({ x: bounds.minx, y: bounds.miny })
  const drawW = (layerCanvas.width / ppu) * camera.zoom
  const drawH = (layerCanvas.height / ppu) * camera.zoom
  ctx.imageSmoothingEnabled = true
  ctx.drawImage(layerCanvas, tl.x, tl.y, drawW, drawH)
}

function drawTransformedMaskTo(ctx, camera, cache) {
  drawWorldLayer(ctx, camera, cache.maskCanvas, cache.bounds, cache.ppu)
}

export function punchOutCompiledInterior(ctx, camera, cache) {
  if (!cache) return
  ctx.save()
  ctx.globalCompositeOperation = "destination-out"
  drawTransformedMaskTo(ctx, camera, cache)
  ctx.restore()
}

function getTemp(holder, key, w, h) {
  return ensureCanvas(holder, key, w, h)
}
const __tmp = {}

function buildScreenGridCanvas(camera, dungeon, w, h, lineWidthScale = 1) {
  const gridC = getTemp(__tmp, "grid_full", w, h)
  const gctx = gridC.getContext("2d")
  gctx.clearRect(0, 0, w, h)
  drawGrid(
    gctx,
    camera,
    dungeon.gridSize,
    w,
    h,
    dungeon.style?.gridLineWidth ?? 1,
    dungeon.style?.gridOpacity ?? 0.06,
    lineWidthScale
  )
  return gridC
}

export function drawCompiledExteriorGrid(ctx, camera, cache, dungeon, w, h, lineWidthScale = 1) {
  const gridC = buildScreenGridCanvas(camera, dungeon, w, h, lineWidthScale)
  if (!cache) {
    ctx.drawImage(gridC, 0, 0)
    return
  }
  const outC = getTemp(__tmp, "grid_outside", w, h)
  const octx = outC.getContext("2d")
  octx.clearRect(0, 0, w, h)
  octx.drawImage(gridC, 0, 0)
  octx.globalCompositeOperation = "destination-out"
  drawTransformedMaskTo(octx, camera, cache)
  octx.globalCompositeOperation = "source-over"
  ctx.drawImage(outC, 0, 0)
}


export function drawCompiledInteriorGridOverlay(ctx, camera, cache, dungeon, w, h, lineWidthScale = 1) {
  if (!cache) return
  const gridC = buildScreenGridCanvas(camera, dungeon, w, h, lineWidthScale)
  const inC = getTemp(__tmp, "grid_inside", w, h)
  const ictx = inC.getContext("2d")
  ictx.clearRect(0, 0, w, h)
  ictx.drawImage(gridC, 0, 0)
  ictx.globalCompositeOperation = "destination-in"
  drawTransformedMaskTo(ictx, camera, cache)
  ictx.globalCompositeOperation = "source-over"
  ctx.drawImage(inC, 0, 0)
}

export function drawCompiledBase(ctx, camera, cache, dungeon, w, h, lineWidthScale = 1) {
  if (!cache) return

  // Fill dungeon interior (tint via source-in to avoid any mask-color interactions)
  const fillC = getTemp(__tmp, "fill", w, h)
  const fctx = fillC.getContext("2d")
  fctx.clearRect(0,0,w,h)
  fctx.globalAlpha = 1
  fctx.filter = "none"
  fctx.globalCompositeOperation = "source-over"
  // Step 1: draw transformed interior mask (alpha carrier)
  drawTransformedMaskTo(fctx, camera, cache)
  // Step 2: tint mask with chosen floor color
  fctx.globalCompositeOperation = "source-in"
  fctx.fillStyle = dungeon.style.floorColor || dungeon.style.paper || "#ffffff"
  fctx.fillRect(0,0,w,h)
  fctx.globalCompositeOperation = "source-over"
  ctx.drawImage(fillC, 0, 0)

  // Interior grid clipped to fill
  drawCompiledInteriorGridOverlay(ctx, camera, cache, dungeon, w, h, lineWidthScale)

  // Interior shadow (stable in world space, clipped to interior)
  if (cache.shadowCanvas && dungeon.style.shadow.enabled) {
    ctx.save()
    drawWorldLayer(ctx, camera, cache.shadowCanvas, cache.bounds, cache.ppu)
    ctx.restore()
  }

  if (cache.waterFillCanvas && dungeon.style?.water?.enabled !== false) {
    drawWorldLayer(ctx, camera, cache.waterFillCanvas, cache.bounds, cache.ppu)
  }
  if (cache.waterEdgeCanvas && ((dungeon.style?.water?.outlineEnabled !== false) || (dungeon.style?.water?.ripplesEnabled !== false))) {
    drawWorldLayer(ctx, camera, cache.waterEdgeCanvas, cache.bounds, cache.ppu)
  }

  // Outside hatch
  if (cache.hatchCanvas && dungeon.style.hatch.enabled) {
    drawWorldLayer(ctx, camera, cache.hatchCanvas, cache.bounds, cache.ppu)
  }

  // Walls outside
  drawWorldLayer(ctx, camera, cache.wallCanvas, cache.bounds, cache.ppu)
}


// Simple vector-ish overlay boundary draw for extra crispness if desired
export function drawCompiledContours(ctx, camera, cache, color = "rgba(20,25,30,0.9)", width = 1) {
  if (!cache?.contoursWorld) return
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.lineCap = "round"
  ctx.lineJoin = "round"
  for (const poly of cache.contoursWorld) {
    if (!poly || poly.length < 2) continue
    ctx.beginPath()
    const p0 = camera.worldToScreen(poly[0])
    ctx.moveTo(p0.x, p0.y)
    for (let i=1;i<poly.length;i++){
      const p = camera.worldToScreen(poly[i])
      ctx.lineTo(p.x, p.y)
    }
    ctx.stroke()
  }
  ctx.restore()
}
