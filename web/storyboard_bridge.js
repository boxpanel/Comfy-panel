/**
 * ComfyUI 工作流桥接：只负责读写 graph 上的节点/控件，不碰 DOM。
 */

const TEXT_WIDGETS = ["text", "prompt", "string"];

/** 桥接模块构建号：面板徽标里一起显示，用来确认浏览器加载的是新代码 */
export const BRIDGE_BUILD = "20261113c";

/** 只返回真正参与执行的工作流节点（排除静音 mode 2 与旁路 mode 4） */
export function getNodes(app) {
  return getAllNodes(app).filter((node) => node.mode !== 2 && node.mode !== 4);
}

/** 所有节点（含静音/旁路），给清理类操作使用 */
export function getAllNodes(app) {
  const graph = app && app.graph;
  if (!graph) return [];
  return (graph.nodes || graph._nodes || []).filter(Boolean);
}

export function getNodeById(app, id) {
  if (id === undefined || id === null || id === "") return null;
  const graph = app && app.graph;
  const direct = graph && graph.getNodeById ? graph.getNodeById(id) : null;
  if (direct) return direct;
  return getNodes(app).find((node) => String(node.id) === String(id)) || null;
}

export function getWidget(node, name) {
  if (!node || !Array.isArray(node.widgets)) return null;
  return node.widgets.find((widget) => widget && widget.name === name) || null;
}

export function hasWidget(node, name) {
  return !!getWidget(node, name);
}

export function textWidgetName(node) {
  return TEXT_WIDGETS.find((name) => hasWidget(node, name)) || null;
}

export function setWidget(node, name, value) {
  const widget = getWidget(node, name);
  if (!widget) return false;

  let next = value;
  let values = widget.options && widget.options.values;
  if (typeof values === "function") {
    try {
      values = values(widget);
    } catch (error) {
      values = null;
    }
  }
  if (Array.isArray(values) && values.length) {
    if (!values.includes(next)) {
      const matched = values.find((item) => String(item).toLowerCase() === String(next).toLowerCase());
      if (matched === undefined) return false;
      next = matched;
    }
  }

  widget.value = next;
  try {
    if (typeof widget.callback === "function") {
      widget.callback(next, node.graph && node.graph.canvas ? node.graph.canvas : undefined, node, [0, 0], null);
    }
  } catch (error) {
    /* 某些自定义节点的 callback 参数不一致，忽略 */
  }
  try {
    if (typeof node.onWidgetChanged === "function") {
      node.onWidgetChanged(widget.name, next, undefined, widget);
    }
  } catch (error) {
    /* 同上 */
  }
  return true;
}

export function markDirty(app, node) {
  try {
    if (node && typeof node.setDirtyCanvas === "function") node.setDirtyCanvas(true, true);
  } catch (error) {
    /* ignore */
  }
  try {
    if (app && app.graph && typeof app.graph.setDirtyCanvas === "function") {
      app.graph.setDirtyCanvas(true, true);
    }
  } catch (error) {
    /* ignore */
  }
}

function getLink(app, linkId) {
  const graph = app && app.graph;
  if (!graph || linkId === undefined || linkId === null) return null;
  const links = graph.links;
  if (!links) return null;
  if (Array.isArray(links)) return links.find((link) => link && link.id === linkId) || null;
  if (typeof links.get === "function") return links.get(linkId) || null;
  return links[linkId] || null;
}

export function followInput(app, node, inputName) {
  if (!node || !Array.isArray(node.inputs)) return null;
  const input = node.inputs.find((item) => item && item.name === inputName);
  if (!input || input.link === undefined || input.link === null) return null;
  const link = getLink(app, input.link);
  if (!link) return null;
  return getNodeById(app, link.origin_id);
}

function conditioningTextNode(app, node, inputName) {
  let current = followInput(app, node, inputName);
  const visited = new Set();
  let guard = 0;
  while (current && guard < 8 && !visited.has(current.id)) {
    visited.add(current.id);
    if (textWidgetName(current)) return current;
    const next = (current.inputs || [])
      .map((input) => (input && input.link !== undefined && input.link !== null ? followInput(app, current, input.name) : null))
      .find(Boolean);
    current = next || null;
    guard += 1;
  }
  return null;
}

export function findSamplerNode(app) {
  const nodes = getNodes(app).filter((node) => node.mode !== 2);
  const candidates = nodes.filter(
    (node) => hasWidget(node, "steps") && (hasWidget(node, "cfg") || hasWidget(node, "sampler_name"))
  );
  if (candidates.length) {
    return candidates.find((node) => /KSampler/i.test(String(node.type || ""))) || candidates[0];
  }
  return nodes.find((node) => hasWidget(node, "sampler_name")) || null;
}

/** 自动识别：正向提示词 / 负面提示词 / 采样器 / 画幅节点 */
export function autoDetectTargets(app) {
  const sampler = findSamplerNode(app);
  // 原生 Ref2V（终极篇）：提示词是从 Ref2V.prompt 经 SetNode/GetNode 接过来的文本节点
  const promptEntry = findPromptEntry(app);
  let positive = promptEntry && promptEntry.textNode
    ? promptEntry.textNode
    : sampler
      ? conditioningTextNode(app, sampler, "positive")
      : null;
  let negative = sampler ? conditioningTextNode(app, sampler, "negative") : null;

  const textNodes = getNodes(app).filter((node) => node.mode !== 2 && textWidgetName(node));
  if (!positive) positive = textNodes[0] || null;
  if (!negative) negative = textNodes.find((node) => node !== positive) || null;

  let latent = sampler ? followInput(app, sampler, "latent_image") : null;
  if (!latent || (!hasWidget(latent, "width") && !hasWidget(latent, "height"))) {
    latent =
      getNodes(app).find(
        (node) =>
          node.mode !== 2 &&
          hasWidget(node, "width") &&
          hasWidget(node, "height") &&
          /Latent|Video|Empty/i.test(String(node.type || ""))
      ) || null;
  }

  const imageNodes = getNodes(app).filter((node) => node.mode !== 2 && hasWidget(node, "image"));
  const image =
    imageNodes.find((node) => /LoadImage/i.test(String(node.type || ""))) || imageNodes[0] || null;

  return { positive, negative, sampler, latent, image };
}

export function describeNode(node) {
  if (!node) return "";
  return `${node.title || node.type} #${node.id}`;
}

export function listNodeOptions(app) {
  const nodes = getNodes(app).filter((node) => node.mode !== 2);
  const option = (node) => ({ id: String(node.id), label: describeNode(node) });
  return {
    positive: nodes.filter((node) => textWidgetName(node)).map(option),
    negative: nodes.filter((node) => textWidgetName(node)).map(option),
    sampler: nodes
      .filter((node) => hasWidget(node, "steps") || hasWidget(node, "sampler_name") || hasWidget(node, "noise_seed"))
      .map(option),
    latent: nodes.filter((node) => hasWidget(node, "width") && hasWidget(node, "height")).map(option),
    image: nodes.filter((node) => hasWidget(node, "image")).map(option),
  };
}

export function setPromptText(app, node, text) {
  if (!node) return false;
  const name = textWidgetName(node);
  if (!name) return false;
  const ok = setWidget(node, name, text);
  if (ok) markDirty(app, node);
  return ok;
}

/** 写入「加载图像」节点的首帧图文件名（新上传的文件可能还不在下拉列表里，直接赋值兜底） */
export function setNodeImage(app, node, filename) {
  if (!node) return false;
  const widget = getWidget(node, "image");
  if (!widget) return false;
  // 新上传的文件可能还不在 LoadImage 的下拉列表里，补进去，避免前端把值弹回旧图
  if (widget.options && Array.isArray(widget.options.values) && !widget.options.values.includes(filename)) {
    widget.options.values.unshift(filename);
  }
  if (!setWidget(node, "image", filename)) {
    widget.value = filename;
    try {
      if (typeof widget.callback === "function") {
        widget.callback(filename, node.graph && node.graph.canvas ? node.graph.canvas : undefined, node, [0, 0], null);
      }
    } catch (error) {
      /* ignore */
    }
  }
  markDirty(app, node);
  return true;
}

const IMAGE_INPUT_RE = /^(first_frame|start_image|init_image|image)$/i;
const FRAME_INPUT_RE = /^(first_frame|start_image|init_image)$/i;
const IMAGE_TARGET_TYPE_RE = /ImageToVideo|I2V|StartImage|FirstFrame/i;

/** 这个加载图像节点是不是专供 H3 参考图用的（不能被首帧逻辑占用） */
function isReferenceLoader(app, loader) {
  const output = Array.isArray(loader.outputs) ? loader.outputs[0] : null;
  const linkIds = (output && Array.isArray(output.links) ? output.links : []) || [];
  return linkIds.some((linkId) => {
    const link = getLink(app, linkId);
    if (!link) return false;
    const target = getNodeById(app, link.target_id);
    if (!target) return false;
    if (TAGGED_PICTURE_TYPE.test(String(target.type || ""))) return true;
    // 原生 Ref2V 的 ref_images.ref_image_N 也是参考图位
    if (STOCK_REF2V_TYPE.test(String(target.type || ""))) {
      const input = Array.isArray(target.inputs) ? target.inputs[link.target_slot] : null;
      if (input && REFERENCE_SLOT_RE.test(String(input.name || ""))) return true;
    }
    return false;
  });
}

/**
 * 自动找「素材入口」：
 *   1. 已有加载图像节点 → {kind:"loader"}
 *   2. 图生视频节点上的图像输入（如 MiniMaxH3ImageToVideo.first_frame）→ {kind:"input"}
 *   3. 都没有 → null
 */
export function findImageEntry(app) {
  const nodes = getNodes(app).filter((node) => node.mode !== 2);

  const imageNodes = nodes.filter((node) => hasWidget(node, "image"));
  const loaders = imageNodes.filter((node) => /LoadImage/i.test(String(node.type || "")));

  // 已经接到图生视频首帧输入上的加载图像节点优先
  const wired = loaders.find((loader) => {
    const output = Array.isArray(loader.outputs) ? loader.outputs[0] : null;
    const linkIds = (output && Array.isArray(output.links) ? output.links : []) || [];
    return linkIds.some((linkId) => {
      const link = getLink(app, linkId);
      if (!link) return false;
      const target = getNodeById(app, link.target_id);
      const input = target && Array.isArray(target.inputs) ? target.inputs[link.target_slot] : null;
      return !!(target && input && IMAGE_INPUT_RE.test(String(input.name || "")) && IMAGE_TARGET_TYPE_RE.test(String(target.type || "")));
    });
  });
  // 优先用已接在首帧输入上的加载图像；其次用未被占用、也没接参考图的（避免覆盖参考素材）
  const loader =
    wired ||
    loaders.find((candidate) => {
      if (isReferenceLoader(app, candidate)) return false;
      const output = Array.isArray(candidate.outputs) ? candidate.outputs[0] : null;
      const linkIds = (output && Array.isArray(output.links) ? output.links : []) || [];
      return linkIds.length === 0;
    }) ||
    null;
  if (loader) return { kind: "loader", node: loader };
  let first = null;
  for (const node of nodes) {
    if (!Array.isArray(node.inputs)) continue;
    const looksLikeI2V = IMAGE_TARGET_TYPE_RE.test(String(node.type || ""));
    for (const input of node.inputs) {
      if (!input || String(input.type || "") !== "IMAGE") continue;
      const name = String(input.name || "");
      if (looksLikeI2V ? !IMAGE_INPUT_RE.test(name) : !FRAME_INPUT_RE.test(name)) continue;
      const candidate = { kind: "input", node, input, priority: looksLikeI2V ? 2 : 1 };
      if (!first || candidate.priority > first.priority) first = candidate;
      if (looksLikeI2V && /^first_frame$/i.test(name)) break;
    }
  }
  if (first) {
    delete first.priority;
    return first;
  }
  return null;
}

