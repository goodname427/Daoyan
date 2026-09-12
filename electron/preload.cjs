/**
 * 预加载脚本。
 *
 * 只向渲染进程暴露一个能力：列出外部元法术文件。
 * 游戏逻辑（含外部扩展）全部跑在前端，核心层不依赖任何宿主 API。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('daoyanHost', {
  platform: process.platform,
  listMetaFiles: () => ipcRenderer.invoke('daoyan:listMetaFiles'),
});
