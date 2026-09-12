/**
 * 发版：升级版本号 + 用 Conventional Commits 生成 CHANGELOG + 打 tag。
 *
 *   npm run release -- patch     # 0.1.0 -> 0.1.1
 *   npm run release -- minor     # 0.1.0 -> 0.2.0
 *   npm run release -- major
 *   npm run release -- patch --dry
 *
 * 不做 git push，交由人工确认后再推。
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = resolve(root, 'package.json');
const changelogPath = resolve(root, 'CHANGELOG.md');

const bump = process.argv[2] ?? 'patch';
const dry = process.argv.includes('--dry');
if (!['patch', 'minor', 'major'].includes(bump)) {
  console.error('用法: npm run release -- <patch|minor|major> [--dry]');
  process.exit(1);
}

const run = (cmd) => execSync(cmd, { cwd: root, encoding: 'utf8' }).trim();

const GROUPS = [
  { type: 'feat', title: '新功能' },
  { type: 'fix', title: '修复' },
  { type: 'perf', title: '性能' },
  { type: 'refactor', title: '重构' },
  { type: 'docs', title: '文档' },
  { type: 'test', title: '测试' },
  { type: 'build', title: '构建' },
  { type: 'ci', title: 'CI' },
  { type: 'chore', title: '杂项' },
];

function currentVersion() {
  return JSON.parse(readFileSync(pkgPath, 'utf8')).version;
}

function nextVersion(v) {
  const [maj, min, pat] = v.split('.').map(Number);
  if (bump === 'major') return `${maj + 1}.0.0`;
  if (bump === 'minor') return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

function commitsSinceLastTag() {
  let range = '';
  try {
    const lastTag = run('git describe --tags --abbrev=0');
    range = `${lastTag}..HEAD`;
  } catch {
    range = 'HEAD';
  }
  const raw = run(`git log ${range} --pretty=format:%s`).split('\n').filter(Boolean);
  return raw.map((line) => {
    const m = /^([a-zA-Z]+)(\(([^)]+)\))?!?: (.*)$/.exec(line);
    if (!m) return { type: 'chore', scope: '', subject: line };
    return { type: m[1].toLowerCase(), scope: m[3] ?? '', subject: m[4] };
  });
}

function renderVersion(version, commits) {
  const date = new Date().toISOString().slice(0, 10);
  const lines = [`## ${version} (${date})`, ''];
  for (const g of GROUPS) {
    const items = commits.filter((c) => c.type === g.type);
    if (!items.length) continue;
    lines.push(`### ${g.title}`);
    for (const c of items) {
      lines.push(`- ${c.scope ? `**${c.scope}**: ` : ''}${c.subject}`);
    }
    lines.push('');
  }
  if (commits.length === 0) lines.push('- 无提交记录', '');
  return lines.join('\n');
}

const from = currentVersion();
const to = nextVersion(from);
const commits = commitsSinceLastTag();

console.log(`版本: ${from} → ${to}`);
console.log(`收录 ${commits.length} 条提交`);

if (dry) {
  console.log('\n--- CHANGELOG 预览 ---\n');
  console.log(renderVersion(to, commits));
  process.exit(0);
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.version = to;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

const old = readFileSync(changelogPath, 'utf8');
const marker = '# 更新日志';
const body = old.startsWith(marker) ? old.slice(marker.length).trimStart() : old;
writeFileSync(changelogPath, `${marker}\n\n${renderVersion(to, commits)}\n${body}`);

run('git add package.json CHANGELOG.md');
run(`git commit -m "chore(release): v${to}"`);
run(`git tag -a v${to} -m "v${to}"`);

console.log(`\n✔ 已发版 v${to}，并打上标签 v${to}`);
console.log('  确认无误后执行: git push && git push --tags');
