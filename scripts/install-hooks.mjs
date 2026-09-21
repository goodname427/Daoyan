/**
 * 启用仓库自带的 git hooks（无需 husky，不依赖 install 脚本）。
 *
 *   npm run hooks
 *
 * 只做一件事：git config core.hooksPath .githooks
 */
import { execSync } from 'node:child_process';
import { chmodSync, existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

if (!existsSync(resolve(root, '.git'))) {
  console.error('当前目录还不是 git 仓库，请先 git init');
  process.exit(1);
}

execSync('git config core.hooksPath .githooks', { cwd: root, stdio: 'inherit' });
for (const name of readdirSync(resolve(root, '.githooks'))) {
  chmodSync(resolve(root, '.githooks', name), 0o755);
}
console.log('✔ git hooks 已启用：.githooks/');
console.log('  pre-commit  → npm run verify');
console.log('  pre-push    → 复用匹配代码树/配置的完整门禁，否则 npm run verify:full');
console.log('  commit-msg  → 校验 Conventional Commits 格式');
