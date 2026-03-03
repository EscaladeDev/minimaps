import { Dungeon } from "./model/dungeon.js"
import { Camera } from "./canvas/camera.js"
import { snapHard, snapSoft } from "./utils/snap.js"
import { dist, norm, rotate } from "./utils/math.js"
import { compileWorldCache, drawCompiledBase, drawCompiledExteriorGrid } from "./canvas/render.js"
import { PATH_SHAPE_MODES, getDefaultPathShapeSettings, normalizePathShapeSettings, getPathRenderGeometry } from "./utils/path-styles.js"

const canvas = document.querySelector("canvas")
const ctx = canvas.getContext("2d", { alpha: true })
const dungeon = new Dungeon()
const camera = new Camera()

const maskCanvas = document.createElement("canvas")
const maskCtx = maskCanvas.getContext("2d", { willReadFrequently: true })
let W=0, H=0

let compiledCache = null
let compiledSig = ""

function ensureCompileVersions(){
  if (!dungeon.__versions || typeof dungeon.__versions !== "object") dungeon.__versions = { interior: 1, water: 1, lines: 1 }
  if (!Number.isFinite(Number(dungeon.__versions.interior))) dungeon.__versions.interior = 1
  if (!Number.isFinite(Number(dungeon.__versions.water))) dungeon.__versions.water = 1
  if (!Number.isFinite(Number(dungeon.__versions.lines))) dungeon.__versions.lines = 1
}
function bumpInteriorVersion(){ ensureCompileVersions(); dungeon.__versions.interior += 1 }
function bumpWaterVersion(){ ensureCompileVersions(); dungeon.__versions.water += 1 }
function bumpLineVersion(){ ensureCompileVersions(); dungeon.__versions.lines += 1 }
ensureCompileVersions()

// Global edit ordering across ALL tool types (rectangle/path/free/polygon).
// This lets subtracts apply correctly no matter which tool created the geometry.
let editSeqCounter = 1
function nextEditSeq(){ return editSeqCounter++ }
function normalizeEditSequences(){
  const all = [
    ...(Array.isArray(dungeon.spaces) ? dungeon.spaces : []),
    ...(Array.isArray(dungeon.paths) ? dungeon.paths : []),
    ...(Array.isArray(dungeon.lines) ? dungeon.lines : []),
    ...(Array.isArray(dungeon.shapes) ? dungeon.shapes : [])
  ]
  let fallback = 1
  for (const item of all){
    if (!item || !Number.isFinite(Number(item.seq))) item.seq = fallback++
  }
  refreshEditSeqCounter()
}
function refreshEditSeqCounter(){
  let maxSeq = 0
  for (const arr of [dungeon.spaces, dungeon.paths, dungeon.lines, dungeon.shapes]){
    for (const item of (arr || [])){
      const s = Number(item && item.seq)
      if (Number.isFinite(s) && s > maxSeq) maxSeq = s
    }
  }
  editSeqCounter = Math.max(1, Math.floor(maxSeq) + 1)
}
function resetTransientDrafts(){
  draft = null
  draftRect = null
  freeDraw = null
  lineDraw = null
  draftShape = null
  draftArc = null
  shapeDrag = null
  eraseStroke = null
}
function clearPropSelection(){
  selectedPropId = null
  propTransformDrag = null
}

// Tools
const toolButtons = Array.from(document.querySelectorAll("button.tool"))
let tool = "space"
let underMode = false
function syncToolUI(){
  toolButtons.forEach(b => {
    const isEraseBtn = b.dataset.tool === "erase"
    const active = isEraseBtn ? !!underMode : (b.dataset.tool === tool)
    b.classList.toggle("primary", active)
  })
  const showCorridorWidth = ["path","free","arc"].includes(tool)
  const showPathShapeControls = ["path","free","arc"].includes(tool)
  const showPolySides = tool === "poly"
  const showLineOptions = tool === "line"
  const showToolOptions = showCorridorWidth || showPolySides || showLineOptions || showPathShapeControls
  const corridorToolRow = document.getElementById("corridorToolRow")
  const polyToolRow = document.getElementById("polyToolRow")
  const lineToolRow = document.getElementById("lineToolRow")
  const pathShapeRow = document.getElementById("pathShapeRow")
  const pathSmoothnessRow = document.getElementById("pathSmoothnessRow")
  const pathAmplitudeRow = document.getElementById("pathAmplitudeRow")
  const pathFrequencyRow = document.getElementById("pathFrequencyRow")
  if (polyToolOptions) {
    polyToolOptions.classList.toggle("hidden", !showToolOptions)
    polyToolOptions.hidden = !showToolOptions
  }
  if (corridorToolRow) {
    corridorToolRow.classList.toggle("hidden", !showCorridorWidth)
    corridorToolRow.hidden = !showCorridorWidth
  }
  if (polyToolRow) {
    polyToolRow.classList.toggle("hidden", !showPolySides)
    polyToolRow.hidden = !showPolySides
  }
  if (lineToolRow) {
    lineToolRow.classList.toggle("hidden", !showLineOptions)
    lineToolRow.hidden = !showLineOptions
  }
  if (pathShapeRow) {
    pathShapeRow.classList.toggle("hidden", !showPathShapeControls)
    pathShapeRow.hidden = !showPathShapeControls
  }
  const currentShapeMode = PATH_SHAPE_MODES.includes(dungeon.style?.pathShapeMode) ? dungeon.style.pathShapeMode : "smooth"
  if (pathSmoothnessRow) {
    const show = showPathShapeControls && currentShapeMode === "smooth"
    pathSmoothnessRow.classList.toggle("hidden", !show)
    pathSmoothnessRow.hidden = !show
  }
  if (pathAmplitudeRow) {
    const show = showPathShapeControls && currentShapeMode === "jagged"
    pathAmplitudeRow.classList.toggle("hidden", !show)
    pathAmplitudeRow.hidden = !show
  }
  if (pathFrequencyRow) {
    const show = showPathShapeControls && currentShapeMode === "jagged"
    pathFrequencyRow.classList.toggle("hidden", !show)
    pathFrequencyRow.hidden = !show
  }
}
function setTool(t){
  if (t === "erase") {
    // Erase is a toggle over the current drawing tool, but it is still a non-select interaction.
    clearPropSelection()
    underMode = !underMode
    syncUnderUI()
    syncToolUI()
    return
  }
  if (t !== tool) {
    resetTransientDrafts() // clear path/free/rect/poly previews when switching tools
    selectedShapeId = null
    if (t !== "select") { clearPropSelection(); selectedTextId = null; syncTextPanelVisibility() }
  } else if (t !== "select") {
    clearPropSelection()
    selectedTextId = null
    syncTextPanelVisibility()
  }
  tool = t
  syncToolUI()
}
function syncUnderUI(){ if (btnUnder) btnUnder.classList.toggle("primary", !!underMode); syncToolUI() }
toolButtons.forEach(b => b.addEventListener("click", () => { selectedShapeId=null; selectedPropId=null; selectedTextId=null; syncTextPanelVisibility(); setTool(b.dataset.tool) }))
if (tool === "erase") tool = "space"

const btnUnder = document.getElementById("btnUnder")
const btnFinish = document.getElementById("btnFinish")
const btnUndo = document.getElementById("btnUndo")
const btnRedo = document.getElementById("btnRedo")
const btnClear = document.getElementById("btnClear")
const btnSaveMap = document.getElementById("btnSaveMap")
const btnLoadMap = document.getElementById("btnLoadMap")
const btnBugReport = document.getElementById("btnBugReport")
const fileLoadMap = document.getElementById("fileLoadMap")
const btnPropsPick = document.getElementById("btnPropsPick")
const btnPropsClear = document.getElementById("btnPropsClear")
const btnPropsDefaults = document.getElementById("btnPropsDefaults")
const propsFolderInput = document.getElementById("propsFolderInput")
const propsShelf = document.getElementById("propsShelf")
const propsSearchInput = document.getElementById("propsSearchInput")
const propsTree = document.getElementById("propsTree")
const tabStyleBtn = document.getElementById("tabStyleBtn")
const tabAssetsBtn = document.getElementById("tabAssetsBtn")
const leftDrawer = document.getElementById("leftDrawer")
const btnDrawerToggle = document.getElementById("btnDrawerToggle")
const btnDrawerCollapse = document.getElementById("btnDrawerCollapse")
const drawerPeekTab = document.getElementById("drawerPeekTab")
const hudRoot = document.querySelector(".hud.appShellHud")
const panelTabButtons = Array.from(document.querySelectorAll("[data-panel-tab]"))
const panelPages = Array.from(document.querySelectorAll("[data-panel-page]"))
const btnExport = document.getElementById("btnExport")
const btnPDF = document.getElementById("btnPDF")
const pdfExportModal = document.getElementById("pdfExportModal")
const pdfExportSummary = document.getElementById("pdfExportSummary")
const btnPdfModalClose = document.getElementById("btnPdfModalClose")
const btnPdfCancel = document.getElementById("btnPdfCancel")
const btnPdfConfirm = document.getElementById("btnPdfConfirm")
const pdfModeInput = document.getElementById("pdfMode")
const pdfPaperInput = document.getElementById("pdfPaper")
const pdfOrientationInput = document.getElementById("pdfOrientation")
const pdfSourceInput = document.getElementById("pdfSource")
const pdfPaddingSquaresInput = document.getElementById("pdfPaddingSquares")
const pdfMarginInInput = document.getElementById("pdfMarginIn")
const pdfRasterDpiInput = document.getElementById("pdfRasterDpi")
const pdfRasterDpiOut = document.getElementById("pdfRasterDpiOut")
const pdfSquareSizeInInput = document.getElementById("pdfSquareSizeIn")
const pdfOverlapSquaresInput = document.getElementById("pdfOverlapSquares")
const pdfLabelsInput = document.getElementById("pdfLabels")
const pdfTrimMarksInput = document.getElementById("pdfTrimMarks")
const pdfOverviewInput = document.getElementById("pdfOverview")
const pdfIncludeEmptyTilesInput = document.getElementById("pdfIncludeEmptyTiles")
const pdfTiledSection = document.getElementById("pdfTiledSection")
const pngExportModal = document.getElementById("pngExportModal")
const pngExportSummary = document.getElementById("pngExportSummary")
const pngExportWarning = document.getElementById("pngExportWarning")
const exportProgressOverlay = document.getElementById("exportProgressOverlay")
const exportProgressTitle = document.getElementById("exportProgressTitle")
const exportProgressMessage = document.getElementById("exportProgressMessage")
const exportProgressFill = document.getElementById("exportProgressFill")
const exportProgressMeta = document.getElementById("exportProgressMeta")
const btnCoverHome = document.getElementById("btnCoverHome")
const coverPage = document.getElementById("coverPage")
const btnCoverClose = document.getElementById("btnCoverClose")
const coverPatchNotes = document.getElementById("coverPatchNotes")
const btnPngModalClose = document.getElementById("btnPngModalClose")
const btnPngCancel = document.getElementById("btnPngCancel")
const btnPngConfirm = document.getElementById("btnPngConfirm")
const pngSourceInput = document.getElementById("pngSource")
const pngPaddingSquaresInput = document.getElementById("pngPaddingSquares")
const pngSquareSizeInInput = document.getElementById("pngSquareSizeIn")
const pngDpiInput = document.getElementById("pngDpi")
const pngDpiOut = document.getElementById("pngDpiOut")


function dsSvgIcon(name){
  const common = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';
  const icons = {
    select: `<svg ${common}><path d="M4 3l13 9-5 1 2 6-3 1-2-6-4 4z"/></svg>`,
    space: `<svg ${common}><rect x="4" y="6" width="16" height="12" rx="2"/></svg>`,
    path: `<svg ${common}><circle cx="6" cy="17" r="2"/><circle cx="18" cy="7" r="2"/><path d="M8 16l8-8"/></svg>`,
    free: `<svg ${common}><path d="M4 16c3-8 6 8 9 0s4-7 7-3"/></svg>`,
    water: `<svg ${common}><path d="M12 3c3 4 6 7 6 10a6 6 0 1 1-12 0c0-3 3-6 6-10z"/></svg>`,
    line: `<svg ${common}><path d="M14.5 5.5 18.5 9.5"/><path d="M6 18l2.4-7.2 8.1-8.1 4 4-8.1 8.1z"/><path d="M5.2 20.2l3.3-.9-2.4-2.4z"/></svg>`,
    arc: `<svg ${common}><path d="M6 18a8 8 0 1 1 12 0"/><path d="M18 18h-4"/></svg>`,
    poly: `<svg ${common}><path d="M12 4l7 5-3 9H8L5 9z"/></svg>`,
    text: `<svg ${common}><path d="M4 6h16"/><path d="M12 6v14"/><path d="M8 10h8"/></svg>`,
    erase: `<svg ${common}><path d="M7 16l7-7 4 4-7 7H7l-2-2z"/><path d="M14 9l3-3 4 4-3 3"/><path d="M4 20h10"/></svg>`,
    undo: `<svg ${common}><path d="M10 7L5 12l5 5"/><path d="M6 12h8a5 5 0 1 1 0 10h-1"/></svg>`,
    redo: `<svg ${common}><path d="M14 7l5 5-5 5"/><path d="M18 12h-8a5 5 0 1 0 0 10h1"/></svg>`,
    clear: `<svg ${common}><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/></svg>`,
    save: `<svg ${common}><path d="M5 4h11l3 3v13H5z"/><path d="M8 4v6h8"/><path d="M9 20v-6h6v6"/></svg>`,
    load: `<svg ${common}><path d="M3 19V8a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9"/><path d="M3 19l2.2-6h15.6L19 19z"/><path d="M12 9v6"/><path d="M9.5 12.5 12 15l2.5-2.5"/></svg>`,
    png: `<svg ${common}><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.4"/><path d="M6 17l4-4 3 3 3-4 2 5"/></svg>`,
    pdf: `<svg ${common}><path d="M6 3h9l5 5v13H6z"/><path d="M15 3v5h5"/><path d="M8 14h8"/><path d="M8 18h5"/></svg>`,
    bug: `<svg ${common}><ellipse cx="12" cy="13" rx="5.5" ry="6.5"/><circle cx="12" cy="7.5" r="2.2"/><path d="M9 4.8 7.6 3.6"/><path d="M15 4.8l1.4-1.2"/><path d="M7 11H4.5"/><path d="M7 15H4.5"/><path d="M17 11h2.5"/><path d="M17 15h2.5"/><path d="M9.2 20.1 8 22"/><path d="M14.8 20.1 16 22"/></svg>`,
    under: `<svg ${common}><path d="M4 7h16"/><path d="M12 7v10"/><path d="M8 13l4 4 4-4"/></svg>`,
    finish: `<svg ${common}><path d="M5 13l4 4L19 7"/></svg>`
  };
  return icons[name] || `<svg ${common}><circle cx="12" cy="12" r="8"/></svg>`;
}

function injectToolbarIconStyles(){
  if (document.getElementById('toolbarIconUiPatch')) return;
  const style = document.createElement('style');
  style.id = 'toolbarIconUiPatch';
  style.textContent = `
    .toolbarRow{display:grid !important;grid-template-columns:repeat(2,minmax(0,1fr)) !important;align-items:start;grid-auto-flow:row;grid-auto-rows:auto;gap:12px}.toolbarRow > *{min-width:0}.toolbarRow > button{width:100%}
    .toolbarRow button.iconOnlyBtn{width:36px;min-width:36px;padding:0;display:inline-flex;align-items:center;justify-content:center;gap:0;position:relative;overflow:visible}
    .toolbarRow button.iconOnlyBtn svg{width:18px;height:18px}
    .toolbarRow button.labelIconBtn{display:inline-flex;align-items:center;gap:.4rem}
    .toolbarRow button.labelIconBtn svg{width:16px;height:16px;flex:0 0 auto}
    .toolbarRow button.textOnlyBtn{display:inline-flex;align-items:center;justify-content:center;gap:0;padding:0 .65rem;min-width:56px;font-weight:600}
    .toolbarRow button.iconOnlyBtn:hover,.toolbarRow button.labelIconBtn:hover,.toolbarRow button.textOnlyBtn:hover{transform:translateY(-1px)}
    .toolbarRow button.iconOnlyBtn:hover{z-index:10001}
    .toolbarRow button.iconOnlyBtn[disabled],.toolbarRow button.labelIconBtn[disabled],.toolbarRow button.textOnlyBtn[disabled]{transform:none}
    .toolbarTools #polyToolOptions{display:block; width:100% !important; max-width:100% !important; min-width:0; box-sizing:border-box; overflow:hidden; margin-top:10px; justify-self:stretch; align-self:start; padding:12px; }
    .toolbarTools #polyToolOptions.hidden{display:none !important}
    .toolbarTools #polyToolOptions .row,.toolbarTools #polyToolOptions .toolbarRow,.toolbarTools #polyToolOptions .fieldRow{display:block !important;grid-template-columns:none !important}
    .toolbarTools #polyToolOptions label{display:block; width:100%; min-width:0}
    .toolbarTools #polyToolOptions .toolInlineRange{display:grid !important; grid-template-columns:1fr !important; gap:8px; width:100%; min-width:0}
    .toolbarTools #polyToolOptions .toolInlineRange.hidden,.toolbarTools #polyToolOptions .toolInlineRange[hidden],.toolbarTools #polyToolOptions label.hidden,.toolbarTools #polyToolOptions label[hidden]{display:none !important}
    .toolbarTools #polyToolOptions .toolInlineRange > span{display:block}
    .toolbarTools #polyToolOptions input[type="range"]{display:block;width:100%; min-width:0; max-width:100%; box-sizing:border-box; margin:0}
    .toolbarRow button.iconOnlyBtn[data-tip]:hover::after{content:attr(data-tip);position:absolute;left:50%;bottom:calc(100% + 8px);top:auto;transform:translateX(-50%);background:rgba(20,20,24,.95);color:#fff;padding:4px 8px;border-radius:8px;font-size:12px;line-height:1;white-space:nowrap;pointer-events:none;z-index:9999;box-shadow:0 6px 18px rgba(0,0,0,.18)}
    .toolbarRow button.iconOnlyBtn[data-tip]:hover::before{content:"";position:absolute;left:50%;bottom:calc(100% + 1px);top:auto;transform:translateX(-50%);border:4px solid transparent;border-top-color:rgba(20,20,24,.95);pointer-events:none;z-index:9999}
  `;
  document.head.appendChild(style);
}

function iconizeButton(btn, { icon, label, iconOnly = false, textOnly = false } = {}){
  if (!btn) return;
  const text = label || btn.getAttribute('aria-label') || btn.title || (btn.textContent || '').trim() || 'Button';
  btn.setAttribute('aria-label', text);
  btn.title = text;
  btn.dataset.tip = text;
  btn.classList.remove('iconOnlyBtn','labelIconBtn','textOnlyBtn');
  if (textOnly){
    btn.classList.add('textOnlyBtn');
    delete btn.dataset.tip;
    btn.textContent = text;
  } else if (iconOnly){
    btn.classList.add('iconOnlyBtn');
    btn.innerHTML = dsSvgIcon(icon);
  } else {
    btn.classList.add('labelIconBtn');
    delete btn.dataset.tip;
    btn.innerHTML = `${dsSvgIcon(icon)}<span>${text}</span>`;
  }
}

function applyToolbarUiOverhaul(){
  injectToolbarIconStyles();
  const toolIconMap = { select:'select', space:'space', path:'path', free:'free', line:'line', water:'water', arc:'arc', poly:'poly', text:'text', erase:'erase' };
  toolButtons.forEach(btn => {
    const toolName = btn.dataset.tool || 'tool';
    const nice = ({space:'Rectangle',path:'Straight Path',free:'Path',line:'Draw',water:'Water',arc:'Arc',poly:'Polygon',text:'Text',select:'Select',erase:'Erase'})[toolName] || toolName;
    if (toolName === 'text') iconizeButton(btn, { label: 'Text', textOnly: true });
    else iconizeButton(btn, { icon: toolIconMap[toolName] || 'select', label: nice, iconOnly: true });
  });
  iconizeButton(btnUndo, { icon:'undo', label:'Undo', iconOnly:true });
  iconizeButton(btnRedo, { icon:'redo', label:'Redo', iconOnly:true });
  iconizeButton(btnClear, { icon:'clear', label:'Clear all', iconOnly:true });
  iconizeButton(btnSaveMap, { icon:'save', label:'Save map', iconOnly:true });
  iconizeButton(btnLoadMap, { icon:'load', label:'Load map', iconOnly:true });
  if (btnBugReport) iconizeButton(btnBugReport, { icon:'bug', label:'Bug Report', iconOnly:true });
  iconizeButton(btnUnder, { icon:'under', label:'Draw under', iconOnly:true });
  iconizeButton(btnFinish, { icon:'finish', label:'Finish tool', iconOnly:true });
  iconizeButton(btnExport, { icon:'png', label:'PNG', iconOnly:false });
  iconizeButton(btnPDF, { icon:'pdf', label:'PDF', iconOnly:false });
}

// controls
const gridSize = document.getElementById("gridSize")
const corridorWidth = document.getElementById("corridorWidth")
const corridorWidthOut = document.getElementById("corridorWidthOut")
const pathShapeMode = document.getElementById("pathShapeMode")
const pathSmoothness = document.getElementById("pathSmoothness")
const pathSmoothnessOut = document.getElementById("pathSmoothnessOut")
const pathAmplitude = document.getElementById("pathAmplitude")
const pathAmplitudeOut = document.getElementById("pathAmplitudeOut")
const pathFrequency = document.getElementById("pathFrequency")
const pathFrequencyOut = document.getElementById("pathFrequencyOut")
const wallWidth = document.getElementById("wallWidth")
const wallColor = document.getElementById("wallColor")
const floorColor = document.getElementById("floorColor")
const backgroundColor = document.getElementById("backgroundColor")
const transparentBg = document.getElementById("transparentBg")
const polyToolOptions = document.getElementById("polyToolOptions")
const polySides = document.getElementById("polySides")
const polySidesOut = document.getElementById("polySidesOut")
const lineDashed = document.getElementById("lineDashed")
const snapDiv = document.getElementById("snapDiv")
const snapDivOut = document.getElementById("snapDivOut")
const gridLineWidth = document.getElementById("gridLineWidth")
const gridLineWidthOut = document.getElementById("gridLineWidthOut")
const gridOpacity = document.getElementById("gridOpacity")
const gridOpacityOut = document.getElementById("gridOpacityOut")
const darkModeUi = document.getElementById("darkModeUi")
const btnThemeMode = document.getElementById("btnThemeMode")
const themeColorMeta = document.querySelector('meta[name="theme-color"]')
const shadowOn = document.getElementById("shadowOn")
const shadowOpacity = document.getElementById("shadowOpacity")
const shadowColor = document.getElementById("shadowColor")
let shadowAllPropsToggle = null
const hatchOn = document.getElementById("hatchOn")
const hatchDensity = document.getElementById("hatchDensity")
const hatchOpacity = document.getElementById("hatchOpacity")
const hatchColor = document.getElementById("hatchColor")
const hatchDepth = document.getElementById("hatchDepth")
applyToolbarUiOverhaul()
const snapStrength = document.getElementById("snapStrength")
const propSnapToggle = document.getElementById("propSnapToggle")
const showTextPreview = document.getElementById("showTextPreview")
const showTextExport = document.getElementById("showTextExport")
const waterEnabled = document.getElementById("waterEnabled")
const waterColor = document.getElementById("waterColor")
const waterOpacity = document.getElementById("waterOpacity")
const waterWidth = document.getElementById("waterWidth")
const waterOutlineEnabled = document.getElementById("waterOutlineEnabled")
const waterRipplesEnabled = document.getElementById("waterRipplesEnabled")
const waterCellSize = document.getElementById("waterCellSize")
const waterSeamBright = document.getElementById("waterSeamBright")
const waterCenterGlow = document.getElementById("waterCenterGlow")
const waterDepthStrength = document.getElementById("waterDepthStrength")
const styleRenderGeneral = document.getElementById("styleRenderGeneral")
const textStylePanel = document.getElementById("textStylePanel")
const textContentInput = document.getElementById("textContentInput")
const textFontFamily = document.getElementById("textFontFamily")
const textFontSize = document.getElementById("textFontSize")
const textFontSizeOut = document.getElementById("textFontSizeOut")
const textColorInput = document.getElementById("textColorInput")
const textShowInPreview = document.getElementById("textShowInPreview")
const textShowInExport = document.getElementById("textShowInExport")
const textEditOverlay = document.getElementById("textEditOverlay")
const textCanvasEditor = document.getElementById("textCanvasEditor")
const googleFontFamilyInput = document.getElementById("googleFontFamilyInput")
const btnLoadGoogleFont = document.getElementById("btnLoadGoogleFont")
const googleFontStatus = document.getElementById("googleFontStatus")
const googleFontRecent = document.getElementById("googleFontRecent")

// Shadow puck
const puck = document.getElementById("shadowPuck")
const pctx = puck.getContext("2d")
const puckSize = 120
const C = { x: puckSize/2, y: puckSize/2 }
const R = 50

const UI_THEME_KEY = "DelvSketch.uiTheme"

function getPreferredTheme(){ return "light" }

function applyUiTheme(_theme){
  document.body.dataset.theme = "light"
  if (darkModeUi) darkModeUi.checked = false
  if (btnThemeMode) btnThemeMode.textContent = "Light"
  if (themeColorMeta) themeColorMeta.setAttribute("content", "#f8f7f4")
  try { localStorage.removeItem(UI_THEME_KEY) } catch {}
}

function toggleUiTheme(){
  applyUiTheme("light")
}

function ensureGlobalPropShadowToggleUi(){
  if (shadowAllPropsToggle && document.body.contains(shadowAllPropsToggle)) return shadowAllPropsToggle
  const shadowSectionBody = shadowOn?.closest?.(".styleSectionBody") || shadowOn?.closest?.("details")?.querySelector?.(".styleSectionBody")
  if (!shadowSectionBody) return null
  let existing = document.getElementById("shadowAllPropsOn")
  if (existing) { shadowAllPropsToggle = existing; return existing }
  const label = document.createElement("label")
  label.className = "inline"
  label.style.marginTop = "2px"
  const span = document.createElement("span")
  span.textContent = "Shadows on all props"
  const input = document.createElement("input")
  input.type = "checkbox"
  input.id = "shadowAllPropsOn"
  input.checked = true
  label.appendChild(span)
  label.appendChild(input)
  shadowSectionBody.appendChild(label)
  shadowAllPropsToggle = input
  return input
}

const PATCH_NOTES = [
  {
    version: "v0.15",
    date: "February 27, 2026",
    groups: [
      { title: "Added", items: [
        "Informational cover page integrated directly into the app.",
        "Patch notes hub accessible from the DelvSketch version badge.",
        "Feature overview and development status sections for orientation."
      ] },
      { title: "Fixed", items: [
        "Optimized arc tool interactions."
      ] }
    ]
  },
  {
    version: "v0.14",
    date: "February 26, 2026",
    groups: [
      { title: "Added", items: [
        "Gridline adjustments.",
        "Visibility of the grid before walls are placed."
      ] },
      { title: "Fixed", items: [
        "Sewer grate default shadow behavior and related shadow preset regressions.",
        "PDF export handling for square print sizing below 1 inch."
      ] }
    ]
  },
  {
    version: "v0.13",
    date: "February 25, 2026",
    groups: [
      { title: "Added", items: [
        "Advanced shadow controls for props with manifest-driven defaults.",
        "Added water, including ripple and edge behavior tuning."
      ] },
      { title: "Fixed", items: [
        "Performance-sensitive visual systems continue to be tuned conservatively to reduce editor latency."
      ] }
    ]
  }
]

let coverPageOpen = false
function renderCoverPatchNotes(){
  if (!coverPatchNotes) return
  coverPatchNotes.innerHTML = PATCH_NOTES.map(entry => `
    <article class="coverPatchEntry">
      <div class="coverPatchHeader">
        <div class="coverPatchVersion">${entry.version}</div>
        <div class="coverPatchDate">${entry.date}</div>
      </div>
      ${entry.groups.map(group => `
        <section class="coverPatchGroup">
          <div class="coverPatchGroupTitle">${group.title}</div>
          <ul class="coverPatchList">
            ${group.items.map(item => `<li>${item}</li>`).join("")}
          </ul>
        </section>
      `).join("")}
    </article>
  `).join("")
}
function showCoverPage(){
  if (!coverPage) return
  coverPage.classList.remove("hidden")
  coverPage.setAttribute("aria-hidden", "false")
  document.body.classList.add("body-cover-open")
  coverPageOpen = true
}
function hideCoverPage(){
  if (!coverPage) return
  coverPage.classList.add("hidden")
  coverPage.setAttribute("aria-hidden", "true")
  document.body.classList.remove("body-cover-open")
  coverPageOpen = false
}
function toggleCoverPage(){
  if (coverPageOpen) hideCoverPage()
  else showCoverPage()
}
renderCoverPatchNotes()

function updateHistoryButtons(){
  const canUndo = undoStack.length > 0
  const canRedo = redoStack.length > 0
  if (btnUndo){ btnUndo.disabled = !canUndo; btnUndo.setAttribute("aria-disabled", String(!canUndo)) }
  if (btnRedo){ btnRedo.disabled = !canRedo; btnRedo.setAttribute("aria-disabled", String(!canRedo)) }
}

function drawPuck(){
  pctx.clearRect(0,0,puckSize,puckSize)
  pctx.strokeStyle = "rgba(0,0,0,0.16)"
  pctx.lineWidth = 2
  pctx.beginPath(); pctx.arc(C.x, C.y, R, 0, Math.PI*2); pctx.stroke()
  pctx.strokeStyle = "rgba(0,0,0,0.06)"
  pctx.lineWidth = 1
  pctx.beginPath(); pctx.moveTo(C.x-R, C.y); pctx.lineTo(C.x+R, C.y); pctx.stroke()
  pctx.beginPath(); pctx.moveTo(C.x, C.y-R); pctx.lineTo(C.x, C.y+R); pctx.stroke()

  const maxLen = dungeon.style.shadow.maxLen
  const lenPx = Math.min(maxLen, Math.max(0, dungeon.style.shadow.length))
  const r = (lenPx / maxLen) * R
  const d = dungeon.style.shadow.dir
  const dx = d.x * r, dy = d.y * r

  pctx.fillStyle = "rgba(20,25,30,0.90)"
  pctx.beginPath(); pctx.arc(C.x + dx, C.y + dy, 6, 0, Math.PI*2); pctx.fill()
}

function updateShadowFromPuck(e){
  const rect = puck.getBoundingClientRect()
  let x = e.clientX - rect.left - C.x
  let y = e.clientY - rect.top  - C.y
  let d = Math.hypot(x,y)
  if (d > R) { x *= R/d; y *= R/d; d = R }

  const maxLen = dungeon.style.shadow.maxLen
  const lenPx = (d / R) * maxLen
  const dir = d < 0.001 ? {x: 0, y: 0} : norm({x: x, y: y})
  dungeon.style.shadow.dir = dir
  dungeon.style.shadow.length = lenPx
  drawPuck()
}
puck.addEventListener("pointerdown", (e)=>{ puck.setPointerCapture(e.pointerId); updateShadowFromPuck(e) })
puck.addEventListener("pointermove", (e)=>{ if (e.buttons) updateShadowFromPuck(e) })

