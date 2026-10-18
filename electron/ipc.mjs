// ============================================================================
// electron/ipc.mjs —— 路线 A 适配层：把 jiaoben 引擎接成 Electron IPC 处理器
// ============================================================================
// 用法（宿主 main.js）：
//   import { registerJiaobenIpc, SCRIPT_LOG_CHANNEL } from 'jiaoben/electron'
//   const jb = registerJiaobenIpc({
//     ipcMain, dialog, shell, clipboard,   // electron 模块（注入，不在这里 import）
//     dataDir: DATA_DIR,                  // 数据目录（花名册/心跳/示例库）
//     log: (msg) => {},                   // 宿主日志
//     send: (channel, payload) => win.webContents.send(channel, payload),
//     getWindow: () => win,               // 选目录对话框的父窗口
//   })
//   app.whenReady().then(() => jb.start())
//   app.on('before-quit', ... await jb.stopAll())
//
// 频道清单（全部 jb: 前缀，共 28 个 invoke + 1 个 push）：
//   面板：script-config-get / python-check / dir-set / save / remove / read / write
//         / run / schedule / cron-preview / python-set-path / python-clear / stop
//         / log-history / status / open-dir / rescan / clone / rename / import
//         / open-editor / clipboard-read
//   示例库：ex-list / ex-read / ex-create / ex-update / ex-remove / ex-import
//   push：jb:script-log（批量日志，攒 100ms 发一批）
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import {
  parseCron,
  cronNextParsed,
  detectPython,
  probePython,
  createScriptsStore,
  createScriptRunner,
  createScriptScheduler,
} from '../src/scripts.mjs'
import { createExamplesStore } from '../src/examples.mjs'

export const SCRIPT_LOG_CHANNEL = 'jb:script-log'

