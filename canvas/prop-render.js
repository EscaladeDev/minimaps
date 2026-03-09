import { rotate } from "../utils/math.js"

const DEFAULT_PROP_SHADOW_CACHE_LIMIT = 256

export function createPropRenderRuntime(){
  return {
    shadowCache: new Map(),
    shadowCacheLimit: DEFAULT_PROP_SHADOW_CACHE_LIMIT,
    tempLayers: Object.create(null),
    staticLayerCanvas: null,
    staticLayerSig: ""
  }
}

function getTempCanvas(runtime, key, w, h){
  let c = runtime.tempLayers[key]
  if (!c) c = runtime.tempLayers[key] = document.createElement('canvas')
  if (c.width !== w || c.height !== h){
    c.width = w
    c.height = h
  }
  return c
}

function drawCompiledLayerToScreen(targetCtx, layerCanvas, cache, cam){
  if (!targetCtx || !layerCanvas || !cache || !cam) return
  const screenW = Math.max(1, Number(targetCtx?.canvas?.width || 0))
  const screenH = Math.max(1, Number(targetCtx?.canvas?.height || 0))
  const topLeftWorld = cam.screenToWorld ? cam.screenToWorld({ x: 0, y: 0 }) : { x: -Number(cam.x || 0), y: -Number(cam.y || 0) }
  const bottomRightWorld = cam.screenToWorld ? cam.screenToWorld({ x: screenW, y: screenH }) : {
    x: topLeftWorld.x + screenW / Math.max(0.0001, Number(cam.zoom || 1)),
    y: topLeftWorld.y + screenH / Math.max(0.0001, Number(cam.zoom || 1))
  }
  const worldLeft = Math.min(topLeftWorld.x, bottomRightWorld.x)
  const worldTop = Math.min(topLeftWorld.y, bottomRightWorld.y)
  const worldRight = Math.max(topLeftWorld.x, bottomRightWorld.x)
  const worldBottom = Math.max(topLeftWorld.y, bottomRightWorld.y)

  const visLeft = Math.max(cache.bounds.minx, worldLeft)
  const visTop = Math.max(cache.bounds.miny, worldTop)
  const visRight = Math.min(cache.bounds.maxx, worldRight)
  const visBottom = Math.min(cache.bounds.maxy, worldBottom)
  if (!(visRight > visLeft && visBottom > visTop)) return

  const sx = Math.max(0, Math.floor((visLeft - cache.bounds.minx) * cache.ppu))
  const sy = Math.max(0, Math.floor((visTop - cache.bounds.miny) * cache.ppu))
  const sRight = Math.min(layerCanvas.width, Math.ceil((visRight - cache.bounds.minx) * cache.ppu))
  const sBottom = Math.min(layerCanvas.height, Math.ceil((visBottom - cache.bounds.miny) * cache.ppu))
  const sw = Math.max(1, sRight - sx)
  const sh = Math.max(1, sBottom - sy)

  const srcLeftWorld = cache.bounds.minx + (sx / cache.ppu)
  const srcTopWorld = cache.bounds.miny + (sy / cache.ppu)
  const srcRightWorld = cache.bounds.minx + (sRight / cache.ppu)
  const srcBottomWorld = cache.bounds.miny + (sBottom / cache.ppu)

  const dx = (srcLeftWorld - worldLeft) * cam.zoom
  const dy = (srcTopWorld - worldTop) * cam.zoom
  const dw = (srcRightWorld - srcLeftWorld) * cam.zoom
  const dh = (srcBottomWorld - srcTopWorld) * cam.zoom

  targetCtx.imageSmoothingEnabled = true
  targetCtx.drawImage(layerCanvas, sx, sy, sw, sh, dx, dy, dw, dh)
}

