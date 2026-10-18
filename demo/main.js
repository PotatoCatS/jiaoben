// ============================================================================
// demo/main.js —— jiaoben 最小 Electron 演示应用（普通窗口款）
// ============================================================================
// 跑法（用宿主工程里的 electron）：
//   E:\Scode\pet-sq\node_modules\.bin\electron.cmd E:\Scode\jiaoben\demo\main.js
// 数据目录默认 demo\data（已 gitignore），可用环境变量 JB_DATA 换。
// ============================================================================

import { app, BrowserWindow, Menu, ipcMain, dialog, shell, clipboard } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerJiaobenIpc } from '../electron/ipc.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.JB_DATA || path.join(HERE, 'data')

let win = null
let jb = null

app.whenReady().then(() => {
  Menu.setApplicationMenu(null)
  win = new BrowserWindow({
    width: 920,
    height: 660,
    title: 'jiaoben 脚本管理器（演示）',
    backgroundColor: '#f4f5f7',
    webPreferences: {
      preload: path.join(HERE, '..', 'electron', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  win.loadFile(path.join(HERE, 'app.html'))

  jb = registerJiaobenIpc({
    ipcMain: ipcMain,
    dialog: dialog,
    shell: shell,
    clipboard: clipboard,
    dataDir: DATA_DIR,
    log: (msg) => console.log('[demo] ' + msg),
    send: (channel, payload) => {
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
    },
    getWindow: () => win,
  })
  jb.start()
  console.log('[demo] 数据目录: ' + DATA_DIR)
})

app.on('window-all-closed', () => {
  app.quit()
})

// 退出前把脚本子进程全部收掉（长驻/定时脚本不能变孤儿）
let stopped = false
app.on('will-quit', (e) => {
  if (stopped) return
  e.preventDefault()
  Promise.resolve(jb ? jb.stopAll() : null)
    .catch((err) => console.log('[demo] 收尾出错: ' + err))
    .finally(() => {
      stopped = true
      app.quit()
    })
})
