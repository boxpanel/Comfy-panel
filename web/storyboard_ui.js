/**
 * 分镜提示词面板 —— 侧边栏 UI
 * 导入 / 粘贴分镜手册 → 解析成单元卡片 → 一键写入 ComfyUI 工作流
 */
import { api } from "../../scripts/api.js";
import {
  buildPrompt,
  cloneTierDefaults,
  extractAssetCodes,
  extractUnitIds,
  parseFrameName,
  parseStoryboard,
  summarize,
} from "./storyboard_parser.js?v=20261113f";
import {
  applyUnitParams,
  autoDetectTargets,
  BRIDGE_BUILD,
  clearAudioSlotsFrom,
  clearFrameImage,
  clearPictureSlotsFrom,
  clearReferenceSlot,
  clearVideoSlotsFrom,
  defaultReferenceTag,
  describeImageEntry,
  detectModelProfile,
  ensureH3Fps,
  ensureImageEntry,
  ensureReferenceAudio,
  ensureReferenceImage,
  ensureReferenceSlots,
  ensureReferenceVideo,
  ensureTaggedPicture,
  findH3PlanNode,
  findFrameInput,
  findImageEntry,
  findPromptEntry,
  findRuleBridge,
  findTaggedPictureNodes,
  getNodeById,
  getNodes,
  getPlanResolution,
  hasReferenceConditioning,
  listNodeOptions,
  pruneReferenceNodes,
  pruneIdleLoaders,
  readH3Plan,
  readResolutionSettings,
  readRuleBridgeText,
  referenceAudioSlots,
  referenceImageSlots,
  referenceVideoSlots,
  removeReferenceNodes,
  routeReferenceSlotsThroughBridge,
  setNodeImage,
  setPlanResolution,
  setPromptText,
  setResolutionMegapixels,
  taggedReferenceTargets,
  wireTaggedReferences,
  writeFrameImage,
  writeH3Plan,
  writePlanPromptPrefix,
  writeRuleBridgeText,
  writeH3Shot,
} from "./storyboard_bridge.js?v=20261113f";

const STORAGE_KEY = "comfy.storyboard.panel.v1";
const SETTINGS_REV = 2;
const PANEL_VERSION = `v53.9 · 输入校验 · ${BRIDGE_BUILD}`;
const DRAFT_STEPS = 10;
// 全自动模式用的低画质像素档（960×544 左右），跑完会恢复原像素档
const AUTO_MEGAPIXELS = 0.5;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 草稿队列拦截器：面板重建后指向最新的实例
let activeDraftPatcher = null;

const DEFAULT_SETTINGS = {
  mode: "zh+en+quality",
  quality: "",
  negative: "blurry, extra fingers, deformed face",
  syncNegative: false,
  seed: 42,
  randomSeed: false,
  cutout: false,
  cutoutBg: "#000000",
  dropCnSound: false,
  // 跨镜接续：把上一镜输出视频接到参考视频1（<Video 1>）
  continuityVideo: true,
  referenceRule: "",
  nodeIds: { positive: "", negative: "", sampler: "", latent: "", image: "" },
};

const STYLE_ID = "sb-panel-style";
const CSS = `
.sb-root{
  --sb-accent:#3b82f6;
  --sb-fg:var(--input-text, var(--p-text-color, #e6e6e6));
  --sb-muted:var(--descrip-text, var(--p-text-muted-color, #9aa0a6));
  --sb-bg:var(--comfy-menu-bg, var(--p-content-background, #202020));
  --sb-card:var(--comfy-input-bg, rgba(127,127,127,.10));
  --sb-line:var(--border-color, var(--p-content-border-color, rgba(127,127,127,.28)));
  position:relative;display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;
  background:var(--sb-bg);color:var(--sb-fg);font-size:12px;line-height:1.45;
}
.sb-root *{box-sizing:border-box;}
.sb-root [hidden]{display:none !important;}
.sb-top{display:flex;align-items:flex-start;gap:8px;padding:10px 10px 8px;}
.sb-brand{flex:1;min-width:0;}
.sb-brand-title{font-size:13px;font-weight:600;letter-spacing:.3px;}
.sb-ver{
  font-size:9px;padding:1px 4px;border-radius:3px;background:rgba(127,127,127,.22);
  color:var(--sb-muted);font-weight:400;margin-left:4px;vertical-align:middle;letter-spacing:0;
}
.sb-brand-sub{color:var(--sb-muted);font-size:11px;margin-top:2px;}
.sb-top-actions{display:flex;gap:6px;flex-shrink:0;}
.sb-btn{
  border:1px solid var(--sb-line);background:var(--sb-card);color:var(--sb-fg);
  border-radius:6px;padding:4px 9px;font-size:11px;cursor:pointer;white-space:nowrap;
  transition:background .12s,border-color .12s;
}
.sb-btn:hover{border-color:var(--sb-accent);}
.sb-btn.primary{background:var(--sb-accent);border-color:var(--sb-accent);color:#fff;}
.sb-btn.primary:hover{filter:brightness(1.08);}
.sb-btn.dim{color:var(--sb-muted);}
.sb-paste{padding:0 10px 8px;display:flex;flex-direction:column;gap:6px;}
.sb-paste textarea{
  width:100%;height:120px;resize:vertical;border-radius:6px;border:1px solid var(--sb-line);
  background:var(--sb-card);color:var(--sb-fg);font-size:11px;line-height:1.5;padding:7px 8px;
  font-family:ui-monospace,SFMono-Regular,Consolas,monospace;
}
.sb-paste textarea:focus{outline:none;border-color:var(--sb-accent);}
.sb-rule{display:flex;flex-direction:column;gap:5px;margin-top:6px;}
.sb-rule textarea{
  width:100%;height:132px;resize:vertical;border-radius:6px;border:1px solid var(--sb-line);
  background:var(--sb-card);color:var(--sb-fg);font-size:11px;line-height:1.5;padding:7px 8px;
  font-family:ui-monospace,SFMono-Regular,Consolas,monospace;
}
.sb-rule textarea:focus{outline:none;border-color:var(--sb-accent);}
.sb-paste-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
.sb-hint{color:var(--sb-muted);font-size:10.5px;}
.sb-upload{margin:6px 0 2px;padding:7px 8px;border:1px solid var(--sb-line);border-radius:6px;background:var(--sb-card);}
.sb-upload-meta{display:flex;align-items:baseline;gap:8px;margin-bottom:5px;font-size:10.5px;}
.sb-upload-meta span:first-child{color:var(--sb-fg);font-weight:500;}
.sb-upload-track{height:6px;border-radius:3px;background:rgba(127,127,127,.22);overflow:hidden;}
.sb-upload-fill{height:100%;width:0;border-radius:3px;background:var(--sb-accent);transition:width .18s ease;}
.sb-upload.done .sb-upload-fill{background:#22c55e;}
.sb-ready{
  display:flex;align-items:center;gap:6px;margin:0 10px 8px;padding:6px 8px;border-radius:7px;
  border:1px solid var(--sb-line);background:var(--sb-card);font-size:10.5px;color:var(--sb-muted);
}
.sb-ready .dot{width:7px;height:7px;border-radius:50%;background:#f0a020;flex:0 0 auto;}
.sb-ready.ok .dot{background:#3fb950;}
.sb-ready .txt{flex:1;min-width:0;line-height:1.4;}
.sb-ready .sb-btn{padding:2px 7px;font-size:10px;}
.sb-primary-row{display:flex;gap:6px;align-items:center;}
.sb-primary-row .sb-btn{flex:1;}
.sb-progress{display:flex;align-items:center;gap:6px;font-size:10.5px;color:var(--sb-muted);}
.sb-progress .track{flex:1;height:4px;border-radius:2px;background:rgba(127,127,127,.25);overflow:hidden;}
.sb-progress .bar{height:100%;width:0;background:#3fb950;transition:width .2s;}
.sb-frame{display:flex;align-items:center;gap:5px;font-size:10.5px;color:var(--sb-muted);}
.sb-frame .label{white-space:nowrap;}
.sb-frame select{
  flex:1;min-width:0;height:24px;border-radius:5px;border:1px solid var(--sb-line);
  background:var(--sb-card);color:var(--sb-fg);font-size:10.5px;padding:1px 4px;
}
.sb-frame select:focus{outline:none;border-color:var(--sb-accent);}
.sb-frame .sb-btn{padding:2px 7px;font-size:10px;}
.sb-ov{width:100%;border-collapse:collapse;font-size:10px;}
.sb-ov th,.sb-ov td{border-bottom:1px solid var(--sb-line);padding:2px 3px;text-align:left;white-space:nowrap;}
.sb-ov th{color:var(--sb-muted);font-weight:500;}
.sb-ov td.done{color:#3fb950;}
.sb-todo{display:inline-flex;align-items:center;gap:4px;color:var(--sb-muted);font-size:10.5px;white-space:nowrap;cursor:pointer;}
.sb-guide ol{margin:0;padding-left:16px;display:flex;flex-direction:column;gap:3px;font-size:11px;line-height:1.55;}
.sb-guide li::marker{color:var(--sb-accent);font-weight:700;}
.sb-help{display:flex;flex-direction:column;gap:4px;font-size:10.5px;color:var(--sb-muted);line-height:1.45;}
.sb-help b{color:var(--sb-fg);font-weight:600;}
.sb-box{margin:0 10px 8px;border:1px solid var(--sb-line);border-radius:8px;overflow:hidden;flex-shrink:0;min-height:27px;}
.sb-box>summary{
  cursor:pointer;padding:6px 9px;font-size:11.5px;font-weight:600;color:var(--sb-fg);
  background:var(--sb-card);list-style:none;user-select:none;
}
.sb-box>summary::-webkit-details-marker{display:none;}
.sb-box>summary::before{content:"▸ ";color:var(--sb-muted);}
.sb-box[open]>summary::before{content:"▾ ";}
.sb-box-body{padding:8px 9px;display:flex;flex-direction:column;gap:7px;max-height:34vh;overflow:auto;}
.sb-field{display:flex;flex-direction:column;gap:3px;}
.sb-field>label{color:var(--sb-muted);font-size:10.5px;}
.sb-field input[type=text],.sb-field input[type=number],.sb-field select{
  width:100%;border:1px solid var(--sb-line);background:var(--sb-card);color:var(--sb-fg);
  border-radius:5px;padding:3px 6px;font-size:11px;height:24px;
}
.sb-field select{padding:2px 4px;}
.sb-field input:focus,.sb-field select:focus{outline:none;border-color:var(--sb-accent);}
.sb-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
.sb-row>*{flex:0 0 auto;}
.sb-row .grow{flex:1 1 auto;min-width:0;}
.sb-chk{display:inline-flex;align-items:center;gap:4px;color:var(--sb-muted);font-size:10.5px;cursor:pointer;}
.sb-grid{display:grid;grid-template-columns:1fr;gap:7px;}
.sb-seed{display:flex;align-items:center;gap:6px;}
.sb-seed input{width:92px;}
.sb-tier-table{width:100%;border-collapse:collapse;font-size:10.5px;}
.sb-tier-table th,.sb-tier-table td{border-bottom:1px solid var(--sb-line);padding:3px 4px;text-align:left;vertical-align:top;}
.sb-tier-table th{color:var(--sb-muted);font-weight:500;white-space:nowrap;}
.sb-tier-table td{white-space:nowrap;}
.sb-toolbar{padding:0 10px 6px;display:flex;flex-direction:column;gap:6px;flex-shrink:0;}
.sb-chips{display:flex;gap:5px;flex-wrap:wrap;}
.sb-chip{
  border:1px solid var(--sb-line);background:transparent;color:var(--sb-muted);
  border-radius:999px;padding:2px 9px;font-size:10.5px;cursor:pointer;
}
.sb-chip.active{background:var(--sb-accent);border-color:var(--sb-accent);color:#fff;}
.sb-search{
  width:100%;height:26px;border-radius:6px;border:1px solid var(--sb-line);
  background:var(--sb-card);color:var(--sb-fg);font-size:11px;padding:3px 8px;
}
.sb-search:focus{outline:none;border-color:var(--sb-accent);}
.sb-list{flex:1;min-height:120px;overflow-y:auto;overflow-x:hidden;padding:0 10px 14px;display:flex;flex-direction:column;gap:7px;}
.sb-scene-head{
  display:flex;align-items:baseline;gap:6px;margin-top:6px;padding-bottom:3px;
  border-bottom:1px dashed var(--sb-line);font-weight:600;font-size:11.5px;
}
.sb-scene-head .sb-muted{font-weight:400;color:var(--sb-muted);font-size:10.5px;}
.sb-scene-note{color:var(--sb-muted);font-size:10.5px;line-height:1.4;margin:-2px 0 2px;}
.sb-card{
  border:1px solid var(--sb-line);border-left-width:3px;border-radius:8px;
  background:var(--sb-card);padding:7px 8px;display:flex;flex-direction:column;gap:5px;
}
.sb-tier-A{border-left-color:#5b8def;}
.sb-tier-B{border-left-color:#3fb950;}
.sb-tier-C{border-left-color:#d29922;}
.sb-card.is-applied{box-shadow:inset 0 0 0 1px rgba(63,185,80,.45);}
.sb-card-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
.sb-code{font-family:ui-monospace,Consolas,monospace;font-size:11.5px;font-weight:600;}
.sb-tier{
  display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;
  border-radius:4px;padding:0 4px;font-size:10px;font-weight:700;color:#fff;background:#666;
}
.sb-tier.A{background:#5b8def;}
.sb-tier.B{background:#2f9e44;}
.sb-tier.C{background:#b8860b;}
.sb-card-meta{color:var(--sb-muted);font-size:10.5px;display:flex;gap:5px;flex-wrap:wrap;}
.sb-check{margin-left:auto;color:#3fb950;font-weight:700;font-size:11px;}
.sb-zh{font-size:11.5px;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
.sb-en{font-size:10.5px;line-height:1.45;color:var(--sb-muted);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word;}
.sb-zh.open,.sb-en.open{display:block;-webkit-line-clamp:unset;}
.sb-line{font-size:10.5px;color:var(--sb-muted);line-height:1.45;word-break:break-word;}
.sb-line b{color:var(--sb-fg);font-weight:500;}
.sb-tags{display:flex;gap:4px;flex-wrap:wrap;}
.sb-tag{
  font-size:10px;padding:1px 5px;border-radius:4px;background:rgba(127,127,127,.18);
  color:var(--sb-fg);font-family:ui-monospace,Consolas,monospace;
}
.sb-params{
  font-size:10px;color:var(--sb-muted);line-height:1.5;border-top:1px dashed var(--sb-line);
  padding-top:4px;word-break:break-word;
}
.sb-actions{display:flex;gap:5px;flex-wrap:wrap;}
.sb-actions .sb-btn{padding:3px 7px;font-size:10.5px;}
.sb-msg{font-size:10.5px;color:var(--sb-muted);min-height:0;}
.sb-msg.ok{color:#3fb950;}
.sb-msg.err{color:#f85149;}
.sb-more{width:100%;padding:7px;margin-top:2px;}
.sb-empty{padding:18px 6px;color:var(--sb-muted);display:flex;flex-direction:column;gap:6px;font-size:11px;}
.sb-empty b{color:var(--sb-fg);font-weight:600;}
.sb-sample{
  margin:0;padding:7px 8px;border-radius:6px;border:1px solid var(--sb-line);background:var(--sb-card);
  color:var(--sb-fg);font-family:ui-monospace,Consolas,monospace;font-size:10px;line-height:1.5;
  white-space:pre-wrap;word-break:break-all;max-height:150px;overflow:auto;
}
.sb-drop{
  position:absolute;inset:0;display:none;align-items:center;justify-content:center;
  background:rgba(59,130,246,.18);border:2px dashed var(--sb-accent);border-radius:8px;
  color:#fff;font-size:13px;font-weight:600;z-index:20;pointer-events:none;
}
.sb-root.dragging .sb-drop{display:flex;}
.sb-toast{
  position:absolute;left:10px;right:10px;bottom:10px;padding:6px 9px;border-radius:6px;
  background:rgba(24,24,24,.96);color:#eee;font-size:11px;border:1px solid var(--sb-line);
  box-shadow:0 6px 18px rgba(0,0,0,.35);z-index:30;
}
.sb-toast.ok{border-color:#3fb950;}
.sb-toast.err{border-color:#f85149;}
.sb-modal{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.62);}
.sb-modal-box{width:min(880px,96vw);max-height:92vh;display:flex;flex-direction:column;gap:8px;padding:10px;border-radius:8px;border:1px solid var(--sb-line);background:var(--sb-bg);color:var(--sb-fg);box-shadow:0 18px 48px rgba(0,0,0,.5);}
.sb-modal-head{display:flex;align-items:baseline;gap:8px;}
.sb-modal-head .sb-btn{margin-left:auto;}
.sb-modal-canvas{display:flex;justify-content:center;background:#000;border-radius:6px;overflow:hidden;}
.sb-modal-canvas canvas{display:block;max-width:100%;cursor:crosshair;touch-action:none;}
.sb-modal-foot{display:flex;align-items:center;gap:6px;}
.sb-cut{display:flex;align-items:center;gap:8px;margin-top:6px;font-size:11px;color:var(--sb-muted);}
.sb-cut label{display:flex;align-items:center;gap:4px;cursor:pointer;}
.sb-cut select{
  background:var(--sb-card);color:var(--sb-fg);border:1px solid var(--sb-line);
  border-radius:4px;padding:1px 4px;font-size:11px;
}
.sb-ov input[type=text]{
  width:86px;background:var(--sb-card);color:var(--sb-fg);border:1px solid var(--sb-line);
  border-radius:4px;padding:1px 4px;font-size:10px;
}
`;

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

/** 从 /history 的结果里收集输出视频（VHS_VideoCombine 把 mp4 放在 gifs 里） */
function collectOutputVideos(entry) {
  const found = [];
  const outputs = (entry && entry.outputs) || {};
  for (const nodeId of Object.keys(outputs)) {
    const bucket = outputs[nodeId] || {};
    for (const key of ["gifs", "videos", "video", "images"]) {
      const list = bucket[key];
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (!item || !item.filename) continue;
        if (!/\.(mp4|webm|mov|mkv)$/i.test(String(item.filename))) continue;
        const subfolder = item.subfolder || "";
        if (found.some((it) => it.filename === item.filename && it.subfolder === subfolder)) continue;
        found.push({ filename: item.filename, subfolder, type: item.type || "output" });
      }
    }
  }
  return found;
}

function loadState() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") || {};
  } catch (error) {
    saved = {};
  }
  const settings = saved.settings || {};
  const settingsRev = Number(saved.settingsRev) || 0;
  return {
    raw: typeof saved.raw === "string" ? saved.raw : "",
    applied: saved.applied && typeof saved.applied === "object" ? saved.applied : {},
    images: saved.images && typeof saved.images === "object" ? saved.images : {},
    tags: saved.tags && typeof saved.tags === "object" ? saved.tags : {},
    // 每镜生成出来的视频（自动模式记录），供下一镜当参考视频/抽末帧用
    shots: saved.shots && typeof saved.shots === "object" ? saved.shots : {},
    // 本镜手动从上一镜末帧取的图（key 是单元编号）
    continuity: saved.continuity && typeof saved.continuity === "object" ? saved.continuity : {},
    // 自动模式最后一条状态（停在哪、为什么停）
    autoNote: typeof saved.autoNote === "string" ? saved.autoNote : "",
    draftBase:
      saved.draftBase && typeof saved.draftBase === "object" && saved.draftBase.width && saved.draftBase.height
        ? saved.draftBase
        : null,
    settings: {
      ...DEFAULT_SETTINGS,
      ...settings,
      // v2 起参考素材默认按原图上传（白底交给提示词规则处理），旧设置里的抠图开关一并关掉
      cutout: settingsRev >= 2 ? settings.cutout === true : false,
      nodeIds: { ...DEFAULT_SETTINGS.nodeIds, ...(settings.nodeIds || {}) },
    },
    doc: null,
    filterScene: "all",
    search: "",
    expanded: {},
    hideDone: false,
    renderLimit: 80,
    imageFiles: [],
    planIndex: null,
  };
}

function seedLabel(settings) {
  return settings.randomSeed ? "随机" : String(settings.seed);
}

