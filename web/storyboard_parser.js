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

// 素材编号：S 角色 / C 服装 / P 道具 / E 场景 / ST 风格 / A 其他，兼容旧的 R / T / G / T-P；
// V / RA 是参考音频（音色绑定）的编号。
// 边界不能用 \b：素材文件名是 S-01_sheet_v01.png / E-01_ref_v01.png，下划线也是单词字符
const ASSET_RE = /(?<![A-Za-z0-9])(?:ST|T-P|T|RA|R|C|S|P|G|E|A|V)-\d{2}[a-zA-Z]?(?:-E\d)?(?![A-Za-z0-9])/gi;

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
  if (!text || /^无[。；;]?$/.test(text)) return "";
  // 「无（火盆炭火轻微噼啪）」= 没台词，只有这一段环境声，括号里才是音效
  const onlyFx = text.match(/^无(?:对白)?\s*[（(]([\s\S]*)[）)]\s*$/);
  if (onlyFx) text = onlyFx[1].trim();
  text = text.replace(/^无对白\s*[。；;，,、]?\s*/g, "").replace(/^有对白\s*[：:]\s*/g, "");
  const DROP = /只借|音色参考|不复制参考|不复制原句|物理声独立生成|不用参考音频/;
  // 「说话人（情绪）：台词」是台词，不是音效；但「音效：」「环境声：」要留着
  const isDialogue = (sentence) =>
    !/^(?:音效|环境声|环境音)/.test(sentence) &&
    (/^[^：:。；]{1,12}(?:（[^）]{0,10}）)?\s*[：:]/.test(sentence) ||
      // 被截断的台词只剩「说话人（」也要认出来
      /^[^：:。；]{1,10}（[^）]*$/.test(sentence));
  const sentences = text
    .split("。")
    .map((sentence) => sentence.trim())
    .filter(
      (sentence) =>
        sentence &&
        !DROP.test(sentence) &&
        !isDialogue(sentence) &&
        // 只剩引号、括号的碎片（「…。」被句号切开后会留下一片「」）不算音效
        /[\u4e00-\u9fffa-zA-Z0-9]/.test(sentence)
    );
  let out = sentences.join("。");
  // 有「音效：」就只取这一段，说话人、台词和起说/说完的时间都不进提示词
  const fx = out.match(/音效\s*[：:]\s*([\s\S]*)$/);
  if (fx) {
    out = fx[1];
  } else if (out.includes("「")) {
    // 没有「音效：」段时兜底：只去掉引号里的台词，引号外的动作声保留
    // （新包里「雪杖绷紧「格」声、芳子急喘」这种引号是拟声，不能整句删掉）
    out = out.replace(/「[^」]*」/g, "");
  }
  return out.replace(/[「」]/g, "").replace(/^[。；;，,、\s]+/, "").replace(/[，,、\s]+$/, "").replace(/\s+/g, " ").trim();
}

/**
 * 画面 prompt 里不许出现台词和 <Audio N> 槽位：
 * 台词只走「对白／音效」栏和参考音频，写进画面会被模型当成字幕或念白。
 * 口型、字幕禁令这类画面指令保留。
 */
function stripDialogueFromPrompt(value) {
  let text = String(value || "");
  if (!text) return "";
  // 旧卡把整段「对白：<Audio 1> …」挂在提示词末尾，整段删掉（实测 3 卡，都在末尾）
  text = text.replace(/\s*(?:对白|Dialogue)\s*[：:][\s\S]*$/i, "");
  // 带音频模型的包会在画面句后面挂 <d>[Chinese] 台词</d> 和一句时长指令，都不属于画面
  text = text.replace(/<d>[\s\S]*?<\/d>/gi, "");
  text = text.replace(/Complete the sentence by approximately\s*\d{1,2}:\d{1,2}(?:\.\d+)?/gi, "");
  // 兜底：残留的音频槽位与引号台词
  text = text.replace(/<Audio\s*\d+>/gi, "");
  text = text.replace(/「[^」]*」/g, "");
  // 合并后的提示词可能带换行，画面句之间用空格接起来
  return text
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/^[。；;，,\s]+/, "")
    .replace(/[，,、；;：:\s]+$/, "")
    .trim();
}

/** 从 <d>[Chinese] …</d> 里取出台词本身，供「对白」栏使用 */
function spokenOf(value) {
  const match = String(value || "").match(/<d>\s*(?:\[[^\]]*\])?\s*([\s\S]*?)<\/d>/i);
  return match ? match[1].trim() : "";
}

