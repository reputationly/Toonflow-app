import express from "express";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";
const router = express.Router();

import fs from "fs";
import path from "path";

declare const __APP_VERSION__: string | undefined;

const APP_VERSION: string = (() => {
  if (typeof __APP_VERSION__ !== "undefined") {
    return __APP_VERSION__;
  }
  // 开发环境回退：从 package.json 读取
  const pkgPath = path.resolve(process.cwd(), "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  return pkg.version;
})();

// 更新清单地址。默认指向自建的 Cloudflare R2；可用环境变量覆盖，便于
// 私有化部署各自指向自己的分发桶，无需改代码重新打包。
// 清单结构见 docs/技术评估与开发环境搭建.md §8。
const DEFAULT_MANIFEST_URL = process.env.UPDATE_MANIFEST_URL || "https://aijisuan.kdns.fr/update.json";

/**
 * 版本号解析。支持四段式 MAJOR.MINOR.PATCH.BUILD：
 * 前三段与上游 Toonflow 保持一致，第四段是本仓的定制迭代号——
 * 上游未发新版时递增它，即可把自有修复通过增量包推给已装机用户。
 * 缺省段按 0 处理，所以 "1.1.8" 与 "1.1.8.0" 等价。
 */
function parseVersion(v: string): number[] {
  return String(v)
    .split(".")
    .map((n) => {
      const parsed = Number.parseInt(n, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    });
}

/**
 * 逐段比较，返回首个不同段的下标与两侧取值；完全相同返回 null。
 *
 * 必须逐段短路：原实现是三个独立的 if，远端 1.1.9 对本地 1.2.0 时
 * MAJOR/MINOR 都不满足，却会命中 `PATCH 9 > 0` 而把降级当成更新推出去。
 */
function diffSegment(remote: number[], local: number[]): { index: number; remote: number; local: number } | null {
  const len = Math.max(remote.length, local.length);
  for (let i = 0; i < len; i++) {
    const r = remote[i] ?? 0;
    const l = local[i] ?? 0;
    if (r !== l) return { index: i, remote: r, local: l };
  }
  return null;
}

export default router.post(
  "/",
  validateFields({
    // source 是清单 data 对象里的键名，不是「下载渠道」。前端目前只启用了一个源
    // （web/src/components/setting/components/about.vue 里 github/gitee/atomgit
    // 均为 disabled:true），保留原枚举是为了不破坏既有前端产物的兼容性。
    source: z.enum(["toonflow", "github", "gitee", "atomgit"]),
    url: z.url().nullable().optional(),
  }),
  async (req, res) => {
    const { source, url } = req.body;

    const getUrl = url ?? DEFAULT_MANIFEST_URL;

    // 工作台会在后台静默调用本接口（web/src/pages/workbench/index.vue checkVersion）。
    // 网络不可达 / 超时 / 返回非 JSON 时不能把异常抛给全局错误处理器：那会返回 500，
    // 前端拿到的 data 为 undefined，读 data.needUpdate 又会触发一次未捕获的 promise 拒绝。
    // 这里统一降级为「已是最新」并带 reachable=false，让后台轮询安静地跳过。
    let versionInfo: any;
    try {
      const resp = await fetch(getUrl, { signal: AbortSignal.timeout(10000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      versionInfo = await resp.json();
    } catch (err: any) {
      return res.status(200).send(
        success({
          needUpdate: false,
          latestVersion: APP_VERSION,
          reinstall: false,
          time: 0,
          version: APP_VERSION,
          reachable: false,
          message: `无法连接更新服务器：${err?.message ?? "未知错误"}`,
        }),
      );
    }

    const { version: tagger, time, data } = versionInfo ?? {};
    // 清单结构不合预期时同样降级，避免 tagger.split / data[source] 直接抛。
    if (typeof tagger !== "string" || !data || typeof data !== "object") {
      return res.status(200).send(
        success({
          needUpdate: false,
          latestVersion: APP_VERSION,
          reinstall: false,
          time: 0,
          version: APP_VERSION,
          reachable: false,
          message: "更新清单格式不正确",
        }),
      );
    }

    const sourceData = data[source];
    if (!Array.isArray(sourceData)) return res.status(400).send(error("无法获取该源的下载信息"));

    const platformType: Record<string, string> = {
      win32: "windows",
      darwin: "macos",
      linux: "linux",
    };

    const zipItem = sourceData.find((d: any) => d.type === "zip");
    const installerItem = sourceData.find((d: any) => d.type === platformType[process.platform]);

    const noUpdate = success({ needUpdate: false, latestVersion: tagger, reinstall: false, time, version: tagger });
    const seg = diffSegment(parseVersion(tagger), parseVersion(APP_VERSION));

    // 版本相同，或远端反而更旧（回滚了清单 / 用户装了更新的内测包）→ 不提示
    if (seg === null || seg.remote < seg.local) return res.status(200).send(noUpdate);

    // 前两段（MAJOR/MINOR）变化意味着结构性升级，必须整包重装；
    // 后两段（PATCH/BUILD）走增量热更新。
    if (seg.index <= 1) {
      if (!installerItem) return res.status(400).send(error("该源暂无适用于当前系统的安装包"));
      return res
        .status(200)
        .send(success({ needUpdate: true, latestVersion: tagger, reinstall: true, time, url: installerItem.url, version: tagger }));
    }
    if (!zipItem) return res.status(400).send(error("该源暂无增量更新包"));
    return res.status(200).send(success({ needUpdate: true, latestVersion: tagger, reinstall: false, time, url: zipItem.url, version: tagger }));
  },
);
