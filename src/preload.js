// 悬浮课表 · preload：向渲染层暴露白名单 API
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  version: process.versions.electron,
  load: () => ipcRenderer.invoke('store:load'),
  save: (data) => ipcRenderer.invoke('store:save', data),
  quit: () => ipcRenderer.invoke('app:quit'),
  setAutoStart: (v) => ipcRenderer.invoke('app:set-autostart', v),
  getAutoStart: () => ipcRenderer.invoke('app:get-autostart'),
});
