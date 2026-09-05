/**
 * ovaijisuan 自部署模型服务 · 供应商适配
 * @version 3.0
 *
 * 端点契约（已对 https://maas.ovaijisuan.com 实测验证）：
 *   文本  POST {baseUrl}/chat/completions            OpenAI 兼容
 *   文生图 POST {baseUrl}/images/generations          JSON，同步返回 data[0].url
 *   图生图 POST {baseUrl}/images/edits                multipart，同步返回 data[0].url
 *   视频  POST {baseUrl}/video/generations           JSON → { task_id }
 *        GET  {baseUrl}/video/generations/{task_id}  → { data: { status, result_url } }
 *
 * 视频模式由 metadata.task_type 显式指定：
 *   t2v   纯文本
 *   i2v   首帧          images=[首帧]
 *   flf2v 首尾帧        images=[首帧, 尾帧]
 *   l2va  仅尾帧        images=[尾帧]
 *   r2va  参考图        metadata.src_ref_images=[...]
 */

// ============================================================
// 类型定义
// ============================================================
type VideoMode =
  | "singleImage"
  | "startEndRequired"
  | "endFrameOptional"
  | "startFrameOptional"
  | "text"
  | (`videoReference:${number}` | `imageReference:${number}` | `audioReference:${number}`)[];

type ReferenceList =
  | { type: "image"; sourceType: "base64"; base64: string }
  | { type: "audio"; sourceType: "base64"; base64: string }
  | { type: "video"; sourceType: "base64"; base64: string };

interface TextModel {
  name: string;
  modelName: string;
  type: "text";
  think: boolean;
}
interface ImageModel {
  name: string;
  modelName: string;
  type: "image";
  mode: ("text" | "singleImage" | "multiReference")[];
  associationSkills?: string;
}
interface VideoModel {
  name: string;
  modelName: string;
  type: "video";
  mode: VideoMode[];
  associationSkills?: string;
  audio: "optional" | false | true;
  durationResolutionMap: { duration: number[]; resolution: string[] }[];
}
interface TTSModel {
  name: string;
  modelName: string;
  type: "tts";
  voices: { title: string; voice: string }[];
}
interface VendorConfig {
  id: string;
  version: string;
  name: string;
  author: string;
  description?: string;
  icon?: string;
  inputs: { key: string; label: string; type: "text" | "password" | "url"; required: boolean; placeholder?: string }[];
  inputValues: Record<string, string>;
  models: (TextModel | ImageModel | VideoModel | TTSModel)[];
}
interface ImageConfig {
  prompt: string;
  referenceList?: Extract<ReferenceList, { type: "image" }>[];
  size: "1K" | "2K" | "4K";
  aspectRatio: `${number}:${number}`;
}
interface VideoConfig {
  duration: number;
  resolution: string;
  aspectRatio: "16:9" | "9:16";
  prompt: string;
  referenceList?: ReferenceList[];
  audio?: boolean;
  mode: VideoMode[];
}
interface TTSConfig {
  text: string;
  voice: string;
  speechRate: number;
  pitchRate: number;
  volume: number;
}
interface PollResult {
  completed: boolean;
  data?: string;
  error?: string;
}

// ============================================================
// 全局声明（由 src/utils/vm.ts 注入沙箱）
// ============================================================
declare const axios: any;
declare const FormData: any;
declare const logger: (msg: any) => void;
declare const urlToBase64: (url: string) => Promise<string>;
declare const pollTask: (fn: () => Promise<PollResult>, interval?: number, timeout?: number) => Promise<PollResult>;
declare const createOpenAI: any;
declare const exports: {
  vendor: VendorConfig;
  textRequest: (m: TextModel, t: boolean, tl: 0 | 1 | 2 | 3) => any;
  imageRequest: (c: ImageConfig, m: ImageModel) => Promise<string>;
  videoRequest: (c: VideoConfig, m: VideoModel) => Promise<string>;
  ttsRequest: (c: TTSConfig, m: TTSModel) => Promise<string>;
  checkForUpdates?: () => Promise<{ hasUpdate: boolean; latestVersion: string; notice: string }>;
  updateVendor?: () => Promise<string>;
};

