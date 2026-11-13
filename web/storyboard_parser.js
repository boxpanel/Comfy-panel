/**
 * 分镜手册解析器（纯函数，不依赖 ComfyUI，方便单独测试）
 *
 * 目标格式示例：
 *   # 四、场 2 执行卡（教室·蝎子，14 单元）
 *   ### S02-U01｜8 秒｜大全｜固定机位
 *   - **素材：**S-01 场景板，空场不加人。
 *   - **提示词（中）：**空教室，斜光穿过窗格……
 *   - **Prompt（英）：**empty classroom, ...
 *   - **对白／音效：**无对白；蝉声……
 *   - **接点：**硬切 U02。
 */

const TIER_DEFAULTS = {
  A: {
    key: "A",
    name: "A 档 · 静",
    width: 1280,
    height: 720,
    frames: 81,
    fps: 16,
    steps: 20,
    cfg: 4.5,
    sampler: "uni_pc",
    scheduler: "simple",
    shift: 5,
    denoise: 1.0,
    candidates: 4,
    motion: "低",
  },
  B: {
    key: "B",
    name: "B 档 · 人像（默认）",
    width: 1280,
    height: 720,
    frames: 81,
    fps: 16,
    steps: 20,
    cfg: 4.5,
    sampler: "uni_pc",
    scheduler: "simple",
    shift: 6,
    denoise: 1.0,
    candidates: 4,
    motion: "中",
  },
  C: {
    key: "C",
    name: "C 档 · 动",
    width: 1280,
    height: 720,
    frames: 81,
    fps: 16,
    steps: 24,
    cfg: 4.5,
    sampler: "euler",
    scheduler: "simple",
    shift: 7,
    denoise: 1.0,
    candidates: 4,
    motion: "中高",
  },
};

const ASSET_RE = /\b(?:T-P\d{2}|T-\d{2}|[RCSPG]-\d{2}[a-zA-Z]?(?:-E\d)?)\b/g;

/** 统一素材编号大小写：s-04a -> S-04a，t-p01 -> T-P01 */
export function normalizeAssetCode(code) {
  return String(code || "").replace(
    /^([a-z]+)-([a-z]?)(\d{1,2})([a-z]?)/i,
    (_, head, mid, num, letter) =>
      `${head.toUpperCase()}-${mid ? mid.toUpperCase() : ""}${num}${letter ? letter.toLowerCase() : ""}`
  );
}

export function cloneTierDefaults() {
  return JSON.parse(JSON.stringify(TIER_DEFAULTS));
}

