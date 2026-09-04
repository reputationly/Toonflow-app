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

    const taggerList = tagger.split(".").map(Number);
    const currentVersionList = APP_VERSION.split(".").map(Number);
    //对比Major
    if (taggerList[0] > currentVersionList[0]) {
      if (!installerItem) return res.status(400).send(error("该源暂无适用于当前系统的安装包"));
      return res
        .status(200)
        .send(success({ needUpdate: true, latestVersion: tagger, reinstall: true, time, url: installerItem.url, version: tagger }));
    }
    //对比Minor
    if (taggerList[1] > currentVersionList[1]) {
      if (!installerItem) return res.status(400).send(error("该源暂无适用于当前系统的安装包"));
      return res
        .status(200)
        .send(success({ needUpdate: true, latestVersion: tagger, reinstall: true, time, url: installerItem.url, version: tagger }));
    }
    //Patch
    if (taggerList[2] > currentVersionList[2]) {
      if (!zipItem) return res.status(400).send(error("该源暂无增量更新包"));
      return res.status(200).send(success({ needUpdate: true, latestVersion: tagger, reinstall: false, time, url: zipItem.url, version: tagger }));
    }
    return res.status(200).send(success({ needUpdate: false, latestVersion: tagger, reinstall: false, time, version: tagger }));
  },
);