function liteGraphFactory() {
  if (typeof window === "undefined") return null;
  const candidates = [
    window.LiteGraph,
    window.LiteGraph && window.LiteGraph.LiteGraph,
    window.comfyAPI && window.comfyAPI.litegraph && window.comfyAPI.litegraph.LiteGraph,
  ];
  return candidates.find((item) => item && typeof item.createNode === "function") || null;
}

/** 拿到可写入的加载图像节点；只有图像输入没加载器时，自动新建并接上 */
export function ensureImageEntry(app, entry) {
  if (!entry) return null;
  if (entry.kind === "loader") return entry.node;
  if (entry.kind !== "input") return null;

  const wired = followInput(app, entry.node, entry.input.name);
  if (wired && hasWidget(wired, "image")) return wired;

  let loader =
    getNodes(app).find((node) => {
      if (node.mode === 2 || !hasWidget(node, "image") || !/LoadImage/i.test(String(node.type || ""))) {
        return false;
      }
      if (isReferenceLoader(app, node)) return false;
      // 只复用完全没接线的加载图，避免把首帧/参考位的图抢过来
      const output = Array.isArray(node.outputs) ? node.outputs[0] : null;
      const links = (output && Array.isArray(output.links) ? output.links : []) || [];
      return links.length === 0;
    }) || null;

  if (!loader) {
    const factory = liteGraphFactory();
    if (!factory) return null;
    try {
      loader = factory.createNode("LoadImage");
      if (!loader) return null;
      const pos = entry.node.pos || [0, 0];
      loader.pos = [Math.max(0, Number(pos[0]) - 620), Number(pos[1]) + 40];
      if (app.graph && typeof app.graph.add === "function") app.graph.add(loader);
      markDirty(app, loader);
    } catch (error) {
      return null;
    }
  }

  const slot = Array.isArray(entry.node.inputs) ? entry.node.inputs.indexOf(entry.input) : -1;
  if (slot < 0) return null;
  try {
    if (typeof loader.connect === "function") {
      loader.connect(0, entry.node, slot);
    } else if (app.graph && typeof app.graph.connect === "function") {
      app.graph.connect(loader, 0, entry.node, slot);
    }
  } catch (error) {
    return null;
  }
  markDirty(app, entry.node);
  return loader;
}

/** 给状态条/诊断用的文字描述 */
export function describeImageEntry(entry) {
  if (!entry) return "无（纯文生视频）";
  if (entry.kind === "loader") return `加载图像 #${entry.node.id}`;
  return `#${entry.node.id} ${entry.node.title || entry.node.type}.${entry.input.name}`;
}

const FIRST_FRAME_RE = /^(first_frame|start_image|init_image)$/i;
const LAST_FRAME_RE = /^last_frame$/i;

/** 找首帧/尾帧的图像输入（first_frame / last_frame，不含 ref_images.*） */
export function findFrameInput(app, kind) {
  const re = kind === "last" ? LAST_FRAME_RE : FIRST_FRAME_RE;
  for (const node of getNodes(app)) {
    if (!Array.isArray(node.inputs)) continue;
    for (let slot = 0; slot < node.inputs.length; slot += 1) {
      const input = node.inputs[slot];
      if (!input || String(input.type || "") !== "IMAGE") continue;
      if (!re.test(String(input.name || ""))) continue;
      return { node, input, slot };
    }
  }
  return null;
}

/** 把图片写到首/尾帧输入；工作流没有对应输入时返回失败 */
export function writeFrameImage(app, kind, filename) {
  const alias = String(filename || "").trim();
  if (!alias) return { ok: false, message: "图片名为空" };
  const target = findFrameInput(app, kind);
  if (!target) {
    return { ok: false, message: kind === "last" ? "工作流没有尾帧输入" : "工作流没有首帧输入" };
  }
  let loader = followInput(app, target.node, target.input.name);
  if (!loader || !hasWidget(loader, "image")) {
    // 断开状态时只新建专用加载图，绝不复用首帧/参考位或用户已有的加载节点
    const factory = liteGraphFactory();
    if (!factory) return { ok: false, message: "当前前端不支持创建加载图像节点" };
    try {
      loader = factory.createNode("LoadImage");
      if (!loader) return { ok: false, message: "创建加载图像节点失败" };
      const pos = target.node.pos || [0, 0];
      loader.pos = [Math.max(0, Number(pos[0]) - 640), Number(pos[1]) + (kind === "last" ? 130 : 0)];
      loader.properties = { ...(loader.properties || {}), sbFrame: kind };
      if (app.graph && typeof app.graph.add === "function") app.graph.add(loader);
      if (!connectOnce(app, loader, 0, target.node, target.slot)) {
        return { ok: false, message: "首/尾帧输入接不上加载图像节点" };
      }
    } catch (error) {
      return { ok: false, message: "创建加载图像节点失败" };
    }
  }
  loader.properties = { ...(loader.properties || {}), sbFrame: kind };
  if (!setNodeImage(app, loader, alias)) {
    return { ok: false, message: "加载图像节点无法写入图片" };
  }
  markDirty(app, loader);
  return { ok: true, node: loader };
}

/** 清掉上一镜由面板写入的首/尾帧（本镜没有对应帧素材时） */
export function clearFrameImage(app, kind) {
  const target = findFrameInput(app, kind);
  if (!target || target.input.link === undefined || target.input.link === null) return false;
  const loader = followInput(app, target.node, target.input.name);
  if (!loader || !(loader.properties && loader.properties.sbFrame)) return false;
  const removed = disconnectInput(app, target.node, target.slot);
  const output = Array.isArray(loader.outputs) ? loader.outputs[0] : null;
  const links = (output && Array.isArray(output.links) ? output.links : []) || [];
  if (removed && links.length === 0 && app.graph && typeof app.graph.remove === "function") {
    try {
      app.graph.remove(loader);
    } catch (error) {
      /* 删不掉就留着 */
    }
  }
  return removed;
}

export const H3_FPS = 24;

// 成片像素档：分镜手册只用来定画面比例，像素统一按 1.5MP（1664×928）跑
const H3_MEGAPIXELS = 1.5;

/** H3 的帧率固定 24；把被误写成 16/其他值的 H3 节点修正回来，返回修正过的节点号 */
export function ensureH3Fps(app) {
  const fixed = [];
  for (const node of getNodes(app)) {
    if (node.mode === 2) continue;
    if (!/^MiniMaxH3/i.test(String(node.type || ""))) continue;
    const widget = getWidget(node, "fps");
    if (!widget) continue;
    if (Number(widget.value) === H3_FPS) continue;
    if (setWidget(node, "fps", H3_FPS)) {
      markDirty(app, node);
      fixed.push(String(node.id));
    }
  }
  return fixed;
}

/**
 * 各模型对帧数/帧率/尺寸的硬性要求（写错就会在运行时报错）
 * frameMod/frameRem 表示帧数必须满足 frames % frameMod === frameRem
 */
const MODEL_PROFILES = [
  {
    key: "h3",
    name: "MiniMax H3",
    fps: 24,
    frameMod: 17,
    frameRem: 5,
    minFrames: 5,
    maxFrames: 3592,
    sizeStep: 32,
    detectNode: /^MiniMaxH3/i,
    detectText: /minimax.?h3/i,
  },
  {
    key: "wan",
    name: "WAN 2.x",
    fps: 16,
    frameMod: 4,
    frameRem: 1,
    minFrames: 17,
    sizeStep: 16,
    detectText: /wan2|wan[ ._-]?2/i,
  },
  {
    key: "hunyuan",
    name: "HunyuanVideo",
    fps: 24,
    frameMod: 4,
    frameRem: 1,
    minFrames: 9,
    sizeStep: 16,
    detectText: /hunyuan/i,
  },
  {
    key: "ltx",
    name: "LTX-Video",
    frameMod: 8,
    frameRem: 1,
    minFrames: 9,
    sizeStep: 32,
    detectText: /ltx/i,
  },
  {
    key: "cogvideo",
    name: "CogVideoX",
    fps: 8,
    frameMod: 8,
    frameRem: 1,
    minFrames: 9,
    sizeStep: 16,
    detectText: /cogvideo/i,
  },
  {
    key: "mochi",
    name: "Mochi",
    fps: 30,
    frameMod: 6,
    frameRem: 1,
    minFrames: 7,
    sizeStep: 16,
    detectText: /mochi/i,
  },
];

/** 从节点类型和模型文件名判断当前工作流属于哪个模型 */
export function detectModelProfile(app) {
  const nodes = getNodes(app).filter((node) => node.mode !== 2);
  for (const profile of MODEL_PROFILES) {
    if (profile.detectNode && nodes.some((node) => profile.detectNode.test(String(node.type || "")))) {
      return profile;
    }
  }
  const parts = [];
  for (const node of nodes) {
    parts.push(String(node.type || ""));
    if (!Array.isArray(node.widgets)) continue;
    for (const widget of node.widgets) {
      if (!widget || typeof widget.value !== "string") continue;
      const name = String(widget.name || "");
      if (/unet|ckpt|checkpoint|model|vae|filename|file/i.test(name)) parts.push(widget.value);
    }
  }
  const text = parts.join(" ");
  return MODEL_PROFILES.find((profile) => profile.detectText && profile.detectText.test(text)) || null;
}

/** 按模型规则校正参数；返回 {params, profile, changes} */
export function guardParams(params, profile) {
  const next = { ...(params || {}) };
  const changes = [];
  if (!profile) return { params: next, profile: null, changes };

  if (profile.fps != null && Number(next.fps) !== profile.fps) {
    changes.push(`帧率 ${next.fps}→${profile.fps}`);
    next.fps = profile.fps;
  }

  if (profile.frameMod) {
    const wanted = Math.max(profile.minFrames || 5, Math.round(Number(next.frames) || 0));
    const mod = profile.frameMod;
    const rem = profile.frameRem;
    const down = (((wanted % mod) - rem) % mod + mod) % mod;
    const up = down === 0 ? 0 : mod - down;
    let aligned = wanted;
    if (down !== 0) aligned = down <= up ? wanted - down : wanted + up;
    while (profile.minFrames && aligned < profile.minFrames) aligned += mod;
    while (profile.maxFrames && aligned > profile.maxFrames) aligned -= mod;
    if (aligned !== Number(next.frames)) {
      changes.push(`帧数 ${next.frames}→${aligned}`);
      next.frames = aligned;
    }
  }

  if (profile.sizeStep) {
    const round = (value) => Math.max(profile.sizeStep, Math.round(Number(value) / profile.sizeStep) * profile.sizeStep);
    const width = round(next.width);
    const height = round(next.height);
    if (width !== Number(next.width)) {
      changes.push(`宽 ${next.width}→${width}`);
      next.width = width;
    }
    if (height !== Number(next.height)) {
      changes.push(`高 ${next.height}→${height}`);
      next.height = height;
    }
  }

  return { params: next, profile, changes };
}

const TAGGED_PICTURE_TYPE = /^MiniMaxH3TaggedPictureReference$/i;
const TAGGED_REF2V_TYPE = /^MiniMaxH3(TaggedReferenceToVideo|CurrentTaggedReferenceScene)$/i;
// 真正能吃到参考图的节点（I2V/T2V 没有参考输入，素材无法参与生成）
const REFERENCE_CONDITIONING_TYPE = /^MiniMaxH3.*(ReferenceToVideo|TaggedReferenceScene)$/i;
// 原生 Ref2V 的参考图位：ref_images.ref_image_0 ...
const REFERENCE_SLOT_RE = /^ref_images\.ref_image_(\d+)$/i;
const STOCK_REF2V_TYPE = /^MiniMaxH3ReferenceToVideo$/i;
// 素材接入参考条件的必经中转节点（规则窗）
const RULE_BRIDGE_TYPE = /^StoryboardRefRuleBridge$/i;
// SetNode/GetNode：工作流用「命名中转」接素材（终极篇这类单条 Ref2V 工作流）
const SET_NODE_TYPE = /^SetNode$/i;
const GET_NODE_TYPE = /^GetNode$/i;
// 规则桥 / Ref2V 的参考位上限（Picture 1-9）
const PICTURE_COUNT = 9;