function syncUI(){
  if (!dungeon.style.shadow || typeof dungeon.style.shadow !== "object") dungeon.style.shadow = {}
  if (typeof dungeon.style.shadow.allPropsEnabled !== "boolean") dungeon.style.shadow.allPropsEnabled = true
  const __shadowAllPropsToggle = ensureGlobalPropShadowToggleUi()
  gridSize.value = dungeon.gridSize
  const pathDefaults = getDefaultPathShapeSettings(dungeon.style || {})
  dungeon.style.pathShapeMode = pathDefaults.shapeMode
  dungeon.style.pathSmoothness = pathDefaults.smoothness
  dungeon.style.pathJaggedAmplitude = pathDefaults.amplitude
  dungeon.style.pathJaggedFrequency = pathDefaults.frequency
  corridorWidth.value = dungeon.style.corridorWidth
  if (corridorWidthOut) corridorWidthOut.textContent = String(dungeon.style.corridorWidth)
  if (pathShapeMode) pathShapeMode.value = pathDefaults.shapeMode
  if (pathSmoothness) pathSmoothness.value = String(pathDefaults.smoothness)
  if (pathSmoothnessOut) pathSmoothnessOut.textContent = pathDefaults.smoothness.toFixed(2)
  if (pathAmplitude) pathAmplitude.value = String(pathDefaults.amplitude)
  if (pathAmplitudeOut) pathAmplitudeOut.textContent = pathDefaults.amplitude.toFixed(2)
  if (pathFrequency) pathFrequency.value = String(pathDefaults.frequency)
  if (pathFrequencyOut) pathFrequencyOut.textContent = pathDefaults.frequency.toFixed(2)
  wallWidth.value = dungeon.style.wallWidth
  if (wallColor) wallColor.value = dungeon.style.wallColor || "#1f2933"
  if (floorColor) floorColor.value = dungeon.style.floorColor || dungeon.style.paper || "#ffffff"
  if (backgroundColor) backgroundColor.value = dungeon.style.backgroundColor || "#f8f7f4"
  if (transparentBg) transparentBg.checked = !!dungeon.style.transparentBackground
  if (polySides) polySides.value = Math.max(3, Math.min(12, Math.round(Number(dungeon.style.polySides || 6))))
  if (polySidesOut) polySidesOut.textContent = String(Math.max(3, Math.min(12, Math.round(Number(dungeon.style.polySides || 6)))))
  if (snapDiv) snapDiv.value = String(Math.max(1, Math.min(8, Math.round(Number(dungeon.subSnapDiv || 4)))))
  if (snapDivOut) snapDivOut.textContent = String(Math.max(1, Math.min(8, Math.round(Number(dungeon.subSnapDiv || 4)))))
  if (!Number.isFinite(Number(dungeon.style.gridLineWidth))) dungeon.style.gridLineWidth = 1
  if (!Number.isFinite(Number(dungeon.style.gridOpacity))) dungeon.style.gridOpacity = 0.06
  const uiGridLineWidth = Math.max(0.5, Math.min(4, Number.isFinite(Number(dungeon.style.gridLineWidth)) ? Number(dungeon.style.gridLineWidth) : 1))
  const uiGridOpacity = Math.max(0, Math.min(1, Number.isFinite(Number(dungeon.style.gridOpacity)) ? Number(dungeon.style.gridOpacity) : 0.06))
  if (gridLineWidth) gridLineWidth.value = String(uiGridLineWidth)
  if (gridLineWidthOut) gridLineWidthOut.textContent = String(uiGridLineWidth)
  if (gridOpacity) gridOpacity.value = String(uiGridOpacity)
  if (gridOpacityOut) gridOpacityOut.textContent = uiGridOpacity.toFixed(2)
  shadowOn.checked = dungeon.style.shadow.enabled
  shadowOpacity.value = dungeon.style.shadow.opacity
  if (shadowColor) shadowColor.value = dungeon.style.shadow.color || "#000000"
  if (__shadowAllPropsToggle) __shadowAllPropsToggle.checked = (dungeon.style.shadow.allPropsEnabled !== false)
  hatchOn.checked = dungeon.style.hatch.enabled
  hatchDensity.value = Math.max(0.25, Number(dungeon.style.hatch.density) || 0.25)
  hatchOpacity.value = dungeon.style.hatch.opacity
  if (hatchColor) hatchColor.value = dungeon.style.hatch.color || "#1f2933"
  hatchDepth.value = dungeon.style.hatch.depth
  if (typeof dungeon.style.propSnapEnabled !== "boolean") dungeon.style.propSnapEnabled = true
  if (propSnapToggle) propSnapToggle.checked = !!dungeon.style.propSnapEnabled
  if (typeof dungeon.style.showTextPreview !== "boolean") dungeon.style.showTextPreview = true
  if (typeof dungeon.style.showTextExport !== "boolean") dungeon.style.showTextExport = true
  if (!dungeon.style.lines || typeof dungeon.style.lines !== "object") dungeon.style.lines = {}
  if (!dungeon.style.lines.color) dungeon.style.lines.color = dungeon.style?.water?.rippleColor || "#1f2933"
  if (!Number.isFinite(Number(dungeon.style.lines.width))) dungeon.style.lines.width = 1.75
  if (typeof dungeon.style.lines.dashed !== "boolean") dungeon.style.lines.dashed = false
  if (!Number.isFinite(Number(dungeon.style.lines.dashPx))) dungeon.style.lines.dashPx = 18
  if (lineDashed) lineDashed.checked = !!dungeon.style.lines.dashed
  if (!dungeon.style.water || typeof dungeon.style.water !== "object") dungeon.style.water = {}
  if (typeof dungeon.style.water.enabled !== "boolean") dungeon.style.water.enabled = true
  if (typeof dungeon.style.water.outlineEnabled !== "boolean") dungeon.style.water.outlineEnabled = (typeof dungeon.style.water.edgeLines === "boolean") ? dungeon.style.water.edgeLines : true
  if (typeof dungeon.style.water.ripplesEnabled !== "boolean") dungeon.style.water.ripplesEnabled = (typeof dungeon.style.water.edgeLines === "boolean") ? dungeon.style.water.edgeLines : true
  if (!dungeon.style.water.color) dungeon.style.water.color = "#6bb8ff"
  if (!Number.isFinite(Number(dungeon.style.water.opacity))) dungeon.style.water.opacity = 0.4
  if (!Number.isFinite(Number(dungeon.style.water.width))) dungeon.style.water.width = 52
  if (!Number.isFinite(Number(dungeon.style.water.glowStrength))) dungeon.style.water.glowStrength = 1.15
  if (!Number.isFinite(Number(dungeon.style.water.depthStrength))) dungeon.style.water.depthStrength = 0.95
  if (!Number.isFinite(Number(dungeon.style.water.sparkleAmount))) dungeon.style.water.sparkleAmount = 0.38
  if (!Number.isFinite(Number(dungeon.style.water.centerGlow))) dungeon.style.water.centerGlow = 1.05
  if (!Number.isFinite(Number(dungeon.style.water.seamBright))) dungeon.style.water.seamBright = 1.15
  if (!Number.isFinite(Number(dungeon.style.water.cellSize))) dungeon.style.water.cellSize = 1.15
  if (waterEnabled) waterEnabled.checked = !!dungeon.style.water.enabled
  if (waterColor) waterColor.value = dungeon.style.water.color
  if (waterOpacity) waterOpacity.value = String(dungeon.style.water.opacity)
  if (waterWidth) waterWidth.value = String(dungeon.style.water.width)
  if (waterOutlineEnabled) waterOutlineEnabled.checked = dungeon.style.water.outlineEnabled !== false
  if (waterRipplesEnabled) waterRipplesEnabled.checked = dungeon.style.water.ripplesEnabled !== false
  if (waterCellSize) waterCellSize.value = String(dungeon.style.water.cellSize)
  if (waterSeamBright) waterSeamBright.value = String(dungeon.style.water.seamBright)
  if (waterCenterGlow) waterCenterGlow.value = String(dungeon.style.water.centerGlow)
  if (waterDepthStrength) waterDepthStrength.value = String(dungeon.style.water.depthStrength)
  if (showTextPreview) showTextPreview.checked = !!dungeon.style.showTextPreview
  if (showTextExport) showTextExport.checked = !!dungeon.style.showTextExport
  snapStrength.value = dungeon.style.snapStrength
  drawPuck()
  syncUnderUI()
  syncToolUI()
}
syncUI()
syncTextPanelVisibility()
renderRecentGoogleFonts()
applyUiTheme(getPreferredTheme())
if (btnCoverHome) btnCoverHome.addEventListener("click", toggleCoverPage)
if (btnCoverClose) btnCoverClose.addEventListener("click", hideCoverPage)
if (coverPage) {
  coverPage.addEventListener("click", (e) => {
    if (e.target && e.target.matches("[data-cover-close]")) hideCoverPage()
  })
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && coverPageOpen) hideCoverPage()
})
showCoverPage()

gridSize.addEventListener("input", () => dungeon.gridSize = Number(gridSize.value))
corridorWidth.addEventListener("input", () => { dungeon.style.corridorWidth = Number(corridorWidth.value); if (corridorWidthOut) corridorWidthOut.textContent = String(dungeon.style.corridorWidth) })
if (pathShapeMode) pathShapeMode.addEventListener("change", () => {
  dungeon.style.pathShapeMode = PATH_SHAPE_MODES.includes(pathShapeMode.value) ? pathShapeMode.value : "smooth"
  if (tool === "free" || tool === "path" || tool === "arc") {
    resetTransientDrafts()
  }
  syncToolUI()
})
if (pathSmoothness) pathSmoothness.addEventListener("input", () => {
  dungeon.style.pathSmoothness = Math.max(0, Math.min(1, Number(pathSmoothness.value) || 0))
  if (pathSmoothnessOut) pathSmoothnessOut.textContent = Number(dungeon.style.pathSmoothness).toFixed(2)
})
if (pathAmplitude) pathAmplitude.addEventListener("input", () => {
  dungeon.style.pathJaggedAmplitude = Math.max(0, Math.min(3.5, Number(pathAmplitude.value) || 0))
  if (pathAmplitudeOut) pathAmplitudeOut.textContent = Number(dungeon.style.pathJaggedAmplitude).toFixed(2)
})
if (pathFrequency) pathFrequency.addEventListener("input", () => {
  dungeon.style.pathJaggedFrequency = Math.max(0.35, Math.min(2.8, Number(pathFrequency.value) || 1))
  if (pathFrequencyOut) pathFrequencyOut.textContent = Number(dungeon.style.pathJaggedFrequency).toFixed(2)
})
wallWidth.addEventListener("input", () => dungeon.style.wallWidth = Number(wallWidth.value))
if (wallColor) wallColor.addEventListener("input", () => dungeon.style.wallColor = wallColor.value)
if (floorColor) {
  const applyFloorColor = () => {
    dungeon.style.floorColor = floorColor.value
    dungeon.style.paper = floorColor.value // legacy alias for older save/export paths
  }
  floorColor.addEventListener("input", applyFloorColor)
  floorColor.addEventListener("change", applyFloorColor)
}
if (backgroundColor) backgroundColor.addEventListener("input", () => dungeon.style.backgroundColor = backgroundColor.value)
if (transparentBg) transparentBg.addEventListener("change", () => dungeon.style.transparentBackground = !!transparentBg.checked)

if (snapDiv) snapDiv.addEventListener("input", () => {
  const v = Math.max(1, Math.min(8, Math.round(Number(snapDiv.value) || 4)))
  dungeon.subSnapDiv = v
  if (snapDivOut) snapDivOut.textContent = String(v)
})
if (gridLineWidth) gridLineWidth.addEventListener("input", () => {
  const v = Math.max(0.5, Math.min(4, Number(gridLineWidth.value) || 1))
  dungeon.style.gridLineWidth = v
  if (gridLineWidthOut) gridLineWidthOut.textContent = String(v)
})
if (gridOpacity) gridOpacity.addEventListener("input", () => {
  const raw = Number(gridOpacity.value)
  const v = Math.max(0, Math.min(1, Number.isFinite(raw) ? raw : 0.06))
  dungeon.style.gridOpacity = v
  if (gridOpacityOut) gridOpacityOut.textContent = v.toFixed(2)
})
function getPolySidesValue(){
  const n = Math.round(Number((polySides && polySides.value) || dungeon.style.polySides || 6))
  return Math.max(3, Math.min(12, Number.isFinite(n) ? n : 6))
}
if (polySides) {
  polySides.addEventListener("input", () => {
    const s = getPolySidesValue()
    dungeon.style.polySides = s
    if (polySidesOut) polySidesOut.textContent = String(s)
    if (selectedShapeId){
      const sh = dungeon.shapes.find(v => v.id === selectedShapeId)
      if (sh && sh.kind === "regular") sh.sides = s
    }
  })
}
shadowOn.addEventListener("change", () => dungeon.style.shadow.enabled = shadowOn.checked)
shadowOpacity.addEventListener("input", () => dungeon.style.shadow.opacity = Number(shadowOpacity.value))
if (shadowColor) shadowColor.addEventListener("input", () => dungeon.style.shadow.color = shadowColor.value)
const __shadowAllPropsToggleInit = ensureGlobalPropShadowToggleUi()
if (__shadowAllPropsToggleInit) __shadowAllPropsToggleInit.addEventListener("change", () => { dungeon.style.shadow.allPropsEnabled = !!__shadowAllPropsToggleInit.checked })
hatchOn.addEventListener("change", () => dungeon.style.hatch.enabled = hatchOn.checked)
hatchDensity.addEventListener("input", () => dungeon.style.hatch.density = Math.max(0.25, Number(hatchDensity.value) || 0.25))
hatchOpacity.addEventListener("input", () => dungeon.style.hatch.opacity = Number(hatchOpacity.value))
if (hatchColor) hatchColor.addEventListener("input", () => dungeon.style.hatch.color = hatchColor.value)
hatchDepth.addEventListener("input", () => dungeon.style.hatch.depth = Number(hatchDepth.value))
snapStrength.addEventListener("input", () => dungeon.style.snapStrength = Number(snapStrength.value))
if (propSnapToggle) propSnapToggle.addEventListener("change", () => { dungeon.style.propSnapEnabled = !!propSnapToggle.checked })
if (showTextPreview) showTextPreview.addEventListener("change", () => { dungeon.style.showTextPreview = !!showTextPreview.checked; if (!isTextPreviewGloballyVisible()) { selectedTextId = null; if (textDrag && textDrag.pushedUndo && !textDrag.changed) undoStack.pop(); textDrag = null; cancelActiveTextEditor(); syncTextPanelVisibility(); } })
if (showTextExport) showTextExport.addEventListener("change", () => { dungeon.style.showTextExport = !!showTextExport.checked })
if (waterEnabled) waterEnabled.addEventListener("change", () => { dungeon.style.water.enabled = !!waterEnabled.checked; compiledSig = "" })
if (waterColor) waterColor.addEventListener("input", () => { dungeon.style.water.color = waterColor.value })
if (waterOpacity) waterOpacity.addEventListener("input", () => { dungeon.style.water.opacity = Number(waterOpacity.value) })
if (waterWidth) waterWidth.addEventListener("input", () => { dungeon.style.water.width = Number(waterWidth.value) })
if (waterOutlineEnabled) waterOutlineEnabled.addEventListener("change", () => { dungeon.style.water.outlineEnabled = !!waterOutlineEnabled.checked; compiledSig = "" })
if (waterRipplesEnabled) waterRipplesEnabled.addEventListener("change", () => { dungeon.style.water.ripplesEnabled = !!waterRipplesEnabled.checked; compiledSig = "" })
if (waterCellSize) waterCellSize.addEventListener("input", () => { dungeon.style.water.cellSize = Number(waterCellSize.value); compiledSig = "" })
if (waterSeamBright) waterSeamBright.addEventListener("input", () => { dungeon.style.water.seamBright = Number(waterSeamBright.value); dungeon.style.water.glowStrength = Math.max(Number(dungeon.style.water.glowStrength || 1.15), Number(waterSeamBright.value) * 0.92); compiledSig = "" })
if (waterCenterGlow) waterCenterGlow.addEventListener("input", () => { dungeon.style.water.centerGlow = Number(waterCenterGlow.value); compiledSig = "" })
if (waterDepthStrength) waterDepthStrength.addEventListener("input", () => { dungeon.style.water.depthStrength = Number(waterDepthStrength.value); compiledSig = "" })
if (lineDashed) lineDashed.addEventListener("change", () => { if (!dungeon.style.lines || typeof dungeon.style.lines !== "object") dungeon.style.lines = {}; dungeon.style.lines.dashed = !!lineDashed.checked })

if (textContentInput) textContentInput.addEventListener('input', () => { const t = getSelectedText(); if (t) { t.text = textContentInput.value; if (textEditorState && textEditorState.id === t.id && textCanvasEditor && document.activeElement !== textCanvasEditor) textCanvasEditor.value = t.text; if (textEditorState && textEditorState.id === t.id) positionTextEditorOverlayForText(t) } })
if (textFontFamily) textFontFamily.addEventListener('change', async () => { const t = getSelectedText(); if (!t) return; const nextFont = textFontFamily.value; if (!hasFontOption(nextFont) && nextFont) { await loadGoogleFontFamily(nextFont) } t.fontFamily = nextFont; if (googleFontFamilyInput && !['Minecraft Five','system-ui','serif','monospace'].includes(nextFont)) googleFontFamilyInput.value = nextFont; if (textEditorState && textEditorState.id === t.id) positionTextEditorOverlayForText(t) })
if (textFontSize) textFontSize.addEventListener('input', () => { const t = getSelectedText(); const v = Math.max(8, Math.min(144, Math.round(Number(textFontSize.value)||20))); if (t) { t.fontSize = v; if (textEditorState && textEditorState.id === t.id) positionTextEditorOverlayForText(t) } if (textFontSizeOut) textFontSizeOut.textContent = String(v) })
if (textColorInput) textColorInput.addEventListener('input', () => { const t = getSelectedText(); if (!t) return; t.color = textColorInput.value || '#1f2933'; if (textCanvasEditor && textEditorState && textEditorState.id === t.id) textCanvasEditor.style.color = t.color })
if (btnLoadGoogleFont) btnLoadGoogleFont.addEventListener('click', async () => { const family = (googleFontFamilyInput && googleFontFamilyInput.value) || ''; if (!normalizeGoogleFontFamilyName(family)) return; if (!textEditorState) pushUndo(); await applyGoogleFontToSelectedText(family) })
if (googleFontFamilyInput) googleFontFamilyInput.addEventListener('keydown', async (e) => { if (e.key !== 'Enter') return; e.preventDefault(); const family = googleFontFamilyInput.value || ''; if (!normalizeGoogleFontFamilyName(family)) return; if (!textEditorState) pushUndo(); await applyGoogleFontToSelectedText(family) })
if (googleFontFamilyInput) googleFontFamilyInput.addEventListener('change', async () => { const family = normalizeGoogleFontFamilyName(googleFontFamilyInput.value); if (!family || !getSelectedText()) return; await applyGoogleFontToSelectedText(family) })
if (googleFontFamilyInput) googleFontFamilyInput.addEventListener('blur', () => { if (googleFontFamilyInput.value) googleFontFamilyInput.value = normalizeGoogleFontFamilyName(googleFontFamilyInput.value) })

if (textCanvasEditor) {
  textCanvasEditor.addEventListener('input', () => {
    const t = getSelectedText()
    if (!t) return
    t.text = textCanvasEditor.value
    if (textContentInput && document.activeElement !== textContentInput) textContentInput.value = textCanvasEditor.value
    positionTextEditorOverlayForText(t)
  })
  textCanvasEditor.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitActiveTextEditor() }
    else if (e.key === 'Escape') { e.preventDefault(); cancelActiveTextEditor() }
  })
  textCanvasEditor.addEventListener('blur', () => {
    if (!textEditorState) return
    // Commit on blur for a natural editor feel
    commitActiveTextEditor()
  })
}

// undo/redo
const undoStack=[], redoStack=[]
updateHistoryButtons()
function snapshot(){ return JSON.stringify({ gridSize:dungeon.gridSize, subSnapDiv:dungeon.subSnapDiv, spaces:dungeon.spaces, paths:dungeon.paths, water:dungeon.water, lines:dungeon.lines, shapes:dungeon.shapes, style:dungeon.style, placedProps, placedTexts, selectedPropId, selectedTextId }) }
function restore(s){
  const d = JSON.parse(s)
  // Backward compatible: restore either plain dungeon snapshot or wrapped save object.
  if (d && (d.dungeon || d.camera)) { applyLoadedMapObject(d); return }
  setDungeonFromObject(d)
  placedProps = Array.isArray(d.placedProps) ? d.placedProps.map(normalizePlacedPropObj).filter(p => p && p.url) : placedProps
  placedTexts = Array.isArray(d.placedTexts) ? d.placedTexts.map(normalizeTextObj) : []
  draft=null; draftRect=null; freeDraw=null; lineDraw=null; draftShape=null; draftArc=null; selectedShapeId=null; selectedPropId=null; selectedTextId=null; shapeDrag=null; propTransformDrag=null; textDrag=null; eraseStroke=null
  syncTextPanelVisibility()
  underMode = false
  syncUI()
  syncPanelTabs()
}

function safeNum(v, fallback=0){ const n = Number(v); return Number.isFinite(n) ? n : fallback }
function cloneJson(v){ return JSON.parse(JSON.stringify(v)) }

function normalizePlacedPropObj(p){
  if (!p || typeof p !== "object") return null
  const fallbackW = Math.max(1, safeNum(p?.w, dungeon.gridSize))
  const fallbackH = Math.max(1, safeNum(p?.h, dungeon.gridSize))
  const baseW = Math.max(1, safeNum(p?.baseW, fallbackW))
  const baseH = Math.max(1, safeNum(p?.baseH, fallbackH))
  const scale = Math.max(0.05, safeNum(p?.scale, 1))
  const propId = (p && p.propId != null) ? String(p.propId) : undefined
  const assetId = (p && p.assetId != null) ? String(p.assetId) : undefined
  return {
    id: String(p?.id || ((typeof globalThis!=='undefined' && globalThis.crypto && globalThis.crypto.randomUUID) ? globalThis.crypto.randomUUID() : (Date.now()+Math.random()))),
    propId,
    assetId,
    source: String(p?.source || (assetId ? "imported" : "bundled")),
    mime: String(p?.mime || ""),
    name: String(p?.name || "Prop"),
    url: String(p?.url || ""),
    x: safeNum(p?.x, 0),
    y: safeNum(p?.y, 0),
    w: fallbackW,
    h: fallbackH,
    baseW,
    baseH,
    scale,
    rot: safeNum(p?.rot, 0),
    flipX: p?.flipX === true,
    flipY: p?.flipY === true,
    shadowDisabled: p?.shadowDisabled === true,
    tags: Array.isArray(p?.tags) ? p.tags.slice() : normalizeAssetTags(p?.tags),
    navPaths: Array.isArray(p?.navPaths) ? p.navPaths.slice() : normalizeAssetTags(p?.navPaths),
    primaryPath: String(p?.primaryPath || ''),
  }
}
function getPlacedPropRenderSize(prop){
  const fallbackW = Math.max(1, Number(prop?.w || dungeon.gridSize || 32))
  const fallbackH = Math.max(1, Number(prop?.h || dungeon.gridSize || 32))
  const baseW = Math.max(1, Number(prop?.baseW || fallbackW))
  const baseH = Math.max(1, Number(prop?.baseH || fallbackH))
  const scale = Math.max(0.05, Number(prop?.scale || 1))
  return { w: baseW * scale, h: baseH * scale }
}

let activePanelTab = "style"
let armedPropId = null
let dragPropId = null
let selectedPropId = null
let propTransformDrag = null
let placedProps = []          // runtime-only for now (local asset URLs are session-based)
let propClipboard = null
let propClipboardPasteCount = 0
const propImageCache = new Map()
var placedTexts = []
var selectedTextId = null
var textDrag = null
let textEditorState = null
const loadedGoogleFonts = new Set()
const googleFontLoadPromises = new Map()
const googleFontLinkEls = new Map()
const GOOGLE_FONT_RECENTS_KEY = "DelvSketch.googleFontRecents"

function normalizeGoogleFontFamilyName(raw){
  return String(raw || "").replace(/["']/g, "").replace(/\s+/g, " ").trim()
}
function setGoogleFontStatus(msg, kind=""){
  if (!googleFontStatus) return
  googleFontStatus.textContent = msg || ""
  googleFontStatus.dataset.state = kind || ""
}
function readRecentGoogleFonts(){
  try {
    const arr = JSON.parse(localStorage.getItem(GOOGLE_FONT_RECENTS_KEY) || "[]")
    return Array.isArray(arr) ? arr.filter(Boolean).map(normalizeGoogleFontFamilyName).filter(Boolean) : []
  } catch (_) { return [] }
}
function writeRecentGoogleFonts(list){ try { localStorage.setItem(GOOGLE_FONT_RECENTS_KEY, JSON.stringify((list || []).slice(0,8))) } catch (_) {} }
function pushRecentGoogleFont(name){
  const clean = normalizeGoogleFontFamilyName(name)
  if (!clean) return
  const next = [clean, ...readRecentGoogleFonts().filter(v => v !== clean)].slice(0,8)
  writeRecentGoogleFonts(next)
  renderRecentGoogleFonts()
}
function renderRecentGoogleFonts(){
  if (!googleFontRecent) return
  const recents = readRecentGoogleFonts()
  googleFontRecent.innerHTML = ''
  if (!recents.length){
    const hint = document.createElement('div')
    hint.className = 'fontRecentHint'
    hint.textContent = 'Recent Google fonts appear here'
    googleFontRecent.appendChild(hint)
    return
  }
  for (const family of recents){
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'fontChip'
    b.textContent = family
    b.title = `Apply ${family}`
    b.addEventListener('click', async () => {
      if (googleFontFamilyInput) googleFontFamilyInput.value = family
      if (!textEditorState) pushUndo()
      await applyGoogleFontToSelectedText(family)
    })
    googleFontRecent.appendChild(b)
  }
}

function isTextPreviewGloballyVisible(){ return dungeon?.style?.showTextPreview !== false }
function ensureGoogleFontLinkEl(family){
  const key = normalizeGoogleFontFamilyName(family) || '__default__'
  let link = googleFontLinkEls.get(key)
  if (link && document.head.contains(link)) return link
  link = document.createElement('link')
  link.rel = 'stylesheet'
  link.dataset.role = 'google-font-loader'
  if (key !== '__default__') link.dataset.family = key
  document.head.appendChild(link)
  googleFontLinkEls.set(key, link)
  return link
}

function waitForStylesheetLoad(link, timeoutMs=8000){
  return new Promise((resolve, reject) => {
    let done = false
    const finish = (ok, err) => {
      if (done) return
      done = true
      link.removeEventListener('load', onLoad)
      link.removeEventListener('error', onError)
      clearTimeout(timer)
      ok ? resolve(true) : reject(err || new Error('stylesheet failed'))
    }
    const onLoad = () => finish(true)
    const onError = () => finish(false, new Error('stylesheet error'))
    const timer = setTimeout(() => finish(false, new Error('stylesheet timeout')), timeoutMs)
    link.addEventListener('load', onLoad, { once:true })
    link.addEventListener('error', onError, { once:true })
  })
}
function googleFontFamilyToParam(name){
  return String(name || '').trim().split(/\s+/).join('+')
}
function hasFontOption(family){
  if (!textFontFamily) return false
  return Array.from(textFontFamily.options).some(o => o.value === family)
}
function addFontOptionIfMissing(family, label){
  if (!textFontFamily || !family) return
  if (hasFontOption(family)) return
  const opt = document.createElement('option')
  opt.value = family
  opt.textContent = label || family
  textFontFamily.appendChild(opt)
}
async function loadGoogleFontFamily(family){
  const clean = normalizeGoogleFontFamilyName(family)
  if (!clean) return false
  addFontOptionIfMissing(clean, `${clean} (Google)`)
  if (loadedGoogleFonts.has(clean)) return true
  if (googleFontLoadPromises.has(clean)) return googleFontLoadPromises.get(clean)
  const promise = (async () => {
    setGoogleFontStatus(`Loading ${clean}…`, 'loading')
    const link = ensureGoogleFontLinkEl(clean)
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(googleFontFamilyToParam(clean))}:wght@400&display=swap`
    try {
      await waitForStylesheetLoad(link)
      if (document.fonts && typeof document.fonts.load === 'function') {
        await Promise.race([
          Promise.all([
            document.fonts.load(`16px ${quoteCanvasFontFamily(clean)}`),
            document.fonts.load(`32px ${quoteCanvasFontFamily(clean)}`)
          ]),
          new Promise((_,rej)=>setTimeout(()=>rej(new Error('font timeout')), 8000))
        ])
      }
      loadedGoogleFonts.add(clean)
      setGoogleFontStatus(`Loaded ${clean}`, 'ok')
      pushRecentGoogleFont(clean)
      return true
    } catch (err) {
      console.warn('Google font load failed', clean, err)
      setGoogleFontStatus(`Couldn't load “${clean}”`, 'error')
      return false
    } finally {
      googleFontLoadPromises.delete(clean)
    }
  })()
  googleFontLoadPromises.set(clean, promise)
  return promise
}

async function applyGoogleFontToSelectedText(rawFamily){
  const family = normalizeGoogleFontFamilyName(rawFamily)
  if (!family) return
  const ok = await loadGoogleFontFamily(family)
  if (!ok) return
  const t = getSelectedText()
  if (!t) return
  t.fontFamily = family
  if (textFontFamily) textFontFamily.value = family
  if (googleFontFamilyInput) googleFontFamilyInput.value = family
  syncSelectedTextControls()
  if (textEditorState && textEditorState.id === t.id) positionTextEditorOverlayForText(t)
}

const propShadowRuntimeCache = new WeakMap()
let propShadowScratch = null
let propShadowScratchCtx = null

