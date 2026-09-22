const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('orrDesktop', {
  platform: process.platform,
  getWorkspace: () => ipcRenderer.invoke('workspace:get'),
  openWorkspace: () => ipcRenderer.invoke('workspace:open'),
  createWorkspace: (setup) => ipcRenderer.invoke('workspace:create', setup),
  onCreateWorkspaceRequested: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('workspace:request-create', listener);
    return () => ipcRenderer.removeListener('workspace:request-create', listener);
  },
});
