/**
 * 把 data/vendor/*.ts 打包成 src/lib/vendor.json。
 *
 * 该 JSON 是内置供应商的**交付载体**：fixDB.ts 从它自动注册供应商并写出
 * <数据目录>/vendor/*.ts。只往 data/vendor/ 放文件是不够的——新用户装上
 * 不会有这个供应商，因为 fixDB 只认 vendor.json 里的条目。
 *
 * 所以新增或修改供应商后必须跑一次本脚本。
 */
import fs from "fs";
import path from "path";

const vendorDir = path.join("data", "vendor");
// 直接写到 fixDB.ts 实际 import 的位置。
// 早先版本输出到 data/vendor/vendor.json，与消费方 src/lib/vendor.json 不一致，
// 每次都得手动搬运，容易漏。
const outFile = path.join("src", "lib", "vendor.json");

const files = fs
  .readdirSync(vendorDir)
  .filter((f) => f.endsWith(".ts"))
  .sort(); // 排序保证输出稳定，避免文件系统顺序变化造成无谓 diff

const result: Record<string, string> = {};
for (const file of files) {
  // 统一成 LF：内容会被 fixDB 原样 fs.writeFileSync 到数据目录，
  // 若混入 CRLF，Node 模式下（数据目录即仓库的 data/vendor/）会把源文件
  // 重写成 CRLF，产生数千行纯换行符 diff 并冲掉 git blame。
  result[file] = fs.readFileSync(path.join(vendorDir, file), "utf-8").replace(/\r\n/g, "\n");
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(result, null, 2) + "\n", "utf-8");

const size = (fs.statSync(outFile).size / 1024).toFixed(0);
console.log(`✅ ${outFile}（${files.length} 个供应商，${size} KB）`);
console.log(`   ${files.map((f) => f.replace(/\.ts$/, "")).join(", ")}`);