function getVisiblePlacedProps({ placedProps, targetCamera, targetW, targetH, extraPadPx = 0, getPlacedPropRenderSize, getPropById, getPropImage, propImageCache }){
  if (!Array.isArray(placedProps) || placedProps.length === 0) return []
  const out = []
  const minX = -extraPadPx
  const minY = -extraPadPx
  const maxX = targetW + extraPadPx
  const maxY = targetH + extraPadPx
  for (const a of placedProps){
    if (!a || !a.url) continue
    const c = targetCamera.worldToScreen({ x: a.x, y: a.y })
    const rs = getPlacedPropRenderSize(a)
    const w = Math.max(1, rs.w * targetCamera.zoom)
    const h = Math.max(1, rs.h * targetCamera.zoom)
    const radius = Math.hypot(w, h) * 0.5 + extraPadPx
    if ((c.x + radius) < minX || (c.x - radius) > maxX || (c.y + radius) < minY || (c.y - radius) > maxY) continue
    const propMeta = getPropById(a.propId)
    const img = propImageCache.get(a.url) || (propMeta ? getPropImage(propMeta) : null)
    out.push({ prop: a, screen: c, w, h, propMeta, img })
  }
  return out
}

function getPropShadowCanvasLikeWalls({ runtime, propInst, img, drawW, drawH, dungeonStyle, zoomOverride = null }){
  const shadow = dungeonStyle?.shadow
  if (!shadow?.enabled) return null
  const alpha = Math.max(0, Math.min(1, Number(shadow.opacity ?? 0.34)))
  if (alpha <= 0) return null
  const activeZoom = Number.isFinite(Number(zoomOverride)) ? Number(zoomOverride) : 1
  const quantizedZoom = Math.max(0.05, Math.round(activeZoom * 8) / 8)
  const propLenScale = 0.5
  const lenPx = Math.max(0, Number(shadow.length || 0) * propLenScale * quantizedZoom)
  const globalDir = shadow.dir || { x: 0.707, y: 0.707 }
  const localDir = rotate({ x: globalDir.x || 0, y: globalDir.y || 0 }, -(Number(propInst?.rot || 0) || 0))
  const dx = Math.round((localDir.x || 0) * lenPx)
  const dy = Math.round((localDir.y || 0) * lenPx)
  if (dx === 0 && dy === 0) return null
  const w = Math.max(1, Math.round(drawW))
  const h = Math.max(1, Math.round(drawH))
  const qW = Math.max(1, Math.round(w / 8) * 8 || w)
  const qH = Math.max(1, Math.round(h / 8) * 8 || h)
  const feather = Math.max(1, Math.round(Math.min(qW, qH) * 0.04))
  const pad = Math.max(6, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) + feather + 4))
  const flipX = propInst?.flipX === true
  const flipY = propInst?.flipY === true
  const imgKey = String(propInst?.propId || propInst?.assetId || propInst?.url || img?.currentSrc || img?.src || 'prop')
  const key = [imgKey,qW,qH,dx,dy,shadow.color||'#000000',alpha,feather, flipX?1:0, flipY?1:0].join('|')
  const cached = runtime.shadowCache.get(key)
  if (cached?.canvas){
    runtime.shadowCache.delete(key)
    runtime.shadowCache.set(key, cached)
    return cached
  }

  const cw = qW + pad * 2, ch = qH + pad * 2
  const baseAlphaC = document.createElement('canvas'); baseAlphaC.width = cw; baseAlphaC.height = ch
  const bactx = baseAlphaC.getContext('2d')
  bactx.clearRect(0,0,cw,ch)
  bactx.imageSmoothingEnabled = false
  bactx.save()
  bactx.translate(pad + qW/2, pad + qH/2)
  bactx.scale(flipX ? -1 : 1, flipY ? -1 : 1)
  bactx.drawImage(img, -qW/2, -qH/2, qW, qH)
  bactx.restore()

  const alphaC = document.createElement('canvas'); alphaC.width = cw; alphaC.height = ch
  const actx = alphaC.getContext('2d')
  actx.imageSmoothingEnabled = false
  actx.drawImage(baseAlphaC, 0, 0)

  if (feather > 0){
    const dilate = document.createElement('canvas'); dilate.width = cw; dilate.height = ch
    const dctx = dilate.getContext('2d')
    dctx.imageSmoothingEnabled = false
    for (let ox = -feather; ox <= feather; ox++){
      for (let oy = -feather; oy <= feather; oy++){
        if ((ox*ox + oy*oy) > feather*feather) continue
        dctx.drawImage(baseAlphaC, ox, oy)
      }
    }
    actx.clearRect(0,0,cw,ch)
    actx.drawImage(dilate, 0, 0)
  }

  const sweepC = document.createElement('canvas'); sweepC.width = cw; sweepC.height = ch
  const sctx = sweepC.getContext('2d')
  sctx.imageSmoothingEnabled = false
  const steps = Math.max(8, Math.min(80, Math.round(Math.hypot(dx, dy))))
  let lx = null, ly = null
  for (let i = 1; i <= steps; i++){
    const ox = Math.round((dx * i) / steps)
    const oy = Math.round((dy * i) / steps)
    if (ox === lx && oy === ly) continue
    lx = ox; ly = oy
    sctx.drawImage(alphaC, ox, oy)
  }
  sctx.globalCompositeOperation = 'destination-out'
  sctx.drawImage(baseAlphaC, 0, 0)
  sctx.globalCompositeOperation = 'source-over'

  try {
    const maskImg = sctx.getImageData(0, 0, cw, ch)
    const d = maskImg.data
    for (let i = 0; i < d.length; i += 4){
      d[i + 3] = d[i + 3] > 0 ? 255 : 0
    }
    sctx.putImageData(maskImg, 0, 0)
  } catch {}

  const bridgeX = dx === 0 ? 0 : -Math.sign(dx)
  const bridgeY = dy === 0 ? 0 : -Math.sign(dy)
  if (bridgeX !== 0 || bridgeY !== 0){
    const bridgeSteps = 1
    const bridgeC = document.createElement('canvas'); bridgeC.width = cw; bridgeC.height = ch
    const bctx = bridgeC.getContext('2d')
    bctx.imageSmoothingEnabled = false
    for (let i = 0; i <= bridgeSteps; i++){
      bctx.drawImage(sweepC, bridgeX * i, bridgeY * i)
    }
    sctx.clearRect(0, 0, cw, ch)
    sctx.drawImage(bridgeC, 0, 0)

    const blockerPad = Math.max(1, Math.min(3, feather + 1))
    const blockerC = document.createElement('canvas'); blockerC.width = cw; blockerC.height = ch
    const blctx = blockerC.getContext('2d')
    blctx.imageSmoothingEnabled = false
    for (let ox = -blockerPad; ox <= blockerPad; ox++){
      for (let oy = -blockerPad; oy <= blockerPad; oy++){
        if ((ox*ox + oy*oy) > blockerPad*blockerPad) continue
        blctx.drawImage(baseAlphaC, ox, oy)
      }
    }
    sctx.globalCompositeOperation = 'destination-out'
    sctx.drawImage(blockerC, bridgeX * blockerPad, bridgeY * blockerPad)
    sctx.globalCompositeOperation = 'source-over'
  }

  const outC = document.createElement('canvas'); outC.width = cw; outC.height = ch
  const octx = outC.getContext('2d')
  octx.fillStyle = shadow.color || '#000000'
  octx.globalAlpha = alpha
  octx.fillRect(0,0,cw,ch)
  octx.globalAlpha = 1
  octx.globalCompositeOperation = 'destination-in'
  octx.drawImage(sweepC, 0, 0)
  octx.globalCompositeOperation = 'source-over'

  const result = { key, canvas: outC, pad, sourceW: qW, sourceH: qH }
  runtime.shadowCache.set(key, result)
  while (runtime.shadowCache.size > runtime.shadowCacheLimit){
    const oldestKey = runtime.shadowCache.keys().next().value
    if (oldestKey == null) break
    runtime.shadowCache.delete(oldestKey)
  }
  return result
}