function renderTierTable(params) {
  const rows = [
    ["分辨率", (p) => `${p.width}×${p.height}`],
    ["帧数／帧率", (p) => `${p.frames} ／ ${p.fps}`],
    ["步数", (p) => p.steps],
    ["CFG", (p) => p.cfg],
    ["采样器／调度器", (p) => `${p.sampler} ／ ${p.scheduler}`],
    ["shift", (p) => p.shift],
    ["降噪", (p) => p.denoise],
    ["动作幅度", (p) => p.motion || "-"],
    ["候选条数", (p) => p.candidates],
  ];
  const tiers = ["A", "B", "C"];
  const head = `<tr><th>参数</th>${tiers.map((t) => `<th>${escapeHtml(params[t].name)}</th>`).join("")}</tr>`;
  const body = rows
    .map(
      ([label, getter]) =>
        `<tr><th>${escapeHtml(label)}</th>${tiers
          .map((t) => `<td>${escapeHtml(getter(params[t]))}</td>`)
          .join("")}</tr>`
    )
    .join("");
  return `<table class="sb-tier-table">${head}${body}</table>`;
}

const LIBRARY_KEY = "comfy.storyboard.library.v1";

/**
 * 素材库放在模块作用域：切换侧栏页签会重建面板实例，
 * 文件句柄、上传进度都必须活过重建，否则上传承接会被打断、素材库变空。
 */
const libraryStore = loadLibraryStore();
const fileHandles = new Map();
let librarySync = null; // { total, done, uploaded, failed, running }
let libraryListener = () => {};

function loadLibraryStore() {
  try {
    const saved = JSON.parse(localStorage.getItem(LIBRARY_KEY) || "{}") || {};
    const files = Array.isArray(saved.files) ? saved.files.filter((entry) => entry && entry.name) : [];
    return { files, importedAt: Number(saved.importedAt) || 0 };
  } catch (error) {
    return { files: [], importedAt: 0 };
  }
}

function saveLibraryStore() {
  try {
    localStorage.setItem(
      LIBRARY_KEY,
      JSON.stringify({ files: libraryStore.files, importedAt: libraryStore.importedAt })
    );
  } catch (error) {
    /* 本地存储写满时只保留内存里的素材库 */
  }
}

