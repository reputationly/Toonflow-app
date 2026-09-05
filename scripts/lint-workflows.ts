/**
 * workflow 防呆检查。
 *
 * actionlint 负责语法、表达式引用、shellcheck；本脚本补的是它查不到的
 * **项目特有语义规则**——每条都对应一次真实踩过的坑，避免重蹈覆辙。
 *
 *   yarn lint:workflows
 *
 * 与 actionlint 一起在 CI 的 workflow-check 里跑。
 */
import fs from "fs";
import path from "path";

interface Finding {
  file: string;
  line: number;
  rule: string;
  message: string;
}

/**
 * 有意为之的例外，用注释显式标注：
 *
 *   # lint-workflows-allow: always-needs-failure-guard  理由写在这里
 *
 * 要求写理由，避免变成无脑消音。作用范围是所在的 job 或 step 块。
 */
function isAllowed(block: string, rule: string): boolean {
  return new RegExp(`#\\s*lint-workflows-allow:\\s*${rule}\\b`).test(block);
}

const dir = path.join(".github", "workflows");
const findings: Finding[] = [];

function check(file: string, lines: string[]): void {
  const text = lines.join("\n");

  // ── 规则 1：fork 仓库里 gh 命令必须显式 --repo ──────────────────
  // 踩坑：gh 在 fork 里默认把 PR / issue 提到 parent（HBAI-Ltd/Toonflow-app），
  // 而 GITHUB_TOKEN 对上游无写权限，报 "Resource not accessible by integration"。
  // 只在 CI 跑起来后才暴露，本地无法复现。
  lines.forEach((line, i) => {
    const m = line.match(/\bgh\s+(pr|issue|release|workflow|api)\b/);
    if (!m) return;
    if (/--repo\b/.test(line)) return;
    // 抑制注释可写在同行或前一行
    if (isAllowed(line + "\n" + (lines[i - 1] ?? ""), "gh-needs-repo")) return;
    // gh api 用完整路径 repos/owner/name 时不需要 --repo
    if (m[1] === "api" && /\brepos\//.test(line)) return;
    findings.push({
      file,
      line: i + 1,
      rule: "gh-needs-repo",
      message: `gh ${m[1]} 缺少 --repo。本仓是 fork，gh 默认会操作上游仓库而非本仓`,
    });
  });

  // ── 规则 2：用了 always() 的 job 必须排除 needs 失败 ─────────────
  // 踩坑：always() 不只是"跳过时也跑"，它会覆盖 needs 的成功门槛，
  // 连 failure 也放行。曾导致某平台构建失败仍覆盖生产 update.json。
  const jobBlocks = text.split(/\n(?=  [\w-]+:\n)/);
  for (const block of jobBlocks) {
    const ifLine = block.match(/^\s*if:\s*(.+)$/m);
    if (!ifLine || !/always\(\)/.test(ifLine[1])) continue;
    if (/needs\.\*\.result|needs\.[\w-]+\.result/.test(ifLine[1])) continue;
    if (isAllowed(block, "always-needs-failure-guard")) continue;
    const jobName = block.match(/^\s{2}([\w-]+):/)?.[1] ?? "?";
    const lineNo = lines.findIndex((l) => l.includes(ifLine[1].slice(0, 40))) + 1;
    findings.push({
      file,
      line: lineNo,
      rule: "always-needs-failure-guard",
      message: `job "${jobName}" 的 if 用了 always() 但未排除 needs 失败。always() 会放行失败的依赖，请加 !contains(needs.*.result, 'failure')`,
    });
  }

  // ── 规则 3：aws cli 访问 R2 必须关闭 checksum ───────────────────
  // 踩坑：aws cli v2 默认发送 CRC32 尾部校验，R2 不支持，直接 501。
  const usesAwsOnR2 = /aws s3/.test(text) && /r2\.cloudflarestorage\.com/.test(text);
  if (usesAwsOnR2) {
    const stepBlocks = text.split(/\n(?=      - name:)/);
    for (const block of stepBlocks) {
      if (!/aws s3/.test(block)) continue;
      if (/AWS_REQUEST_CHECKSUM_CALCULATION/.test(block)) continue;
      if (isAllowed(block, "r2-checksum-env")) continue;
      const stepName = block.match(/- name:\s*(.+)/)?.[1]?.trim() ?? "?";
      const lineNo = lines.findIndex((l) => l.includes(`- name: ${stepName}`)) + 1;
      findings.push({
        file,
        line: lineNo,
        rule: "r2-checksum-env",
        message: `步骤 "${stepName}" 对 R2 用 aws s3 但未设 AWS_REQUEST_CHECKSUM_CALCULATION=when_required。aws cli v2 默认的 CRC32 尾部校验会让 R2 返回 501`,
      });
    }
  }
}

if (!fs.existsSync(dir)) {
  console.log("没有 .github/workflows 目录，跳过");
  process.exit(0);
}

const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
for (const f of files) {
  check(path.join(dir, f), fs.readFileSync(path.join(dir, f), "utf-8").split("\n"));
}

if (findings.length === 0) {
  console.log(`✅ workflow 防呆检查通过（${files.length} 个文件，3 条规则）`);
  process.exit(0);
}

console.error(`\n❌ 发现 ${findings.length} 处问题：\n`);
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}  [${f.rule}]`);
  console.error(`     ${f.message}\n`);
}
process.exit(1);