function getPropLayerCanvas(runtime, w, h){
  let c = runtime.staticLayerCanvas
  if (!c) c = runtime.staticLayerCanvas = document.createElement('canvas')
  if (c.width !== w || c.height !== h){
    c.width = w
    c.height = h
    runtime.staticLayerSig = ""
  }
  return c
}

function buildVisiblePropSignature(items){
  if (!Array.isArray(items) || items.length === 0) return 'empty'
  return items.map(({ prop }) => {
    const p = prop || {}
    return [
      String(p.id || ''),
      String(p.propId || p.assetId || p.url || ''),
      Number(p.x || 0).toFixed(2),
      Number(p.y || 0).toFixed(2),
      Number(p.rot || 0).toFixed(4),
      Number(p.scale || 1).toFixed(3),
      p.flipX ? 1 : 0,
      p.flipY ? 1 : 0,
      p.shadowDisabled === true ? 'n' : (p.shadowDisabled === false ? 'y' : ''),
      String(p.url || '')
    ].join('~')
  }).join('|')
}

export function drawPlacedPropsTo({
  targetCtx,
  targetCamera,
  targetW,
  targetH,
  cacheForWalls,
  cacheSignature = '',
  placedProps,
  dungeonStyle,
  runtime,
  getPlacedPropRenderSize,
  getPropById,
  getPropImage,
  propImageCache,
  selectedPropId = null,
  useStaticCache = false,
  cameraSignature = ''
}){
  if (!Array.isArray(placedProps) || placedProps.length === 0) return
  const shadowCullPad = Math.max(24, Math.ceil((Number(dungeonStyle?.shadow?.length || 0) * 0.6 + 12) * Math.max(1, targetCamera.zoom)))
  const visibleProps = getVisiblePlacedProps({
    placedProps,
    targetCamera,
    targetW,
    targetH,
    extraPadPx: shadowCullPad,
    getPlacedPropRenderSize,
    getPropById,
    getPropImage,
    propImageCache
  })
  if (!visibleProps.length) return

  const staticProps = useStaticCache
    ? visibleProps.filter(item => String(item?.prop?.id || '') !== String(selectedPropId || ''))
    : visibleProps
  const liveProps = useStaticCache
    ? visibleProps.filter(item => String(item?.prop?.id || '') === String(selectedPropId || ''))
    : []

  const shadowMasterEnabled = !!(dungeonStyle?.shadow?.enabled)
  const propShadowsGloballyEnabled = shadowMasterEnabled && (dungeonStyle?.shadow?.allPropsEnabled !== false)
  const shadowCapableCount = propShadowsGloballyEnabled ? staticProps.reduce((acc, item) => {
    const propMeta = item.propMeta
    const shadowEnabled =
      (item.prop?.shadowDisabled === true) ? false :
      (item.prop?.shadowDisabled === false) ? true :
      (propMeta?.castShadow !== false)
    return acc + ((shadowEnabled && item.img?.complete && item.img?.naturalWidth > 0) ? 1 : 0)
  }, 0) : 0

  const needsShadowPass = propShadowsGloballyEnabled && shadowCapableCount > 0
  const shadowMaskC = needsShadowPass ? getTempCanvas(runtime, 'shadowMask', targetW, targetH) : null
  const propOccC = needsShadowPass ? getTempCanvas(runtime, 'propOcc', targetW, targetH) : null
  const wallOccC = needsShadowPass ? getTempCanvas(runtime, 'wallOcc', targetW, targetH) : null
  const shadowTintC = needsShadowPass ? getTempCanvas(runtime, 'shadowTint', targetW, targetH) : null
  const propOccExpandedC = needsShadowPass ? getTempCanvas(runtime, 'propOccExpanded', targetW, targetH) : null
  const smctx = shadowMaskC ? shadowMaskC.getContext('2d', { willReadFrequently: true }) : null
  const poctx = propOccC ? propOccC.getContext('2d') : null
  const poectx = propOccExpandedC ? propOccExpandedC.getContext('2d') : null
  const woctx = wallOccC ? wallOccC.getContext('2d', { willReadFrequently: true }) : null
  const stctx = shadowTintC ? shadowTintC.getContext('2d') : null

  if (smctx) {
    smctx.clearRect(0,0,targetW,targetH)
    smctx.globalCompositeOperation = 'source-over'
    smctx.imageSmoothingEnabled = false
  }
  if (poctx) {
    poctx.clearRect(0,0,targetW,targetH)
    poctx.globalCompositeOperation = 'source-over'
    poctx.imageSmoothingEnabled = false
  }
  if (poectx) {
    poectx.clearRect(0,0,targetW,targetH)
    poectx.globalCompositeOperation = 'source-over'
    poectx.imageSmoothingEnabled = false
  }
  if (woctx) {
    woctx.clearRect(0,0,targetW,targetH)
    woctx.globalCompositeOperation = 'source-over'
    woctx.imageSmoothingEnabled = true
  }

  if (needsShadowPass && smctx && poctx){
    for (const item of staticProps){
      const a = item.prop
      const img = item.img
      if (!a || !a.url || !img) continue
      const c = item.screen
      const w = item.w
      const h = item.h

      if (img.complete && img.naturalWidth > 0){
        poctx.save()
        poctx.translate(c.x, c.y)
        if (a.rot) poctx.rotate(a.rot)
        if (a.flipX === true || a.flipY === true) poctx.scale(a.flipX === true ? -1 : 1, a.flipY === true ? -1 : 1)
        poctx.drawImage(img, -w/2, -h/2, w, h)
        poctx.restore()
      }

      const shadowEnabled =
        (a?.shadowDisabled === true) ? false :
        (a?.shadowDisabled === false) ? true :
        (item.propMeta?.castShadow !== false)
      if (!shadowEnabled || !(img.complete && img.naturalWidth > 0)) continue
      const shadowLayer = getPropShadowCanvasLikeWalls({ runtime, propInst: a, img, drawW: w, drawH: h, dungeonStyle, zoomOverride: targetCamera.zoom })
      if (!shadowLayer?.canvas) continue
      smctx.save()
      smctx.translate(c.x, c.y)
      if (a.rot) smctx.rotate(a.rot)
      const shadowScaleX = w / Math.max(1, Number(shadowLayer.sourceW || w))
      const shadowScaleY = h / Math.max(1, Number(shadowLayer.sourceH || h))
      const shadowDestW = shadowLayer.canvas.width * shadowScaleX
      const shadowDestH = shadowLayer.canvas.height * shadowScaleY
      const shadowDestX = (-Number(shadowLayer.sourceW || w) / 2 - Number(shadowLayer.pad || 0)) * shadowScaleX
      const shadowDestY = (-Number(shadowLayer.sourceH || h) / 2 - Number(shadowLayer.pad || 0)) * shadowScaleY
      smctx.drawImage(shadowLayer.canvas, shadowDestX, shadowDestY, shadowDestW, shadowDestH)
      smctx.restore()
    }

    try {
      const maskImg = smctx.getImageData(0, 0, targetW, targetH)
      const d = maskImg.data
      for (let i = 0; i < d.length; i += 4){
        d[i] = 0; d[i+1] = 0; d[i+2] = 0
        d[i+3] = d[i+3] > 0 ? 255 : 0
      }
      smctx.putImageData(maskImg, 0, 0)
    } catch {}

    const occOverlapPx = Math.max(1, Math.min(2, Math.round(targetCamera.zoom * 0.03)))
    const lightDir = (() => {
      const g = dungeonStyle?.shadow?.dir || { x: 0.707, y: 0.707 }
      const lx = -Number(g.x || 0)
      const ly = -Number(g.y || 0)
      const mag = Math.hypot(lx, ly) || 1
      return { x: lx / mag, y: ly / mag }
    })()
    const occMaskForCutout = (() => {
      if (!poectx || !propOccExpandedC) return propOccC
      poectx.clearRect(0,0,targetW,targetH)
      if (occOverlapPx > 0){
        for (let ox = -occOverlapPx; ox <= occOverlapPx; ox++){
          for (let oy = -occOverlapPx; oy <= occOverlapPx; oy++){
            if ((ox*ox + oy*oy) > occOverlapPx*occOverlapPx) continue
            poectx.drawImage(propOccC, ox, oy)
          }
        }
      } else {
        poectx.drawImage(propOccC, 0, 0)
      }

      const lightCarvePx = Math.max(1, Math.min(4, Math.round(targetCamera.zoom * 0.06)))
      const stepX = lightDir.x === 0 ? 0 : Math.sign(lightDir.x)
      const stepY = lightDir.y === 0 ? 0 : Math.sign(lightDir.y)
      for (let i = 1; i <= lightCarvePx; i++){
        const ox = Math.round(lightDir.x * i)
        const oy = Math.round(lightDir.y * i)
        poectx.drawImage(propOccC, ox, oy)
        if (stepX !== 0) poectx.drawImage(propOccC, ox + stepX, oy)
        if (stepY !== 0) poectx.drawImage(propOccC, ox, oy + stepY)
      }
      return propOccExpandedC
    })()
    smctx.globalCompositeOperation = 'destination-out'
    smctx.drawImage(occMaskForCutout, 0, 0)
    smctx.globalCompositeOperation = 'source-over'

    if (cacheForWalls?.maskCanvas && cacheForWalls?.bounds && cacheForWalls?.ppu) {
      try {
        woctx && woctx.clearRect(0,0,targetW,targetH)
        if (woctx){
          drawCompiledLayerToScreen(woctx, cacheForWalls.maskCanvas, cacheForWalls, targetCamera)
          smctx.globalCompositeOperation = 'destination-in'
          smctx.drawImage(wallOccC, 0, 0)
          smctx.globalCompositeOperation = 'source-over'
        }
      } catch {}
    }

    if (woctx && cacheForWalls?.shadowCanvas && cacheForWalls?.bounds && cacheForWalls?.ppu) {
      woctx.clearRect(0,0,targetW,targetH)
      drawCompiledLayerToScreen(woctx, cacheForWalls.shadowCanvas, cacheForWalls, targetCamera)
      try {
        const maskImg = smctx.getImageData(0, 0, targetW, targetH)
        const wallImg = woctx.getImageData(0, 0, targetW, targetH)
        const md = maskImg.data
        const wd = wallImg.data
        const npx = targetW * targetH
        const shadowOpacity = Math.max(0.001, Math.min(1, Number(dungeonStyle?.shadow?.opacity ?? 0.34)))
        const wallOccThreshold = 4
        const propOcc = new Uint8Array(npx)
        const wallOcc = new Uint8Array(npx)
        let k = 0
        for (let i = 0; i < md.length; i += 4, k++) {
          propOcc[k] = md[i+3] > 0 ? 1 : 0
          wallOcc[k] = wd[i+3] >= wallOccThreshold ? 1 : 0
        }
        let comb = new Uint8Array(npx)
        for (let i = 0; i < npx; i++) comb[i] = (propOcc[i] | wallOcc[i])
        const dil = new Uint8Array(npx)
        for (let y = 0; y < targetH; y++) {
          const y0 = Math.max(0, y - 1), y1 = Math.min(targetH - 1, y + 1)
          for (let x = 0; x < targetW; x++) {
            let on = 0
            const x0 = Math.max(0, x - 1), x1 = Math.min(targetW - 1, x + 1)
            for (let yy = y0; yy <= y1 && !on; yy++) {
              let idx = yy * targetW + x0
              for (let xx = x0; xx <= x1; xx++, idx++) { if (comb[idx]) { on = 1; break } }
            }
            dil[y * targetW + x] = on
          }
        }
        const closed = new Uint8Array(npx)
        for (let y = 0; y < targetH; y++) {
          const y0 = Math.max(0, y - 1), y1 = Math.min(targetH - 1, y + 1)
          for (let x = 0; x < targetW; x++) {
            let on = 1
            const x0 = Math.max(0, x - 1), x1 = Math.min(targetW - 1, x + 1)
            for (let yy = y0; yy <= y1 && on; yy++) {
              let idx = yy * targetW + x0
              for (let xx = x0; xx <= x1; xx++, idx++) { if (!dil[idx]) { on = 0; break } }
            }
            closed[y * targetW + x] = on
          }
        }

        k = 0
        for (let i = 0; i < md.length; i += 4, k++) {
          const wallA = wd[i+3] / 255
          const targetA = closed[k] ? shadowOpacity : 0
          let addA = 0
          if (targetA > wallA + 1e-4) {
            const denom = Math.max(1e-4, 1 - wallA)
            addA = Math.max(0, Math.min(1, (targetA - wallA) / denom))
          }
          md[i] = 0; md[i+1] = 0; md[i+2] = 0
          md[i+3] = Math.round(addA * 255)
        }
        smctx.putImageData(maskImg, 0, 0)
      } catch {}
    } else if (smctx) {
      try {
        const maskImg = smctx.getImageData(0, 0, targetW, targetH)
        const md = maskImg.data
        const shadowOpacity = Math.max(0, Math.min(1, Number(dungeonStyle?.shadow?.opacity ?? 0.34)))
        for (let i = 0; i < md.length; i += 4) {
          md[i] = 0; md[i+1] = 0; md[i+2] = 0
          md[i+3] = Math.round((md[i+3] / 255) * shadowOpacity * 255)
        }
        smctx.putImageData(maskImg, 0, 0)
      } catch {}
    }

    if (stctx){
      stctx.clearRect(0,0,targetW,targetH)
      stctx.fillStyle = dungeonStyle?.shadow?.color || '#000000'
      stctx.globalAlpha = 1
      stctx.fillRect(0,0,targetW,targetH)
      stctx.globalCompositeOperation = 'destination-in'
      stctx.drawImage(shadowMaskC, 0, 0)
      stctx.globalCompositeOperation = 'source-over'
      targetCtx.drawImage(shadowTintC, 0, 0)
    }
  }

  targetCtx.save()
  for (const item of [...staticProps, ...liveProps]){
    const a = item.prop
    const img = item.img
    if (!a || !a.url || !img) continue
    const c = item.screen
    const w = item.w
    const h = item.h

    targetCtx.save()
    targetCtx.translate(c.x, c.y)
    if (a.rot) targetCtx.rotate(a.rot)
    if (a.flipX === true || a.flipY === true) targetCtx.scale(a.flipX === true ? -1 : 1, a.flipY === true ? -1 : 1)

    targetCtx.globalAlpha = 1
    if (img.complete && img.naturalWidth > 0){
      targetCtx.drawImage(img, -w/2, -h/2, w, h)
    } else {
      targetCtx.fillStyle = "rgba(17,24,39,0.16)"
      targetCtx.strokeStyle = "rgba(17,24,39,0.28)"
      targetCtx.lineWidth = 1
      targetCtx.fillRect(-w/2, -h/2, w, h)
      targetCtx.strokeRect(-w/2, -h/2, w, h)
      targetCtx.beginPath()
      targetCtx.moveTo(-w/2, -h/2); targetCtx.lineTo(w/2, h/2)
      targetCtx.moveTo(w/2, -h/2); targetCtx.lineTo(-w/2, h/2)
      targetCtx.stroke()
    }
    targetCtx.restore()
  }
  targetCtx.restore()
}