function newTextId(){
  try {
    if (typeof globalThis !== 'undefined' && globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      return globalThis.crypto.randomUUID()
    }
  } catch (_) {}
  return `text-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}
function normalizeTextObj(t){
  return {
    id: String(t?.id || newTextId()),
    text: String(t?.text || 'Label'),
    x: safeNum(t?.x, 0),
    y: safeNum(t?.y, 0),
    fontFamily: String(t?.fontFamily || 'Minecraft Five'),
    fontSize: Math.max(8, Math.min(144, Math.round(safeNum(t?.fontSize, 20)))),
    color: String(t?.color || '#1f2933'),
    showInPreview: t?.showInPreview !== false,
    showInExport: t?.showInExport !== false
  }
}
function getSelectedText(){ return (selectedTextId && Array.isArray(placedTexts)) ? (placedTexts.find(t => t && t.id === selectedTextId) || null) : null }
function syncSelectedTextControls(){
  const t = getSelectedText()
  if (!t) return
  if (textContentInput && document.activeElement !== textContentInput) textContentInput.value = t.text || ''
  if (textFontFamily && document.activeElement !== textFontFamily) { const ff = t.fontFamily || 'Minecraft Five'; addFontOptionIfMissing(ff, ff); textFontFamily.value = ff }
  if (googleFontFamilyInput && document.activeElement !== googleFontFamilyInput) { const ff = t.fontFamily || ''; googleFontFamilyInput.value = ['Minecraft Five','system-ui','serif','monospace'].includes(ff) ? '' : ff }
  const sz = Math.max(8, Math.min(144, Math.round(Number(t.fontSize)||20)))
  if (textFontSize && document.activeElement !== textFontSize) textFontSize.value = String(sz)
  if (textFontSizeOut) textFontSizeOut.textContent = String(sz)
  if (textColorInput && document.activeElement !== textColorInput) textColorInput.value = String(t.color || '#1f2933')
}
function syncTextPanelVisibility(){
  const hasText = !!getSelectedText()
  if (styleRenderGeneral) styleRenderGeneral.classList.toggle('hidden', hasText)
  if (textStylePanel) textStylePanel.classList.toggle('hidden', !hasText)
  syncSelectedTextControls()
}
function getCanvasClientRect(){ return canvas.getBoundingClientRect() }
function positionTextEditorOverlayForText(t){
  if (!textEditOverlay || !textCanvasEditor || !t) return
  const screen = camera.worldToScreen({ x:t.x, y:t.y })
  const crect = getCanvasClientRect()
  textCanvasEditor.style.fontFamily = t.fontFamily || 'system-ui'
  textCanvasEditor.style.fontSize = `${Math.max(10, Math.min(32, Number(t.fontSize)||20))}px`
  textCanvasEditor.style.color = String(t.color || '#1f2933')
  const desiredW = Math.max(140, Math.min(420, Math.ceil((measureTextScreenBounds(t, camera, ctx).w || 160) + 60)))
  textEditOverlay.style.width = `${desiredW}px`
  const margin = 8
  let left = Math.round(crect.left + screen.x + 10)
  let top = Math.round(crect.top + screen.y - 18)
  textEditOverlay.classList.remove('hidden')
  textEditOverlay.setAttribute('aria-hidden', 'false')
  const r = textEditOverlay.getBoundingClientRect()
  if (left + r.width > window.innerWidth - margin) left = Math.max(margin, Math.round(crect.left + screen.x - r.width - 10))
  if (top + r.height > window.innerHeight - margin) top = Math.max(margin, Math.round(crect.top + screen.y - r.height - 12))
  if (top < margin) top = margin
  if (left < margin) left = margin
  textEditOverlay.style.left = `${left}px`
  textEditOverlay.style.top = `${top}px`
}
function openTextEditorFor(textId, opts={}){
  const t = placedTexts.find(v => v && v.id === textId)
  if (!t || !textEditOverlay || !textCanvasEditor) return false
  selectedTextId = t.id
  selectedPropId = null
  selectedShapeId = null
  syncTextPanelVisibility()
  textEditorState = {
    id: t.id,
    originalText: String(t.text || ''),
    isNew: !!opts.isNew,
    undoPushed: !!opts.undoPushed
  }
  textCanvasEditor.value = String(t.text || '')
  if (t.fontFamily && !['Minecraft Five','system-ui','serif','monospace'].includes(t.fontFamily)) { loadGoogleFontFamily(t.fontFamily) }
  textCanvasEditor.dataset.textId = t.id
  positionTextEditorOverlayForText(t)
  queueMicrotask(() => { try { textCanvasEditor.focus(); textCanvasEditor.select() } catch (_) {} })
  requestAnimationFrame(() => { try { textCanvasEditor.focus(); textCanvasEditor.select() } catch (_) {} })
  setTimeout(() => { try { textCanvasEditor.focus(); textCanvasEditor.select() } catch (_) {} }, 0)
  refocusTextCanvasEditorSoon()
  return true
}
function closeTextEditorOverlay(){
  if (!textEditOverlay || !textCanvasEditor) { textEditorState = null; return }
  textEditOverlay.classList.add('hidden')
  textEditOverlay.setAttribute('aria-hidden', 'true')
  textCanvasEditor.dataset.textId = ''
  textEditorState = null
}
function refocusTextCanvasEditorSoon(){
  if (!textCanvasEditor) return
  setTimeout(() => { try { if (textEditorState) { textCanvasEditor.focus(); textCanvasEditor.select() } } catch (_) {} }, 0)
  requestAnimationFrame(() => { try { if (textEditorState) { textCanvasEditor.focus(); textCanvasEditor.select() } } catch (_) {} })
}
function commitActiveTextEditor(){
  if (!textEditorState || !textCanvasEditor) return false
  const t = placedTexts.find(v => v && v.id === textEditorState.id)
  if (!t) { closeTextEditorOverlay(); return false }
  const raw = String(textCanvasEditor.value || '')
  t.text = raw.trim() || 'Label'
  syncSelectedTextControls()
  closeTextEditorOverlay()
  return true
}
function cancelActiveTextEditor(){
  if (!textEditorState || !textCanvasEditor) return false
  const st = textEditorState
  const t = placedTexts.find(v => v && v.id === st.id)
  if (t){
    if (st.isNew){
      placedTexts = placedTexts.filter(v => v && v.id !== st.id)
      selectedTextId = null
      if (st.undoPushed) undoStack.pop()
    } else {
      t.text = st.originalText
    }
  }
  syncTextPanelVisibility()
  closeTextEditorOverlay()
  return true
}
function quoteCanvasFontFamily(name){
  const raw = String(name || 'system-ui').trim() || 'system-ui'
  if (/^[A-Za-z0-9_-]+$/.test(raw)) return raw
  return `"${raw.replace(/(["\\])/g, '\\$1')}"`
}

function textFontCss(t, cam){
  const px = Math.max(8, (Number(t.fontSize)||20) * (cam?.zoom || 1))
  return `${px}px ${quoteCanvasFontFamily(t.fontFamily)} , system-ui`
}
function measureTextScreenBounds(t, cam, targetCtx=ctx){
  const s = cam.worldToScreen({x:t.x, y:t.y})
  targetCtx.save()
  targetCtx.font = textFontCss(t, cam)
  const m = targetCtx.measureText(t.text || '')
  targetCtx.restore()
  const fs = Math.max(8, (Number(t.fontSize)||20) * (cam?.zoom || 1))
  const pad = 6
  const w = Math.max(8, m.width || 0)
  return { x:s.x-pad, y:s.y-fs-pad, w:w+pad*2, h:fs+pad*2 }
}
function pickTextAtScreen(screen, cam=camera){
  if (!isTextPreviewGloballyVisible()) return null
  for (let i = placedTexts.length - 1; i >= 0; i--){
    const t = placedTexts[i]
    if (!t) continue
    const b = measureTextScreenBounds(t, cam, ctx)
    if (screen.x >= b.x && screen.x <= b.x + b.w && screen.y >= b.y && screen.y <= b.y + b.h) return t
  }
  return null
}
function createTextAtWorld(world){
  const p = snapSoft(world, subGrid(), dungeon.style.snapStrength)
  const t = normalizeTextObj({ x:p.x, y:p.y, text:'Label', fontFamily:'Minecraft Five', fontSize:20, color:'#1f2933' })
  placedTexts.push(t)
  selectedTextId = t.id
  selectedPropId = null
  selectedShapeId = null
  return t
}
function drawTextsTo(targetCtx, cam, opts={}){
  const forExport = !!opts.forExport
  const globalAllowed = forExport ? (dungeon.style.showTextExport !== false) : (dungeon.style.showTextPreview !== false)
  if (!forExport && !globalAllowed) return
  for (const t of placedTexts){
    if (!t) continue
    const itemAllowed = forExport ? (t.showInExport !== false) : (t.showInPreview !== false)
    if (forExport && (!globalAllowed || !itemAllowed)) continue
    const s = cam.worldToScreen({x:t.x,y:t.y})
    targetCtx.save()
    targetCtx.font = textFontCss(t, cam)
    targetCtx.textBaseline = 'alphabetic'
    targetCtx.fillStyle = String(t.color || '#1f2933')
    if (!forExport && !itemAllowed) targetCtx.globalAlpha = 0.25
    targetCtx.fillText(t.text || '', s.x, s.y)
    targetCtx.restore()
  }
}
function drawTextSelection(){
  if (!isTextPreviewGloballyVisible()) return
  const t = getSelectedText()
  if (!t) return
  const b = measureTextScreenBounds(t, camera, ctx)
  ctx.save()
  ctx.strokeStyle = 'rgba(80,120,255,0.95)'
  ctx.setLineDash([6,6])
  ctx.lineWidth = 2
  ctx.strokeRect(b.x, b.y, b.w, b.h)
  ctx.restore()
}

function getPropShadowScratch(width, height){
  const w = Math.max(1, Math.ceil(width))
  const h = Math.max(1, Math.ceil(height))
  if (!propShadowScratch){
    propShadowScratch = document.createElement('canvas')
    propShadowScratchCtx = propShadowScratch.getContext('2d')
  }
  if (propShadowScratch.width !== w || propShadowScratch.height !== h){
    propShadowScratch.width = w
    propShadowScratch.height = h
  }
  return { canvas: propShadowScratch, ctx: propShadowScratchCtx }
}


function syncPanelTabs(){
  const hasAssets = !!(tabAssetsBtn && panelPages.length)
  for (const b of panelTabButtons){
    const t = b.dataset.panelTab
    const active = t === activePanelTab
    b.classList.toggle("primary", active)
    b.setAttribute("aria-selected", active ? "true" : "false")
  }
  for (const p of panelPages){
    const active = p.dataset.panelPage === activePanelTab
    p.classList.toggle("hidden", !active)
    p.setAttribute("aria-hidden", active ? "false" : "true")
  }
}
function setPanelTab(tab){
  activePanelTab = (tab === "assets") ? "assets" : "style"
  if (activePanelTab === "style") clearPropSelection()
  syncPanelTabs()
}
let drawerOpen = true
function setDrawerOpen(open){
  drawerOpen = !!open
  if (leftDrawer) leftDrawer.classList.toggle("collapsed", !drawerOpen)
  if (hudRoot) hudRoot.classList.toggle("drawer-collapsed", !drawerOpen)
  if (btnDrawerToggle) btnDrawerToggle.setAttribute("aria-expanded", drawerOpen ? "true" : "false")
  if (btnDrawerCollapse) {
    btnDrawerCollapse.setAttribute("aria-expanded", drawerOpen ? "true" : "false")
    btnDrawerCollapse.title = drawerOpen ? "Collapse sidebar" : "Expand sidebar"
  }
}
function toggleDrawer(){ setDrawerOpen(!drawerOpen) }
function getPropById(id){
  return (propsCatalog || []).find(p => p.id === id) || null
}
function getPlacedPropById(id){
  return (placedProps || []).find(p => p && p.id === id) || null
}
function getPropSnapEnabled(){
  return !!(dungeon.style && dungeon.style.propSnapEnabled !== false)
}
function snapPropWorldPoint(world){
  if (!getPropSnapEnabled()) return { x: world.x, y: world.y }
  const step = Math.max(1, Number(dungeon.gridSize) || 32)
  // Default placement snaps to grid-cell centers (not line intersections) for cleaner placement.
  return {
    x: (Math.round((world.x / step) - 0.5) + 0.5) * step,
    y: (Math.round((world.y / step) - 0.5) + 0.5) * step
  }
}
function snapPropMoveWorldPoint(world){
  if (!getPropSnapEnabled()) return { x: world.x, y: world.y }
  const grid = Math.max(1, Number(dungeon.gridSize) || 32)
  const step = Math.max(0.5, grid / 2)
  // Move drags can land on half-grid increments for finer prop alignment.
  return {
    x: Math.round(world.x / step) * step,
    y: Math.round(world.y / step) * step
  }
}
function normalizeAngleRad(a){
  if (!Number.isFinite(a)) return 0
  while (a <= -Math.PI) a += Math.PI * 2
  while (a > Math.PI) a -= Math.PI * 2
  return a
}
function rotatePropAngleMaybeSnap(rad){
  let out = normalizeAngleRad(rad)
  if (getPropSnapEnabled()) {
    const step = Math.PI / 12
    out = Math.round(out / step) * step
  }
  return out
}
function propHandleLocal(prop){
  const size = getPlacedPropRenderSize(prop)
  const w = Math.max(1, Number(size.w || dungeon.gridSize || 32))
  const h = Math.max(1, Number(size.h || dungeon.gridSize || 32))
  const offset = Math.max(10, Math.min(24, w * 0.18))
  return { x: 0, y: -h/2 - offset }
}
function propScaleHandleLocal(prop){
  const size = getPlacedPropRenderSize(prop)
  return { x: Math.max(1, size.w)/2, y: Math.max(1, size.h)/2 }
}
function propLocalToWorld(prop, local){
  const r = Number(prop?.rot || 0) || 0
  const c = Math.cos(r), si = Math.sin(r)
  return {
    x: (prop?.x || 0) + local.x * c - local.y * si,
    y: (prop?.y || 0) + local.x * si + local.y * c
  }
}
function worldToPropLocal(prop, world){
  const r = Number(prop?.rot || 0) || 0
  const dx = world.x - (prop?.x || 0)
  const dy = world.y - (prop?.y || 0)
  const c = Math.cos(-r), si = Math.sin(-r)
  return { x: dx * c - dy * si, y: dx * si + dy * c }
}
function hitPlacedProp(world, prop){
  if (!prop) return false
  const l = worldToPropLocal(prop, world)
  const size = getPlacedPropRenderSize(prop)
  const w = Math.max(1, Number(size.w || dungeon.gridSize || 32))
  const h = Math.max(1, Number(size.h || dungeon.gridSize || 32))
  return Math.abs(l.x) <= w/2 && Math.abs(l.y) <= h/2
}
function hitPlacedPropRotateHandle(world, prop){
  if (!prop) return false
  const hw = propLocalToWorld(prop, propHandleLocal(prop))
  const rWorld = Math.max((12 / Math.max(0.001, camera.zoom)), (dungeon.gridSize || 32) * 0.22)
  return Math.hypot(world.x - hw.x, world.y - hw.y) <= rWorld
}
function hitPlacedPropScaleHandle(world, prop){
  if (!prop) return false
  const hw = propLocalToWorld(prop, propScaleHandleLocal(prop))
  const rWorld = Math.max((12 / Math.max(0.001, camera.zoom)), (dungeon.gridSize || 32) * 0.2)
  return Math.hypot(world.x - hw.x, world.y - hw.y) <= rWorld
}
function pickPlacedPropAtWorld(world){
  if (!Array.isArray(placedProps)) return null
  for (let i = placedProps.length - 1; i >= 0; i--){
    const p = placedProps[i]
    if (!p) continue
    if (hitPlacedPropRotateHandle(world, p) || hitPlacedPropScaleHandle(world, p) || hitPlacedProp(world, p)) return p
  }
  return null
}
function placePropAtScreenById(propId, screen){
  const prop = getPropById(propId)
  if (!prop) return false
  return !!placePropAtWorld(prop, camera.screenToWorld(screen))
}
function getPropImage(prop){
  if (!prop || !prop.url) return null
  let img = propImageCache.get(prop.url)
  if (!img){
    img = new Image()
    img.decoding = "async"
    img.src = prop.url
    propImageCache.set(prop.url, img)
  }
  return img
}
function placePropAtWorld(prop, world){
  if (!prop || !world) return null
  const placeWorld = getPropSnapEnabled() ? snapPropWorldPoint(world) : world
  const img = getPropImage(prop)
  const nw = (img && img.naturalWidth) || 64
  const nh = (img && img.naturalHeight) || 64
  const base = Math.max(8, dungeon.gridSize)
  const gridW = Math.max(0.2, Number(prop.gridW ?? prop.defaultGridW ?? 1) || 1)
  const gridH = Math.max(0.2, Number(prop.gridH ?? prop.defaultGridH ?? 1) || 1)
  let w = base * gridW
  let h = base * gridH
  if (!(w > 0 && h > 0)){
    const aspect = (nw > 0 && nh > 0) ? (nh / nw) : 1
    w = base
    h = Math.max(base * 0.4, base * aspect)
  }
  pushUndo()
  const placed = {
    id: (crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now() + Math.random()),
    propId: prop.id,
    assetId: prop.assetId ? String(prop.assetId) : undefined,
    source: String(prop.source || (prop.assetId ? 'imported' : 'bundled')),
    mime: String(prop.mime || ''),
    name: prop.name,
    url: prop.url,
    x: placeWorld.x,
    y: placeWorld.y,
    w,
    h,
    baseW: w,
    baseH: h,
    scale: 1,
    rot: rotatePropAngleMaybeSnap(Number(prop.rot || 0) || 0),
    flipX: false,
    flipY: false,
    shadowDisabled: !!(prop.shadow && prop.shadow.mode === 'none'),
  }
  placedProps.push(placed)
  selectedPropId = placed.id
  return placed
}

function duplicatePlacedPropById(id, opts = {}){
  const src = getPlacedPropById(id)
  if (!src) return null
  const dx = Number(opts.dx) || 0
  const dy = Number(opts.dy) || 0
  const copy = {
    ...src,
    id: (crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now() + Math.random()),
    x: (Number(src.x) || 0) + dx,
    y: (Number(src.y) || 0) + dy
  }
  placedProps.push(copy)
  selectedPropId = copy.id
  selectedTextId = null
  selectedShapeId = null
  syncTextPanelVisibility()
  return copy
}

function copySelectedPropToClipboard(){
  const src = getPlacedPropById(selectedPropId)
  if (!src) return false
  const clean = normalizePlacedPropObj(src)
  if (!clean || !clean.url) return false
  propClipboard = {
    prop: { ...clean, id: undefined },
    copiedAt: Date.now()
  }
  propClipboardPasteCount = 0
  return true
}

function pastePropFromClipboard(opts = {}){
  if (!propClipboard || !propClipboard.prop) return null
  const base = normalizePlacedPropObj(propClipboard.prop)
  if (!base || !base.url) return null
  const grid = Math.max(1, Number(dungeon.gridSize) || 32)
  const step = Math.max(4, (typeof subGrid === 'function' ? subGrid() : (grid / 2)))
  const serial = Math.max(1, Number(opts.serial) || (propClipboardPasteCount + 1))
  let x = (Number(base.x) || 0) + step * serial
  let y = (Number(base.y) || 0) + step * serial
  if (getPropSnapEnabled()) {
    const snapped = snapPropMoveWorldPoint({ x, y })
    x = snapped.x; y = snapped.y
  }
  const pasted = {
    ...base,
    id: (crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now() + Math.random()),
    x,
    y
  }
  placedProps.push(pasted)
  propClipboardPasteCount = serial
  selectedPropId = pasted.id
  selectedTextId = null
  selectedShapeId = null
  setTool('select')
  syncTextPanelVisibility()
  return pasted
}


function getPropShadowCanvasLikeWalls(propInst, img, drawW, drawH, zoomOverride = null){
  const shadow = dungeon.style?.shadow
  if (!shadow?.enabled) return null
  const alpha = Math.max(0, Math.min(1, Number(shadow.opacity ?? 0.34)))
  if (alpha <= 0) return null
  const activeZoom = Number.isFinite(Number(zoomOverride)) ? Number(zoomOverride) : camera.zoom
  const propLenScale = 0.5 // prop shadows are half the wall-shadow length
  const lenPx = Math.max(0, Number(shadow.length || 0) * propLenScale * activeZoom)
  const globalDir = shadow.dir || { x: 0.707, y: 0.707 }
  const localDir = rotate({ x: globalDir.x || 0, y: globalDir.y || 0 }, -(Number(propInst?.rot || 0) || 0))
  const dx = Math.round((localDir.x || 0) * lenPx)
  const dy = Math.round((localDir.y || 0) * lenPx)
  if (dx === 0 && dy === 0) return null
  const w = Math.max(1, Math.round(drawW))
  const h = Math.max(1, Math.round(drawH))
  // Extra pad and feathering make thin SVG line props cast a visible shadow.
  const feather = Math.max(1, Math.round(Math.min(w, h) * 0.04))
  const pad = Math.max(6, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) + feather + 4))
  const flipX = propInst?.flipX === true
  const flipY = propInst?.flipY === true
  const key = [w,h,dx,dy,shadow.color||'#000000',alpha,feather, flipX?1:0, flipY?1:0].join('|')
  const cached = propShadowRuntimeCache.get(propInst)
  if (cached && cached.key === key && cached.canvas) return cached

  const cw = w + pad * 2, ch = h + pad * 2

  // Alpha mask for the prop image.
  const baseAlphaC = document.createElement('canvas'); baseAlphaC.width = cw; baseAlphaC.height = ch
  const bactx = baseAlphaC.getContext('2d')
  bactx.clearRect(0,0,cw,ch)
  bactx.imageSmoothingEnabled = false
  bactx.save()
  bactx.translate(pad + w/2, pad + h/2)
  bactx.scale(flipX ? -1 : 1, flipY ? -1 : 1)
  bactx.drawImage(img, -w/2, -h/2, w, h)
  bactx.restore()

  // Build a slightly expanded source mask for shadow casting while keeping a tighter
  // body mask for the cutout. Using the same expanded mask for both can leave a pale
  // seam between the prop and the shadow on anti-aliased assets.
  const alphaC = document.createElement('canvas'); alphaC.width = cw; alphaC.height = ch
  const actx = alphaC.getContext('2d')
  actx.imageSmoothingEnabled = false
  actx.drawImage(baseAlphaC, 0, 0)

  // Slightly dilate the cast source so stroke-based SVG icons (doors/chests/etc.)
  // still produce a visible shadow.
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

  // Sweep the prop alpha in the shadow direction to make a directional cast shadow, then subtract the prop itself.
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

  // Normalize the mask to binary alpha so overlapping sweep samples don't become darker.
  try {
    const maskImg = sctx.getImageData(0, 0, cw, ch)
    const d = maskImg.data
    for (let i = 0; i < d.length; i += 4){
      d[i + 3] = d[i + 3] > 0 ? 255 : 0
    }
    sctx.putImageData(maskImg, 0, 0)
  } catch {}

  // Bridge the tiny anti-aliased halo/gap that can appear between a prop sprite
  // and the start of its shadow. Keep the overlap modest, then carve back the
  // light-facing side so the shadow does not wrap around the prop silhouette.
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

    // Remove the faint halo that can survive on the light-facing / shoulder sides
    // of the prop after bridging. We subtract a slightly expanded copy of the prop
    // body, biased toward the light, so the shadow starts flush only on the cast side.
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

  const result = { key, canvas: outC, pad }
  propShadowRuntimeCache.set(propInst, result)
  return result
}

function drawPropSelection(){
  if (tool !== 'select' || !selectedPropId) return
  const p = getPlacedPropById(selectedPropId)
  if (!p) return
  const c = camera.worldToScreen({ x: p.x, y: p.y })
  const rs = getPlacedPropRenderSize(p)
  const w = Math.max(1, rs.w * camera.zoom)
  const h = Math.max(1, rs.h * camera.zoom)
  const handleW = propLocalToWorld(p, propHandleLocal(p))
  const hs = camera.worldToScreen(handleW)
  const scaleHandleW = propLocalToWorld(p, propScaleHandleLocal(p))
  const shs = camera.worldToScreen(scaleHandleW)
  ctx.save()
  ctx.translate(c.x, c.y)
  if (p.rot) ctx.rotate(p.rot)
  ctx.strokeStyle = 'rgba(80,120,255,0.95)'
  ctx.lineWidth = 2
  ctx.setLineDash([6,6])
  ctx.strokeRect(-w/2, -h/2, w, h)
  ctx.setLineDash([])
  ctx.beginPath()
  ctx.moveTo(0, -h/2)
  ctx.lineTo(hs.x - c.x, hs.y - c.y)
  ctx.strokeStyle = 'rgba(80,120,255,0.55)'
  ctx.lineWidth = 1.5
  ctx.stroke()
  ctx.restore()
  ctx.fillStyle = 'rgba(80,120,255,0.95)'
  ctx.beginPath(); ctx.arc(hs.x, hs.y, 7, 0, Math.PI*2); ctx.fill()
  ctx.strokeStyle = 'rgba(255,255,255,0.95)'
  ctx.lineWidth = 2
  ctx.beginPath(); ctx.arc(hs.x, hs.y, 7, 0, Math.PI*2); ctx.stroke()
  ctx.fillStyle = 'rgba(80,120,255,0.95)'
  ctx.fillRect(shs.x - 6, shs.y - 6, 12, 12)
  ctx.strokeStyle = 'rgba(255,255,255,0.95)'
  ctx.lineWidth = 2
  ctx.strokeRect(shs.x - 6, shs.y - 6, 12, 12)
}

const __propLayerTmp = {}
function getPropLayerTemp(key, w, h){
  let c = __propLayerTmp[key]
  if (!c) c = __propLayerTmp[key] = document.createElement('canvas')
  if (c.width !== w || c.height !== h){ c.width = w; c.height = h }
  return c
}
function drawCompiledLayerToScreen(targetCtx, layerCanvas, cache, cam = camera){
  if (!targetCtx || !layerCanvas || !cache) return
  const tl = cam.worldToScreen({ x: cache.bounds.minx, y: cache.bounds.miny })
  const drawW = (layerCanvas.width / cache.ppu) * cam.zoom
  const drawH = (layerCanvas.height / cache.ppu) * cam.zoom
  targetCtx.imageSmoothingEnabled = true
  targetCtx.drawImage(layerCanvas, tl.x, tl.y, drawW, drawH)
}

