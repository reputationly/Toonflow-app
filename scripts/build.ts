import esbuild from "esbuild";
import fs from "fs";
import path from "path";

// 打包默认使用 prod 环境变量
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = "prod";
}

const pkg = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));

// 客户端自报版本。默认取 package.json，但允许用 APP_VERSION 覆盖成四段式
// （如 1.1.8.1）——前三段与上游 Toonflow 对齐，第四段是本仓的定制迭代号。
// 之所以不直接写进 package.json：electron-builder 校验 semver，
// 四段版本会以 `Invalid version: "1.1.8.1"` 直接构建失败。
// 比较逻辑见 src/routes/setting/about/checkUpdate.ts 的 parseVersion。
const appVersion = process.env.APP_VERSION || pkg.version;

const external = [
  "electron",
  "@huggingface/transformers",
  "onnxruntime-node",
  "vm2",
  "better-sqlite3",
  // sqlite3 已从 dependencies 移除（项目用 better-sqlite3，它只是 @rmp135/sql-ts
  // 的可选 peer，且在 Windows ARM64 上没有预编译包、需现场 node-gyp 编译而构建失败）。
  // 但仍须留在 external：knex 的 sqlite3 方言里有静态 require('sqlite3')，
  // 不标 external 的话 esbuild 解析不到会直接报错。mysql / pg / oracledb 同理。
  "sqlite3",
  "sharp",
  "mysql",
  "mysql2",
  "pg",
  "pg-query-stream",
  "oracledb",
  "tedious",
  "mssql",
];

// 后端服务打包配置
const appBuildConfig: esbuild.BuildOptions = {
  entryPoints: ["src/app.ts"],
  bundle: true,
  minify: false,
  format: "cjs",
  allowOverwrite: true,
  outfile: `data/serve/app.js`,
  platform: "node",
  target: "esnext",
  tsconfig: "./tsconfig.json",
  alias: {
    "@": "./src",
  },
  sourcemap: false,
  external,
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
};

// Electron 主进程打包配置
const mainBuildConfig: esbuild.BuildOptions = {
  entryPoints: ["scripts/main.ts"],
  bundle: true,
  minify: false,
  format: "cjs",
  outfile: `build/main.js`,
  allowOverwrite: true,
  platform: "node",
  target: "esnext",
  tsconfig: "./tsconfig.json",
  alias: {
    "@": "./src",
  },
  sourcemap: false,
  external,
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
};

(async () => {
  try {
    console.log("🔨 开始构建...\n");

    // 并行构建
    await Promise.all([esbuild.build(appBuildConfig), esbuild.build(mainBuildConfig)]);

    console.log("✅ 后端服务构建完成: build/app.js");
    console.log("✅ Electron主进程构建完成: build/main.js");
    console.log("\n🎉 所有构建任务完成!\n");
  } catch (err) {
    console.error("❌ 构建失败:", err);
    process.exit(1);
  }
})();
