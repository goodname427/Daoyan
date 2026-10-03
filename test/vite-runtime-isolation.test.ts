import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { expect, it } from 'vitest';
import config from '../vite.config';

it('watches source changes without watching isolated Electron caches or runtime evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'daoyan-vite-watch-'));
  const source = join(root, 'src', 'entry.ts');
  const cache = join(root, '.daoyan-agent', 'runs', 'profile', 'Code Cache');
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    await mkdir(join(root, 'src'));
    await mkdir(cache, { recursive: true });
    await writeFile(source, 'export const value = 1;');
    await writeFile(join(cache, 'temp-index'), 'cache');
    server = await createServer({
      configFile: false,
      root,
      plugins: [],
      server: { ...config.server, middlewareMode: true },
    });
    const watcher = server.watcher;
    const watchedPaths = () =>
      Object.entries(watcher.getWatched()).flatMap(([dir, files]) =>
        files.map((file) => join(dir, file)),
      );
    await expect.poll(() => watchedPaths().includes(source)).toBe(true);
    expect(watchedPaths().some((path) => path.includes('.daoyan-agent'))).toBe(false);

    const changes: string[] = [];
    watcher.on('change', (path) => changes.push(path.replaceAll('\\', '/')));
    await writeFile(join(cache, 'temp-index'), 'changed cache');
    await writeFile(source, 'export const value = 2;');
    await expect.poll(() => changes.includes(source.replaceAll('\\', '/'))).toBe(true);
    expect(changes.some((path) => path.includes('.daoyan-agent'))).toBe(false);
    expect(watchedPaths().some((path) => path.includes('.daoyan-agent'))).toBe(false);
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