function drawPlacedPropsTo(targetCtx, targetCamera, targetW, targetH, cacheForWalls = compiledCache){
  if (!Array.isArray(placedProps) || placedProps.length === 0) return

  const shadowMasterEnabled = !!(dungeon.style?.shadow?.enabled)
  const propShadowsGloballyEnabled = shadowMasterEnabled && (dungeon.style?.shadow?.allPropsEnabled !== false)
  const shadowMaskC = propShadowsGloballyEnabled ? getPropLayerTemp('shadowMask', targetW, targetH) : null
  const propOccC = propShadowsGloballyEnabled ? getPropLayerTemp('propOcc', targetW, targetH) : null
  const wallOccC = propShadowsGloballyEnabled ? getPropLayerTemp('wallOcc', targetW, targetH) : null
  const shadowTintC = propShadowsGloballyEnabled ? getPropLayerTemp('shadowTint', targetW, targetH) : null
  const propOccExpandedC = propShadowsGloballyEnabled ? getPropLayerTemp('propOccExpanded', targetW, targetH) : null
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

  // Pass 1: accumulate prop shadow masks (union target) and total prop occupancy.
  if (propShadowsGloballyEnabled && smctx && poctx){
    for (const a of placedProps){
      if (!a || !a.url) continue
      const propMeta = getPropById(a.propId)
      const img = propImageCache.get(a.url) || (()=>{ const p = propMeta; return p ? getPropImage(p) : null })()
      if (!img) continue
      const c = targetCamera.worldToScreen({ x: a.x, y: a.y })
      const rs = getPlacedPropRenderSize(a)
      const w = Math.max(1, rs.w * targetCamera.zoom)
      const h = Math.max(1, rs.h * targetCamera.zoom)

      // Occupancy mask of prop bodies so no prop shadow can render over any prop sprite.
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
        (propMeta?.castShadow !== false)
      if (!shadowEnabled || !(img.complete && img.naturalWidth > 0)) continue
      const shadowLayer = getPropShadowCanvasLikeWalls(a, img, w, h, targetCamera.zoom)
      if (!shadowLayer?.canvas) continue
      smctx.save()
      smctx.translate(c.x, c.y)
      if (a.rot) smctx.rotate(a.rot)
      // Intentionally do not apply prop flip to the cast-shadow draw transform;
      // flipping the prop should not reverse the world-space shadow direction.
      smctx.drawImage(shadowLayer.canvas, -w/2 - shadowLayer.pad, -h/2 - shadowLayer.pad)
      smctx.restore()
    }

    // Convert accumulated alpha to a binary union mask so overlaps don't get darker.
    try {
      const maskImg = smctx.getImageData(0, 0, targetW, targetH)
      const d = maskImg.data
      for (let i = 0; i < d.length; i += 4){
        d[i] = 0; d[i+1] = 0; d[i+2] = 0
        d[i+3] = d[i+3] > 0 ? 255 : 0
      }
      smctx.putImageData(maskImg, 0, 0)
    } catch {}

    // Never draw prop shadows under the semi-transparent fringe of prop bodies.
    // Use two cutouts:
    // 1) a tiny isotropic expansion to hide anti-aliased seams directly under the sprite edge
    // 2) a light-side-biased carve so the shadow does not wrap around the silhouette on the lit side
    const occOverlapPx = Math.max(1, Math.min(2, Math.round(targetCamera.zoom * 0.03)))
    const lightDir = (() => {
      const g = dungeon.style?.shadow?.dir || { x: 0.707, y: 0.707 }
      const lx = -Number(g.x || 0)
      const ly = -Number(g.y || 0)
      const mag = Math.hypot(lx, ly) || 1
      return { x: lx / mag, y: ly / mag }
    })()
    const occMaskForCutout = (() => {
      if (!poectx || !propOccExpandedC) return propOccC
      poectx.clearRect(0,0,targetW,targetH)

      // Small symmetric overlap so the shadow tucks just under soft sprite edges.
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

      // Stronger carve on the light-facing side only, which removes pale/white streaks
      // without opening a gap on the cast side where the shadow should start flush.
      const lightCarvePx = Math.max(1, Math.min(4, Math.round(targetCamera.zoom * 0.06)))
      const stepX = lightDir.x === 0 ? 0 : Math.sign(lightDir.x)
      const stepY = lightDir.y === 0 ? 0 : Math.sign(lightDir.y)
      for (let i = 1; i <= lightCarvePx; i++){
        const ox = Math.round(lightDir.x * i)
        const oy = Math.round(lightDir.y * i)
        poectx.drawImage(propOccC, ox, oy)
        // Fill in coarse pixel stairs for diagonal light directions.
        if (stepX !== 0) poectx.drawImage(propOccC, ox + stepX, oy)
        if (stepY !== 0) poectx.drawImage(propOccC, ox, oy + stepY)
      }
      return propOccExpandedC
    })()
    smctx.globalCompositeOperation = 'destination-out'
    smctx.drawImage(occMaskForCutout, 0, 0)
    smctx.globalCompositeOperation = 'source-over'

    // Clip prop shadows to dungeon interior so they cannot leak outside walls.
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

    // Merge with wall shadow into a single flat-darkness result and bridge tiny gaps.
    if (woctx && cacheForWalls?.shadowCanvas && cacheForWalls?.bounds && cacheForWalls?.ppu) {
      woctx.clearRect(0,0,targetW,targetH)
      drawCompiledLayerToScreen(woctx, cacheForWalls.shadowCanvas, cacheForWalls, targetCamera)
      try {
        const maskImg = smctx.getImageData(0, 0, targetW, targetH)
        const wallImg = woctx.getImageData(0, 0, targetW, targetH)
        const md = maskImg.data
        const wd = wallImg.data
        const npx = targetW * targetH
        const shadowOpacity = Math.max(0.001, Math.min(1, Number(dungeon.style?.shadow?.opacity ?? 0.34)))
        const wallOccThreshold = 4
        const propOcc = new Uint8Array(npx)
        const wallOcc = new Uint8Array(npx)
        let k = 0
        for (let i = 0; i < md.length; i += 4, k++) {
          propOcc[k] = md[i+3] > 0 ? 1 : 0
          wallOcc[k] = wd[i+3] >= wallOccThreshold ? 1 : 0
        }
        // Combined occupancy = wall OR prop, then close tiny gaps (radius 1, 8-neighbor).
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

        // Emit only the delta needed over the already-drawn wall shadow, preserving constant darkness.
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
      // No wall shadow layer available: convert mask alpha into actual source-over alpha payload using global opacity.
      try {
        const maskImg = smctx.getImageData(0, 0, targetW, targetH)
        const md = maskImg.data
        const shadowOpacity = Math.max(0, Math.min(1, Number(dungeon.style?.shadow?.opacity ?? 0.34)))
        for (let i = 0; i < md.length; i += 4) {
          md[i] = 0; md[i+1] = 0; md[i+2] = 0
          md[i+3] = Math.round((md[i+3] / 255) * shadowOpacity * 255)
        }
        smctx.putImageData(maskImg, 0, 0)
      } catch {}
    }

    // Tint once from the delta/max-merged prop shadow mask.
    if (stctx){
      stctx.clearRect(0,0,targetW,targetH)
      stctx.fillStyle = dungeon.style?.shadow?.color || '#000000'
      stctx.globalAlpha = 1
      stctx.fillRect(0,0,targetW,targetH)
      stctx.globalCompositeOperation = 'destination-in'
      stctx.drawImage(shadowMaskC, 0, 0)
      stctx.globalCompositeOperation = 'source-over'
      targetCtx.drawImage(shadowTintC, 0, 0)
    }
  }

  // Pass 2: draw prop sprites on top.
  targetCtx.save()
  for (const a of placedProps){
    if (!a || !a.url) continue
    const propMeta = getPropById(a.propId)
    const img = propImageCache.get(a.url) || (()=>{ const p = propMeta; return p ? getPropImage(p) : null })()
    if (!img) continue
    const c = targetCamera.worldToScreen({ x: a.x, y: a.y })
    const rs = getPlacedPropRenderSize(a)
    const w = Math.max(1, rs.w * targetCamera.zoom)
    const h = Math.max(1, rs.h * targetCamera.zoom)

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

function drawPlacedProps(){
  drawPlacedPropsTo(ctx, camera, W, H, compiledCache)
}


let builtInPropsCatalog = []
let importedPropsCatalog = []
let propsCatalog = []
let bundledPropsLoadQueued = false
let assetBrowserActivePath = "all"
let assetBrowserSearchTerm = ""

function slugifyAssetToken(value){
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}
function titleCaseAssetToken(value){
  return String(value || '').replace(/[-_]+/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase())
}
function normalizeAssetTags(input){
  if (Array.isArray(input)) return input.map(v => slugifyAssetToken(v)).filter(Boolean)
  if (typeof input === 'string') return input.split(',').map(v => slugifyAssetToken(v)).filter(Boolean)
  return []
}
function inferFlatAssetTags(meta = {}){
  const out = []
  const push = (...values) => {
    for (const value of values){
      const token = slugifyAssetToken(value)
      if (token) out.push(token)
    }
  }
  const category = String(meta.category || '').toLowerCase()
  const name = String(meta.name || '').toLowerCase()
  const id = String(meta.id || '').toLowerCase()
  const src = String(meta.src || '').toLowerCase()
  const haystack = `${name} ${id} ${src}`
  if (meta.source === 'imported') push('imported', 'custom')
  if (category) push(category)
  if (category.includes('floor')) push('details', 'floor')
  if (/door|arch/.test(haystack)) push('structure', 'doors')
  if (/bed/.test(haystack)) push('interior', 'furniture', 'sleeping', 'beds')
  if (/table/.test(haystack)) push('interior', 'furniture', 'tables')
  if (/chest|crate/.test(haystack)) push('interior', 'storage')
  if (/campfire|brazier|torch|fire/.test(haystack)) push('lighting', 'fire')
  if (/stairs/.test(haystack)) push('structure', 'stairs')
  if (/column/.test(haystack)) push('structure', 'columns')
  if (/grate|drain/.test(haystack)) push('details', 'floor', 'drains')
  if (/cobweb|web/.test(haystack)) push('details', 'dressing', 'cobwebs')
  if (!out.length) push(category.includes('floor') ? 'details' : 'props', 'misc')
  return Array.from(new Set(out))
}
function buildCatalogTagModel(list = []){
  const tagCounts = new Map()
  const pairCounts = new Map()
  const items = Array.isArray(list) ? list : []
  for (const item of items){
    const tags = Array.from(new Set(normalizeAssetTags(item?.tags)))
    for (const tag of tags) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1)
    for (let i = 0; i < tags.length; i++){
      for (let j = i + 1; j < tags.length; j++){
        const a = tags[i]
        const b = tags[j]
        const key = a < b ? `${a}|${b}` : `${b}|${a}`
        pairCounts.set(key, (pairCounts.get(key) || 0) + 1)
      }
    }
  }
  const getPairCount = (a, b) => {
    if (!a || !b || a === b) return 0
    const key = a < b ? `${a}|${b}` : `${b}|${a}`
    return pairCounts.get(key) || 0
  }
  const parentMap = new Map()
  for (const child of tagCounts.keys()){
    const childCount = tagCounts.get(child) || 0
    const candidates = []
    for (const parent of tagCounts.keys()){
      if (!parent || parent === child) continue
      const parentCount = tagCounts.get(parent) || 0
      if (parentCount < childCount) continue
      const pairCount = getPairCount(child, parent)
      if (!pairCount) continue
      const confidence = pairCount / Math.max(1, childCount)
      if (confidence < 0.34) continue
      const breadth = parentCount / Math.max(1, childCount)
      const score = confidence * 4 + Math.min(breadth, 4) + (parent.length < child.length ? 0.2 : 0)
      candidates.push({ tag: parent, score, pairCount, parentCount, childCount })
    }
    candidates.sort((a, b) => b.score - a.score || b.pairCount - a.pairCount || b.parentCount - a.parentCount || a.tag.localeCompare(b.tag))
    parentMap.set(child, candidates.slice(0, 3).map(c => c.tag))
  }
  return { tagCounts, pairCounts, parentMap, getPairCount }
}
function deriveNavPathsFromTags(tags, model = null){
  const normalized = Array.from(new Set(normalizeAssetTags(tags)))
  if (!normalized.length) return ['misc']
  if (!model) return normalized
  const tagCounts = model.tagCounts || new Map()
  const parentMap = model.parentMap || new Map()
  const results = new Set()
  const maxDepth = 4
  const tagSet = new Set(normalized)
  const addPath = (parts) => {
    const clean = parts.map(slugifyAssetToken).filter(Boolean)
    if (clean.length) results.add(clean.join('/'))
  }
  for (const tag of normalized) addPath([tag])
  const recurse = (leaf, path, visited, depth) => {
    if (depth >= maxDepth) return
    const parents = (parentMap.get(leaf) || []).filter(parent => tagSet.has(parent) && !visited.has(parent))
    for (const parent of parents){
      const next = [parent, ...path]
      addPath(next)
      const nextVisited = new Set(visited)
      nextVisited.add(parent)
      recurse(parent, next, nextVisited, depth + 1)
    }
  }
  const leaves = normalized.slice().sort((a, b) => {
    const countDiff = (tagCounts.get(a) || 0) - (tagCounts.get(b) || 0)
    if (countDiff) return countDiff
    return a.localeCompare(b)
  })
  for (const leaf of leaves){
    recurse(leaf, [leaf], new Set([leaf]), 1)
  }
  return Array.from(results).sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
}
function buildAssetTaxonomyMeta(meta = {}, model = null){
  const explicit = normalizeAssetTags(meta.tags)
  const inferred = explicit.length ? [] : inferFlatAssetTags(meta)
  const tags = Array.from(new Set([...explicit, ...inferred]))
  const navPaths = deriveNavPathsFromTags(tags, model)
  const primaryPath = navPaths.slice().sort((a, b) => b.split('/').length - a.split('/').length || a.localeCompare(b))[0] || tags[0] || 'misc'
  return { tags, navPaths, primaryPath }
}
function attachAssetTaxonomy(prop, meta = {}, model = null){
  const tax = buildAssetTaxonomyMeta({ ...prop, ...meta }, model)
  prop.tags = tax.tags
  prop.navPaths = tax.navPaths
  prop.primaryPath = tax.primaryPath
  prop.searchText = [prop.name, prop.id, prop.source, prop.category, ...(prop.tags || []), ...(prop.navPaths || [])].filter(Boolean).join(' ').toLowerCase()
  return prop
}
function getAssetBrowserNodes(list){
  const nodes = new Map()
  const seenByNode = new Map()
  const items = Array.isArray(list) ? list : []
  nodes.set('all', { path:'all', label:'All', count:items.length, depth:0, parentPath:null, children:[] })
  const bumpNode = (key, label, depth, parentPath, assetKey) => {
    const node = nodes.get(key) || { path:key, label, count:0, depth, parentPath, children:[] }
    node.label = label
    node.depth = depth
    node.parentPath = parentPath
    if (!seenByNode.has(key)) seenByNode.set(key, new Set())
    const seen = seenByNode.get(key)
    if (!seen.has(assetKey)) {
      seen.add(assetKey)
      node.count += 1
    }
    nodes.set(key, node)
    return node
  }
  for (const item of items) {
    const assetKey = String(item?.assetId || item?.propId || item?.id || item?.name || Math.random())
    const paths = Array.isArray(item?.navPaths) && item.navPaths.length ? item.navPaths : [item?.primaryPath || 'misc']
    for (const path of paths){
      const parts = String(path || '').split('/').filter(Boolean)
      let accum = ''
      for (let i = 0; i < parts.length; i++){
        const part = parts[i]
        const parent = accum || 'all'
        accum = accum ? `${accum}/${part}` : part
        const key = accum.toLowerCase()
        bumpNode(key, titleCaseAssetToken(part), i + 1, parent, assetKey)
        const parentNode = nodes.get(parent)
        if (parentNode && !parentNode.children.includes(key)) parentNode.children.push(key)
      }
    }
  }
  return nodes
}
function sortAssetBrowserNodes(a, b){
  if (!a && !b) return 0
  if (!a) return 1
  if (!b) return -1
  const countDiff = Number(b.count || 0) - Number(a.count || 0)
  if (countDiff) return countDiff
  const depthDiff = Number(a.depth || 0) - Number(b.depth || 0)
  if (depthDiff) return depthDiff
  return String(a.label || a.path || '').localeCompare(String(b.label || b.path || ''), undefined, { sensitivity:'base', numeric:true })
}
function getAssetBrowserAncestors(path, nodes){
  const out = []
  let current = String(path || 'all').toLowerCase()
  while (current && current !== 'all'){
    const node = nodes.get(current)
    if (!node) break
    out.unshift(node)
    current = node.parentPath || 'all'
  }
  return out
}
function encodeRelatedAssetBrowserPath(basePath, tags){
  const base = String(basePath || 'all').toLowerCase()
  const list = Array.isArray(tags) ? tags : [tags]
  const normalized = Array.from(new Set(list.map(slugifyAssetToken).filter(Boolean)))
  if (!normalized.length) return base
  return `related:${base}|${normalized.join('+')}`
}
function parseAssetBrowserPathState(path){
  const raw = String(path || 'all').toLowerCase()
  if (!raw.startsWith('related:')) return { mode:'path', raw, basePath:raw || 'all', tag:'', tags:[] }
  const payload = raw.slice('related:'.length)
  const pipeIndex = payload.lastIndexOf('|')
  if (pipeIndex === -1) return { mode:'path', raw, basePath:'all', tag:'', tags:[] }
  const basePath = payload.slice(0, pipeIndex) || 'all'
  const tags = Array.from(new Set(String(payload.slice(pipeIndex + 1) || '').split('+').map(slugifyAssetToken).filter(Boolean)))
  return { mode:'related', raw, basePath, tag:tags[tags.length - 1] || '', tags }
}
function getRelatedTagNodesForSelection(items, activePath, nodes){
  const list = Array.isArray(items) ? items : []
  const pathState = parseAssetBrowserPathState(activePath)
  const excluded = new Set(String(pathState.basePath || 'all').split('/').map(slugifyAssetToken).filter(Boolean))
  for (const activeTag of (pathState.tags || [])) excluded.add(activeTag)
  const contextualCounts = new Map()
  for (const item of list){
    const seenTags = new Set()
    const tags = normalizeAssetTags(item?.tags)
    for (const tag of tags){
      if (!tag || excluded.has(tag) || seenTags.has(tag)) continue
      seenTags.add(tag)
      contextualCounts.set(tag, (contextualCounts.get(tag) || 0) + 1)
    }
  }
  return Array.from(contextualCounts.keys()).map(tag => {
    const existing = nodes.get(tag)
    const globalCount = existing?.count || (Array.isArray(propsCatalog) ? propsCatalog.filter(asset => normalizeAssetTags(asset?.tags).includes(tag)).length : 0)
    return {
      path: existing?.path || tag || encodeRelatedAssetBrowserPath(pathState.basePath, [...(pathState.tags || []), tag]),
      label: existing?.label || titleCaseAssetToken(tag),
      count: globalCount,
      contextualCount: contextualCounts.get(tag) || 0,
      depth: existing?.depth || 1,
      parentPath: existing?.parentPath || 'all',
      children: existing?.children || [],
      relatedTag: tag,
      basePath: pathState.basePath || 'all'
    }
  }).sort(sortAssetBrowserNodes)
}
function assetMatchesBrowser(prop){
  if (!prop) return false
  const term = String(assetBrowserSearchTerm || '').trim().toLowerCase()
  const pathState = parseAssetBrowserPathState(assetBrowserActivePath || 'all')
  const basePath = String(pathState.basePath || 'all').toLowerCase()
  const navPaths = Array.isArray(prop.navPaths) ? prop.navPaths.map(p => String(p || '').toLowerCase()) : []
  const primaryPath = String(prop.primaryPath || '').toLowerCase()
  const matchesBasePath = (basePath === 'all') || navPaths.some(p => p === basePath || p.startsWith(basePath + '/')) || primaryPath === basePath
  if (!matchesBasePath) return false
  if (pathState.mode === 'related' && Array.isArray(pathState.tags) && pathState.tags.length) {
    const tags = normalizeAssetTags(prop?.tags)
    for (const activeTag of pathState.tags){
      if (!tags.includes(activeTag)) return false
    }
  }
  if (!term) return true
  return String(prop.searchText || '').includes(term)
}
function renderAssetTree(){
  if (!propsTree) return
  propsTree.innerHTML = ''
  const nodes = getAssetBrowserNodes(propsCatalog)
  const allNode = nodes.get('all') || { path:'all', label:'All', count:Array.isArray(propsCatalog) ? propsCatalog.length : 0, children:[] }
  const pathState = parseAssetBrowserPathState(assetBrowserActivePath || 'all')
  let activePath = pathState.raw
  if (pathState.mode === 'path' && activePath !== 'all' && !nodes.has(activePath)) activePath = assetBrowserActivePath = 'all'

  const makeChip = (node, extraClass = '') => {
    if (!node) return null
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'assetTreeChip' + (node.path === activePath ? ' active' : '') + (extraClass ? ` ${extraClass}` : '')
    btn.textContent = `${node.label} (${node.count})`
    btn.title = node.path
    btn.addEventListener('click', () => {
      assetBrowserActivePath = (node.path === activePath) ? 'all' : node.path
      renderPropsShelf()
    })
    return btn
  }
  const addGroup = (label, items, kind = '') => {
    if (!Array.isArray(items) || !items.length) return
    const wrap = document.createElement('div')
    wrap.className = 'assetTreeGroup' + (kind ? ` ${kind}` : '')
    if (label){
      const heading = document.createElement('div')
      heading.className = 'assetTreeGroupLabel'
      heading.textContent = label
      wrap.appendChild(heading)
    }
    const chips = document.createElement('div')
    chips.className = 'assetTreeGroupChips'
    for (const item of items){
      const chip = makeChip(item, kind === 'breadcrumbs' ? 'crumb' : '')
      if (chip) chips.appendChild(chip)
    }
    wrap.appendChild(chips)
    propsTree.appendChild(wrap)
  }

  const rootNodes = (allNode.children || []).map(path => nodes.get(path)).filter(Boolean).sort(sortAssetBrowserNodes)
  const activeNode = pathState.mode === 'related' ? nodes.get(pathState.basePath || 'all') : nodes.get(activePath)

  addGroup('', [allNode, ...rootNodes], 'roots')

  if (activePath !== 'all' && activeNode){
    const ancestors = getAssetBrowserAncestors(pathState.mode === 'related' ? (pathState.basePath || 'all') : activePath, nodes)
    if (pathState.mode === 'related' && Array.isArray(pathState.tags) && pathState.tags.length){
      pathState.tags.forEach((activeTag, index) => {
        ancestors.push({
          path: encodeRelatedAssetBrowserPath(pathState.basePath, pathState.tags.slice(0, index + 1)),
          label: titleCaseAssetToken(activeTag),
          count: (Array.isArray(propsCatalog) ? propsCatalog : []).filter(asset => {
            const tags = normalizeAssetTags(asset?.tags)
            const navPaths = Array.isArray(asset?.navPaths) ? asset.navPaths.map(p => String(p || '').toLowerCase()) : []
            const primaryPath = String(asset?.primaryPath || '').toLowerCase()
            const base = String(pathState.basePath || 'all').toLowerCase()
            const matchesBasePath = (base === 'all') || navPaths.some(p => p === base || p.startsWith(base + '/')) || primaryPath === base
            if (!matchesBasePath) return false
            return pathState.tags.slice(0, index + 1).every(tag => tags.includes(tag))
          }).length,
          depth: Number(activeNode?.depth || 0) + 1 + index,
          parentPath: index ? encodeRelatedAssetBrowserPath(pathState.basePath, pathState.tags.slice(0, index)) : (pathState.basePath || 'all'),
          children: []
        })
      })
    }
    addGroup('Path', ancestors, 'breadcrumbs')

    const childNodes = pathState.mode === 'related'
      ? []
      : (activeNode.children || []).map(path => nodes.get(path)).filter(Boolean).sort(sortAssetBrowserNodes)
    if (childNodes.length){
      addGroup('Narrow further', childNodes, 'children')
    } else {
      const selectedItems = (Array.isArray(propsCatalog) ? propsCatalog : []).filter(assetMatchesBrowser)
      const relatedTagNodes = getRelatedTagNodesForSelection(selectedItems, activePath, nodes).filter(node => String(node.path || '').toLowerCase() !== activePath)
      if (relatedTagNodes.length) addGroup('Related tags', relatedTagNodes, 'siblings')
    }
  }
}
function makeCustomAssetId(seed = "asset"){
  const base = String(seed || "asset").replace(/\.[^.]+$/, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "asset"
  const suffix = (crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now() + Math.random())
  return `custom-${base}-${suffix}`
}
function readFileAsDataURL(file){
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'))
    reader.onload = () => resolve(String(reader.result || ''))
    reader.readAsDataURL(file)
  })
}
function getMimeFromDataUrl(dataUrl){
  const m = /^data:([^;,]+)[;,]/i.exec(String(dataUrl || ''))
  return m ? String(m[1]).toLowerCase() : ''
}
function isEmbeddedCustomPropLike(value){
  return !!value && /^(data:image\/|blob:)/i.test(String(value))
}
function buildImportedPropFromEmbeddedAsset(asset, i = 0){
  if (!asset || !asset.assetId || !asset.data) return null
  return attachAssetTaxonomy({
    id: String(asset.assetId),
    assetId: String(asset.assetId),
    name: String(asset.name || `Image ${i+1}`).replace(/\.[^.]+$/, "") || `Image ${i+1}`,
    url: String(asset.data),
    mime: String(asset.mime || getMimeFromDataUrl(asset.data) || ''),
    source: 'imported'
  }, { tags: asset.tags || ['imported', 'custom'] })
}
function rebuildImportedPropsFromEmbeddedAssets(list){
  importedPropsCatalog = Array.isArray(list)
    ? list.map((asset, i) => buildImportedPropFromEmbeddedAsset(asset, i)).filter(Boolean)
    : []
  rebuildPropsCatalog()
  for (const p of importedPropsCatalog) getPropImage(p)
  renderPropsShelf()
}
function collectUsedEmbeddedAssetsFromPlacedProps(list){
  const byId = new Map()
  for (const raw of (list || [])) {
    const p = normalizePlacedPropObj(raw)
    if (!p) continue
    const assetId = String(p.assetId || '')
    const isCustom = !!assetId || (p.source === 'imported') || isEmbeddedCustomPropLike(p.url)
    if (!isCustom) continue
    const data = String(p.url || '')
    if (!isEmbeddedCustomPropLike(data)) continue
    const id = assetId || String(p.propId || p.id || makeCustomAssetId(p.name || 'image'))
    if (byId.has(id)) continue
    byId.set(id, {
      assetId: id,
      name: String(p.name || 'Image'),
      mime: String(p.mime || getMimeFromDataUrl(data) || ''),
      tags: Array.isArray(p.tags) && p.tags.length ? p.tags.slice() : ['imported', 'custom'],
      data
    })
  }
  return Array.from(byId.values())
}
function serializePlacedPropsForSave(list){
  return (list || []).map(raw => {
    const p = normalizePlacedPropObj(raw)
    if (!p) return null
    const out = {
      id: p.id,
      propId: p.propId,
      assetId: p.assetId,
      source: p.source,
      mime: p.mime,
      name: p.name,
      x: p.x,
      y: p.y,
      w: p.w,
      h: p.h,
      baseW: p.baseW,
      baseH: p.baseH,
      scale: p.scale,
      rot: p.rot,
      flipX: p.flipX,
      flipY: p.flipY,
      shadowDisabled: p.shadowDisabled,
      tags: Array.isArray(p.tags) ? p.tags.slice() : undefined,
      navPaths: Array.isArray(p.navPaths) ? p.navPaths.slice() : undefined,
      primaryPath: p.primaryPath,
    }
    if (!(p.assetId || p.source === 'imported' || isEmbeddedCustomPropLike(p.url))) {
      out.url = p.url
    }
    return out
  }).filter(Boolean)
}
function hydratePlacedPropsWithEmbeddedAssets(list, embeddedAssets){
  const assetMap = new Map((embeddedAssets || []).map(asset => [String(asset.assetId), asset]))
  return (list || []).map(raw => {
    const p = normalizePlacedPropObj(raw)
    if (!p) return null
    const asset = p.assetId ? assetMap.get(String(p.assetId)) : null
    if (asset && asset.data) {
      p.url = String(asset.data)
      p.mime = String(asset.mime || p.mime || getMimeFromDataUrl(asset.data) || '')
      p.source = 'imported'
      if (!p.propId) p.propId = String(asset.assetId)
      attachAssetTaxonomy(p, { tags: asset.tags || p.tags || ['imported', 'custom'] })
    } else {
      attachAssetTaxonomy(p, { tags: p.tags || p.navPaths || [] })
    }
    return p
  }).filter(p => p && p.url)
}

function rebuildPropsCatalog(){
  propsCatalog = [...builtInPropsCatalog, ...importedPropsCatalog].map(p => ({ ...p }))
  const model = buildCatalogTagModel(propsCatalog)
  propsCatalog = propsCatalog.map(p => attachAssetTaxonomy(p, { tags: p.tags || p.navPaths || [] }, model))
  builtInPropsCatalog = propsCatalog.filter(p => p.source === 'bundled')
  importedPropsCatalog = propsCatalog.filter(p => p.source === 'imported')
  const validPaths = new Set(['all'])
  for (const p of propsCatalog){ for (const path of (p.navPaths || [])) validPaths.add(String(path).toLowerCase()) }
  if (!validPaths.has(String(assetBrowserActivePath || 'all').toLowerCase())) assetBrowserActivePath = 'all'
}

function clearPropObjectURLs(list = importedPropsCatalog){
  for (const p of (list || [])){
    if (p && p.url && p.url.startsWith("blob:")) {
      try { URL.revokeObjectURL(p.url) } catch {}
    }
  }
}


function defaultShadowModeForCategory(category){
  const c = String(category || '').toLowerCase()
  if (c.includes('floor')) return 'none'
  if (c.includes('structure')) return 'solid'
  return 'default'
}
function normalizePropManifestMeta(a = {}){
  const src = String(a.src || '').toLowerCase()
  const id = String(a.id || '').toLowerCase()
  const name = String(a.name || '').toLowerCase()
  const looksLikeFloorProp = (
    src.includes('grate') || id.includes('grate') || name.includes('grate') ||
    src.includes('drain') || id.includes('drain') || name.includes('drain')
  )
  const category = String(a.category || (looksLikeFloorProp ? 'floor' : 'props'))
  const shadow = (a.shadow && typeof a.shadow === 'object') ? a.shadow : {}
  const inferredShadowMode = looksLikeFloorProp ? 'none' : defaultShadowModeForCategory(category)
  const shadowMode = String(shadow.mode || inferredShadowMode).toLowerCase()
  return {
    category,
    shadowMode,
    shadowProfile: String(shadow.profile || 'bounds').toLowerCase()
  }
}

function makeBundledPropUrl(src){
  try { return new URL(`assets/props/${src}`, window.location.href).href }
  catch { return `assets/props/${src}` }
}

async function loadBundledPropsManifest(force = false){
  if (!force && builtInPropsCatalog.length) return builtInPropsCatalog
  const manifestCandidates = [
    "assets/props/manifest.json",
    "assets/props-custom/manifest.json",
    "assets/user-assets/manifest.json"
  ]
  const merged = []
  for (const manifestPath of manifestCandidates){
    try {
      const res = await fetch(manifestPath, { cache: "no-store" })
      if (!res.ok) continue
      const manifest = await res.json()
      const list = Array.isArray(manifest?.assets) ? manifest.assets : []
      for (const [i, a] of list.entries()){
        if (!a || !a.src) continue
        const src = String(a.src)
        const baseDir = manifestPath.replace(/[^/]+$/, "")
        const resolvedSrc = /^(https?:|data:|blob:|\/)/i.test(src) ? src : (baseDir + src)
        const meta = normalizePropManifestMeta(a)
        merged.push(attachAssetTaxonomy({
          id: String(a.id || `${manifestPath}-builtin-${i}`),
          name: String(a.name || a.src).replace(/\.[^.]+$/, ""),
          url: resolvedSrc,
          source: "bundled",
          category: meta.category,
          gridW: Number(a.gridW ?? a.defaultGridW ?? a.size?.w ?? 1) || 1,
          gridH: Number(a.gridH ?? a.defaultGridH ?? a.size?.h ?? 1) || 1,
          rot: Number(a.rot || 0) || 0,
          castShadow: (meta.shadowMode !== 'none') && (a.castShadow !== false),
          shadow: { mode: meta.shadowMode, profile: meta.shadowProfile }
        }, { src, tags: a.tags || [] }))
      }
    } catch (err) {
      if (manifestPath === "assets/props/manifest.json") {
        console.warn("Bundled props manifest not loaded:", err)
      }
    }
  }
  builtInPropsCatalog = merged.slice(0, 1000)
  rebuildPropsCatalog()
  for (const p of builtInPropsCatalog) getPropImage(p)
  renderPropsShelf()
  return builtInPropsCatalog
}

function queueBundledPropsLoad(){
  if (bundledPropsLoadQueued) return
  bundledPropsLoadQueued = true
  Promise.resolve().then(() => loadBundledPropsManifest()).catch(() => {})
}

async function collectPngFilesFromDirectoryHandle(dirHandle){
  const out = []
  async function walk(handle){
    for await (const entry of handle.values()){
      if (entry.kind === "file"){
        if (!/\.(png|svg|webp|jpg|jpeg)$/i.test(entry.name)) continue
        const file = await entry.getFile()
        out.push(file)
      } else if (entry.kind === "directory"){
        await walk(entry)
      }
    }
  }
  await walk(dirHandle)
  return out
}

async function pickPropsFolder(){
  if (window.showDirectoryPicker){
    const dirHandle = await window.showDirectoryPicker({ mode: "read" })
    const files = await collectPngFilesFromDirectoryHandle(dirHandle)
    await loadPropsFromFolderFiles(files)
    return
  }
  if (propsFolderInput) propsFolderInput.click()
}

function renderPropsShelf(){
  if (!propsShelf) return
  propsShelf.innerHTML = ""
  renderAssetTree()
  const visible = (Array.isArray(propsCatalog) ? propsCatalog : []).filter(assetMatchesBrowser)
  if (!visible.length){
    propsShelf.classList.add("empty")
    const empty = document.createElement("div")
    empty.className = "propsEmpty"
    empty.textContent = (Array.isArray(propsCatalog) && propsCatalog.length) ? "No assets match this filter" : "No props loaded yet"
    propsShelf.appendChild(empty)
    return
  }
  propsShelf.classList.remove("empty")
  for (const prop of visible){
    const tile = document.createElement("button")
    tile.type = "button"
    tile.className = "propTile"
    tile.title = prop.name + " — drag onto map to place"
    tile.draggable = true
    tile.dataset.propId = prop.id

    const img = document.createElement("img")
    img.src = prop.url
    img.alt = prop.name
    img.draggable = false

    const name = document.createElement("div")
    name.className = "name"
    name.textContent = prop.name
    name.draggable = false

    const badge = document.createElement("div")
    badge.className = "badge"
    badge.textContent = "✓"

    tile.appendChild(img)
    tile.appendChild(name)
    tile.appendChild(badge)

    tile.addEventListener("click", () => {
      setPanelTab("assets")
    })

    tile.addEventListener("dragstart", (e) => {
      dragPropId = prop.id
      try {
        if (e.dataTransfer){
          e.dataTransfer.effectAllowed = "copy"
          e.dataTransfer.setData("text/plain", prop.id)
          e.dataTransfer.setData("application/x-dungeon-prop-id", prop.id)
        }
      } catch {}
    })
    tile.addEventListener("dragend", () => {
      dragPropId = null
      renderPropsShelf()
    })

    propsShelf.appendChild(tile)
  }
}
function fileLooksLikeSupportedImage(file){
  if (!file) return false
  const nameOk = /\.(png|svg|webp|jpg|jpeg)$/i.test(String(file.name || ''))
  const type = String(file.type || '').toLowerCase()
  const typeOk = type.startsWith('image/') && /(png|svg\+xml|webp|jpeg|jpg)/.test(type)
  return nameOk || typeOk
}
async function makeImportedPropFromFile(f, i=0){
  const assetId = makeCustomAssetId(f?.name || `image-${i+1}`)
  const dataUrl = await readFileAsDataURL(f)
  const baseName = String(f?.name || `Image ${i+1}`).replace(/\.[^.]+$/, "") || `Image ${i+1}`
  const filenameTag = slugifyAssetToken(baseName)
  return attachAssetTaxonomy({
    id: assetId,
    assetId,
    name: baseName,
    url: dataUrl,
    mime: String(f?.type || getMimeFromDataUrl(dataUrl) || ''),
    source: "imported"
  }, { tags: ['imported', 'custom', filenameTag] })
}
async function appendImportedPropsFromFiles(fileList){
  const files = Array.from(fileList || [])
    .filter(fileLooksLikeSupportedImage)
    .sort((a,b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric:true, sensitivity:"base" }))
    .slice(0, 500)
  if (!files.length) return []
  const fresh = (await Promise.all(files.map((f, i) => makeImportedPropFromFile(f, i)))).filter(Boolean)
  importedPropsCatalog = [...importedPropsCatalog, ...fresh]
  rebuildPropsCatalog()
  for (const p of fresh) getPropImage(p)
  armedPropId = null
  assetBrowserActivePath = 'custom'
  renderPropsShelf()
  setPanelTab("assets")
  return fresh
}
async function loadPropsFromFolderFiles(fileList){
  clearPropObjectURLs(importedPropsCatalog)
  importedPropsCatalog = []
  await appendImportedPropsFromFiles(fileList)
}

