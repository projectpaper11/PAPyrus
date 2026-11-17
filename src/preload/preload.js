'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (cb) => {
  const h = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('papyrus', {
  app: {
    init: () => ipcRenderer.invoke('app:init'),
    openFolderDialog: () => ipcRenderer.invoke('app:openFolderDialog'),
    setProject: (p) => ipcRenderer.invoke('app:setProject', p),
    setTitle: (t) => ipcRenderer.invoke('app:setTitle', t),
    setSettings: (patch) => ipcRenderer.invoke('app:setSettings', patch),
    settingsPath: () => ipcRenderer.invoke('app:settingsPath'),
    reloadSettings: () => ipcRenderer.invoke('app:reloadSettings'),
    setTheme: (effective, source) => ipcRenderer.invoke('app:setTheme', { effective, source }),
    toggleDevTools: () => ipcRenderer.invoke('app:toggleDevTools'),
    openExternal: (u) => ipcRenderer.invoke('app:openExternal', u),
    reveal: (p) => ipcRenderer.invoke('app:reveal', p),
    newWindow: (project) => ipcRenderer.invoke('app:newWindow', project),
    setRecentProjects: (list) => ipcRenderer.invoke('app:setRecentProjects', list),
    confirm: (opts) => ipcRenderer.invoke('app:confirm', opts),
    onGoto: on('app:goto'),
    onOpenProject: on('app:openProject'),
    pathForFile: (f) => webUtils.getPathForFile(f),
  },
  fs: {
    listDir: (d, opts) => ipcRenderer.invoke('fs:listDir', d, opts),
    listAllFiles: (r) => ipcRenderer.invoke('fs:listAllFiles', r),
    exists: (p) => ipcRenderer.invoke('fs:exists', p),
    stat: (p) => ipcRenderer.invoke('fs:stat', p),
    readFile: (p) => ipcRenderer.invoke('fs:readFile', p),
    writeFile: (p, text, encoding) => ipcRenderer.invoke('fs:writeFile', { path: p, text, encoding }),
    createFile: (p, text) => ipcRenderer.invoke('fs:createFile', { path: p, text }),
    createFolder: (p) => ipcRenderer.invoke('fs:createFolder', p),
    rename: (from, to) => ipcRenderer.invoke('fs:rename', { from, to }),
    copy: (from, to) => ipcRenderer.invoke('fs:copy', { from, to }),
    trash: (p) => ipcRenderer.invoke('fs:trash', p),
    findInFiles: (root, query, opts) => ipcRenderer.invoke('fs:findInFiles', { root, query, opts }),
    onFindResult: on('fs:findResult'),
    watch: (root) => ipcRenderer.invoke('fs:watch', root),
    onChanged: on('fs:changed'),
  },
  lsp: {
    start: () => ipcRenderer.invoke('lsp:start'),
    stop: () => ipcRenderer.invoke('lsp:stop'),
    request: (method, params, token) => ipcRenderer.invoke('lsp:request', { method, params, token }),
    cancel: (token) => ipcRenderer.send('lsp:cancel', token),
    notify: (method, params) => ipcRenderer.send('lsp:notify', { method, params }),
    install: () => ipcRenderer.invoke('lsp:install'),
    restore: () => ipcRenderer.invoke('lsp:restore'),
    onNotification: on('lsp:notification'),
    onStatus: on('lsp:status'),
    onLog: on('lsp:log'),
  },
  update: {
    getState: () => ipcRenderer.invoke('update:getState'),
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install'),
    skip: (v) => ipcRenderer.invoke('update:skip', v),
    onState: on('update:state'),
  },
  setup: {
    status: () => ipcRenderer.invoke('setup:status'),
    installDotnet: () => ipcRenderer.invoke('setup:installDotnet'),
    installLsp: () => ipcRenderer.invoke('setup:installLsp'),
  },
  history: {
    file: (p) => ipcRenderer.invoke('history:file', p),
    content: (hash) => ipcRenderer.invoke('history:content', hash),
    recent: (limit) => ipcRenderer.invoke('history:recent', limit),
    label: (text) => ipcRenderer.invoke('history:label', text),
    changesSince: (t) => ipcRenderer.invoke('history:changesSince', t),
    revertTo: (t) => ipcRenderer.invoke('history:revertTo', t),
  },
  unity: {
    start: () => ipcRenderer.invoke('unity:start'),
    send: (cmd) => ipcRenderer.send('unity:send', cmd),
    mirrorPlace: (rect) => ipcRenderer.send('unity:mirrorPlace', rect),
    installPackage: () => ipcRenderer.invoke('unity:installPackage'),
    ensureAnalyzers: () => ipcRenderer.invoke('unity:ensureAnalyzers'),
    scanAssets: (root) => ipcRenderer.invoke('unity:scanAssets', root),
    projectData: (root) => ipcRenderer.invoke('unity:projectData', root),
    onMessage: on('unity:message'),
    onStatus: on('unity:status'),
  },
});
