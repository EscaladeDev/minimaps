export function createLiveLayerCache(options = {}){
  return {
    alpha: options.alpha !== false,
    canvas: null,
    ctx: null,
    sizeKey: "",
    renderKey: ""
  }
}

export function invalidateLiveLayer(cache){
  if (!cache) return
  cache.renderKey = ""
}

export function resetLiveLayerSize(cache){
  if (!cache) return
  cache.sizeKey = ""
  cache.renderKey = ""
}

export function ensureLiveLayer(cache, width, height){
  const w = Math.max(1, width | 0)
  const h = Math.max(1, height | 0)
  const sizeKey = `${w}x${h}`
  if (!cache.canvas || cache.sizeKey !== sizeKey){
    cache.canvas = document.createElement('canvas')
    cache.canvas.width = w
    cache.canvas.height = h
    cache.ctx = cache.canvas.getContext('2d', { alpha: cache.alpha !== false })
    cache.sizeKey = sizeKey
    cache.renderKey = ""
  }
  return cache.ctx
}

export function drawLiveLayer(targetCtx, cache, width, height, renderKey, drawFn){
  const ctx = ensureLiveLayer(cache, width, height)
  if (cache.renderKey !== renderKey){
    ctx.clearRect(0, 0, width, height)
    drawFn(ctx, width, height)
    cache.renderKey = renderKey
  }
  targetCtx.drawImage(cache.canvas, 0, 0, width, height)
}