export function createStoryboardPanel(root, app) {
  injectStyle();

  const state = loadState();
  if (state.raw) {
    state.doc = parseStoryboard(state.raw);
  }

  let searchTimer = null;
  let toastTimer = null;
  let applying = false;
  // 全自动：应用一镜 → 排队 → 等生成完成 → 下一镜
  let autoRunning = false;
  let autoStopRequested = false;
  // 记录上一镜写进加载图像节点的首帧，下一镜没有素材时要把它清掉
  let lastAppliedImage = null;
  // 本镜实际接上的上一镜参考视频（提示词里要写 <Video 1>）
  let lastVideoBound = null;
  // 最近一次应用并排队的镜，手动点「运行」后把输出视频记到它名下
  let appliedUnitId = null;

  root.classList.add("sb-root");
  root.innerHTML = `
    <div class="sb-top">
      <div class="sb-brand">
        <div class="sb-brand-title">分镜提示词面板 <span class="sb-ver">${PANEL_VERSION}</span></div>
        <div class="sb-brand-sub" data-el="summary">尚未导入文档</div>
      </div>
      <div class="sb-top-actions">
        <button class="sb-btn" data-el="pick">导入分镜</button>
        <button class="sb-btn" data-el="pick-assets">素材库</button>
        <button class="sb-btn" data-el="paste-toggle">粘贴</button>
        <button class="sb-btn" data-el="update" title="检查并更新插件（git pull，更新后刷新页面）">⟳</button>
      </div>
      <input type="file" data-el="file" accept=".md,.markdown,.txt,text/markdown" hidden>
      <input type="file" data-el="folder" webkitdirectory directory multiple hidden>
    </div>

    <div class="sb-ready" data-el="ready">
      <span class="dot"></span>
      <span class="txt" data-el="ready-text">正在检查工作流…</span>
      <button class="sb-btn" data-el="diagnose" title="检查识别到了哪些节点">诊断</button>
      <button class="sb-btn" data-el="redetect">重新识别</button>
    </div>

    <details class="sb-box sb-guide" data-el="guide">
      <summary>怎么用（三步）</summary>
      <div class="sb-box-body">
        <ol>
          <li><b>导入分镜</b>：点右上角「导入分镜」选 .md，或把文件拖进来。</li>
          <li><b>导入素材库</b>：点「素材库」选母库文件夹；文件名里带 S-01 / R-01 / S02-U01 的会自动对上。</li>
          <li><b>打开工作流</b>：在 ComfyUI 里打开你要用的图生视频工作流（面板顶部变绿就说明认到了）。</li>
          <li><b>按顺序做</b>：点下面的「应用下一镜」，素材会自动上传并填好，再回 ComfyUI 点「运行」；出完 4 条再回来点下一镜。</li>
        </ol>
        <div class="sb-hint">看不懂参数没关系，全部已经按手册的 A／B／C 档算好，按钮会自动填进工作流。</div>
        <div class="sb-hint">注意：合成好的首帧图，文件名带上镜号（如 S02-U01.png）会被优先当作这一镜的首帧。</div>
        <div class="sb-hint">格式很宽松：标题 # 可省略、竖线 ｜ 或 / 都行、S02U01 也认；只要出现镜号就能拆出镜头。</div>
      </div>
    </details>

    <div class="sb-paste" data-el="paste" hidden>
      <textarea data-el="text" spellcheck="false" placeholder="把分镜手册内容粘贴到这里（Markdown 执行卡格式）"></textarea>
      <div class="sb-paste-actions">
        <button class="sb-btn primary" data-el="parse">解析</button>
        <button class="sb-btn" data-el="clear">清空</button>
        <span class="sb-hint">也可以把 .md 文件拖进面板</span>
      </div>
    </div>

    <details class="sb-box" data-el="settings-box">
      <summary>高级设置（不懂可以不管）</summary>
      <div class="sb-box-body">
        <div class="sb-field">
          <label>提示词拼接方式</label>
          <select data-el="mode">
            <option value="zh+en+quality">中文 + 英文 + 质感串</option>
            <option value="en+quality">英文 + 质感串</option>
            <option value="zh+quality">仅中文 + 质感串</option>
            <option value="zh+en">中文 + 英文</option>
            <option value="en">仅英文</option>
            <option value="zh">仅中文</option>
          </select>
        </div>
        <div class="sb-field">
          <label>质感串（英文，可留空）</label>
          <input type="text" data-el="quality" placeholder="从母库末尾复制英文质感串">
        </div>
        <div class="sb-field">
          <label>负面提示词</label>
          <input type="text" data-el="negative" placeholder="blurry, extra fingers, deformed face">
        </div>
        <label class="sb-chk"><input type="checkbox" data-el="syncneg"> 应用提示词时同时写入负面节点</label>
        <div class="sb-field">
          <label>随机种子</label>
          <div class="sb-seed">
            <input type="number" data-el="seed" min="0" step="1">
            <button class="sb-btn" data-el="dice" title="换一个固定种子">🎲</button>
            <label class="sb-chk"><input type="checkbox" data-el="random">每次应用随机</label>
          </div>
        </div>
        <div class="sb-grid">
          <div class="sb-field">
            <label>正向提示词节点</label>
            <select data-el="node-positive"></select>
          </div>
          <div class="sb-field">
            <label>负面提示词节点</label>
            <select data-el="node-negative"></select>
          </div>
          <div class="sb-field">
            <label>采样器节点</label>
            <select data-el="node-sampler"></select>
          </div>
          <div class="sb-field">
            <label>画幅／视频节点</label>
            <select data-el="node-latent"></select>
          </div>
          <div class="sb-field">
            <label>首帧图节点（加载图像）</label>
            <select data-el="node-image"></select>
          </div>
        </div>
        <div class="sb-row">
          <button class="sb-btn" data-el="detect">自动识别节点</button>
          <button class="sb-btn" data-el="refresh-nodes">刷新节点列表</button>
        </div>
      </div>
    </details>

    <details class="sb-box">
      <summary>参数三档（解析结果）</summary>
      <div class="sb-box-body" data-el="tiers"></div>
    </details>

    <details class="sb-box">
      <summary>分镜总清单（每镜参数一览）</summary>
      <div class="sb-box-body" data-el="overview"></div>
    </details>

    <details class="sb-box">
      <summary>本批素材（编号 / 名称 / 用到的镜头）</summary>
      <div class="sb-box-body" data-el="assets"></div>
    </details>

    <details class="sb-box">
      <summary>这些参数是什么意思</summary>
      <div class="sb-box-body sb-help">
        <div><b>A 档 · 静</b>：空教室、道具、静物这类没有人大幅动的镜头。</div>
        <div><b>B 档 · 人像（默认）</b>：单人或两人说话、近景中景，手册里的默认档。</div>
        <div><b>C 档 · 动</b>：多人、翻倒、挣扎、跑动，动作多、步数多一点。</div>
        <div><b>步数</b>：20 是画质和速度的平衡点；24 给动作多的镜头。</div>
        <div><b>CFG</b>：4.5 表示“听话程度”，一般不用动。</div>
        <div><b>shift</b>：画面硬不硬，静 5、人像 6、动作 7。</div>
        <div><b>降噪</b>：图生视频必须 1.0，低了等于没动。</div>
        <div><b>种子</b>：同一个种子出图更接近；想换一条就点 🎲 或选“每次随机”。</div>
        <div><b>81 帧 / 16fps</b>：约 5 秒，手册里一条卡的实际生成长度。</div>
      </div>
    </details>

    <div class="sb-toolbar">
      <div class="sb-primary-row">
        <button class="sb-btn primary" data-el="next">▶ 应用下一镜</button>
        <label class="sb-todo"><input type="checkbox" data-el="hide-done"> 隐藏已做</label>
      </div>
      <div class="sb-frame">
        <label class="sb-chk"><input type="checkbox" data-el="auto"> 全自动（低画质）</label>
        <span class="sb-hint grow" data-el="auto-text">开启后自动：应用 → 排队 → 等生成完成 → 下一镜</span>
      </div>
      <div class="sb-frame">
        <label class="sb-chk"><input type="checkbox" data-el="contvideo" title="把上一镜生成的视频接到「参考视频1」，保持人物、服装、环境连续"> 接上一镜视频</label>
        <span class="sb-hint grow">跨镜接续用；如果某镜因此生成失败，可以先关掉再跑</span>
      </div>
      <div class="sb-progress">
        <div class="track"><div class="bar" data-el="progress-bar"></div></div>
        <span data-el="progress-text">0 / 0</span>
      </div>
      <div class="sb-frame" data-el="frame-row">
        <span class="label" data-el="frame-label">首帧图</span>
        <select data-el="first-image"></select>
        <button class="sb-btn" data-el="refresh-images" title="刷新工作流 input 目录里的图片">↻</button>
      </div>
      <div class="sb-frame" data-el="plan-row" hidden>
        <span class="label" data-el="plan-label">H3 计划</span>
        <select data-el="plan-shot"></select>
        <button class="sb-btn" data-el="plan-sync" title="把整份分镜写入 H3 计划">⇩ 写入全部</button>
      </div>
      <div class="sb-frame" data-el="draft-row" hidden>
        <span class="label">草稿/成片</span>
        <button class="sb-btn" data-el="draft" title="只在本次运行临时降分辨率 + 10 步，不改分镜里的分辨率">草稿</button>
        <button class="sb-btn" data-el="final" title="按分镜记录的分辨率与步数出成片">成片</button>
        <span class="sb-hint" data-el="draft-text"></span>
      </div>
      <div class="sb-chips" data-el="chips"></div>
      <input class="sb-search" data-el="search" placeholder="搜索单元编号或提示词…">
    </div>

    <div class="sb-list" data-el="list"></div>
    <div class="sb-drop">松开导入分镜文档</div>
    <div class="sb-toast" data-el="toast" hidden></div>
  `;

  const el = {};
  root.querySelectorAll("[data-el]").forEach((node) => {
    el[node.dataset.el] = node;
  });

  el.text.value = state.raw;

  // 上传可能由上一个面板实例发起：重建后把进度接回当前实例
  libraryListener = () => setLibraryStatus();

  // 手动点「运行」也能记录输出视频：执行完成后记到最近应用的那一镜名下
  if (typeof api.addEventListener === "function") {
    api.addEventListener("execution_success", (event) => {
      const promptId = event && event.detail && event.detail.prompt_id;
      if (!promptId || !appliedUnitId || autoRunning) return;
      api
        .fetchApi(`/history/${encodeURIComponent(promptId)}`, { cache: "no-store" })
        .then((response) => (response.ok ? response.json() : null))
        .then((data) => {
          const videos = collectOutputVideos(data && data[promptId]);
          if (!videos.length) return;
          state.shots[appliedUnitId] = { ...videos[0], at: Date.now() };
          persist();
          // 下一镜卡片上要出现「取上一镜末帧」
          renderList();
        })
        .catch(() => {});
    });
  }

  function persist() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          raw: state.raw,
          settings: state.settings,
          settingsRev: SETTINGS_REV,
          applied: state.applied,
          images: state.images,
          tags: state.tags,
          shots: state.shots,
          continuity: state.continuity,
          autoNote: state.autoNote || "",
          draftBase: state.draftBase,
        })
      );
    } catch (error) {
      /* localStorage 满了也不影响使用 */
    }
  }

  function toast(message, kind) {
    if (!message) return;
    el.toast.textContent = message;
    el.toast.className = `sb-toast ${kind || ""}`;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.toast.hidden = true;
    }, 3200);
  }

  function settings() {
    return state.settings;
  }

  function fillSelect(select, options, selected) {
    const html = ['<option value="">自动</option>']
      .concat(
        options.map(
          (option) => `<option value="${escapeHtml(option.id)}">${escapeHtml(option.label)}</option>`
        )
      )
      .join("");
    select.innerHTML = html;
    select.value = selected && options.some((option) => option.id === String(selected)) ? String(selected) : "";
  }

  function renderNodeSelects() {
    const options = listNodeOptions(app);
    const ids = settings().nodeIds;
    fillSelect(el["node-positive"], options.positive, ids.positive);
    fillSelect(el["node-negative"], options.negative, ids.negative);
    fillSelect(el["node-sampler"], options.sampler, ids.sampler);
    fillSelect(el["node-latent"], options.latent, ids.latent);
  }

  function syncNodeSelects() {
    const ids = settings().nodeIds;
    el["node-positive"].value = ids.positive || "";
    el["node-negative"].value = ids.negative || "";
    el["node-sampler"].value = ids.sampler || "";
    el["node-latent"].value = ids.latent || "";
  }

  function renderSummary() {
    if (!state.doc || !state.doc.units.length) {
      el.summary.textContent = "尚未导入文档";
      return;
    }
    const stats = summarize(state.doc);
    el.summary.textContent = `${state.doc.scenes.length} 场 · ${stats.total} 单元（A ${stats.A} / B ${stats.B} / C ${stats.C}）`;
    const libraryCount = libraryFiles().filter((entry) => !entry.audio).length;
    if (libraryCount) el.summary.textContent += ` · 素材库 ${libraryCount} 张图片`;
  }

  function renderChips() {
    if (!state.doc) {
      el.chips.innerHTML = "";
      return;
    }
    const chips = [
      `<button class="sb-chip ${state.filterScene === "all" ? "active" : ""}" data-scene="all">全部 ${state.doc.units.length}</button>`,
    ];
    for (const scene of state.doc.scenes) {
      chips.push(
        `<button class="sb-chip ${state.filterScene === scene.no ? "active" : ""}" data-scene="${scene.no}">场 ${scene.no}${
          scene.name ? " · " + escapeHtml(scene.name) : ""
        } ${scene.units.length}</button>`
      );
    }
    el.chips.innerHTML = chips.join("");
  }

  function renderTiers() {
    const params = state.doc ? state.doc.params : cloneTierDefaults();
    el.tiers.innerHTML = renderTierTable(params);
  }

  function assetName(code) {
    return (state.doc && state.doc.assetNames && state.doc.assetNames[code]) || "";
  }

  function assetCategory(code) {
    if (/^S-/.test(code)) return "场景";
    if (/^P-/.test(code) || /^T-P/.test(code)) return "道具";
    if (/^C-/.test(code)) return "参考";
    if (/^G-/.test(code)) return "群像";
    return "人物";
  }

  function renderAssets() {
    if (!el.assets) return;
    if (!state.doc || !state.doc.units.length) {
      el.assets.innerHTML = '<div class="sb-hint">导入文档后，这里会列出这一批要用的素材。</div>';
      return;
    }
    const usage = {};
    for (const unit of state.doc.units) {
      for (const code of unit.assets) {
        (usage[code] = usage[code] || []).push(unit.id);
      }
    }
    const codes = Object.keys(usage).sort();
    const rows = codes
      .map((code) => {
        const list = usage[code];
        const local = libraryFiles().filter(
          (entry) => !entry.audio && (entry.codes || []).includes(code)
        );
        const localEntry = local[0];
        const localText = local.length ? `${localEntry.name}${local.length > 1 ? ` 等 ${local.length} 个` : ""}` : "";
        const noteMark = localEntry && localEntry.note ? "〔提示词〕" : "";
        const tag = state.tags[code] || defaultReferenceTag(code);
        return `<tr>
          <td>${escapeHtml(code)}</td>
          <td>${escapeHtml(assetName(code) || "-")}</td>
          <td>${escapeHtml(assetCategory(code))}</td>
          <td>${list.length}</td>
          <td>${escapeHtml(list.slice(0, 3).join("、"))}${list.length > 3 ? "…" : ""}</td>
          <td>${escapeHtml(localText || "-")}${noteMark}</td>
          <td><input type="text" data-tag="${escapeHtml(code)}" value="${escapeHtml(tag)}" title="提示词里用 @${escapeHtml(tag)} 激活这张参考图"></td>
        </tr>`;
      })
      .join("");
    const unnamed = codes.filter((code) => !assetName(code));
    const libraryCount = libraryFiles().filter((entry) => !entry.audio).length;
    const noteCount = libraryFiles().filter((entry) => entry.note).length;
    const audioInLibrary = libraryFiles().filter((entry) => entry.audio);
    const refCount = findTaggedPictureNodes(app).length;
    const refTargets = taggedReferenceTargets(app);
    const refSlots = referenceImageSlots(app);
    const ruleBridge = findRuleBridge(app);
    el.assets.innerHTML = `
      <div class="sb-hint">共用到 ${codes.length} 个素材。点顶部「素材库」导入母库文件夹（可含子文件夹），文件名里的编号会自动对上；${
        libraryCount ? `当前素材库 ${libraryCount} 张图片${noteCount ? `（${noteCount} 张带提示词）` : ""}。` : "还没导入素材库。"
      }</div>
      <div class="sb-hint" data-el="library-text">${escapeHtml(libraryStatusText())}</div>
      <div class="sb-hint">参考图：${refCount} 张已建节点；参考入口 ${
        refTargets.length
          ? `${refTargets.length} 个（${refTargets.some((item) => item.ref2v) ? "Ref2VA 可用" : "只有校验入口，画面仍需 Ref2VA"}）`
          : "无（当前工作流是纯文生视频）"
      }。</div>
      ${
        refSlots.length
          ? `<div class="sb-hint">素材入口：Ref2V 的 Picture 1-${refSlots.length}。应用每一镜时复用已有的加载窗口填入本镜素材，不会新增窗口。</div>
             <div class="sb-hint">规则窗：${
               ruleBridge
                 ? "已接入（加载图 → 规则窗 → Ref2V），规则文本保存在画布的规则窗节点里"
                 : "还没有规则窗节点；点「接入参考素材」或「应用这一镜」会自动插入并把素材改接进去"
             }。</div>`
          : ""
      }
      <div class="sb-hint">参考图规则保存在画布的「参考图规则桥」节点里；点「运行」时才临时拼进提示词，工作流里的 Plan 前缀不写规则。应用镜头时仍会按人物／服装／道具／场景补上 <Picture N> 的用途说明。</div>
      <div class="sb-hint">素材文件夹里只有图片算素材；与图片同名的 .txt 当作该素材的提示词，会写进镜头里的「参考提示词」，不占参考位。音频文件（mp3/wav/flac/m4a/ogg）不算图片素材，会按文件名里的编号接到 Ref2V 的参考音频位（ref_audios）。</div>
      ${
        audioInLibrary.length
          ? `<div class="sb-hint">参考音频 ${audioInLibrary.length} 个：${escapeHtml(
              audioInLibrary
                .slice(0, 5)
                .map((entry) => entry.name)
                .join("、")
            )}${audioInLibrary.length > 5 ? "…" : ""}（应用这一镜时按素材顺序写入 ref_audio_0..N，多余的清空）</div>`
          : ""
      }
      <div class="sb-hint">同一编号有多张图（多视角，如 R-06_sit / R-06_view_front）会按素材列顺序一起加载；同名变体只取版本号最大的。</div>
      <div class="sb-hint">首尾帧命名：S02-U05_first_v01.png / S02-U05_last_v01.png（旧名 S02-U05_frame.png 当首帧）。同类取版本号最大的，按原图写入 first_frame / last_frame，不抠图。</div>
      <table class="sb-ov">
        <tr><th>编号</th><th>名称</th><th>类别</th><th>镜头数</th><th>用到的镜头</th><th>本地文件</th><th>参考标签</th></tr>
        ${rows}
      </table>
      ${unnamed.length ? `<div class="sb-hint">手册没给名称的编号：${escapeHtml(unnamed.join("、"))}</div>` : ""}
      <div class="sb-hint">点「应用下一镜」时，会用到的素材自动上传到 ComfyUI 的 input 目录并写入加载图像节点。</div>
      <div class="sb-cut">
        <label><input type="checkbox" data-el="cutout" ${settings().cutout ? "checked" : ""}> 白底自动抠图（参考素材建议不勾）</label>
        <label><input type="checkbox" data-el="drop-cn-sound" ${settings().dropCnSound ? "checked" : ""}> 音效段跳过中文（提示词保持纯英文）</label>
        <select data-el="cutout-bg">
          ${["#000000", "#808080", "#00ff00"]
            .map(
              (color) =>
                `<option value="${color}" ${settings().cutoutBg === color ? "selected" : ""}>${
                  { "#000000": "黑底", "#808080": "中灰", "#00ff00": "绿幕" }[color]
                }</option>`
            )
            .join("")}
        </select>
      </div>
      <div class="sb-hint">人物、道具、场景参考默认按原图上传，不做抠图；白色底色由 Plan 前缀里的白底规则处理。只有确实需要透明底时才勾选上面的自动抠图。</div>
      <div class="sb-rule">
        <div class="sb-hint"><b>参考图规则</b>：保存在画布的「参考图规则桥」节点里，点「运行」时面板才临时拼进提示词，工作流里的 Plan 前缀不动。留空或点「默认规则」就用面板内置版本。</div>
        <textarea data-el="rule" spellcheck="false" placeholder="留空 = 使用面板内置规则">${escapeHtml(
          settings().referenceRule || defaultRuleBody(refSlots.length || 9)
        )}</textarea>
        <div class="sb-row">
          <button class="sb-btn" data-act="rule-default">默认规则</button>
          <button class="sb-btn" data-act="rule-write">保存规则</button>
          <span class="sb-hint grow">规则只存在规则桥里；自定义后编号不会再随参考位数量自动改写。</span>
        </div>
      </div>
      <div class="sb-row" style="margin-top:6px">
        <button class="sb-btn" data-act="wire-refs">接入参考素材</button>
        <button class="sb-btn" data-act="upload-assets">上传素材</button>
        <button class="sb-btn" data-act="clear-refs">清空参考位</button>
        <button class="sb-btn" data-act="clear-library">清空素材库</button>
        <span class="sb-hint grow">「清空参考位」会关掉当前工作流里所有参考图/首尾帧加载窗口；「清空素材库」还会移除面板创建的参考图节点。</span>
      </div>
      ${
        libraryFiles().length
          ? `<div class="sb-upload" data-el="upload-progress" hidden>
               <div class="sb-upload-meta">
                 <span data-el="upload-text">已上传 0 / 0 个</span>
                 <span class="sb-hint grow">图片和音频一起算，上传中断或切页都不会停</span>
               </div>
               <div class="sb-upload-track"><div class="sb-upload-fill" data-el="upload-fill"></div></div>
             </div>`
          : ""
      }
      <div class="sb-hint">注意：要让参考图真正进入画面，工作流的条件节点必须是 Ref2VA（如 MiniMax H3 Tagged Reference to Video）；纯 ImageToVideo 只能当首帧用。</div>
      ${
        libraryCount
          ? '<div class="sb-hint">素材库会记住文件清单和已上传状态：切页、刷新后不用重新选文件夹；只有尚未上传成功的文件需要重新点「素材库」选文件夹补传。</div>'
          : ""
      }
    `;
    setLibraryStatus();
  }

  function libraryFiles() {
    return libraryStore.files;
  }

  function libraryMatches(unit) {
    return libraryFiles().filter((entry) => {
      if (entry.audio) return false;
      if (entry.frame) return false;
      if (entry.units && entry.units.includes(unit.id)) return true;
      return (entry.codes || []).some((code) => unit.assets.includes(code));
    });
  }

  /** 本镜要用的参考音频：先按素材列顺序，再按镜号命中 */
  function unitAudioPicks(unit) {
    const picks = [];
    const seen = new Set();
    for (const code of unit.assets || []) {
      for (const entry of libraryFiles()) {
        if (!entry.audio || seen.has(entry.path)) continue;
        if (!(entry.codes || []).includes(code)) continue;
        seen.add(entry.path);
        picks.push({ code, entry });
      }
    }
    for (const entry of libraryFiles()) {
      if (!entry.audio || seen.has(entry.path)) continue;
      if (!(entry.units || []).includes(unit.id)) continue;
      seen.add(entry.path);
      picks.push({ code: (entry.codes || [])[0] || "", entry });
    }
    return picks;
  }

  async function importAssetFolder(fileList) {
    const files = Array.from(fileList || []).filter((file) => file && file.name && !file.name.startsWith("."));
    if (!files.length) return;
    fileHandles.clear();
    // 只有图片算素材；同名 .txt 是素材的提示词，不占素材位；音频是参考音色
    const imageFiles = files.filter((file) => /\.(png|jpe?g|webp|bmp|tiff?)$/i.test(file.name));
    const noteFiles = files.filter((file) => /\.txt$/i.test(file.name));
    const audioFiles = files.filter((file) => /\.(mp3|wav|flac|m4a|ogg|opus|aac|aiff?)$/i.test(file.name));
    const entries = imageFiles.map((file) => {
      const path = file.webkitRelativePath || file.name;
      fileHandles.set(path, file);
      const frame = parseFrameName(file.name);
      return {
        name: file.name,
        path,
        frame,
        codes: frame ? [] : extractAssetCodes(file.name),
        units: frame ? [frame.unit] : extractUnitIds(file.name),
        image: true,
        note: "",
        uploadedName: "",
        uploadedFrameName: "",
      };
    });
    // 音频素材：文件名里的编号/镜号会用来对到镜头，作为参考音色（ref_audios）
    const audioEntries = audioFiles.map((file) => {
      const path = file.webkitRelativePath || file.name;
      fileHandles.set(path, file);
      const stem = file.name.replace(/\.\w+$/, "");
      return {
        name: file.name,
        path,
        image: false,
        audio: true,
        frame: null,
        role: /(voice|vocal|音色|台词|对白|配音|speech)/i.test(stem) ? "voice" : "audio",
        codes: extractAssetCodes(file.name),
        units: extractUnitIds(file.name),
        note: "",
        uploadedName: "",
        uploadedFrameName: "",
      };
    });
    // 读取素材提示词：按同名文件或文件名里的编号挂到对应素材上
    let noteCount = 0;
    for (const noteFile of noteFiles) {
      let text = "";
      try {
        text = String(await noteFile.text()).trim();
      } catch (error) {
        continue;
      }
      if (!text) continue;
      const base = noteFile.name.replace(/\.txt$/i, "");
      const codes = extractAssetCodes(base);
      const targets = entries.filter((entry) => {
        if (entry.name.replace(/\.\w+$/, "") === base) return true;
        return codes.length > 0 && (entry.codes || []).some((code) => codes.includes(code));
      });
      if (!targets.length) continue;
      targets.forEach((entry) => {
        entry.note = entry.note ? `${entry.note}\n${text}` : text;
      });
      noteCount += 1;
    }
    libraryStore.files = [...entries, ...audioEntries];
    libraryStore.importedAt = Date.now();
    if (librarySync && librarySync.running) librarySync.cancelled = true;
    librarySync = null;
    saveLibraryStore();
    // 换了素材文件夹：丢掉指向旧文件的首帧选择
    Object.keys(state.images || {}).forEach((unitId) => {
      const base = String(state.images[unitId] || "")
        .split("/")
        .pop()
        .replace(/\.\w+$/, "")
        .replace(/_cut$/i, "");
      const keep = entries.some((entry) => entry.name.replace(/\.\w+$/, "") === base);
      if (!keep) delete state.images[unitId];
    });
    persist();
    renderAll();
    // 选完文件夹就直接整批传进 ComfyUI input，后面应用镜头只写文件名
    syncLibraryToComfy().catch(() => {});
    const matched = entries.filter((entry) => entry.codes.length || entry.units.length).length;
    const frameCount = entries.filter((entry) => entry.frame).length;
    const frameText = frameCount ? `，首尾帧 ${frameCount} 个` : "";
    const noteText = noteCount ? `，素材提示词 ${noteCount} 个` : "";
    const audioText = audioEntries.length ? `，参考音频 ${audioEntries.length} 个` : "";
    // 画布上已经有参考节点时，自动用新素材重建，避免继续显示旧图
    if (state.doc && state.doc.units.length && findTaggedPictureNodes(app).length) {
      toast(`素材库：${entries.length} 张图片${audioText}${noteText}${frameText}，${matched} 个能对上编号；正在用新素材重建参考图…`, "ok");
      wireReferences().catch(() => {});
      return;
    }
    toast(`素材库：${entries.length} 张图片${audioText}${noteText}${frameText}，${matched} 个能对上编号`, "ok");
  }

  function renderOverview() {
    if (!el.overview) return;
    if (!state.doc || !state.doc.units.length) {
      el.overview.innerHTML = '<div class="sb-hint">导入文档后，这里会列出每一镜的档位与参数。</div>';
      return;
    }
    const head =
      "<tr><th>编号</th><th>档</th><th>时长</th><th>景别</th><th>步数</th><th>采样器</th><th>shift</th><th>输出前缀</th><th>状态</th></tr>";
    const rows = state.doc.units
      .map((unit) => {
        const params = unit.params || cloneTierDefaults().B;
        const done = !!state.applied[unit.id];
        return `<tr>
          <td>${escapeHtml(unit.id)}</td>
          <td>${escapeHtml(unit.tier)}</td>
          <td>${escapeHtml(unit.durationText || "-")}</td>
          <td>${escapeHtml(unit.shot || "-")}</td>
          <td>${params.steps}</td>
          <td>${escapeHtml(params.sampler)}</td>
          <td>${params.shift}</td>
          <td>${escapeHtml(unit.id + "_")}</td>
          <td class="${done ? "done" : ""}">${done ? "✓" : ""}</td>
        </tr>`;
      })
      .join("");
    el.overview.innerHTML = `<table class="sb-ov">${head}${rows}</table>`;
  }

  function renderProgress() {
    const total = state.doc ? state.doc.units.length : 0;
    const done = state.doc ? state.doc.units.filter((unit) => state.applied[unit.id]).length : 0;
    const percent = total ? Math.round((done / total) * 100) : 0;
    if (el["progress-text"]) el["progress-text"].textContent = `已做 ${done} / ${total}`;
    if (el["progress-bar"]) el["progress-bar"].style.width = `${percent}%`;
    if (!el.next) return;
    if (!total) {
      el.next.textContent = "▶ 应用下一镜";
      return;
    }
    const next = visibleUnits().find((unit) => !state.applied[unit.id]);
    el.next.textContent = next ? `▶ 下一镜：${next.id}` : "▶ 这一批做完了";
    renderFrameSelector();
  }

  function nextUnitForFrame() {
    return visibleUnits().find((unit) => !state.applied[unit.id]) || null;
  }

  function renderFrameSelector() {
    if (!el["first-image"]) return;
    const active = nextUnitForFrame();
    const files = state.imageFiles || [];
    const current = active ? state.images[active.id] || "" : "";
    const options = ['<option value="">（不改，沿用当前图）</option>'];
    for (const file of files) {
      options.push(`<option value="${escapeHtml(file)}">${escapeHtml(file)}</option>`);
    }
    if (current && !files.includes(current)) {
      options.push(`<option value="${escapeHtml(current)}">${escapeHtml(current)}</option>`);
    }
    el["first-image"].innerHTML = options.join("");
    el["first-image"].value = current;
    el["frame-label"].textContent = planInfoSafe()
      ? "整链首帧（只作用于第 0 帧）"
      : active
        ? `首帧 ${active.id}`
        : "首帧图";
  }

  function loadImageFiles() {
    fetch("/object_info/LoadImage")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        const spec =
          data &&
          data.LoadImage &&
          data.LoadImage.input &&
          data.LoadImage.input.required &&
          data.LoadImage.input.required.image;
        const files = Array.isArray(spec) ? spec[0] : null;
        state.imageFiles = Array.isArray(files) ? files.slice() : [];
      })
      .catch(() => {
        state.imageFiles = [];
      })
      .finally(() => renderFrameSelector());
  }

  function planInfoSafe() {
    try {
      return readH3Plan(app);
    } catch (error) {
      return null;
    }
  }

  /** 把素材库里的图片建成 H3 参考图节点，并接到工作流的参考入口 */
  async function wireReferences() {
    if (!state.doc || !state.doc.units.length) {
      toast("先导入分镜文档", "err");
      return;
    }
    // 原生 Ref2V（ref_images.ref_image_N）：直接按当前镜素材顺序填参考位
    const slots = referenceImageSlots(app);
    if (slots.length) {
      const unit = nextUnitForFrame() || visibleUnits()[0] || null;
      if (!unit) {
        toast("分镜里没有可用的单元", "err");
        return;
      }
      const result = await applyReferenceImagesToUnit(unit, slots);
      persist();
      renderAll();
      toast(result.message || "参考位已更新", result.ok ? "ok" : "err");
      return;
    }
    const codes = new Set();
    state.doc.units.forEach((unit) => (unit.assets || []).forEach((code) => codes.add(code)));
    const entries = libraryFiles().filter((entry) => entry.image);
    const pairs = [];
    for (const code of codes) {
      const entry = entries.find((item) => (item.codes || []).includes(code));
      if (entry) pairs.push({ code, entry });
    }
    if (!pairs.length) {
      toast("素材库里还没有能对上编号的图片", "err");
      return;
    }
    // 先清掉上一批素材留下的参考节点，避免画布/提示词里继续用旧图
    const pruned = pruneReferenceNodes(
      app,
      pairs.map(({ code }) => referenceTagFor(code))
    );
    let okCount = 0;
    const failed = [];
    for (const { code, entry } of pairs) {
      const name = await uploadAsset(entry);
      if (!name) {
        failed.push(code);
        continue;
      }
      const result = ensureTaggedPicture(app, referenceTagFor(code), name);
      if (result.ok) okCount += 1;
      else failed.push(code);
    }
    const wired = wireTaggedReferences(app);
    // 旧参考节点被清掉后，之前写入计划里的 @旧标签也会失效，需要重新逐镜应用
    if (pruned.nodes) state.applied = {};
    persist();
    if (pruned.nodes) renderAll();
    else renderAssets();
    const parts = [];
    if (pruned.nodes) parts.push(`已移除上一批参考图 ${pruned.nodes} 张（请重新逐镜「应用」）`);
    parts.push(`参考图 ${okCount} 张已建立`);
    if (wired.message) parts.push(wired.message);
    if (failed.length) parts.push(`${failed.length} 张失败：${failed.slice(0, 5).join("、")}`);
    toast(parts.join("；"), okCount ? "ok" : "err");
  }

  /** 清空当前工作流里的参考位与首尾帧加载窗口（不动素材库） */
  function clearReferenceSlots() {
    let slots = 0;
    for (const slot of referenceImageSlots(app)) {
      if (clearReferenceSlot(app, slot)) slots += 1;
    }
    let frames = 0;
    if (clearFrameImage(app, "first")) frames += 1;
    if (clearFrameImage(app, "last")) frames += 1;
    const parts = [];
    if (slots) parts.push(`关闭 ${slots} 个参考位`);
    if (frames) parts.push(`关闭 ${frames} 个首尾帧`);
    toast(parts.length ? `已${parts.join("，")}` : "参考位和首尾帧本来就是空的", "ok");
    renderAll();
  }

  /** 清空素材库，并移除面板创建的参考图节点与加载图像 */
  function clearLibraryAndRefs() {
    const removed = removeReferenceNodes(app);
    libraryStore.files = [];
    libraryStore.importedAt = 0;
    librarySync = null;
    state.tags = {};
    state.images = {};
    state.continuity = {};
    fileHandles.clear();
    saveLibraryStore();
    persist();
    renderAll();
    const tail = removed.nodes
      ? `，已移除 ${removed.nodes} 个参考节点${removed.loaders ? `、${removed.loaders} 个加载图像` : ""}`
      : "";
    toast(`已清空素材库${tail}`, "ok");
  }

  /** 当前加载图像节点里的图片名，用于诊断 */
  function currentImageValue() {
    const entry = findImageEntry(app);
    if (!entry) return "无";
    if (entry.kind !== "loader") return `${describeImageEntry(entry)}（未接图）`;
    const widget = (entry.node.widgets || []).find((item) => item && item.name === "image");
    return widget && widget.value ? String(widget.value) : "空";
  }

  /** 素材编号 → 参考标签（用户可在「本批素材」里改） */
  function referenceTagFor(code) {
    return state.tags[code] || defaultReferenceTag(code);
  }

  /** 本镜提示词里要带的 @标签（只有 Ref2VA 才真正把参考图送进画面） */
  function planReferenceTags(unit) {
    const targets = taggedReferenceTargets(app);
    if (!targets.some((target) => target.ref2v)) return [];
    const wired = new Set(
      findTaggedPictureNodes(app).map((node) => {
        const widget = (node.widgets || []).find((item) => item && item.name === "tag");
        return widget ? String(widget.value) : "";
      })
    );
    return (unit.assets || []).map((code) => referenceTagFor(code)).filter((tag) => tag && wired.has(tag));
  }

  const AUTO_PREFIX_MARK = "【分镜面板自动规则】";

  /** 面板内置的参考图规则正文（不含自动标记，编号跟着参考位数量走） */
  function defaultRuleBody(count) {
    const total = Math.max(1, count);
    return [
      "参考图使用规则（全部镜头通用）：",
      `一、编号约定：<Picture 1> 至 <Picture ${total}> 依次对应「图片 1」至「图片 ${total}」；提示词只引用本镜需要的图片，未引用或已停用的参考图不参与构图。`,
      "二、白底规则：人物、服装、群像与道具参考只取主体本身，包括五官、脸型、发型、体型、服装、配饰，以及道具的外形、颜色、材质与磨损；白色底色与四周留白不属于画面，不构成背景，不产生棚拍白光、白色描边或白色轮廓光；主体站在真实光位里，有接触阴影，边缘受环境光包裹。",
      "三、场景例外：场景类参考图整幅使用，提供空间结构、构图、光向与色调，直接作为画面环境；人物与道具参考不得反过来提供背景。",
      "四、跨镜头一致性：同一人物的脸型、五官、发型、服装与配饰保持恒定，同一道具的外形、颜色、材质与磨损保持一致；换镜或换参考图不改变身份与外观。",
      "忽略参考图背景：除场景参考外，参考图的背景、白底、留白与拍摄环境一律不进入画面。",
      `EN: Picture 1-${total} follow the same order. Use the subject only for character, clothing, group and prop references and ignore white backing; use scene references whole for space, composition, light and tone; keep faces, wardrobe and prop wear consistent across shots.`,
    ].join("\n");
  }

  /** 自动生成的全局参考图规则（用户改过就用规则窗口里的内容） */
  function referenceRulePrefix(count) {
    const custom = String(settings().referenceRule || "").trim();
    return `${AUTO_PREFIX_MARK}\n${custom || defaultRuleBody(count)}`;
  }

  /** 解析分镜或应用镜头时，把规则写进规则桥；Plan 里的自动规则清掉（提交时才临时拼） */
  function ensurePlanRulePrefix() {
    const slots = referenceImageSlots(app).length;
    if (!slots) return;
    // 规则桥是规则唯一的存放处
    writeRuleBridgeText(app, referenceRulePrefix(slots));
    const info = planInfoSafe();
    if (!info) return;
    const current = String((info.plan && info.plan.prompt_prefix) || "");
    // 以前写进 Plan 的自动规则，改成只在提交队列时临时拼
    if (current.startsWith(AUTO_PREFIX_MARK)) writePlanPromptPrefix(app, "");
  }

  /** 素材类型：scene / character / clothing / group / prop / other */
  function assetKind(code) {
    const value = String(code || "").toUpperCase();
    if (value.startsWith("S-")) return "scene";
    if (value.startsWith("R-")) return "character";
    if (value.startsWith("C-")) return "clothing";
    if (value.startsWith("G-")) return "group";
    if (value.startsWith("P-") || value.startsWith("T-P") || value.startsWith("T-")) return "prop";
    return "other";
  }

  /** 参考图用途说明的英文版（写进英文提示词时用） */
  const BINDING_KIND_EN = { scene: "scene", character: "character", clothing: "wardrobe", group: "group", prop: "prop" };
  const BINDING_RULE_EN = {
    scene: "use the whole frame for space, composition, light direction and colour.",
    character:
      "use the face, hair, build, wardrobe and accessories only; keep identity and wardrobe constant across shots; the white background must not appear.",
    clothing: "use the cut, colour and accessories only; dress the same person and keep it constant; the white background must not appear.",
    prop: "use shape, colour, material and wear only; keep it identical across shots; the white background must not appear.",
    group: "use each person's face, hair, wardrobe and blocking only; the white background must not appear.",
  };

  /** 本镜每个参考位的用途说明（顺序与实际写入 Picture 的顺序一致） */
  function unitPictureBindings(unit, lang = "zh") {
    const slotCount = referenceImageSlots(app).length;
    if (!slotCount) return [];
    return unitReferenceCodes(unit)
      .slice(0, slotCount)
      .map((pick, index) => {
        const label = `<Picture ${index + 1}>`;
        const name = assetName(pick.code) || pick.code;
        const kind = assetKind(pick.code);
        const fileName = String((pick.entry && pick.entry.name) || "");
        if (lang === "en") {
          const kindEn = BINDING_KIND_EN[kind] || "reference";
          const rule = BINDING_RULE_EN[kind] || "take only the subject itself; the white background must not appear.";
          return `${label} is the ${kindEn} reference ${pick.code}${fileName ? ` (${fileName})` : ""}: ${rule}`;
        }
        const kindLabel = { scene: "场景", character: "人物", clothing: "服装", group: "群像", prop: "道具" }[kind] || "素材";
        let rule = "只取主体本身，白色底色不进画面。";
        if (kind === "scene") rule = "整幅使用，提供空间、构图、光向与色调。";
        else if (kind === "prop") rule = "只取道具外形、颜色、材质与磨损，白色底色不进画面，各镜保持一致。";
        else if (kind === "clothing") rule = "只取版型、颜色与配饰，白色底色不进画面，穿在同一人物身上并保持恒定。";
        else if (kind === "group") rule = "只取各人的长相、发型、服装与站位关系，白色底色不进画面。";
        else if (kind === "character") rule = "只取五官、发型、体型、服装与配饰，白色底色不进画面，脸型与服装跨镜恒定。";
        const note = String((pick.entry && pick.entry.note) || "")
          .replace(/\s+/g, " ")
          .trim();
        const noteText = note ? `参考提示词：${note.length > 180 ? `${note.slice(0, 180)}…` : note}` : "";
        return `${label} 为${name}（${pick.code}，${kindLabel}${fileName ? `；${fileName}` : ""}）：${rule}${noteText}`;
      });
  }

  /** H3 计划里的提示词：只写英文正文（中文留在面板里对照），音效单列一段 */
  function buildPlanPrompt(unit, video = null) {
    const text = String(unit.promptEn || "").trim() || String(unit.promptZh || "").trim();
    const sound = String(unit.soundscape || "").trim();
    // 音效只有中文时：默认照原样写入；勾选「音效段跳过中文」后写纯英文提示词
    const soundUsable = sound && !(settings().dropCnSound && /[\u4e00-\u9fff]/.test(sound));
    const tags = planReferenceTags(unit);
    const lines = ["detailed_description:", text];
    if (tags.length) {
      lines.push("", `Reference pictures: ${tags.map((tag) => `@${tag}`).join(" ")}.`);
    } else {
      // 原生 Ref2V：按参考位顺序写明每张图的用途，保持英文
      const bindings = unitPictureBindings(unit, "en");
      if (bindings.length && !/<Picture\s+1>/i.test(text)) lines.push("", ...bindings);
    }
    // 手动从上一镜末帧取的图排在参考图最后一位
    const extra = continuityPick(unit);
    if (extra) {
      const index = unitReferenceCodes(unit).length + 1;
      lines.push(
        "",
        `<Picture ${index}> is ${extra.cropped ? "a cropped detail" : "the last frame"} from the previous shot ${
          extra.code || ""
        }: use it only for the same wardrobe, props, materials, colour and wear; it does not define this shot's framing or background.`
      );
    }
    // 跨镜衔接：上一镜视频接在 ref_videos.ref_video_0
    if (video) {
      lines.push(
        "",
        `<Video 1> is the previous shot ${video.unitId}: keep the same characters, wardrobe, props, set dressing, light direction and colour grade. Use it only as a continuity reference; this shot's framing, camera angle and action are defined above.`
      );
    }
    // 原生 Ref2V 的参考音频按 ref_audios 顺序编号，提示词里要说清「只要音色」
    const audioPicks = unitAudioPicks(unit);
    if (audioPicks.length && !/<Audio\s+1>/i.test(text)) {
      lines.push(
        "",
        ...audioPicks.slice(0, 3).map(
          (pick, index) =>
            `<Audio ${index + 1}> is the voice-timbre reference ${pick.code || pick.entry.name}: keep the vocal identity and timbre only; do not copy its original dialogue or background sound.`
        )
      );
    }
    if (soundUsable) lines.push("", "overall_soundscape:", sound);
    lines.push("", "non_diegetic_music:", "No non-diegetic music.");
    return lines.join("\n");
  }

  /** H3 的帧数必须满足 17k+5，最长 3592；按 24fps 从秒数换算，取最接近的一档 */
  function alignedFrames(seconds) {
    const target = Math.min(3592, Math.max(5, Math.round((Number(seconds) || 8) * 24)));
    const down = (((target % 17) - 5) % 17 + 17) % 17;
    const up = down === 0 ? 0 : 17 - down;
    let frames = target;
    if (down !== 0) frames = down <= up ? target - down : target + up;
    if (frames < 5) frames = 5;
    if (frames > 3592) frames = 3592;
    return frames;
  }

  /** 草稿分辨率：成片尺寸的一半，按 32 对齐 */
  function draftSize(width, height) {
    const step = 32;
    const round = (value) => Math.max(step * 2, Math.round((Number(value) * 0.5) / step) * step);
    return { width: round(width), height: round(height) };
  }

  function draftTargetSize(draft) {
    if (draft && draft.draftWidth && draft.draftHeight) {
      return { width: draft.draftWidth, height: draft.draftHeight };
    }
    return draftSize(draft.width, draft.height);
  }

  /** 草稿只在提交队列时替换参数：计划节点与工作流文件都不改 */
  function applyDraftToPayload(payload) {
    const draft = state.draftBase;
    if (!draft || !payload || !payload.output) return;
    const planNode = getNodeById(app, draft.nodeId);
    if (!planNode) return;
    const entry = payload.output[String(planNode.id)];
    if (!entry || !entry.inputs) return;
    const size = draftTargetSize(draft);
    entry.inputs.width = size.width;
    entry.inputs.height = size.height;
    try {
      const plan = JSON.parse(entry.inputs.plan_json || "{}");
      for (const shot of plan.shots || []) {
        if (shot && typeof shot === "object") shot.steps = DRAFT_STEPS;
      }
      entry.inputs.plan_json = JSON.stringify(plan);
    } catch (error) {
      /* plan_json 异常时只替换分辨率 */
    }
  }

  /** 规则只存在规则桥里；提交队列时临时拼进 Plan 前缀，工作流里的提示词不动 */
  function applyRulesToPayload(payload) {
    if (!payload || !payload.output) return;
    const rules = String(readRuleBridgeText(app) || "").trim();
    if (!rules) return;
    const planNode = findH3PlanNode(app);
    if (!planNode) return;
    const entry = payload.output[String(planNode.id)];
    if (!entry || !entry.inputs) return;
    try {
      const plan = JSON.parse(entry.inputs.plan_json || "{}");
      const existing = String(plan.prompt_prefix || "");
      if (existing.includes(rules)) return;
      plan.prompt_prefix = existing ? `${rules}\n\n${existing}` : rules;
      entry.inputs.plan_json = JSON.stringify(plan);
    } catch (error) {
      /* plan_json 异常时不动 */
    }
  }

  function installDraftQueueHook() {
    if (typeof api.queuePrompt === "function" && !api.__sbDraftHooked) {
      const original = api.queuePrompt.bind(api);
      api.queuePrompt = function (...args) {
        if (activeDraftPatcher) activeDraftPatcher(args[1]);
        applyRulesToPayload(args[1]);
        return original(...args);
      };
      api.__sbDraftHooked = true;
    }
    activeDraftPatcher = applyDraftToPayload;
  }

  function updateDraftRow() {
    const row = el["draft-row"];
    if (!row) return;
    const info = getPlanResolution(app);
    row.hidden = !info;
    if (!info) return;
    const base = state.draftBase;
    if (base) {
      const size = draftTargetSize(base);
      el["draft-text"].textContent = `草稿（仅本次运行）${size.width}×${size.height} · ${DRAFT_STEPS} 步；分镜记录 ${info.width}×${info.height}`;
    } else {
      el["draft-text"].textContent = `成片 ${info.width}×${info.height}`;
    }
  }

  function enterDraft() {
    const info = getPlanResolution(app);
    if (!info) {
      toast("当前工作流没有 H3 计划节点", "err");
      return;
    }
    if (state.draftBase) {
      toast("已经在草稿模式；点「成片」恢复按分镜原分辨率生成", "ok");
      return;
    }
    const size = draftSize(info.width, info.height);
    state.draftBase = {
      nodeId: info.nodeId,
      width: info.width,
      height: info.height,
      draftWidth: size.width,
      draftHeight: size.height,
    };
    persist();
    renderPlanRow();
    toast(
      `草稿模式：运行时临时 ${size.width}×${size.height}、${DRAFT_STEPS} 步；分镜里仍是 ${info.width}×${info.height}，确认后点「成片」`,
      "ok"
    );
  }

  function finishDraft() {
    const base = state.draftBase;
    if (!base) {
      toast("当前已经是成片模式", "ok");
      return;
    }
    // 兼容旧版草稿：如果计划节点被改过，这里恢复成记录值
    const info = getPlanResolution(app);
    if (info && (info.width !== base.width || info.height !== base.height)) {
      setPlanResolution(app, base.width, base.height);
    }
    state.draftBase = null;
    persist();
    renderPlanRow();
    toast(`成片模式：按分镜记录的 ${base.width}×${base.height} 生成`, "ok");
  }

  function renderPlanRow() {
    const row = el["plan-row"];
    if (!row) return;
    const info = planInfoSafe();
    if (!info || !info.shots.length) {
      row.hidden = true;
      if (el["frame-row"]) el["frame-row"].hidden = !!findFrameInput(app, "first");
      updateDraftRow();
      return;
    }
    row.hidden = false;
    if (el["frame-row"]) {
      el["frame-row"].hidden = !!findFrameInput(app, "first") || !findImageEntry(app);
    }
    let index = state.planIndex;
    if (index == null || index < 0 || index >= info.shots.length) {
      index = Math.min(Math.max(0, info.active), info.shots.length - 1);
    }
    state.planIndex = index;
    const options = info.shots.map((shot, i) => {
      const id = shot && shot.id ? shot.id : `#${i + 1}`;
      const preview = String((shot && shot.prompt) || "").replace(/\s+/g, " ").slice(0, 26);
      return `<option value="${i}">${escapeHtml(`${i + 1}. ${id}${preview ? " · " + preview : ""}`)}</option>`;
    });
    el["plan-label"].textContent = `H3 计划 ${index + 1}/${info.shots.length}${
      index === info.shots.length - 1 ? "（末镜）" : ""
    }`;
    el["plan-shot"].innerHTML = options.join("");
    el["plan-shot"].value = String(index);
    updateDraftRow();
  }

  function advancePlanAfterApply() {
    const info = planInfoSafe();
    if (!info || info.shots.length <= 1) return;
    state.planIndex = Math.min((state.planIndex == null ? info.active : state.planIndex) + 1, info.shots.length - 1);
    renderPlanRow();
  }

  /** 单元编号统一成 S02-U05（兼容文档里的 2-05 写法） */
  function unitFrameId(unit) {
    const id = String(unit && unit.id ? unit.id : "")
      .trim()
      .toUpperCase();
    const full = /^S(\d{1,2})-U(\d{1,3})$/.exec(id);
    if (full) return `S${full[1].padStart(2, "0")}-U${full[2].padStart(2, "0")}`;
    const legacy = /^(\d{1,2})-(\d{1,3})$/.exec(id);
    if (legacy) return `S${legacy[1].padStart(2, "0")}-U${legacy[2].padStart(2, "0")}`;
    return id;
  }

  /** 本镜的首/尾帧素材（同类型取版本号最大的） */
  function pickUnitFrame(unit, kind) {
    const target = unitFrameId(unit);
    if (!target) return null;
    return (
      libraryFiles()
        .filter((entry) => entry.frame && entry.frame.unit === target && entry.frame.kind === kind)
        .sort((a, b) => b.frame.version - a.frame.version)[0] || null
    );
  }

  /** 帧图按原图上传（不做白底抠图） */
  async function uploadFrameAsset(entry) {
    if (!entry) return null;
    if (entry.uploadedFrameName) return entry.uploadedFrameName;
    const file = fileHandles.get(entry.path);
    if (!file) return null;
    try {
      const form = new FormData();
      form.append("image", file, entry.name);
      form.append("overwrite", "true");
      const response = await fetch("/upload/image", { method: "POST", body: form });
      if (!response.ok) return null;
      const data = await response.json();
      const name = data && data.name ? (data.subfolder ? `${data.subfolder}/${data.name}` : data.name) : "";
      if (!name) return null;
      entry.uploadedFrameName = name;
      return name;
    } catch (error) {
      return null;
    }
  }

  /** 把本镜的首/尾帧素材写到工作流的 first_frame / last_frame 输入 */
  async function applyUnitFrames(unit) {
    const hasFirst = !!findFrameInput(app, "first");
    const hasLast = !!findFrameInput(app, "last");
    if (!hasFirst && !hasLast) return { ok: true, message: "" };
    const first = pickUnitFrame(unit, "first");
    const last = pickUnitFrame(unit, "last");
    const parts = [];
    let ok = true;
    for (const [kind, hasInput, pick] of [
      ["first", hasFirst, first],
      ["last", hasLast, last],
    ]) {
      if (!hasInput) continue;
      const label = kind === "first" ? "首帧" : "尾帧";
      if (!pick) {
        if (clearFrameImage(app, kind)) parts.push(`已清空上一镜${label}`);
        continue;
      }
      const name = await uploadFrameAsset(pick);
      if (!name) {
        ok = false;
        parts.push(`${label} ${pick.name} 上传失败`);
        continue;
      }
      const result = writeFrameImage(app, kind, name);
      if (result.ok) parts.push(`${label} ${pick.name} 已写入`);
      else {
        ok = false;
        parts.push(`${label}：${result.message}`);
      }
    }
    if (last && !first) parts.push("缺首帧素材（规则要求首帧未出不开视频）");
    return { ok, message: parts.join("；") };
  }

  /** 本镜要用的素材：同一个编号的多个视角全部带上；同名变体只取版本号最大的 */
  function unitReferenceCodes(unit) {
    const usedFiles = new Set();
    const picks = [];
    for (const code of unit.assets || []) {
      const best = new Map();
      for (const entry of libraryFiles()) {
        if (!entry.image || entry.frame) continue;
        if (!(entry.codes || []).includes(code)) continue;
        const stem = entry.name.replace(/\.\w+$/, "");
        const versioned = /^(.*)_v(\d{2})$/i.exec(stem);
        const key = versioned ? versioned[1].toLowerCase() : stem.toLowerCase();
        const version = versioned ? Number(versioned[2]) : 0;
        const prev = best.get(key);
        if (!prev || version > prev.version) best.set(key, { entry, version });
      }
      for (const item of best.values()) {
        if (usedFiles.has(item.entry.path)) continue;
        usedFiles.add(item.entry.path);
        picks.push({ code, entry: item.entry });
      }
    }
    return picks;
  }

  /** 参考位是否真的把素材送到了 Ref2V（Set/Get 链看加载窗口，直连看输入口） */
  function slotWired(slot) {
    if (!slot) return false;
    if (slot.setter) return !!(slot.loader && slot.loader.mode === 0);
    return slot.input.link !== null && slot.input.link !== undefined;
  }

  /** 参考位里现在写着的文件名（空 / None 都算没写） */
  function slotValue(slot, name = "image") {
    const loader = slot && slot.loader;
    const widget = loader ? (loader.widgets || []).find((item) => item && item.name === name) : null;
    const value = widget ? String(widget.value || "").trim() : "";
    return /^none$/i.test(value) ? "" : value;
  }

  /** 本镜素材是不是已经按顺序待在各参考位里（重复点「应用这一镜」时用来跳过，不做任何动作） */
  function referenceSlotsMatch(list, picks) {
    if (picks.length > list.length) return false;
    const expected = picks.map((pick) => pick.entry.uploadedName || pick.entry.name);
    return list.every((slot, index) => {
      if (index < expected.length) {
        if (!slotWired(slot) || !slot.loader || slot.loader.mode !== 0) return false;
        return slotValue(slot) === expected[index];
      }
      // 多出来的参考位：桥到 Ref2V 的线保留，但桥入口不能接窗口、窗口里也不能留旧图
      if (slot.bridge) return !slot.loader;
      // Set/Get 链：窗口清空并停用（GetNode 会拿到 None），GetNode → Ref2V 的线不动
      if (slot.setter) return !slotValue(slot) && (!slot.loader || slot.loader.mode === 4);
      if (slot.input.link !== null && slot.input.link !== undefined) return false;
      return !slotValue(slot);
    });
  }

  /** 本镜素材没被用上时，把原因写清楚（否则看起来像「没加载」） */
  function noPickMessage(unit) {
    const codes = unit.assets || [];
    if (!codes.length) return "本镜没有素材，参考位保持为空";
    const images = libraryFiles().filter((entry) => entry.image && !entry.frame).length;
    return images
      ? `本镜素材 ${codes.join("、")} 在素材库里没找到（库里 ${images} 张图，检查文件名里的编号）`
      : `本镜素材 ${codes.join("、")} 还没有素材库：先点顶部「素材库」选文件夹`;
  }

  /** 原生 Ref2V：把本镜素材按顺序写进 Picture 1..N，多余参考位断开 */
  async function applyReferenceImagesToUnit(unit, slots) {
    let list = slots || referenceImageSlots(app);
    if (!list.length) return { ok: true, message: "工作流里没有 Ref2V 参考位（Picture）" };
    const picks = unitReferenceCodes(unit);
    // 手动取的上一镜末帧排在参考图最后一位
    const extra = continuityPick(unit);
    if (extra) picks.push(extra);
    if (picks.length > list.length) list = ensureReferenceSlots(app, picks.length);
    // 素材连接参考条件必须经过规则桥（没有就自动插入并改接）
    list = routeReferenceSlotsThroughBridge(app);
    writeRuleBridgeText(app, referenceRulePrefix(Math.max(1, list.length)));
    // 本镜素材已经全部待在对的参考位里：重复点击不再清空、不再上传
    if (referenceSlotsMatch(list, picks)) {
      return {
        ok: true,
        message: picks.length
          ? `本镜素材 ${picks.length} 张已在参考位里，未重复加载`
          : noPickMessage(unit),
      };
    }
    // 记住每个位置原来接的加载窗口，写入时原地复用（不新增窗口）
    const previousLoaders = list.map((slot) => slot.loader || null);
    const used = Math.min(picks.length, list.length);
    const parts = [`本镜素材 ${picks.length} 张 / 参考位 ${list.length} 个`];
    let filled = 0;
    let kept = 0;
    let created = 0;
    let offline = 0;
    const failed = [];
    // 逐位比对：已经对上的窗口原地不动，只处理新增或变了的素材
    for (let index = 0; index < used; index += 1) {
      const slot = list[index];
      const expected = picks[index].entry.uploadedName || picks[index].entry.name;
      const loader = slot.loader;
      if (loader && loader.mode === 0 && slotValue(slot) === expected && slotWired(slot)) {
        kept += 1;
        filled += 1;
        continue;
      }
      const name = await uploadAsset(picks[index].entry);
      if (!name) {
        if (!picks[index].entry.uploadedName && !fileHandles.has(picks[index].entry.path)) offline += 1;
        failed.push(picks[index].entry.name);
        continue;
      }
      let result;
      try {
        result = ensureReferenceImage(app, list[index], name, previousLoaders[index]);
      } catch (error) {
        result = { ok: false, message: "写入参考位失败" };
      }
      if (result.ok) {
        filled += 1;
        if (result.created) created += 1;
      } else {
        failed.push(picks[index].entry.name);
      }
    }
    // 只保留写上了素材的窗口：规则桥上 Picture (picks.length+1) 起的入口全部断开
    const clearResult = await clearPictureSlotsFrom(app, picks.length);
    let cleared = clearResult.cleared;
    // 需要却没写对的位也断开，避免串用上一镜的图
    for (const slot of referenceImageSlots(app)) {
      if (slot.index >= picks.length) continue;
      const pick = picks[slot.index];
      const expected = pick ? pick.entry.uploadedName || pick.entry.name : "";
      if (expected && slotValue(slot) === expected) continue;
      try {
        if (clearReferenceSlot(app, slot)) cleared += 1;
      } catch (error) {
        /* 单路失败不影响其它路 */
      }
    }
    // 断开只在 9 个窗口 ↔ 规则桥之间做；再补一遍「规则桥 → Ref2V」，保证这条链一直完整
    routeReferenceSlotsThroughBridge(app);
    const idle = pruneIdleLoaders(app);
    if (kept) parts.push(`沿用 ${kept} 张`);
    const written = filled - kept;
    if (written) parts.push(`写入 ${written} 张`);
    if (cleared) parts.push(`已清空 ${cleared} 个无素材参考位`);
    if (clearResult.left) parts.push(`还有 ${clearResult.left} 根多余连线没断开`);
    if (idle) parts.push(`清空 ${idle} 个未使用的加载窗口`);
    if (failed.length) parts.push(`失败 ${failed.length} 张：${failed.slice(0, 3).join("、")}`);
    if (offline) parts.push("素材文件不在当前会话（刷新过页面），重新点一次「素材库」选文件夹即可");
    if (created) parts.push(`新建 ${created} 个加载窗口（画布上没有可复用的空闲窗口）`);
    if (picks.length > list.length) {
      parts.push(`参考位只有 ${list.length} 个，第 ${list.length + 1} 张起的素材没接上`);
    }
    return { ok: filled > 0 || !picks.length, message: parts.join("；") };
  }

  /** 原生 Ref2V：把本镜的参考音频按顺序写到 ref_audios.ref_audio_0..N，多余的断开 */
  async function applyUnitAudio(unit) {
    const slots = referenceAudioSlots(app);
    if (!slots.length) return { ok: true, message: "" };
    const picks = unitAudioPicks(unit);
    if (!picks.length) {
      const cleared = clearAudioSlotsFrom(app, 0);
      return { ok: true, message: cleared ? `已清空上一镜的 ${cleared} 个参考音频` : "" };
    }
    const limit = Math.min(picks.length, slots.length);
    const parts = [];
    const failed = [];
    let written = 0;
    let offline = 0;
    for (let index = 0; index < limit; index += 1) {
      const name = await uploadAsset(picks[index].entry);
      if (!name) {
        if (!picks[index].entry.uploadedName && !fileHandles.has(picks[index].entry.path)) offline += 1;
        failed.push(picks[index].entry.name);
        continue;
      }
      const result = ensureReferenceAudio(app, index, name);
      if (result.ok) written += 1;
      else failed.push(picks[index].entry.name);
    }
    const cleared = clearAudioSlotsFrom(app, limit);
    if (written) parts.push(`参考音频 ${written} 个已接上`);
    if (cleared) parts.push(`断开 ${cleared} 个旧音频`);
    if (failed.length) parts.push(`音频失败：${failed.slice(0, 2).join("、")}`);
    if (offline) parts.push("音频文件不在当前会话，重新点一次「素材库」选文件夹即可");
    if (picks.length > slots.length) parts.push(`参考音频位只有 ${slots.length} 个`);
    return { ok: !failed.length, message: parts.join("；") };
  }

  /** 同场的前一镜（跨场不接，避免把上一场的环境带进新场） */
  function previousUnit(unit) {
    const units = state.doc ? state.doc.units : [];
    const at = units.findIndex((item) => item.id === unit.id);
    if (at <= 0) return null;
    const prev = units[at - 1];
    return prev && prev.scene === unit.scene ? prev : null;
  }

  /** 本镜手动从上一镜末帧取的图（卡片上的「取上一镜末帧」） */
  function continuityPick(unit) {
    const saved = state.continuity[unit.id];
    if (!saved || !saved.name) return null;
    const entry = libraryStore.files.find((item) => item.name === saved.name);
    if (!entry) return null;
    return { code: saved.from || "", entry, continuity: true, cropped: !!saved.cropped };
  }

  /** 输出目录里的视频用 annotated 路径交给 VHS_LoadVideo */
  function annotatedVideoName(shot) {
    const path = shot.subfolder ? `${shot.subfolder}/${shot.filename}` : shot.filename;
    return shot.type && shot.type !== "input" ? `[${shot.type}]${path}` : path;
  }

  /** 上一镜视频是否真的能从 /view 读到：读不到就别接，免得整镜排队失败 */
  async function videoReachable(shot) {
    if (!shot || !shot.filename) return false;
    try {
      const query = new URLSearchParams({
        filename: shot.filename,
        subfolder: shot.subfolder || "",
        type: shot.type || "output",
      });
      const url = typeof api.apiURL === "function" ? api.apiURL(`/view?${query.toString()}`) : `/view?${query}`;
      const response = await fetch(url, { method: "HEAD", cache: "no-store" });
      return response.ok;
    } catch (error) {
      return false;
    }
  }

  /**
   * 让后端把上一镜视频转存到 input/storyboard_ref，返回 VHS 可用的普通路径。
   * 返回 null = 后端不支持这个接口（退回 [output] 方案）；"" = 文件确实不可用。
   */
  async function stageVideoForLoad(shot) {
    if (!shot || !shot.filename) return "";
    try {
      const response = await api.fetchApi("/storyboard/ref-video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: shot.filename,
          subfolder: shot.subfolder || "",
          type: shot.type || "output",
        }),
      });
      if (response.status === 404) return null;
      const data = await response.json().catch(() => null);
      return data && data.ok && data.name ? data.name : "";
    } catch (error) {
      return null;
    }
  }

  /**
   * 跨镜衔接：把上一镜生成出来的视频接到 ref_videos.ref_video_0（提示词里的 <Video 1>）。
   * 只有同一场才接；视频读不到就跳过，绝不让整批自动模式停在一镜上。
   */
  async function applyUnitVideo(unit) {
    lastVideoBound = null;
    if (!referenceVideoSlots(app).length) return { ok: true, message: "" };
    if (settings().continuityVideo === false) {
      const cleared = clearVideoSlotsFrom(app, 0);
      return { ok: true, message: cleared ? "已关闭跨镜接续，清空参考视频" : "" };
    }
    const prev = previousUnit(unit);
    const shot = prev ? state.shots[prev.id] : null;
    if (!prev || !shot || !shot.filename) {
      const cleared = clearVideoSlotsFrom(app, 0);
      return { ok: true, message: cleared ? `已断开上一镜的参考视频（${cleared} 路）` : "" };
    }
    // 先让后端转存到 input；文件不在了就跳过接续，别让 VHS 校验把整批停下
    const staged = await stageVideoForLoad(shot);
    if (staged === "") {
      delete state.shots[prev.id];
      persist();
      const cleared = clearVideoSlotsFrom(app, 0);
      return {
        ok: true,
        message: `上一镜视频 ${shot.filename} 不在服务器上，已跳过接续${cleared ? "并清空视频位" : ""}`,
      };
    }
    if (!staged && !(await videoReachable(shot))) {
      const cleared = clearVideoSlotsFrom(app, 0);
      return {
        ok: true,
        message: `上一镜视频读不到（${shot.filename}），已跳过接续${cleared ? "并清空视频位" : ""}`,
      };
    }
    const result = ensureReferenceVideo(app, 0, staged || annotatedVideoName(shot));
    if (!result.ok) return { ok: true, message: `参考视频没接上：${result.message}` };
    lastVideoBound = { unitId: prev.id, filename: shot.filename };
    return { ok: true, message: `参考视频 ← ${prev.id}` };
  }

  // ---------- 取上一镜末帧：可拖框裁出局部（跨景别时当局部参考） ----------

  let sampler = null; // { unit, prev, image, rect, wrap }

  function closeSampler() {
    if (sampler && sampler.wrap && sampler.wrap.parentNode) sampler.wrap.parentNode.removeChild(sampler.wrap);
    sampler = null;
  }

  function openSampler(unit) {
    const prev = previousUnit(unit);
    const shot = prev ? state.shots[prev.id] : null;
    if (!prev || !shot || !shot.filename) {
      toast("上一镜还没有可用的输出视频", "err");
      return;
    }
    closeSampler();
    const query = new URLSearchParams({
      filename: shot.filename,
      subfolder: shot.subfolder || "",
      type: shot.type || "output",
    });
    const url = typeof api.apiURL === "function" ? api.apiURL(`/view?${query.toString()}`) : `/view?${query}`;
    const wrap = document.createElement("div");
    wrap.className = "sb-modal";
    wrap.innerHTML = `
      <div class="sb-modal-box">
        <div class="sb-modal-head">
          <b>取上一镜末帧</b>
          <span class="sb-hint">${escapeHtml(prev.id)} · ${escapeHtml(shot.filename)}</span>
          <button class="sb-btn dim" data-sampler="close">×</button>
        </div>
        <div class="sb-modal-canvas"><canvas data-el="sampler-canvas"></canvas></div>
        <div class="sb-modal-foot">
          <span class="sb-hint grow" data-el="sampler-info">正在读取视频…</span>
          <button class="sb-btn" data-sampler="reset">整帧</button>
          <button class="sb-btn primary" data-sampler="ok">插入本镜参考</button>
        </div>
      </div>`;
    root.appendChild(wrap);
    sampler = { unit, prev, image: null, rect: null, wrap };
    const canvas = wrap.querySelector('[data-el="sampler-canvas"]');
    const info = wrap.querySelector('[data-el="sampler-info"]');
    canvas.width = 640;
    canvas.height = 360;
    bindSamplerEvents(wrap, canvas, info);
    loadSamplerFrame(url, canvas, info);
  }

  /** 用隐藏的 <video> 抽最后一帧画进 canvas（不需要 ffmpeg） */
  function loadSamplerFrame(url, canvas, info) {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = url;
    const fail = () => {
      if (info) info.textContent = "浏览器读不了这个视频：可以在剪辑软件里截一帧拖进素材库";
    };
    video.addEventListener("error", fail, { once: true });
    video.addEventListener(
      "loadedmetadata",
      () => {
        try {
          video.currentTime = Math.max(0, (video.duration || 1) - 0.08);
        } catch (error) {
          fail();
        }
      },
      { once: true }
    );
    video.addEventListener(
      "seeked",
      () => {
        if (!sampler) return;
        const max = 1280;
        const scale = Math.min(1, max / Math.max(1, video.videoWidth || max));
        const image = document.createElement("canvas");
        image.width = Math.max(2, Math.round((video.videoWidth || 640) * scale));
        image.height = Math.max(2, Math.round((video.videoHeight || 360) * scale));
        image.getContext("2d").drawImage(video, 0, 0, image.width, image.height);
        sampler.image = image;
        drawSampler(canvas, info);
      },
      { once: true }
    );
  }

  /** 画底图 + 选区；选区存的是原图像素坐标 */
  function drawSampler(canvas, info) {
    const st = sampler;
    if (!st || !st.image) return;
    const box = canvas.parentElement ? canvas.parentElement.clientWidth : 640;
    const width = Math.max(240, Math.min(760, box - 2));
    const scale = width / st.image.width;
    canvas.width = Math.max(2, Math.round(st.image.width * scale));
    canvas.height = Math.max(2, Math.round(st.image.height * scale));
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(st.image, 0, 0, canvas.width, canvas.height);
    if (st.rect) {
      const k = canvas.width / st.image.width;
      const x = st.rect.x * k;
      const y = st.rect.y * k;
      const w = st.rect.w * k;
      const h = st.rect.h * k;
      ctx.fillStyle = "rgba(0,0,0,.45)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.clearRect(x, y, w, h);
      ctx.drawImage(st.image, st.rect.x, st.rect.y, st.rect.w, st.rect.h, x, y, w, h);
      ctx.strokeStyle = "#3b82f6";
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, w, h);
    }
    updateSamplerInfo(info);
  }

  function updateSamplerInfo(info) {
    if (!info || !sampler || !sampler.image) return;
    const rect = sampler.rect;
    info.textContent = rect
      ? `选区 ${Math.round(rect.w)}×${Math.round(rect.h)} 像素，拖框可重选`
      : `整帧 ${sampler.image.width}×${sampler.image.height}，在画面上拖框可裁出局部`;
  }

  function bindSamplerEvents(wrap, canvas, info) {
    let start = null;
    const toCanvas = (event) => {
      const rect = canvas.getBoundingClientRect();
      const width = canvas.width || 1;
      const height = canvas.height || 1;
      return {
        x: Math.max(0, Math.min(width, ((event.clientX - rect.left) / Math.max(1, rect.width)) * width)),
        y: Math.max(0, Math.min(height, ((event.clientY - rect.top) / Math.max(1, rect.height)) * height)),
      };
    };
    canvas.addEventListener("pointerdown", (event) => {
      if (!sampler || !sampler.image) return;
      event.preventDefault();
      start = toCanvas(event);
      sampler.rect = null;
      drawSampler(canvas, info);
    });
    canvas.addEventListener("pointermove", (event) => {
      if (!start || !sampler || !sampler.image) return;
      const at = toCanvas(event);
      const k = sampler.image.width / (canvas.width || 1);
      const x = Math.min(start.x, at.x) * k;
      const y = Math.min(start.y, at.y) * k;
      const w = Math.abs(at.x - start.x) * k;
      const h = Math.abs(at.y - start.y) * k;
      sampler.rect = w > 4 && h > 4 ? { x, y, w, h } : null;
      drawSampler(canvas, info);
    });
    const end = () => {
      start = null;
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
    wrap.addEventListener("click", (event) => {
      const action = event.target.closest("[data-sampler]");
      if (!action) return;
      const cmd = action.dataset.sampler;
      if (cmd === "close") closeSampler();
      else if (cmd === "reset") {
        if (sampler) sampler.rect = null;
        drawSampler(canvas, info);
      } else if (cmd === "ok") commitSampler();
    });
  }

  /** 裁图上传后进素材库，并绑定到本镜最后一个参考位 */
  async function commitSampler() {
    const st = sampler;
    if (!st || !st.image) {
      toast("视频还没读出来，等一秒再点", "err");
      return;
    }
    const image = st.image;
    const rect = st.rect;
    const sx = rect ? Math.max(0, Math.round(rect.x)) : 0;
    const sy = rect ? Math.max(0, Math.round(rect.y)) : 0;
    const sw = rect ? Math.min(image.width - sx, Math.round(rect.w)) : image.width;
    const sh = rect ? Math.min(image.height - sy, Math.round(rect.h)) : image.height;
    if (sw < 24 || sh < 24) {
      toast("选区太小了，重新框一下", "err");
      return;
    }
    const cropped = sw < image.width - 2 || sh < image.height - 2;
    const out = document.createElement("canvas");
    out.width = sw;
    out.height = sh;
    out.getContext("2d").drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
    const blob = await new Promise((resolve) => out.toBlob(resolve, "image/png"));
    if (!blob) {
      toast("截图失败", "err");
      return;
    }
    // 不能用 _last_v01 命名：那会被当成上一镜自己的尾帧
    const name = `${st.prev.id}_contin${cropped ? "_crop" : ""}_v01.png`;
    const file = new File([blob], name, { type: "image/png" });
    const form = new FormData();
    form.append("image", file, name);
    form.append("overwrite", "true");
    let uploaded = "";
    try {
      const response = await api.fetchApi("/upload/image", { method: "POST", body: form });
      if (response.ok) {
        const data = await response.json();
        uploaded = data && data.name ? (data.subfolder ? `${data.subfolder}/${data.name}` : data.name) : "";
      }
    } catch (error) {
      uploaded = "";
    }
    if (!uploaded) {
      toast("上传失败：确认 ComfyUI 正在运行", "err");
      return;
    }
    const entry = {
      name,
      path: `session:${name}`,
      image: true,
      audio: false,
      frame: true,
      codes: [st.prev.id],
      units: [st.prev.id],
      uploadedName: uploaded,
      note: `上一镜 ${st.prev.id} 末帧${cropped ? "局部" : ""}`,
    };
    libraryStore.files = [entry, ...libraryStore.files.filter((item) => item.name !== name)];
    saveLibraryStore();
    state.continuity[st.unit.id] = { name, uploadedName: uploaded, cropped, from: st.prev.id };
    persist();
    closeSampler();
    renderList();
    toast(`${name} 已入库，应用这一镜时会接在参考图最后一位`, "ok");
  }

  /** 按工作流的素材入口选择：先写首尾帧，再按 Ref2V 参考位或首帧处理素材 */
  async function applyVisualToUnit(unit) {
    const video = await applyUnitVideo(unit);
    const frames = await applyUnitFrames(unit);
    const audio = await applyUnitAudio(unit);
    const slots = referenceImageSlots(app);
    const refs = slots.length
      ? await applyReferenceImagesToUnit(unit, slots)
      : await applyImageToUnit(unit);
    const message = [video.message, frames.message, refs.message, audio.message].filter(Boolean).join("；");
    return { ok: video.ok && frames.ok && refs.ok && audio.ok, message };
  }

  async function applyImageToUnit(unit) {
    // 工作流有独立首帧入口时，素材不再兼作首帧（首帧只认 S02-U05_first 这类命名）
    if (findFrameInput(app, "first")) return { ok: true, message: "" };
    const explicit = state.images[unit.id];
    const matches = libraryMatches(unit).filter((item) => item.image);

    // 本镜没有素材
    if (!explicit && !matches.length) {
      // H3 计划里首帧是整条链的锚点，不随单个分镜清空；普通工作流才清掉上一镜残留
      if (planInfoSafe()) return { ok: true, message: "" };
      const entry = findImageEntry(app);
      if (entry && entry.kind === "loader" && lastAppliedImage && String(entry.node.id) === lastAppliedImage.nodeId) {
        const widget = (entry.node.widgets || []).find((item) => item && item.name === "image");
        if (widget && String(widget.value) === lastAppliedImage.value) {
          const cleared = lastAppliedImage.value;
          setNodeImage(app, entry.node, "");
          lastAppliedImage = null;
          loadImageFiles();
          return { ok: true, message: `已清空上一镜首帧 ${cleared}（本镜没有素材）` };
        }
      }
      lastAppliedImage = null;
      return { ok: true, message: "" };
    }

    // 先把本镜素材上传到 ComfyUI 的 input 目录（入口有没有都不影响上传）
    const uploaded = [];
    for (const item of matches) {
      const name = await uploadAsset(item);
      if (name) uploaded.push({ entry: item, name });
    }
    if (matches.length && !uploaded.length) {
      return { ok: false, message: "素材上传失败：请确认 ComfyUI 正在运行" };
    }

    const preferred =
      (explicit ? { name: explicit } : null) ||
      uploaded.find((item) => item.entry.units.includes(unit.id)) ||
      uploaded.find((item) => item.entry.codes.some((code) => /^S-/.test(code))) ||
      uploaded[0];
    if (!preferred) return { ok: true, message: "" };

    // 自动找入口：已有加载图像节点，或图生视频节点的首帧输入（没接线就自动新建加载图像并接上）
    const entry = findImageEntry(app);
    const target = ensureImageEntry(app, entry);
    const count = uploaded.length ? `素材已上传 ${uploaded.length} 张，` : "";
    if (target && setNodeImage(app, target, preferred.name)) {
      lastAppliedImage = { nodeId: String(target.id), value: String(preferred.name) };
      loadImageFiles();
      return { ok: true, message: `${count}首帧 ${preferred.name} → ${describeImageEntry({ kind: "loader", node: target })}` };
    }
    return {
      ok: true,
      message: `${count}首帧 ${preferred.name} 已上传，但该工作流没有可写入的图像入口（纯文生视频），已跳过`,
    };
  }

  /** 从四边泛洪去掉白色背景，再以所选底色合成（LoadImage 只取 RGB，透明会被丢掉） */
  function cutoutFile(file, bgColor) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        try {
          const width = img.naturalWidth;
          const height = img.naturalHeight;
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          ctx.drawImage(img, 0, 0);
          const imageData = ctx.getImageData(0, 0, width, height);
          const data = imageData.data;
          const total = width * height;
          const removed = new Uint8Array(total);
          const stack = [];
          const push = (x, y) => {
            const index = y * width + x;
            if (removed[index]) return;
            const p = index * 4;
            const r = data[p];
            const g = data[p + 1];
            const b = data[p + 2];
            if (Math.min(r, g, b) < 228) return;
            if (Math.max(r, g, b) - Math.min(r, g, b) > 26) return;
            removed[index] = 1;
            stack.push(index);
          };
          for (let x = 0; x < width; x += 1) {
            push(x, 0);
            push(x, height - 1);
          }
          for (let y = 0; y < height; y += 1) {
            push(0, y);
            push(width - 1, y);
          }
          while (stack.length) {
            const index = stack.pop();
            const x = index % width;
            const y = (index - x) / width;
            if (x > 0) push(x - 1, y);
            if (x + 1 < width) push(x + 1, y);
            if (y > 0) push(x, y - 1);
            if (y + 1 < height) push(x, y + 1);
          }
          const rgb = [
            parseInt(bgColor.slice(1, 3), 16),
            parseInt(bgColor.slice(3, 5), 16),
            parseInt(bgColor.slice(5, 7), 16),
          ];
          // 边缘 1px 混色，减少白边
          for (let index = 0; index < total; index += 1) {
            if (removed[index]) continue;
            const x = index % width;
            const edge =
              (x > 0 && removed[index - 1]) ||
              (x + 1 < width && removed[index + 1]) ||
              (index >= width && removed[index - width]) ||
              (index + width < total && removed[index + width]);
            if (!edge) continue;
            const p = index * 4;
            data[p] = Math.round(data[p] * 0.5 + rgb[0] * 0.5);
            data[p + 1] = Math.round(data[p + 1] * 0.5 + rgb[1] * 0.5);
            data[p + 2] = Math.round(data[p + 2] * 0.5 + rgb[2] * 0.5);
          }
          for (let index = 0; index < total; index += 1) {
            if (!removed[index]) continue;
            const p = index * 4;
            data[p] = rgb[0];
            data[p + 1] = rgb[1];
            data[p + 2] = rgb[2];
            data[p + 3] = 255;
          }
          ctx.putImageData(imageData, 0, 0);
          canvas.toBlob((blob) => resolve(blob), "image/png");
        } catch (error) {
          resolve(null);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(null);
      };
      img.src = url;
    });
  }

  function resetUploads() {
    libraryFiles().forEach((entry) => {
      entry.uploadedName = "";
    });
    librarySync = null;
    saveLibraryStore();
    persist();
  }

  async function uploadAsset(entry, persistNow = true) {
    if (entry.uploadedName) return entry.uploadedName;
    if (!entry.image && !entry.audio) return null;
    let file = fileHandles.get(entry.path);
    if (!file) return null;
    let uploadName = entry.name;
    if (entry.image && settings().cutout) {
      try {
        const blob = await cutoutFile(file, settings().cutoutBg || "#000000");
        if (blob) {
          uploadName = `${entry.name.replace(/\.[^.]+$/, "")}_cut.png`;
          file = new File([blob], uploadName, { type: "image/png" });
        }
      } catch (error) {
        /* 抠图失败就用原图 */
      }
    }
    try {
      const form = new FormData();
      form.append("image", file, uploadName);
      form.append("overwrite", "true");
      const response = await fetch("/upload/image", { method: "POST", body: form });
      if (!response.ok) return null;
      const data = await response.json();
      const name = data && data.name ? (data.subfolder ? `${data.subfolder}/${data.name}` : data.name) : "";
      if (!name) return null;
      entry.uploadedName = name;
      if (persistNow) {
        saveLibraryStore();
        persist();
      }
      return name;
    } catch (error) {
      return null;
    }
  }

  function libraryStatusText() {
    const entries = libraryFiles().filter((entry) => entry.image || entry.audio);
    if (librarySync) {
      const { total, done, uploaded, failed, running } = librarySync;
      if (running) return `正在上传素材到 ComfyUI：${done}/${total}${failed ? `，失败 ${failed}` : ""}…`;
      return `素材上传完成：${uploaded}/${total} 个已进 ComfyUI input${failed ? `，${failed} 个失败` : ""}`;
    }
    if (!entries.length) return "";
    const uploaded = entries.filter((entry) => entry.uploadedName).length;
    return uploaded === entries.length
      ? `素材已在 ComfyUI input：${uploaded}/${entries.length} 个`
      : `已上传 ${uploaded}/${entries.length} 个；点「上传素材」补齐`;
  }

  /** 状态文字 + 上传进度条；元素可能被重建，所以每次都从 root 重新取 */
  function setLibraryStatus() {
    const node = root.querySelector('[data-el="library-text"]');
    if (node) node.textContent = libraryStatusText();
    const wrap = root.querySelector('[data-el="upload-progress"]');
    if (!wrap) return;
    const entries = libraryFiles().filter((entry) => entry.image || entry.audio);
    if (!entries.length) {
      wrap.hidden = true;
      return;
    }
    const total = entries.length;
    const uploaded = entries.filter((entry) => entry.uploadedName).length;
    const done = librarySync ? Math.max(librarySync.done, uploaded) : uploaded;
    const percent = total ? Math.round((done / total) * 100) : 0;
    wrap.hidden = false;
    wrap.classList.toggle("done", percent >= 100);
    const text = wrap.querySelector('[data-el="upload-text"]');
    if (text) {
      const failed = librarySync && librarySync.failed ? librarySync.failed : 0;
      const running = librarySync && librarySync.running;
      // 服务器上传慢，成功数可能长时间是 0，所以把已处理数一起显示，让用户看到进度在动
      text.textContent = `已上传 ${uploaded} / ${total} 个${running ? ` · 处理中 ${done}/${total}` : ""}${failed ? ` · 失败 ${failed}` : ""}`;
    }
    const fill = wrap.querySelector('[data-el="upload-fill"]');
    if (fill) fill.style.width = `${percent}%`;
  }

  /** 选完素材文件夹就整批传进 ComfyUI 的 input 目录：之后刷新页面也能直接用 */
  async function syncLibraryToComfy() {
    if (librarySync && librarySync.running) {
      toast("素材正在上传中，完成时会有提示", "ok");
      return;
    }
    const entries = libraryFiles().filter((entry) => entry.image || entry.audio);
    if (!entries.length) {
      toast("素材库是空的：先点「素材库」选文件夹", "err");
      return;
    }
    const pending = entries.filter((entry) => !entry.uploadedName);
    const job = {
      total: entries.length,
      done: entries.length - pending.length,
      uploaded: entries.length - pending.length,
      failed: 0,
      running: true,
      cancelled: false,
    };
    librarySync = job;
    libraryListener();
    if (!pending.length) {
      job.running = false;
      libraryListener();
      renderAssets();
      toast(`素材已经在 ComfyUI input 里（${entries.length} 个），不用重复上传`, "ok");
      return;
    }
    let cursor = 0;
    const worker = async () => {
      while (cursor < pending.length) {
        const entry = pending[cursor];
        cursor += 1;
        if (job.cancelled) return;
        if (!fileHandles.has(entry.path)) {
          job.failed += 1;
        } else {
          const name = await uploadAsset(entry, false);
          if (name) job.uploaded += 1;
          else job.failed += 1;
        }
        job.done += 1;
        // 服务器上传慢时进度条要一点点走，所以每个文件完成都刷新一次
        saveLibraryStore();
        libraryListener();
      }
    };
    try {
      await Promise.all([worker(), worker(), worker(), worker()]);
    } finally {
      job.running = false;
      saveLibraryStore();
      libraryListener();
      renderAssets();
      const { uploaded, failed, total } = job;
      if (!job.cancelled) {
        toast(
          `素材已上传 ${uploaded}/${total} 个到 ComfyUI input${failed ? `，${failed} 个失败（文件不在本次会话）` : ""}`,
          failed ? "err" : "ok"
        );
      }
    }
  }

  function visibleUnits() {
    if (!state.doc) return [];
    let units = state.doc.units;
    if (state.filterScene !== "all") {
      units = units.filter((unit) => unit.scene === state.filterScene);
    }
    if (state.hideDone) {
      units = units.filter((unit) => !state.applied[unit.id]);
    }
    const keyword = state.search.trim().toLowerCase();
    if (keyword) {
      units = units.filter((unit) =>
        [unit.id, unit.promptZh, unit.promptEn, unit.audio, unit.assets.join(" ")]
          .join(" ")
          .toLowerCase()
          .includes(keyword)
      );
    }
    return units;
  }

  function paramsLine(unit, expanded) {
    const params = unit.params || cloneTierDefaults().B;
    const duration = unit.durationText || `${Math.round(params.frames / params.fps)} 秒`;
    // H3 的帧数按 24fps 落到 17k+5 网格，这里显示实际会写入的帧数
    const isH3 = !!findH3PlanNode(app);
    const seconds = Number(unit.duration) > 0 ? Number(unit.duration) : params.frames / (params.fps || 16);
    const frames = isH3 ? alignedFrames(seconds) : params.frames;
    const parts = [
      params.name,
      `${duration}（生成 ${frames} 帧${isH3 ? " · 24fps" : ""}）`,
      `${params.width}×${params.height}`,
      `${params.steps} 步`,
      `CFG ${params.cfg}`,
      `种子 ${seedLabel(settings())}`,
    ];
    if (expanded) {
      parts.push(`${params.sampler} / ${params.scheduler}`, `shift ${params.shift}`, `降噪 ${params.denoise}`, `候选 ${params.candidates}`);
    }
    return parts.join(" · ");
  }

  function cardHtml(unit) {
    const expanded = !!state.expanded[unit.id];
    const applied = !!state.applied[unit.id];
    const assets = unit.assets.length
      ? `<div class="sb-tags">${unit.assets
          .map((code) => {
            const name = assetName(code);
            return `<span class="sb-tag">${escapeHtml(code)}${name ? " " + escapeHtml(name) : ""}</span>`;
          })
          .join("")}</div>`
      : "";
    const image = state.images[unit.id];
    const imageLine = image ? `<div class="sb-line"><b>首帧图</b> ${escapeHtml(image)}</div>` : "";
    const libFiles = libraryMatches(unit);
    const libLine = libFiles.length
      ? `<div class="sb-line"><b>素材库</b> ${escapeHtml(
          libFiles
            .slice(0, 3)
            .map((entry) => entry.name)
            .join("、")
        )}${libFiles.length > 3 ? "…" : ""}</div>`
      : "";
    const firstFrame = pickUnitFrame(unit, "first");
    const lastFrame = pickUnitFrame(unit, "last");
    const prevUnit = previousUnit(unit);
    const prevShot = prevUnit ? state.shots[prevUnit.id] : null;
    const cont = state.continuity[unit.id];
    const contLine = cont
      ? `<div class="sb-line"><b>衔接帧</b> ${escapeHtml(cont.name)}${cont.cropped ? "（局部）" : ""}${
          cont.from ? ` ← ${escapeHtml(cont.from)} 末帧` : ""
        }</div>`
      : "";
    const frameLine =
      firstFrame || lastFrame
        ? `<div class="sb-line"><b>首尾帧</b> ${escapeHtml(
            `${firstFrame ? `首 ${firstFrame.name}` : "首 -"} · ${lastFrame ? `尾 ${lastFrame.name}` : "尾 -"}`
          )}${lastFrame && !firstFrame ? "（缺首帧，规则上不建议开视频）" : ""}</div>`
        : "";
    return `
      <article class="sb-card sb-tier-${unit.tier} ${applied ? "is-applied" : ""}" data-id="${escapeHtml(unit.id)}">
        <div class="sb-card-head">
          <span class="sb-code">${escapeHtml(unit.id)}</span>
          <span class="sb-tier ${unit.tier}">${unit.tier}</span>
          <span class="sb-card-meta">
            ${unit.durationText ? `<span>${escapeHtml(unit.durationText)}</span>` : ""}
            ${unit.shot ? `<span>· ${escapeHtml(unit.shot)}</span>` : ""}
            ${unit.camera ? `<span>· ${escapeHtml(unit.camera)}</span>` : ""}
          </span>
          <span class="sb-check">${applied ? "✓" : ""}</span>
        </div>
        <div class="sb-zh ${expanded ? "open" : ""}">${escapeHtml(unit.promptZh || "（无中文提示词）")}</div>
        ${unit.promptEn ? `<div class="sb-en ${expanded ? "open" : ""}">${escapeHtml(unit.promptEn)}</div>` : ""}
        ${unit.audio ? `<div class="sb-line"><b>对白／音效</b> ${escapeHtml(unit.audio)}</div>` : ""}
        ${
          unit.retention && expanded
            ? `<div class="sb-line"><b>保留</b> ${escapeHtml(unit.retention)}</div>`
            : ""
        }
        ${
          unit.continuity && expanded
            ? `<div class="sb-line"><b>接点</b> ${escapeHtml(unit.continuity)}</div>`
            : ""
        }
        ${assets}
        ${imageLine}
        ${libLine}
        ${frameLine}
        ${contLine}
        <div class="sb-params" title="采样器 ${escapeHtml(unit.params?.sampler || "")} / 调度器 ${escapeHtml(
          unit.params?.scheduler || ""
        )} · shift ${escapeHtml(unit.params?.shift ?? "")} · 降噪 ${escapeHtml(
          unit.params?.denoise ?? ""
        )} · 候选 ${escapeHtml(unit.params?.candidates ?? "")}">${escapeHtml(paramsLine(unit, expanded))}</div>
        <div class="sb-actions">
          <button class="sb-btn primary" data-act="all">① 应用这一镜</button>
          <button class="sb-btn" data-act="copy">复制提示词</button>
          ${
            prevShot
              ? `<button class="sb-btn" data-act="sample" title="从上一镜输出的最后一帧取图，可拖框裁出局部">${
                  cont ? "重取末帧" : "取上一镜末帧"
                }</button>`
              : ""
          }
          <button class="sb-btn dim" data-act="expand">${expanded ? "收起" : "更多"}</button>
        </div>
        ${
          expanded
            ? `<div class="sb-actions">
                <button class="sb-btn" data-act="prompt">只写提示词</button>
                <button class="sb-btn" data-act="params">只写参数</button>
              </div>`
            : ""
        }
        <div class="sb-msg" data-role="msg"></div>
      </article>
    `;
  }

  function renderList() {
    renderProgress();
    if (!state.doc || !state.doc.units.length) {
      if (state.raw) {
        const candidates = String(state.raw)
          .split("\n")
          .filter((line) => /S\d{1,2}\s*[-_ ]?\s*U\d+/i.test(line) || /镜号|镜头|分镜/.test(line))
          .slice(0, 6)
          .map((line) => line.trim().slice(0, 90))
          .join("\n");
        el.list.innerHTML = `
          <div class="sb-empty">
            <div><b>文件已经读进来了，但没找到“执行卡”标题。</b></div>
            <div class="sb-hint">只要标题里出现 <b>S02-U01</b> 这样的镜号就能认。下面是最小格式：</div>
            <pre class="sb-sample">### S02-U01｜8 秒｜大全｜固定机位
- **素材：**S-01 场景板
- **提示词（中）：**空教室，斜光……
- **Prompt（英）：**empty classroom, ...</pre>
            <div class="sb-hint">宽松规则：标题 # 可有可无，竖线 ｜ 或 / 都行，S02U01 也认；字段名用 素材 / 提示词 / Prompt / 对白 / 接点 开头即可。</div>
            <div class="sb-hint">文件字数：${String(state.raw).length}。下面是文件里像镜号的行：</div>
            <pre class="sb-sample">${escapeHtml(candidates || "（没找到含 S02-U01 这类镜号的行）")}</pre>
            <div class="sb-hint">文件开头（确认没导错文件）：</div>
            <pre class="sb-sample">${escapeHtml(String(state.raw).slice(0, 300))}</pre>
            <div class="sb-hint">如果你导入的是 .docx，请先在 Word 里「另存为」.md 或 .txt，再导入。</div>
          </div>`;
      } else {
        el.list.innerHTML = `
          <div class="sb-empty">
            <div><b>还没有分镜内容。</b>点右上角「导入分镜」选择 .md 文件，或把文件拖进面板、用「粘贴」贴入文本。</div>
            <div class="sb-hint">识别格式：<code>### S02-U01｜8 秒｜大全｜固定机位</code>，下接 <code>- **提示词（中）：**</code> / <code>- **Prompt（英）：**</code> 等行。</div>
            <div class="sb-hint">解析后会按场次列出每个单元，并把 A／B／C 档位参数一起算好。</div>
          </div>`;
      }
      return;
    }

    const units = visibleUnits();
    if (!units.length) {
      el.list.innerHTML = `<div class="sb-empty">没有匹配的单元。</div>`;
      return;
    }

    const limit = state.renderLimit || 80;
    const shown = units.slice(0, limit);
    let html = "";
    let lastScene = null;
    for (const unit of shown) {
      if (unit.scene !== lastScene) {
        lastScene = unit.scene;
        const scene = state.doc.scenes.find((item) => item.no === unit.scene);
        const count = scene ? scene.units.length : units.filter((u) => u.scene === unit.scene).length;
        html += `<div class="sb-scene-head">场 ${unit.scene}${
          scene && scene.name ? ` · ${escapeHtml(scene.name)}` : ""
        }<span class="sb-muted">（${count} 单元）</span></div>`;
        if (scene && scene.note) {
          html += `<div class="sb-scene-note">${escapeHtml(scene.note)}</div>`;
        }
      }
      html += cardHtml(unit);
    }
    if (units.length > shown.length) {
      html += `<button class="sb-btn sb-more" data-act="more">显示更多（还有 ${units.length - shown.length} 个）</button>`;
    }
    el.list.innerHTML = html;
  }

  function renderAll() {
    renderSummary();
    renderChips();
    renderTiers();
    renderOverview();
    renderAssets();
    renderList();
    renderNodeSelects();
    renderPlanRow();
  }

  function findUnit(id) {
    return state.doc ? state.doc.units.find((unit) => unit.id === id) : null;
  }

  function ensureTargets() {
    const ids = settings().nodeIds;
    const targets = {
      positive: getNodeById(app, ids.positive),
      negative: getNodeById(app, ids.negative),
      sampler: getNodeById(app, ids.sampler),
      latent: getNodeById(app, ids.latent),
      image: getNodeById(app, ids.image),
    };
    if (!targets.positive || !targets.sampler || !targets.latent || !targets.image) {
      const auto = autoDetectTargets(app);
      if (!targets.positive && auto.positive) {
        targets.positive = auto.positive;
        ids.positive = String(auto.positive.id);
      }
      if (!targets.negative && auto.negative) {
        targets.negative = auto.negative;
        ids.negative = String(auto.negative.id);
      }
      if (!targets.sampler && auto.sampler) {
        targets.sampler = auto.sampler;
        ids.sampler = String(auto.sampler.id);
      }
      if (!targets.latent && auto.latent) {
        targets.latent = auto.latent;
        ids.latent = String(auto.latent.id);
      }
      if (!targets.image && auto.image) {
        targets.image = auto.image;
        ids.image = String(auto.image.id);
      }
      syncNodeSelects();
    }
    return targets;
  }

  function applyPromptToUnit(unit) {
    const planNode = findH3PlanNode(app);
    const plan = planInfoSafe();
    if (plan && plan.shots.length) {
      // 参考位可能被前端收起，先按本镜素材数量补回来，再生成用途说明与规则前缀
      const need = unitReferenceCodes(unit).length;
      if (need) ensureReferenceSlots(app, need);
      // 应用前确保 Plan 里有自动生成的参考图规则
      ensurePlanRulePrefix();
      const target = state.planIndex == null ? plan.active : state.planIndex;
      const result = writeH3Shot(app, target, { prompt: buildPlanPrompt(unit, lastVideoBound) });
      if (!result.ok) return { ok: false, message: result.message };
      state.planIndex = result.index;
      renderPlanRow();
      const assetCount = (unit.assets || []).length;
      const warn =
        assetCount && !hasReferenceConditioning(app)
          ? "；注意：当前工作流没有启用的 Ref2V 节点，素材不会参与生成"
          : "";
      return {
        ok: true,
        message: `提示词已写入 H3 计划第 ${result.index + 1} 镜（${result.id}）${warn}`,
      };
    }
    if (planNode && !plan) {
      return { ok: false, message: "找到 H3 计划节点，但 plan_json 解析失败，未写入" };
    }

    const targets = ensureTargets();
    // 原生 Ref2V（终极篇）：提示词入口是 Ref2V.prompt 上游的文本节点，写英文结构
    const promptEntry = findPromptEntry(app);
    const promptNode = (promptEntry && promptEntry.textNode) || targets.positive;
    if (!promptNode) return { ok: false, message: "未找到正向提示词节点，请先打开工作流" };
    const stockRef2V = referenceImageSlots(app).length > 0;
    const text = stockRef2V
      ? buildPlanPrompt(unit, lastVideoBound)
      : buildPrompt(unit, { mode: settings().mode, quality: settings().quality });
    if (!text) return { ok: false, message: "该单元没有提示词内容" };
    if (!setPromptText(app, promptNode, text)) {
      return { ok: false, message: "正向节点没有可写入的文本控件" };
    }
    let message = stockRef2V ? `提示词已写入文本节点 #${promptNode.id}（英文结构）` : "提示词已写入";
    if (settings().syncNegative && targets.negative) {
      setPromptText(app, targets.negative, settings().negative);
      message += " + 负面词";
    }
    return { ok: true, message };
  }

  function applyParamsToUnit(unit, options = {}) {
    const plan = planInfoSafe();
    if (plan && plan.shots.length) {
      const seed = settings().randomSeed
        ? Math.floor(Math.random() * 4294967295)
        : Math.max(0, Math.floor(Number(settings().seed) || 0));
      const target = state.planIndex == null ? plan.active : state.planIndex;
      const seconds =
        Number(unit.duration) > 0
          ? Number(unit.duration)
          : Number(unit.params.frames) / (Number(unit.params.fps) || 16);
      const frames = alignedFrames(seconds);
      const steps = unit.params.steps;
      const result = writeH3Shot(app, target, { steps, seed: String(seed), length: frames });
      if (!result.ok) return { ok: false, message: result.message };
      const fpsFixed = ensureH3Fps(app);
      state.planIndex = result.index;
      renderPlanRow();
      return {
        ok: true,
        message: `H3 计划第 ${result.index + 1} 镜：步数 ${steps}、种子 ${seed}、时长 ${frames} 帧（${(frames / 24).toFixed(
          1
        )} 秒）；采样器/画幅由计划节点控制，未改${
          state.draftBase ? `；草稿运行时临时 ${DRAFT_STEPS} 步` : ""
        }${fpsFixed.length ? `；已把 H3 帧率修正为 24（节点 ${fpsFixed.join("、")}）` : ""}`,
      };
    }
    if (findH3PlanNode(app) && !plan) {
      return { ok: false, message: "找到 H3 计划节点，但 plan_json 解析失败，参数未写" };
    }

    const targets = ensureTargets();
    const result = applyUnitParams(app, unit, settings(), targets, options);
    if (!result.ok) {
      return { ok: false, message: "没找到可写入的参数控件（工作流为空？）" };
    }
    let message = `参数已写入：${result.done.join("、")}`;
    if (result.tuned) message += "；步数/CFG/采样器沿用工作流里调好的设定";
    if (result.adjusted && result.adjusted.length) {
      message += `；已按 ${result.modelName} 规则自动校正：${result.adjusted.join("、")}`;
    }
    if (result.missing.length) {
      message += `（这个工作流没有：${friendlyMissing(result.missing).join("、")}，已跳过）`;
    }
    return { ok: true, message };
  }

  function friendlyMissing(list) {
    const map = {
      宽: "画幅节点",
      高: "画幅节点",
      帧数: "画幅节点",
      时长: "时长控件",
      帧率: "帧率控件",
      输出前缀: "保存节点",
      shift: "shift 控件",
    };
    return Array.from(new Set(list.map((item) => map[item] || item)));
  }

  function markApplied(unit, ok) {
    if (ok) {
      state.applied[unit.id] = Date.now();
      persist();
    }
    if (state.hideDone && ok) {
      renderList();
    } else {
      const card = el.list.querySelector(`[data-id="${unit.id}"]`);
      if (card) {
        card.classList.toggle("is-applied", !!state.applied[unit.id]);
        const check = card.querySelector(".sb-check");
        if (check) check.textContent = state.applied[unit.id] ? "✓" : "";
      }
    }
    renderProgress();
    renderOverview();
  }

  function setCardMessage(unit, message, kind) {
    const card = el.list.querySelector(`[data-id="${unit.id}"]`);
    if (!card) return;
    const box = card.querySelector('[data-role="msg"]');
    if (!box) return;
    box.textContent = message;
    box.className = `sb-msg ${kind || ""}`;
  }

  let lastModelCheck = 0;
  let modelDownloading = false;

  const MODEL_FILE_RE = /\.(safetensors|gguf|ckpt|pt)$/i;

  function normalizeModelName(value) {
    return String(value || "")
      .replace(/\\/g, "/")
      .replace(/^\/+/, "");
  }

  /** 工作流引用的文件名是否已经存在于本地 loras 列表 */
  function modelPresent(localList, value) {
    const name = normalizeModelName(value);
    if (!name) return true;
    const base = name.split("/").pop();
    return (localList || []).some(
      (file) => file === name || file.endsWith(`/${name}`) || file === base
    );
  }

  /** 找出工作流里引用了登记模型（含等价别名）但本地缺失的控件 */
  function findModelRefs(items, localList) {
    const refs = [];
    const nodes = getNodes(app);
    for (const item of items) {
      for (const node of nodes) {
        for (const widget of node.widgets || []) {
          const value = String((widget && widget.value) || "");
          if (!value || !MODEL_FILE_RE.test(value)) continue;
          const lower = value.toLowerCase();
          const direct = value.includes(item.name);
          const alias =
            !direct &&
            (item.aliases || []).some((part) => lower.includes(String(part).toLowerCase()));
          if (!direct && !alias) continue;
          if (modelPresent(localList, value)) continue;
          refs.push({ item, node, widget, value, direct });
        }
      }
    }
    return refs;
  }

  /** 加载工作流时：引用了缺失的登记模型就自动下载；已存在则跳过 */
  async function maybeEnsureModels(force = false) {
    if (modelDownloading) return;
    const now = Date.now();
    if (!force && now - lastModelCheck < 30000) return;
    lastModelCheck = now;
    try {
      const response = await fetch("/storyboard/models/status");
      if (!response.ok) return;
      const data = await response.json();
      const items = data.items || [];
      if (!items.length) return;
      const refs = findModelRefs(items, data.loras || []);
      if (!refs.length) return;
      const names = Array.from(new Set(refs.map((ref) => ref.item.name)));

      let resultItems = [];
      if (names.some((name) => !items.find((item) => item.name === name && item.exists))) {
        modelDownloading = true;
        toast(`检测到工作流缺少模型，开始自动下载：${names.join("、")}`, "ok");
        const ensure = await fetch("/storyboard/models/ensure", { method: "POST" });
        if (ensure.ok) {
          const result = await ensure.json();
          resultItems = result.items || [];
        }
      }

      const ready = new Set(
        resultItems
          .filter((item) => item.status === "downloaded" || item.status === "skipped")
          .map((item) => item.name)
      );
      items.filter((item) => item.exists).forEach((item) => ready.add(item.name));

      // 第三方等价文件缺失时，把控件改到官方模型
      const switched = [];
      for (const ref of refs) {
        if (!ready.has(ref.item.name) || ref.value.includes(ref.item.name)) continue;
        ref.widget.value = ref.item.name;
        if (typeof ref.node.onWidgetChanged === "function") {
          try {
            ref.node.onWidgetChanged(ref.widget.name, ref.item.name, undefined, ref.widget);
          } catch (error) {
            /* 老节点没有该回调 */
          }
        }
        switched.push(`${ref.value} → ${ref.item.name}`);
      }
      if (switched.length && app.graph && typeof app.graph.setDirtyCanvas === "function") {
        app.graph.setDirtyCanvas(true, true);
      }

      const done = resultItems.filter((item) => item.status === "downloaded");
      const failed = resultItems.filter((item) => item.status === "error");
      if (done.length) {
        toast(
          `模型已补齐：${done.map((item) => item.name).join("、")}；已指向官方文件，可直接运行（下拉列表要刷新页面才会显示）`,
          "ok"
        );
      } else if (switched.length && !done.length) {
        toast(`已改用官方模型（本地已存在，跳过下载）：${switched.join("、")}`, "ok");
      }
      if (failed.length) {
        toast(
          `模型下载失败：${failed.map((item) => `${item.name}（${item.error}）`).join("；")}`,
          "err"
        );
      }
    } catch (error) {
      /* 后端没有该接口时静默跳过 */
    } finally {
      modelDownloading = false;
    }
  }

  /** 打开/切换工作流后自动检查一次模型 */
  function installWorkflowLoadHook() {
    if (!app || typeof app.loadGraphData !== "function" || app.__sbModelHooked) return;
    const original = app.loadGraphData.bind(app);
    app.loadGraphData = function (...args) {
      const result = original(...args);
      Promise.resolve(result).then(
        () => maybeEnsureModels(true),
        () => {}
      );
      return result;
    };
    app.__sbModelHooked = true;
  }

  function refreshReady() {
    installWorkflowLoadHook();
    maybeEnsureModels();
    const ready = el.ready;
    if (!state.doc || !state.doc.units.length) {
      ready.className = "sb-ready";
      el["ready-text"].textContent = state.raw
        ? "已读入文件，但没找到镜号标题：看下方列表里的格式说明"
        : "还没有导入分镜：先点右上角「导入分镜」";
      return;
    }
    const graphNodes = (app.graph && (app.graph.nodes || app.graph._nodes)) || [];
    if (!graphNodes.length) {
      ready.className = "sb-ready";
      el["ready-text"].textContent = "还没有打开工作流：先在 ComfyUI 打开一个图生视频工作流";
      return;
    }
    const h3 = planInfoSafe();
    if (h3 && h3.shots.length) {
      ready.className = "sb-ready ok";
      const fpsFixed = ensureH3Fps(app);
      const refSlots = referenceImageSlots(app).length;
      const refHint = refSlots
        ? `；参考图：Ref2V Picture 1-${refSlots}（按镜自动填）`
        : hasReferenceConditioning(app)
          ? ""
          : "；参考素材不生效（当前工作流没有 Ref2V 节点）";
      el["ready-text"].textContent = `工作流已就绪：H3 计划 ${h3.shots.length} 镜；素材入口 ${describeImageEntry(
        findImageEntry(app)
      )}${refHint}${fpsFixed.length ? `；已修正 H3 帧率 24（节点 ${fpsFixed.join("、")}）` : ""}`;
      renderPlanRow();
      return;
    }
    const ids = settings().nodeIds;
    const before = `${ids.positive}|${ids.negative}|${ids.sampler}|${ids.latent}`;
    try {
      ensureTargets();
    } catch (error) {
      /* 忽略 */
    }
    if (before !== `${ids.positive}|${ids.negative}|${ids.sampler}|${ids.latent}`) {
      renderNodeSelects();
    }
    const missing = [];
    if (!getNodeById(app, ids.positive)) missing.push("提示词框");
    if (!getNodeById(app, ids.sampler)) missing.push("采样器");
    const refSlots = referenceImageSlots(app).length;
    // 原生 Ref2V 自带画幅入口（ResolutionSelector），没有独立宽高节点也算就绪
    if (!getNodeById(app, ids.latent) && !refSlots) missing.push("画幅节点");
    if (!missing.length) {
      ready.className = "sb-ready ok";
      el["ready-text"].textContent =
        `工作流已就绪：提示词 #${ids.positive}、采样器 #${ids.sampler}` +
        `${ids.latent ? `、画幅 #${ids.latent}` : ""}；素材入口 ${describeImageEntry(findImageEntry(app))}` +
        (refSlots
          ? `；参考图 Picture 1-${refSlots}、参考音频 ${referenceAudioSlots(app).length} 路（按镜自动填）`
          : "");
    } else {
      ready.className = "sb-ready";
      el["ready-text"].textContent = `还差：${missing.join("、")}。点「重新识别」，或到高级设置手动选`;
    }
  }

  function findNextUnit() {
    return visibleUnits().find((unit) => !state.applied[unit.id]) || null;
  }

  /** 把一镜写进工作流（提示词 / 参数 / 素材），返回是否成功与回执 */
  async function applyUnitCore(unit, options = {}) {
    appliedUnitId = unit.id;
    // 先接素材与上一镜视频：提示词里要按实际接上的 <Video 1> 写衔接说明
    const image = await applyVisualToUnit(unit);
    const prompt = applyPromptToUnit(unit);
    const params = applyParamsToUnit(unit, options);
    const ok = prompt.ok && params.ok && image.ok;
    const detail = [image.message, prompt.message, params.message].filter(Boolean).join("；");
    return { ok, detail };
  }

  async function applyNextUnit() {
    if (applying) return;
    if (!state.doc || !state.doc.units.length) {
      toast("先导入分镜文档，再点这里", "err");
      return;
    }
    const unit = findNextUnit();
    if (!unit) {
      toast("这一批都做完了，可以去剪辑了", "ok");
      return;
    }
    applying = true;
    el.next.disabled = true;
    try {
      const { ok, detail } = await applyUnitCore(unit);
      markApplied(unit, ok);
      if (ok) advancePlanAfterApply();
      setCardMessage(unit, detail, ok ? "ok" : "err");
      const card = el.list.querySelector(`[data-id="${unit.id}"]`);
      if (card) card.scrollIntoView({ block: "nearest", behavior: "smooth" });
      toast(ok ? `${unit.id} 已写入，回 ComfyUI 点「运行」` : `${unit.id}：${detail}`, ok ? "ok" : "err");
      refreshReady();
    } catch (error) {
      toast(`应用失败：${error && error.message ? error.message : error}`, "err");
    } finally {
      applying = false;
      el.next.disabled = false;
    }
  }

  // ---------- 全自动：应用 → 排队 → 等完成 → 下一镜 ----------

  const AUTO_HINT = "开启后自动：应用 → 排队 → 等生成完成 → 下一镜";

  function setAutoStatus(text) {
    // 状态写进 state：切页签重建面板后还能看到自动模式停在哪、为什么停
    state.autoNote = text || "";
    persist();
    if (!el["auto-text"]) return;
    el["auto-text"].textContent = text || AUTO_HINT;
  }

  /** 自动模式按文档顺序做，不受搜索/筛选影响 */
  function nextAutoUnit() {
    return (state.doc ? state.doc.units : []).find((unit) => !state.applied[unit.id]) || null;
  }

  /** 提交当前画布到队列，返回 prompt_id */
  async function queueCurrentGraph() {
    if (autoStopRequested) return { ok: false, message: "已停止" };
    if (typeof api.queuePrompt !== "function") return { ok: false, message: "当前前端不支持排队接口" };
    let payload = null;
    try {
      payload = await app.graphToPrompt();
    } catch (error) {
      return { ok: false, message: "读取工作流失败" };
    }
    if (!payload || !payload.output) return { ok: false, message: "工作流是空的" };
    try {
      const response = await api.queuePrompt(0, payload);
      if (!response || !response.prompt_id) return { ok: false, message: "ComfyUI 没有接收这次排队" };
      if (response.node_errors && Object.keys(response.node_errors).length) {
        const nodeId = Object.keys(response.node_errors)[0];
        const first = response.node_errors[nodeId];
        const error = first && first.errors && first.errors[0];
        // ComfyUI 把具体字段放在 details 里，只显示 message 会丢失「哪个输入不对」
        const text = error
          ? [error.message, error.details, error.extra_info && error.extra_info.input_name ? `输入 ${error.extra_info.input_name}` : ""]
              .filter(Boolean)
              .join("：")
              .slice(0, 300)
          : "参数不合法";
        return { ok: false, message: `节点 #${nodeId}：${text}` };
      }
      return { ok: true, promptId: response.prompt_id };
    } catch (error) {
      const detail =
        error && error.response && error.response.error
          ? error.response.error.message || error.response.error
          : "";
      return { ok: false, message: String(detail || (error && error.message) || "排队失败") };
    }
  }

  /** 从 /history 的 status.messages 里提取具体失败原因（节点、异常） */
  function describeFailure(entry) {
    const messages = (entry && entry.status && entry.status.messages) || [];
    for (const item of messages) {
      if (!Array.isArray(item)) continue;
      const kind = item[0];
      const data = item[1] || {};
      if (kind === "execution_error") {
        const node = data.node_id != null ? `节点 #${data.node_id} ` : "";
        const type = data.node_type ? `${data.node_type}：` : "";
        const text = String(data.exception_message || data.exception_type || "")
          .split("\n")[0]
          .slice(0, 160);
        return `${node}${type}${text || "执行出错"}`;
      }
      if (kind === "execution_interrupted") return "执行被中断（有人点了取消，或服务器重启）";
    }
    return "生成失败，详情看 ComfyUI 控制台";
  }

  /** 等这一条任务在 /history 里出现完成状态 */
  async function waitForPrompt(promptId) {
    const started = Date.now();
    while (!autoStopRequested) {
      if (Date.now() - started > 6 * 60 * 60 * 1000) return { ok: false, message: "等待超时", videos: [] };
      try {
        const response = await api.fetchApi(`/history/${encodeURIComponent(promptId)}`, { cache: "no-store" });
        if (response.ok) {
          const data = await response.json();
          const entry = data && data[promptId];
          if (entry && entry.status && (entry.status.completed || entry.status.status_str)) {
            const failed = entry.status.status_str && entry.status.status_str !== "success";
            return {
              ok: !failed,
              message: failed ? describeFailure(entry) : "",
              videos: failed ? [] : collectOutputVideos(entry),
            };
          }
        }
      } catch (error) {
        /* 网络抖动就继续等 */
      }
      await sleep(2000);
    }
    return { ok: false, message: "已停止", videos: [] };
  }

  async function runAuto() {
    if (!state.doc || !state.doc.units.length) {
      if (el.auto) el.auto.checked = false;
      toast("先导入分镜文档，再开自动模式", "err");
      return;
    }
    if (autoRunning) return;
    autoRunning = true;
    autoStopRequested = false;
    applying = true;
    el.next.disabled = true;
    if (el.auto) el.auto.checked = true;
    // 低画质：原生 Ref2V 临时降像素档；H3 计划工作流走草稿（10 步 + 半分辨率）
    const before = readResolutionSettings(app);
    const megapixelsBackup = before ? before.megapixels : null;
    const draftBefore = !!state.draftBase;
    if (planInfoSafe() && !draftBefore) enterDraft();
    let done = 0;
    try {
      while (!autoStopRequested) {
        const unit = nextAutoUnit();
        if (!unit) {
          // 之前跑过的镜会留在「已做」里，自动模式不会重跑：把数字说清楚
          const total = state.doc.units.length;
          const skipped = Math.max(0, total - done);
          setAutoStatus(
            `全部完成：本次跑了 ${done} 镜${
              skipped ? `，另有 ${skipped} 镜之前已标记完成（要重跑请重新导入文档）` : ""
            }`
          );
          toast(`自动模式完成：本次生成 ${done} 镜`, "ok");
          break;
        }
        setAutoStatus(`第 ${done + 1} 镜：${unit.id} 写入中…`);
        const result = await applyUnitCore(unit, { megapixels: AUTO_MEGAPIXELS });
        if (!result.ok) {
          setCardMessage(unit, result.detail, "err");
          setAutoStatus(`停在 ${unit.id}：${result.detail}`);
          toast(`${unit.id} 写入失败，自动模式已停止`, "err");
          console.error(`[分镜面板] ${unit.id} 写入失败：${result.detail}`);
          break;
        }
        setCardMessage(unit, result.detail, "ok");
        const card = el.list.querySelector(`[data-id="${unit.id}"]`);
        if (card) card.scrollIntoView({ block: "nearest", behavior: "smooth" });
        if (autoStopRequested) break;
        setAutoStatus(`第 ${done + 1} 镜：${unit.id} 已排队，等待生成…`);
        let queued = await queueCurrentGraph();
        if (!queued.ok && /invalid video file|video.*not in list|not in list.*video/i.test(queued.message)) {
          // 上一镜视频在服务器上不可用：断开视频位、去掉提示词里的 <Video 1>，再排一次
          clearVideoSlotsFrom(app, 0);
          lastVideoBound = null;
          applyPromptToUnit(unit);
          console.warn(`[分镜面板] ${unit.id} 参考视频不可用，已断开并重排：${queued.message}`);
          queued = await queueCurrentGraph();
        }
        if (!queued.ok) {
          if (autoStopRequested) break;
          setAutoStatus(`排队失败：${queued.message}`);
          toast(`排队失败：${queued.message}`, "err");
          console.error(`[分镜面板] ${unit.id} 排队失败：${queued.message}`);
          break;
        }
        const finished = await waitForPrompt(queued.promptId);
        if (!finished.ok) {
          if (!autoStopRequested) {
            setAutoStatus(`${unit.id} 生成失败：${finished.message}`);
            toast(`${unit.id} 生成失败，自动模式已停止`, "err");
            console.error(`[分镜面板] ${unit.id} 生成失败：${finished.message}`);
          }
          break;
        }
        // 记下这一镜的输出视频：下一镜会把它接到 ref_videos（<Video 1>）
        if (finished.videos && finished.videos.length) {
          state.shots[unit.id] = { ...finished.videos[0], at: Date.now() };
        } else {
          delete state.shots[unit.id];
        }
        persist();
        // 生成成功才算这一镜完成，避免中途停止时把没出片的镜标成已完成
        markApplied(unit, true);
        advancePlanAfterApply();
        setCardMessage(unit, `${result.detail}；已生成`, "ok");
        done += 1;
        console.info(
          `[分镜面板] ${unit.id} 完成（本次第 ${done} 镜），输出视频 ${finished.videos ? finished.videos.length : 0} 个`
        );
        setAutoStatus(`已完成 ${done} 镜，准备下一镜…`);
        await sleep(800);
      }
    } catch (error) {
      // 任何没兜住的异常都要说出来，不能悄悄停
      const reason = error && error.message ? error.message : String(error);
      console.error("[分镜面板] 自动模式异常", error);
      setAutoStatus(`自动模式异常停止：${reason}`);
      toast(`自动模式异常停止：${reason}`, "err");
    } finally {
      autoRunning = false;
      applying = false;
      if (el.next) el.next.disabled = false;
      if (el.auto) el.auto.checked = false;
      if (megapixelsBackup != null) setResolutionMegapixels(app, megapixelsBackup);
      if (!draftBefore && state.draftBase) finishDraft();
      if (autoStopRequested) setAutoStatus(`已停止（完成 ${done} 镜）`);
      refreshReady();
    }
  }

  /** 右上角更新按钮：让后端在插件目录里 git pull，前端按改动决定刷新还是提示重启 */
  async function runPanelUpdate() {
    const button = el.update;
    if (button && button.disabled) return;
    if (button) {
      button.disabled = true;
      button.textContent = "…";
    }
    try {
      const response = await api.fetchApi("/storyboard/update/apply", { method: "POST" });
      if (response.status === 404) {
        toast("更新接口不可用：后端没加载，或者是 zip 安装", "err");
        return;
      }
      const data = await response.json().catch(() => null);
      if (!response.ok || !data) {
        toast("更新失败：接口返回异常", "err");
        return;
      }
      if (!data.ok) {
        toast(`更新失败：${data.message || "未知原因"}`, "err");
        return;
      }
      if (Array.isArray(data.changed) && data.changed.length) {
        if (data.restart) {
          toast(`已更新 ${data.before} → ${data.after}；改了后端代码，请重启 ComfyUI`, "ok");
        } else {
          toast(`已更新 ${data.before} → ${data.after}，正在刷新…`, "ok");
          setTimeout(() => location.reload(), 1200);
        }
      } else {
        toast(data.message || "已是最新版本", "ok");
      }
    } catch (error) {
      toast("更新失败：连不上 ComfyUI", "err");
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = "⟳";
      }
    }
  }

  function importRaw(text, sourceName) {
    if (!text || !text.trim()) {
      toast("内容为空，没有可解析的分镜", "err");
      return;
    }
    if (/PK\u0003\u0004/.test(text.slice(0, 8)) || text.slice(0, 4000).includes("word/document.xml")) {
      toast("这看起来是 Word 文件：请在 Word 里另存为 .md 或 .txt 再导入", "err");
      return;
    }
    state.raw = text;
    state.doc = parseStoryboard(text);
    state.applied = {};
    // 新一批：上一批的输出视频与衔接帧不再适用，留着会接错片
    state.shots = {};
    state.continuity = {};
    state.autoNote = "";
    // 新分镜：旧的首帧选择和自定义标签都属于上一批素材，清掉避免串用
    const docCodes = new Set();
    state.doc.units.forEach((unit) => (unit.assets || []).forEach((code) => docCodes.add(code)));
    state.images = {};
    state.tags = Object.fromEntries(
      Object.entries(state.tags || {}).filter(([code]) => docCodes.has(code))
    );
    state.search = "";
    state.filterScene = "all";
    state.renderLimit = 80;
    el.search.value = "";
    el.text.value = text;
    persist();
    renderAll();
    refreshReady();
    // 解析分镜后，把参考图规则写进 Plan 的共享提示词
    ensurePlanRulePrefix();
    el.guide.open = false;
    const stats = summarize(state.doc);
    if (!stats.total) {
      toast("已读入文件，但没找到镜号标题：看列表里的格式说明", "err");
    } else {
      toast(`已解析 ${stats.scenes} 场 / ${stats.total} 个单元${sourceName ? "：" + sourceName : ""}`, "ok");
    }
  }

  async function importFile(file) {
    if (!file) return;
    if (/\.(docx?|pdf|pptx?|xlsx?)$/i.test(file.name)) {
      toast("这是 Word / PDF / 表格文件：请先另存为 .md 或 .txt 再导入", "err");
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      toast("文件太大（>4MB），请确认是分镜手册", "err");
      return;
    }
    try {
      const text = await file.text();
      importRaw(text, file.name);
    } catch (error) {
      toast("读取文件失败：" + error.message, "err");
    }
  }

  // ---------- 事件绑定 ----------

  el.pick.addEventListener("click", () => el.file.click());

  el["pick-assets"].addEventListener("click", () => el.folder.click());

  el.folder.addEventListener("change", () => {
    const files = Array.from(el.folder.files || []);
    el.folder.value = "";
    importAssetFolder(files).catch(() => {});
  });

  el.file.addEventListener("change", () => {
    const file = el.file.files && el.file.files[0];
    el.file.value = "";
    importFile(file);
  });

  el["paste-toggle"].addEventListener("click", () => {
    el.paste.hidden = !el.paste.hidden;
    if (!el.paste.hidden) el.text.focus();
  });

  el.update.addEventListener("click", runPanelUpdate);

  el.parse.addEventListener("click", () => importRaw(el.text.value, "粘贴内容"));

  el.clear.addEventListener("click", () => {
    state.raw = "";
    state.doc = null;
    state.applied = {};
    el.text.value = "";
    persist();
    renderAll();
    refreshReady();
    toast("已清空");
  });

  // 设置项
  el.contvideo.checked = settings().continuityVideo !== false;
  el.contvideo.addEventListener("change", () => {
    settings().continuityVideo = el.contvideo.checked;
    persist();
    toast(el.contvideo.checked ? "跨镜接续：开启" : "跨镜接续：关闭（不再接上一镜视频）", "ok");
  });

  el.mode.value = settings().mode;
  el.mode.addEventListener("change", () => {
    settings().mode = el.mode.value;
    persist();
  });

  el.quality.value = settings().quality;
  el.quality.addEventListener("input", () => {
    settings().quality = el.quality.value;
    persist();
  });

  el.negative.value = settings().negative;
  el.negative.addEventListener("input", () => {
    settings().negative = el.negative.value;
    persist();
  });

  el.syncneg.checked = !!settings().syncNegative;
  el.syncneg.addEventListener("change", () => {
    settings().syncNegative = el.syncneg.checked;
    persist();
  });

  el.seed.value = settings().seed;
  el.seed.addEventListener("change", () => {
    settings().seed = Math.max(0, Math.floor(Number(el.seed.value) || 0));
    el.seed.value = settings().seed;
    persist();
    renderList();
  });

  el.random.checked = !!settings().randomSeed;
  el.random.addEventListener("change", () => {
    settings().randomSeed = el.random.checked;
    el.seed.disabled = el.random.checked;
    persist();
    renderList();
  });
  el.seed.disabled = !!settings().randomSeed;

  el.dice.addEventListener("click", () => {
    settings().seed = Math.floor(Math.random() * 4294967295);
    el.seed.value = settings().seed;
    persist();
    renderList();
  });

  const nodeSelectMap = {
    "node-positive": "positive",
    "node-negative": "negative",
    "node-sampler": "sampler",
    "node-latent": "latent",
    "node-image": "image",
  };
  Object.keys(nodeSelectMap).forEach((key) => {
    el[key].addEventListener("change", () => {
      settings().nodeIds[nodeSelectMap[key]] = el[key].value;
      persist();
    });
  });

  el.detect.addEventListener("click", () => {
    const auto = autoDetectTargets(app);
    const ids = settings().nodeIds;
    if (auto.positive) ids.positive = String(auto.positive.id);
    if (auto.negative) ids.negative = String(auto.negative.id);
    if (auto.sampler) ids.sampler = String(auto.sampler.id);
    if (auto.latent) ids.latent = String(auto.latent.id);
    if (auto.image) ids.image = String(auto.image.id);
    persist();
    renderNodeSelects();
    const found = [
      auto.positive ? "正向" : "",
      auto.negative ? "负面" : "",
      auto.sampler ? "采样器" : "",
      auto.latent ? "画幅" : "",
      describeImageEntry(findImageEntry(app)) !== "无（纯文生视频）" ? "素材入口" : "",
    ].filter(Boolean);
    toast(found.length ? `已识别：${found.join("、")}` : "没有识别到可用节点，请先打开工作流", found.length ? "ok" : "err");
    refreshReady();
  });

  el.redetect.addEventListener("click", () => el.detect.click());

  el.diagnose.addEventListener("click", () => {
    const nodes = ((app.graph && (app.graph.nodes || app.graph._nodes)) || []).filter(Boolean);
    const plan = planInfoSafe();
    const auto = autoDetectTargets(app);
    const model = detectModelProfile(app);
    const text = [
      `版本 ${PANEL_VERSION}`,
      `节点 ${nodes.length}`,
      `模型 ${model ? model.name : "通用（未识别，仅按基础规则）"}`,
      plan ? `H3 计划 ${plan.shots.length} 镜` : "H3 计划 无",
      `提示词 ${auto.positive ? "有" : "无"}`,
      `采样器 ${auto.sampler ? "有" : "无"}`,
      `画幅 ${auto.latent ? "有" : "无"}`,
      `素材入口 ${describeImageEntry(findImageEntry(app))}`,
      `首帧图 ${currentImageValue()}`,
      `参考图 ${findTaggedPictureNodes(app).length} 张 / 入口 ${taggedReferenceTargets(app).length}`,
    ].join(" · ");
    el["ready-text"].textContent = text;
    toast(text, "ok");
  });

  el["refresh-nodes"].addEventListener("click", () => {
    renderNodeSelects();
    toast("节点列表已刷新");
  });

  el.chips.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-scene]");
    if (!chip) return;
    const value = chip.dataset.scene;
    state.filterScene = value === "all" ? "all" : Number(value);
    state.renderLimit = 80;
    renderChips();
    renderList();
  });

  el.search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = el.search.value;
      state.renderLimit = 80;
      renderList();
    }, 120);
  });

  el.next.addEventListener("click", applyNextUnit);

  el.auto.addEventListener("change", () => {
    if (el.auto.checked) {
      runAuto();
      return;
    }
    autoStopRequested = true;
    if (autoRunning) setAutoStatus("停止中：等当前这镜跑完…");
  });

  el["hide-done"].addEventListener("change", () => {
    state.hideDone = el["hide-done"].checked;
    state.renderLimit = 80;
    renderList();
  });

  el.assets.addEventListener("change", (event) => {
    const target = event.target;
    if (!target || !target.dataset) return;
    if (target.dataset.el === "cutout") {
      settings().cutout = !!target.checked;
      resetUploads();
      persist();
      toast(settings().cutout ? "已开启白底自动抠图，下次应用会重新上传素材" : "已关闭自动抠图，下次应用会重新上传原图", "ok");
    } else if (target.dataset.el === "cutout-bg") {
      settings().cutoutBg = target.value;
      resetUploads();
      persist();
      toast("抠图底色已更新，下次应用会重新上传素材", "ok");
    } else if (target.dataset.el === "drop-cn-sound") {
      settings().dropCnSound = !!target.checked;
      persist();
      toast(
        settings().dropCnSound
          ? "已开启：音效段是中文时不再写入，提示词保持纯英文"
          : "已关闭：音效段按手册原文写入",
        "ok"
      );
    } else if (target.dataset.tag) {
      const code = target.dataset.tag;
      const value = String(target.value || "").trim().replace(/^@+/, "").replace(/\s+/g, "_");
      if (value) state.tags[code] = value;
      else delete state.tags[code];
      persist();
      target.value = referenceTagFor(code);
      renderAssets();
    }
  });

  el.assets.addEventListener("input", (event) => {
    const rule = event.target && event.target.closest ? event.target.closest('[data-el="rule"]') : null;
    if (!rule) return;
    settings().referenceRule = String(rule.value || "").trim() ? rule.value : "";
    persist();
  });

  el.assets.addEventListener("click", (event) => {
    const clear = event.target.closest('[data-act="clear-library"]');
    if (clear) {
      if (!window.confirm("清空素材库，并移除面板创建的参考图节点与加载图像？")) return;
      clearLibraryAndRefs();
      return;
    }
    const ruleDefault = event.target.closest('[data-act="rule-default"]');
    if (ruleDefault) {
      settings().referenceRule = "";
      persist();
      renderAssets();
      toast("参考图规则已恢复为面板内置版本", "ok");
      return;
    }
    const ruleWrite = event.target.closest('[data-act="rule-write"]');
    if (ruleWrite) {
      const field = el.assets.querySelector('[data-el="rule"]');
      const value = String((field && field.value) || "");
      settings().referenceRule = value.trim() ? value : "";
      persist();
      const count = Math.max(1, referenceImageSlots(app).length);
      const text = referenceRulePrefix(count);
      const saved = writeRuleBridgeText(app, text);
      const info = planInfoSafe();
      if (info && String(info.plan.prompt_prefix || "").startsWith(AUTO_PREFIX_MARK)) {
        writePlanPromptPrefix(app, "");
      }
      toast(
        saved ? "参考图规则已存进规则桥（运行时临时拼进提示词）" : "没有找到规则桥节点，先点「应用这一镜」",
        saved ? "ok" : "err"
      );
      renderAssets();
      return;
    }
    const clearRefs = event.target.closest('[data-act="clear-refs"]');
    if (clearRefs) {
      clearReferenceSlots();
      return;
    }
    const uploadAssets = event.target.closest('[data-act="upload-assets"]');
    if (uploadAssets) {
      uploadAssets.disabled = true;
      syncLibraryToComfy().finally(() => {
        uploadAssets.disabled = false;
      });
      return;
    }
    const button = event.target.closest('[data-act="wire-refs"]');
    if (!button) return;
    button.disabled = true;
    wireReferences().finally(() => {
      button.disabled = false;
    });
  });

  el["first-image"].addEventListener("change", () => {
    const active = nextUnitForFrame();
    if (!active) return;
    const value = el["first-image"].value;
    if (value) state.images[active.id] = value;
    else delete state.images[active.id];
    persist();
    renderList();
  });

  el["plan-shot"].addEventListener("change", () => {
    state.planIndex = Math.max(0, Math.floor(Number(el["plan-shot"].value) || 0));
    renderPlanRow();
  });

  let planSyncArmed = false;
  let planSyncTimer = null;
  el["plan-sync"].addEventListener("click", () => {
    if (!state.doc || !state.doc.units.length) {
      toast("先导入分镜文档", "err");
      return;
    }
    const info = planInfoSafe();
    if (!info) {
      toast("当前工作流不是 H3 计划工作流", "err");
      return;
    }
    const count = state.doc.units.length;
    if (!planSyncArmed) {
      planSyncArmed = true;
      el["plan-sync"].textContent = `确认替换 ${count} 镜？`;
      clearTimeout(planSyncTimer);
      planSyncTimer = setTimeout(() => {
        planSyncArmed = false;
        el["plan-sync"].textContent = "⇩ 写入全部";
      }, 4000);
      return;
    }
    planSyncArmed = false;
    clearTimeout(planSyncTimer);
    el["plan-sync"].textContent = "⇩ 写入全部";
    const baseSeed = Math.max(0, Math.floor(Number(settings().seed) || 0));
    const shots = state.doc.units.map((unit, index) => ({
      id: unit.id,
      prompt: buildPlanPrompt(unit),
      length: alignedFrames(unit.duration || 8),
      steps: unit.params.steps,
      seed: String(baseSeed + index),
    }));
    info.plan.shots = shots;
    const result = writeH3Plan(app, info.plan);
    if (!result.ok) {
      toast(result.message, "err");
      return;
    }
    state.planIndex = 0;
    renderPlanRow();
    toast(`已把 ${count} 镜写入 H3 计划（替换原有镜头）`, "ok");
  });

  el["draft"].addEventListener("click", () => enterDraft());
  el["final"].addEventListener("click", () => finishDraft());

  el["refresh-images"].addEventListener("click", () => {
    loadImageFiles();
    toast("已刷新首帧图列表");
  });

  el.list.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-act]");
    if (!button) return;
    if (button.dataset.act === "more") {
      state.renderLimit = (state.renderLimit || 80) + 80;
      renderList();
      return;
    }
    const card = button.closest("[data-id]");
    if (!card) return;
    const unit = findUnit(card.dataset.id);
    if (!unit) return;

    const act = button.dataset.act;

    if (act === "expand") {
      state.expanded[unit.id] = !state.expanded[unit.id];
      renderList();
      return;
    }

    if (act === "sample") {
      openSampler(unit);
      return;
    }

    if (act === "copy") {
      // H3 计划：复制真正会写入的英文结构；普通工作流：按当前语言设置拼
      const text = planInfoSafe()
        ? buildPlanPrompt(unit)
        : buildPrompt(unit, { mode: settings().mode, quality: settings().quality });
      if (!text) {
        setCardMessage(unit, "没有可复制的提示词", "err");
        return;
      }
      const done = () => setCardMessage(unit, "提示词已复制到剪贴板", "ok");
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, () => {
          setCardMessage(unit, "复制失败，请手动选择文本", "err");
        });
      } else {
        setCardMessage(unit, "当前环境不支持剪贴板", "err");
      }
      return;
    }

    if (act === "prompt") {
      const result = applyPromptToUnit(unit);
      markApplied(unit, result.ok);
      setCardMessage(unit, result.message, result.ok ? "ok" : "err");
      toast(result.message, result.ok ? "ok" : "err");
      return;
    }

    if (act === "params") {
      const result = applyParamsToUnit(unit);
      markApplied(unit, result.ok);
      setCardMessage(unit, result.message, result.ok ? "ok" : "err");
      toast(result.message, result.ok ? "ok" : "err");
      return;
    }

    if (act === "all") {
      try {
        const prompt = applyPromptToUnit(unit);
        const params = applyParamsToUnit(unit);
        const image = await applyVisualToUnit(unit);
        const ok = prompt.ok && params.ok && image.ok;
        markApplied(unit, ok);
        if (ok) advancePlanAfterApply();
        const message = [prompt.message, params.message, image.message].filter(Boolean).join("；");
        setCardMessage(unit, ok ? `${message}。回 ComfyUI 点「运行」即可` : message, ok ? "ok" : "err");
        toast(ok ? `${unit.id} 已写入，回 ComfyUI 点「运行」` : `${unit.id}：${message}`, ok ? "ok" : "err");
        refreshReady();
      } catch (error) {
        const detail = error && error.message ? error.message : String(error);
        setCardMessage(unit, `应用失败：${detail}`, "err");
        toast(`应用失败：${detail}`, "err");
      }
    }
  });

  // 拖拽导入
  let dragDepth = 0;
  root.addEventListener("dragenter", (event) => {
    event.preventDefault();
    event.stopPropagation();
    dragDepth += 1;
    root.classList.add("dragging");
  });
  root.addEventListener("dragover", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  root.addEventListener("dragleave", (event) => {
    event.preventDefault();
    event.stopPropagation();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) root.classList.remove("dragging");
  });
  root.addEventListener("drop", (event) => {
    event.preventDefault();
    event.stopPropagation();
    dragDepth = 0;
    root.classList.remove("dragging");
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) importFile(file);
  });

  el.guide.open = !state.doc;
  installDraftQueueHook();
  installWorkflowLoadHook();
  renderAll();
  refreshReady();
  loadImageFiles();
  // 上次自动模式停在哪：重建面板后继续显示，方便查原因
  if (state.autoNote) setAutoStatus(state.autoNote);

  return {
    refresh() {
      renderAll();
      refreshReady();
    },
    importRaw(text, sourceName) {
      importRaw(text, sourceName);
    },
  };
}
