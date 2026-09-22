const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('orrDesktop', {
  platform: process.platform,
  getWorkspace: () => ipcRenderer.invoke('workspace:get'),
  openWorkspace: () => ipcRenderer.invoke('workspace:open'),
  createWorkspace: () => ipcRenderer.invoke('workspace:create'),
});
