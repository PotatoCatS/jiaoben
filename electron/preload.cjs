// ============================================================================
// electron/preload.js —— 渲染进程 ⇄ 主进程的安全桥（sandbox 兼容，只暴露 jiaoben 面板）
// ============================================================================
// 面板里用 window.jiaoben.* 调用；日志订阅 window.jiaoben.onScriptLog(cb)。
// 频道名与 electron/ipc.mjs 一一对应（jb: 前缀）。
// ============================================================================

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('jiaoben', {
  /** 面板数据：{ ok, dir, items, python, pythonPath }，items 里带 exists/running/instances/alarm/nextRun/cronError */
  configGet: () => ipcRenderer.invoke('jb:script-config-get'),
  dirSet: () => ipcRenderer.invoke('jb:script-dir-set'),
  save: (input) => ipcRenderer.invoke('jb:script-save', input),
  remove: (id, deleteFile) => ipcRenderer.invoke('jb:script-remove', id, !!deleteFile),
  read: (id) => ipcRenderer.invoke('jb:script-read', id),
  write: (id, code) => ipcRenderer.invoke('jb:script-write', id, code),
  run: (id) => ipcRenderer.invoke('jb:script-run', id),
  stop: (id, inst) => ipcRenderer.invoke('jb:script-stop', id, inst),
  logHistory: (id) => ipcRenderer.invoke('jb:script-log-history', id),
  pythonCheck: () => ipcRenderer.invoke('jb:script-python-check'),
  rescan: () => ipcRenderer.invoke('jb:script-rescan'),
  clone: (id) => ipcRenderer.invoke('jb:script-clone', id),
  rename: (id, newBase) => ipcRenderer.invoke('jb:script-rename', id, newBase),
  openDir: () => ipcRenderer.invoke('jb:script-open-dir'),
  /** 定时/启动方式配置 + cron 预览 + Python 自填路径 */
  schedule: (id, opts) => ipcRenderer.invoke('jb:script-schedule', id, opts),
  cronPreview: (expr) => ipcRenderer.invoke('jb:script-cron-preview', expr),
  pythonSetPath: (p) => ipcRenderer.invoke('jb:script-python-set-path', p),
  pythonClear: () => ipcRenderer.invoke('jb:script-python-clear'),
  /** 导入 / 粘贴 / 示例 / VS Code 打开 */
  importFiles: () => ipcRenderer.invoke('jb:script-import'),
  openEditor: (id) => ipcRenderer.invoke('jb:script-open-editor', id),
  clipboardRead: () => ipcRenderer.invoke('jb:clipboard-read'),
  /** 收纳管理（阶段四）：候选扫描 / 收编 / 不收编名单 / 开关 / 分组 / 停用 */
  scanCandidates: () => ipcRenderer.invoke('jb:script-scan-candidates'),
  adopt: (files) => ipcRenderer.invoke('jb:script-adopt', files),
  ignore: (files) => ipcRenderer.invoke('jb:script-ignore', files),
  unexclude: (file) => ipcRenderer.invoke('jb:script-unexclude', file),
  excludedList: () => ipcRenderer.invoke('jb:script-excluded-list'),
  optsGet: () => ipcRenderer.invoke('jb:script-opts-get'),
  optsSet: (patch) => ipcRenderer.invoke('jb:script-opts-set', patch),
  groupList: () => ipcRenderer.invoke('jb:script-group-list'),
  groupCreate: (name) => ipcRenderer.invoke('jb:script-group-create', name),
  groupRename: (id, name) => ipcRenderer.invoke('jb:script-group-rename', id, name),
  groupRemove: (id) => ipcRenderer.invoke('jb:script-group-remove', id),
  groupMove: (scriptId, groupId) => ipcRenderer.invoke('jb:script-group-move', scriptId, groupId),
  setEnabled: (id, on) => ipcRenderer.invoke('jb:script-enabled', id, !!on),
  /** 示例库（可增删改查） */
  exList: () => ipcRenderer.invoke('jb:ex-list'),
  exRead: (id) => ipcRenderer.invoke('jb:ex-read', id),
  exCreate: (input, autoRename) => ipcRenderer.invoke('jb:ex-create', input, !!autoRename),
  exUpdate: (id, input) => ipcRenderer.invoke('jb:ex-update', id, input),
  exRemove: (id) => ipcRenderer.invoke('jb:ex-remove', id),
  exImport: (id) => ipcRenderer.invoke('jb:ex-import', id),
  /** 脚本输出（主进程 → 渲染进程，100ms 批量推送） */
  onScriptLog: (cb) =>
    ipcRenderer.on('jb:script-log', (_e, batch) => {
      try {
        cb(batch)
      } catch (err) {}
    }),
  /** 自动收纳收编了新脚本（主进程 → 渲染进程，面板开着时刷新列表） */
  onAdopted: (cb) =>
    ipcRenderer.on('jb:script-adopted', (_e, payload) => {
      try {
        cb(payload)
      } catch (err) {}
    }),
})
