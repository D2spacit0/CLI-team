const { contextBridge, ipcRenderer } = require('electron');
window.addEventListener('DOMContentLoaded', () => ipcRenderer.send('desktop:preload-ready'), { once: true });

contextBridge.exposeInMainWorld('cliTeamDesktop', Object.freeze({
  getInfo: () => ipcRenderer.invoke('desktop:get-info'),
  selectWorkspace: () => ipcRenderer.invoke('desktop:select-workspace'),
  openWorkspace: () => ipcRenderer.invoke('desktop:open-workspace'),
  onBeforeLeave: (save, resume) => {
    let activeRequestId;
    const listener = async (_event, requestId) => {
      if (typeof requestId !== 'string') return;
      activeRequestId = requestId;
      let saved = false;
      try { saved = (await save()) === true; } catch { /* The host keeps the window open on failure. */ }
      if (activeRequestId === requestId) ipcRenderer.send('desktop:leave-ready', requestId, saved);
    };
    const cancelled = (_event, requestId) => {
      if (requestId !== activeRequestId) return;
      activeRequestId = undefined;
      resume();
    };
    ipcRenderer.on('desktop:prepare-leave', listener);
    ipcRenderer.on('desktop:cancel-leave', cancelled);
    return () => {
      activeRequestId = undefined;
      ipcRenderer.removeListener('desktop:prepare-leave', listener);
      ipcRenderer.removeListener('desktop:cancel-leave', cancelled);
    };
  },
}));