/** 画布上的「参考图规则桥」：素材 → 规则 → Ref2V */
export function findRuleBridge(app) {
  return getNodes(app).find((node) => RULE_BRIDGE_TYPE.test(String(node.type || ""))) || null;
}

/** 没有规则桥就建一个，放在参考条件节点左边 */
export function ensureRuleBridge(app) {
  const existing = findRuleBridge(app);
  if (existing) return existing;
  const refNode = getNodes(app).find((node) => STOCK_REF2V_TYPE.test(String(node.type || "")));
  if (!refNode) return null;
  const factory = liteGraphFactory();
  if (!factory) return null;
  try {
    const bridge = factory.createNode("StoryboardRefRuleBridge");
    if (!bridge) return null;
    const pos = Array.isArray(refNode.pos) ? refNode.pos : [0, 0];
    bridge.pos = [Math.max(0, Number(pos[0]) - 360), Number(pos[1])];
    bridge.properties = { ...(bridge.properties || {}), sbRuleBridge: true };
    if (app.graph && typeof app.graph.add === "function") app.graph.add(bridge);
    markDirty(app, bridge);
    markDirty(app, refNode);
    return bridge;
  } catch (error) {
    return null;
  }
}

function bridgeInputSlot(bridge, name) {
  if (!bridge || !Array.isArray(bridge.inputs)) return -1;
  return bridge.inputs.findIndex((input) => input && String(input.name) === String(name));
}

/** 规则桥的输入口：前端把没连线的可选输入收起时补回来，按名字仍能找到 */
function ensureBridgeInput(app, bridge, name) {
  const at = bridgeInputSlot(bridge, name);
  if (at >= 0) return at;
  if (!bridge || typeof bridge.addInput !== "function") return -1;
  try {
    bridge.addInput(String(name), "IMAGE");
    markDirty(app, bridge);
  } catch (error) {
    return -1;
  }
  return bridgeInputSlot(bridge, name);
}

/** 读规则桥里的规则文本 */
export function readRuleBridgeText(app) {
  const bridge = findRuleBridge(app);
  const widget = bridge ? getWidget(bridge, "rules") : null;
  return widget ? String(widget.value || "") : "";
}

/** 把规则写进规则桥（没有桥就跳过） */
export function writeRuleBridgeText(app, text) {
  const bridge = findRuleBridge(app);
  if (!bridge) return false;
  const widget = getWidget(bridge, "rules");
  if (!widget) return false;
  const value = String(text || "");
  if (String(widget.value || "") === value) return true;
  widget.value = value;
  markDirty(app, bridge);
  return true;
}

/** 当前工作流有没有启用的参考图条件节点 */
export function hasReferenceConditioning(app) {
  return getNodes(app).some((node) => REFERENCE_CONDITIONING_TYPE.test(String(node.type || "")));
}

/** SetNode/GetNode 的中转名（KJNodes 的控件叫 Constant，取第一个控件兜底） */
function setGetKey(node) {
  if (!node) return "";
  const widget =
    getWidget(node, "Constant") ||
    getWidget(node, "constant") ||
    getWidget(node, "name") ||
    (Array.isArray(node.widgets) ? node.widgets[0] : null);
  return widget ? String(widget.value === undefined || widget.value === null ? "" : widget.value).trim() : "";
}

/** 节点第一个接了线的输入口的上游节点 */
function firstLinkedInput(app, node) {
  if (!node || !Array.isArray(node.inputs)) return null;
  for (const input of node.inputs) {
    if (!input || input.link === undefined || input.link === null) continue;
    const source = followInput(app, node, input.name);
    if (source) return source;
  }
  return null;
}

function findSetterNode(app, key) {
  if (!key) return null;
  return (
    getAllNodes(app).find((node) => SET_NODE_TYPE.test(String(node.type || "")) && setGetKey(node) === key) || null
  );
}

/**
 * 穿透 GetNode → 同名 SetNode → 上游（Reroute 也一起穿透），拿到真正产出数据的节点。
 * 返回 { source, setter }：source 是上游真实节点，setter 是链上的 SetNode（没有则为 null）。
 */
export function resolveSetGetSource(app, node) {
  let current = node || null;
  let setter = null;
  const visited = new Set();
  for (let guard = 0; current && guard < 10 && !visited.has(current.id); guard += 1) {
    visited.add(current.id);
    const type = String(current.type || "");
    if (GET_NODE_TYPE.test(type)) {
      const found = findSetterNode(app, setGetKey(current));
      if (!found) return { source: null, setter: null };
      setter = found;
      current = firstLinkedInput(app, found);
      continue;
    }
    if (/^Reroute$/i.test(type)) {
      current = firstLinkedInput(app, current);
      continue;
    }
    break;
  }
  return { source: current || null, setter };
}

/** 原生 Ref2V 的提示词入口：prompt ← GetNode ← SetNode ← 文本节点 */
export function findPromptEntry(app) {
  for (const node of getNodes(app)) {
    if (!STOCK_REF2V_TYPE.test(String(node.type || "")) || !Array.isArray(node.inputs)) continue;
    const input = node.inputs.find((item) => item && String(item.name) === "prompt");
    if (!input) continue;
    if (input.link === undefined || input.link === null) {
      return { node, input, textNode: textWidgetName(node) ? node : null };
    }
    const { source } = resolveSetGetSource(app, followInput(app, node, "prompt"));
    if (source && textWidgetName(source)) return { node, input, textNode: source };
  }
  return null;
}

/** 原生 Ref2V 的参考图位（Picture 1..N）；loader 是这个位置当前接的加载窗口 */
export function referenceImageSlots(app) {
  const slots = [];
  for (const node of getNodes(app)) {
    if (!STOCK_REF2V_TYPE.test(String(node.type || "")) || !Array.isArray(node.inputs)) continue;
    node.inputs.forEach((input, index) => {
      const match = input && REFERENCE_SLOT_RE.exec(String(input.name || ""));
      if (!match) return;
      const picture = Number(match[1]);
      const bridgeName = `image_${picture + 1}`;
      const link = input && input.link !== undefined && input.link !== null ? getLink(app, input.link) : null;
      const upstream = link ? getNodeById(app, link.origin_id) : null;
      const bridge = upstream && RULE_BRIDGE_TYPE.test(String(upstream.type || "")) ? upstream : null;
      // 有规则桥时按「实际接的是桥的哪一路输出」找加载图，这样错位也能被发现
      let bridgeSlot = null;
      let setter = null;
      let source = upstream;
      if (bridge) {
        bridgeSlot = Number(link.origin_slot);
        const output = Array.isArray(bridge.outputs) ? bridge.outputs[bridgeSlot] : null;
        source = output ? followInput(app, bridge, output.name) : null;
      } else if (upstream) {
        // 终极篇这类工作流：Ref2V ← GetNode ← SetNode ← LoadImage
        const chain = resolveSetGetSource(app, upstream);
        setter = chain.setter;
        source = chain.source;
      }
      slots.push({
        node,
        input,
        slot: index,
        index: picture,
        bridge,
        bridgeSlot,
        bridgeInput: bridgeName,
        direct: upstream,
        setter,
        loader:
          source && /LoadImage/i.test(String(source.type || "")) && hasWidget(source, "image") ? source : null,
      });
    });
  }
  return slots.sort((a, b) => a.index - b.index);
}

/** 参考输入在当前节点上的索引（动态输入会被前端收起/重排，不能缓存旧索引） */
export function referenceInputSlot(node, name) {
  if (!node || !Array.isArray(node.inputs)) return -1;
  return node.inputs.findIndex((input) => input && String(input.name) === String(name));
}

/** 动态输入被收起时，尽力把 ref_images.ref_image_N 补回来（补不回来就返回 false） */
export function growReferenceInputs(node, count) {
  if (!node || !Array.isArray(node.inputs) || typeof node.addInput !== "function") return false;
  let added = false;
  for (let index = 0; index < count; index += 1) {
    const name = `ref_images.ref_image_${index}`;
    if (referenceInputSlot(node, name) >= 0) continue;
    try {
      node.addInput(name, "IMAGE");
      added = true;
    } catch (error) {
      break;
    }
  }
  return added;
}

/** 面板经手过、又没接在任何参考位上的加载窗口：清空图片并停用 */
export function pruneIdleLoaders(app) {
  let cleared = 0;
  for (const node of getAllNodes(app)) {
    if (!/LoadImage/i.test(String(node.type || ""))) continue;
    const props = node.properties || {};
    if (props.sbRefSlot == null && !props.sbReferenceLoader && !props.sbFrame) continue;
    const widget = getWidget(node, "image");
    if (!widget || !String(widget.value || "").trim()) continue;
    if (!isLoaderFree(node)) continue;
    widget.value = "";
    node.mode = 4;
    markDirty(app, node);
    cleared += 1;
  }
  return cleared;
}

/** 把已经直连参考条件的素材改接成「加载图 → 规则桥 → Ref2V」；桥到 Ref2V 始终连着 */
export function routeReferenceSlotsThroughBridge(app) {
  let slots = referenceImageSlots(app);
  if (!slots.length) return slots;
  const existingBridge = findRuleBridge(app);
  // 工作流本身用 SetNode/GetNode 中转素材（终极篇）：不要再插规则桥，否则会把间接接线全打乱
  if (!existingBridge && slots.some((slot) => slot.setter)) return slots;
  const bridge = existingBridge || ensureRuleBridge(app);
  if (!bridge) return slots;
  const refNode = slots[0].node;
  // 参考位被前端收起时补齐到 9 路：桥 → Ref2V 的连线必须一直完整，不能一次点击少一根
  if (growReferenceInputs(refNode, PICTURE_COUNT)) {
    slots = referenceImageSlots(app);
  }
  let changed = false;
  for (const slot of slots) {
    try {
      // 规则桥 → Ref2V：每一路都保持连接（空位由桥输出 None，Ref2V 会跳过）
      if (connectBridgeOutput(app, bridge, slot)) changed = true;
      if (slot.bridge) continue;
      const loader = slot.loader || followInput(app, slot.node, slot.input.name);
      if (!loader || !/LoadImage/i.test(String(loader.type || ""))) continue;
      const at = ensureBridgeInput(app, bridge, slot.bridgeInput);
      if (at < 0) continue;
      dropOtherOutputLinks(app, loader, bridge, at);
      if (connectOnce(app, loader, 0, bridge, at)) changed = true;
    } catch (error) {
      /* 单路失败不影响其它参考位 */
    }
  }
  if (changed) markDirty(app, bridge);
  return referenceImageSlots(app);
}

/** 参考位不够时先把动态输入补回来，再返回最新的参考位列表 */
export function ensureReferenceSlots(app, needed) {
  const slots = referenceImageSlots(app);
  if (!slots.length || slots.length >= needed) return slots;
  const node = slots[0].node;
  if (!growReferenceInputs(node, needed)) return slots;
  markDirty(app, node);
  return referenceImageSlots(app);
}

function isInputFree(node, slot) {
  const input = node && Array.isArray(node.inputs) ? node.inputs[slot] : null;
  return !input || input.link === undefined || input.link === null;
}

