/**
 * 预加载脚本。当前不向渲染进程暴露任何 Node 能力——
 * 游戏逻辑全部跑在前端，保持「核心不依赖宿主」的约束。
 */
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('daoyan', {
  platform: process.platform,
});
