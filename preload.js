'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('icc', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  setName: (name) => ipcRenderer.invoke('set-name', name),
});