/** 断开某个输入上的连线（清空参考位用）：先走前端官方 API，不行再手工收尾 */
export function disconnectInput(app, node, slot) {
  const input = node && Array.isArray(node.inputs) ? node.inputs[slot] : null;
  if (!input || input.link === undefined || input.link === null) return false;
  const linkId = input.link;
  const link = getLink(app, linkId);

  // 1) 官方 API：会同时清 graph.links 和对端 outputs.links
  try {
    if (typeof node.disconnectInput === "function") {
      node.disconnectInput(slot);
      if (isInputFree(node, slot)) {
        markDirty(app, node);
        return true;
      }
    }
  } catch (error) {
    /* 退回手工处理 */
  }

  // 2) 图级 API：直接按 link id 删
  try {
    const graph = app && app.graph;
    if (graph && typeof graph.removeLink === "function") {
      graph.removeLink(linkId);
      if (isInputFree(node, slot)) {
        markDirty(app, node);
        return true;
      }
    }
  } catch (error) {
    /* 退回手工处理 */
  }

  // 3) 手工：输入口、对端输出口、graph.links 三处一起清
  try {
    input.link = null;
  } catch (error) {
    /* 输入口是只读的就跳过 */
  }
  if (link) {
    const origin = getNodeById(app, link.origin_id);
    const output = origin && Array.isArray(origin.outputs) ? origin.outputs[link.origin_slot] : null;
    if (output && Array.isArray(output.links)) {
      try {
        output.links = output.links.filter((id) => id !== linkId);
      } catch (error) {
        /* 输出口只读就跳过 */
      }
    }
  }
  removeGraphLink(app, linkId);
  markDirty(app, node);
  return isInputFree(node, slot);
}

/** graph.links 在不同前端版本里可能是对象或 Map，两个都要能删 */
function removeGraphLink(app, linkId) {
  const links = app && app.graph ? app.graph.links : null;
  if (!links) return;
  try {
    if (typeof links.delete === "function") {
      links.delete(linkId);
      return;
    }
    delete links[linkId];
  } catch (error) {
    /* 删不掉就留着 */
  }
}

/** 断开规则桥上某一路入口（按名字定位，不依赖输入口索引是否被前端重排） */
function clearBridgeInput(app, bridge, name) {
  const at = bridgeInputSlot(bridge, name);
  if (at < 0) return false;
  const input = bridge.inputs[at];
  if (!input || input.link === undefined || input.link === null) return false;
  const linkId = input.link;
  const loader = followInput(app, bridge, name);
  let freed = disconnectInput(app, bridge, at);
  if (!freed && loader && typeof loader.disconnectOutput === "function") {
    // 桥这一侧拆不掉时，改从加载窗口的输出口拆
    const link = getLink(app, linkId);
    try {
      loader.disconnectOutput(link ? link.origin_slot : 0, link ? link.target_slot : at);
    } catch (error) {
      /* 下一轮再试 */
    }
    if (isInputFree(bridge, at)) {
      try {
        input.link = null;
      } catch (error) {
        /* 输入口只读也没关系 */
      }
      freed = true;
    }
  }
  if (!freed) return false;
  // 这个窗口还接在别的参考位上就别动它
  if (loader && /LoadImage/i.test(String(loader.type || "")) && isLoaderFree(loader)) {
    const match = /^image_(\d+)$/i.exec(String(name));
    loader.properties = { ...(loader.properties || {}), sbRefSlot: match ? Number(match[1]) - 1 : 0 };
    const widget = getWidget(loader, "image");
    if (widget) widget.value = "";
    loader.mode = 4;
    markDirty(app, loader);
  }
  return true;
}