function setDungeonFromObject(d){
  if (!d || typeof d !== "object") return
  if (Number.isFinite(Number(d.gridSize))) dungeon.gridSize = Math.max(4, safeNum(d.gridSize, dungeon.gridSize))
  if (Number.isFinite(Number(d.subSnapDiv))) dungeon.subSnapDiv = Math.max(1, Math.min(16, Math.round(safeNum(d.subSnapDiv, dungeon.subSnapDiv))))

  // Prefer exact serialized edit geometry if present (preserves add/subtract ordering perfectly).
  const raw = (d.raw && typeof d.raw === "object") ? d.raw : null
  if (raw && (Array.isArray(raw.spaces) || Array.isArray(raw.paths) || Array.isArray(raw.lines) || Array.isArray(raw.shapes))) {
    dungeon.spaces = Array.isArray(raw.spaces) ? raw.spaces : []
    dungeon.paths  = Array.isArray(raw.paths)  ? raw.paths  : []
    dungeon.water  = (raw.water && typeof raw.water === "object") ? raw.water : { paths: [] }
    dungeon.lines  = Array.isArray(raw.lines) ? raw.lines : []
    dungeon.shapes = Array.isArray(raw.shapes) ? raw.shapes : []
  } else if (d.geometry && Array.isArray(d.geometry.regions)) {
    // Compact fallback: reconstruct as additive boundary regions.
    dungeon.spaces = d.geometry.regions
      .filter(poly => Array.isArray(poly) && poly.length >= 3)
      .map(poly => ({
        id: crypto.randomUUID(),
        mode: "add",
        polygon: poly.map(p => Array.isArray(p)
          ? { x: safeNum(p[0],0), y: safeNum(p[1],0) }
          : { x: safeNum(p.x,0), y: safeNum(p.y,0) }
        )
      }))
    dungeon.paths = []
    dungeon.water = { paths: [] }
    dungeon.lines = []
    dungeon.shapes = []
  } else {
    dungeon.spaces = Array.isArray(d.spaces) ? d.spaces : []
    dungeon.paths = Array.isArray(d.paths) ? d.paths : []
    dungeon.water = (d.water && typeof d.water === "object") ? d.water : { paths: [] }
    dungeon.lines = Array.isArray(d.lines) ? d.lines : []
    dungeon.shapes = Array.isArray(d.shapes) ? d.shapes : []
  }

  // Normalize IDs/modes after loading (older saves or hand-edited files).
  for (const s of dungeon.spaces) {
    if (!s.id) s.id = crypto.randomUUID()
    if (!s.mode) s.mode = "add"
    if (!Array.isArray(s.polygon)) s.polygon = []
    if (!Number.isFinite(Number(s.seq))) s.seq = nextEditSeq()
  }
  for (const p of dungeon.paths) {
    if (!p.id) p.id = crypto.randomUUID()
    if (!p.mode) p.mode = "add"
    if (!Array.isArray(p.points)) p.points = []
    if (!Number.isFinite(Number(p.seq))) p.seq = nextEditSeq()
    if (!Number.isFinite(Number(p.width))) p.width = Number(dungeon.style?.corridorWidth || 48)
    const normalizedPathShape = normalizePathShapeSettings(p, dungeon.style || {})
    p.shapeMode = normalizedPathShape.shapeMode
    p.smoothness = normalizedPathShape.smoothness
    p.amplitude = normalizedPathShape.amplitude
    p.frequency = normalizedPathShape.frequency
  }
  if (!dungeon.water || typeof dungeon.water !== "object") dungeon.water = { paths: [] }
  if (!Array.isArray(dungeon.water.paths)) dungeon.water.paths = []
  for (const wp of dungeon.water.paths) {
    if (!wp.id) wp.id = crypto.randomUUID()
    if (!wp.mode) wp.mode = "add"
    if (!Array.isArray(wp.points)) wp.points = []
    if (!Number.isFinite(Number(wp.seq))) wp.seq = nextEditSeq()
    if (!Number.isFinite(Number(wp.width))) wp.width = Number(dungeon.style?.water?.width || 52)
  }
  if (!Array.isArray(dungeon.lines)) dungeon.lines = []
  for (const ln of dungeon.lines) {
    if (!ln.id) ln.id = crypto.randomUUID()
    if (!ln.mode) ln.mode = "add"
    if (!Array.isArray(ln.points)) ln.points = []
    if (!Number.isFinite(Number(ln.seq))) ln.seq = nextEditSeq()
    if (!Number.isFinite(Number(ln.width))) ln.width = Number(dungeon.style?.lines?.width || 1.75)
    ln.dashed = ln.dashed === true
  }
  for (const sh of dungeon.shapes) {
    if (!sh.id) sh.id = crypto.randomUUID()
    if (!sh.mode) sh.mode = "add"
    if (!Number.isFinite(Number(sh.seq))) sh.seq = nextEditSeq()
  }

  // Preserve newer style keys by merging onto current/default style.
  const nextStyle = cloneJson(dungeon.style)
  if (d.style && typeof d.style === "object") {
    Object.assign(nextStyle, d.style)
    if (d.style.shadow && typeof d.style.shadow === "object") {
      nextStyle.shadow = Object.assign({}, dungeon.style.shadow, d.style.shadow)
      if (d.style.shadow.dir && typeof d.style.shadow.dir === "object") {
        nextStyle.shadow.dir = Object.assign({}, dungeon.style.shadow.dir, d.style.shadow.dir)
      }
    }
    if (d.style.hatch && typeof d.style.hatch === "object") {
      nextStyle.hatch = Object.assign({}, dungeon.style.hatch, d.style.hatch)
    }
    if (d.style.water && typeof d.style.water === "object") {
      nextStyle.water = Object.assign({}, dungeon.style.water, d.style.water)
    }
    if (d.style.lines && typeof d.style.lines === "object") {
      nextStyle.lines = Object.assign({}, dungeon.style.lines, d.style.lines)
    }
  }
  nextStyle.polySides = Math.max(3, Math.min(12, Math.round(safeNum(nextStyle.polySides, 6))))
  if (typeof nextStyle.propSnapEnabled !== "boolean") nextStyle.propSnapEnabled = true
  if (typeof nextStyle.showTextPreview !== "boolean") nextStyle.showTextPreview = true
  if (typeof nextStyle.showTextExport !== "boolean") nextStyle.showTextExport = true
  if (!(Number.isFinite(Number(nextStyle.hatch?.density)) && Number(nextStyle.hatch.density) > 0)) nextStyle.hatch.density = 0.25
  // Migrate old saves that used `paper` for the interior fill color.
  if (!nextStyle.floorColor && nextStyle.paper) nextStyle.floorColor = nextStyle.paper
  // Keep legacy alias in sync for compatibility with any older code paths.
  if (!nextStyle.paper && nextStyle.floorColor) nextStyle.paper = nextStyle.floorColor
  dungeon.style = nextStyle
  refreshEditSeqCounter()
}

function applyLoadedMapObject(obj){
  if (!obj || typeof obj !== "object") throw new Error("Invalid map file")

  // Supports both wrapped format {dungeon, camera...} and plain dungeon object.
  const d = (obj.dungeon && typeof obj.dungeon === "object") ? obj.dungeon : obj
  const embeddedAssets = Array.isArray(obj.embeddedAssets) ? obj.embeddedAssets : []
  setDungeonFromObject(d)
  rebuildImportedPropsFromEmbeddedAssets(embeddedAssets)
  placedProps = hydratePlacedPropsWithEmbeddedAssets(Array.isArray(d.placedProps) ? d.placedProps : [], embeddedAssets)
  placedTexts = Array.isArray(d.placedTexts) ? d.placedTexts.map(normalizeTextObj) : []

  
  if (obj.camera && typeof obj.camera === "object") {
    camera.x = safeNum(obj.camera.x, camera.x)
    camera.y = safeNum(obj.camera.y, camera.y)
    camera.zoom = camera.clampZoom(safeNum(obj.camera.zoom, camera.zoom))
  }

  draft=null; draftRect=null; freeDraw=null; draftShape=null; draftArc=null; selectedShapeId=null; selectedPropId=null; selectedTextId=null; shapeDrag=null; propTransformDrag=null; textDrag=null; eraseStroke=null
  syncTextPanelVisibility()
  underMode = false
  syncUI()
  drawPuck()
  ensureCompileVersions()
  bumpInteriorVersion()
  bumpWaterVersion()
  compiledSig = "" // force recompile next frame
}


function getCompactBoundaryRegions(){
  try {
    const cache = ensureCompiled()
    if (!cache?.contoursWorld?.length) return []
    return cache.contoursWorld
      .filter(poly => Array.isArray(poly) && poly.length >= 3)
      .map(poly => poly.map(p => [Number(p.x.toFixed(3)), Number(p.y.toFixed(3))]))
  } catch (err) {
    console.warn("Failed to build compact boundary save; falling back to raw geometry.", err)
    return []
  }
}

async function getSaveMapObject(){
  const compactRegions = getCompactBoundaryRegions()
  const dungeonData = {
    gridSize: dungeon.gridSize,
    subSnapDiv: dungeon.subSnapDiv,
    style: cloneJson(dungeon.style),
    // Reliable exact geometry for editing (preserves add/subtract order + all tool outputs)
    raw: {
      spaces: cloneJson(dungeon.spaces),
      paths: cloneJson(dungeon.paths),
      water: cloneJson(dungeon.water),
      lines: cloneJson(dungeon.lines),
      shapes: dungeon.shapes.map(s => ({...s, _poly: undefined}))
    }
  }

  // Optional compact boundary loops for future canonical loading / lightweight processing.
  if (compactRegions.length) {
    dungeonData.geometry = {
      kind: "boundary-regions",
      note: "Canonical boundary loops (derived). Exact editable geometry is stored in dungeon.raw.",
      regions: compactRegions
    }
  }

  const serializedPlacedProps = serializePlacedPropsForSave(placedProps || [])
  const embeddedAssets = collectUsedEmbeddedAssetsFromPlacedProps(placedProps || [])
  return {
    app: "DelvSketch",
    format: "dungeon-sketch-map",
    version: 6,
    savedAt: new Date().toISOString(),
    camera: { x: camera.x, y: camera.y, zoom: camera.zoom },
    embeddedAssets,
    dungeon: Object.assign(dungeonData, { placedProps: serializedPlacedProps, placedTexts: cloneJson(placedTexts || []) })
  }
}

async function saveMapToFile(){
  const data = JSON.stringify(await getSaveMapObject(), null, 2)
  const blob = new Blob([data], { type: "application/json" })
  const a = document.createElement("a")
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  a.href = URL.createObjectURL(blob)
  a.download = `dungeon-sketch-map-${stamp}.json`
  document.body.appendChild(a)
  a.click()
  setTimeout(() => {
    URL.revokeObjectURL(a.href)
    a.remove()
  }, 0)
}

function openBugReport(){
  const versionText = (document.getElementById("btnCoverHome")?.textContent || "DelvSketch").trim()
  const body = [
    "## Describe the bug",
    "",
    "A clear and concise description of what went wrong.",
    "",
    "## Steps to reproduce",
    "",
    "1. ",
    "2. ",
    "3. ",
    "",
    "## Expected behavior",
    "",
    "What did you expect to happen?",
    "",
    "## Environment",
    `- Version: ${versionText}`,
    `- Browser: ${navigator.userAgent}`,
    `- Viewport: ${window.innerWidth}x${window.innerHeight}`
  ].join("\n")
  const params = new URLSearchParams({
    title: "[Bug]: ",
    body
  })
  window.open(`https://github.com/EscaladeDev/DelvSketch/issues/new?${params.toString()}`, "_blank", "noopener")
}

async function loadMapFromFile(file){
  if (!file) return
  const text = await file.text()
  const obj = JSON.parse(text)
  pushUndo()
  applyLoadedMapObject(obj)
  updateHistoryButtons()
}

function pushUndo(){ undoStack.push(snapshot()); if(undoStack.length>200) undoStack.shift(); redoStack.length=0; updateHistoryButtons() }
function undo(){ if(!undoStack.length) return; redoStack.push(snapshot()); restore(undoStack.pop()); updateHistoryButtons() }
function redo(){ if(!redoStack.length) return; undoStack.push(snapshot()); restore(redoStack.pop()); updateHistoryButtons() }

btnUndo.addEventListener("click", undo)
btnRedo.addEventListener("click", redo)
if (btnSaveMap) btnSaveMap.addEventListener("click", () => { saveMapToFile().catch(err => alert(`Could not save map: ${err.message || err}`)) })
if (btnLoadMap) btnLoadMap.addEventListener("click", () => fileLoadMap && fileLoadMap.click())
if (btnBugReport) btnBugReport.addEventListener("click", openBugReport)
if (btnDrawerToggle) btnDrawerToggle.addEventListener("click", toggleDrawer)
if (btnDrawerCollapse) btnDrawerCollapse.addEventListener("click", toggleDrawer)
if (drawerPeekTab) drawerPeekTab.addEventListener("click", () => setDrawerOpen(true))
if (tabStyleBtn) tabStyleBtn.addEventListener("click", () => setPanelTab("style"))
if (tabAssetsBtn) tabAssetsBtn.addEventListener("click", () => setPanelTab("assets"))
syncPanelTabs()
if (btnPropsPick) btnPropsPick.addEventListener("click", async () => { try { await pickPropsFolder() } catch (err) { if (err && err.name !== "AbortError") alert(`Could not open prop folder: ${err.message || err}`) } })
if (btnPropsClear) btnPropsClear.addEventListener("click", () => { clearPropObjectURLs(importedPropsCatalog); importedPropsCatalog = []; rebuildPropsCatalog(); armedPropId = null; dragPropId = null; propImageCache.clear(); renderPropsShelf() })
if (btnPropsDefaults) btnPropsDefaults.addEventListener("click", async () => { try { await loadBundledPropsManifest(true) } catch {} })
if (propsFolderInput) propsFolderInput.addEventListener("change", async (e) => {
  try { await loadPropsFromFolderFiles(e.target.files) }
  catch (err) { alert(`Could not load prop folder: ${err.message || err}`) }
  e.target.value = ""
})
renderPropsShelf()
if (propsSearchInput) propsSearchInput.addEventListener("input", () => {
  assetBrowserSearchTerm = String(propsSearchInput.value || '')
  renderPropsShelf()
})
queueBundledPropsLoad()
if (fileLoadMap) fileLoadMap.addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0]
  if (!file) return
  try { await loadMapFromFile(file) }
  catch (err) { alert(`Could not load map: ${err.message || err}`) }
  e.target.value = ""
})
function clearMapContents(){
  dungeon.spaces = [];
  dungeon.paths = [];
  dungeon.water = { paths: [] };
  dungeon.lines = [];
  dungeon.shapes = [];
  placedProps = [];
  placedTexts = [];

  selectedPropId = null;
  selectedShapeId = null;
  selectedTextId = null;
  armedPropId = null;
  dragPropId = null;

  draft = null;
  draftRect = null;
  freeDraw = null;
  lineDraw = null;
  draftShape = null;
  draftArc = null;
  eraseStroke = null;

  bumpInteriorVersion();
  bumpWaterVersion();
  bumpLineVersion();
  refreshEditSeqCounter();
  syncTextPanelVisibility();
  updateHistoryButtons();
  render();
}
btnClear.addEventListener("click", () => {
  pushUndo();
  clearMapContents();
});
btnExport.addEventListener("click", () => exportPNG().catch(err => { console.error(err); alert("PNG export failed. See console.") }))
btnPDF?.addEventListener("click", () => exportMultipagePDF().catch(err => { console.error(err); alert("PDF export failed. See console."); }))
if (btnFinish) btnFinish.addEventListener("click", finishTool)
if (btnUnder) btnUnder.addEventListener("click", () => {
  if (selectedShapeId){
    const sh = dungeon.shapes.find(s=>s.id===selectedShapeId)
    if (!sh) return
    pushUndo()
    sh.mode = (sh.mode === "add") ? "subtract" : "add"
    sh.seq = nextEditSeq()
    return
  }
  underMode = !underMode
  syncUnderUI()
  syncToolUI()
})

function getPropWorldAABB(a){
  const cx = Number(a?.x || 0), cy = Number(a?.y || 0)
  const rs = getPlacedPropRenderSize(a)
  const w = Math.max(0, Number(rs.w || dungeon.gridSize) || dungeon.gridSize)
  const h = Math.max(0, Number(rs.h || dungeon.gridSize) || dungeon.gridSize)
  const rot = Number(a?.rot || 0) || 0
  const c = Math.cos(rot), s = Math.sin(rot)
  const ex = Math.abs(c) * (w/2) + Math.abs(s) * (h/2)
  const ey = Math.abs(s) * (w/2) + Math.abs(c) * (h/2)
  return { minx: cx - ex, miny: cy - ey, maxx: cx + ex, maxy: cy + ey }
}

function unionBounds(a, b){
  if (!a) return b ? { ...b } : null
  if (!b) return { ...a }
  return {
    minx: Math.min(a.minx, b.minx),
    miny: Math.min(a.miny, b.miny),
    maxx: Math.max(a.maxx, b.maxx),
    maxy: Math.max(a.maxy, b.maxy)
  }
}

function renderSceneToCanvasForBounds(targetCanvas, worldBounds){
  const tw = Math.max(1, targetCanvas.width|0)
  const th = Math.max(1, targetCanvas.height|0)
  const tctx = targetCanvas.getContext('2d', { alpha: true })
  const exportCam = new Camera()
  exportCam.minZoom = 0.001
  exportCam.maxZoom = 100000
  exportCam.zoom = Math.min(tw / (worldBounds.maxx - worldBounds.minx), th / (worldBounds.maxy - worldBounds.miny))
  exportCam.x = -worldBounds.minx
  exportCam.y = -worldBounds.miny

  tctx.clearRect(0,0,tw,th)
  if (!dungeon.style.transparentBackground){
    tctx.fillStyle = dungeon.style.backgroundColor || '#f8f7f4'
    tctx.fillRect(0,0,tw,th)
  }
  const liveZoom = Math.max(0.0001, Number(camera.zoom) || 1)
  const exportGridLineWidthScale = Math.min(8, Math.max(1, exportCam.zoom / liveZoom))
  const cache = ensureCompiled()
  drawCompiledExteriorGrid(tctx, exportCam, cache, dungeon, tw, th, exportGridLineWidthScale)
  drawCompiledBase(tctx, exportCam, cache, dungeon, tw, th, exportGridLineWidthScale)
  drawLinesTo(tctx, exportCam)
  drawPlacedPropsTo(tctx, exportCam, tw, th, cache)
  drawTextsTo(tctx, exportCam, { forExport:true })
  return { ctx: tctx, cam: exportCam }
}

let pngExportDialogState = {
  source: 'map',
  paddingSquares: 1,
  squareSizeIn: 1.0,
  dpi: 300,
}

function normalizePngExportOpts(raw = {}){
  const source = String(raw.source || 'map').toLowerCase().includes('view') ? 'viewport' : 'map'
  return {
    source,
    paddingSquares: clampNum(Number(raw.paddingSquares ?? (source === 'viewport' ? 0 : 1)) || 0, 0, 100),
    squareSizeIn: clampNum(Number(raw.squareSizeIn) || 1, 0.1, 4),
    dpi: Math.round(clampNum(Number(raw.dpi) || 300, 72, 1200)),
  }
}

function applyPngExportModalStateToInputs(raw){
  const opts = normalizePngExportOpts(raw)
  if (pngSourceInput) pngSourceInput.value = opts.source === 'viewport' ? 'viewport' : 'map'
  if (pngPaddingSquaresInput) pngPaddingSquaresInput.value = String(Number(opts.paddingSquares.toFixed(2)))
  if (pngSquareSizeInInput) pngSquareSizeInInput.value = String(Number(opts.squareSizeIn.toFixed(2)))
  if (pngDpiInput) pngDpiInput.value = String(opts.dpi)
  if (pngDpiOut) pngDpiOut.textContent = String(opts.dpi)
  syncPngExportModalSummary()
}

function readPngExportModalInputs(){
  return normalizePngExportOpts({
    source: pngSourceInput?.value || 'map',
    paddingSquares: pngPaddingSquaresInput?.value,
    squareSizeIn: pngSquareSizeInInput?.value,
    dpi: pngDpiInput?.value,
  })
}

function computePngExportPlan(rawOpts){
  const opts = normalizePngExportOpts(rawOpts)
  const bounds = getExportWorldBounds({ source: opts.source, paddingSquares: opts.paddingSquares })
  if (!bounds) return { ok:false, opts, reason:'Nothing to export from the selected area.' }
  const g = Math.max(1, Number(dungeon.gridSize) || 32)
  const worldW = Math.max(0, bounds.maxx - bounds.minx)
  const worldH = Math.max(0, bounds.maxy - bounds.miny)
  if (!(worldW > 0) || !(worldH > 0)) return { ok:false, opts, reason:'Nothing to export from the selected area.' }
  const cols = worldW / g
  const rows = worldH / g
  const pxPerSquare = opts.squareSizeIn * opts.dpi
  const widthPx = Math.max(1, Math.round(cols * pxPerSquare))
  const heightPx = Math.max(1, Math.round(rows * pxPerSquare))
  const printWidthIn = cols * opts.squareSizeIn
  const printHeightIn = rows * opts.squareSizeIn
  let severity = ''
  const warnings = []
  if (widthPx > 8192 || heightPx > 8192){ warnings.push('Large export may be slow in the browser.'); severity = 'warn' }
  if (widthPx > 16384 || heightPx > 16384){ warnings.push('Resolution exceeds common browser canvas limits and may fail.'); severity = 'error' }
  const totalPx = widthPx * heightPx
  if (totalPx > 80_000_000){ warnings.push('Very large total pixel count may use too much memory.'); severity = severity || 'warn' }
  if (totalPx > 200_000_000){ warnings.push('Total pixel count is extremely high and may fail.'); severity = 'error' }
  return { ok:true, opts, bounds, cols, rows, pxPerSquare, widthPx, heightPx, printWidthIn, printHeightIn, totalPx, warnings, severity }
}

function syncPngExportModalSummary(){
  if (!pngExportSummary) return
  const plan = computePngExportPlan(readPngExportModalInputs())
  if (!plan.ok){
    pngExportSummary.textContent = plan.reason || 'Nothing to export.'
    if (pngExportWarning){ pngExportWarning.textContent = ''; pngExportWarning.classList.add('hidden'); pngExportWarning.classList.remove('warn','error') }
    if (btnPngConfirm) btnPngConfirm.disabled = true
    return
  }
  pngExportSummary.textContent = `Pixels per square: ${Math.round(plan.pxPerSquare)} px • Final resolution: ${plan.widthPx} × ${plan.heightPx} px • Print size: ${plan.printWidthIn.toFixed(2)} × ${plan.printHeightIn.toFixed(2)} in @ ${plan.opts.dpi} DPI`
  if (pngExportWarning){
    if (plan.warnings.length){
      pngExportWarning.textContent = plan.warnings.join(' ')
      pngExportWarning.classList.remove('hidden')
      pngExportWarning.classList.toggle('warn', plan.severity !== 'error')
      pngExportWarning.classList.toggle('error', plan.severity === 'error')
    } else {
      pngExportWarning.textContent = ''
      pngExportWarning.classList.add('hidden')
      pngExportWarning.classList.remove('warn','error')
    }
  }
  if (btnPngConfirm) btnPngConfirm.disabled = plan.severity === 'error'
  if (pngDpiOut && pngDpiInput) pngDpiOut.textContent = String(Math.round(Number(pngDpiInput.value) || plan.opts.dpi))
}

function openPngExportOptionsDialog(){
  if (!pngExportModal) return Promise.resolve(null)
  applyPngExportModalStateToInputs(pngExportDialogState)
  pngExportModal.classList.remove('hidden')
  pngExportModal.setAttribute('aria-hidden', 'false')
  document.body.classList.add('modal-open')
  return new Promise((resolve) => {
    let closed = false
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const close = (result) => {
      if (closed) return
      closed = true
      pngExportModal.classList.add('hidden')
      pngExportModal.setAttribute('aria-hidden', 'true')
      document.body.classList.remove('modal-open')
      document.body.style.overflow = prevOverflow
      if (result) pngExportDialogState = normalizePngExportOpts(result)
      cleanup()
      resolve(result || null)
    }
    const onCancel = () => close(null)
    const onConfirm = () => {
      const plan = computePngExportPlan(readPngExportModalInputs())
      if (!plan.ok || plan.severity === 'error') return
      close(plan.opts)
    }
    const onKeyDown = (e) => {
      if (e.key === 'Escape'){ e.preventDefault(); onCancel(); return }
      if (e.key === 'Enter'){
        const el = e.target
        const tag = (el && el.tagName) ? el.tagName.toLowerCase() : ''
        if (tag !== 'textarea' && !(tag === 'button' && el.id === 'btnPngCancel')) { e.preventDefault(); onConfirm() }
      }
    }
    const onBackdrop = (e) => { if (e.target && e.target.closest('[data-png-modal-close]')) onCancel() }
    const onInput = () => syncPngExportModalSummary()
    const cleanup = () => {
      btnPngCancel?.removeEventListener('click', onCancel)
      btnPngModalClose?.removeEventListener('click', onCancel)
      btnPngConfirm?.removeEventListener('click', onConfirm)
      pngExportModal?.removeEventListener('click', onBackdrop)
      pngExportModal?.removeEventListener('input', onInput)
      pngExportModal?.removeEventListener('change', onInput)
      window.removeEventListener('keydown', onKeyDown, true)
    }
    btnPngCancel?.addEventListener('click', onCancel)
    btnPngModalClose?.addEventListener('click', onCancel)
    btnPngConfirm?.addEventListener('click', onConfirm)
    pngExportModal?.addEventListener('click', onBackdrop)
    pngExportModal?.addEventListener('input', onInput)
    pngExportModal?.addEventListener('change', onInput)
    window.addEventListener('keydown', onKeyDown, true)
    queueMicrotask(() => (btnPngConfirm || btnPngCancel)?.focus())
  })
}

function showExportProgress(title, message, progress = null, meta = ""){
  if (!exportProgressOverlay) return
  exportProgressOverlay.classList.remove("hidden")
  exportProgressOverlay.setAttribute("aria-hidden", "false")
  if (exportProgressTitle) exportProgressTitle.textContent = title || "Exporting…"
  if (exportProgressMessage) exportProgressMessage.textContent = message || "Working…"
  if (exportProgressFill){
    const pct = Number.isFinite(progress) ? Math.max(2, Math.min(100, progress)) : 12
    exportProgressFill.style.width = pct + "%"
  }
  if (exportProgressMeta) exportProgressMeta.textContent = meta || ""
}

function updateExportProgress(message, progress = null, meta = undefined){
  if (exportProgressOverlay?.classList.contains("hidden")) return showExportProgress("Exporting…", message, progress, meta || "")
  if (exportProgressMessage && message != null) exportProgressMessage.textContent = message
  if (exportProgressFill && Number.isFinite(progress)) exportProgressFill.style.width = Math.max(2, Math.min(100, progress)) + "%"
  if (exportProgressMeta && meta !== undefined) exportProgressMeta.textContent = meta
}

function hideExportProgress(){
  if (!exportProgressOverlay) return
  exportProgressOverlay.classList.add("hidden")
  exportProgressOverlay.setAttribute("aria-hidden", "true")
}


function nextPaintFrame(){
  return new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  })
}

async function showExportProgressAndYield(title, message, progress = null, meta = ""){
  showExportProgress(title, message, progress, meta)
  await nextPaintFrame()
}

async function updateExportProgressAndYield(message, progress = null, meta = undefined){
  updateExportProgress(message, progress, meta)
  await nextPaintFrame()
}

async function exportPNG(){
  const opts = await openPngExportOptionsDialog()
  if (!opts) return
  const plan = computePngExportPlan(opts)
  if (!plan.ok){
    alert(plan.reason || 'Nothing to export.')
    return
  }
  try {
    await showExportProgressAndYield('PNG Export', 'Rendering map image…', 15, `${plan.widthPx} × ${plan.heightPx} px`)
    const out = document.createElement('canvas')
    out.width = plan.widthPx
    out.height = plan.heightPx
    renderSceneToCanvasForBounds(out, plan.bounds)
    await updateExportProgressAndYield('Encoding PNG…', 82, `${plan.widthPx} × ${plan.heightPx} px`)
    const a = document.createElement('a')
    a.download = `dungeon-map-${plan.widthPx}x${plan.heightPx}.png`
    a.href = out.toDataURL('image/png')
    await updateExportProgressAndYield('Starting download…', 100, a.download)
    a.click()
  } finally {
    setTimeout(hideExportProgress, 120)
  }
}

function compileSignature(){
  // committed geometry + style knobs that affect compiled caches only
  return JSON.stringify({
    spaces: dungeon.spaces,
    paths: dungeon.paths,
    shapes: dungeon.shapes.map(s => ({...s, _poly: undefined})),
    water: dungeon.water,
    style: {
      wallColor: dungeon.style.wallColor,
      wallWidth: dungeon.style.wallWidth,
      shadow: dungeon.style.shadow,
      hatch: dungeon.style.hatch,
      water: dungeon.style.water,
    }
  })
}

function ensureCompiled(){
  const sig = compileSignature()
  if (!compiledCache || sig !== compiledSig){
    compiledSig = sig
    compiledCache = compileWorldCache(dungeon, placedProps, getPropById)
  }
  return compiledCache
}


async function ensureJsPDF(){
  if (window.jspdf && window.jspdf.jsPDF) return window.jspdf.jsPDF
  await new Promise((resolve, reject) => {
    const s = document.createElement("script")
    s.src = "https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js"
    s.onload = resolve
    s.onerror = reject
    document.head.appendChild(s)
  })
  if (!window.jspdf?.jsPDF) throw new Error("jsPDF failed to load")
  return window.jspdf.jsPDF
}

function inchesToMm(v){ return Number(v) * 25.4 }
function mmToInches(v){ return Number(v) / 25.4 }
function clampNum(v, min, max){ return Math.max(min, Math.min(max, v)) }

let pdfExportDialogState = {
  mode: 'tiled',
  paper: 'LETTER',
  orientation: 'auto',
  source: 'map',
  paddingSquares: 1,
  marginIn: 0.25,
  rasterDpi: 220,
  squareSizeIn: 1.0,
  overlapSquares: 0,
  labels: true,
  trimMarks: true,
  overview: true,
  includeEmptyTiles: false,
}

function normalizePdfExportOpts(raw = {}){
  const mode = String(raw.mode || 'tiled').toLowerCase().startsWith('s') ? 'single' : 'tiled'
  const source = String(raw.source || 'map').toLowerCase().includes('view') ? 'viewport' : 'map'
  const out = {
    mode,
    paper: String(raw.paper || 'LETTER').toUpperCase() === 'A4' ? 'A4' : 'LETTER',
    orientation: ['auto','portrait','landscape'].includes(String(raw.orientation || 'auto')) ? String(raw.orientation || 'auto') : 'auto',
    source,
    paddingSquares: Math.max(0, Math.round(Number(raw.paddingSquares ?? (source === 'map' ? 1 : 0)) || 0)),
    marginIn: clampNum(Number(raw.marginIn) || 0.25, 0, 2),
    rasterDpi: clampNum(Math.round(Number(raw.rasterDpi) || 220), 96, 600),
    squareSizeIn: clampNum(Number(raw.squareSizeIn) || 1, 0.1, 5),
    overlapSquares: Math.max(0, Math.floor(Number(raw.overlapSquares) || 0)),
    labels: raw.labels !== false,
    trimMarks: raw.trimMarks !== false,
    overview: raw.overview !== false,
    includeEmptyTiles: !!raw.includeEmptyTiles,
  }
  if (out.source === 'viewport' && !(raw && Object.prototype.hasOwnProperty.call(raw, 'paddingSquares'))) out.paddingSquares = 0
  return out
}