export function registerJiaobenIpc(opts) {
  opts = opts || {}
  const ipcMain = opts.ipcMain
  const dialog = opts.dialog
  const shell = opts.shell
  const clipboard = opts.clipboard
  const dataDir = opts.dataDir
  const log = opts.log || function () {}
  const send = opts.send || function () {}
  const getWindow = opts.getWindow || function () { return null }

  const store = createScriptsStore({ dataDir: dataDir, log: log })
  const exStore = createExamplesStore({ dataDir: dataDir, log: log })

  /** Python 检测结果（null=还没检测过）；失败后可在面板里触发重检 */
  let pythonInfo = null
  let pythonChecking = null

  const runner = createScriptRunner({
    store: store,
    log: log,
    getPython: function () {
      return pythonInfo && pythonInfo.ok ? [pythonInfo.cmd].concat(pythonInfo.args || []) : null
    },
    sendLog: function (batch) {
      send(SCRIPT_LOG_CHANNEL, batch)
    },
  })

  let scheduler = null

  // ---------- 面板数据 ----------
  ipcMain.handle('jb:script-config-get', () => {
    if (!store) return { ok: false, error: 'not-ready', dir: null, items: [] }
    const cfg = store.read()
    const run = runner ? runner.status() : {}
    const items = cfg.items.map((it) => {
      let exists = false
      if (cfg.dir) {
        try {
          exists = fs.existsSync(path.join(cfg.dir, it.file))
        } catch (err) {}
      }
      const instances = run[it.id] || []
      const alarm = scheduler ? scheduler.getAlarm(it.id) : null
      let nextRun = null
      let cronError = null
      if (it.cron) {
        const parsed = parseCron(it.cron)
        if (!parsed.ok) cronError = parsed.error
        else {
          const nx = cronNextParsed(parsed, Date.now())
          if (nx.ok) nextRun = nx.time
          else cronError = nx.error
        }
      }
      return { ...it, exists, running: instances.length, instances, alarm, nextRun, cronError }
    })
    return { ok: true, dir: cfg.dir, items, python: pythonInfo, pythonPath: cfg.pythonPath }
  })

  // ---------- Python ----------
  ipcMain.handle('jb:script-python-check', async () => {
    // 重检：失败后装好 Python 再来点一次；成功的结果直接复用（避免每次开面板都跑探测）
    if (pythonInfo && pythonInfo.ok) return { ok: true, python: pythonInfo }
    if (!pythonChecking) {
      pythonChecking = detectPython({ log })
        .then((res) => {
          pythonInfo = res
          return res
        })
        .finally(() => {
          pythonChecking = null
        })
    }
    const res = await pythonChecking
    return { ok: true, python: res }
  })
  // 自填路径：必须通过 --version 验证才落盘，避免存一个跑不动的路径
  ipcMain.handle('jb:script-python-set-path', async (_e, p) => {
    const clean = String(p == null ? '' : p).trim()
    if (!clean) return { ok: false, error: '路径不能为空' }
    const probed = await probePython(clean)
    if (!probed.ok) return { ok: false, error: '这个路径不是可用的 Python（没通过 --version 验证）' }
    store.setPythonPath(clean)
    pythonInfo = { ok: true, cmd: clean, args: [], version: probed.version, custom: true }
    log('[jb] Python 自填路径: ' + clean + '（' + probed.version + '）')
    return { ok: true, python: pythonInfo }
  })
  ipcMain.handle('jb:script-python-clear', async () => {
    store.clearPythonPath()
    // 清掉自填后回到自动检测
    if (!pythonChecking) {
      pythonChecking = detectPython({ log })
        .then((res) => {
          pythonInfo = res
          return res
        })
        .finally(() => {
          pythonChecking = null
        })
    }
    const res = await pythonChecking
    return { ok: true, python: res }
  })

  // ---------- 目录 ----------
  ipcMain.handle('jb:script-dir-set', async () => {
    const win = getWindow()
    if (!win || win.isDestroyed()) return { ok: false, error: '窗口不可用' }
    const res = await dialog.showOpenDialog(win, {
      title: '选择脚本存放目录',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (res.canceled || !res.filePaths || !res.filePaths.length) return { ok: false, error: 'cancelled' }
    const cfg = store.setDir(res.filePaths[0])
    log('[jb] 脚本目录: ' + cfg.dir)
    // 换目录后自动收编新目录一级的 .js/.py
    const scan = store.rescan()
    if (!scan.ok) log('[jb] 换目录后自动扫描失败: ' + (scan.error || ''))
    if (scan.ok && scan.added && scan.added.length) log('[jb] 换目录后自动收编 ' + scan.added.length + ' 个脚本')
    return { ok: true, dir: cfg.dir, adopted: scan.ok ? (scan.added ? scan.added.length : 0) : 0 }
  })
  ipcMain.handle('jb:script-open-dir', () => {
    const dir = store ? store.read().dir : null
    if (!dir) return { ok: false, error: '请先选择脚本目录' }
    shell.openPath(dir)
    return { ok: true }
  })

  // ---------- 花名册 ----------
  ipcMain.handle('jb:script-save', (_e, input) => {
    if (!store.read().dir) return { ok: false, error: '请先选择脚本目录' }
    const res = store.save(input)
    if (res.ok) log('[jb] 已保存：' + res.item.name + '（' + res.item.lang + '）')
    return res
  })
  ipcMain.handle('jb:script-remove', (_e, id, deleteFile) => {
    const res = store.remove(id, !!deleteFile)
    if (res.ok) log('[jb] 已删除 ' + id + (res.deletedFile ? '（含文件）' : ''))
    return res
  })
  // 重新扫描：目录里新放进去的 .js/.py（一级）收编进花名册；旧条目只标「找不到文件」不删
  ipcMain.handle('jb:script-rescan', () => {
    const res = store.rescan()
    if (res.ok) {
      log(
        '[jb] 重新扫描：新收编 ' +
          res.added.length +
          ' 个（' +
          (res.added.map((a) => a.file).join(', ') || '无') +
          '）',
      )
    }
    return res
  })
  // 克隆：生成「xxx 副本.js」并登记
  ipcMain.handle('jb:script-clone', (_e, id) => {
    const res = store.clone(id)
    if (res.ok) log('[jb] 已克隆：' + res.item.file)
    return res
  })
  // 重命名：磁盘文件真改名 + 花名册同步。运行中的脚本文件被进程锁着，先拦下来
  ipcMain.handle('jb:script-rename', (_e, id, newBase) => {
    const run = runner ? runner.status() : {}
    if ((run[id] || []).length) return { ok: false, error: '脚本正在运行，先停止再改名' }
    const res = store.rename(id, newBase)
    if (res.ok) log('[jb] 已改名：' + res.item.file)
    return res
  })
  // 导入本地文件：选文件（可多选）→ 逐个复制进脚本目录并登记。撞名自动加序号，
  // 每个文件单独成败（一个坏了不连累别的），结果全带回给面板提示。
  ipcMain.handle('jb:script-import', async () => {
    if (!store.read().dir) return { ok: false, error: '请先选择脚本目录' }
    const win = getWindow()
    if (!win || win.isDestroyed()) return { ok: false, error: '窗口不可用' }
    const res = await dialog.showOpenDialog(win, {
      title: '选择要导入的脚本文件（可多选）',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '脚本文件', extensions: ['js', 'py'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    })
    if (res.canceled || !res.filePaths || !res.filePaths.length) return { ok: false, error: 'cancelled' }
    const results = res.filePaths.map((p) => {
      const r = store.importFile(p)
      if (r.ok) log('[jb] 已导入：' + r.file + '（← ' + path.basename(p) + '）')
      return { file: r.ok ? r.file : path.basename(p), source: path.basename(p), ...r }
    })
    const count = results.filter((r) => r.ok).length
    if (!count) log('[jb] 导入全部失败')
    return { ok: true, results: results, count: count }
  })

  // ---------- 文件读写与运行 ----------
  ipcMain.handle('jb:script-read', (_e, id) => {
    const cfg = store.read()
    const item = cfg.items.find((x) => x.id === id)
    if (!item) return { ok: false, error: '找不到该脚本' }
    if (!cfg.dir) return { ok: false, error: '请先选择脚本目录' }
    try {
      return { ok: true, code: fs.readFileSync(path.join(cfg.dir, item.file), 'utf8'), exists: true }
    } catch (err) {
      return { ok: true, code: '', exists: false }
    }
  })
  ipcMain.handle('jb:script-write', (_e, id, code) => {
    const cfg = store.read()
    const item = cfg.items.find((x) => x.id === id)
    if (!item) return { ok: false, error: '找不到该脚本' }
    if (!cfg.dir) return { ok: false, error: '请先选择脚本目录' }
    try {
      const p = path.join(cfg.dir, item.file)
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, String(code == null ? '' : code), 'utf8')
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) }
    }
  })
  ipcMain.handle('jb:script-run', (_e, id) => {
    const cfg = store.read()
    const item = cfg.items.find((x) => x.id === id)
    if (!item) return { ok: false, error: '找不到该脚本' }
    if (!cfg.dir) return { ok: false, error: '请先选择脚本目录' }
    try {
      if (!fs.existsSync(path.join(cfg.dir, item.file))) return { ok: false, error: '文件不存在，先编辑保存再运行' }
    } catch (err) {
      return { ok: false, error: '文件不存在，先编辑保存再运行' }
    }
    const res = runner.runOne(item, cfg.dir, {})
    if (res.ok) log('[jb] 运行 ' + item.name + '（' + res.inst + '）')
    else log('[jb] 运行失败 ' + item.name + ': ' + res.error)
    return res
  })
  // —— 定时 / 启动方式 ——
  ipcMain.handle('jb:script-schedule', (_e, id, opts) => {
    const cfg = store.read()
    const item = cfg.items.find((x) => x.id === id)
    if (!item) return { ok: false, error: '找不到该脚本' }
    opts = opts || {}
    const input = { ...item }
    if (typeof opts.cron === 'string' && opts.cron.trim()) {
      // 表达式顺手归一化（去多余空格），非法的一律拒绝，不让脏数据进花名册
      const parsed = parseCron(opts.cron.trim())
      if (!parsed.ok) return parsed
      input.cron = parsed.expr
    } else {
      input.cron = null
    }
    input.cronCatchUp = opts.cronCatchUp === true
    input.onStartup = opts.onStartup === true
    input.daemon = opts.daemon === true
    input.closeAfterRun = opts.closeAfterRun === true
    // 长驻必然随启动：后台保活的进程不随应用启动就毫无意义
    if (input.daemon) input.onStartup = true
    const res = store.save(input)
    if (res.ok) {
      if (scheduler) scheduler.clearAlarm(id)
      log(
        '[jb] 已更新启动配置：' +
          item.name +
          '（cron=' +
          (input.cron || '无') +
          ' onStartup=' +
          input.onStartup +
          ' daemon=' +
          input.daemon +
          '）',
      )
    }
    return res
  })
  // cron 表达式实时预览：输入框每次按键 debounce 后调这里，给「下次运行」和错误提示
  ipcMain.handle('jb:script-cron-preview', (_e, expr) => {
    const parsed = parseCron(expr == null ? '' : expr)
    if (!parsed.ok) return parsed
    return cronNextParsed(parsed, Date.now())
  })
  ipcMain.handle('jb:script-stop', (_e, id, inst) => {
    return runner.stop(id, inst)
  })
  ipcMain.handle('jb:script-log-history', (_e, id) => {
    return { ok: true, lines: runner.history(id) }
  })
  ipcMain.handle('jb:script-status', () => {
    return { ok: true, running: runner.status() }
  })

  // ---------- 示例库 ----------
  ipcMain.handle('jb:ex-list', () => {
    return { ok: true, items: exStore.list() }
  })
  ipcMain.handle('jb:ex-read', (_e, id) => {
    return exStore.readCode(id)
  })
  ipcMain.handle('jb:ex-create', (_e, input, autoRename) => {
    return exStore.create(input, { autoRename: !!autoRename })
  })
  ipcMain.handle('jb:ex-update', (_e, id, input) => {
    return exStore.update(id, input)
  })
  ipcMain.handle('jb:ex-remove', (_e, id) => {
    return exStore.remove(id)
  })
  // 导入示例到脚本目录：复用脚本存储的 importFile（复制 + 登记 + 撞名加序号）
  ipcMain.handle('jb:ex-import', (_e, id) => {
    const cfg = store.read()
    if (!cfg.dir) return { ok: false, error: '请先选择脚本目录' }
    const ex = exStore.read().items.find((x) => x.id === id)
    if (!ex) return { ok: false, error: '找不到该示例' }
    const res = store.importFile(path.join(exStore.dir, ex.file))
    if (res.ok) log('[jb] 已从示例库导入：' + res.file)
    return res
  })

  // ---------- 杂项 ----------
  ipcMain.handle('jb:clipboard-read', () => {
    try {
      return { ok: true, text: clipboard.readText() }
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) }
    }
  })
  // 在 VS Code 中打开：code 命令（where/which 探真身）→ 常见安装路径 → 兜底系统默认程序
  ipcMain.handle('jb:script-open-editor', async (_e, id) => {
    const cfg = store.read()
    const item = cfg.items.find((x) => x.id === id)
    if (!item) return { ok: false, error: '找不到该脚本' }
    if (!cfg.dir) return { ok: false, error: '请先选择脚本目录' }
    const filePath = path.join(cfg.dir, item.file)
    if (await openInVSCode(filePath)) {
      log('[jb] 已在 VS Code 中打开：' + item.file)
      return { ok: true, how: 'vscode' }
    }
    // 兜底：没找到 VS Code，就用系统默认程序打开（记事本之类），反正能看代码
    const err2 = await shell.openPath(filePath)
    if (err2) return { ok: false, error: String((err2 && err2.message) || err2) }
    return { ok: true, how: 'system' }
  })

  // ---------- 生命周期 ----------
  function start() {
    pythonChecking = detectPython({ log })
      .then((res) => {
        pythonInfo = res
        return res
      })
      .finally(() => {
        pythonChecking = null
      })
    // 定时调度器 + 长驻守护：tick 立刻开始，随启动/补跑等 Python 检测落定再放行
    scheduler = createScriptScheduler({
      store: store,
      runner: runner,
      dataDir: dataDir,
      log: log,
      ready: function () {
        return pythonChecking || Promise.resolve()
      },
    })
    scheduler.start()
  }

  async function stopAll() {
    if (scheduler) {
      scheduler.stop()
      scheduler = null
    }
    await runner.stopAll()
  }

  return {
    start: start,
    stopAll: stopAll,
    store: store,
    runner: runner,
    exStore: exStore,
    scheduler: function () {
      return scheduler
    },
    getPythonInfo: function () {
      return pythonInfo
    },
  }
}

