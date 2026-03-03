export class Dungeon {
  constructor() {
    this.gridSize = 32
    this.subSnapDiv = 4 // invisible snap grid = gridSize / subSnapDiv
    this.spaces = []        // {id, polygon: [{x,y}...]}
    this.paths = []         // {id, points:[{x,y}...]}
    this.water = { paths: [] } // water brush strokes {id, points:[{x,y}...], mode, width, seq}
    this.lines = []        // drawn line overlay strokes {id, points:[{x,y}...], mode, width, dashed, seq}
    this.shapes = []        // {id, kind:'regular', sides, center, radius, rotation, mode:'add'|'subtract'}
    this.__versions = { interior: 1, water: 1 }
    this.style = {
      // floorColor is the canonical interior fill color. `paper` is kept as a
      // legacy alias for compatibility with older saved maps.
      floorColor: "#ffffff",
      paper: "#ffffff",
      backgroundColor: "#f8f7f4",
      transparentBackground: false,
      wallColor: "#1f2933",
      wallWidth: 6,
      corridorWidth: 48,
      pathShapeMode: "smooth",
      pathSmoothness: 0.6,
      pathJaggedAmplitude: 1.45,
      pathJaggedFrequency: 1.15,
      shadow: { enabled: true, color: "#000000", length: 18, opacity: 0.34, dir: {x: 0.707, y: 0.707}, maxLen: 48 },
      hatch: { enabled: true, color: "#1f2933", density: 0.5, opacity: 1, depth: 12, inset: 2, angleRange: 1.15, minLen: 10, maxLen: 30 },
      snapStrength: 0.95,
      gridLineWidth: 1,
      gridOpacity: 0.06,
      msStep: 4,
      polySides: 6,
      water: {
        enabled: true,
        color: "#8ec8ff",
        opacity: 0.4,
        width: 52,
        outlineEnabled: true,
        ripplesEnabled: true,
        outlineColor: "#1f2933",
        outlinePx: 10,
        rippleColor: "#1f2933",
        ripplePx: 7,
        rippleSpacing: 110,
        glowStrength: 1.28,
        depthStrength: 1.12,
        sparkleAmount: 0.34,
        centerGlow: 1.22,
        seamBright: 1.34,
        cellSize: 1.32,
        rippleInsetMin: 18,
        rippleInsetMax: 54,
        rippleLengthMin: 28,
        rippleLengthMax: 62
      },
      lines: {
        color: "#1f2933",
        width: 1.75,
        dashed: false,
        dashPx: 18
      },
    }
  }
}