function syncPdfExportSummary(opts){
  if (!pdfExportSummary) return
  if (opts.mode === 'single'){
    pdfExportSummary.textContent = `Single-page PDF: fits the selected content area to one page. Margins ${opts.marginIn.toFixed(2)} in, ${opts.rasterDpi} dpi.`
    return
  }
  const emptyText = opts.includeEmptyTiles ? 'including empty tiles' : 'skipping effectively empty tiles'
  pdfExportSummary.textContent = `Tiled PDF: ${opts.squareSizeIn.toFixed(2)} in per grid square, overlap ${opts.overlapSquares} square(s), ${emptyText}.`
}
function applyPdfExportModalStateToInputs(raw){
  const opts = normalizePdfExportOpts(raw)
  if (pdfModeInput) pdfModeInput.value = opts.mode
  if (pdfPaperInput) pdfPaperInput.value = opts.paper
  if (pdfOrientationInput) pdfOrientationInput.value = opts.orientation
  if (pdfSourceInput) pdfSourceInput.value = opts.source === 'viewport' ? 'viewport' : 'map'
  if (pdfPaddingSquaresInput) pdfPaddingSquaresInput.value = String(opts.paddingSquares)
  if (pdfMarginInInput) pdfMarginInInput.value = String(Number(opts.marginIn.toFixed(2)))
  if (pdfRasterDpiInput) pdfRasterDpiInput.value = String(opts.rasterDpi)
  if (pdfRasterDpiOut) pdfRasterDpiOut.textContent = String(opts.rasterDpi)
  if (pdfSquareSizeInInput) pdfSquareSizeInInput.value = String(Number(opts.squareSizeIn.toFixed(2)))
  if (pdfOverlapSquaresInput) pdfOverlapSquaresInput.value = String(opts.overlapSquares)
  if (pdfLabelsInput) pdfLabelsInput.checked = !!opts.labels
  if (pdfTrimMarksInput) pdfTrimMarksInput.checked = !!opts.trimMarks
  if (pdfOverviewInput) pdfOverviewInput.checked = !!opts.overview
  if (pdfIncludeEmptyTilesInput) pdfIncludeEmptyTilesInput.checked = !!opts.includeEmptyTiles
  syncPdfExportModalFormVisibility()
  syncPdfExportModalSummary()
}

function readPdfExportModalInputs(){
  const source = (pdfSourceInput?.value === 'viewport') ? 'viewport' : 'map'
  return normalizePdfExportOpts({
    mode: pdfModeInput?.value || 'tiled',
    paper: pdfPaperInput?.value || 'LETTER',
    orientation: pdfOrientationInput?.value || 'auto',
    source,
    paddingSquares: pdfPaddingSquaresInput?.value,
    marginIn: pdfMarginInInput?.value,
    rasterDpi: pdfRasterDpiInput?.value,
    squareSizeIn: pdfSquareSizeInInput?.value,
    overlapSquares: pdfOverlapSquaresInput?.value,
    labels: !!pdfLabelsInput?.checked,
    trimMarks: !!pdfTrimMarksInput?.checked,
    overview: !!pdfOverviewInput?.checked,
    includeEmptyTiles: !!pdfIncludeEmptyTilesInput?.checked,
  })
}

function syncPdfExportModalFormVisibility(){
  const opts = readPdfExportModalInputs()
  if (pdfTiledSection) pdfTiledSection.classList.toggle('hidden', opts.mode !== 'tiled')
  if (pdfPaddingSquaresInput && pdfSourceInput){
    const shouldDefault = source => String(pdfPaddingSquaresInput.dataset.autofillSource || '') === source
    if (pdfSourceInput.value === 'viewport' && (pdfPaddingSquaresInput.value === '' || shouldDefault('map'))){
      pdfPaddingSquaresInput.value = '0'
      pdfPaddingSquaresInput.dataset.autofillSource = 'viewport'
    } else if (pdfSourceInput.value !== 'viewport' && (pdfPaddingSquaresInput.value === '' || shouldDefault('viewport'))){
      pdfPaddingSquaresInput.value = '1'
      pdfPaddingSquaresInput.dataset.autofillSource = 'map'
    }
  }
}

function syncPdfExportModalSummary(){
  syncPdfExportSummary(readPdfExportModalInputs())
}

function openPdfExportOptionsDialog(){
  if (!pdfExportModal) return Promise.resolve(null)
  applyPdfExportModalStateToInputs(pdfExportDialogState)
  pdfExportModal.classList.remove('hidden')
  pdfExportModal.setAttribute('aria-hidden', 'false')
  document.body.classList.add('modal-open')

  return new Promise((resolve) => {
    let closed = false
    let prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const close = (result) => {
      if (closed) return
      closed = true
      pdfExportModal.classList.add('hidden')
      pdfExportModal.setAttribute('aria-hidden', 'true')
      document.body.classList.remove('modal-open')
      document.body.style.overflow = prevOverflow
      if (result) pdfExportDialogState = normalizePdfExportOpts(result)
      cleanup()
      resolve(result || null)
    }

    const onCancel = () => close(null)
    const onConfirm = () => close(readPdfExportModalInputs())
    const onKeyDown = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); return }
      if (e.key === 'Enter'){
        const el = e.target
        const tag = (el && el.tagName) ? el.tagName.toLowerCase() : ''
        if (tag !== 'textarea' && !(tag === 'button' && el.id === 'btnPdfCancel')) {
          e.preventDefault(); onConfirm()
        }
      }
    }
    const onBackdrop = (e) => {
      if (e.target && e.target.closest('[data-pdf-modal-close]')) onCancel()
    }
    const onInput = () => {
      if (pdfRasterDpiOut && pdfRasterDpiInput) pdfRasterDpiOut.textContent = String(Math.round(Number(pdfRasterDpiInput.value) || 220))
      syncPdfExportModalFormVisibility()
      syncPdfExportModalSummary()
    }

    const cleanup = () => {
      btnPdfCancel?.removeEventListener('click', onCancel)
      btnPdfModalClose?.removeEventListener('click', onCancel)
      btnPdfConfirm?.removeEventListener('click', onConfirm)
      pdfExportModal?.removeEventListener('click', onBackdrop)
      pdfExportModal?.removeEventListener('input', onInput)
      pdfExportModal?.removeEventListener('change', onInput)
      window.removeEventListener('keydown', onKeyDown, true)
    }

    btnPdfCancel?.addEventListener('click', onCancel)
    btnPdfModalClose?.addEventListener('click', onCancel)
    btnPdfConfirm?.addEventListener('click', onConfirm)
    pdfExportModal?.addEventListener('click', onBackdrop)
    pdfExportModal?.addEventListener('input', onInput)
    pdfExportModal?.addEventListener('change', onInput)
    window.addEventListener('keydown', onKeyDown, true)

    queueMicrotask(() => (btnPdfConfirm || btnPdfCancel)?.focus())
  })
}

