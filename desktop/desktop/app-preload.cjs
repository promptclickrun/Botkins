// HTML apps use window.botkins. Saved apps can also use the earlier bridge names.
const { contextBridge, ipcRenderer } = require("electron");
const bridge = {
  getData: () => ipcRenderer.invoke("app:data"),
  onData: (fn) => {
    const listener = (_event, data) => fn(data);
    ipcRenderer.on("app:data", listener);
    return () => ipcRenderer.removeListener("app:data", listener);
  },
  sendAnswer: (answer) => ipcRenderer.invoke("app:answer", String(answer)),
  close: () => ipcRenderer.invoke("app:close"),
};
contextBridge.exposeInMainWorld("botkins", bridge);
contextBridge.exposeInMainWorld("commander", bridge);
contextBridge.exposeInMainWorld("bighelp", bridge);