// ============================================================
// 供应商配置
// ============================================================
const vendor: VendorConfig = {
  id: "ovaijisuan",
  version: "3.0",
  author: "self-hosted",
  name: "ovaijisuan",
  description:
    "自部署模型服务。文本走 OpenAI 兼容接口；图像走 images/generations 与 images/edits；视频走 video/generations 异步任务。模型列表可在下方手动增删。",
  icon: "",
  inputs: [
    { key: "apiKey", label: "API密钥", type: "password", required: true, placeholder: "sk-..." },
    { key: "baseUrl", label: "请求地址", type: "url", required: true, placeholder: "以 /v1 结尾，示例：https://maas.ovaijisuan.com/v1" },
  ],
  inputValues: {
    apiKey: "",
    baseUrl: "https://maas.ovaijisuan.com/v1",
  },
  models: [
    // ---------- 文本（自部署，小写模型名）----------
    { name: "Qwen3.8 Flash FP8", modelName: "qwen3.8-flash-fp8", type: "text", think: false },
    { name: "Qwen3.8 27B", modelName: "qwen3.8-27b", type: "text", think: false },
    { name: "GLM-5.2", modelName: "glm-5.2", type: "text", think: false },
    { name: "GLM-5.2 W4A8", modelName: "glm-5.2-w4a8", type: "text", think: false },
    { name: "DeepSeek V4 Flash", modelName: "deepseek-v4-flash-0731", type: "text", think: false },

    // ---------- 图像 ----------
    { name: "Qwen Image（文生图）", modelName: "qwen-image", type: "image", mode: ["text"] },
    { name: "Qwen Image Edit（参考图）", modelName: "qwen-image-edit", type: "image", mode: ["text", "singleImage", "multiReference"] },

    // ---------- 视频 ----------
    {
      name: "MiniMax H3 参考生视频",
      modelName: "minimax-h3-ref2va",
      type: "video",
      mode: ["singleImage"],
      audio: "optional",
      durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480p", "768p"] }],
    },
    {
      name: "MiniMax H3 参考生视频（快速）",
      modelName: "minimax-h3-fast-ref2va",
      type: "video",
      mode: ["singleImage"],
      audio: "optional",
      durationResolutionMap: [{ duration: [10, 11, 12, 13, 14, 15], resolution: ["480p", "768p"] }],
    },
    {
      name: "MiniMax H3 首尾帧",
      modelName: "minimax-h3-fl2va",
      type: "video",
      mode: ["singleImage", "startEndRequired", "endFrameOptional"],
      audio: "optional",
      durationResolutionMap: [{ duration: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480p", "768p"] }],
    },
    {
      name: "MiniMax H3 首尾帧（快速）",
      modelName: "minimax-h3-fast-fl2va",
      type: "video",
      mode: ["singleImage", "startEndRequired", "endFrameOptional"],
      audio: "optional",
      durationResolutionMap: [{ duration: [10, 11, 12, 13, 14, 15], resolution: ["480p", "768p"] }],
    },
    {
      name: "LTX 2.5 HD",
      modelName: "ltx2.5-hd",
      type: "video",
      mode: ["text", "singleImage"],
      audio: false,
      durationResolutionMap: [{ duration: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["544p", "704p", "1080p", "2k"] }],
    },
  ],
};

// ============================================================
// 工具函数
// ============================================================
/** qwen-image-edit 的参考图硬上限，超出时上游返回 500「图片编辑最多支持 5 张底图」 */
const MAX_EDIT_REFS = 5;

/**
 * 截断参考图后，把提示词里指向已丢弃图片的 `@图N` 引用一并去掉。
 * 上游拼装格式形如：`@图1 为林深角色 @图2 为陈锐角色 @图6 为白瓷水杯 ...`
 * 留着 @图6 会让模型去找不存在的参考对象，反而干扰生成。
 */
function stripDroppedRefs(prompt: string, keep: number): string {
  return String(prompt)
    // 整段移除 "@图N 为XXX"（N > keep），描述持续到下一个 @图 或断句符
    .replace(/@图(\d+)\s*为[^@，,。\n]*/g, (whole, n) => (Number(n) > keep ? "" : whole))
    // 移除残留的裸引用
    .replace(/@图(\d+)/g, (whole, n) => (Number(n) > keep ? "" : whole))
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function creds(): { apiKey: string; baseUrl: string } {
  const raw = vendor.inputValues.apiKey;
  if (!raw) throw new Error("缺少 API Key");
  const baseUrl = (vendor.inputValues.baseUrl || "").replace(/\/+$/, "");
  if (!baseUrl) throw new Error("缺少请求地址");
  return { apiKey: raw.replace(/^Bearer\s+/i, ""), baseUrl };
}

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

/** 去掉 data URI 前缀，返回纯 base64 */
function stripDataUri(s: string): string {
  return s.replace(/^data:[^;]+;base64,/, "");
}

/** 补上 data URI 前缀（上游接受 data URI 或 https URL） */
function toDataUri(s: string): string {
  if (/^https?:\/\//i.test(s) || /^data:/i.test(s)) return s;
  return `data:image/png;base64,${s}`;
}

function imageBase64List(config: { referenceList?: { type: string; base64: string }[] }): string[] {
  return (config.referenceList ?? []).filter((r) => r.type === "image").map((r) => r.base64);
}

/** size 档位 + 宽高比 → "WxH"，对齐到 64 的倍数 */
function pixelSize(size: string, aspectRatio: string): string {
  const base = size === "4K" ? 4096 : size === "2K" ? 2048 : 1024;
  const parts = String(aspectRatio || "1:1").split(":");
  const rw = Number(parts[0]) || 1;
  const rh = Number(parts[1]) || 1;
  const scale = base / Math.sqrt(rw * rh);
  const align = (v: number) => Math.max(256, Math.round((v * scale) / 64) * 64);
  return `${align(rw)}x${align(rh)}`;
}

/** "768p" / "1080p" / "2k" + 宽高比 → { width, height } */
function resolutionWH(resolution: string, aspectRatio: string): { width: number; height: number } {
  const r = String(resolution || "").toLowerCase();
  const shortSide = r === "2k" ? 1440 : parseInt(r.replace(/[^0-9]/g, ""), 10) || 720;
  const portrait = String(aspectRatio) === "9:16";
  const parts = String(aspectRatio || "16:9").split(":");
  const rw = Number(parts[0]) || 16;
  const rh = Number(parts[1]) || 9;
  const ratio = portrait ? rh / rw : rw / rh;
  const longSide = Math.round((shortSide * ratio) / 2) * 2;
  return portrait ? { width: shortSide, height: longSide } : { width: longSide, height: shortSide };
}

/** 从响应体里取出图片地址 */
function pickImage(body: any): string {
  const item = body?.data?.[0];
  if (!item) throw new Error(`图像生成失败：${JSON.stringify(body).slice(0, 300)}`);
  if (item.url) return item.url;
  if (item.b64_json) return toDataUri(item.b64_json);
  throw new Error(`图像响应中无 url/b64_json：${JSON.stringify(item).slice(0, 300)}`);
}

/**
 * 决定 metadata.task_type。
 * 注意：运行时 config.mode 是单个字符串（见 volcengine.ts 同样处理），
 * 类型签名里写成数组是模板遗留，这里两种都兼容。
 */
function resolveTaskType(modelName: string, mode: any, imageCount: number): string {
  const m = typeof mode === "string" ? mode : Array.isArray(mode) ? String(mode[0] ?? "") : "";

  // ref2va 系列只认参考图通道
  if (/ref2va$/i.test(modelName)) return "r2va";

  if (m === "startEndRequired") return "flf2v";
  if (m === "endFrameOptional") return imageCount >= 2 ? "flf2v" : "i2v";
  if (m === "startFrameOptional") return imageCount >= 2 ? "flf2v" : "l2va";
  if (m === "singleImage") return "i2v";
  if (m === "text") return "t2v";

  // 兜底：按图片数量推断
  if (imageCount >= 2) return "flf2v";
  if (imageCount === 1) return "i2v";
  return "t2v";
}

// ============================================================
// 适配器函数
// ============================================================
const textRequest = (model: TextModel, _think: boolean, _thinkLevel: 0 | 1 | 2 | 3) => {
  const { apiKey, baseUrl } = creds();
  return createOpenAI({ baseURL: baseUrl, apiKey }).chat(model.modelName);
};

const imageRequest = async (config: ImageConfig, model: ImageModel): Promise<string> => {
  const { apiKey, baseUrl } = creds();
  const all = imageBase64List(config);

  // 上游 batchGenerateImage.ts 不限制参考图数量，分镜引用几个资产就传几张，
  // 而 qwen-image-edit 硬上限是 5 张，超出直接 500：
  //   图片编辑最多支持 5 张底图,当前 6 张
  // 实测 34 个分镜里 15 个因此失败。在供应商侧兜底截断，避免改上游代码。
  //
  // 保留前 5 张：上游按「角色 → 场景 → 道具」的顺序拼装 @图N，
  // 截断尾部即优先保住角色一致性（最影响观感的那部分）。
  const refs = all.slice(0, MAX_EDIT_REFS);
  // 提示词里的 @图6、@图7 等指代已被截掉的图，留着会让模型引用不存在的对象，
  // 一并从提示词中移除。
  const prompt = all.length > MAX_EDIT_REFS ? stripDroppedRefs(config.prompt, MAX_EDIT_REFS) : config.prompt;
  if (all.length > MAX_EDIT_REFS) {
    logger(`[ovaijisuan] 参考图 ${all.length} 张超出上限，截断为 ${MAX_EDIT_REFS} 张`);
  }

  // 有参考图 → multipart /images/edits
  if (refs.length > 0) {
    const form = new FormData();
    form.append("model", model.modelName);
    form.append("prompt", prompt);
    form.append("n", "1");
    refs.forEach((b64, i) => {
      form.append("image", Buffer.from(stripDataUri(b64), "base64"), {
        filename: `ref_${i}.png`,
        contentType: "image/png",
      });
    });
    const res = await axios.post(`${baseUrl}/images/edits`, form, {
      headers: Object.assign({}, form.getHeaders(), { Authorization: `Bearer ${apiKey}` }),
      timeout: 600000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
    return pickImage(res.data);
  }

  // 纯文生图 → JSON /images/generations
  const res = await axios.post(
    `${baseUrl}/images/generations`,
    {
      model: model.modelName,
      prompt: config.prompt,
      n: 1,
      size: pixelSize(config.size, config.aspectRatio),
    },
    { headers: authHeaders(apiKey), timeout: 600000, maxContentLength: Infinity },
  );
  return pickImage(res.data);
};

const videoRequest = async (config: VideoConfig, model: VideoModel): Promise<string> => {
  const { apiKey, baseUrl } = creds();
  const images = imageBase64List(config);
  const taskType = resolveTaskType(model.modelName, config.mode, images.length);
  const wh = resolutionWH(config.resolution, config.aspectRatio);

  const metadata: Record<string, any> = { task_type: taskType };
  const body: Record<string, any> = {
    model: model.modelName,
    prompt: config.prompt,
    duration: config.duration,
    width: wh.width,
    height: wh.height,
    metadata,
  };

  if (taskType === "r2va") {
    if (!images.length) throw new Error("参考生视频需要至少 1 张参考图");
    metadata.src_ref_images = images.map(toDataUri);
  } else if (images.length) {
    // i2v=[首帧]，flf2v=[首帧,尾帧]，l2va=[尾帧]
    body.images = (taskType === "flf2v" ? images.slice(0, 2) : images.slice(0, 1)).map(toDataUri);
    if (taskType === "flf2v" && body.images.length < 2) {
      throw new Error("首尾帧模式需要首帧和尾帧两张图");
    }
  }

  const submit = await axios.post(`${baseUrl}/video/generations`, body, {
    headers: authHeaders(apiKey),
    timeout: 120000,
    maxBodyLength: Infinity,
  });

  const sd = submit.data ?? {};
  const taskId = sd.task_id || sd.id || sd.data?.task_id;
  if (!taskId) throw new Error(`视频任务提交失败：${JSON.stringify(sd).slice(0, 300)}`);
  logger(`[ovaijisuan] 视频任务已提交 task_type=${taskType} task_id=${taskId}`);

  // 轮询：5s 一次，最长 30 分钟
  const result = await pollTask(
    async (): Promise<PollResult> => {
      const q = await axios.get(`${baseUrl}/video/generations/${taskId}`, {
        headers: authHeaders(apiKey),
        timeout: 60000,
      });
      const d = q.data?.data ?? q.data ?? {};
      const status = String(d.status ?? "").toUpperCase();

      if (status === "SUCCESS" || status === "SUCCEEDED" || status === "COMPLETED") {
        const url = d.result_url || d.url || d.data?.result_url;
        if (!url) return { completed: true, error: `任务成功但未返回地址：${JSON.stringify(d).slice(0, 300)}` };
        return { completed: true, data: url };
      }
      if (status === "FAILURE" || status === "FAILED" || status === "ERROR") {
        return { completed: true, error: d.fail_reason || d.error?.message || "视频生成失败" };
      }
      return { completed: false };
    },
    5000,
    1800000,
  );

  if (result.error) throw new Error(result.error);
  if (!result.data) throw new Error("视频生成超时");
  return result.data;
};

const ttsRequest = async (_config: TTSConfig, _model: TTSModel): Promise<string> => {
  throw new Error("该供应商暂未接入 TTS");
};

const checkForUpdates = async (): Promise<{ hasUpdate: boolean; latestVersion: string; notice: string }> => {
  return { hasUpdate: false, latestVersion: vendor.version, notice: "" };
};

const updateVendor = async (): Promise<string> => {
  return "";
};

exports.vendor = vendor;
exports.textRequest = textRequest;
exports.imageRequest = imageRequest;
exports.videoRequest = videoRequest;
exports.ttsRequest = ttsRequest;
exports.checkForUpdates = checkForUpdates;
exports.updateVendor = updateVendor;
export {};
