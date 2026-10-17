// Exposes the few actions the block screen needs, nothing more.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('focuslock', {
  startMeditation: () => ipcRenderer.invoke('fl:start-meditation'),
  startBreak: () => ipcRenderer.invoke('fl:start-break'),
  startPass: () => ipcRenderer.invoke('fl:start-pass'),
  close: () => ipcRenderer.invoke('fl:close'),
});