/** 出包偶尔把分隔符和残留字段行写进正文：孤立的 #、---、`- 首帧补充：无`、双语包的重复 EN 行 */
function stripPackNoise(value) {
  const kept = String(value || "")
    .split(/\r?\n/)
    .filter((line) => {
      const text = line.trim();
      if (!text) return true;
      if (/^#{1,6}$/.test(text)) return false;
      if (/^(?:-{3,}|\*{3,})$/.test(text)) return false;
      if (/^EN\s*[：:]/i.test(text)) return false;
      if (/^[-*]\s*[\u4e00-\u9fff]{1,8}\s*[：:]/.test(text)) return false;
      return true;
    });
  return kept.join("\n").trim();
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

// 「镜头 NN」卡片（01-分镜提示词.md / 提示词包）的字段名，和 08 JSON 一一对应
const SHOT_FIELD_MAP = {
  时长: "durationText",
  主体状态: "subject",
  画面主体: "subject",
  环境与光照: "environment",
  环境: "environment",
  机位与运镜: "camera",
  景别机位: "camera",
  时间流逝: "elapsed",
  空间锚点: "anchor",
  首帧提示词: "firstFramePrompt",
  尾帧提示词: "lastFramePrompt",
  视频提示词: "promptEn",
  视频提示词补充: "dialogueText",
  "音频/对白": "audio",
  音频: "audio",
  对白: "audio",
  衔接: "continuity",
  接点: "joint",
  首尾帧验收: "acceptance",
  风险: "risk",
};

function shotFieldOf(key) {
  // 「视频提示词（台词）」「视频提示词补充」都是台词，不占画面提示词
  if (/^视频提示词\s*(?:[（(]台词[）)]|补充)/.test(key)) return "dialogueText";
  // 「视频提示词（可直接投喂）」等括号说明仍按英文画面提示词
  if (/^视频提示词/.test(key)) return "promptEn";
  // 「首帧补充：无」这类残留行直接忽略
  if (/^(?:首帧|尾帧)补充$/.test(key) || /^主体口型$/.test(key)) return null;
  // 试拍稿的英文首/尾帧单列一行，中文优先，英文跳过
  if (/^(?:first|last)\s*frame\b/i.test(key)) return null;
  return SHOT_FIELD_MAP[key] || fieldOf(key);
}

/** 宽容地识别执行卡标题：S02-U01 / S02U01 / **S02-U01**｜8 秒｜大全｜固定机位 */
function parseUnitHeading(rawLine) {
  let text = rawLine.trim().replace(/^(?:镜号|镜头|分镜)\s*[：:]\s*/i, "");
  if (!text || /^\|/.test(text)) return null;

  // 兜底：「镜头 17」「### 镜头 26」「### 镜头 01（0:00—0:05 · 5s）」这种只有镜号的标题
  const shotMatch = text.match(/^#{0,4}\s*镜头\s*(\d{1,3})\s*(?:[（(]([^）)]*)[）)])?\s*$/);
  if (shotMatch) {
    const label = String(Number(shotMatch[1])).padStart(2, "0");
    const tail = shotMatch[2] || "";
    const seconds = (tail.match(/(\d+(?:\.\d+)?)\s*(?:s|秒)/i) || [])[1] || "";
    return {
      sceneNo: 1,
      label,
      id: `S01-U${label}`,
      parts: seconds ? [`${seconds}s`] : [],
      tier: "",
      shotStyle: true,
    };
  }

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

const ASSET_CODE_PATTERN = "(?:ST|T-P|T|RA|R|C|S|P|G|E|A|V)-\\d{2}[a-zA-Z]?(?:-E\\d)?";

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
      .replace(/^[（(]([\s\S]*)[）)]$/, "$1")
      .replace(/\s+/g, "");
    if (!clean) return;
    if (/^(的|与|和|在|到)/.test(clean)) return;
    if (/三视图|参考|场景板|规格|静物|全身|表情|局部|可选|或用|优先|单元/.test(clean)) return;
    if (!names[code]) names[code] = clean;
  };

  const KIND_WORD = /^(?:角色|人物|服装|服饰|道具|物品|场景|环境|风格|其他|群像)$/;
  // 表格可能是 |编号|名称|用途|，也可能是 |编号|类别|名称|文件名|（试拍段素材清单）
  const rowRe = new RegExp(`^\\|\\s*(${ASSET_CODE_PATTERN})\\s*\\|\\s*([^|\\n]+)\\|\\s*([^|\\n]*)\\|?`, "gm");
  let match;
  while ((match = rowRe.exec(text))) {
    const second = match[2].trim();
    const third = (match[3] || "").trim();
    const name = KIND_WORD.test(second) && third && !/\.png$|不出图/i.test(third) ? third : second;
    put(match[1], name.split(/[（(]/)[0]);
  }

  // 新包标题：### S-01 · 角色 · 卫斯理 / ### E-02 · 场景 · 田宅·夜 / #### E-01 · 卫斯理的办公室（场景）
  const headingRe = new RegExp(`^#{1,6}\\s*(${ASSET_CODE_PATTERN})\\s*[·・|｜:：]?\\s*([^\\n]*)$`, "gm");
  while ((match = headingRe.exec(text))) {
    const parts = match[2].split(/[·・|｜]/).map((part) => part.trim()).filter(Boolean);
    // 第二段是类型词时跳过，名称取后面全部（保住「田宅·夜」这类多段名）
    const rest = parts.length > 1 && KIND_WORD.test(parts[0]) ? parts.slice(1) : parts;
    if (rest.length) put(match[1], rest.join("·").replace(/[（(](?:角色|服装|道具|场景|风格|其他|人物|群像)[）)]\s*$/, ""));
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

// ---------- 标准工作流单元提示词（六段式） ----------
// 出包端格式：## U001 · 镜头 01—04
//   - 场景：… ｜ 镜数：4 ｜ 名义 20s ｜ 对齐 481 帧 = 20.042s
//   - 素材绑定：<Picture 1> S-01、<Picture 2> S-06
//   - 音色绑定：<Audio 1> S1 卫斯理（V-01）
//   ```text
//   subject_definitions: … / summary: [reference generation + audio reference] … / …
//   ```
const PROMPT_SECTIONS = [
  "subject_definitions",
  "summary",
  "retention_analysis",
  "detailed_description",
  "overall_soundscape",
  "non_diegetic_music",
];
// summary 前缀：纯参考图生成，或参考图 + 音色参考
const SUMMARY_PREFIX_RE = /^\[reference generation(?:\s*\+\s*audio reference)?\]\s*/i;
const STRUCT_CODE_RE = "(?:ST|T-P|T|RA|R|C|S|P|G|E|A|V)-\\d{2}[a-zA-Z]?(?:-E\\d)?";

/** 六段式正文 → { subject_definitions, summary, … } */
function promptSectionsOf(body) {
  const marks = [];
  const re = new RegExp(`^(${PROMPT_SECTIONS.join("|")}):\\s*$`, "gm");
  let match;
  while ((match = re.exec(body))) {
    marks.push({ key: match[1], start: match.index, end: match.index + match[0].length });
  }
  const sections = {};
  marks.forEach((mark, index) => {
    const stop = index + 1 < marks.length ? marks[index + 1].start : body.length;
    sections[mark.key] = body.slice(mark.end, stop).trim();
  });
  return sections;
}

/** 素材绑定：`<Picture 1> S-01` 与 `S-01 卫斯理（Picture 1）` 两种写法 */
function parsePictureBindings(line) {
  const found = [];
  let match;
  const direct = new RegExp(`<Picture\\s+(\\d+)>\\s*(${STRUCT_CODE_RE})`, "gi");
  while ((match = direct.exec(line))) {
    found.push({ picture: Number(match[1]), code: normalizeAssetCode(match[2]) });
  }
  if (!found.length) {
    const trailing = new RegExp(`(${STRUCT_CODE_RE})\\s*[^、，,（(]*[（(]\\s*Picture\\s+(\\d+)\\s*[）)]`, "gi");
    while ((match = trailing.exec(line))) {
      found.push({ picture: Number(match[2]), code: normalizeAssetCode(match[1]) });
    }
  }
  return found.sort((a, b) => a.picture - b.picture);
}

/** 音色绑定：`<Audio 1> S1 卫斯理（V-01）` → 音频槽 / 说话人 / 名称 / 参考音频编号 */
function parseVoiceBindings(line) {
  const found = [];
  const re = /<Audio\s+(\d+)>\s*(?:(S\d+)\s*)?([^、，,（(<>\n]*?)\s*(?:[（(]\s*((?:V|RA)-\d{1,2})\s*[）)])?(?=[、，,]|$)/gi;
  let match;
  while ((match = re.exec(line))) {
    found.push({
      audio: Number(match[1]),
      speaker: String(match[2] || "").toUpperCase(),
      name: String(match[3] || "").trim(),
      code: match[4] ? normalizeAssetCode(match[4]) : "",
    });
  }
  return found;
}

/** subject_definitions 里的 `<Audio N> … <Subject M> (S#)` 定义 */
function parseAudioDefinitions(section) {
  const found = [];
  const re = /<Audio\s+(\d+)>[^\n]*?<Subject\s+(\d+)>[^\n]*?\((S\d+)\)/gi;
  let match;
  while ((match = re.exec(String(section || "")))) {
    found.push({ audio: Number(match[1]), subject: Number(match[2]), speaker: match[3].toUpperCase() });
  }
  return found;
}

/** retention_analysis 里的 RA 行：`<Audio N>: reference - …` */
function parseAudioRetention(section) {
  const found = [];
  const re = /^<Audio\s+(\d+)>\s*:\s*([^\n]+)$/gmi;
  let match;
  while ((match = re.exec(String(section || "")))) {
    found.push({ audio: Number(match[1]), text: match[2].trim() });
  }
  return found;
}

/** subject_definitions 里的 `<Subject N> … from <Picture K>` */
function parseSubjectDefinitions(section) {
  const found = [];
  const re = /^<Subject\s+(\d+)>\s+is\s+([^\n,]+?)(?:\s*\(([^)]*)\))?\s+from\s+<Picture\s+(\d+)>/gmi;
  let match;
  while ((match = re.exec(String(section || "")))) {
    found.push({
      subject: Number(match[1]),
      enName: match[2].trim(),
      name: (match[3] || match[2]).trim(),
      picture: Number(match[4]),
    });
  }
  return found;
}

/** 合并音色绑定、定义与 RA 行，按 <Audio N> 排序 */
function mergeAudioRefs(voice, defs, retention) {
  const map = new Map();
  const bucket = (audio) => {
    if (!map.has(audio)) {
      map.set(audio, { audio, speaker: "", name: "", code: "", subject: 0, retention: "" });
    }
    return map.get(audio);
  };
  const absorb = (item) => {
    const target = bucket(item.audio);
    Object.keys(item).forEach((key) => {
      if (item[key] !== "" && item[key] !== 0 && item[key] != null) target[key] = item[key];
    });
  };
  defs.forEach(absorb);
  voice.forEach(absorb);
  retention.forEach((item) => {
    bucket(item.audio).retention = item.text;
  });
  return Array.from(map.values()).sort((a, b) => a.audio - b.audio);
}

/** 结构化成片提示词（单元包 / 样张）→ 与旧手册相同的 doc 结构 */
function parseStructuredPromptPack(text) {
  const unitHeads = [];
  let match;
  const unitRe = /^##\s+(U\d{3})\s*[·・]\s*镜头\s*(\d+)\s*[—–-]\s*(\d+)\s*$/gm;
  while ((match = unitRe.exec(text))) {
    unitHeads.push({
      index: match.index,
      end: match.index + match[0].length,
      uid: match[1],
      from: Number(match[2]),
      to: Number(match[3]),
    });
  }
  if (!unitHeads.length) {
    const shotRe = /^##\s+镜头\s*(\d+)\s*(?:[（(]([^）)]*)[）)])?\s*$/gm;
    while ((match = shotRe.exec(text))) {
      const heading = parseUnitHeading(match[0]);
      if (!heading) continue;
      unitHeads.push({
        index: match.index,
        end: match.index + match[0].length,
        uid: heading.id,
        from: Number(match[1]),
        to: Number(match[1]),
        heading,
        tail: match[2] || "",
      });
    }
  }
  if (!unitHeads.length) return null;

  const tiers = cloneTierDefaults();
  const titleMatch = text.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : "标准工作流单元提示词";
  const scene = { no: 1, name: title, note: "", units: [] };
  const units = [];
  const warnings = [];
  // 素材编号 → 名称：从 subject_definitions 反推（有中文用中文，没有就用英文名）
  const assetNames = {};

  unitHeads.forEach((head, index) => {
    const stop = index + 1 < unitHeads.length ? unitHeads[index + 1].index : text.length;
    const block = text.slice(head.end, stop);
    const fence = block.match(/```(?:text)?\s*\n([\s\S]*?)```/);
    let body = (fence ? fence[1] : block).trim();
    // 无代码围栏时，从六段式的第一段开始，去掉场景/素材绑定/音色绑定等头部行
    if (!fence) {
      const start = body.search(/^subject_definitions:\s*$/m);
      if (start > 0) body = body.slice(start).trim();
    }
    const sections = promptSectionsOf(body);

    const meta = block.match(
      /^[-*]?\s*场景[：:]\s*(.+?)\s*[｜|]\s*镜数[：:]\s*(\d+)\s*[｜|]\s*名义\s*(\d+(?:\.\d+)?)\s*s\s*[｜|]\s*对齐\s*(\d+)\s*帧\s*=\s*([\d.]+)\s*s/m
    );
    const bind = block.match(/^[-*]?\s*(?:素材绑定|素材)[：:]\s*(.+)$/m);
    const voice = block.match(/^[-*]?\s*音色绑定[：:]\s*(.+)$/m);

    let nominal = meta ? Number(meta[3]) : 0;
    if (!nominal && head.tail) {
      const first = head.tail.match(/^(\d+(?:\.\d+)?)\s*(?:s|秒)/i);
      if (first) nominal = Number(first[1]);
    }

    const pictures = bind ? parsePictureBindings(bind[1]) : [];
    const subjects = parseSubjectDefinitions(sections.subject_definitions);
    pictures.forEach((pic) => {
      const subject = subjects.find((item) => item.picture === pic.picture);
      if (!subject || assetNames[pic.code]) return;
      const label = /[\u4e00-\u9fff]/.test(subject.name) ? subject.name : subject.enName || subject.name;
      if (label) assetNames[pic.code] = label;
    });
    const audioDefs = parseAudioDefinitions(sections.subject_definitions);
    const audioRetention = parseAudioRetention(sections.retention_analysis);
    const voiceBindings = voice ? voice[1].trim() : "";
    const audioRefs = mergeAudioRefs(voice ? parseVoiceBindings(voice[1]) : [], audioDefs, audioRetention);

    const summaryText = String(sections.summary || "").trim();
    const prefix = summaryText.match(SUMMARY_PREFIX_RE);
    const summaryBody = prefix ? summaryText.slice(prefix[0].length).trim() : summaryText;

    const id = head.uid;
    const label = head.heading ? head.heading.label : String(head.from).padStart(2, "0");

    if (!prefix) warnings.push(`${id} summary 缺 [reference generation + audio reference] 前缀`);
    const missing = PROMPT_SECTIONS.filter((key) => !sections[key]);
    if (missing.length) warnings.push(`${id} 六段式缺 ${missing.join("、")}`);
    if (new RegExp(`(?:^|[\\s(])${STRUCT_CODE_RE}`, "m").test(body)) {
      warnings.push(`${id} 正文出现素材编号，应只用 <Subject N>`);
    }
    const defined = new Set(subjects.map((item) => item.subject));
    const used = new Set(
      (summaryBody + " " + String(sections.detailed_description || ""))
        .match(/<Subject\s+(\d+)>/g)?.map((item) => Number(item.replace(/\D/g, ""))) || []
    );
    const undefinedSubjects = Array.from(used).filter((no) => !defined.has(no));
    if (undefinedSubjects.length) {
      warnings.push(`${id} 正文用了未定义的 <Subject ${undefinedSubjects.join(">、<Subject ")}>`);
    }

    const unit = {
      id,
      scene: 1,
      label,
      sceneName: meta ? meta[1].trim() : title,
      durationText: nominal ? `${nominal} 秒` : "",
      duration: nominal,
      // 交付稿已算好 17k+5 的帧数（向上对齐），计划工作流直接用这个值
      frames: meta ? Number(meta[4]) : 0,
      alignedSeconds: meta ? Number(meta[5]) : 0,
      shot: "",
      camera: "",
      assets: pictures.map((item) => item.code),
      audioRefs,
      voiceBindings,
      subjects,
      audioDefinitions: audioDefs,
      audioRetention,
      summaryMode: prefix ? prefix[0].replace(/^\[|\]\s*$/g, "").trim() : "",
      sections,
      structuredPrompt: true,
      promptZh: summaryBody,
      promptEn: body,
      englishOnly: true,
      negative: "",
      audio: voiceBindings,
      soundscape: sections.overall_soundscape || "",
      retention: sections.retention_analysis || "",
      continuity: "",
      joint: normalizeJoint(head.heading ? (head.heading.parts || []).join(" ") : ""),
      acceptance: "",
      risk: "",
      firstFramePrompt: "",
      lastFramePrompt: "",
      tier: "B",
      params: {
        ...tiers.B,
        frames: Math.max(5, Math.round((nominal || 8) * (Number(tiers.B.fps) || 16))),
      },
    };
    units.push(unit);
    scene.units.push(unit);
  });

  return {
    title,
    scenes: [scene],
    units,
    params: tiers,
    tierMap: {},
    warnings,
    assets: [],
    assetNames,
    assetAlias: {},
    negativePrompt: "",
    source: "pack",
    structured: true,
  };
}

/**
 * 主入口：把整份 Markdown 手册解析成结构化数据
 * @returns {{title:string, scenes:Array, units:Array, params:object, tierMap:object, warnings:string[]}}
 */
export function parseStoryboard(rawText) {
  const text = unescapeMd(String(rawText || "")).replace(/\r\n?/g, "\n");
  // 六段式单元包：正文只按 <Subject N> / <Audio N> 解析，素材编号只认「素材绑定」行
  if (/^subject_definitions:\s*$/m.test(text)) {
    const structured = parseStructuredPromptPack(text);
    if (structured) return structured;
  }
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
        firstFramePrompt: "",
        lastFramePrompt: "",
        negative: "",
        acceptance: "",
        risk: "",
        joint: "",
        jointReference: "",
        subject: "",
        environment: "",
        elapsed: "",
        anchor: "",
        dialogueText: "",
        _shotStyle: !!heading.shotStyle,
        _lastField: null,
        _tier: heading.tier || null,
      };
      result.units.push(unit);
      scene.units.push(unit);
      continue;
    }

    if (unit) {
      // 双语包把英文写在字段下一行（「  EN: …」）；面板只用中文首尾帧 + 英文视频提示词，这行跳过
      if (/^\s*EN\s*[：:]/i.test(line)) continue;
      const bullet = line.match(
        /^\s*(?:[-*·]\s*)?(?:\*\*)?([^：:*]{1,14})(?:\*\*)?\s*[：:]\s*(?:\*\*)?\s*(.*)$/
      );
      if (bullet) {
        const key = unescapeMd(bullet[1]).trim();
        const value = unescapeMd(bullet[2]).trim();
        const field = unit._shotStyle ? shotFieldOf(key) : fieldOf(key);
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
      } else if (unit._lastField && line.trim() && !/^\s*[-*|>#]/.test(line)) {
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
    const shotStyle = !!unitData._shotStyle;
    // 「镜头 NN」卡片没有「素材：」行，编号直接出现在主体/环境文本里
    unitData.assets = extractAssets(
      [unitData.assetsText, shotStyle ? unitData.subject : "", shotStyle ? unitData.environment : ""]
        .filter(Boolean)
        .join(" ")
    );
    delete unitData.assetsText;
    delete unitData._lastField;
    delete unitData._shotStyle;

    if (shotStyle) {
      unitData.duration = durationSeconds(unitData.durationText) || unitData.duration;
      if (!unitData.promptZh) {
        unitData.promptZh = [unitData.subject, unitData.environment, unitData.camera, unitData.elapsed, unitData.anchor]
          .map((part) => String(part || "").trim().replace(/[。；;]+$/, ""))
          .filter(Boolean)
          .join("。");
      }
      if (!unitData.retention) {
        unitData.retention = [unitData.subject, unitData.anchor].filter(Boolean).join("；");
      }
      // 台词只进「对白」栏：优先 音频/对白，其次 视频提示词补充 里的 <d>
      const spoken = spokenOf(unitData.dialogueText);
      if (!unitData.audio || /^无[。；;]?$/.test(unitData.audio)) {
        unitData.audio = spoken;
      } else if (spoken && !unitData.audio.includes(spoken)) {
        unitData.audio = `${unitData.audio}；${spoken}`;
      }
      const rawJoint = String(unitData.joint || "").trim();
      unitData.jointReference = rawJoint;
      unitData.joint = normalizeJoint(rawJoint);
      delete unitData.subject;
      delete unitData.environment;
      delete unitData.elapsed;
      delete unitData.anchor;
      delete unitData.dialogueText;
    }

    unitData.soundscape = soundscapeOf(unitData.audio);
    // 台词与 <Audio N> 不写进画面 prompt（导演口径：台词只进音频栏）
    unitData.promptZh = stripDialogueFromPrompt(stripPackNoise(unitData.promptZh));
    unitData.promptEn = stripDialogueFromPrompt(stripPackNoise(unitData.promptEn));
    unitData.continuity = stripPackNoise(unitData.continuity);
    unitData.firstFramePrompt = stripPackNoise(unitData.firstFramePrompt);
    unitData.lastFramePrompt = stripPackNoise(unitData.lastFramePrompt);

    // 镜头卡缺「时长」就写不了帧数，交付时要让使用者看见
    if (shotStyle && !String(unitData.durationText || "").trim()) {
      result.warnings.push(`${unitData.id} 缺「时长」，这镜没法按秒数算帧数`);
    }

    unitData.sceneName = (result.scenes.find((item) => item.no === unitData.scene) || {}).name || "";

    const sceneTier = result.tierMap[unitData.scene] || {};
    const tier = unitData._tier || sceneTier[String(unitData.label).toUpperCase()] || "B";
    delete unitData._tier;
    unitData.tier = tier;
    unitData.params = { ...result.params[tier] };
    // 镜头卡的帧数按本镜时长算，和 08 JSON 导入保持一致
    if (shotStyle && unitData.duration > 0) {
      unitData.params.frames = Math.max(
        5,
        Math.round(unitData.duration * (Number(unitData.params.fps) || 16))
      );
    }
  }

  result.scenes.sort((a, b) => a.no - b.no);

  if (!result.units.length) {
    result.warnings.push("没有识别到执行卡（标题里要有 S02-U01 这样的镜号）");
  }

  return result;
}

/** 接点：连续 cont / 切换 cut / 硬切 hard；缺字段或看不懂一律 unknown */
export function normalizeJoint(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "unknown";
  // 以标准标签开头的，直接按开头算（例：「连续 · 原稿未标注接点，已按连续处理」）
  if (/^连续/.test(text)) return "cont";
  if (/^切换/.test(text)) return "cut";
  if (/^硬切/.test(text)) return "hard";
  // 「未标注接点 · 暂按连续处理…请人工确认是否应改为硬切」整句里同时出现「连续」和「硬切」，
  // 必须先认出「未标注」，否则会被后面的关键字误判成硬切。
  if (/未标注|unknown|待确认|请人工确认/.test(text)) return "unknown";
  if (/hard|硬切/.test(text)) return "hard";
  // 切换的说明里常写「只作身份参考」「构图按本镜重设」，要在连续之前判
  if (/cut|切换|同场换机位|只作人物|身份参考，构图/.test(text)) return "cut";
  // 04 的连续行只写「可把上一镜尾帧…作为视频参考」，没有「连续」两个字
  if (/cont|连续|可把上一镜尾帧|作为视频参考|沿用上一镜/.test(text)) return "cont";
  return "unknown";
}

/** 把视频提示词末尾内嵌的「Negative: …」拆出来，避免和负向提示词重复 */
function splitInlineNegative(value) {
  const text = String(value || "").trim();
  const at = text.search(/(?:^|\s)Negative\s*[:：]/i);
  if (at < 0) return { text, negative: "" };
  return {
    text: text.slice(0, at).trim(),
    negative: text.slice(at).replace(/^\s*Negative\s*[:：]\s*/i, "").trim(),
  };
}

/**
 * 时长字符串 → 秒数。导演包里有三种写法：`5s`、`5 秒`、`3—8 秒`；
 * 区间取上限（与交付卡总时长口径一致），带「分」的先折成秒。
 */
export function durationSeconds(value) {
  const text = String(value || "").replace(/[，,]/g, " ").trim();
  if (!text) return 0;
  const minutes = text.match(/(\d+(?:\.\d+)?)\s*分/);
  if (minutes) {
    const seconds = text.match(/(\d+(?:\.\d+)?)\s*秒/);
    return Number(minutes[1]) * 60 + (seconds ? Number(seconds[1]) : 0);
  }
  const numbers = text.match(/\d+(?:\.\d+)?/g);
  if (!numbers || !numbers.length) return 0;
  return Math.max(...numbers.map(Number));
}

/**
 * 解析「提示词包」JSON（豆包导演导出的 08-分镜表.json）：
 * { title, summary, negativePrompt, shots: [{ shot, duration, subject, environment,
 *   camera, elapsed, anchor, scene, firstFrame, lastFrame, videoPrompt, audio,
 *   continuity, acceptance, risk }] }
 * 每镜映射成一张卡：视频提示词 → 英文提示词，其余中文字段合成中文提示词。
 */
export function parsePromptPack(data, titleOverride) {
  const pack = data && typeof data === "object" ? data : {};
  const title = String(titleOverride || pack.title || "提示词包").trim();
  const tiers = cloneTierDefaults();
  const scene = { no: 1, name: title, units: [], note: String(pack.summary || "").trim() };
  const units = [];
  const warnings = [];
  // 出包端若已汇总「缺视频提示词」的镜号，逐镜重复的那句就不刷屏了
  const emptyPromptWarnings = [];

  (Array.isArray(pack.shots) ? pack.shots : []).forEach((shot, index) => {
    const no = String(shot && shot.shot != null ? shot.shot : index + 1).padStart(2, "0");
    // 双语包会把英文放 videoPromptEn；中文正文仍留在 videoPrompt
    const rawZhVideo = stripPackNoise(String((shot && shot.videoPrompt) || ""));
    const rawVideo = stripPackNoise(String((shot && shot.videoPromptEn) || "")) || rawZhVideo;
    const video = splitInlineNegative(rawVideo);
    // 带音频模型的包把台词写成 <d>[Chinese] …</d>；台词只进「对白」栏，不进画面
    const spoken = spokenOf(rawVideo) || spokenOf(rawZhVideo);
    const audioText = stripPackNoise(String((shot && shot.audio) || "")).trim();
    const audio = /^无[。；;]?$/.test(audioText) ? "" : audioText || spoken;
    // 出包端按镜头文本里的素材名自动匹配出的编号，可能为空
    const assetRefs = (Array.isArray(shot && shot.assetRefs) ? shot.assetRefs : [])
      .map((code) => normalizeAssetCode(String(code || "").trim()))
      .filter(Boolean);
    const durationText = String((shot && shot.duration) || "").trim();
    const seconds = durationSeconds(durationText);
    if (!durationText) {
      warnings.push(`S01-U${no} 缺「时长」，这镜只能按 B 档默认帧数走`);
    }
    const zhFields = [shot.scene, shot.subject, shot.environment, shot.camera, shot.elapsed, shot.anchor]
      .map((part) => stripPackNoise(String(part || "")).replace(/[。；;]+$/, ""))
      .filter(Boolean);
    // 英文正文单独给的时候，中文正文本身就是画面摘要，别丢
    if (rawZhVideo && rawZhVideo !== rawVideo && /[\u4e00-\u9fff]/.test(rawZhVideo)) {
      zhFields.push(stripDialogueFromPrompt(rawZhVideo));
    }
    const zhParts = zhFields;
    // 参数沿用执行卡的 B 档，但帧数按本镜时长算，画幅按提示词里写的比例
    const params = { ...tiers.B };
    if (seconds > 0) params.frames = Math.max(5, Math.round(seconds * (Number(params.fps) || 16)));
    const ratioText = [shot.videoPrompt, shot.videoPromptEn, shot.firstFrame, shot.scene, shot.environment]
      .filter(Boolean)
      .join(" ");
    if (/9\s*[:：]\s*16/.test(ratioText)) {
      params.width = 720;
      params.height = 1280;
    }
    const unit = {
      id: `S01-U${no}`,
      scene: 1,
      label: no,
      sceneName: title,
      durationText,
      duration: seconds,
      shot: "",
      camera: stripPackNoise(String((shot && shot.camera) || "")).trim(),
      assets: [
        ...new Set([
          ...assetRefs,
          ...extractAssets([shot.subject, shot.environment, shot.anchor, shot.scene, audio].filter(Boolean).join(" ")),
        ]),
      ],
      promptZh: zhParts.join("。"),
      promptEn: stripDialogueFromPrompt(video.text),
      // 提示词包的英文正文已经包含中文摘要的全部信息，拼提示词时不再重复中文
      englishOnly: true,
      negative: video.negative,
      audio,
      soundscape: soundscapeOf(audio),
      // 提示词包没有「保留」行，用主体与空间锚点当连续性约束
      retention: [shot.subject, shot.anchor].filter(Boolean).join("；"),
      continuity: stripPackNoise(String((shot && shot.continuity) || "")).trim(),
      acceptance: stripPackNoise(String((shot && shot.acceptance) || "")).trim(),
      risk: stripPackNoise(String((shot && shot.risk) || "")).trim(),
      firstFramePrompt: stripPackNoise(String((shot && shot.firstFrame) || "")).trim(),
      lastFramePrompt: stripPackNoise(String((shot && shot.lastFrame) || "")).trim(),
      // 接点：决定这镜要不要沿用上一镜画面
      joint: normalizeJoint(shot && shot.joint),
      jointReference: stripPackNoise(String((shot && shot.jointReference) || "")).trim(),
      tier: "B",
      params,
    };
    units.push(unit);
    scene.units.push(unit);

    // 导演工具偶尔会中途截断。中文成稿本来就不带句号，英文成稿也常常整句不加标点，
    // 所以只看「整段为空」「字段以冒号/逗号结尾」「括号没配上」这三种硬信号。
    const joined = [shot.subject, shot.environment, shot.firstFrame, shot.lastFrame, unit.promptEn]
      .map((part) => String(part || ""))
      .join("|");
    const openParen = (joined.match(/（/g) || []).length;
    const closeParen = (joined.match(/）/g) || []).length;
    const dangling = [shot.subject, shot.environment, shot.camera, shot.firstFrame, shot.lastFrame, rawVideo]
      .map((part) => String(part || "").trim())
      .some((part) => /[：:，,、]$/.test(part));
    if (!unit.promptEn) {
      const text = `${unit.id} 视频提示词为空，这一镜在包里被截断了`;
      warnings.push(text);
      emptyPromptWarnings.push(text);
    } else if (dangling) {
      warnings.push(`${unit.id} 有字段以冒号/逗号结尾，疑似被截断：…${unit.promptEn.slice(-24)}`);
    } else if (openParen !== closeParen) {
      warnings.push(`${unit.id} 字段括号没闭合，疑似被截断：…${unit.promptEn.slice(-24)}`);
    }
  });

  // 出包端的交付自检：非阻断，原样展示给使用者
  const packWarnings = (Array.isArray(pack.warnings) ? pack.warnings : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  warnings.push(...packWarnings);
  // 出包端已经列出了缺提示词的镜号，逐镜那 6 句就不再重复刷日志
  const packListsMissing = packWarnings.some((item) => /缺视频提示词|缺首帧|视频提示词或首帧/.test(item));
  if (packListsMissing) {
    emptyPromptWarnings.forEach((text) => {
      const at = warnings.indexOf(text);
      if (at >= 0) warnings.splice(at, 1);
    });
  }

  if (!units.length) warnings.push("JSON 里没有 shots 镜头列表");
  // 导演规律：每场第一个镜头一律硬切
  if (units.length && units[0].joint === "unknown") {
    warnings.push(`${units[0].id} 未标注接点；每场第一个镜头应为硬切`);
  }
  // 分场之间会空出若干镜号，缺号本身正常，但要让用户知道总表不是 1..N 连续
  const numbers = units.map((unit) => Number(unit.label)).filter((value) => value > 0).sort((a, b) => a - b);
  const gaps = [];
  let cursor = 1;
  numbers.forEach((value) => {
    if (value > cursor) gaps.push(`${cursor}-${value - 1}`);
    cursor = Math.max(cursor, value + 1);
  });
  const mentionsGap = packWarnings.some((item) => /镜号不连续|缺号|缺 \d|缺\d/.test(item));
  if (gaps.length && !mentionsGap) {
    warnings.push(`镜头号不连续：缺 ${gaps.join("、")}（分场空号，确认不是漏镜）`);
  }
  const mentionsFirst = packWarnings.some((item) => /首镜|从 ?01|从 ?1 起|增量/.test(item));
  if (numbers.length && numbers[0] !== 1 && !mentionsFirst) {
    warnings.push(`首镜是 ${numbers[0]}，不是 01：确认这份包不是增量或漏镜`);
  }

  // 08 里带的素材清单：编号 → 中文名，给卡片标签和素材表用
  const assets = (Array.isArray(pack.assets) ? pack.assets : [])
    .map((item) => {
      const id = normalizeAssetCode(String((item && item.id) || "").trim());
      if (!id) return null;
      return {
        id,
        kind: String((item && item.kind) || "").trim(),
        name: String((item && item.name) || "").trim(),
        // 出图文件名可能用另一套编号（S-01 的图叫 R-01_sheet_v01.png），记下来做别名
        file: String((item && item.file) || "").trim(),
        prompt: String((item && item.prompt) || "").trim(),
        promptEn: String((item && item.promptEn) || "").trim(),
        consistency: String((item && item.consistency) || "").trim(),
        negative: String((item && item.negative) || "").trim(),
      };
    })
    .filter(Boolean);
  const assetNames = {};
  assets.forEach((item) => {
    const label = [item.kind, item.name].filter(Boolean).join("·");
    if (label) assetNames[item.id] = label;
  });
  // 别名表：文件名里的编号 → 镜头 assetRefs 用的编号（文件名常带下划线，先把下划线当分隔符）
  const assetAlias = {};
  assets.forEach((item) => {
    if (!item.file) return;
    const fileCode = extractAssets(String(item.file).replace(/_/g, " "))[0];
    if (fileCode && fileCode !== item.id) assetAlias[fileCode] = item.id;
  });
  const aliasPairs = Object.keys(assetAlias).map((code) => `${code}→${assetAlias[code]}`);
  if (aliasPairs.length) {
    warnings.push(
      `素材文件名与编号不一致：${aliasPairs.join("、")}（已按文件名自动对上；正文里同名编号若指别人，请改文件名）`
    );
  }

  return {
    title,
    scenes: [scene],
    units,
    params: tiers,
    tierMap: {},
    warnings,
    assets,
    assetNames,
    assetAlias,
    negativePrompt: String(pack.negativePrompt || "").trim(),
    source: "pack",
  };
}

/** 极简 CSV：支持引号包裹、字段内逗号换行、"" 转义、UTF-8 BOM */
function parseCsvRows(text) {
  const source = String(text || "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => String(cell).trim()));
}

// 06-镜头表.csv：12 列基础版 + 新增的接点 / 音频对白
const CSV_FIELD_MAP = {
  镜头号: "shot",
  时长: "duration",
  主体状态: "subject",
  环境与光照: "environment",
  机位与运镜: "camera",
  时间流逝: "elapsed",
  空间锚点: "anchor",
  首帧提示词: "firstFrame",
  尾帧提示词: "lastFrame",
  视频提示词: "videoPrompt",
  首尾帧验收: "acceptance",
  风险: "risk",
  接点: "joint",
  "音频/对白": "audio",
  音频对白: "audio",
  音频: "audio",
  对白: "audio",
};

/** 备用解析：06-镜头表.csv（按表头对列，表头缺失时按固定顺序兜底） */
export function parsePromptPackCsv(text, titleOverride) {
  const rows = parseCsvRows(text);
  if (!rows.length) return parsePromptPack({ title: "", shots: [] }, titleOverride);
  const header = rows[0].map((cell) => String(cell).trim());
  // 只按表头名映射：列顺序、列数变了都不影响（06 现在是 14 列）
  const keys = header.map((name) => CSV_FIELD_MAP[name] || null);
  const shots = rows.slice(1).map((cells) => {
    const shot = {};
    cells.forEach((cell, index) => {
      const key = keys[index];
      if (key) shot[key] = String(cell || "").trim();
    });
    // 接点列写的是整句说明（「未标注接点 · 先按连续处理…」），原样留作参考
    if (shot.joint) shot.jointReference = shot.joint;
    return shot;
  });
  return parsePromptPack({ title: "", shots }, titleOverride);
}

/** 04-视频提示词.txt：可选的「接点：连续」行 + 【镜头 01】时长 / 景别·运镜 + 下一行起英文提示词 */
export function parsePromptPackTxt(text, titleOverride) {
  const source = String(text || "").replace(/^\uFEFF/, "");
  const shots = [];
  let current = null;
  // 接点行有两种位置：新包写在本镜标题之后、正文之前；旧包写在下一条标题之前
  let awaitingJoint = false;
  let pendingJoint = "";
  for (const line of source.split(/\r?\n/)) {
    const jointMatch = line.match(/^接点\s*[：:]\s*(.*)$/);
    if (jointMatch) {
      const value = jointMatch[1].trim();
      if (current && awaitingJoint) {
        current.joint = value;
        current.jointReference = value;
        awaitingJoint = false;
      } else {
        pendingJoint = value;
      }
      continue;
    }
    const head = line.match(/^【镜头\s*(\d+)】\s*(.*)$/);
    if (head) {
      const [duration, ...cameraParts] = String(head[2] || "").split("/");
      current = {
        shot: head[1],
        duration: duration.trim(),
        camera: cameraParts.join("/").trim(),
        videoPrompt: "",
        joint: pendingJoint,
        jointReference: pendingJoint,
      };
      pendingJoint = "";
      awaitingJoint = true;
      shots.push(current);
      continue;
    }
    if (current) {
      current.videoPrompt = `${current.videoPrompt ? `${current.videoPrompt}\n` : ""}${line}`;
      if (line.trim()) awaitingJoint = false;
    }
  }
  for (const shot of shots) shot.videoPrompt = String(shot.videoPrompt || "").trim();
  return parsePromptPack({ title: "", shots }, titleOverride);
}

/** 统一入口：JSON / CSV / 04 纯文本 走提示词包解析，其余仍按 Markdown 执行卡解析 */
export function parseAnyStoryboard(text, titleOverride) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return parseStoryboard(text);
  if (trimmed.startsWith("{")) {
    try {
      const data = JSON.parse(trimmed);
      if (data && Array.isArray(data.shots) && data.shots.length) {
        return parsePromptPack(data, titleOverride);
      }
    } catch (error) {
      /* 不是合法 JSON 就退回 Markdown 解析 */
    }
  }
  if (/【镜头\s*\d+】/.test(trimmed)) return parsePromptPackTxt(trimmed, titleOverride);
  // CSV 只看表头有没有「镜头号」，列顺序不固定（06 现在是 14 列，接点在第 3 列）
  const firstLine = trimmed.split(/\r?\n/, 1)[0] || "";
  if (/镜头号/.test(firstLine) && firstLine.includes(",")) {
    return parsePromptPackCsv(trimmed, titleOverride);
  }
  return parseStoryboard(text);
}

/** 按设定拼接提示词：中文动作句 → 英文动作句 → 质感串，用句号连接 */
export function buildPrompt(unit, options = {}) {
  if (!unit) return "";
  const mode = options.mode || "zh+en+quality";
  const parts = [];
  // 提示词包只有英文正文是成稿；同时要中英时不再把中文摘要重复拼一遍
  const allowZh = mode.includes("zh") && !(unit.englishOnly && mode.includes("en"));
  if (allowZh && unit.promptZh) parts.push(unit.promptZh);
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