// ============================================================================
// VS Code 打开逻辑（从桌宠主进程原样移植，宿主无关）
// ============================================================================

function spawnDetachedOk(cmd, args, useShell) {
  return new Promise(function (resolve) {
    let child = null
    try {
      child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true, shell: !!useShell })
    } catch (err) {
      return resolve(false)
    }
    child.once('error', function () {
      resolve(false)
    })
    child.once('spawn', function () {
      resolve(true)
    })
    child.unref()
  })
}

function vscodeCmdPath() {
  const probe = process.platform === 'win32' ? 'where' : 'which'
  return new Promise(function (resolve) {
    execFile(probe, ['code'], { windowsHide: true, timeout: 4000 }, function (err, stdout) {
      const line = String(stdout || '')
        .split(/\r?\n/)
        .map(function (s) {
          return s.trim()
        })
        .filter(Boolean)[0]
      resolve(err || !line ? null : line)
    })
  })
}

async function openInVSCode(filePath) {
  // ① PATH 里的 code（Windows 上是 code.cmd，spawn 需要 shell 才能执行 .cmd）
  const viaPath = await vscodeCmdPath()
  if (viaPath && (await spawnDetachedOk(viaPath, [filePath], process.platform === 'win32'))) return true
  // ② 常见安装位置（装了 VS Code 但没勾「加入 PATH」的机器上也能找到）
  const cands = []
  if (process.env.USERPROFILE) {
    cands.push(path.join(process.env.USERPROFILE, 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe'))
  }
  if (process.env.ProgramFiles) cands.push(path.join(process.env.ProgramFiles, 'Microsoft VS Code', 'Code.exe'))
  if (process.env['ProgramFiles(x86)']) {
    cands.push(path.join(process.env['ProgramFiles(x86)'], 'Microsoft VS Code', 'Code.exe'))
  }
  for (const p of cands) {
    let exists = false
    try {
      exists = fs.existsSync(p)
    } catch (err) {}
    if (exists && (await spawnDetachedOk(p, [filePath], false))) return true
  }
  // ③ 兜底：系统默认程序打开
  return false
}