function promptYesNo(message, defaultYes=true){
  const d = defaultYes ? 'y' : 'n'
  const raw = (prompt(`${message} (y/n)`, d) || d).trim().toLowerCase()
  if (!raw) return defaultYes
  if (raw.startsWith('y')) return true
  if (raw.startsWith('n')) return false
  return defaultYes
}
function rowLabelFromIndex(i){
  let n = Math.floor(i)
  let out = ''
  do {
    out = String.fromCharCode(65 + (n % 26)) + out
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return out
}
function pageTileLabel(r, c){ return `${rowLabelFromIndex(r)}${c+1}` }

function snapBoundsToGrid(bounds, paddingSquares=0){
  if (!bounds) return null
  const g = Math.max(1, Number(dungeon.gridSize) || 32)
  const pad = Math.max(0, Number(paddingSquares) || 0) * g
  const b = {
    minx: Number(bounds.minx) - pad,
    miny: Number(bounds.miny) - pad,
    maxx: Number(bounds.maxx) + pad,
    maxy: Number(bounds.maxy) + pad
  }
  b.minx = Math.floor(b.minx / g) * g
  b.miny = Math.floor(b.miny / g) * g
  b.maxx = Math.ceil(b.maxx / g) * g
  b.maxy = Math.ceil(b.maxy / g) * g
  if (!(b.maxx > b.minx) || !(b.maxy > b.miny)) return null
  return b
}

function getViewportWorldBounds(options = {}){
  if (!(W > 0 && H > 0 && camera.zoom > 0)) return null
  const base = {
    minx: -camera.x,
    miny: -camera.y,
    maxx: -camera.x + (W / camera.zoom),
    maxy: -camera.y + (H / camera.zoom)
  }
  return snapBoundsToGrid(base, options.paddingSquares || 0)
}

function getExportWorldBounds(options = {}){
  if (options && options.source === 'viewport') return getViewportWorldBounds(options)

  const cache = ensureCompiled()
  let b = null
  if (cache?.contentBounds) b = unionBounds(b, cache.contentBounds)
  else if (cache?.bounds) b = unionBounds(b, cache.bounds)

  if (Array.isArray(dungeon.lines)) {
    for (const line of dungeon.lines){
      b = unionBounds(b, lineStrokeBounds(line))
    }
  }

  if (Array.isArray(placedProps)){
    for (const a of placedProps){
      if (!a) continue
      b = unionBounds(b, getPropWorldAABB(a))
    }
  }
  if (!b) return null

  const g = Math.max(1, Number(dungeon.gridSize) || 32)
  const wallPad = Math.max(0, Number(dungeon.style?.wallWidth || 6)) * 0.75
  const shadowPad = !!(dungeon.style?.shadow?.enabled) ? Math.max(0, Number(dungeon.style?.shadow?.length || 0)) + 4 : 0
  const basePad = Math.max(g * 0.5, wallPad + shadowPad)
  const userPad = Math.max(0, Number(options.paddingSquares || 0)) * g
  const pad = basePad + userPad

  b = { minx: b.minx - pad, miny: b.miny - pad, maxx: b.maxx + pad, maxy: b.maxy + pad }
  b.minx = Math.floor(b.minx / g) * g
  b.miny = Math.floor(b.miny / g) * g
  b.maxx = Math.ceil(b.maxx / g) * g
  b.maxy = Math.ceil(b.maxy / g) * g

  if (!(b.maxx > b.minx) || !(b.maxy > b.miny)) return null
  return b
}

function drawPdfTrimMarks(pdf, pageMm, rectMm){
  const x = rectMm.x, y = rectMm.y, w = rectMm.w, h = rectMm.h
  if (!(w > 0 && h > 0)) return
  const mark = 4
  const gap = 1
  pdf.setDrawColor(90, 90, 90)
  pdf.setLineWidth(0.2)
  const segs = [
    [x-gap-mark, y, x-gap, y], [x, y-gap-mark, x, y-gap],
    [x+w+gap, y, x+w+gap+mark, y], [x+w, y-gap-mark, x+w, y-gap],
    [x-gap-mark, y+h, x-gap, y+h], [x, y+h+gap, x, y+h+gap+mark],
    [x+w+gap, y+h, x+w+gap+mark, y+h], [x+w, y+h+gap, x+w, y+h+gap+mark],
  ]
  for (const [x1,y1,x2,y2] of segs){
    if (Math.min(x1,x2) < 0 || Math.max(x1,x2) > pageMm.w || Math.min(y1,y2) < 0 || Math.max(y1,y2) > pageMm.h) continue
    pdf.line(x1,y1,x2,y2)
  }
}

async function collectPdfExportOptions(){
  if (pdfExportModal) {
    const opts = await openPdfExportOptionsDialog()
    return opts ? normalizePdfExportOpts(opts) : null
  }

  // Fallback for environments where the modal markup is unavailable.
  const modeRaw = (prompt('PDF export mode: tiled or single', 'tiled') || 'tiled').trim().toLowerCase()
  const mode = modeRaw.startsWith('s') ? 'single' : 'tiled'

  const paperRaw = (prompt('Paper size (Letter or A4)', 'Letter') || 'Letter').trim().toUpperCase()
  const paper = (paperRaw === 'A4') ? 'A4' : 'LETTER'

  const orientRaw = (prompt('Orientation (auto / portrait / landscape)', 'auto') || 'auto').trim().toLowerCase()
  const orientation = orientRaw.startsWith('p') ? 'portrait' : orientRaw.startsWith('l') ? 'landscape' : 'auto'

  const sourceRaw = (prompt('Content area: map bounds or viewport', 'map bounds') || 'map bounds').trim().toLowerCase()
  const source = (sourceRaw.includes('view') || sourceRaw.includes('canvas')) ? 'viewport' : 'map'

  const paddingDefault = source === 'map' ? '1' : '0'
  const paddingSquares = Math.max(0, Number(prompt('Padding around export bounds (grid squares)', paddingDefault)) || 0)
  const marginIn = clampNum(Number(prompt('Margins (inches)', '0.25')) || 0.25, 0, 2)
  const rasterDpi = clampNum(Number(prompt('PDF raster DPI (higher = sharper/larger file)', '220')) || 220, 96, 600)

  if (mode === 'single'){
    return normalizePdfExportOpts({ mode, paper, orientation, source, paddingSquares, marginIn, rasterDpi })
  }

  const squareSizeIn = clampNum(Number(prompt('Square print size in inches (1.0 = standard battlemat)', '1.0')) || 1, 0.1, 5)
  const overlapSquares = Math.max(0, Math.floor(Number(prompt('Tile overlap (grid squares; keeps seams aligned)', '0')) || 0))
  const labels = promptYesNo('Add page labels (A1, A2, B1...)', true)
  const trimMarks = promptYesNo('Add cut/trim marks', true)
  const overview = promptYesNo('Add assembly overview page', true)
  const includeEmptyTiles = promptYesNo('Include effectively empty tiles', false)

  return normalizePdfExportOpts({
    mode, paper, orientation, source, paddingSquares, marginIn, rasterDpi,
    squareSizeIn, overlapSquares, labels, trimMarks, overview, includeEmptyTiles
  })
}

function getPaperPageInches(paperKey){
  if (paperKey === 'A4') return { w: mmToInches(210), h: mmToInches(297), format: 'a4' }
  return { w: 8.5, h: 11, format: 'letter' }
}

function choosePageLayoutForTiling(opts, mapSquares){
  const paper = getPaperPageInches(opts.paper)
  const overlap = Math.max(0, Math.floor(opts.overlapSquares || 0))
  const floorWithEpsilon = (value) => Math.floor((Number(value) || 0) + 1e-9)

  const candidates = []
  const orientations = opts.orientation === 'auto' ? ['portrait', 'landscape'] : [opts.orientation]

  for (const orientation of orientations){
    const pageIn = orientation === 'landscape' ? { w: paper.h, h: paper.w } : { w: paper.w, h: paper.h }
    const printable = { w: pageIn.w - 2*opts.marginIn, h: pageIn.h - 2*opts.marginIn }
    const capX = floorWithEpsilon(printable.w / opts.squareSizeIn)
    const capY = floorWithEpsilon(printable.h / opts.squareSizeIn)
    if (capX < 1 || capY < 1) continue
    const stepX = Math.max(1, capX - overlap)
    const stepY = Math.max(1, capY - overlap)
    const cols = (mapSquares.w <= capX) ? 1 : (1 + Math.ceil((mapSquares.w - capX) / stepX))
    const rows = (mapSquares.h <= capY) ? 1 : (1 + Math.ceil((mapSquares.h - capY) / stepY))
    candidates.push({
      orientation,
      paperFormat: paper.format,
      pageIn,
      printableIn: printable,
      capX, capY, stepX, stepY,
      cols, rows,
      pages: cols * rows
    })
  }

  if (!candidates.length) return null
  candidates.sort((a,b) => {
    if (a.pages !== b.pages) return a.pages - b.pages
    const aCap = a.capX * a.capY, bCap = b.capX * b.capY
    if (aCap !== bCap) return bCap - aCap
    return (b.printableIn.w*b.printableIn.h) - (a.printableIn.w*a.printableIn.h)
  })
  return candidates[0]
}

function buildTileGrid(bounds, layout){
  const g = Math.max(1, Number(dungeon.gridSize) || 32)
  const totalSqW = Math.max(1, Math.round((bounds.maxx - bounds.minx) / g))
  const totalSqH = Math.max(1, Math.round((bounds.maxy - bounds.miny) / g))
  const tiles = []

  for (let r=0; r<layout.rows; r++){
    for (let c=0; c<layout.cols; c++){
      const startSqX = c * layout.stepX
      const startSqY = r * layout.stepY
      const tileSqW = Math.max(0, Math.min(layout.capX, totalSqW - startSqX))
      const tileSqH = Math.max(0, Math.min(layout.capY, totalSqH - startSqY))
      if (tileSqW <= 0 || tileSqH <= 0) continue
      const minx = bounds.minx + startSqX * g
      const miny = bounds.miny + startSqY * g
      const maxx = minx + tileSqW * g
      const maxy = miny + tileSqH * g
      tiles.push({
        r, c,
        label: pageTileLabel(r,c),
        sqX: startSqX, sqY: startSqY,
        sqW: tileSqW, sqH: tileSqH,
        world: { minx, miny, maxx, maxy }
      })
    }
  }
  return { totalSqW, totalSqH, tiles }
}

function rectsIntersect(a, b){
  if (!a || !b) return false
  return a.minx < b.maxx && a.maxx > b.minx && a.miny < b.maxy && a.maxy > b.miny
}

function tileHasVisibleInterior(tileWorld, cache){
  if (!cache?.maskCanvas || !cache?.bounds || !rectsIntersect(tileWorld, cache.bounds)) return false
  const ppu = Number(cache.ppu) || 1
  const x0 = Math.max(0, Math.floor((tileWorld.minx - cache.bounds.minx) * ppu))
  const y0 = Math.max(0, Math.floor((tileWorld.miny - cache.bounds.miny) * ppu))
  const x1 = Math.min(cache.maskCanvas.width, Math.ceil((tileWorld.maxx - cache.bounds.minx) * ppu))
  const y1 = Math.min(cache.maskCanvas.height, Math.ceil((tileWorld.maxy - cache.bounds.miny) * ppu))
  const w = x1 - x0, h = y1 - y0
  if (w <= 0 || h <= 0) return false
  const mctx = cache.maskCanvas.getContext('2d', { willReadFrequently: true })
  const data = mctx.getImageData(x0, y0, w, h).data
  for (let i = 3; i < data.length; i += 4){
    if (data[i] > 8) return true
  }
  return false
}

function tileHasPlacedProp(tileWorld){
  if (!Array.isArray(placedProps) || placedProps.length === 0) return false
  for (const p of placedProps){
    if (!p) continue
    const b = getPropWorldAABB(p)
    if (rectsIntersect(tileWorld, b)) return true
  }
  return false
}

function tileHasPrintableContent(tileWorld, cache){
  return tileHasVisibleInterior(tileWorld, cache) || tileHasPlacedProp(tileWorld)
}

function renderTileCanvasForWorld(tileWorld, pxPerSquare){
  const g = Math.max(1, Number(dungeon.gridSize) || 32)
  const sqW = Math.max(1, Math.round((tileWorld.maxx - tileWorld.minx) / g))
  const sqH = Math.max(1, Math.round((tileWorld.maxy - tileWorld.miny) / g))
  const tilePxW = Math.max(64, Math.round(sqW * pxPerSquare))
  const tilePxH = Math.max(64, Math.round(sqH * pxPerSquare))
  const out = document.createElement('canvas')
  out.width = tilePxW
  out.height = tilePxH
  renderSceneToCanvasForBounds(out, tileWorld)
  return out
}

function drawPdfOverviewPage(pdf, pageMm, opts, layout, tileData, printedTileLabels = null){
  const margin = 12
  const headerY = 16
  const gridTop = 42
  const footerPad = 18
  const usableW = pageMm.w - margin*2
  const usableH = pageMm.h - gridTop - margin - footerPad
  const scale = Math.max(0.1, Math.min(usableW / layout.cols, usableH / layout.rows))
  const gridW = layout.cols * scale
  const gridH = layout.rows * scale
  const x0 = (pageMm.w - gridW) / 2
  const y0 = gridTop

  pdf.setFontSize(16)
  pdf.setTextColor(20,25,30)
  pdf.text('DelvSketch — Tiled PDF Assembly', margin, headerY)

  pdf.setFontSize(9)
  const meta1 = `Paper: ${opts.paper === 'A4' ? 'A4' : 'Letter'}  •  Orientation: ${layout.orientation}  •  Square size: ${opts.squareSizeIn.toFixed(2)} in`
  const printedCount = printedTileLabels ? tileData.tiles.filter(t => printedTileLabels.has(t.label)).length : tileData.tiles.length
  const skippedCount = Math.max(0, tileData.tiles.length - printedCount)
  const meta2 = `Pages: ${layout.rows} × ${layout.cols} = ${printedCount}${skippedCount ? ` printed (+${skippedCount} skipped empty)` : ''}  •  Tile overlap: ${opts.overlapSquares} square(s)`
  pdf.text(meta1, margin, headerY + 8)
  pdf.text(meta2, margin, headerY + 14)

  pdf.setDrawColor(120,120,120)
  pdf.setLineWidth(0.25)
  pdf.setFillColor(235,238,242)

  for (let r=0; r<layout.rows; r++){
    for (let c=0; c<layout.cols; c++){
      const x = x0 + c*scale
      const y = y0 + r*scale
      const label = pageTileLabel(r,c)
      const printed = !printedTileLabels || printedTileLabels.has(label)
      if (printed) {
        pdf.setFillColor(235,238,242)
        pdf.setTextColor(35,40,45)
      } else {
        pdf.setFillColor(246,246,247)
        pdf.setTextColor(160,165,172)
      }
      pdf.rect(x, y, scale, scale, 'FD')
      if (!printed) {
        pdf.setDrawColor(205,208,212)
        pdf.setLineWidth(0.2)
        pdf.line(x+1, y+1, x+scale-1, y+scale-1)
        pdf.line(x+scale-1, y+1, x+1, y+scale-1)
        pdf.setDrawColor(120,120,120)
        pdf.setLineWidth(0.25)
      }
      pdf.setFontSize(Math.max(7, Math.min(14, scale * 0.35)))
      pdf.text(label, x + scale/2, y + scale/2 + 1.5, { align: 'center' })
    }
  }

  pdf.setDrawColor(80,80,80)
  pdf.setLineWidth(0.5)
  pdf.rect(x0, y0, gridW, gridH)

  pdf.setFontSize(8)
  pdf.setTextColor(80,80,80)
  const footerMsg = opts.includeEmptyTiles
    ? 'Print at 100% / Actual Size (disable "Fit to page") for accurate square sizing.'
    : 'Print at 100% / Actual Size. Empty tiles are skipped unless enabled in PDF settings.'
  pdf.text(footerMsg, margin, pageMm.h - 8)
}

async function exportSinglePagePDFWithOptions(jsPDF, opts){
  await showExportProgressAndYield('PDF Export', 'Preparing single-page PDF…', 10, '')
  const bounds = getExportWorldBounds({ source: opts.source === 'viewport' ? 'viewport' : 'map', paddingSquares: opts.paddingSquares })
  if (!bounds){
    alert('Draw something first.')
    return
  }

  const paper = getPaperPageInches(opts.paper)
  const orientations = opts.orientation === 'auto' ? ['portrait', 'landscape'] : [opts.orientation]
  let best = null
  const worldW = bounds.maxx - bounds.minx
  const worldH = bounds.maxy - bounds.miny
  for (const orientation of orientations){
    const pageIn = orientation === 'landscape' ? { w: paper.h, h: paper.w } : { w: paper.w, h: paper.h }
    const printableIn = { w: pageIn.w - 2*opts.marginIn, h: pageIn.h - 2*opts.marginIn }
    if (printableIn.w <= 0 || printableIn.h <= 0) continue
    const fitScale = Math.min(printableIn.w / worldW, printableIn.h / worldH)
    if (!best || fitScale > best.fitScale) best = { orientation, pageIn, printableIn, fitScale }
  }
  if (!best) throw new Error('Margins too large for selected paper size')

  const pageMm = { w: inchesToMm(best.pageIn.w), h: inchesToMm(best.pageIn.h) }
  const marginMm = inchesToMm(opts.marginIn)
  const targetMmW = worldW * best.fitScale * 25.4
  const targetMmH = worldH * best.fitScale * 25.4
  const xMm = marginMm + (inchesToMm(best.printableIn.w) - targetMmW) * 0.5
  const yMm = marginMm + (inchesToMm(best.printableIn.h) - targetMmH) * 0.5

  const pxW = Math.max(800, Math.round((targetMmW / 25.4) * opts.rasterDpi))
  const pxH = Math.max(800, Math.round((targetMmH / 25.4) * opts.rasterDpi))
  await updateExportProgressAndYield('Rendering page image…', 45, `${pxW} × ${pxH} px`)
  const out = document.createElement('canvas')
  out.width = pxW
  out.height = pxH
  renderSceneToCanvasForBounds(out, bounds)

  await updateExportProgressAndYield('Building PDF file…', 78, `${opts.paper} ${best.orientation}`)
  const pdf = new jsPDF({
    orientation: best.orientation,
    unit: 'mm',
    format: paper.format,
    compress: true
  })
  pdf.addImage(out.toDataURL('image/png'), 'PNG', xMm, yMm, targetMmW, targetMmH, undefined, 'FAST')
  pdf.setFontSize(9)
  pdf.setTextColor(80,80,80)
  pdf.text('Single-page export (fit to page).', marginMm, pageMm.h - Math.max(4, marginMm * 0.5))
  await updateExportProgressAndYield('Saving PDF…', 100, 'dungeon-map-single-page.pdf')
  pdf.save('dungeon-map-single-page.pdf')
}


async function exportTiledScalePDFWithOptions(jsPDF, opts){
  await showExportProgressAndYield('PDF Export', 'Preparing tiled PDF…', 10, '')
  const bounds = getExportWorldBounds({ source: opts.source === 'viewport' ? 'viewport' : 'map', paddingSquares: opts.paddingSquares })
  if (!bounds){
    alert('Draw something first.')
    return
  }

  const g = Math.max(1, Number(dungeon.gridSize) || 32)
  const mapSquares = {
    w: Math.max(1, Math.round((bounds.maxx - bounds.minx) / g)),
    h: Math.max(1, Math.round((bounds.maxy - bounds.miny) / g))
  }

  const layout = choosePageLayoutForTiling(opts, mapSquares)
  if (!layout) {
    alert(`Square size (${opts.squareSizeIn.toFixed(2)} in) is too large for the chosen paper + margins.`)
    return
  }

  const tileData = buildTileGrid(bounds, layout)
  let tilesToPrint = tileData.tiles
  if (!opts.includeEmptyTiles) {
    const cache = ensureCompiled()
    tilesToPrint = tileData.tiles.filter(tile => tileHasPrintableContent(tile.world, cache))
  }
  if (!tilesToPrint.length) {
    alert('No printable tiles found in the selected export area. Try enabling “Include effectively empty pages” or adjusting bounds.')
    return
  }
  const printedTileLabels = new Set(tilesToPrint.map(t => t.label))

  const pageMm = { w: inchesToMm(layout.pageIn.w), h: inchesToMm(layout.pageIn.h) }
  const marginMm = inchesToMm(opts.marginIn)
  const pxPerSquare = clampNum(Math.round(opts.rasterDpi * opts.squareSizeIn), 24, 2400)

  await updateExportProgressAndYield('Preparing tiled PDF…', 10, `${tilesToPrint.length} tile page(s)`)
  const pdf = new jsPDF({
    orientation: layout.orientation,
    unit: 'mm',
    format: layout.paperFormat,
    compress: true
  })
  let writtenPages = 0
  const startPage = () => { if (writtenPages > 0) pdf.addPage(); writtenPages++ }

  if (opts.overview){
    await updateExportProgressAndYield('Rendering overview page…', 16, `1 + ${tilesToPrint.length} tile page(s)`)
    startPage()
    drawPdfOverviewPage(pdf, pageMm, opts, layout, tileData, printedTileLabels)
  }

  for (let i = 0; i < tilesToPrint.length; i++){
    const pctBase = opts.overview ? 20 : 14
    const pct = pctBase + (i / Math.max(1, tilesToPrint.length)) * 72
    await updateExportProgressAndYield(`Rendering tile ${i+1}/${tilesToPrint.length}…`, pct, tilesToPrint[i]?.label || '')
    const tile = tilesToPrint[i]
    startPage()

    const tileCanvas = renderTileCanvasForWorld(tile.world, pxPerSquare)
    const tileMmW = inchesToMm(tile.sqW * opts.squareSizeIn)
    const tileMmH = inchesToMm(tile.sqH * opts.squareSizeIn)
    const imgX = marginMm
    const imgY = marginMm

    pdf.addImage(tileCanvas.toDataURL('image/png'), 'PNG', imgX, imgY, tileMmW, tileMmH, undefined, 'FAST')

    if (opts.trimMarks) drawPdfTrimMarks(pdf, pageMm, { x: imgX, y: imgY, w: tileMmW, h: tileMmH })

    if (opts.labels){
      pdf.setFontSize(10)
      pdf.setTextColor(20,25,30)
      const topLabel = `${tile.label}  (${tile.r + 1},${tile.c + 1})`
      pdf.text(topLabel, pageMm.w - marginMm, Math.max(6, marginMm * 0.7), { align: 'right' })
      pdf.setFontSize(8)
      pdf.setTextColor(90,90,90)
      pdf.text(
        `Tile ${i+1}/${tilesToPrint.length} • ${tile.sqW}×${tile.sqH} squares • scale ${opts.squareSizeIn.toFixed(2)} in/square`,
        marginMm,
        pageMm.h - Math.max(4, marginMm * 0.55)
      )
    }
  }

  const sqLabel = String(opts.squareSizeIn).replace(/\./g, '_')
  await updateExportProgressAndYield('Saving PDF…', 100, `dungeon-map-tiled-${sqLabel}in.pdf`)
  pdf.save(`dungeon-map-tiled-${sqLabel}in.pdf`)
}

async function exportMultipagePDF(){
  const cache = ensureCompiled()
  const hasMap = cache && (Array.isArray(dungeon.spaces) || Array.isArray(dungeon.paths) || Array.isArray(dungeon.shapes))
  if (!hasMap) {
    // still allow viewport exports if props-only, but keep quick guard friendly
  }

  let startedProgress = false
  try {
    const opts = await collectPdfExportOptions()
    if (!opts) return

    await showExportProgressAndYield('PDF Export', 'Loading PDF engine…', 4, '')
    startedProgress = true
    const jsPDF = await ensureJsPDF()

    if (opts.mode === 'single') return await exportSinglePagePDFWithOptions(jsPDF, opts)
    return await exportTiledScalePDFWithOptions(jsPDF, opts)
  } finally {
    if (startedProgress) setTimeout(hideExportProgress, 160)
  }
}

// drafting states
let draft = null          // {type:'path', points:[]}
let draftRect = null      // {a,b}
let freeDraw = null       // [{x,y}...]
let lineDraw = null       // { points:[{x,y}...], dashed }
let draftShape = null     // {center, radius, rotation, sides}
let draftArc = null       // {stage, center, radius, startAngle, endAngle, sweepAccum, lastRawAngle, previewAngle, dragPointerId}
let selectedShapeId = null
let shapeDrag = null      // {mode:'move'|'handle', id, startWorld, startCenter, startRadius, startRot}
let eraseStroke = null     // {cells: Map<key,{gx,gy}>}
normalizeEditSequences()

function finishTool(){
  if (tool === "path" || tool === "poly") {
    if (draft && draft.type === "path" && draft.points.length>=2) {
      commitDraftPath(draft.points, currentPathShapeSettings())
      draft = null
    }
  }
  // poly tool doesn't need finish (created on drag), but keep for symmetry
}

function normalizeAngle(angle){
  let a = Number(angle) || 0
  while (a <= -Math.PI) a += Math.PI * 2
  while (a > Math.PI) a -= Math.PI * 2
  return a
}
function angleFromCenter(center, point){
  return Math.atan2((point.y - center.y), (point.x - center.x))
}
function distanceToArcCircumference(arc, world){
  if (!arc || !world) return Infinity
  return Math.abs(Math.hypot(world.x - arc.center.x, world.y - arc.center.y) - arc.radius)
}
function getArcPreviewData(arc){
  if (!arc) return null
  const radius = Math.max(subGrid(), Number(arc.radius) || 0)
  const startAngle = Number.isFinite(Number(arc.startAngle)) ? Number(arc.startAngle) : 0
  const sweepAccum = Number.isFinite(Number(arc.sweepAccum)) ? Number(arc.sweepAccum) : 0
  const fullCircleThreshold = Math.PI * 1.92
  const isCircle = arc.stage === "end" && Math.abs(sweepAccum) >= fullCircleThreshold
  const sweep = isCircle ? (sweepAccum >= 0 ? Math.PI * 2 : -Math.PI * 2) : sweepAccum
  const endAngle = Number.isFinite(Number(arc.endAngle)) ? Number(arc.endAngle) : (startAngle + sweep)
  return { center: arc.center, radius, startAngle, endAngle: isCircle ? (startAngle + sweep) : endAngle, sweep, isCircle }
}
function sampleArcPoints(center, radius, startAngle, endAngle, { closeLoop=false } = {}){
  const r = Math.max(subGrid(), Number(radius) || 0)
  const sweep = endAngle - startAngle
  const arcLen = Math.max(r * Math.abs(sweep), r * 0.5)
  const targetChord = Math.max(subGrid() * 0.8, 10)
  let segments = Math.max(12, Math.ceil(arcLen / targetChord))
  if (closeLoop) segments = Math.max(24, segments)
  segments = Math.min(180, segments)
  const pts = []
  for (let i=0;i<=segments;i++) {
    const t = i / segments
    const a = startAngle + sweep * t
    pts.push({ x: center.x + Math.cos(a) * r, y: center.y + Math.sin(a) * r })
  }
  if (closeLoop && pts.length) pts.push({ ...pts[0] })
  return pts
}
function commitDraftArc(arc){
  const preview = getArcPreviewData(arc)
  if (!preview || !preview.center) return false
  if (preview.radius < subGrid() * 0.75) return false
  if (!preview.isCircle && Math.abs(preview.sweep) < (Math.PI / 18)) return false
  const pts = sampleArcPoints(preview.center, preview.radius, preview.startAngle, preview.endAngle, { closeLoop: preview.isCircle })
  if (!Array.isArray(pts) || pts.length < 2) return false
  commitDraftPath(pts, { source: "arc", closed: !!preview.isCircle })
  return true
}

function simplifyFree(points, minDist=7){
  if(points.length<3) return points
  const out=[points[0]]
  for (let i=1;i<points.length;i++){
    if (dist(points[i], out[out.length-1]) >= minDist) out.push(points[i])
  }
  return out
}

function subGrid(){ return dungeon.gridSize / (dungeon.subSnapDiv || 4) }
function currentDrawMode(){ return underMode ? "subtract" : "add" }
function currentCorridorWidth(){ return Math.max(12, Number(dungeon.style?.corridorWidth || 48) || 48) }
function currentPathShapeSettings(){ return getDefaultPathShapeSettings(dungeon.style || {}) }
function currentLineBaseWorldWidth(){
  const fallbackRipplePx = Math.max(1, Number(dungeon.style?.water?.ripplePx || 7) || 7)
  const fallbackPpu = Math.max(1, Number(compiledCache?.ppu || 4) || 4)
  return Math.max(0.5, Number(dungeon.style?.lines?.width || (fallbackRipplePx / fallbackPpu)) || (fallbackRipplePx / fallbackPpu))
}
function currentLineWorldWidth(mode = currentDrawMode()){
  return mode === "subtract" ? currentCorridorWidth() : currentLineBaseWorldWidth()
}
function currentLineDashWorld(){
  const fallbackPpu = Math.max(1, Number(compiledCache?.ppu || 4) || 4)
  return Math.max(1, Number(dungeon.style?.lines?.dashPx || 18) || 18) / fallbackPpu
}
function lineStrokeBounds(line){
  if (!line || !Array.isArray(line.points) || !line.points.length) return null
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity
  for (const pt of line.points){
    const x = Number(pt?.x), y = Number(pt?.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    if (x < minx) minx = x
    if (y < miny) miny = y
    if (x > maxx) maxx = x
    if (y > maxy) maxy = y
  }
  if (!Number.isFinite(minx) || !Number.isFinite(miny) || !Number.isFinite(maxx) || !Number.isFinite(maxy)) return null
  const pad = Math.max(1, Number(line.width || currentLineWorldWidth()) || 1) * 0.5 + subGrid() * 0.25
  return { minx:minx-pad, miny:miny-pad, maxx:maxx+pad, maxy:maxy+pad }
}
function commitLineStroke(points, extra = {}){
  if (!Array.isArray(points) || points.length < 2) return false
  pushUndo()
  if (!Array.isArray(dungeon.lines)) dungeon.lines = []
  dungeon.lines.push({ id: crypto.randomUUID(), seq: nextEditSeq(), mode: currentDrawMode(), width: currentLineWorldWidth(), dashed: dungeon.style?.lines?.dashed === true, points, ...extra })
  bumpLineVersion()
  return true
}
function drawLineStrokePath(context, cam, points){
  if (!Array.isArray(points) || points.length < 2) return false
  context.beginPath()
  points.forEach((p,i)=>{
    const s = cam.worldToScreen(p)
    if (i===0) context.moveTo(s.x, s.y)
    else context.lineTo(s.x, s.y)
  })
  return true
}
function drawLinesTo(targetCtx, cam){
  if (!Array.isArray(dungeon.lines) || !dungeon.lines.length) return
  const liveCanvasCtx = targetCtx === ctx
  const logicalW = liveCanvasCtx ? Math.max(1, W|0) : Math.max(1, targetCtx.canvas.width|0)
  const logicalH = liveCanvasCtx ? Math.max(1, H|0) : Math.max(1, targetCtx.canvas.height|0)
  const layer = document.createElement("canvas")
  layer.width = logicalW
  layer.height = logicalH
  const lctx = layer.getContext("2d", { alpha:true })
  lctx.clearRect(0,0,logicalW,logicalH)
  lctx.lineCap = "round"
  lctx.lineJoin = "round"
  lctx.strokeStyle = dungeon.style?.lines?.color || dungeon.style?.water?.rippleColor || "#1f2933"
  const ops = dungeon.lines.slice().sort((a,b)=> Number(a?.seq || 0) - Number(b?.seq || 0))
  for (const line of ops){
    if (!Array.isArray(line?.points) || line.points.length < 2) continue
    lctx.save()
    lctx.globalCompositeOperation = (line.mode === "subtract") ? "destination-out" : "source-over"
    lctx.setLineDash(line.dashed ? [Math.max(2, currentLineDashWorld() * cam.zoom), Math.max(2, currentLineDashWorld() * cam.zoom)] : [])
    lctx.lineWidth = Math.max(1, Number(line.width || currentLineWorldWidth()) * cam.zoom)
    drawLineStrokePath(lctx, cam, line.points)
    lctx.stroke()
    lctx.restore()
  }
  if (liveCanvasCtx) targetCtx.drawImage(layer, 0, 0, logicalW, logicalH)
  else targetCtx.drawImage(layer, 0, 0)
}
function commitDraftPath(points, extra = {}){
  if (!Array.isArray(points) || points.length < 2) return false
  pushUndo()
  const shapeSettings = normalizePathShapeSettings(extra, dungeon.style || {})
  dungeon.paths.push({
    id: crypto.randomUUID(),
    seq: nextEditSeq(),
    mode: currentDrawMode(),
    width: currentCorridorWidth(),
    points,
    shapeMode: shapeSettings.shapeMode,
    smoothness: shapeSettings.smoothness,
    amplitude: shapeSettings.amplitude,
    frequency: shapeSettings.frequency,
    ...extra
  })
  bumpInteriorVersion()
  return true
}
function updateDraftArcSweepToWorld(arc, world){
  if (!arc || arc.stage !== "end" || !world) return
  const rawAngle = angleFromCenter(arc.center, world)
  const last = Number.isFinite(Number(arc.lastRawAngle)) ? arc.lastRawAngle : rawAngle
  arc.sweepAccum += normalizeAngle(rawAngle - last)
  arc.lastRawAngle = rawAngle
  arc.endAngle = arc.startAngle + arc.sweepAccum
  arc.previewAngle = rawAngle
}

function rectPolyKey(poly){
  if (!Array.isArray(poly) || poly.length !== 4) return null
  const xs = poly.map(p => Number(p.x))
  const ys = poly.map(p => Number(p.y))
  if (xs.some(v=>!Number.isFinite(v)) || ys.some(v=>!Number.isFinite(v))) return null
  const minx = Math.min(...xs), maxx = Math.max(...xs)
  const miny = Math.min(...ys), maxy = Math.max(...ys)
  const corners = new Set([`${minx},${miny}`,`${maxx},${miny}`,`${maxx},${maxy}`,`${minx},${maxy}`])
  const pts = new Set(poly.map(p => `${Number(p.x)},${Number(p.y)}`))
  if (pts.size !== 4 || corners.size !== 4) return null
  for (const c of corners) if (!pts.has(c)) return null
  return `${minx},${miny},${maxx},${maxy}`
}

function commitSpacePolygon(poly, mode=currentDrawMode()){
  const key = rectPolyKey(poly)
  if (!key){
    dungeon.spaces.push({ id: crypto.randomUUID(), seq: nextEditSeq(), mode, polygon: poly })
    bumpInteriorVersion()
    return true
  }
  for (let i=dungeon.spaces.length-1; i>=0; i--){
    const s = dungeon.spaces[i]
    const sk = rectPolyKey(s && s.polygon)
    if (sk !== key) continue
    if ((s.mode || "add") === mode){
      // exact duplicate rectangle in same mode -> ignore
      return false
    }
    // exact opposite rectangle exists -> latest action wins (replace prior)
    dungeon.spaces.splice(i, 1)
    dungeon.spaces.push({ id: crypto.randomUUID(), seq: nextEditSeq(), mode, polygon: poly })
    bumpInteriorVersion()
    return true
  }
  dungeon.spaces.push({ id: crypto.randomUUID(), seq: nextEditSeq(), mode, polygon: poly })
  return true
}

function getCellAt(world){
  const g = subGrid()
  return { gx: Math.floor(world.x / g), gy: Math.floor(world.y / g) }
}
function cellKey(gx, gy){ return `${gx},${gy}` }
function cellRectFromGrid(gx, gy){
  const g = subGrid()
  const x = gx * g, y = gy * g
  return [{x,y},{x:x+g,y},{x:x+g,y:y+g},{x,y:y+g}]
}
function addEraseCell(erase, gx, gy){
  const key = cellKey(gx, gy)
  if (!erase.cells.has(key)) erase.cells.set(key, { gx, gy })
}
function addEraseLine(erase, aCell, bCell){
  const dx = bCell.gx - aCell.gx
  const dy = bCell.gy - aCell.gy
  const steps = Math.max(Math.abs(dx), Math.abs(dy), 1)
  for (let i=0;i<=steps;i++){
    const t = i / steps
    const gx = Math.round(aCell.gx + dx * t)
    const gy = Math.round(aCell.gy + dy * t)
    addEraseCell(erase, gx, gy)
  }
}
function rebuildEraseRect(erase, aCell, bCell){
  if (!erase || !aCell || !bCell) return
  erase.cells.clear()
  const minGX = Math.min(aCell.gx, bCell.gx)
  const maxGX = Math.max(aCell.gx, bCell.gx)
  const minGY = Math.min(aCell.gy, bCell.gy)
  const maxGY = Math.max(aCell.gy, bCell.gy)
  for (let gx = minGX; gx <= maxGX; gx++){
    for (let gy = minGY; gy <= maxGY; gy++){
      addEraseCell(erase, gx, gy)
    }
  }
}

function getPointerPos(e){
  const r = canvas.getBoundingClientRect()
  const sx = (r.width > 0 ? (W / r.width) : 1)
  const sy = (r.height > 0 ? (H / r.height) : 1)
  if (typeof e.clientX === "number" && typeof e.clientY === "number"){
    return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy }
  }
  if (typeof e.offsetX === "number" && typeof e.offsetY === "number"){
    return { x: e.offsetX * sx, y: e.offsetY * sy }
  }
  return { x: lastCursorScreen.x, y: lastCursorScreen.y }
}

function pointInsideCanvasClient(clientX, clientY){
  const r = canvas.getBoundingClientRect()
  return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom
}

function getDraggedPropIdFromEvent(e){
  try {
    return (e.dataTransfer && (e.dataTransfer.getData("application/x-dungeon-prop-id") || e.dataTransfer.getData("text/plain"))) || dragPropId || null
  } catch {
    return dragPropId || null
  }
}

function maybeHandlePropDrop(e){
  const pid = getDraggedPropIdFromEvent(e)
  if (!pid) return false
  if (typeof e.clientX === 'number' && typeof e.clientY === 'number' && !pointInsideCanvasClient(e.clientX, e.clientY)) return false
  e.preventDefault()
  const pos = getPointerPos(e)
  if (placePropAtScreenById(pid, pos)) {
    // Drag/drop is one-shot: clear transient drag/arm state and return to Select.
    dragPropId = null
    armedPropId = null
    setTool("select")
    renderPropsShelf()
    try { canvas.focus && canvas.focus() } catch {}
    return true
  }
  return false
}

function getImageFilesFromDataTransfer(dt){
  if (!dt) return []
  const out = []
  try {
    if (dt.items && dt.items.length){
      for (const item of Array.from(dt.items)){
        if (!item) continue
        const kind = String(item.kind || '').toLowerCase()
        const type = String(item.type || '').toLowerCase()
        if (kind !== 'file') continue
        if (type && !type.startsWith('image/')) continue
        const file = item.getAsFile ? item.getAsFile() : null
        if (file && fileLooksLikeSupportedImage(file)) out.push(file)
      }
    }
  } catch {}
  if (!out.length) {
    try {
      for (const file of Array.from(dt.files || [])){
        if (fileLooksLikeSupportedImage(file)) out.push(file)
      }
    } catch {}
  }
  const seen = new Set()
  return out.filter(file => {
    const key = [file.name, file.size, file.lastModified, file.type].join('::')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
function eventHasExternalImageFiles(e){
  const dt = e && e.dataTransfer
  if (!dt) return false
  if (getImageFilesFromDataTransfer(dt).length) return true
  try {
    const types = Array.from(dt.types || []).map(v => String(v).toLowerCase())
    return types.includes('files') || types.includes('application/x-moz-file')
  } catch { return false }
}
async function maybeHandleExternalImageDrop(e){
  if (!eventHasExternalImageFiles(e)) return false
  if (typeof e.clientX === 'number' && typeof e.clientY === 'number' && !pointInsideCanvasClient(e.clientX, e.clientY)) return false
  e.preventDefault()
  e.stopPropagation()
  const files = getImageFilesFromDataTransfer(e.dataTransfer)
  if (!files.length) return false
  const pos = getPointerPos(e)
  const added = await appendImportedPropsFromFiles(files)
  if (!added.length) return false
  const gridStep = Math.max(10, Number(dungeon.gridSize) || 32)
  let placedAny = false
  added.forEach((prop, i) => {
    const screen = { x: pos.x + i * Math.min(24, gridStep * 0.4), y: pos.y + i * Math.min(24, gridStep * 0.4) }
    if (placePropAtScreenById(prop.id, screen)) placedAny = true
  })
  if (placedAny) {
    dragPropId = null
    armedPropId = null
    setTool("select")
    try { canvas.focus && canvas.focus() } catch {}
    return true
  }
  return false
}

function zoomAt(screenPt, factor){
  const sp = (screenPt && Number.isFinite(screenPt.x) && Number.isFinite(screenPt.y))
    ? screenPt
    : { x: W * 0.5, y: H * 0.5 }
  const before = camera.screenToWorld(sp)
  camera.zoom = camera.clampZoom(camera.zoom * factor)
  const after = camera.screenToWorld(sp)
  // Keep the world point under the cursor fixed after zooming.
  camera.x += after.x - before.x
  camera.y += after.y - before.y
}

// Navigation
const pointers = new Map()
let gesture=null
let panDrag=null
let lastCursorScreen = { x: 0, y: 0 }
window.addEventListener("pointermove", (e)=>{
  if (typeof e.clientX !== "number" || typeof e.clientY !== "number") return
  if (!pointInsideCanvasClient(e.clientX, e.clientY)) return
  lastCursorScreen = getPointerPos(e)
  if (tool === "arc" && draftArc && draftArc.stage === "end") {
    const hoverWorld = camera.screenToWorld(lastCursorScreen)
    updateDraftArcSweepToWorld(draftArc, hoverWorld)
  }
})

let propContextMenuEl = null
let propContextMenuTargetId = null
function ensurePropContextMenu(){
  if (propContextMenuEl) return propContextMenuEl
  const m = document.createElement('div')
  m.id = 'prop-context-menu'
  m.setAttribute('role', 'menu')
  m.setAttribute('aria-hidden', 'true')
  m.style.position = 'fixed'
  m.style.zIndex = '9999'
  m.style.minWidth = '190px'
  m.style.background = 'rgba(255,255,255,0.98)'
  m.style.border = '1px solid rgba(15,23,42,0.12)'
  m.style.borderRadius = '12px'
  m.style.boxShadow = '0 12px 30px rgba(15,23,42,0.16)'
  m.style.padding = '6px'
  m.style.display = 'none'
  m.style.backdropFilter = 'blur(8px)'
  const mkBtn = (action, label)=>{
    const b = document.createElement('button')
    b.type = 'button'
    b.dataset.action = action
    b.setAttribute('role', 'menuitem')
    b.style.display = 'block'
    b.style.width = '100%'
    b.style.textAlign = 'left'
    b.style.background = 'transparent'
    b.style.color = '#111827'
    b.style.border = '0'
    b.style.borderRadius = '8px'
    b.style.padding = '9px 10px'
    b.style.cursor = 'pointer'
    b.style.font = '500 13px system-ui, sans-serif'
    b.textContent = label
    b.addEventListener('mouseenter', ()=>{ b.style.background = 'rgba(15,23,42,0.06)' })
    b.addEventListener('mouseleave', ()=>{ b.style.background = 'transparent' })
    return b
  }
  m.appendChild(mkBtn('flip-h', 'Flip Horizontally'))
  m.appendChild(mkBtn('flip-v', 'Flip Vertically'))
  const sep = document.createElement('div')
  sep.style.height = '1px'
  sep.style.margin = '6px 4px'
  sep.style.background = 'rgba(15,23,42,0.08)'
  m.appendChild(sep)
  m.appendChild(mkBtn('toggle-shadow', 'Disable Shadow'))
  m.addEventListener('contextmenu', (e)=> e.preventDefault())
  m.addEventListener('click', (e)=>{
    const btn = e.target && e.target.closest ? e.target.closest('button[data-action]') : null
    if (!btn) return
    const p = getPlacedPropById(propContextMenuTargetId || selectedPropId)
    if (!p) { hidePropContextMenu(); return }
    pushUndo()
    if (btn.dataset.action === 'flip-h') p.flipX = !(p.flipX === true)
    else if (btn.dataset.action === 'flip-v') p.flipY = !(p.flipY === true)
    else if (btn.dataset.action === 'toggle-shadow') p.shadowDisabled = !(p.shadowDisabled === true)
    hidePropContextMenu()
  })
  document.body.appendChild(m)
  propContextMenuEl = m
  return m
}
function hidePropContextMenu(){
  if (!propContextMenuEl) return
  propContextMenuEl.style.display = 'none'
  propContextMenuEl.setAttribute('aria-hidden', 'true')
  propContextMenuTargetId = null
}
function showPropContextMenuForProp(prop, clientX, clientY){
  if (!prop) return false
  const m = ensurePropContextMenu()
  propContextMenuTargetId = prop.id
  const shadowBtn = m.querySelector('button[data-action="toggle-shadow"]')
  if (shadowBtn) shadowBtn.textContent = (prop.shadowDisabled === true) ? 'Enable Shadow' : 'Disable Shadow'
  m.style.display = 'block'
  m.setAttribute('aria-hidden', 'false')
  const pad = 8
  const r = m.getBoundingClientRect()
  let x = Math.round(clientX), y = Math.round(clientY)
  if (x + r.width > window.innerWidth - pad) x = Math.max(pad, window.innerWidth - pad - r.width)
  if (y + r.height > window.innerHeight - pad) y = Math.max(pad, window.innerHeight - pad - r.height)
  m.style.left = x + 'px'
  m.style.top = y + 'px'
  return true
}
window.addEventListener('pointerdown', (e)=>{
  if (!propContextMenuEl || propContextMenuEl.style.display === 'none') return
  if (propContextMenuEl.contains(e.target)) return
  hidePropContextMenu()
}, true)
window.addEventListener('keydown', (e)=>{ if (e.key === 'Escape') hidePropContextMenu() })

canvas.addEventListener("contextmenu", (e)=>{
  e.preventDefault()
  const screen = getPointerPos(e)
  const world = camera.screenToWorld(screen)

  if (textEditorState && textEditOverlay && !textEditOverlay.contains(e.target)) {
    commitActiveTextEditor()
  }
  const picked = pickPlacedPropAtWorld(world)
  if (!picked) { hidePropContextMenu(); return }
  selectedPropId = picked.id
  selectedTextId = null
  propTransformDrag = null
  syncTextPanelVisibility()
  showPropContextMenuForProp(picked, e.clientX, e.clientY)
})
function shouldInterceptAnyDropEvent(e){
  return !!getDraggedPropIdFromEvent(e) || eventHasExternalImageFiles(e)
}
function handleGlobalDragOver(e){
  if (!shouldInterceptAnyDropEvent(e)) return
  e.preventDefault()
  try { if (e.dataTransfer) e.dataTransfer.dropEffect = "copy" } catch {}
}
async function handleGlobalDrop(e){
  if (!shouldInterceptAnyDropEvent(e)) return
  // Let the canvas-specific drop handler own drops that land on the canvas.
  // The document capture-phase drop listener fires before the canvas listener,
  // which can otherwise place the same prop twice for a single drag/drop.
  if (typeof e.clientX === 'number' && typeof e.clientY === 'number' && pointInsideCanvasClient(e.clientX, e.clientY)) return
  e.preventDefault()
  if (await maybeHandleExternalImageDrop(e)) return
  maybeHandlePropDrop(e)
}

document.addEventListener("dragenter", handleGlobalDragOver, true)
document.addEventListener("dragover", handleGlobalDragOver, true)
document.addEventListener("drop", handleGlobalDrop, true)

canvas.addEventListener("dragover", (e)=>{
  if (!shouldInterceptAnyDropEvent(e)) return
  e.preventDefault()
  try { if (e.dataTransfer) e.dataTransfer.dropEffect = "copy" } catch {}
})
canvas.addEventListener("drop", async (e)=>{
  // Prevent the document/window fallback drop handler from also placing a prop.
  e.stopPropagation()
  if (await maybeHandleExternalImageDrop(e)) return
  maybeHandlePropDrop(e)
})
// Fallback: if the drag lands on a non-canvas overlay element, still place onto the canvas at cursor position.
window.addEventListener("dragover", (e)=>{
  if (!shouldInterceptAnyDropEvent(e)) return
  if (typeof e.clientX === 'number' && typeof e.clientY === 'number' && pointInsideCanvasClient(e.clientX, e.clientY)) {
    e.preventDefault()
    try { if (e.dataTransfer) e.dataTransfer.dropEffect = "copy" } catch {}
  }
})
window.addEventListener("drop", async (e)=>{
  if (e.defaultPrevented) return
  if (await maybeHandleExternalImageDrop(e)) return
  maybeHandlePropDrop(e)
})
canvas.addEventListener("wheel", (e)=>{
  e.preventDefault()
  const sp = getPointerPos(e)
  lastCursorScreen = sp
  const isZoom = e.ctrlKey || e.metaKey || e.altKey
  if (isZoom) {
    zoomAt(sp, Math.exp(-e.deltaY * 0.0015))
  } else {
    camera.x -= e.deltaX / camera.zoom
    camera.y -= e.deltaY / camera.zoom
  }
},{passive:false})

window.addEventListener("keydown", (e)=>{
  if (textEditorState && e.key === "Escape") { e.preventDefault(); cancelActiveTextEditor(); return }
  const tag = (document.activeElement && document.activeElement.tagName || "").toLowerCase()
  const activeEditable = !!(document.activeElement && document.activeElement.isContentEditable)
  const accel = e.metaKey || e.ctrlKey
  if (accel && !e.altKey){
    const k = (e.key || "").toLowerCase()
    if (k === "z" && e.shiftKey){ e.preventDefault(); redo(); return }
    if (k === "z"){ e.preventDefault(); undo(); return }
    if (k === "y"){ e.preventDefault(); redo(); return }
    if ((k === "c" || k === "x" || k === "v") && (tag === "input" || tag === "textarea" || (document.activeElement && document.activeElement.isContentEditable))) return
    if (k === "c" && selectedPropId){
      e.preventDefault()
      copySelectedPropToClipboard()
      return
    }
    if (k === "v"){
      if (propClipboard && propClipboard.prop){
        e.preventDefault()
        pushUndo()
        pastePropFromClipboard()
        return
      }
    }
    if (k === "d" && selectedPropId){
      e.preventDefault()
      pushUndo()
      const step = Math.max(4, subGrid ? subGrid() : ((dungeon.gridSize || 32) / 2))
      duplicatePlacedPropById(selectedPropId, { dx: step, dy: step })
      return
    }
  }
  if (tag === "input" || tag === "textarea" || activeEditable) return
  if ((e.key === "t" || e.key === "T") && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); setTool("text") ; return }
  if ((e.key === "a" || e.key === "A") && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); setTool("arc") ; return }
  if (e.key === "Enter" && selectedTextId) { e.preventDefault(); if (!textEditorState) { pushUndo(); openTextEditorFor(selectedTextId, { isNew:false, undoPushed:true }) } return }
  if ((e.key === "Delete" || e.key === "Backspace") && selectedPropId){
    const idx = placedProps.findIndex(p => p && p.id === selectedPropId)
    if (idx >= 0){
      e.preventDefault()
      pushUndo()
      placedProps.splice(idx, 1)
      selectedPropId = null
      return
    }
  }
  if ((e.key === "Delete" || e.key === "Backspace") && selectedTextId){
    const idx = placedTexts.findIndex(t => t && t.id === selectedTextId)
    if (idx >= 0){
      e.preventDefault()
      pushUndo()
      placedTexts.splice(idx, 1)
      selectedTextId = null
      syncTextPanelVisibility()
      return
    }
  }
  if ((e.key === "Delete" || e.key === "Backspace") && selectedShapeId){
    const idx = dungeon.shapes.findIndex(sh => sh && sh.id === selectedShapeId)
    if (idx >= 0){
      e.preventDefault()
      pushUndo()
      dungeon.shapes.splice(idx, 1)
      selectedShapeId = null
      shapeDrag = null
      return
    }
  }
  if ((e.key === "+" || e.key === "=") && !e.metaKey && !e.ctrlKey) {
    e.preventDefault()
    zoomAt(lastCursorScreen, 1.12)
  } else if ((e.key === "-" || e.key === "_") && !e.metaKey && !e.ctrlKey) {
    e.preventDefault()
    zoomAt(lastCursorScreen, 1/1.12)
  }
})

// Shape helpers
function regularPolygon(center, sides, radius, rotation){
  const pts=[]
  for (let i=0;i<sides;i++){
    const a = rotation + i * 2*Math.PI/sides
    pts.push({ x: center.x + Math.cos(a)*radius, y: center.y + Math.sin(a)*radius })
  }
  return pts
}
function updateShapePoly(sh){
  sh._poly = regularPolygon(sh.center, sh.sides, sh.radius, sh.rotation)
}
function hitShape(worldPt, sh){
  const dx = worldPt.x - sh.center.x
  const dy = worldPt.y - sh.center.y
  return Math.hypot(dx,dy) <= sh.radius * 1.05
}
function shapeHandleWorld(sh){
  // handle at first vertex
  const a = sh.rotation
  return { x: sh.center.x + Math.cos(a)*sh.radius, y: sh.center.y + Math.sin(a)*sh.radius }
}
function hitHandle(worldPt, sh){
  const h = shapeHandleWorld(sh)
  return Math.hypot(worldPt.x-h.x, worldPt.y-h.y) <= dungeon.gridSize*0.5
}

// Input
canvas.addEventListener("pointerdown", (e)=>{
  canvas.setPointerCapture(e.pointerId)
  pointers.set(e.pointerId, getPointerPos(e))
  if (e.button !== 2) hidePropContextMenu()

  if (e.pointerType==="mouse" && (e.button===1 || e.button===2)){
    panDrag = { start:{x:e.clientX,y:e.clientY}, cam:{x:camera.x,y:camera.y} }
    draftRect=null; freeDraw=null; lineDraw=null; draft=null; draftShape=null; draftArc=null; shapeDrag=null; propTransformDrag=null; eraseStroke=null
    return
  }
  if (pointers.size===2){
    const [a,b]=Array.from(pointers.values())
    const mid={x:(a.x+b.x)/2,y:(a.y+b.y)/2}
    const dd=Math.hypot(a.x-b.x,a.y-b.y)
    gesture={ lastDist:Math.max(dd, 0.0001), lastMid:mid }
    draftRect=null; freeDraw=null; lineDraw=null; draft=null; draftShape=null; draftArc=null; shapeDrag=null; propTransformDrag=null; eraseStroke=null
    return
  }

  const screen = getPointerPos(e)
  const world = camera.screenToWorld(screen)

  // Select tool: move text / props
  if (tool === "select") {
    const pickedText = pickTextAtScreen(screen)
    if (pickedText){
      selectedTextId = pickedText.id
      selectedPropId = null
      selectedShapeId = null
      syncTextPanelVisibility()
      pushUndo()
      textDrag = { id:pickedText.id, startWorld:world, startX:pickedText.x, startY:pickedText.y, changed:false, pushedUndo:true }
      return
    }
    const picked = pickPlacedPropAtWorld(world)
    if (!picked){
      selectedPropId = null
      selectedTextId = null
      propTransformDrag = null
      textDrag = null
      syncTextPanelVisibility()
      return
    }
    selectedTextId = null
    selectedPropId = picked.id
    syncTextPanelVisibility()
    const onRotateHandle = hitPlacedPropRotateHandle(world, picked)
    const onScaleHandle = !onRotateHandle && hitPlacedPropScaleHandle(world, picked)
    if (!onRotateHandle && !onScaleHandle && e.altKey){
      pushUndo()
      const dup = duplicatePlacedPropById(picked.id)
      if (dup){
        propTransformDrag = { mode:"move", id:dup.id, startWorld:world, startX:dup.x, startY:dup.y, changed:false, pushedUndo:true, origin:"duplicate" }
        return
      }
    }
    pushUndo()
    propTransformDrag = onRotateHandle
      ? { mode:"rotate", id:picked.id, startWorld:world, startRot:Number(picked.rot || 0) || 0, startAngle:Math.atan2(world.y - picked.y, world.x - picked.x), changed:false, pushedUndo:true }
      : onScaleHandle
        ? { mode:"scale", id:picked.id, startScale:Math.max(0.05, Number(picked.scale || 1) || 1), startPointerDist:Math.max(0.001, Math.hypot(world.x - (Number(picked.x)||0), world.y - (Number(picked.y)||0))), changed:false, pushedUndo:true }
        : { mode:"move", id:picked.id, startWorld:world, startX:picked.x, startY:picked.y, changed:false, pushedUndo:true }
    return
  }

  // Text tool: click existing text to select/drag, otherwise place a new label and edit inline
  if (tool === "text"){
    if (textEditorState) commitActiveTextEditor()
    const pickedText = pickTextAtScreen(screen)
    if (pickedText){
      selectedTextId = pickedText.id
      selectedPropId = null
      selectedShapeId = null
      syncTextPanelVisibility()
      pushUndo()
      textDrag = { id:pickedText.id, startWorld:world, startX:pickedText.x, startY:pickedText.y, changed:false, pushedUndo:true }
      return
    }
    pushUndo()
    const t = createTextAtWorld(world)
    syncTextPanelVisibility()
    openTextEditorFor(t.id, { isNew:true, undoPushed:true })
    return
  }


  // Poly tool: create/select/drag parametric shape
  if (tool === "poly"){
    // try select existing
    const found = dungeon.shapes.slice().reverse().find(sh => hitHandle(world, sh) || hitShape(world, sh))
    if (found){
      selectedShapeId = found.id
      if (hitHandle(world, found)){
        shapeDrag = { mode:"handle", id:found.id, startWorld:world, startCenter:{...found.center}, startRadius:found.radius, startRot:found.rotation }
      } else {
        shapeDrag = { mode:"move", id:found.id, startWorld:world, startCenter:{...found.center} }
      }
      return
    }
    // create new on drag
    const c = snapSoft(world, subGrid(), dungeon.style.snapStrength)
    draftShape = { center:c, radius:dungeon.gridSize*2, rotation:-Math.PI/6, sides:getPolySidesValue() }
    return
  }


  selectedShapeId = null
  selectedPropId = null
  selectedTextId = null
  syncTextPanelVisibility()
  if (tool === "erase"){
    const w = camera.screenToWorld(screen)
    draftRect = { a:w, b:w }
    eraseStroke = null
    return
  }

  selectedShapeId = null

  if (tool === "space"){
    const w = camera.screenToWorld(screen)
    draftRect = { a:w, b:w }
  } else if (tool === "free" || tool === "water"){
    freeDraw = [ snapSoft(world, subGrid(), dungeon.style.snapStrength) ]
  } else if (tool === "line"){
    const start = snapSoft(world, subGrid(), dungeon.style.snapStrength)
    lineDraw = { start, points:[start], dashed: dungeon.style?.lines?.dashed === true }
  } else if (tool === "arc"){
    if (!draftArc){
      draftArc = {
        stage:"radius",
        center:snapSoft(world, subGrid(), dungeon.style.snapStrength),
        radius:subGrid(),
        startAngle:0,
        endAngle:0,
        sweepAccum:0,
        lastRawAngle:0,
        previewAngle:0,
        dragPointerId:e.pointerId
      }
    }
  }
})

canvas.addEventListener("pointermove", (e)=>{
  if (!pointers.has(e.pointerId)) return
  const pos = getPointerPos(e)
  pointers.set(e.pointerId, pos)

  if (panDrag){
    const dx = (e.clientX - panDrag.start.x)/camera.zoom
    const dy = (e.clientY - panDrag.start.y)/camera.zoom
    camera.x = panDrag.cam.x + dx
    camera.y = panDrag.cam.y + dy
    return
  }
  if (gesture && pointers.size===2){
    const [a,b]=Array.from(pointers.values())
    const mid={x:(a.x+b.x)/2,y:(a.y+b.y)/2}
    const dd=Math.max(Math.hypot(a.x-b.x,a.y-b.y), 0.0001)

    // Two-finger pan follows the pinch midpoint.
    if (gesture.lastMid){
      const mdx = mid.x - gesture.lastMid.x
      const mdy = mid.y - gesture.lastMid.y
      camera.x += mdx / camera.zoom
      camera.y += mdy / camera.zoom
    }

    // Zoom around the CURRENT pinch midpoint so the content under the fingers stays put.
    const factor = dd / (gesture.lastDist || dd)
    if (Number.isFinite(factor) && factor > 0){
      zoomAt(mid, factor)
    }

    gesture.lastMid = mid
    gesture.lastDist = dd
    return
  }

  const world = camera.screenToWorld(pos)


  // text drag
  if (textDrag){
    const t = placedTexts.find(v => v && v.id === textDrag.id)
    if (!t) return
    let nx = textDrag.startX + (world.x - textDrag.startWorld.x)
    let ny = textDrag.startY + (world.y - textDrag.startWorld.y)
    const snapped = snapSoft({ x:nx, y:ny }, subGrid(), dungeon.style.snapStrength)
    nx = snapped.x; ny = snapped.y
    if (Math.abs(nx - t.x) > 1e-6 || Math.abs(ny - t.y) > 1e-6) textDrag.changed = true
    t.x = nx; t.y = ny
    return
  }

  // prop transform drag
  if (propTransformDrag){
    const p = getPlacedPropById(propTransformDrag.id)
    if (!p) return
    if (propTransformDrag.mode === "move") {
      let nx = propTransformDrag.startX + (world.x - propTransformDrag.startWorld.x)
      let ny = propTransformDrag.startY + (world.y - propTransformDrag.startWorld.y)
      if (getPropSnapEnabled()) { const snapped = snapPropMoveWorldPoint({ x:nx, y:ny }); nx = snapped.x; ny = snapped.y }
      if (Math.abs(nx - p.x) > 1e-6 || Math.abs(ny - p.y) > 1e-6) propTransformDrag.changed = true
      p.x = nx; p.y = ny
    } else if (propTransformDrag.mode === "rotate") {
      const ang = Math.atan2(world.y - p.y, world.x - p.x)
      const nextRot = rotatePropAngleMaybeSnap((propTransformDrag.startRot || 0) + (ang - propTransformDrag.startAngle))
      if (Math.abs(nextRot - (Number(p.rot || 0) || 0)) > 1e-6) propTransformDrag.changed = true
      p.rot = nextRot
    } else if (propTransformDrag.mode === "scale") {
      const dist = Math.max(0.001, Math.hypot(world.x - (Number(p.x)||0), world.y - (Number(p.y)||0)))
      let nextScale = Math.max(0.05, (Number(propTransformDrag.startScale) || 1) * (dist / Math.max(0.001, Number(propTransformDrag.startPointerDist) || 1)))
      nextScale = Math.min(8, Math.max(0.2, nextScale))
      if (getPropSnapEnabled()) nextScale = Math.round(nextScale / 0.05) * 0.05
      if (Math.abs(nextScale - (Number(p.scale || 1) || 1)) > 1e-6) propTransformDrag.changed = true
      p.scale = nextScale
    }
    return
  }


  // shape drag
  if (shapeDrag){
    const sh = dungeon.shapes.find(s=>s.id===shapeDrag.id)
    if (!sh) return
    if (shapeDrag.mode==="move"){
      const dx = world.x - shapeDrag.startWorld.x
      const dy = world.y - shapeDrag.startWorld.y
      const newC = { x: shapeDrag.startCenter.x + dx, y: shapeDrag.startCenter.y + dy }
      sh.center = snapSoft(newC, subGrid(), dungeon.style.snapStrength)
      updateShapePoly(sh)
    } else {
      // handle drag sets radius + rotation
      const v = { x: world.x - sh.center.x, y: world.y - sh.center.y }
      const r = Math.max(subGrid(), Math.hypot(v.x,v.y))
      const ang = Math.atan2(v.y, v.x)
      sh.radius = snapHard({x:r,y:0}, subGrid()).x
      // snap rotation to 15 degrees
      const step = Math.PI/12
      sh.rotation = Math.round(ang/step)*step
      updateShapePoly(sh)
    }
    return
  }

  if (tool==="poly" && draftShape){
    const v = { x: world.x - draftShape.center.x, y: world.y - draftShape.center.y }
    const r = Math.max(subGrid(), Math.hypot(v.x,v.y))
    draftShape.radius = snapHard({x:r,y:0}, subGrid()).x
    const ang = Math.atan2(v.y, v.x)
    const step = Math.PI/12
    draftShape.rotation = Math.round(ang/step)*step
  }

  if (tool==="arc" && draftArc){
    if (draftArc.stage === "radius" && draftArc.dragPointerId === e.pointerId){
      const v = { x: world.x - draftArc.center.x, y: world.y - draftArc.center.y }
      const r = Math.max(subGrid(), Math.hypot(v.x, v.y))
      draftArc.radius = snapHard({x:r,y:0}, subGrid()).x
      draftArc.previewAngle = angleFromCenter(draftArc.center, world)
      draftArc.startAngle = draftArc.previewAngle
      draftArc.endAngle = draftArc.previewAngle
    }
  }

  if (tool==="space" && draftRect && pointers.size===1){
    draftRect.b = world
  }
  if ((tool==="free" || tool==="water") && freeDraw && pointers.size===1){
    freeDraw.push(snapSoft(world, subGrid(), dungeon.style.snapStrength))
  }
  if (tool==="line" && lineDraw && pointers.size===1){
    const snapped = snapSoft(world, subGrid(), dungeon.style.snapStrength)
    if (e.shiftKey){
      lineDraw.points = [lineDraw.start, snapped]
    } else {
      const pts = lineDraw.points
      const last = pts[pts.length - 1]
      if (!last || dist(snapped, last) >= Math.max(2, subGrid() * 0.2)) pts.push(snapped)
      else pts[pts.length - 1] = snapped
    }
  }
})

let lastTapTime=0, lastTapPos=null
canvas.addEventListener("pointerup", (e)=>{
  const pos = getPointerPos(e)
  const wasGesture = !!gesture || pointers.size>1
  pointers.delete(e.pointerId)

  if (panDrag){ panDrag=null; return }
  if (gesture && pointers.size<2){ gesture=null; return }
  if (wasGesture) return

  const world = camera.screenToWorld(pos)
  const now = performance.now()
  const isNearLast = lastTapPos ? Math.hypot(pos.x-lastTapPos.x, pos.y-lastTapPos.y) < 22 : true
  const isDoubleTap = (now - lastTapTime) < 320 && isNearLast


  // end text drag
  if (textDrag){
    const clickedId = textDrag.id
    const wasChanged = !!textDrag.changed
    if (!wasChanged && textDrag.pushedUndo) undoStack.pop()
    textDrag = null
    if (!wasChanged && (tool === "select" || tool === "text")) {
      openTextEditorFor(clickedId, { isNew:false, undoPushed:false })
    }
    return
  }

  // end prop transform drag
  if (propTransformDrag){
    if (!propTransformDrag.changed && propTransformDrag.pushedUndo && propTransformDrag.origin !== "duplicate") undoStack.pop()
    propTransformDrag = null
    return
  }


  // end shape drag / create shape
  if (shapeDrag){
    pushUndo()
    const sh = dungeon.shapes.find(s => s.id === shapeDrag.id)
    if (sh) sh.seq = nextEditSeq()
    shapeDrag = null
    return
  }
  if (tool==="poly" && draftShape){
    pushUndo()
    const sh = { id: crypto.randomUUID(), seq: nextEditSeq(), kind:"regular", sides:draftShape.sides, center:draftShape.center, radius:draftShape.radius, rotation:draftShape.rotation, mode: currentDrawMode() }
    updateShapePoly(sh)
    dungeon.shapes.push(sh)
    bumpInteriorVersion()
    selectedShapeId = sh.id
    draftShape = null
    return
  }

  if (tool==="arc" && draftArc){
    if (draftArc.stage === "radius" && draftArc.dragPointerId === e.pointerId){
      const rawAngle = angleFromCenter(draftArc.center, world)
      const v = { x: world.x - draftArc.center.x, y: world.y - draftArc.center.y }
      const r = Math.max(subGrid(), Math.hypot(v.x, v.y))
      if (r < subGrid() * 0.75) {
        draftArc = null
        return
      }
      draftArc.radius = snapHard({x:r,y:0}, subGrid()).x
      draftArc.stage = "end"
      draftArc.startAngle = rawAngle
      draftArc.endAngle = rawAngle
      draftArc.sweepAccum = 0
      draftArc.lastRawAngle = rawAngle
      draftArc.previewAngle = rawAngle
      draftArc.dragPointerId = null
      return
    }
    if (draftArc.stage === "end"){
      updateDraftArcSweepToWorld(draftArc, world)
      if (commitDraftArc(draftArc)) draftArc = null
      return
    }
  }

  if (tool==="space"){
    if (!draftRect) return
    const a=draftRect.a, b=draftRect.b
    const minx=Math.min(a.x,b.x), maxx=Math.max(a.x,b.x)
    const miny=Math.min(a.y,b.y), maxy=Math.max(a.y,b.y)
    const p0 = snapHard({x:minx,y:miny}, subGrid())
    const p2 = snapHard({x:maxx,y:maxy}, subGrid())
    const w = Math.abs(p2.x-p0.x), h = Math.abs(p2.y-p0.y)
    if (w >= subGrid()*0.75 && h >= subGrid()*0.75){
      const poly = [
        {x:p0.x,y:p0.y},{x:p2.x,y:p0.y},{x:p2.x,y:p2.y},{x:p0.x,y:p2.y}
      ]
      pushUndo()
      const changed = commitSpacePolygon(poly, currentDrawMode())
      if (!changed) undoStack.pop()
    }
    draftRect=null
  } else if (tool==="free"){
    if (freeDraw && freeDraw.length>=2){
      const pts = simplifyFree(freeDraw, 6)
      commitDraftPath(pts, currentPathShapeSettings())
    }
    freeDraw=null
  } else if (tool==="line") {
    if (lineDraw && Array.isArray(lineDraw.points) && lineDraw.points.length >= 2){
      const pts = lineDraw.points.length === 2 ? lineDraw.points.slice() : simplifyFree(lineDraw.points, Math.max(3, subGrid() * 0.35))
      commitLineStroke(pts, { dashed: lineDraw.dashed === true })
    }
    lineDraw = null
  } else if (tool==="water"){
    if (freeDraw && freeDraw.length>=2){
      pushUndo()
      const pts = simplifyFree(freeDraw, 4)
      if (!dungeon.water || typeof dungeon.water !== "object") dungeon.water = { paths: [] }
      if (!Array.isArray(dungeon.water.paths)) dungeon.water.paths = []
      dungeon.water.paths.push({ id: crypto.randomUUID(), seq: nextEditSeq(), mode: currentDrawMode(), width: Number(dungeon.style?.water?.width || 52), points: pts })
      bumpWaterVersion()
      compiledSig = ""
    }
    freeDraw=null
  } else if (tool==="path"){
    if (isDoubleTap && draft && draft.type==="path"){
      if (draft.points.length>=2){
        commitDraftPath(draft.points, currentPathShapeSettings())
      }
      draft=null
    } else {
      if (!draft) draft = { type:"path", points:[] }
      const p = snapSoft(world, subGrid(), dungeon.style.snapStrength)
      draft.points.push(p)
    }
  }

  lastTapTime=now; lastTapPos=pos
  if (textEditorState) refocusTextCanvasEditorSoon()
})

canvas.addEventListener("dblclick", (e)=>{
  if (tool !== "select") return
  const screen = getPointerPos(e)
  const pickedText = pickTextAtScreen(screen)
  if (!pickedText) return
  e.preventDefault()
  if (!textEditorState) pushUndo()
  openTextEditorFor(pickedText.id, { isNew:false, undoPushed:!textEditorState })
})

canvas.addEventListener("pointercancel", (e)=>{
  pointers.delete(e.pointerId)
  if (pointers.size<2) gesture=null
  if (propTransformDrag && !propTransformDrag.changed && propTransformDrag.pushedUndo && propTransformDrag.origin !== "duplicate") undoStack.pop()
  panDrag=null
  draftRect=null
  freeDraw=null
  lineDraw=null
  draft=null
  draftShape=null
  draftArc=null
  shapeDrag=null
  propTransformDrag=null
  textDrag=null
  eraseStroke=null
})

// resize
function resize(){
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1))
  canvas.width = Math.floor(window.innerWidth * dpr)
  canvas.height = Math.floor(window.innerHeight * dpr)
  canvas.style.width = window.innerWidth + "px"
  canvas.style.height = window.innerHeight + "px"
  ctx.setTransform(dpr,0,0,dpr,0,0)
  W = window.innerWidth; H = window.innerHeight
  maskCanvas.width = W; maskCanvas.height = H
}
window.addEventListener("resize", resize)
resize()

