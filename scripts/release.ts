/**
 * 发版脚本：自动计算下一个定制迭代号并打 tag 推送。
 *
 *   yarn release            # 递增第四段（.BUILD），日常发自有修复用这个
 *   yarn release --dry      # 只打印将要做什么，不实际操作
 *   yarn release --yes      # 跳过确认（CI 或你很确定时）
 *
 * 版本号规则见 docs/技术评估与开发环境搭建.md §8.6：
 *   MAJOR.MINOR.PATCH  与上游 Toonflow 一致，取自 package.json
 *   .BUILD             本仓定制迭代号，由本脚本递增
 *
 * 同步上游新版本时，先手动改 package.json 的 version，再跑本脚本——
 * 它会发现该三段号下还没有任何 tag，从 .1 重新开始。
 */
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import readline from "readline";

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const YES = args.includes("--yes");

function sh(cmd: string): string {
  return execSync(cmd, { encoding: "utf8" }).trim();
}

function die(msg: string): never {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

// ── 1. 前置检查 ───────────────────────────────────────────────
// tag 指向的是当前 HEAD，所以工作区必须干净、且已推送到远端，
// 否则 CI 检出 tag 时拿到的代码和你本地看到的不是一回事。
const dirty = sh("git status --porcelain --untracked-files=no");
if (dirty) die(`工作区有未提交改动，请先提交或还原：\n${dirty}`);

const branch = sh("git rev-parse --abbrev-ref HEAD");
sh("git fetch --tags --quiet origin");

const local = sh("git rev-parse HEAD");
let remote = "";
try {
  remote = sh(`git rev-parse origin/${branch}`);
} catch {
  die(`远端没有分支 origin/${branch}，请先 git push -u origin ${branch}`);
}
if (local !== remote) {
  die(`本地 ${branch} 与 origin/${branch} 不同步（本地 ${local.slice(0, 7)} / 远端 ${remote.slice(0, 7)}），请先 git push`);
}

// ── 2. 计算下一个版本号 ────────────────────────────────────────
const pkgPath = path.resolve("package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const base: string = pkg.version;
if (!/^\d+\.\d+\.\d+$/.test(base)) {
  die(`package.json 的 version 必须是三段 semver，当前是 "${base}"。\nelectron-builder 不接受四段版本，定制迭代号请交给本脚本处理。`);
}

// 收集该三段号下已有的 tag（含 v1.1.8 与 v1.1.8.N 两种形态），取最大的 .BUILD
const escaped = base.replace(/\./g, "\\.");
const re = new RegExp(`^v${escaped}(?:\\.(\\d+))?$`);
const builds = sh("git tag --list")
  .split("\n")
  .map((t) => t.trim().match(re))
  .filter((m): m is RegExpMatchArray => m !== null)
  .map((m) => (m[1] ? Number.parseInt(m[1], 10) : 0));

const nextBuild = builds.length ? Math.max(...builds) + 1 : 1;
const version = `${base}.${nextBuild}`;
const tag = `v${version}`;

if (sh("git tag --list").split("\n").includes(tag)) {
  die(`tag ${tag} 已存在。若要重发，请先删除：\n  git tag -d ${tag} && git push origin :refs/tags/${tag}`);
}

// ── 3. 展示并确认 ─────────────────────────────────────────────
const subject = sh("git log -1 --pretty=%s");
const shortSha = local.slice(0, 7);
console.log(`
  上游基线    ${base}   (package.json)
  已有迭代号  ${builds.length ? builds.sort((a, b) => a - b).join(", ") : "（无）"}
  ────────────────────────────────
  即将发布    ${tag}
  提交        ${shortSha}  ${subject}
  分支        ${branch}
`);
console.log("  发布后 CI 会：构建 4 个安装包 → 发 GitHub Release → 传 R2 并更新 update.json");
console.log("  已装机用户将通过增量包（约 35 MB）自动热更新。\n");

if (DRY) {
  console.log("  --dry 模式，未做任何操作。\n");
  process.exit(0);
}

async function confirm(): Promise<boolean> {
  if (YES) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(`  确认发布 ${tag}？(y/N) `, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

(async () => {
  if (!(await confirm())) {
    console.log("\n  已取消。\n");
    process.exit(0);
  }
  const message = `${tag}\n\n基于上游 Toonflow ${base}，第 ${nextBuild} 个定制迭代。\n\n${subject}`;
  execSync(`git tag -a ${tag} -m ${JSON.stringify(message)}`, { stdio: "inherit" });
  execSync(`git push origin ${tag}`, { stdio: "inherit" });
  const repo = sh("git remote get-url origin")
    .replace(/^git@github\.com:/, "")
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/\.git$/, "");
  console.log(`\n✅ 已发布 ${tag}`);
  console.log(`   进度：https://github.com/${repo}/actions\n`);
})();