/** 规则桥上「Picture 序号 >= keep 且还连着线」的入口 */
function extraBridgeLinks(app, keep) {
  const bridge = findRuleBridge(app);
  if (!bridge || !Array.isArray(bridge.inputs)) return [];
  const extras = [];
  bridge.inputs.forEach((input, at) => {
    const match = /^image_(\d+)$/i.exec(String((input && input.name) || ""));
    if (!match) return;
    if (Number(match[1]) - 1 < keep) return;
    if (input.link === undefined || input.link === null) return;
    extras.push({ bridge, at, name: String(input.name), linkId: input.link });
  });
  return extras;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 把 Picture keepCount 之后的所有入口全部断开。
 * 直接扫规则桥上的实际连线，断开后等前端同步再复查，没断干净就再来一轮，
 * 保证「点一次」就把多余连线全断掉。
 */
export async function clearPictureSlotsFrom(app, keepCount) {
  const keep = Math.max(0, Math.trunc(Number(keepCount) || 0));
  const before = extraBridgeLinks(app, keep).length;
  let previous = before + 1;
  for (let pass = 0; pass < 4; pass += 1) {
    const extras = extraBridgeLinks(app, keep);
    if (!extras.length) break;
    if (extras.length >= previous) break; // 上一轮没有进展，别死循环
    previous = extras.length;
    for (let i = extras.length - 1; i >= 0; i -= 1) {
      try {
        clearBridgeInput(app, extras[i].bridge, extras[i].name);
      } catch (error) {
        /* 下一轮再试 */
      }
    }
    await sleep(30); // 等前端把连线状态同步完再复查
  }
  const left = extraBridgeLinks(app, keep).length;
  // SetNode/GetNode 中转的参考位：keep 之后把加载窗口清空并停用，GetNode → Ref2V 的线保留
  let chain = 0;
  for (const slot of referenceImageSlots(app)) {
    if (slot.index < keep || !slot.setter) continue;
    if (clearChainSlot(app, slot)) chain += 1;
  }
  return { cleared: Math.max(0, before - left) + chain, left };
}

/** 清空一个「SetNode 上游加载图」：窗口清空并停用，链路本身不动（GetNode 会拿到 None） */
function clearChainSlot(app, slot) {
  const loader = slot && slot.loader;
  if (!loader) return false;
  const widget = getWidget(loader, "image") || getWidget(loader, "audio") || getWidget(loader, "video");
  const value = widget ? String(widget.value || "").trim() : "";
  const empty = !value || /^none$/i.test(value);
  // 已经清空并停用过的窗口不再重复计数，但残留的 None 也一并抹掉
  const alreadyOff = empty && loader.mode === 4;
  if (widget) widget.value = "";
  loader.mode = 4;
  loader.properties = { ...(loader.properties || {}), sbRefSlot: slot.index };
  markDirty(app, loader);
  return !alreadyOff;
}

const REF_AUDIO_RE = /^ref_audios\.ref_audio_(\d+)$/i;
const REF_VIDEO_RE = /^ref_videos\.ref_video_(\d+)$/i;

/** Ref2V 的参考音频位（ref_audios.ref_audio_N）；loader 是当前接着的加载音频节点 */
export function referenceAudioSlots(app) {
  const slots = [];
  for (const node of getNodes(app)) {
    if (!STOCK_REF2V_TYPE.test(String(node.type || "")) || !Array.isArray(node.inputs)) continue;
    node.inputs.forEach((input, index) => {
      const match = REF_AUDIO_RE.exec(String((input && input.name) || ""));
      if (!match) return;
      const direct = followInput(app, node, input.name);
      // 终极篇：Ref2V ← GetNode(参考音频N) ← SetNode ← LoadAudio
      const chain = resolveSetGetSource(app, direct);
      slots.push({
        node,
        input,
        slot: index,
        index: Number(match[1]),
        direct,
        setter: chain.setter,
        loader: chain.source,
      });
    });
  }
  return slots.sort((a, b) => a.index - b.index);
}

/** 参考音频输入被前端收起时补回来 */
function growReferenceAudioInputs(node, count) {
  if (!node || !Array.isArray(node.inputs) || typeof node.addInput !== "function") return false;
  let added = false;
  for (let index = 0; index < count; index += 1) {
    const name = `ref_audios.ref_audio_${index}`;
    if (referenceInputSlot(node, name) >= 0) continue;
    try {
      node.addInput(name, "AUDIO");
      added = true;
    } catch (error) {
      break;
    }
  }
  return added;
}

/** 写入加载音频节点的文件名（新上传的文件先补进下拉列表） */
export function setNodeAudio(app, node, filename) {
  const widget = node ? getWidget(node, "audio") : null;
  if (!widget) return false;
  const alias = String(filename || "");
  if (widget.options && Array.isArray(widget.options.values) && !widget.options.values.includes(alias)) {
    widget.options.values.unshift(alias);
  }
  widget.value = alias;
  try {
    if (typeof widget.callback === "function") {
      widget.callback(alias, node.graph && node.graph.canvas ? node.graph.canvas : undefined, node, [0, 0], null);
    }
  } catch (error) {
    /* 某些前端 callback 参数不一致，忽略 */
  }
  markDirty(app, node);
  return true;
}

/** 把一个音频参考写到 ref_audios.ref_audio_N：复用已接的加载音频节点，没有就建一个 */
export function ensureReferenceAudio(app, index, filename) {
  const alias = String(filename || "").trim();
  if (!alias) return { ok: false, message: "音频名为空" };
  const slots = referenceAudioSlots(app);
  const node = slots.length ? slots[0].node : null;
  if (!node) return { ok: false, message: "当前工作流没有参考音频入口（ref_audios）" };
  const name = `ref_audios.ref_audio_${index}`;
  let slot = referenceInputSlot(node, name);
  if (slot < 0 && growReferenceAudioInputs(node, index + 1)) slot = referenceInputSlot(node, name);
  if (slot < 0) return { ok: false, message: `参考音频位 ${index + 1} 没展开` };

  // 工作流用 SetNode/GetNode 中转（终极篇）：写到链路里的加载音频节点
  const chainSlot = referenceAudioSlots(app).find((item) => item.index === index);
  if (chainSlot && chainSlot.setter) {
    const wiredAudio =
      chainSlot.loader && /LoadAudio/i.test(String(chainSlot.loader.type || "")) ? chainSlot.loader : null;
    if (wiredAudio) {
      if (!setNodeAudio(app, wiredAudio, alias)) return { ok: false, message: "加载音频节点写不进文件" };
      wiredAudio.properties = { ...(wiredAudio.properties || {}), sbRefAudio: index + 1 };
      wiredAudio.mode = 0;
      markDirty(app, wiredAudio);
      return { ok: true, loader: wiredAudio };
    }
    const setter = chainSlot.setter;
    const inputAt = (setter.inputs || []).findIndex((item) => item && (item.link === undefined || item.link === null));
    if (inputAt < 0) return { ok: false, message: `参考音频 ${index + 1} 的上游没有空位` };
    const factory = liteGraphFactory();
    if (!factory || typeof factory.createNode !== "function") {
      return { ok: false, message: "当前前端不支持创建加载音频节点" };
    }
    let createdAudio = null;
    try {
      createdAudio = factory.createNode("LoadAudio");
      if (!createdAudio) return { ok: false, message: "创建加载音频节点失败" };
      const pos = Array.isArray(node.pos) ? node.pos : [0, 0];
      createdAudio.pos = [Math.max(0, Number(pos[0]) - 900), Number(pos[1]) + 120 + index * 90];
      if (app.graph && typeof app.graph.add === "function") app.graph.add(createdAudio);
    } catch (error) {
      return { ok: false, message: "创建加载音频节点失败" };
    }
    createdAudio.properties = { ...(createdAudio.properties || {}), sbRefAudio: index + 1 };
    createdAudio.mode = 0;
    if (!setNodeAudio(app, createdAudio, alias)) return { ok: false, message: "加载音频节点写不进文件" };
    if (!connectOnce(app, createdAudio, 0, setter, inputAt)) return { ok: false, message: "音频接不上参考位" };
    markDirty(app, createdAudio);
    return { ok: true, loader: createdAudio, created: true };
  }

  const wired = followInput(app, node, name);
  if (wired && /LoadAudio/i.test(String(wired.type || ""))) {
    if (!setNodeAudio(app, wired, alias)) return { ok: false, message: "加载音频节点写不进文件" };
    wired.properties = { ...(wired.properties || {}), sbRefAudio: index + 1 };
    wired.mode = 0;
    markDirty(app, wired);
    return { ok: true, loader: wired };
  }

  let loader =
    getAllNodes(app).find(
      (candidate) =>
        /LoadAudio/i.test(String(candidate.type || "")) &&
        candidate.mode !== 2 &&
        hasWidget(candidate, "audio") &&
        isLoaderFree(candidate)
    ) || null;
  if (!loader) {
    const factory = liteGraphFactory();
    if (!factory || typeof factory.createNode !== "function") {
      return { ok: false, message: "当前前端不支持创建加载音频节点" };
    }
    try {
      loader = factory.createNode("LoadAudio");
      if (!loader) return { ok: false, message: "创建加载音频节点失败" };
      const pos = Array.isArray(node.pos) ? node.pos : [0, 0];
      loader.pos = [Math.max(0, Number(pos[0]) - 620), Number(pos[1]) + 120 + index * 90];
      if (app.graph && typeof app.graph.add === "function") app.graph.add(loader);
      markDirty(app, loader);
    } catch (error) {
      return { ok: false, message: "创建加载音频节点失败" };
    }
  }
  loader.properties = { ...(loader.properties || {}), sbRefAudio: index + 1 };
  loader.mode = 0;
  if (!setNodeAudio(app, loader, alias)) return { ok: false, message: "加载音频节点写不进文件" };
  if (!connectOnce(app, loader, 0, node, slot)) return { ok: false, message: "音频接不上参考位" };
  markDirty(app, loader);
  return { ok: true, loader, created: true };
}

/** 断开 keep 之后的参考音频位，并清空/停用对应的加载音频节点 */
export function clearAudioSlotsFrom(app, keep) {
  const count = Math.max(0, Math.trunc(Number(keep) || 0));
  let cleared = 0;
  for (const slot of referenceAudioSlots(app)) {
    if (slot.index < count) continue;
    // SetNode/GetNode 中转：清空并停用加载音频，保留 GetNode → Ref2V 的线
    if (slot.setter) {
      if (clearChainSlot(app, slot)) cleared += 1;
      continue;
    }
    if (slot.input.link === undefined || slot.input.link === null) continue;
    const loader = slot.loader;
    if (!disconnectInput(app, slot.node, slot.slot)) continue;
    if (loader && /LoadAudio/i.test(String(loader.type || "")) && isLoaderFree(loader)) {
      const widget = getWidget(loader, "audio");
      if (widget) widget.value = "";
      loader.mode = 4;
      markDirty(app, loader);
    }
    cleared += 1;
  }
  return cleared;
}

/** 参考视频位（ref_videos.ref_video_N）：终极篇是 Ref2V ← GetNode ← SetNode ← VHS_LoadVideo */
export function referenceVideoSlots(app) {
  const slots = [];
  for (const node of getNodes(app)) {
    if (!STOCK_REF2V_TYPE.test(String(node.type || "")) || !Array.isArray(node.inputs)) continue;
    node.inputs.forEach((input, index) => {
      const match = REF_VIDEO_RE.exec(String((input && input.name) || ""));
      if (!match) return;
      const direct = followInput(app, node, input.name);
      const chain = resolveSetGetSource(app, direct);
      slots.push({
        node,
        input,
        slot: index,
        index: Number(match[1]),
        direct,
        setter: chain.setter,
        loader: chain.source,
      });
    });
  }
  return slots.sort((a, b) => a.index - b.index);
}

/**
 * 写加载视频节点的文件名。
 * 值支持 ComfyUI 的 annotated 路径：上一镜输出在 output 目录，
 * 写成 `[output]xxx.mp4` 就能被 VHS_LoadVideo 直接读到，不用复制到 input。
 */
export function setNodeVideo(app, node, filename) {
  const widget = node ? getWidget(node, "video") : null;
  if (!widget) return false;
  const alias = String(filename || "");
  if (widget.options && Array.isArray(widget.options.values) && !widget.options.values.includes(alias)) {
    widget.options.values.unshift(alias);
  }
  widget.value = alias;
  try {
    if (typeof widget.callback === "function") {
      widget.callback(alias, node.graph && node.graph.canvas ? node.graph.canvas : undefined, node, [0, 0], null);
    }
  } catch (error) {
    /* 某些前端 callback 参数不一致，忽略 */
  }
  // H3 参考视频要求 24fps；只取前 5 秒（120 帧），够锁定人物/服装/环境，又不会把显存吃满
  const rate = getWidget(node, "force_rate");
  if (rate) rate.value = 24;
  const cap = getWidget(node, "frame_load_cap");
  if (cap) cap.value = 120;
  const skip = getWidget(node, "skip_first_frames");
  if (skip) skip.value = 0;
  markDirty(app, node);
  return true;
}

/** 把上一镜的输出视频写到 ref_videos.ref_video_N */
export function ensureReferenceVideo(app, index, filename) {
  const alias = String(filename || "").trim();
  if (!alias) return { ok: false, message: "视频名为空" };
  const slots = referenceVideoSlots(app);
  if (!slots.length) return { ok: false, message: "当前工作流没有参考视频入口（ref_videos）" };
  const slot = slots.find((item) => item.index === index);
  if (!slot) return { ok: false, message: `参考视频位 ${index + 1} 没展开` };
  const loader =
    slot.loader && /LoadVideo/i.test(String(slot.loader.type || "")) ? slot.loader : null;
  if (!loader) return { ok: false, message: `参考视频 ${index + 1} 没有接加载视频节点` };
  if (!setNodeVideo(app, loader, alias)) return { ok: false, message: "加载视频节点写不进文件" };
  loader.properties = { ...(loader.properties || {}), sbRefVideo: index + 1 };
  loader.mode = 0;
  markDirty(app, loader);
  return { ok: true, loader };
}

/** 清空面板经手的参考视频位，加载视频节点停用（保留 GetNode → Ref2V 的线） */
export function clearVideoSlotsFrom(app, keep) {
  const count = Math.max(0, Math.trunc(Number(keep) || 0));
  let cleared = 0;
  for (const slot of referenceVideoSlots(app)) {
    if (slot.index < count) continue;
    const loader = slot.loader;
    if (!loader || !/LoadVideo/i.test(String(loader.type || ""))) continue;
    // 只动面板写过的，用户自己接的视频不碰
    if (!loader.properties || loader.properties.sbRefVideo == null) continue;
    if (slot.setter) {
      if (clearChainSlot(app, slot)) cleared += 1;
      continue;
    }
    const widget = getWidget(loader, "video");
    if (widget) widget.value = "";
    loader.mode = 4;
    markDirty(app, loader);
    cleared += 1;
  }
  return cleared;
}

/** 清空一个参考位：断开连线、清空窗口里的图片，窗口本身保留（方便下次复用） */
export function clearReferenceSlot(app, slot, removeNode = false) {
  // SetNode/GetNode 中转的参考位：只清空并停用加载窗口，保留 GetNode → Ref2V 这条线
  if (slot && slot.setter) return clearChainSlot(app, slot);
  const refName = slot && slot.input ? slot.input.name : "";
  const bridge = slot && slot.bridge;
  let loader = (slot && slot.loader) || null;
  let removed = false;
  if (bridge) {
    // 只断开「加载图 → 规则桥」；规则桥 → Ref2V 的连线保持不动
    const outLinks =
      loader && Array.isArray(loader.outputs) && loader.outputs[0] && Array.isArray(loader.outputs[0].links)
        ? loader.outputs[0].links.slice()
        : [];
    if (outLinks.length) {
      // 只断这个窗口实际接着的那一路，别碰别的参考位
      for (let i = 0; i < bridge.inputs.length; i += 1) {
        const input = bridge.inputs[i];
        if (!input || input.link === undefined || input.link === null) continue;
        if (!outLinks.includes(input.link)) continue;
        removed = disconnectInput(app, bridge, i) || removed;
      }
    } else {
      // 没有可识别的加载窗口时才按名字兜底
      const at = bridgeInputSlot(bridge, slot.bridgeInput);
      if (at >= 0 && bridge.inputs[at].link !== undefined && bridge.inputs[at].link !== null) {
        loader = followInput(app, bridge, slot.bridgeInput) || loader;
        removed = disconnectInput(app, bridge, at) || removed;
      }
    }
  } else {
    // 动态输入的索引会变，按名字现查
    const at = slot && slot.node ? referenceInputSlot(slot.node, refName) : -1;
    const input = at >= 0 ? slot.node.inputs[at] : null;
    if (input && input.link !== undefined && input.link !== null) {
      loader = followInput(app, slot.node, refName) || loader;
      removed = disconnectInput(app, slot.node, at) || removed;
    }
  }
  const isLoader = loader && /LoadImage/i.test(String(loader.type || ""));
  const widget = isLoader ? getWidget(loader, "image") : null;
  const hasImage = !!(widget && String(widget.value || "").trim());
  // 已经断开、但窗口里还留着旧图：只在窗口空闲时清空，避免动到别处正在用的图
  if (!removed && !(hasImage && isLoaderFree(loader))) return false;
  if (isLoader) {
    loader.properties = { ...(loader.properties || {}), sbRefSlot: slot.index };
    if (widget) {
      widget.value = "";
    }
    // 本镜用不到就把加载图设为“停用”，避免占位图继续参与采样
    loader.mode = 4;
    markDirty(app, loader);
    const output = Array.isArray(loader.outputs) ? loader.outputs[0] : null;
    const links = (output && Array.isArray(output.links) ? output.links : []) || [];
    if (removeNode && !links.length && app.graph && typeof app.graph.remove === "function") {
      try {
        app.graph.remove(loader);
      } catch (error) {
        /* 删不掉就留着 */
      }
    }
  }
  return true;
}

function isLoaderFree(loader) {
  const output = Array.isArray(loader.outputs) ? loader.outputs[0] : null;
  const links = (output && Array.isArray(output.links) ? output.links : []) || [];
  return links.length === 0;
}

function loaderDistance(loader, refNode) {
  const pos = Array.isArray(loader.pos) ? loader.pos : [0, 0];
  const ref = refNode && Array.isArray(refNode.pos) ? refNode.pos : [0, 0];
  return Math.abs(Number(ref[0]) - Number(pos[0])) + Math.abs(Number(ref[1]) - Number(pos[1])) * 0.3;
}

/** 画布上可复用的空闲加载图（按离参考节点的远近排序，优先面板创建过的） */
function pickFreeLoader(app, slot) {
  return (
    getAllNodes(app)
      .filter(
        (node) =>
          /LoadImage/i.test(String(node.type || "")) &&
          hasWidget(node, "image") &&
          node.mode !== 2 &&
          isLoaderFree(node)
      )
      .sort((a, b) => {
        const markedA = a.properties && (a.properties.sbReferenceLoader || a.properties.sbRefSlot != null) ? 0 : 1;
        const markedB = b.properties && (b.properties.sbReferenceLoader || b.properties.sbRefSlot != null) ? 0 : 1;
        if (markedA !== markedB) return markedA - markedB;
        return loaderDistance(a, slot.node) - loaderDistance(b, slot.node);
      })[0] || null
  );
}

/** 规则桥的输出接到参考条件的对应 Picture 位 */
function connectBridgeOutput(app, bridge, slot) {
  const refName = slot.input ? slot.input.name : "";
  let at = referenceInputSlot(slot.node, refName);
  if (at < 0 && growReferenceInputs(slot.node, slot.index + 1)) {
    at = referenceInputSlot(slot.node, refName);
  }
  if (at < 0) return false;
  return connectOnce(app, bridge, slot.index, slot.node, at);
}

/** 把一个参考图位写成指定图片：素材先过规则桥，再进参考条件；不新增窗口 */
export function ensureReferenceImage(app, slot, filename, preferred = null) {
  const alias = String(filename || "").trim();
  if (!alias) return { ok: false, message: "图片名为空" };
  const targetName = slot.input ? slot.input.name : "";
  // 工作流用 SetNode/GetNode 中转素材（终极篇）：按链路写加载窗口，不插规则桥
  if (!slot.bridge && slot.setter) {
    const source = slot.loader;
    if (source && hasWidget(source, "image")) {
      if (!setNodeImage(app, source, alias)) return { ok: false, message: "加载图像节点无法写入图片" };
      source.properties = { ...(source.properties || {}), sbRefSlot: slot.index };
      source.mode = 0;
      markDirty(app, source);
      return { ok: true, loader: source };
    }
    // SetNode 上游空着：把一个加载窗口接到它的空输入口
    const setter = slot.setter;
    const at = (setter.inputs || []).findIndex((item) => item && (item.link === undefined || item.link === null));
    if (at < 0) return { ok: false, message: `参考位 ${slot.index + 1} 的上游已经被占满` };
    let loader = preferred && /LoadImage/i.test(String(preferred.type || "")) && hasWidget(preferred, "image") ? preferred : null;
    let created = false;
    if (!loader) {
      const factory = liteGraphFactory();
      if (!factory) return { ok: false, message: "当前前端不支持创建加载图像节点" };
      try {
        loader = factory.createNode("LoadImage");
        if (!loader) return { ok: false, message: "创建加载图像节点失败" };
        const pos = Array.isArray(slot.node.pos) ? slot.node.pos : [0, 0];
        loader.pos = [Math.max(0, Number(pos[0]) - 900), Number(pos[1]) + slot.index * 90];
        loader.properties = { ...(loader.properties || {}), sbReferenceLoader: true, sbRefSlot: slot.index };
        if (app.graph && typeof app.graph.add === "function") app.graph.add(loader);
        created = true;
      } catch (error) {
        return { ok: false, message: "创建加载图像节点失败" };
      }
    }
    if (!setNodeImage(app, loader, alias)) return { ok: false, message: "加载图像节点无法写入图片" };
    loader.mode = 0;
    if (!connectOnce(app, loader, 0, setter, at)) return { ok: false, message: `参考位 ${slot.index + 1} 接不上` };
    markDirty(app, loader);
    return { ok: true, loader, created };
  }
  // 素材连接参考条件必须先经过「参考图规则桥」
  const bridge = slot.bridge || (slot.setter ? null : ensureRuleBridge(app));
  if (bridge) bridge.mode = 0;
  const wired = bridge ? followInput(app, bridge, slot.bridgeInput) : followInput(app, slot.node, targetName);
  if (wired && hasWidget(wired, "image")) {
    if (!setNodeImage(app, wired, alias)) return { ok: false, message: "加载图像节点无法写入图片" };
    wired.properties = { ...(wired.properties || {}), sbRefSlot: slot.index };
    wired.mode = 0;
    if (bridge && !connectBridgeOutput(app, bridge, slot)) {
      return { ok: false, message: "规则桥接不上参考位" };
    }
    markDirty(app, wired);
    return { ok: true, loader: wired };
  }
  // 目标槽位：有规则桥就接桥的 image_N，否则直连参考位
  let targetNode = slot.node;
  let targetSlot = 0;
  if (bridge) {
    targetNode = bridge;
    targetSlot = ensureBridgeInput(app, bridge, slot.bridgeInput);
    if (targetSlot < 0) return { ok: false, message: `规则桥没有 ${slot.bridgeInput} 入口` };
  } else {
    // 动态输入的索引会变，按名字现查；被前端收起时先尝试补回来
    targetSlot = referenceInputSlot(slot.node, targetName);
    if (targetSlot < 0 && growReferenceInputs(slot.node, slot.index + 1)) {
      targetSlot = referenceInputSlot(slot.node, targetName);
    }
    if (targetSlot < 0) {
      return { ok: false, message: `参考位 Picture ${slot.index + 1} 没展开` };
    }
  }
  // 这个位置清空前接的加载窗口（最可靠，不依赖标记是否还在）
  const preferredLoader =
    preferred &&
    /LoadImage/i.test(String(preferred.type || "")) &&
    hasWidget(preferred, "image") &&
    preferred.mode !== 2 &&
    isLoaderFree(preferred)
      ? preferred
      : null;
  let reusable = preferredLoader;
  // 其次复用这个参考位之前用过的窗口（已断开、图片被清空；停用节点也算，先取全部节点）
  if (!reusable) {
    reusable = getAllNodes(app).find(
      (node) =>
        /LoadImage/i.test(String(node.type || "")) &&
        hasWidget(node, "image") &&
        node.properties &&
        node.properties.sbRefSlot === slot.index &&
        isLoaderFree(node)
    );
  }
  // 标记丢了（例如重开工作流）也不要新建窗口：直接复用画布上空闲的加载图
  if (!reusable) reusable = pickFreeLoader(app, slot);
  if (reusable) {
    if (!setNodeImage(app, reusable, alias)) return { ok: false, message: "加载图像节点无法写入图片" };
    reusable.properties = { ...(reusable.properties || {}), sbRefSlot: slot.index };
    reusable.mode = 0;
    // 一个加载窗口只接一个参考位，先清掉多余的出线
    dropOtherOutputLinks(app, reusable, targetNode, targetSlot);
    if (!connectOnce(app, reusable, 0, targetNode, targetSlot)) {
      return { ok: false, message: bridge ? "素材接不上规则桥" : "参考图位接不上" };
    }
    if (bridge && !connectBridgeOutput(app, bridge, slot)) {
      return { ok: false, message: "规则桥接不上参考位" };
    }
    markDirty(app, reusable);
    return { ok: true, loader: reusable, reused: true };
  }
  const factory = liteGraphFactory();
  if (!factory) return { ok: false, message: "当前前端不支持创建加载图像节点" };
  let loader = null;
  try {
    loader = factory.createNode("LoadImage");
    if (!loader) return { ok: false, message: "创建加载图像节点失败" };
    const pos = slot.node.pos || [0, 0];
    loader.pos = [Math.max(0, Number(pos[0]) - 620), Number(pos[1]) + slot.index * 90];
    loader.properties = { ...(loader.properties || {}), sbReferenceLoader: true, sbRefSlot: slot.index };
    if (app.graph && typeof app.graph.add === "function") app.graph.add(loader);
    if (!setNodeImage(app, loader, alias)) return { ok: false, message: "加载图像节点无法写入图片" };
    if (!connectOnce(app, loader, 0, targetNode, targetSlot)) {
      return { ok: false, message: bridge ? "素材接不上规则桥" : "参考图位接不上" };
    }
    if (bridge && !connectBridgeOutput(app, bridge, slot)) {
      return { ok: false, message: "规则桥接不上参考位" };
    }
    markDirty(app, loader);
    markDirty(app, slot.node);
    return { ok: true, loader, created: true };
  } catch (error) {
    return { ok: false, message: "创建参考图加载节点失败" };
  }
}

/** 素材编号 → 默认参考标签（R-01 -> r_01） */
export function defaultReferenceTag(code) {
  const tag = String(code || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return tag || "ref";
}

/** 工作流里所有能接收 H3_TAGGED_REFERENCES 的输入（Ref2VA / Loop Start 校验） */
export function taggedReferenceTargets(app) {
  const targets = [];
  for (const node of getNodes(app)) {
    if (node.mode === 2 || !Array.isArray(node.inputs)) continue;
    // 参考图节点自己的 previous 是内部串联，不算工作流入口
    if (TAGGED_PICTURE_TYPE.test(String(node.type || ""))) continue;
    node.inputs.forEach((input, index) => {
      if (!input || String(input.type || "") !== "H3_TAGGED_REFERENCES") return;
      targets.push({
        node,
        input,
        slot: index,
        ref2v: TAGGED_REF2V_TYPE.test(String(node.type || "")),
      });
    });
  }
  return targets;
}

export function findTaggedPictureNodes(app) {
  return getNodes(app).filter((node) => node.mode !== 2 && TAGGED_PICTURE_TYPE.test(String(node.type || "")));
}

/** 同一个输出只能接一个参考位：把加载图其它多余的出线都拆掉 */
function dropOtherOutputLinks(app, node, keepTarget, keepSlot) {
  const output = node && Array.isArray(node.outputs) ? node.outputs[0] : null;
  if (!output || !Array.isArray(output.links)) return 0;
  let dropped = 0;
  for (const linkId of output.links.slice()) {
    const link = getLink(app, linkId);
    if (link && keepTarget && String(link.target_id) === String(keepTarget.id) && Number(link.target_slot) === Number(keepSlot)) {
      continue;
    }
    if (link) {
      const other = getNodeById(app, link.target_id);
      const otherInput = other && Array.isArray(other.inputs) ? other.inputs[link.target_slot] : null;
      if (otherInput && otherInput.link === linkId) {
        try {
          otherInput.link = null;
        } catch (error) {
          /* 输入口只读就跳过 */
        }
      }
      removeGraphLink(app, linkId);
    }
    try {
      output.links = output.links.filter((id) => id !== linkId);
    } catch (error) {
      /* 输出口只读就跳过 */
    }
    dropped += 1;
  }
  if (dropped) markDirty(app, node);
  return dropped;
}

/** 目标口现在接的是不是「这个节点的这个输出口」 */
function inputLinkMatches(app, node, slot, origin, originSlot) {
  const input = node && Array.isArray(node.inputs) ? node.inputs[slot] : null;
  if (!input || input.link === undefined || input.link === null) return false;
  const link = getLink(app, input.link);
  // 前端没把 link 存进 graph.links（结构不同/旧数据）：只能相信输入口本身
  if (!link) return true;
  return String(link.origin_id) === String(origin.id) && Number(link.origin_slot) === Number(originSlot);
}

/** 只负责连线（官方 connect → graph.connect），接完核对，接不上就返回 false */
function tryConnect(app, origin, originSlot, target, targetSlot) {
  try {
    if (typeof origin.connect === "function") {
      origin.connect(originSlot, target, targetSlot);
      if (inputLinkMatches(app, target, targetSlot, origin, originSlot)) return true;
    }
  } catch (error) {
    /* 换 graph.connect 再试 */
  }
  try {
    if (app.graph && typeof app.graph.connect === "function") {
      app.graph.connect(origin, originSlot, target, targetSlot);
      if (inputLinkMatches(app, target, targetSlot, origin, originSlot)) return true;
    }
  } catch (error) {
    /* 接不上就交给外面处理 */
  }
  return false;
}

function connectOnce(app, origin, originSlot, target, targetSlot) {
  if (!origin || !target) return false;
  if (inputLinkMatches(app, target, targetSlot, origin, originSlot)) return true;
  // 先直接接：LiteGraph 会自己替换目标口原来的线，比「先断后接」安全（断完接不上会丢线）
  if (tryConnect(app, origin, originSlot, target, targetSlot)) return true;
  // 旧线挡着接不上时才断开重试
  disconnectInput(app, target, targetSlot);
  if (!tryConnect(app, origin, originSlot, target, targetSlot)) return false;
  return true;
}

/** 确保某个素材有一个 Tagged Picture 参考节点（LoadImage → 参考节点），返回节点 */
export function ensureTaggedPicture(app, tag, filename) {
  const factory = liteGraphFactory();
  if (!factory) return { ok: false, message: "当前 ComfyUI 前端不支持自动创建参考节点" };
  const alias = String(tag || "").trim();
  if (!alias) return { ok: false, message: "参考标签为空" };

  const existing = getAllNodes(app)
    .filter((node) => TAGGED_PICTURE_TYPE.test(String(node.type || "")))
    .find((node) => {
      const widget = getWidget(node, "tag");
      return widget && String(widget.value) === alias;
    });

  let loader = existing ? followInput(app, existing, "image") : null;
  let refNode = existing || null;
  let created = 0;

  if (!loader) {
    try {
      loader = factory.createNode("LoadImage");
      if (!loader) return { ok: false, message: "创建加载图像节点失败" };
      const pos = refNode && refNode.pos ? refNode.pos : [0, 0];
      loader.pos = [Math.max(0, Number(pos[0]) - 620), Number(pos[1]) + 40];
      loader.properties = { ...(loader.properties || {}), sbReferenceLoader: true };
      if (app.graph && typeof app.graph.add === "function") app.graph.add(loader);
      markDirty(app, loader);
      created += 1;
    } catch (error) {
      return { ok: false, message: "创建加载图像节点失败" };
    }
  }

  if (!setNodeImage(app, loader, filename)) {
    return { ok: false, message: "加载图像节点无法写入图片" };
  }

  if (!refNode) {
    try {
      refNode = factory.createNode("MiniMaxH3TaggedPictureReference");
      if (!refNode) return { ok: false, message: "创建参考图节点失败" };
      const pos = loader.pos || [0, 0];
      refNode.pos = [Number(pos[0]) + 320, Number(pos[1]) - 40];
      refNode.properties = { ...(refNode.properties || {}), sbReference: true };
      if (app.graph && typeof app.graph.add === "function") app.graph.add(refNode);
      setWidget(refNode, "tag", alias);
      markDirty(app, refNode);
      created += 1;
    } catch (error) {
      return { ok: false, message: "创建参考图节点失败" };
    }
  }

  const imageSlot = (refNode.inputs || []).findIndex((input) => input && input.name === "image");
  if (imageSlot >= 0) connectOnce(app, loader, 0, refNode, imageSlot);

  return { ok: true, node: refNode, loader, created, tag: alias };
}

/** 把参考节点串成链，并接到工作流的参考输入上 */
export function wireTaggedReferences(app) {
  const nodes = findTaggedPictureNodes(app);
  if (!nodes.length) return { ok: false, message: "还没有参考图节点" };
  const ordered = nodes.slice().sort((a, b) => Number(a.id) - Number(b.id));

  for (let index = 1; index < ordered.length; index += 1) {
    const previousSlot = (ordered[index].inputs || []).findIndex((input) => input && input.name === "previous");
    if (previousSlot >= 0) connectOnce(app, ordered[index - 1], 0, ordered[index], previousSlot);
  }

  const tail = ordered[ordered.length - 1];
  const targets = taggedReferenceTargets(app);
  let wired = 0;
  for (const target of targets) {
    if (connectOnce(app, tail, 0, target.node, target.slot)) wired += 1;
  }
  markDirty(app, tail);
  const capable = hasReferenceConditioning(app);
  return {
    ok: true,
    count: ordered.length,
    wired,
    hasRef2V: targets.some((target) => target.ref2v),
    capable,
    message: !capable
      ? `参考图 ${ordered.length} 张已串好，但当前工作流没有启用的 Ref2V 节点：素材不会参与生成（请换 Ref2V Studio 一类工作流）`
      : wired
        ? `参考图 ${ordered.length} 张已接入 ${wired} 个入口`
        : `参考图 ${ordered.length} 张已串好，但参考入口没接上`,
  };
}

/** 移除不再需要的面板参考节点（换素材时清掉上一批残留） */
export function pruneReferenceNodes(app, keepTags) {
  const keep = new Set((keepTags || []).map((tag) => String(tag)));
  const stale = getAllNodes(app).filter((node) => {
    if (node.mode === 2 || !TAGGED_PICTURE_TYPE.test(String(node.type || ""))) return false;
    const widget = getWidget(node, "tag");
    if (keep.has(String(widget ? widget.value : ""))) return false;
    if (node.properties && node.properties.sbReference) return true;
    const loader = followInput(app, node, "image");
    const image = loader ? getWidget(loader, "image") : null;
    return !!(image && /_cut\.png$/i.test(String(image.value || "")));
  });
  let nodes = 0;
  let loaders = 0;
  const orphanLoaders = [];
  for (const node of stale) {
    const loader = followInput(app, node, "image");
    try {
      app.graph.remove(node);
      nodes += 1;
    } catch (error) {
      continue;
    }
    if (loader) orphanLoaders.push(loader);
  }
  for (const loader of orphanLoaders) {
    const stillUsed = findTaggedPictureNodes(app).some(
      (node) => followInput(app, node, "image") === loader
    );
    if (stillUsed) continue;
    const properties = loader.properties || {};
    const widget = getWidget(loader, "image");
    if (!(properties.sbReferenceLoader || (widget && /_cut\.png$/i.test(String(widget.value || ""))))) {
      continue;
    }
    try {
      app.graph.remove(loader);
      loaders += 1;
    } catch (error) {
      /* 配套加载图像删不掉就留着 */
    }
  }
  if (nodes || loaders) markDirty(app, null);
  return { nodes, loaders };
}

/** 移除面板创建的参考图节点（Tagged Picture + 配套的 _cut.png 加载图像） */
export function removeReferenceNodes(app) {
  const refs = getAllNodes(app)
    .filter((node) => node.mode !== 2 && TAGGED_PICTURE_TYPE.test(String(node.type || "")))
    .filter((node) => {
    if (node.properties && node.properties.sbReference) return true;
    // 兼容旧版本创建、没有标记的节点：图片是面板抠图产物
    const loader = followInput(app, node, "image");
    const widget = loader ? getWidget(loader, "image") : null;
    return !!(widget && /_cut\.png$/i.test(String(widget.value || "")));
  });
  let nodes = 0;
  let loaders = 0;
  for (const node of refs) {
    const loader = followInput(app, node, "image");
    try {
      if (app.graph && typeof app.graph.remove === "function") app.graph.remove(node);
      nodes += 1;
    } catch (error) {
      continue;
    }
    const properties = (loader && loader.properties) || {};
    const widget = loader ? getWidget(loader, "image") : null;
    if (loader && (properties.sbReferenceLoader || (widget && /_cut\.png$/i.test(String(widget.value || ""))))) {
      try {
        app.graph.remove(loader);
        loaders += 1;
      } catch (error) {
        /* 配套加载图像删不掉就留着 */
      }
    }
  }
  return { nodes, loaders };
}

/** 找 MiniMax H3 Chain 的 Production Plan 节点（提示词真正存在这里） */
export function findH3PlanNode(app) {
  return (
    getNodes(app).find(
      (node) =>
        node.mode !== 2 &&
        /^MiniMaxH3ChainPlan(?:Modern)?$/i.test(String(node.type || "")) &&
        hasWidget(node, "plan_json")
    ) || null
  );
}

/** 写入 H3 计划的全局前缀（prompt_prefix），其余字段保持不动 */
export function writePlanPromptPrefix(app, text) {
  const info = readH3Plan(app);
  if (!info) return { ok: false, message: "没有找到 H3 计划节点（plan_json）" };
  const plan = { ...info.plan, prompt_prefix: String(text || "").trim() };
  if (!setWidget(info.node, "plan_json", JSON.stringify(plan, null, 2))) {
    return { ok: false, message: "计划节点的 plan_json 无法写入" };
  }
  markDirty(app, info.node);
  return { ok: true };
}

/** 读取 H3 计划：{node, plan, shots, active}；不是 H3 工作流则返回 null */
export function readH3Plan(app) {
  const node = findH3PlanNode(app);
  if (!node) return null;
  const widget = getWidget(node, "plan_json");
  if (!widget) return null;
  try {
    const plan = JSON.parse(String(widget.value || ""));
    if (!plan || typeof plan !== "object") return null;
    const shots = Array.isArray(plan.shots) ? plan.shots : [];
    const editor = getNodes(app).find((item) =>
      /MiniMaxH3ChainScenePromptEditor/i.test(String(item.type || ""))
    );
    const active = editor
      ? Math.max(
          0,
          Math.trunc(Number(editor.properties && editor.properties["h3_scene_prompt_editor_active_scene"]) || 0)
        )
      : 0;
    return { node, plan, shots, active };
  } catch (error) {
    return null;
  }
}

/** 修改 H3 计划的某一镜（prompt / steps / seed），并同步 Scene Prompts 的当前镜 */
export function writeH3Shot(app, index, patch) {
  const info = readH3Plan(app);
  if (!info) return { ok: false, message: "没有找到 H3 计划节点（plan_json）" };
  const shots = Array.isArray(info.plan.shots) ? info.plan.shots : (info.plan.shots = []);
  if (!shots.length) return { ok: false, message: "H3 计划里还没有镜头" };
  const target = Math.min(Math.max(0, Math.trunc(Number(index) || 0)), shots.length - 1);
  const shot = shots[target] && typeof shots[target] === "object" ? shots[target] : (shots[target] = {});
  Object.assign(shot, patch || {});
  const ok = setWidget(info.node, "plan_json", JSON.stringify(info.plan, null, 2));
  if (!ok) return { ok: false, message: "计划节点的 plan_json 无法写入" };
  markDirty(app, info.node);
  const editor = getNodes(app).find((item) =>
    /MiniMaxH3ChainScenePromptEditor/i.test(String(item.type || ""))
  );
  if (editor) {
    editor.properties = editor.properties || {};
    editor.properties["h3_scene_prompt_editor_active_scene"] = target;
    markDirty(app, editor);
  }
  return { ok: true, index: target, id: shot.id || `#${target + 1}`, count: shots.length };
}

/** 整份写回 H3 计划（批量同步分镜时用） */
export function writeH3Plan(app, plan) {
  const node = findH3PlanNode(app);
  if (!node) return { ok: false, message: "没有找到 H3 计划节点（plan_json）" };
  const ok = setWidget(node, "plan_json", JSON.stringify(plan, null, 2));
  if (!ok) return { ok: false, message: "计划节点的 plan_json 无法写入" };
  markDirty(app, node);
  const editor = getNodes(app).find((item) =>
    /MiniMaxH3ChainScenePromptEditor/i.test(String(item.type || ""))
  );
  if (editor) {
    editor.properties = editor.properties || {};
    editor.properties["h3_scene_prompt_editor_active_scene"] = 0;
    markDirty(app, editor);
  }
  return { ok: true, count: Array.isArray(plan.shots) ? plan.shots.length : 0 };
}

/** 读取 H3 计划节点的全局宽高（计划模式下所有镜头共用） */
export function getPlanResolution(app) {
  const node = findH3PlanNode(app);
  if (!node) return null;
  const width = getWidget(node, "width");
  const height = getWidget(node, "height");
  if (!width || !height) return null;
  return { nodeId: String(node.id), width: Number(width.value), height: Number(height.value) };
}

/** 改 H3 计划的全局宽高（草稿/成片切换用） */
export function setPlanResolution(app, width, height) {
  const node = findH3PlanNode(app);
  if (!node) return { ok: false, message: "当前工作流没有 H3 计划节点" };
  if (!setWidget(node, "width", width) || !setWidget(node, "height", height)) {
    return { ok: false, message: "计划节点没有宽高控件" };
  }
  markDirty(app, node);
  return { ok: true, width, height };
}

/** 把计划里所有镜头的步数改成同一个值，返回原始步数用于恢复 */
export function setPlanSteps(app, steps) {
  const info = readH3Plan(app);
  if (!info) return { ok: false, backup: [], message: "没有找到 H3 计划节点" };
  const shots = Array.isArray(info.plan.shots) ? info.plan.shots : [];
  const backup = shots.map((shot) =>
    shot && typeof shot === "object" && shot.steps !== undefined ? shot.steps : null
  );
  for (const shot of shots) {
    if (shot && typeof shot === "object") shot.steps = steps;
  }
  const ok = setWidget(info.node, "plan_json", JSON.stringify(info.plan, null, 2));
  if (!ok) return { ok: false, backup: [], message: "计划节点的 plan_json 无法写入" };
  markDirty(app, info.node);
  return { ok: true, backup, count: shots.length };
}

/** 恢复计划里各镜头原来的步数 */
export function restorePlanSteps(app, backup) {
  const info = readH3Plan(app);
  if (!info) return { ok: false };
  const shots = Array.isArray(info.plan.shots) ? info.plan.shots : [];
  shots.forEach((shot, index) => {
    if (!shot || typeof shot !== "object") return;
    const value = Array.isArray(backup) ? backup[index] : null;
    if (value === null || value === undefined) delete shot.steps;
    else shot.steps = value;
  });
  const ok = setWidget(info.node, "plan_json", JSON.stringify(info.plan, null, 2));
  if (ok) markDirty(app, info.node);
  return { ok, count: shots.length };
}

/** 画面比例 / 分辨率入口：Ref2V 的 width/height 上游，或画布上带 aspect_ratio + megapixels 的节点 */
export function findResolutionEntry(app) {
  const isRes = (node) => !!node && hasWidget(node, "aspect_ratio") && hasWidget(node, "megapixels");
  for (const ref of getNodes(app)) {
    if (!STOCK_REF2V_TYPE.test(String(ref.type || ""))) continue;
    for (const name of ["width", "height"]) {
      const { source } = resolveSetGetSource(app, followInput(app, ref, name));
      if (isRes(source)) return source;
      // 中间可能隔着算术/合并节点，再往下探一层
      if (!source || !Array.isArray(source.inputs)) continue;
      for (const input of source.inputs) {
        if (!input || input.link === undefined || input.link === null) continue;
        const deeper = resolveSetGetSource(app, followInput(app, source, input.name)).source;
        if (isRes(deeper)) return deeper;
      }
    }
  }
  return getNodes(app).find(isRes) || null;
}

function pickClosestOption(values, target, toNumber) {
  let best = null;
  for (const value of values) {
    const number = toNumber(value);
    if (!Number.isFinite(number) || number <= 0) continue;
    if (!best || Math.abs(number - target) < Math.abs(best.number - target)) best = { value, number };
  }
  return best;
}

/** 写画面比例与分辨率（ResolutionSelector 这类节点）；megapixels 传了就锁这个档，不传按分镜宽高换算 */
export function writeResolution(app, width, height, lockMegapixels = null) {
  const w = Math.round(Number(width) || 0);
  const h = Math.round(Number(height) || 0);
  if (!w || !h) return { ok: false, message: "分镜没有可用宽高" };
  const node = findResolutionEntry(app);
  if (!node) return { ok: false, message: "工作流没有分辨率入口" };

  const aspectWidget = getWidget(node, "aspect_ratio");
  const aspectValues =
    aspectWidget && aspectWidget.options && Array.isArray(aspectWidget.options.values) ? aspectWidget.options.values : [];
  const aspectPick = pickClosestOption(aspectValues, w / h, (value) => {
    const match = /(\d+(?:\.\d+)?)\s*[:：]\s*(\d+(?:\.\d+)?)/.exec(String(value));
    return match ? Number(match[1]) / Number(match[2]) : NaN;
  });
  const aspect = aspectPick ? aspectPick.value : null;
  let wroteAspect = false;
  if (aspect !== null) wroteAspect = setWidget(node, "aspect_ratio", aspect);

  const mpWidget = getWidget(node, "megapixels");
  const mpValues = mpWidget && mpWidget.options && Array.isArray(mpWidget.options.values) ? mpWidget.options.values : [];
  const target = Number(lockMegapixels) > 0 ? Number(lockMegapixels) : (w * h) / 1e6;
  let megapixels = null;
  if (mpValues.length) {
    const pick = pickClosestOption(mpValues, target, (value) => Number(value));
    if (pick) megapixels = pick.value;
  } else {
    megapixels = Math.round(target * 100) / 100;
  }
  let wroteMp = false;
  if (megapixels !== null) wroteMp = setWidget(node, "megapixels", megapixels);
  markDirty(app, node);

  const aspectLabel = aspect ? String(aspect).replace(/\s*\(.*\)$/, "") : `${w}×${h}`;
  const mpLabel = megapixels !== null ? `${Number(megapixels)}MP` : "";
  return {
    ok: wroteAspect || wroteMp,
    aspect,
    megapixels,
    node,
    label: [aspectLabel, mpLabel].filter(Boolean).join(" · "),
  };
}

/** 读当前画面比例 / 像素档（自动模式结束后恢复用） */
export function readResolutionSettings(app) {
  const node = findResolutionEntry(app);
  if (!node) return null;
  const aspect = getWidget(node, "aspect_ratio");
  const megapixels = getWidget(node, "megapixels");
  return {
    node,
    aspect: aspect ? aspect.value : null,
    megapixels: megapixels ? Number(megapixels.value) : null,
  };
}

/** 只改像素档，不动画面比例 */
export function setResolutionMegapixels(app, megapixels) {
  const value = Number(megapixels);
  if (!Number.isFinite(value) || value <= 0) return false;
  const node = findResolutionEntry(app);
  const widget = node ? getWidget(node, "megapixels") : null;
  if (!widget) return false;
  const values = widget.options && Array.isArray(widget.options.values) ? widget.options.values : [];
  const pick = values.length ? pickClosestOption(values, value, (item) => Number(item)) : null;
  const ok = setWidget(node, "megapixels", pick ? pick.value : value);
  if (ok) markDirty(app, node);
  return ok;
}

/** 把单元的档位参数写入工作流 */
export function applyUnitParams(app, unit, settings, targets, options = {}) {
  const raw = unit && unit.params;
  if (!raw) return { ok: false, done: [], missing: [], message: "该单元没有可用参数" };

  // 写入前先按当前模型的硬规则校正（帧数对齐、帧率、尺寸倍数）
  const guarded = guardParams(raw, detectModelProfile(app));
  const params = guarded.params;

  const done = [];
  const missing = [];
  const seen = new Set();
  const pushDone = (label) => {
    if (!seen.has(label)) {
      seen.add(label);
      done.push(label);
    }
  };

  const seed = settings && settings.randomSeed
    ? Math.floor(Math.random() * 4294967295)
    : Math.max(0, Math.floor(Number(settings && settings.seed) || 0));

  const sampler = targets && targets.sampler;

  // 原生 Ref2V 单条工作流（终极篇）：步数/CFG/画幅/采样器都是调好的，只写时长、种子、输出前缀
  if (referenceImageSlots(app).length) {
    const seconds =
      Number(unit && unit.duration) > 0
        ? Number(unit.duration)
        : Number(params.frames) / Math.max(1, Number(params.fps) || H3_FPS);
    const durationNode = getNodes(app).find(
      (node) =>
        /duration|时长|秒数/i.test(String(node.title || "")) &&
        (hasWidget(node, "value") || hasWidget(node, "seconds"))
    );
    if (
      durationNode &&
      setWidget(durationNode, hasWidget(durationNode, "value") ? "value" : "seconds", Math.round(seconds * 100) / 100)
    ) {
      markDirty(app, durationNode);
      pushDone(`时长 ${Math.round(seconds * 10) / 10} 秒`);
    } else {
      missing.push("时长");
    }
    // 画面比例按分镜档位的宽高算，像素默认锁 1.5MP；自动模式会传更低的档
    const lockMegapixels = Number(options.megapixels) > 0 ? Number(options.megapixels) : H3_MEGAPIXELS;
    const resolution = writeResolution(app, params.width, params.height, lockMegapixels);
    if (resolution.ok) pushDone(`画幅 ${resolution.label}`);
    else missing.push("画幅");
    if (sampler && setWidget(sampler, "seed", seed)) {
      markDirty(app, sampler);
      pushDone(`种子 ${seed}`);
    } else {
      missing.push("种子");
    }
    let prefixHit = false;
    for (const node of getNodes(app)) {
      if (hasWidget(node, "filename_prefix") && setWidget(node, "filename_prefix", `${unit.id}_`)) {
        markDirty(app, node);
        prefixHit = true;
      }
    }
    if (prefixHit) pushDone(`前缀 ${unit.id}_`);
    else missing.push("输出前缀");
    return {
      ok: done.length > 0,
      done,
      missing,
      seed,
      tuned: true,
      model: guarded.profile ? guarded.profile.key : "",
      modelName: guarded.profile ? guarded.profile.name : "",
      adjusted: guarded.changes,
    };
  }

  const setSampler = (names, value, label) => {
    let hit = null;
    if (sampler) {
      for (const name of names) {
        if (hasWidget(sampler, name) && setWidget(sampler, name, value)) {
          hit = sampler;
          break;
        }
      }
    }
    if (!hit) {
      for (const node of getNodes(app)) {
        if (node.mode === 2) continue;
        for (const name of names) {
          if (hasWidget(node, name) && setWidget(node, name, value)) {
            hit = node;
            break;
          }
        }
        if (hit) break;
      }
    }
    if (hit) {
      markDirty(app, hit);
      pushDone(`${label} ${value}`);
    } else {
      missing.push(label);
    }
  };

  setSampler(["steps"], params.steps, "步数");
  setSampler(["cfg"], params.cfg, "CFG");
  setSampler(["sampler_name", "sampler"], params.sampler, "采样器");
  setSampler(["scheduler"], params.scheduler, "调度器");
  if (params.denoise !== undefined && params.denoise !== null) setSampler(["denoise"], params.denoise, "降噪");
  setSampler(["seed", "noise_seed"], seed, "种子");

  let shiftHit = false;
  for (const node of getNodes(app)) {
    if (node.mode === 2) continue;
    if (setWidget(node, "shift", params.shift)) {
      shiftHit = true;
      markDirty(app, node);
    }
  }
  if (shiftHit) pushDone(`shift ${params.shift}`);
  else missing.push("shift");

  const latent = targets && targets.latent;
  const setLatent = (names, value, label) => {
    let hit = null;
    if (latent) {
      for (const name of names) {
        if (hasWidget(latent, name) && setWidget(latent, name, value)) {
          hit = latent;
          break;
        }
      }
    }
    if (hit) {
      markDirty(app, hit);
      pushDone(`${label} ${value}`);
    } else {
      missing.push(label);
    }
  };
  setLatent(["width"], params.width, "宽");
  setLatent(["height"], params.height, "高");
  setLatent(["length", "num_frames", "frames", "frame_count", "video_length"], params.frames, "帧数");

  // 有些工作流用「秒数」节点（如 PrimitiveFloat (duration)）→ 表达式换算帧数
  const framesWritten = done.some((item) => String(item).startsWith("帧数 "));
  if (!framesWritten) {
    const seconds =
      Number(unit.duration) > 0
        ? Number(unit.duration)
        : Number(params.frames) / Math.max(1, Number(params.fps) || 16);
    const durationNode = getNodes(app).find(
      (node) =>
        /duration|时长|秒数/i.test(String(node.title || "")) &&
        (hasWidget(node, "value") || hasWidget(node, "seconds"))
    );
    const name = durationNode ? (hasWidget(durationNode, "value") ? "value" : "seconds") : "";
    if (durationNode && setWidget(durationNode, name, Math.round(seconds * 100) / 100)) {
      markDirty(app, durationNode);
      pushDone(`时长 ${Math.round(seconds * 10) / 10} 秒`);
    } else {
      missing.push("时长");
    }
  }

  let fpsHit = false;
  for (const node of getNodes(app)) {
    if (node.mode === 2) continue;
    // H3 的音频时钟固定按 24fps 计算，写 16 会让 Loop Trim 的音频校准报错
    if (/^MiniMaxH3/i.test(String(node.type || ""))) continue;
    for (const name of ["fps", "frame_rate"]) {
      if (hasWidget(node, name) && setWidget(node, name, params.fps)) {
        fpsHit = true;
        markDirty(app, node);
        break;
      }
    }
  }
  if (fpsHit) pushDone(`帧率 ${params.fps}`);
  else missing.push("帧率");

  let prefixHit = false;
  for (const node of getNodes(app)) {
    if (node.mode === 2) continue;
    if (hasWidget(node, "filename_prefix") && setWidget(node, "filename_prefix", `${unit.id}_`)) {
      prefixHit = true;
      markDirty(app, node);
    }
  }
  if (prefixHit) pushDone(`前缀 ${unit.id}_`);
  else missing.push("输出前缀");

  return {
    ok: done.length > 0,
    done,
    missing,
    seed,
    model: guarded.profile ? guarded.profile.key : "",
    modelName: guarded.profile ? guarded.profile.name : "",
    adjusted: guarded.changes,
  };
}