/** 还原 Markdown 反斜杠转义：\- \. \_ \( 等 */
export function unescapeMd(value) {
  return String(value == null ? "" : value).replace(/\\([\\`*_{}\[\]()#+\-.!|>~])/g, "$1");
}

function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => unescapeMd(cell).trim());
}

function firstNumber(value) {
  const m = String(value == null ? "" : value).match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

function applyParamRow(target, label, value) {
  if (!label) return;
  const text = String(value || "").trim();

  if (/分辨率/.test(label)) {
    const m = text.match(/(\d+)\s*[×xX*]\s*(\d+)/);
    if (m) {
      target.width = parseInt(m[1], 10);
      target.height = parseInt(m[2], 10);
    }
    return;
  }
  if (/帧数/.test(label)) {
    const m = text.match(/(\d+)\s*[／/]\s*(\d+)/);
    if (m) {
      target.frames = parseInt(m[1], 10);
      target.fps = parseInt(m[2], 10);
    }
    return;
  }
  if (/步数/.test(label)) {
    const n = firstNumber(text);
    if (n != null) target.steps = Math.round(n);
    return;
  }
  if (/CFG/i.test(label)) {
    const n = firstNumber(text);
    if (n != null) target.cfg = n;
    return;
  }
  if (/采样器/.test(label)) {
    const parts = text.split(/[／/]/).map((s) => s.trim());
    if (parts[0]) target.sampler = parts[0];
    if (parts[1]) target.scheduler = parts[1];
    return;
  }
  if (/shift/i.test(label)) {
    const n = firstNumber(text);
    if (n != null) target.shift = n;
    return;
  }
  if (/降噪/.test(label)) {
    const n = firstNumber(text);
    if (n != null) target.denoise = n;
    return;
  }
  if (/候选/.test(label)) {
    const n = firstNumber(text);
    if (n != null) target.candidates = Math.round(n);
    return;
  }
  if (/动作幅度/.test(label)) {
    target.motion = text;
    return;
  }
  if (/用于/.test(label)) {
    target.usage = text;
  }
}

/** 解析「参数三档」表格，未找到时返回默认三档 */
export function parseTierParams(lines) {
  const params = cloneTierDefaults();
  const start = lines.findIndex((line) => /^#{2,3}\s*参数三档/.test(line.trim()));
  if (start < 0) return params;

  let i = start + 1;
  while (i < lines.length && !lines[i].trim().startsWith("|")) i++;
  if (i >= lines.length) return params;

  const header = splitRow(lines[i]);
  const columnOf = {};
  header.forEach((cell, index) => {
    const m = cell.match(/([ABC])\s*档/);
    if (m) columnOf[m[1]] = index;
  });
  if (!Object.keys(columnOf).length) return params;

  i += 2; // 跳过分隔行 |---|---|
  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("|")) break;
    const cells = splitRow(line);
    const label = cells[0] || "";
    for (const tierKey of Object.keys(columnOf)) {
      applyParamRow(params[tierKey], label, cells[columnOf[tierKey]]);
    }
  }
  return params;
}

/**
 * 从「对白／音效」里取出能写进提示词的现场声。
 * 只留音效与环境声：台词交给参考音频和 prompt 里的 dialogue，
 * 「音色参考 assets/…」「语音只借音色，不复制…」「物理声独立生成」这类制作说明
 * 一律不写进提示词，否则 H3 会把说明当成台词念出来。
 */
function soundscapeOf(value) {
  let text = String(value || "").trim();
  if (!text) return "";
  text = text.replace(/^无对白\s*[。；;，,、]?\s*/g, "").replace(/^有对白\s*[：:]\s*/g, "");
  const DROP = /只借|音色参考|不复制参考|不复制原句|物理声独立生成|不用参考音频/;
  const sentences = text
    .split("。")
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence && !DROP.test(sentence));
  let out = sentences.join("。");
  // 有「音效：」就只取这一段，说话人、台词和起说/说完的时间都不进提示词
  const fx = out.match(/音效\s*[：:]\s*([\s\S]*)$/);
  if (fx) {
    out = fx[1];
  } else if (out.includes("「")) {
    // 没有音效段时兜底：引号里的台词和它后面的时间说明都去掉
    out = out.replace(/「[^」]*」[^。]*/g, "");
  }
  return out.replace(/^[。；;，,\s]+/, "").replace(/\s+/g, " ").trim();
}

/** 解析「场 2 的档位：U01、U04 用 A 档；……」 */
export function parseTierAssignments(text) {
  const map = {};
  const segmentRe = /场\s*(\d+)\s*的档位\s*[：:]([\s\S]*?)(?=场\s*\d+\s*的档位\s*[：:]|$)/g;
  let segment;
  while ((segment = segmentRe.exec(text))) {
    const sceneNo = Number(segment[1]);
    const body = segment[2];
    const ruleRe = /((?:U\d+[a-zA-Z]?\s*[、,，和]?\s*)+)用\s*([ABC])\s*档/g;
    let rule;
    map[sceneNo] = map[sceneNo] || {};
    while ((rule = ruleRe.exec(body))) {
      const units = rule[1].split(/[、,，和\s]+/).filter(Boolean);
      const tier = rule[2];
      for (const unit of units) {
        map[sceneNo][unit.toUpperCase()] = tier;
      }
    }
  }
  return map;
}

function fieldOf(key) {
  if (/素材|资产|参考图|引用/.test(key)) return "assetsText";
  if (/prompt|english|英文/i.test(key)) return "promptEn";
  if (/提示词|中文|动作|画面/.test(key)) return "promptZh";
  if (/对白|音效|台词|声音|配音/.test(key)) return "audio";
  if (/接点|衔接|转场|连接/.test(key)) return "continuity";
  return null;
}

/** 宽容地识别执行卡标题：S02-U01 / S02U01 / **S02-U01**｜8 秒｜大全｜固定机位 */
function parseUnitHeading(rawLine) {
  let text = rawLine.trim().replace(/^(?:镜号|镜头|分镜)\s*[：:]\s*/i, "");
  if (!text || /^\|/.test(text)) return null;
  if (!/S\d{1,2}\s*[-_－—]?\s*U\d+[a-zA-Z]?/i.test(text)) return null;

  const headingLike =
    /^#{0,4}\s*[*【\[]/.test(text) ||
    /^#{1,4}\s/.test(text) ||
    /^S\d{1,2}/i.test(text) ||
    /^[【\[]/.test(text);
  if (!headingLike) return null;

  const match = text.match(
    /^#{0,4}\s*[*【\[]*\s*(S\d{1,2})\s*[-_－—]?\s*(U\d+[a-zA-Z]?)\s*[*】\]]*\s*[｜|/／]?\s*(.*)$/i
  );
  if (!match) return null;

  const rest = (match[3] || "").replace(/\*\*/g, "").trim();
  let parts = rest.split(/[｜|/／]+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2 && rest) {
    parts = rest.split(/\s{2,}|[，,·]+/).map((s) => s.trim()).filter(Boolean);
  }
  if (parts.length < 2 && rest) {
    const compact = rest.match(/^(\d+(?:\.\d+)?\s*秒)?\s*(大全|全景|中景|近景|特写|远景)?\s*(.*)$/);
    if (compact) parts = [compact[1] || "", compact[2] || "", compact[3] || ""].filter(Boolean);
  }

  return {
    sceneNo: parseInt(match[1].slice(1), 10),
    label: match[2],
    id: `${match[1]}-${match[2]}`,
    parts,
    tier: (rest.match(/([ABC])\s*档/) || [])[1] || "",
  };
}

function ensureScene(doc, no) {
  let scene = doc.scenes.find((item) => item.no === no);
  if (!scene) {
    scene = { no, name: "", note: "", units: [] };
    doc.scenes.push(scene);
  }
  return scene;
}

/** 识别分镜表表头：|镜|时长·景别·机位·档|素材|中文|Prompt（英）|对白／音效|接点| */
function tableColumns(cells) {
  const find = (re) => cells.findIndex((cell) => re.test(cell));
  const id = find(/^(镜|镜号|单元|编号|shot)/i);
  const meta = find(/时长|景别|机位|档/);
  const assets = find(/素材|资产/);
  const zh = find(/^中文|中文提示|提示词.*中/);
  const en = find(/prompt|英文/i);
  const audio = find(/对白|音效|台词/);
  const continuity = find(/接点|衔接|转场|连接/);
  if (id < 0 || assets < 0 || zh < 0) return null;
  return { id, meta, assets, zh, en, audio, continuity };
}

function isSeparatorRow(cells) {
  return cells.length > 1 && cells.every((cell) => /^:?-{2,}:?$/.test(cell.replace(/\s/g, "")));
}

/** 表格的一行 -> 一个单元 */
function unitFromRow(cells, cols, scene, doc) {
  const id = (cells[cols.id] || "").replace(/\s+/g, "");
  if (!/^(?:[A-Z]\d{1,2}[-_]U\d+[A-Za-z]?|\d{1,2}[-_]\d{1,3}[A-Za-z]?)$/i.test(id)) return null;

  const meta = (cells[cols.meta] || "")
    .split(/[／/|·、]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const tierRaw = (meta[3] || "").toUpperCase();

  const sceneNo = parseInt((id.match(/^(?:S)?(\d{1,2})/i) || [])[1] || (scene ? scene.no : 1), 10);
  const sceneRef = ensureScene(doc, sceneNo);
  const labelMatch = id.match(/U\d+[a-zA-Z]?$/i);
  const label = labelMatch ? labelMatch[0] : `U${(id.split(/[-_]/)[1] || "").toUpperCase()}`;

  const unit = {
    id,
    scene: sceneNo,
    label,
    sceneName: sceneRef.name,
    durationText: meta[0] || "",
    duration: parseFloat(meta[0]) || 0,
    shot: meta[1] || "",
    camera: meta[2] || "",
    assetsText: cells[cols.assets] || "",
    assets: [],
    promptZh: cells[cols.zh] || "",
    promptEn: cols.en >= 0 ? cells[cols.en] || "" : "",
    audio: cols.audio >= 0 ? cells[cols.audio] || "" : "",
    soundscape: "",
    retention: "",
    continuity: cols.continuity >= 0 ? cells[cols.continuity] || "" : "",
    tier: /^[ABC]$/.test(tierRaw) ? tierRaw : "B",
    params: null,
    _lastField: null,
    _tier: /^[ABC]$/.test(tierRaw) ? tierRaw : null,
  };
  doc.units.push(unit);
  sceneRef.units.push(unit);
  return unit;
}

function extractAssets(text) {
  const seen = new Set();
  const found = [];
  const matches = String(text || "").match(ASSET_RE) || [];
  for (const rawCode of matches) {
    const code = normalizeAssetCode(rawCode);
    if (!seen.has(code)) {
      seen.add(code);
      found.push(code);
    }
  }
  return found;
}

const ASSET_CODE_PATTERN = "T-P\\d{2}|T-\\d{2}|[RCSPG]-\\d{2}[a-zA-Z]?(?:-E\\d)?";

/**
 * 从手册里抽「素材编号 → 中文名」对照表。
 * 支持两种写法：表格 |T-01|大块（同班男生）|，以及段落 **人物：**R-01 卫斯理、R-02 祝香香
 */
export function parseAssetNames(text) {
  const names = {};
  const put = (code, name) => {
    if (!code || !name) return;
    const clean = String(name)
      .trim()
      .replace(/^[（(]|[）)]$/g, "")
      .replace(/\s+/g, "");
    if (!clean) return;
    if (/^(的|与|和|在|到)/.test(clean)) return;
    if (/三视图|参考|场景板|规格|静物|全身|表情|局部|可选|或用|优先|单元/.test(clean)) return;
    if (!names[code]) names[code] = clean;
  };

  const rowRe = new RegExp(`^\\|\\s*(${ASSET_CODE_PATTERN})\\s*\\|\\s*([^|]+)\\|`, "gm");
  let match;
  while ((match = rowRe.exec(text))) {
    put(match[1], match[2].split(/[（(]/)[0]);
  }

  const listRe = /\*\*[^*]{0,8}：\*\*([^\n]+)/g;
  while ((match = listRe.exec(text))) {
    const body = match[1];
    const itemRe = new RegExp(
      `(${ASSET_CODE_PATTERN})\\s*(?:[（(]([^）)]*)[）)])?\\s*([^、。；，,\\n）)]*)`,
      "g"
    );
    let item;
    while ((item = itemRe.exec(body))) {
      put(item[1], (item[3] || "").trim() || (item[2] || "").trim());
    }
  }
  return names;
}

/**
 * 主入口：把整份 Markdown 手册解析成结构化数据
 * @returns {{title:string, scenes:Array, units:Array, params:object, tierMap:object, warnings:string[]}}
 */
export function parseStoryboard(rawText) {
  const text = unescapeMd(String(rawText || "")).replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const result = {
    title: "",
    scenes: [],
    units: [],
    params: parseTierParams(lines),
    tierMap: parseTierAssignments(text),
    assetNames: parseAssetNames(text),
    warnings: [],
  };

  for (const line of lines) {
    const m = line.match(/^#\s+(.+)$/);
    if (m && !/^#\s*[一二三四五六七八九十百]+、/.test(line)) {
      result.title = m[1].trim();
      break;
    }
  }

  let scene = null;
  let unit = null;
  let table = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, "");

    const sceneMatch = line.match(/^#{1,3}\s*(?:[一二三四五六七八九十百]+、)?\s*场\s*(\d+)\s*(.*)$/);
    if (sceneMatch) {
      unit = null;
      let rest = (sceneMatch[2] || "").trim();
      rest = rest.replace(/[（(]\s*\d+\s*单元\s*[）)]\s*$/, "");
      const paren = rest.match(/^执行卡\s*[（(](.*?)[）)]\s*$/);
      if (paren) rest = paren[1];
      rest = rest
        .replace(/[，,]\s*\d+\s*单元\s*$/, "")
        .replace(/执行卡\s*$/, "")
        .replace(/^[·:：\-—\s]+/, "")
        .trim();
      scene = {
        no: parseInt(sceneMatch[1], 10),
        name: rest,
        note: "",
        units: [],
      };
      result.scenes.push(scene);
      continue;
    }

    if (/^\s*\|/.test(line)) {
      const cells = splitRow(line);
      if (isSeparatorRow(cells)) continue;
      const cols = tableColumns(cells);
      if (cols) {
        table = cols;
        unit = null;
        continue;
      }
      if (table) {
        const rowUnit = unitFromRow(cells, table, scene, result);
        if (rowUnit) {
          unit = rowUnit;
          scene = ensureScene(result, rowUnit.scene);
        }
      }
      continue;
    }
    table = null;

    const heading = parseUnitHeading(line);
    if (heading) {
      const sceneNo = Number.isFinite(heading.sceneNo) ? heading.sceneNo : scene ? scene.no : 1;
      scene = ensureScene(result, sceneNo);
      const parts = heading.parts;
      unit = {
        id: heading.id,
        scene: sceneNo,
        label: heading.label,
        sceneName: scene.name,
        durationText: parts[0] || "",
        duration: parseFloat(parts[0]) || 0,
        shot: parts[1] || "",
        camera: parts[2] || "",
        assetsText: "",
        assets: [],
        promptZh: "",
        promptEn: "",
        audio: "",
        soundscape: "",
        retention: "",
        continuity: "",
        tier: heading.tier || "B",
        params: null,
        _lastField: null,
        _tier: heading.tier || null,
      };
      result.units.push(unit);
      scene.units.push(unit);
      continue;
    }

    if (unit) {
      const bullet = line.match(
        /^\s*(?:[-*·]\s*)?(?:\*\*)?([^：:*]{1,14})(?:\*\*)?\s*[：:]\s*(?:\*\*)?\s*(.*)$/
      );
      if (bullet) {
        const key = unescapeMd(bullet[1]).trim();
        const value = unescapeMd(bullet[2]).trim();
        const field = fieldOf(key);
        if (field) {
          if (field === "assetsText") {
            // 「素材：S-01。｜保留：……」把保留项单独拆出来，供 retention_analysis 用
            const [assetPart, ...kept] = String(value).split(/[｜|]\s*保留\s*[：:]/);
            unit.assetsText = (unit.assetsText ? unit.assetsText + " " : "") + assetPart.trim();
            if (kept.length) {
              const text = kept.join("｜保留：").trim();
              if (text) unit.retention = unit.retention ? `${unit.retention} ${text}` : text;
            }
          } else {
            unit[field] = unit[field] ? `${unit[field]} ${value}` : value;
          }
          unit._lastField = field;
          continue;
        }
      }
      if (/^#{1,4}\s/.test(line)) {
        unit = null;
      } else if (unit._lastField && line.trim() && !/^\s*[-*|>]/.test(line)) {
        const field = unit._lastField;
        unit[field] = `${unit[field]} ${line.trim()}`.trim();
      }
      if (!unit) continue;
    }

    if (!unit && scene && line.trim() && !/^\s{0,3}[-*#|>]/.test(line)) {
      scene.note = scene.note ? `${scene.note} ${line.trim()}` : line.trim();
    }
  }

  for (const unitData of result.units) {
    unitData.assets = extractAssets(unitData.assetsText);
    delete unitData.assetsText;
    delete unitData._lastField;
    unitData.soundscape = soundscapeOf(unitData.audio);

    unitData.sceneName = (result.scenes.find((item) => item.no === unitData.scene) || {}).name || "";

    const sceneTier = result.tierMap[unitData.scene] || {};
    const tier = unitData._tier || sceneTier[String(unitData.label).toUpperCase()] || "B";
    delete unitData._tier;
    unitData.tier = tier;
    unitData.params = { ...result.params[tier] };
  }

  result.scenes.sort((a, b) => a.no - b.no);

  if (!result.units.length) {
    result.warnings.push("没有识别到执行卡（标题里要有 S02-U01 这样的镜号）");
  }

  return result;
}

/** 按设定拼接提示词：中文动作句 → 英文动作句 → 质感串，用句号连接 */
export function buildPrompt(unit, options = {}) {
  if (!unit) return "";
  const mode = options.mode || "zh+en+quality";
  const parts = [];
  if (mode.includes("zh") && unit.promptZh) parts.push(unit.promptZh);
  if (mode.includes("en") && unit.promptEn) parts.push(unit.promptEn);
  if (mode.includes("quality") && options.quality) parts.push(options.quality);
  const cleaned = parts
    .map((part) => String(part).trim().replace(/[。．.；;\s]+$/, ""))
    .filter(Boolean);
  return cleaned.length ? `${cleaned.join("。")}。` : "";
}

/** 统计各档位数量 */
export function summarize(doc) {
  const stats = { total: 0, A: 0, B: 0, C: 0, scenes: 0 };
  if (!doc) return stats;
  stats.total = doc.units.length;
  stats.scenes = doc.scenes.length;
  for (const unit of doc.units) {
    if (stats[unit.tier] != null) stats[unit.tier] += 1;
  }
  return stats;
}

/** 从文件名里抽出素材编号，如 "R-01_卫斯理.png" -> ["R-01"] */
export function extractAssetCodes(text) {
  const pattern = new RegExp(ASSET_CODE_PATTERN, "gi");
  const found = String(text || "").match(pattern) || [];
  return Array.from(new Set(found.map((code) => normalizeAssetCode(code))));
}

/** 从文件名里抽出单元编号，如 "S02-U01_合成.png" / "1-01.png" -> ["S02-U01"] / ["1-01"] */
export function extractUnitIds(text) {
  const found =
    String(text || "")
      .toUpperCase()
      .match(/S\d{1,2}[-_ ]?U\d+[A-Z]?|\b\d{1,2}[-_]\d{1,3}[A-Z]?\b/g) || [];
  return Array.from(new Set(found.map((item) => item.replace(/[-_ ]/g, "-"))));
}

/**
 * 首/尾帧命名解析：
 *   S02-U05_first_v01.png -> { unit: "S02-U05", kind: "first", version: 1 }
 *   S02-U05_last_v01.png  -> { unit: "S02-U05", kind: "last",  version: 1 }
 *   旧名 S02-U05_frame.png 一律当首帧 v01
 */
export function parseFrameName(name) {
  const file = String(name || "").split(/[\\/]/).pop();
  let match = /^(S\d{2}-U\d{2})_(first|last)_v(\d{2})\.(png|jpe?g|webp)$/i.exec(file);
  if (match) {
    return {
      unit: match[1].toUpperCase(),
      kind: match[2].toLowerCase(),
      version: Number(match[3]),
    };
  }
  match = /^(S\d{2}-U\d{2})_frame\.(png|jpe?g|webp)$/i.exec(file);
  if (match) return { unit: match[1].toUpperCase(), kind: "first", version: 1 };
  return null;
}
