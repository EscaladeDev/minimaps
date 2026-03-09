export function createTextMetricsCache(){
  return {
    map: new Map(),
    cameraSig: ""
  }
}

export function invalidateTextMetricsCache(cache){
  if (!cache) return
  cache.map.clear()
  cache.cameraSig = ""
}

export function prepareTextMetricsFrame(cache, cameraSignature){
  if (!cache) return
  if (cache.cameraSig !== cameraSignature){
    cache.map.clear()
    cache.cameraSig = cameraSignature
  }
}

export function getCachedTextScreenBounds(cache, targetCtx, textObj, cam, fontCssFn){
  if (!cache || !textObj) return null
  const zoom = Number(cam?.zoom || 1)
  const key = [
    textObj.id || '',
    Number(textObj.x || 0).toFixed(2),
    Number(textObj.y || 0).toFixed(2),
    Number(textObj.fontSize || 20).toFixed(2),
    String(textObj.fontFamily || ''),
    String(textObj.text || ''),
    Number(cam?.x || 0).toFixed(3),
    Number(cam?.y || 0).toFixed(3),
    zoom.toFixed(4)
  ].join('|')
  const cached = cache.map.get(key)
  if (cached) return cached

  const s = cam.worldToScreen({ x: textObj.x, y: textObj.y })
  targetCtx.save()
  targetCtx.font = fontCssFn(textObj, cam)
  const m = targetCtx.measureText(textObj.text || '')
  targetCtx.restore()
  const fs = Math.max(8, (Number(textObj.fontSize) || 20) * zoom)
  const pad = 6
  const w = Math.max(8, m.width || 0)
  const bounds = { x: s.x - pad, y: s.y - fs - pad, w: w + pad * 2, h: fs + pad * 2 }
  cache.map.set(key, bounds)
  return bounds
}