function drawShapeSelection(){
  if (!selectedShapeId) return
  const sh = dungeon.shapes.find(s=>s.id===selectedShapeId)
  if (!sh) return
  updateShapePoly(sh)
  const poly = sh._poly
  ctx.save()
  ctx.strokeStyle = sh.mode==="subtract" ? "rgba(255,80,80,0.95)" : "rgba(80,120,255,0.95)"
  ctx.lineWidth = 2
  ctx.setLineDash([6,6])
  ctx.beginPath()
  for (let i=0;i<poly.length;i++){
    const p = camera.worldToScreen(poly[i])
    i===0 ? ctx.moveTo(p.x,p.y) : ctx.lineTo(p.x,p.y)
  }
  ctx.closePath()
  ctx.stroke()
  ctx.setLineDash([])

  // center handle
  const c = camera.worldToScreen(sh.center)
  ctx.fillStyle = "rgba(20,25,30,0.9)"
  ctx.beginPath(); ctx.arc(c.x,c.y,5,0,Math.PI*2); ctx.fill()

  // resize/rotate handle
  const h = shapeHandleWorld(sh)
  const hs = camera.worldToScreen(h)
  ctx.fillStyle = "rgba(80,120,255,0.95)"
  ctx.beginPath(); ctx.arc(hs.x,hs.y,6,0,Math.PI*2); ctx.fill()
  ctx.restore()
}

function drawDraftOverlay(){
  ctx.save()
  // high contrast preview colors
  const isErasePreview = !!underMode
  const stroke = (underMode || isErasePreview) ? "rgba(220,80,80,0.95)" : "rgba(80,120,255,0.90)"
  const fill = (underMode || isErasePreview) ? "rgba(220,80,80,0.22)" : "rgba(80,120,255,0.20)"
  ctx.strokeStyle = stroke
  ctx.lineWidth = 1
  ctx.setLineDash([6,6])

  if (draftRect){
    const p0 = snapHard({ x: Math.min(draftRect.a.x, draftRect.b.x), y: Math.min(draftRect.a.y, draftRect.b.y) }, subGrid())
    const p1 = snapHard({ x: Math.max(draftRect.a.x, draftRect.b.x), y: Math.max(draftRect.a.y, draftRect.b.y) }, subGrid())
    const a = camera.worldToScreen(p0)
    const b = camera.worldToScreen(p1)
    const x=Math.min(a.x,b.x), y=Math.min(a.y,b.y)
    const w=Math.abs(a.x-b.x), h=Math.abs(a.y-b.y)
    ctx.strokeRect(x,y,w,h)
  }

  // Path tool preview: dashed centerline + translucent corridor stroke (no squish)
  if (draft && draft.type==="path" && draft.points.length>0){
    ctx.beginPath()
    draft.points.forEach((p,i)=>{
      const s = camera.worldToScreen(p)
      i===0 ? ctx.moveTo(s.x,s.y) : ctx.lineTo(s.x,s.y)
    })
    ctx.stroke()

    // Show corridor width preview immediately at the first point
    const pFirst = camera.worldToScreen(draft.points[0])
    const r = Math.max(2, (currentCorridorWidth() * camera.zoom) * 0.5)
    ctx.setLineDash([])
    ctx.fillStyle = fill
    ctx.strokeStyle = stroke
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(pFirst.x, pFirst.y, r, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()

    if (draft.points.length>=2){
      const previewGeom = getPathRenderGeometry(draft.points, currentPathShapeSettings(), { width: currentCorridorWidth(), seed: "draft-path", preview: true, pointBudget: 120 })
      ctx.setLineDash([])
      if (previewGeom.kind === "polygon") {
        ctx.fillStyle = fill
        ctx.strokeStyle = stroke
        ctx.lineWidth = 1
        ctx.beginPath()
        previewGeom.points.forEach((p,i)=>{
          const s = camera.worldToScreen(p)
          i===0 ? ctx.moveTo(s.x,s.y) : ctx.lineTo(s.x,s.y)
        })
        ctx.closePath()
        ctx.fill()
        ctx.stroke()
      } else {
        ctx.strokeStyle = fill
        ctx.lineWidth = currentCorridorWidth() * camera.zoom
        ctx.lineCap = "round"; ctx.lineJoin = "round"
        ctx.beginPath()
        previewGeom.points.forEach((p,i)=>{
          const s = camera.worldToScreen(p)
          i===0 ? ctx.moveTo(s.x,s.y) : ctx.lineTo(s.x,s.y)
        })
        ctx.stroke()
      }
    }
  }

  if (tool==="line" && lineDraw && lineDraw.points.length>1){
    ctx.setLineDash(lineDraw.dashed ? [Math.max(4, currentLineDashWorld() * camera.zoom), Math.max(4, currentLineDashWorld() * camera.zoom)] : [6,6])
    ctx.strokeStyle = stroke
    ctx.lineWidth = Math.max(1, currentLineWorldWidth() * camera.zoom)
    ctx.lineCap = "round"; ctx.lineJoin = "round"
    ctx.beginPath()
    lineDraw.points.forEach((p,i)=>{
      const s = camera.worldToScreen(p)
      i===0 ? ctx.moveTo(s.x,s.y) : ctx.lineTo(s.x,s.y)
    })
    ctx.stroke()
    ctx.setLineDash([])
  }
  if (tool === "line" && underMode){
    const previewRadius = Math.max(6, currentLineWorldWidth("subtract") * camera.zoom * 0.5)
    const cx = Number(lastCursorScreen?.x || 0)
    const cy = Number(lastCursorScreen?.y || 0)
    if (Number.isFinite(cx) && Number.isFinite(cy)){
      ctx.save()
      ctx.setLineDash([8, 6])
      ctx.strokeStyle = "rgba(220,80,80,0.95)"
      ctx.fillStyle = "rgba(220,80,80,0.10)"
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(cx, cy, previewRadius, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
      ctx.restore()
    }
  }

  // Free draw preview: translucent corridor stroke
  if (tool!=="water" && freeDraw && freeDraw.length>1){
    const previewGeom = getPathRenderGeometry(freeDraw, currentPathShapeSettings(), { width: currentCorridorWidth(), seed: "draft-free", preview: true, pointBudget: 120 })
    const previewLine = previewGeom.centerline || previewGeom.points
    ctx.setLineDash([6,6])
    ctx.strokeStyle = stroke
    ctx.lineWidth = 1
    ctx.beginPath()
    previewLine.forEach((p,i)=>{
      const s = camera.worldToScreen(p)
      i===0 ? ctx.moveTo(s.x,s.y) : ctx.lineTo(s.x,s.y)
    })
    ctx.stroke()

    ctx.setLineDash([])
    if (previewGeom.kind === "polygon") {
      ctx.fillStyle = fill
      ctx.strokeStyle = stroke
      ctx.lineWidth = 1
      ctx.beginPath()
      previewGeom.points.forEach((p,i)=>{
        const s = camera.worldToScreen(p)
        i===0 ? ctx.moveTo(s.x,s.y) : ctx.lineTo(s.x,s.y)
      })
      ctx.closePath()
      ctx.fill()
      ctx.stroke()
    } else {
      ctx.strokeStyle = fill
      ctx.lineWidth = currentCorridorWidth() * camera.zoom
      ctx.lineCap = "round"; ctx.lineJoin = "round"
      ctx.beginPath()
      previewGeom.points.forEach((p,i)=>{
        const s = camera.worldToScreen(p)
        i===0 ? ctx.moveTo(s.x,s.y) : ctx.lineTo(s.x,s.y)
      })
      ctx.stroke()
    }
  }


  if (tool==="water" && freeDraw && freeDraw.length>1){
    const waterStyle = dungeon.style.water || {}
    const wcol = waterStyle.color || "#6bb8ff"
    const alpha = Math.max(0.08, Math.min(0.85, Number(waterStyle.opacity || 0.4)))
    ctx.setLineDash([])
    ctx.strokeStyle = wcol
    ctx.globalAlpha = alpha * 0.9
    ctx.lineWidth = Number(waterStyle.width || 52) * camera.zoom
    ctx.lineCap = "round"; ctx.lineJoin = "round"
    ctx.beginPath()
    freeDraw.forEach((p,i)=>{
      const s = camera.worldToScreen(p)
      i===0 ? ctx.moveTo(s.x,s.y) : ctx.lineTo(s.x,s.y)
    })
    ctx.stroke()
    ctx.globalAlpha = 1
    if (waterStyle.outlineEnabled !== false){
      ctx.strokeStyle = underMode ? "rgba(220,80,80,0.95)" : (waterStyle.outlineColor || "rgba(31,41,51,0.95)")
      ctx.lineWidth = Math.max(2, (Number(waterStyle.outlinePx || 8)))
      ctx.beginPath()
      freeDraw.forEach((p,i)=>{
        const s = camera.worldToScreen(p)
        i===0 ? ctx.moveTo(s.x,s.y) : ctx.lineTo(s.x,s.y)
      })
      ctx.stroke()
    }
  }

  if (draftArc){
    const centerScreen = camera.worldToScreen(draftArc.center)
    const radiusPx = Math.max(1, draftArc.radius * camera.zoom)
    ctx.setLineDash([6,6])
    ctx.strokeStyle = stroke
    ctx.lineWidth = 1.25
    ctx.beginPath()
    ctx.arc(centerScreen.x, centerScreen.y, radiusPx, 0, Math.PI * 2)
    ctx.stroke()

    ctx.setLineDash([])
    ctx.fillStyle = fill
    ctx.beginPath()
    ctx.arc(centerScreen.x, centerScreen.y, 4, 0, Math.PI * 2)
    ctx.fill()

    if (draftArc.stage === "radius"){
      const handle = { x: draftArc.center.x + Math.cos(draftArc.previewAngle || 0) * draftArc.radius, y: draftArc.center.y + Math.sin(draftArc.previewAngle || 0) * draftArc.radius }
      const hs = camera.worldToScreen(handle)
      ctx.strokeStyle = stroke
      ctx.lineWidth = 1.25
      ctx.beginPath()
      ctx.moveTo(centerScreen.x, centerScreen.y)
      ctx.lineTo(hs.x, hs.y)
      ctx.stroke()
    } else {
      const preview = getArcPreviewData(draftArc)
      const start = { x: draftArc.center.x + Math.cos(preview.startAngle) * preview.radius, y: draftArc.center.y + Math.sin(preview.startAngle) * preview.radius }
      const ss = camera.worldToScreen(start)
      ctx.fillStyle = stroke
      ctx.beginPath()
      ctx.arc(ss.x, ss.y, 4.5, 0, Math.PI * 2)
      ctx.fill()
      if (preview && (preview.isCircle || Math.abs(preview.sweep) > 1e-3)){
        const pts = sampleArcPoints(preview.center, preview.radius, preview.startAngle, preview.endAngle, { closeLoop: preview.isCircle })
        const arcShapeSettings = currentPathShapeSettings()
        const previewGeom = getPathRenderGeometry(pts, arcShapeSettings, {
          width: currentCorridorWidth(),
          preview: true,
          seed: `arc-preview:${preview.center.x.toFixed(2)},${preview.center.y.toFixed(2)}:${preview.radius.toFixed(2)}:${preview.startAngle.toFixed(3)}:${preview.endAngle.toFixed(3)}:${preview.isCircle ? 1 : 0}`,
          pointBudget: 120
        })
        ctx.strokeStyle = fill
        ctx.lineWidth = currentCorridorWidth() * camera.zoom
        ctx.lineCap = "round"; ctx.lineJoin = "round"
        if (previewGeom.kind === "polygon" && previewGeom.points.length >= 3) {
          ctx.beginPath()
          previewGeom.points.forEach((p,i)=>{
            const s = camera.worldToScreen(p)
            i===0 ? ctx.moveTo(s.x,s.y) : ctx.lineTo(s.x,s.y)
          })
          ctx.closePath()
          ctx.fillStyle = fill
          ctx.fill()
        } else {
          ctx.beginPath()
          previewGeom.points.forEach((p,i)=>{
            const s = camera.worldToScreen(p)
            i===0 ? ctx.moveTo(s.x,s.y) : ctx.lineTo(s.x,s.y)
          })
          ctx.stroke()
        }

        ctx.strokeStyle = stroke
        ctx.lineWidth = 1.5
        ctx.setLineDash([6,6])
        ctx.beginPath()
        pts.forEach((p,i)=>{
          const s = camera.worldToScreen(p)
          i===0 ? ctx.moveTo(s.x,s.y) : ctx.lineTo(s.x,s.y)
        })
        ctx.stroke()
        ctx.setLineDash([])
      }
    }
  }
  // Draft shape preview
  if (draftShape){
    const pts = []
    for (let i=0;i<draftShape.sides;i++){
      const a = draftShape.rotation + i*2*Math.PI/draftShape.sides
      pts.push({ x: draftShape.center.x + Math.cos(a)*draftShape.radius, y: draftShape.center.y + Math.sin(a)*draftShape.radius })
    }
    ctx.setLineDash([6,6])
    ctx.strokeStyle = stroke
    ctx.lineWidth = 1.5
    ctx.beginPath()
    pts.forEach((p,i)=>{
      const s = camera.worldToScreen(p)
      i===0 ? ctx.moveTo(s.x,s.y) : ctx.lineTo(s.x,s.y)
    })
    ctx.closePath()
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = fill
    ctx.beginPath()
    pts.forEach((p,i)=>{
      const s = camera.worldToScreen(p)
      i===0 ? ctx.moveTo(s.x,s.y) : ctx.lineTo(s.x,s.y)
    })
    ctx.closePath()
    ctx.fill()
  }

  ctx.restore()
}

// render loop
function loop(){
  // keep shape polys up to date
  for (const sh of dungeon.shapes) updateShapePoly(sh)

  // scene cache compile (authoritative world-space compile, stable across pan/zoom)
  ensureCompiled()

  ctx.clearRect(0,0,W,H)
  if (!dungeon.style.transparentBackground){
    ctx.fillStyle = dungeon.style.backgroundColor || "#f8f7f4"
    ctx.fillRect(0,0,W,H)
  }
  drawCompiledExteriorGrid(ctx, camera, compiledCache, dungeon, W, H)

  drawCompiledBase(ctx, camera, compiledCache, dungeon, W, H)
  drawLinesTo(ctx, camera)
  drawPlacedProps()
  drawTextsTo(ctx, camera, { forExport:false })
  drawPropSelection()
  drawTextSelection()
  if (textEditorState) { const tt = getSelectedText(); if (tt) positionTextEditorOverlayForText(tt) }

  drawShapeSelection()
  drawDraftOverlay()

  requestAnimationFrame(loop)
}
loop()
