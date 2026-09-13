import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const required = [
  'AGENTS.md',
  'CONTRIBUTING.md',
  'README.md',
  'CHANGELOG.md',
  'docs/README.md',
  'docs/status.md',
  'docs/workflow.md',
  'docs/testing.md',
  'docs/product/vision.md',
  'docs/product/core-loop.md',
  'docs/reference/spell-authoring.md',
  'docs/reference/meta-spells.md',
  'docs/reference/entities-and-attributes.md',
  'docs/proposals/meta-spell-and-entity-model-vnext.md',
  'docs/architecture/overview.md',
  'docs/architecture/invariants.md',
  'docs/specs/README.md',
  'docs/specs/template.md',
  '.codebuddy/memory/MEMORY.md',
];

function markdownFiles(path) {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) return markdownFiles(child);
    return extname(entry.name) === '.md' ? [child] : [];
  });
}

const errors = [];
for (const path of required) {
  if (!existsSync(resolve(root, path))) errors.push(`缺少必需文档: ${path}`);
}

const files = [
  resolve(root, 'README.md'),
  resolve(root, 'AGENTS.md'),
  resolve(root, 'CONTRIBUTING.md'),
  resolve(root, 'CHANGELOG.md'),
  ...markdownFiles(resolve(root, 'docs')),
  ...markdownFiles(resolve(root, '.codebuddy/memory')),
].filter(existsSync);

for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const links = source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g);
  for (const match of links) {
    const raw = match[1].trim().replace(/^<|>$/g, '');
    if (!raw || raw.startsWith('#') || /^(?:https?:|mailto:|codex:)/.test(raw)) continue;
    const target = decodeURIComponent(raw.split('#')[0]);
    const absolute = resolve(dirname(file), target);
    if (!existsSync(absolute)) errors.push(`${file.slice(root.length + 1)}: 无效链接 ${raw}`);
  }

  for (const match of source.matchAll(/npm run ([a-zA-Z0-9:_-]+)/g)) {
    const script = match[1];
    const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    if (!packageJson.scripts?.[script]) {
      errors.push(`${file.slice(root.length + 1)}: 不存在 npm script ${script}`);
    }
  }
}

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));
const changelog = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');
const latest = /^## (\d+\.\d+\.\d+)/m.exec(changelog)?.[1];
if (!latest) errors.push('CHANGELOG.md 中找不到最新版本号');
if (latest && pkg.version !== latest) {
  errors.push(`版本不一致: package.json=${pkg.version}, CHANGELOG.md=${latest}`);
}
if (lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) {
  errors.push('package-lock.json 与 package.json 版本不一致');
}
if (pkg.scripts?.['verify:ci'] !== 'npm run verify:full') {
  errors.push('verify:ci 必须直接复用 verify:full');
}

const ci = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');
if (!ci.includes('branches: [master]')) errors.push('CI 未监听 master 分支');
if (!ci.includes("tags: ['v*']")) errors.push('CI 未监听版本 tag');
if (!ci.includes('run: npm run verify:ci')) errors.push('CI 未使用统一完整门禁');

for (const file of files) {
  if (!statSync(file).isFile()) errors.push(`文档路径不是文件: ${file}`);
}

if (errors.length > 0) {
  console.error(`文档检查失败（${errors.length} 项）:`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`文档检查通过：${files.length} 个 Markdown 文件，版本 ${pkg.version}`);
