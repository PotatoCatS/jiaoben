// ============================================================================
// jiaoben · 脚本管理器面板（前端，纯 DOM，ES 模块，无 Node 依赖）
// ============================================================================
// 从桌宠工程 pet-sq client/boot.js 第 1199–3106 行移植，改造成普通窗口面板：
//   · 桥：__dshPetBridge → window.jiaoben（方法名按 electron/preload.js 映射：
//     configGet/dirSet/save/remove/read/write/run/stop/logHistory/pythonCheck/
//     rescan/clone/rename/openDir/schedule/cronPreview/pythonSetPath/pythonClear/
//     importFiles/openEditor/clipboardRead/exList/exRead/exCreate/exUpdate/exRemove/
//     exImport/onScriptLog）
//   · 普通窗口没有桌面穿透：删掉 sendHitAreas / placePanel / 标题栏拖拽
//   · 面板与全部弹窗都挂在宿主 root（mount 第一参）下；弹窗仍按窗口居中
//   · 唯一出口：mountJiaobenPanel(root, opts)。opts.onClose 为函数时点 ✕ 回调
//     宿主（宿主决定关窗），否则 ✕ 只隐藏面板；重复 mount 幂等（重新显示）。
//   · 面板**不点外自动收**（里面有编辑器，点外误关会丢代码），只用 ✕ 关，
//     关闭前有未保存改动会先确认。
// ============================================================================

var SC_PANEL_ID = 'dshpet-smpanel'
var scPanelEl = null
var scRoot = null
var scItems = []
var scDir = null
var scSelId = null
var scTab = 'edit'
var scDirty = false
var scCodeEl = null
var scLogEl = null
var scListEl = null
var scStatusEl = null
var scNameIn = null
var scLangSel = null
var scTabEditEl = null
var scTabLogEl = null
var scDirtyEl = null
var scPyEl = null
var scPython = null
var scPythonPath = null
// 阶段三：启动方式设置弹窗 / Python 解释器弹窗
var scSchedEl = null
var scPyDlgEl = null
var scCronTimer = null

var bridge = window.jiaoben || null

var SC_TEMPLATES = {
  js:
    "console.log('你好，我是小工具脚本，现在时间 ' + new Date().toLocaleTimeString())\n" +
    'setTimeout(function () {\n' +
    "  console.log('我跑完了，再见~')\n" +
    '}, 1500)\n',
  py:
    'import datetime\n' +
    "print('你好，我是小工具脚本，现在时间', datetime.datetime.now().strftime('%H:%M:%S'))\n",
}

function scItemById(id) {
  for (var i = 0; i < scItems.length; i++) {
    if (scItems[i].id === id) return scItems[i]
  }
  return null
}

function scSetDirty(v) {
  scDirty = !!v
  if (scDirtyEl) scDirtyEl.textContent = scDirty ? '● 未保存' : ''
}

function scSetStatus(msg) {
  if (scStatusEl) scStatusEl.textContent = String(msg || '')
}

// 关闭 = 收起面板（普通窗口里由宿主或用户再次 mount 重新显示；不销毁 DOM）
function closeScriptPanel() {
  if (!scPanelEl) return
  closeScCtxMenu()
  closeScRename()
  closeScPaste()
  closeScExEdit()
  closeScExamples()
  closeScSched()
  closeScPyDlg()
  scPanelEl.style.display = 'none'
  scSelId = null
  scSetDirty(false)
}

function confirmScriptPanelClose() {
  if (!scDirty) return true
  try {
    return window.confirm('有未保存的改动，确定要关闭吗？')
  } catch (err) {
    return true
  }
}

function scPad2(n) {
  return (n < 10 ? '0' : '') + n
}

function appendScLogLine(p) {
  if (!scLogEl) return
  var div = document.createElement('div')
  div.className =
    'dshpet-smp-log-' + (p.kind === 'err' ? 'err' : p.kind === 'exit' ? 'exit' : p.kind === 'out' ? 'out' : 'sys')
  var t = p.ts ? new Date(p.ts) : new Date()
  div.textContent = '[' + scPad2(t.getHours()) + ':' + scPad2(t.getMinutes()) + ':' + scPad2(t.getSeconds()) + '] ' + p.text
  scLogEl.appendChild(div)
}

function scAutoScroll() {
  if (scLogEl) scLogEl.scrollTop = scLogEl.scrollHeight
}

async function scRefresh() {
  if (!bridge || !bridge.configGet) return
  var res = await bridge.configGet()
  scDir = (res && res.dir) || null
  scItems = (res && res.items) || []
  scPython = (res && res.python) || null
  scPythonPath = (res && res.pythonPath) || null
  if (scSelId && !scItemById(scSelId)) {
    scSelId = null
    scSetDirty(false)
    if (scCodeEl) scCodeEl.value = ''
    if (scLogEl) scLogEl.textContent = ''
  }
  renderScList()
  renderScStatus()
  renderScPython()
}

function renderScPython() {
  if (!scPyEl) return
  if (scPython && scPython.ok) {
    scPyEl.textContent = 'Python ✓ ' + (scPython.version || '')
    scPyEl.style.borderColor = 'rgba(46, 160, 67, 0.6)'
    scPyEl.style.color = '#2da44e'
    scPyEl.title =
      (scPython.custom ? '自填路径：' : '') +
      scPython.cmd +
      (scPython.args && scPython.args.length ? ' ' + scPython.args.join(' ') : '')
  } else if (scPython) {
    scPyEl.textContent = 'Python ✗ 未检测到'
    scPyEl.style.borderColor = 'rgba(180, 35, 24, 0.5)'
    scPyEl.style.color = '#b42318'
    scPyEl.title = '点我设置解释器路径 / 重新检测（装好 Python 后再点）'
  } else {
    scPyEl.textContent = 'Python …'
    scPyEl.style.borderColor = ''
    scPyEl.style.color = ''
    scPyEl.title = ''
  }
}

// 重新扫描：主进程把目录一级新出现的 .js/.py 收编进花名册，再刷新列表
async function scRescan() {
  var r = null
  if (bridge && bridge.rescan) r = await bridge.rescan()
  await scRefresh()
  if (!r || !r.ok) {
    scSetStatus((r && r.error) || '扫描失败')
    return
  }
  var n = r.added ? r.added.length : 0
  scSetStatus(n > 0 ? '扫描完成，新收编 ' + n + ' 个脚本' : '扫描完成，没发现新脚本（只认一级目录里的 .js / .py）')
}

// —— 右键菜单：克隆 / 重命名 / 删除 ——
var scCtxEl = null
// —— 阶段二弹窗：粘贴代码 / 内置示例 ——
var scPasteEl = null
var scExEl = null

function closeScCtxMenu() {
  if (!scCtxEl) return
  try {
    scCtxEl.remove()
  } catch (err) {}
  scCtxEl = null
}

function scCtxItem(label, fn, cls) {
  var b = document.createElement('button')
  b.type = 'button'
  b.className = 'dshpet-smp-menu-item' + (cls ? ' ' + cls : '')
  b.textContent = label
  b.addEventListener('click', function () {
    closeScCtxMenu()
    fn()
  })
  return b
}

function openScCtxMenu(it, x, y) {
  closeScCtxMenu()
  var m = document.createElement('div')
  m.id = 'dshpet-smpmenu'
  m.className = 'dshpet-smp-menu'
  m.appendChild(scCtxItem('克隆（生成副本）', function () { scClone(it.id) }))
  m.appendChild(scCtxItem('重命名', function () { scRename(it) }))
  m.appendChild(scCtxItem('存为示例', function () { scSaveAsExample(it) }))
  m.appendChild(scCtxItem('删除', function () { scDelete(it) }, 'dshpet-smp-menu-danger'))
  scRoot.appendChild(m)
  scCtxEl = m
  // 贴着光标放，钳进窗口
  var vw = window.innerWidth
  var vh = window.innerHeight
  var w = m.offsetWidth
  var h = m.offsetHeight
  m.style.left = Math.min(x, Math.max(8, vw - w - 8)) + 'px'
  m.style.top = Math.min(y, Math.max(8, vh - h - 8)) + 'px'
}

window.addEventListener(
  'pointerdown',
  function (e) {
    if (!scCtxEl) return
    if (e.target && e.target.closest && e.target.closest('#dshpet-smpmenu')) return
    closeScCtxMenu()
  },
  true,
)

async function scClone(id) {
  var r = null
  if (bridge && bridge.clone) r = await bridge.clone(id)
  await scRefresh()
  if (!r || !r.ok) {
    scSetStatus((r && r.error) || '克隆失败')
    return
  }
  if (r.item) {
    await scSelect(r.item.id)
    scSetStatus('已克隆为 ' + r.item.file)
  } else {
    scSetStatus('已克隆')
  }
}

// 重命名弹窗（Electron 里 window.prompt 不可用，自绘一个输入框弹窗）
var scRenameEl = null

function closeScRename() {
  if (!scRenameEl) return
  try {
    scRenameEl.remove()
  } catch (err) {}
  scRenameEl = null
}

async function scRename(it) {
  closeScRename()
  closeScCtxMenu()
  var box = document.createElement('div')
  box.id = 'dshpet-smprename'
  box.className = 'dshpet-smp-rename'
  var label = document.createElement('div')
  label.className = 'dshpet-smp-rename-label'
  label.textContent = '给「' + it.name + '」起个新名字（不用带扩展名，扩展名保持不变）'
  box.appendChild(label)
  var input = document.createElement('input')
  input.type = 'text'
  input.className = 'dshpet-smp-rename-input'
  input.value = it.name
  input.maxLength = 120
  input.spellcheck = false
  box.appendChild(input)
  var row = document.createElement('div')
  row.className = 'dshpet-smp-rename-row'
  var okBtn = document.createElement('button')
  okBtn.type = 'button'
  okBtn.className = 'dshpet-smp-btn dshpet-smp-btn-primary'
  okBtn.textContent = '确定'
  var cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.className = 'dshpet-smp-btn'
  cancelBtn.textContent = '取消'
  row.appendChild(okBtn)
  row.appendChild(cancelBtn)
  box.appendChild(row)

  var finish = async function (value) {
    closeScRename()
    if (value === null) return
    var r = null
    if (bridge && bridge.rename) r = await bridge.rename(it.id, value)
    await scRefresh()
    if (!r || !r.ok) {
      scSetStatus((r && r.error) || '改名失败')
      return
    }
    scSetStatus('已改名：' + r.item.file)
  }
  okBtn.addEventListener('click', function () {
    finish(input.value)
  })
  cancelBtn.addEventListener('click', function () {
    finish(null)
  })
  input.addEventListener('keydown', function (e) {
    e.stopPropagation()
    if (e.key === 'Enter') finish(input.value)
    else if (e.key === 'Escape') finish(null)
  })

  scRoot.appendChild(box)
  scRenameEl = box
  // 弹窗放窗口水平居中、偏上 1/3，不压住列表操作区
  var vw = window.innerWidth
  var vh = window.innerHeight
  var w = box.offsetWidth
  box.style.left = Math.max(8, Math.round((vw - w) / 2)) + 'px'
  box.style.top = Math.round(vh / 3) + 'px'
  try {
    input.focus()
    input.select()
  } catch (err) {}
}

window.addEventListener(
  'pointerdown',
  function (e) {
    if (!scRenameEl) return
    if (e.target && e.target.closest && e.target.closest('#dshpet-smprename')) return
    closeScRename()
  },
  true,
)

// —— 阶段三：启动方式设置弹窗（定时 / 错过补跑 / 随启动 / 长驻 / 自动关面板）——
function closeScSched() {
  if (!scSchedEl) return
  try {
    scSchedEl.remove()
  } catch (err) {}
  scSchedEl = null
  if (scCronTimer) {
    clearTimeout(scCronTimer)
    scCronTimer = null
  }
}

// cron 实时预览（debounce 后调主进程，错误原因也原样带回来）
function scSchedPreview(expr, outEl) {
  if (!outEl || !scSchedEl) return
  if (!String(expr || '').trim()) {
    outEl.textContent = ''
    outEl.className = 'dshpet-smp-sched-prev'
    return
  }
  if (bridge && bridge.cronPreview) {
    bridge.cronPreview(expr).then(function (r) {
      if (!outEl || !scSchedEl) return // 预览回来前弹窗已关
      if (!r) return
      if (r.ok) {
        outEl.textContent = '下次运行：' + scFmtDateTime(r.time)
        outEl.className = 'dshpet-smp-sched-prev dshpet-smp-sched-prev-ok'
      } else {
        outEl.textContent = r.error || '表达式不对'
        outEl.className = 'dshpet-smp-sched-prev dshpet-smp-sched-prev-err'
      }
    })
  }
}

// 弹窗标题栏（普通窗口不需要拖拽，只保留标题 + ✕）
function scSchedHead(title, box, onClose) {
  var head = document.createElement('div')
  head.className = 'dshpet-smp-sched-head'
  head.appendChild(document.createTextNode(title))
  var x = document.createElement('button')
  x.type = 'button'
  x.className = 'dshpet-smp-close'
  x.textContent = '✕'
  x.addEventListener('click', function (e) {
    e.stopPropagation()
    onClose()
  })
  head.appendChild(x)
  head.style.userSelect = 'none'
  return head
}

function openScSchedule(it) {
  closeScSched()
  closeScCtxMenu()
  var box = document.createElement('div')
  box.id = 'dshpet-smpsched'
  box.className = 'dshpet-smp-sched'
  box.appendChild(scSchedHead('⏱ 启动方式 · ' + it.name, box, closeScSched))

  var label = document.createElement('div')
  label.className = 'dshpet-smp-sched-label'
  label.textContent = '定时表达式（分 时 日 月 周）'
  box.appendChild(label)
  var cronRow = document.createElement('div')
  cronRow.className = 'dshpet-smp-sched-cronrow'
  var cronIn = document.createElement('input')
  cronIn.type = 'text'
  cronIn.className = 'dshpet-smp-sched-input'
  cronIn.value = it.cron || ''
  cronIn.placeholder = '留空 = 不定时'
  cronIn.spellcheck = false
  cronRow.appendChild(cronIn)
  var preset = document.createElement('select')
  preset.className = 'dshpet-smp-select'
  var presets = [
    ['', '常用预设…'],
    ['* * * * *', '每分钟'],
    ['0 * * * *', '每小时整点'],
    ['0 9 * * *', '每天 9 点'],
    ['0 9 * * 1-5', '工作日 9 点'],
    ['0 9 * * 1', '每周一 9 点'],
  ]
  for (var i = 0; i < presets.length; i++) {
    var op = document.createElement('option')
    op.value = presets[i][0]
    op.textContent = presets[i][1]
    preset.appendChild(op)
  }
  cronRow.appendChild(preset)
  box.appendChild(cronRow)

  var prev = document.createElement('div')
  prev.className = 'dshpet-smp-sched-prev'
  box.appendChild(prev)

  // 错过策略：只有设了定时才有意义（没定时时置灰）
  var catchRow = document.createElement('div')
  catchRow.className = 'dshpet-smp-sched-line'
  var catchLabel = document.createElement('span')
  catchLabel.className = 'dshpet-smp-sched-label'
  catchLabel.textContent = '关机期间错过的定时：'
  catchRow.appendChild(catchLabel)
  var radioNoIn = document.createElement('input')
  radioNoIn.type = 'radio'
  radioNoIn.name = 'sched-catchup'
  radioNoIn.checked = !it.cronCatchUp
  var radioYesIn = document.createElement('input')
  radioYesIn.type = 'radio'
  radioYesIn.name = 'sched-catchup'
  radioYesIn.checked = it.cronCatchUp === true
  var radioNo = document.createElement('label')
  radioNo.className = 'dshpet-smp-sched-radio'
  radioNo.appendChild(radioNoIn)
  radioNo.appendChild(document.createTextNode(' 不补'))
  var radioYes = document.createElement('label')
  radioYes.className = 'dshpet-smp-sched-radio'
  radioYes.appendChild(radioYesIn)
  radioYes.appendChild(document.createTextNode(' 开机补跑一次'))
  catchRow.appendChild(radioNo)
  catchRow.appendChild(radioYes)
  box.appendChild(catchRow)

  var cbOnStartup = document.createElement('label')
  cbOnStartup.className = 'dshpet-smp-sched-check'
  var onStartupIn = document.createElement('input')
  onStartupIn.type = 'checkbox'
  onStartupIn.checked = it.onStartup === true
  cbOnStartup.appendChild(onStartupIn)
  cbOnStartup.appendChild(document.createTextNode(' 随桌宠启动（🚀）'))
  box.appendChild(cbOnStartup)

  var cbDaemon = document.createElement('label')
  cbDaemon.className = 'dshpet-smp-sched-check'
  var daemonIn = document.createElement('input')
  daemonIn.type = 'checkbox'
  daemonIn.checked = it.daemon === true
  cbDaemon.appendChild(daemonIn)
  cbDaemon.appendChild(document.createTextNode(' 长驻后台（🔁，意外退出自动拉起）'))
  box.appendChild(cbDaemon)
  var daemonHint = document.createElement('div')
  daemonHint.className = 'dshpet-smp-sched-hint'
  daemonHint.textContent = '长驻脚本必然随桌宠启动：勾上长驻会自动带上「随启动」。'
  box.appendChild(daemonHint)
  // 联动：长驻 → 强制且锁定「随启动」
  function syncDaemon() {
    if (daemonIn.checked) {
      onStartupIn.checked = true
      onStartupIn.disabled = true
    } else {
      onStartupIn.disabled = false
    }
  }
  daemonIn.addEventListener('change', syncDaemon)
  syncDaemon()

  var cbClose = document.createElement('label')
  cbClose.className = 'dshpet-smp-sched-check'
  var closeIn = document.createElement('input')
  closeIn.type = 'checkbox'
  closeIn.checked = it.closeAfterRun === true
  cbClose.appendChild(closeIn)
  cbClose.appendChild(document.createTextNode(' 手动运行成功后自动关闭脚本管理器页面'))
  box.appendChild(cbClose)

  var errEl = document.createElement('div')
  errEl.className = 'dshpet-smp-sched-err'
  box.appendChild(errEl)
  var row = document.createElement('div')
  row.className = 'dshpet-smp-rename-row'
  var saveBtn = document.createElement('button')
  saveBtn.type = 'button'
  saveBtn.className = 'dshpet-smp-btn dshpet-smp-btn-primary'
  saveBtn.textContent = '保存'
  var cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.className = 'dshpet-smp-btn'
  cancelBtn.textContent = '取消'
  row.appendChild(saveBtn)
  row.appendChild(cancelBtn)
  box.appendChild(row)

  // 输入即预览（debounce 400ms）；没填定时就把「错过策略」置灰
  var schedulePreview = function () {
    if (scCronTimer) clearTimeout(scCronTimer)
    var v = cronIn.value
    var hasCron = !!String(v || '').trim()
    radioNoIn.disabled = !hasCron
    radioYesIn.disabled = !hasCron
    catchRow.style.opacity = hasCron ? '' : '0.45'
    scCronTimer = setTimeout(function () {
      scSchedPreview(v, prev)
    }, 400)
  }
  cronIn.addEventListener('input', schedulePreview)
  preset.addEventListener('change', function () {
    if (preset.value) {
      cronIn.value = preset.value
      schedulePreview()
    }
  })
  schedulePreview()
  scSchedPreview(cronIn.value, prev)

  var save = async function () {
    if (!bridge || !bridge.schedule) return
    var r = await bridge.schedule(it.id, {
      cron: cronIn.value,
      cronCatchUp: radioYesIn.checked,
      onStartup: onStartupIn.checked,
      daemon: daemonIn.checked,
      closeAfterRun: closeIn.checked,
    })
    if (!r || !r.ok) {
      // 保存失败（如表达式非法）弹窗不关，把原因亮在弹窗里
      errEl.textContent = (r && r.error) || '保存失败'
      return
    }
    closeScSched()
    await scRefresh()
    scSetStatus('已保存「' + it.name + '」的启动方式')
  }
  saveBtn.addEventListener('click', save)
  cancelBtn.addEventListener('click', function () {
    closeScSched()
  })
  cronIn.addEventListener('keydown', function (e) {
    e.stopPropagation()
    if (e.key === 'Enter') save()
    else if (e.key === 'Escape') closeScSched()
  })

  scRoot.appendChild(box)
  scSchedEl = box
  var vw = window.innerWidth
  var vh = window.innerHeight
  var w = box.offsetWidth
  var h = box.offsetHeight
  box.style.left = Math.max(8, Math.round((vw - w) / 2)) + 'px'
  box.style.top = Math.max(8, Math.round((vh - h) / 2)) + 'px'
  try {
    cronIn.focus()
  } catch (err) {}
}

window.addEventListener(
  'pointerdown',
  function (e) {
    if (!scSchedEl) return
    if (e.target && e.target.closest && e.target.closest('#dshpet-smpsched')) return
    closeScSched()
  },
  true,
)

// —— 阶段三：Python 解释器弹窗（状态 / 自填路径 / 重检）——
function closeScPyDlg() {
  if (!scPyDlgEl) return
  try {
    scPyDlgEl.remove()
  } catch (err) {}
  scPyDlgEl = null
}

function openScPyDlg() {
  closeScPyDlg()
  var box = document.createElement('div')
  box.id = 'dshpet-smpydlg'
  box.className = 'dshpet-smp-ydlg'
  box.appendChild(scSchedHead('🐍 Python 解释器', box, closeScPyDlg))

  var status = document.createElement('div')
  status.className = 'dshpet-smp-ydlg-status'
  box.appendChild(status)

  var label = document.createElement('div')
  label.className = 'dshpet-smp-sched-label'
  label.textContent = '自填解释器路径（填了就用它，优先于自动检测）'
  box.appendChild(label)
  var input = document.createElement('input')
  input.type = 'text'
  input.className = 'dshpet-smp-sched-input'
  input.value = scPythonPath || ''
  input.placeholder = '例如 C:\\Python311\\python.exe'
  input.spellcheck = false
  box.appendChild(input)
  var msg = document.createElement('div')
  msg.className = 'dshpet-smp-ydlg-msg'
  box.appendChild(msg)

  var row = document.createElement('div')
  row.className = 'dshpet-smp-rename-row'
  var saveBtn = document.createElement('button')
  saveBtn.type = 'button'
  saveBtn.className = 'dshpet-smp-btn dshpet-smp-btn-primary'
  saveBtn.textContent = '保存路径'
  var clearBtn = document.createElement('button')
  clearBtn.type = 'button'
  clearBtn.className = 'dshpet-smp-btn'
  clearBtn.textContent = '清除自填'
  var recheckBtn = document.createElement('button')
  recheckBtn.type = 'button'
  recheckBtn.className = 'dshpet-smp-btn'
  recheckBtn.textContent = '重检'
  var closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'dshpet-smp-btn'
  closeBtn.textContent = '关闭'
  row.appendChild(saveBtn)
  row.appendChild(clearBtn)
  row.appendChild(recheckBtn)
  row.appendChild(closeBtn)
  box.appendChild(row)

  var renderStatus = function () {
    if (scPython && scPython.ok) {
      status.textContent =
        '✓ ' + (scPython.custom ? '自填路径生效：' : '自动检测到：') + scPython.cmd + (scPython.version ? '（' + scPython.version + '）' : '')
      status.className = 'dshpet-smp-ydlg-status dshpet-smp-ydlg-ok'
    } else if (scPython) {
      status.textContent = '✗ 没检测到 Python，.py 脚本暂时不能运行（可自填路径，或装好后点「重检」）'
      status.className = 'dshpet-smp-ydlg-status dshpet-smp-ydlg-bad'
    } else {
      status.textContent = '… 正在检测'
      status.className = 'dshpet-smp-ydlg-status'
    }
  }
  renderStatus()

  var savePath = async function () {
    var v = String(input.value || '').trim()
    if (!v) {
      msg.textContent = '路径不能为空'
      msg.className = 'dshpet-smp-ydlg-msg dshpet-smp-ydlg-bad'
      return
    }
    if (!bridge || !bridge.pythonSetPath) return
    msg.textContent = '正在验证（跑一次 --version）…'
    msg.className = 'dshpet-smp-ydlg-msg'
    var r = await bridge.pythonSetPath(v)
    if (r && r.ok) {
      scPython = (r && r.python) || scPython
      scPythonPath = v
      msg.textContent = ''
      msg.className = 'dshpet-smp-ydlg-msg'
      renderStatus()
      renderScPython()
      scSetStatus('已保存自填路径：' + v)
    } else {
      msg.textContent = (r && r.error) || '验证失败'
      msg.className = 'dshpet-smp-ydlg-msg dshpet-smp-ydlg-bad'
    }
  }
  var clearPath = async function () {
    if (!bridge || !bridge.pythonClear) return
    var r = await bridge.pythonClear()
    if (r && r.ok) {
      scPython = (r && r.python) || null
      scPythonPath = null
      input.value = ''
      msg.textContent = ''
      msg.className = 'dshpet-smp-ydlg-msg'
      renderStatus()
      renderScPython()
      scSetStatus('已清除自填路径，恢复自动检测')
    }
  }
  var recheck = async function () {
    if (!bridge || !bridge.pythonCheck) return
    var r = await bridge.pythonCheck()
    scPython = (r && r.python) || null
    renderStatus()
    renderScPython()
    scSetStatus(scPython && scPython.ok ? '已检测到 Python：' + scPython.version : '没检测到 Python（试 py -3 / py / python 都拿不到版本号）')
  }
  saveBtn.addEventListener('click', savePath)
  clearBtn.addEventListener('click', clearPath)
  recheckBtn.addEventListener('click', recheck)
  closeBtn.addEventListener('click', function () {
    closeScPyDlg()
  })
  input.addEventListener('keydown', function (e) {
    e.stopPropagation()
    if (e.key === 'Enter') savePath()
    else if (e.key === 'Escape') closeScPyDlg()
  })

  scRoot.appendChild(box)
  scPyDlgEl = box
  var vw = window.innerWidth
  var vh = window.innerHeight
  var w = box.offsetWidth
  var h = box.offsetHeight
  box.style.left = Math.max(8, Math.round((vw - w) / 2)) + 'px'
  box.style.top = Math.max(8, Math.round((vh - h) / 2)) + 'px'
  try {
    input.focus()
  } catch (err) {}
}

window.addEventListener(
  'pointerdown',
  function (e) {
    if (!scPyDlgEl) return
    if (e.target && e.target.closest && e.target.closest('#dshpet-smpydlg')) return
    closeScPyDlg()
  },
  true,
)

// —— 阶段二：本地文件导入 ——
// 主进程弹文件选择框（可多选）→ 逐个复制进脚本目录并登记（撞名自动加序号），
// 结果一条条带回：有几个成功、几个失败（及原因）都写进状态条。
async function scImport() {
  if (!scDir) {
    scSetStatus('请先选择脚本目录')
    return
  }
  var r = null
  if (bridge && bridge.importFiles) r = await bridge.importFiles()
  if (!r) {
    scSetStatus('导入失败')
    return
  }
  if (!r.ok && r.error === 'cancelled') return // 用户取消选择，不算错
  await scRefresh()
  if (!r.ok) {
    scSetStatus(r.error || '导入失败')
    return
  }
  var results = r.results || []
  var okN = 0
  var badMsgs = []
  var firstId = null
  for (var i = 0; i < results.length; i++) {
    if (results[i].ok) {
      okN++
      if (!firstId && results[i].item) firstId = results[i].item.id
    } else {
      badMsgs.push((results[i].source || results[i].file) + '：' + (results[i].error || '失败'))
    }
  }
  var msg = '导入完成：成功 ' + okN + ' 个'
  if (badMsgs.length) msg += '；失败 ' + badMsgs.length + ' 个（' + badMsgs.join('；') + '）'
  scSetStatus(msg)
  if (firstId) await scSelect(firstId)
}

// —— 阶段二：粘贴代码保存 ——
// window.prompt 在 Electron 里不可用（和重命名弹窗一个道理），自绘弹窗：
// 代码框自动预填剪贴板内容（主进程只读剪贴板），填名字、选语言即可保存。
function closeScPaste() {
  if (!scPasteEl) return
  try {
    scPasteEl.remove()
  } catch (err) {}
  scPasteEl = null
}

async function openScPaste() {
  if (!scDir) {
    scSetStatus('请先选择脚本目录')
    return
  }
  closeScPaste()
  closeScCtxMenu()
  var clip = ''
  if (bridge && bridge.clipboardRead) {
    try {
      var c = await bridge.clipboardRead()
      if (c && c.ok) clip = c.text || ''
    } catch (err) {}
  }
  var box = document.createElement('div')
  box.id = 'dshpet-smpaste'
  box.className = 'dshpet-smp-paste'
  var label = document.createElement('div')
  label.className = 'dshpet-smp-rename-label'
  label.textContent = '粘贴代码存成新脚本（代码框已自动填入剪贴板内容，可以改）'
  box.appendChild(label)
  var row1 = document.createElement('div')
  row1.className = 'dshpet-smp-paste-row'
  var input = document.createElement('input')
  input.type = 'text'
  input.className = 'dshpet-smp-rename-input dshpet-smp-paste-name'
  input.placeholder = '新脚本名（不含扩展名）'
  input.maxLength = 100
  input.spellcheck = false
  var sel = document.createElement('select')
  sel.className = 'dshpet-smp-select'
  var optJs = document.createElement('option')
  optJs.value = 'js'
  optJs.textContent = 'JavaScript'
  var optPy = document.createElement('option')
  optPy.value = 'py'
  optPy.textContent = 'Python'
  sel.appendChild(optJs)
  sel.appendChild(optPy)
  row1.appendChild(input)
  row1.appendChild(sel)
  box.appendChild(row1)
  var ta = document.createElement('textarea')
  ta.className = 'dshpet-smp-paste-code'
  ta.spellcheck = false
  ta.value = clip
  ta.placeholder = '在这里粘贴或修改代码'
  box.appendChild(ta)
  var row2 = document.createElement('div')
  row2.className = 'dshpet-smp-rename-row'
  var okBtn = document.createElement('button')
  okBtn.type = 'button'
  okBtn.className = 'dshpet-smp-btn dshpet-smp-btn-primary'
  okBtn.textContent = '保存为新脚本'
  var cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.className = 'dshpet-smp-btn'
  cancelBtn.textContent = '取消'
  row2.appendChild(okBtn)
  row2.appendChild(cancelBtn)
  box.appendChild(row2)

  var finish = async function (value) {
    if (value === null) {
      closeScPaste()
      return
    }
    // 校验/保存失败都让弹窗留着（刚粘的代码不丢），改个名字再试
    var name = (input.value || '').trim()
    if (!name) {
      scSetStatus('先填个脚本名（不含扩展名）')
      try {
        input.focus()
      } catch (err) {}
      return
    }
    var lang = sel.value === 'py' ? 'py' : 'js'
    var ext = lang === 'py' ? '.py' : '.js'
    var r = null
    if (bridge && bridge.save) r = await bridge.save({ name: name, lang: lang, file: name + ext })
    if (!r || !r.ok) {
      scSetStatus((r && r.error) || '保存失败')
      return
    }
    if (bridge.write) {
      var w = await bridge.write(r.item.id, ta.value || '')
      if (!w || !w.ok) {
        scSetStatus((w && w.error) || '写入文件失败')
        return
      }
    }
    closeScPaste()
    await scRefresh()
    await scSelect(r.item.id)
    scSetStatus('已粘贴保存为 ' + r.item.file + '，试试点「运行」')
  }
  okBtn.addEventListener('click', function () {
    finish(input.value)
  })
  cancelBtn.addEventListener('click', function () {
    finish(null)
  })
  input.addEventListener('keydown', function (e) {
    e.stopPropagation()
    if (e.key === 'Enter') {
      finish(input.value)
    } else if (e.key === 'Escape') {
      finish(null)
    }
  })
  ta.addEventListener('keydown', function (e) {
    e.stopPropagation()
    if (e.key === 'Escape') {
      finish(null)
    } else if (e.key === 'Enter' && e.ctrlKey) {
      finish(input.value)
    }
  })

  scRoot.appendChild(box)
  scPasteEl = box
  var vw = window.innerWidth
  var vh = window.innerHeight
  var w = box.offsetWidth
  box.style.left = Math.max(8, Math.round((vw - w) / 2)) + 'px'
  box.style.top = Math.max(8, Math.round(vh / 5)) + 'px'
  try {
    if (!clip) ta.focus()
    else input.focus()
  } catch (err) {}
}

window.addEventListener(
  'pointerdown',
  function (e) {
    if (!scPasteEl) return
    if (e.target && e.target.closest && e.target.closest('#dshpet-smpaste')) return
    closeScPaste()
  },
  true,
)

// —— 阶段二：示例库管理器（可增删改查；2026-10-17 用户拍板：存数据目录、从零开始）——
// 「示例」弹窗升级成小型管理器：左边示例列表、右边代码预览，按钮：新建/编辑/删除/
// 导入到脚本目录。普通窗口不需要标题栏拖拽，管理器标题栏和编辑弹窗只保留标题 + ✕。
var scExItems = []
var scExSelId = null
var scExListEl = null
var scExViewEl = null
var scExEditEl = null

function scExItemById(id) {
  for (var i = 0; i < scExItems.length; i++) {
    if (scExItems[i].id === id) return scExItems[i]
  }
  return null
}

function closeScExamples() {
  if (!scExEl) return
  closeScExEdit()
  try {
    scExEl.remove()
  } catch (err) {}
  scExEl = null
  scExListEl = null
  scExViewEl = null
  scExSelId = null
}

function closeScExEdit() {
  if (!scExEditEl) return
  try {
    scExEditEl.remove()
  } catch (err) {}
  scExEditEl = null
}

function renderScExList() {
  if (!scExListEl) return
  scExListEl.textContent = ''
  if (!scExItems.length) {
    var e = document.createElement('div')
    e.className = 'dshpet-smp-empty'
    e.textContent = '示例库还是空的。\n点「新建示例」写第一个，\n或在脚本列表右键「存为示例」。'
    scExListEl.appendChild(e)
    return
  }
  for (var i = 0; i < scExItems.length; i++) {
    ;(function (ex) {
      var it = document.createElement('button')
      it.type = 'button'
      it.className =
        'dshpet-smp-ex-item' +
        (ex.id === scExSelId ? ' dshpet-smp-ex-item-sel' : '') +
        (ex.exists === false ? ' dshpet-smp-ex-item-missing' : '')
      var name = document.createElement('span')
      name.className = 'dshpet-smp-ex-name'
      var lang = document.createElement('span')
      lang.className = 'dshpet-smp-lang' + (ex.lang === 'py' ? ' dshpet-smp-lang-py' : '')
      lang.textContent = ex.lang === 'py' ? 'PY' : 'JS'
      name.appendChild(lang)
      name.appendChild(document.createTextNode(ex.name))
      var sub = document.createElement('span')
      sub.className = 'dshpet-smp-ex-sub'
      sub.textContent = ex.exists === false ? '找不到文件' : ex.file
      it.appendChild(name)
      it.appendChild(sub)
      it.addEventListener('click', function () {
        scExSelect(ex.id)
      })
      it.addEventListener('dblclick', function () {
        openScExEdit(ex)
      })
      scExListEl.appendChild(it)
    })(scExItems[i])
  }
}

async function scExViewCode() {
  if (!scExViewEl) return
  if (!scExSelId) {
    scExViewEl.value = ''
    scExViewEl.placeholder = '点左边选一个示例看代码；双击可直接编辑'
    return
  }
  var item = scExItemById(scExSelId)
  if (!item) return
  if (item.exists === false) {
    scExViewEl.value = '// 示例文件不在了（可能被手动删掉）\n// 点「编辑」保存一次会重建文件'
    return
  }
  var res = null
  if (bridge && bridge.exRead) res = await bridge.exRead(scExSelId)
  scExViewEl.value = res && res.ok ? res.code || '' : '// 读取失败: ' + ((res && res.error) || '')
}

function scExSelect(id) {
  scExSelId = id
  renderScExList()
  scExViewCode()
}

async function scExRefresh() {
  var r = null
  if (bridge && bridge.exList) r = await bridge.exList()
  scExItems = (r && r.items) || []
  if (scExSelId && !scExItemById(scExSelId)) scExSelId = null
  renderScExList()
  await scExViewCode()
}

async function scExImportOne(id) {
  var r = null
  if (bridge && bridge.exImport) r = await bridge.exImport(id)
  await scRefresh()
  if (!r || !r.ok) {
    scSetStatus((r && r.error) || '导入失败')
    return
  }
  scSetStatus('已从示例库导入 ' + r.item.file + ' 到脚本目录')
}

async function scExDelete(id) {
  var item = scExItemById(id)
  if (!item) return
  var ok = false
  try {
    ok = window.confirm('删除示例「' + item.name + '」？\n\n示例文件和示例库记录会一起删掉。')
  } catch (err) {
    ok = true
  }
  if (!ok) return
  var r = null
  if (bridge && bridge.exRemove) r = await bridge.exRemove(id)
  if (!r || !r.ok) {
    scSetStatus((r && r.error) || '删除失败')
    return
  }
  await scExRefresh()
  scSetStatus('已删除示例 ' + item.name)
}

// 新建/编辑共用的输入弹窗（名字 + 语言 + 代码框）
function openScExEdit(item) {
  closeScExEdit()
  var box = document.createElement('div')
  box.id = 'dshpet-smpexedit'
  box.className = 'dshpet-smp-exedit'
  var head = document.createElement('div')
  head.className = 'dshpet-smp-ex-head'
  head.textContent = item ? '编辑示例' : '新建示例'
  head.style.userSelect = 'none'
  var x = document.createElement('button')
  x.type = 'button'
  x.className = 'dshpet-smp-close'
  x.textContent = '✕'
  x.addEventListener('click', function (e) {
    e.stopPropagation()
    closeScExEdit()
  })
  head.appendChild(x)
  box.appendChild(head)
  var row1 = document.createElement('div')
  row1.className = 'dshpet-smp-paste-row'
  var input = document.createElement('input')
  input.type = 'text'
  input.className = 'dshpet-smp-rename-input dshpet-smp-paste-name'
  input.placeholder = '示例名（不含扩展名）'
  input.maxLength = 120
  input.spellcheck = false
  input.value = item ? item.name : ''
  var sel = document.createElement('select')
  sel.className = 'dshpet-smp-select'
  var optJs = document.createElement('option')
  optJs.value = 'js'
  optJs.textContent = 'JavaScript'
  var optPy = document.createElement('option')
  optPy.value = 'py'
  optPy.textContent = 'Python'
  sel.appendChild(optJs)
  sel.appendChild(optPy)
  sel.value = item && item.lang === 'py' ? 'py' : 'js'
  row1.appendChild(input)
  row1.appendChild(sel)
  box.appendChild(row1)
  var ta = document.createElement('textarea')
  ta.className = 'dshpet-smp-paste-code'
  ta.spellcheck = false
  ta.placeholder = '示例代码'
  box.appendChild(ta)
  var row2 = document.createElement('div')
  row2.className = 'dshpet-smp-rename-row'
  var okBtn = document.createElement('button')
  okBtn.type = 'button'
  okBtn.className = 'dshpet-smp-btn dshpet-smp-btn-primary'
  okBtn.textContent = '保存'
  var cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.className = 'dshpet-smp-btn'
  cancelBtn.textContent = '取消'
  row2.appendChild(okBtn)
  row2.appendChild(cancelBtn)
  box.appendChild(row2)

  // 编辑模式先读现有代码填进去
  var finish = async function (value) {
    if (value === null) {
      closeScExEdit()
      return
    }
    var name = (input.value || '').trim()
    if (!name) {
      scSetStatus('先填个示例名（不含扩展名）')
      try {
        input.focus()
      } catch (err) {}
      return
    }
    var r = null
    if (item) {
      if (bridge && bridge.exUpdate) r = await bridge.exUpdate(item.id, { name: name, lang: sel.value, code: ta.value || '' })
    } else {
      if (bridge && bridge.exCreate) r = await bridge.exCreate({ name: name, lang: sel.value, code: ta.value || '' })
    }
    if (!r || !r.ok) {
      scSetStatus((r && r.error) || '保存失败')
      return // 弹窗留着，代码不丢
    }
    closeScExEdit()
    scExSelId = r.item ? r.item.id : item.id
    await scExRefresh()
    scSetStatus(item ? '已更新示例 ' + r.item.file : '已新建示例 ' + r.item.file)
  }
  okBtn.addEventListener('click', function () {
    finish(input.value)
  })
  cancelBtn.addEventListener('click', function () {
    finish(null)
  })
  input.addEventListener('keydown', function (e) {
    e.stopPropagation()
    if (e.key === 'Enter') finish(input.value)
    else if (e.key === 'Escape') finish(null)
  })
  ta.addEventListener('keydown', function (e) {
    e.stopPropagation()
    if (e.key === 'Escape') finish(null)
    else if (e.key === 'Enter' && e.ctrlKey) finish(input.value)
  })

  scRoot.appendChild(box)
  scExEditEl = box
  var vw = window.innerWidth
  var vh = window.innerHeight
  var w = box.offsetWidth
  box.style.left = Math.max(8, Math.round((vw - w) / 2)) + 'px'
  box.style.top = Math.max(8, Math.round(vh / 4)) + 'px'
  try {
    input.focus()
    input.select()
  } catch (err) {}
  if (item) {
    ;(async function () {
      var res = null
      if (bridge && bridge.exRead) res = await bridge.exRead(item.id)
      if (res && res.ok && res.exists !== false) ta.value = res.code || ''
      else if (res && res.ok) ta.value = '// 文件不在了，保存一次会重建\n'
      try {
        if (document.activeElement === input) ta.focus()
      } catch (err) {}
    })()
  }
}

async function openScExamples() {
  closeScExamples()
  closeScCtxMenu()
  var box = document.createElement('div')
  box.id = 'dshpet-smpexamples'
  box.className = 'dshpet-smp-examples'
  var head = document.createElement('div')
  head.className = 'dshpet-smp-ex-head'
  head.textContent = '示例库（点选查看，双击编辑）'
  head.style.userSelect = 'none'
  var x = document.createElement('button')
  x.type = 'button'
  x.className = 'dshpet-smp-close'
  x.textContent = '✕'
  x.addEventListener('click', function (e) {
    e.stopPropagation()
    closeScExamples()
  })
  head.appendChild(x)
  box.appendChild(head)

  var body = document.createElement('div')
  body.className = 'dshpet-smp-ex-body'
  scExListEl = document.createElement('div')
  scExListEl.className = 'dshpet-smp-ex-list'
  body.appendChild(scExListEl)
  scExViewEl = document.createElement('textarea')
  scExViewEl.className = 'dshpet-smp-ex-viewer'
  scExViewEl.readOnly = true
  scExViewEl.spellcheck = false
  scExViewEl.wrap = 'off'
  body.appendChild(scExViewEl)
  box.appendChild(body)

  var btns = document.createElement('div')
  btns.className = 'dshpet-smp-ex-btns'
  var newBtn = document.createElement('button')
  newBtn.type = 'button'
  newBtn.className = 'dshpet-smp-btn dshpet-smp-btn-primary'
  newBtn.textContent = '新建示例'
  newBtn.addEventListener('click', function () {
    openScExEdit(null)
  })
  btns.appendChild(newBtn)
  var editBtn = document.createElement('button')
  editBtn.type = 'button'
  editBtn.className = 'dshpet-smp-btn'
  editBtn.textContent = '编辑'
  editBtn.addEventListener('click', function () {
    var item = scExItemById(scExSelId)
    if (!item) {
      scSetStatus('先在左边选一个示例')
      return
    }
    openScExEdit(item)
  })
  btns.appendChild(editBtn)
  var delBtn = document.createElement('button')
  delBtn.type = 'button'
  delBtn.className = 'dshpet-smp-btn'
  delBtn.textContent = '删除'
  delBtn.addEventListener('click', function () {
    if (!scExSelId) {
      scSetStatus('先在左边选一个示例')
      return
    }
    scExDelete(scExSelId)
  })
  btns.appendChild(delBtn)
  var impBtn = document.createElement('button')
  impBtn.type = 'button'
  impBtn.className = 'dshpet-smp-btn'
  impBtn.textContent = '导入到脚本目录'
  impBtn.title = '把选中的示例复制进脚本目录并登记（撞名自动加序号）'
  impBtn.addEventListener('click', function () {
    if (!scExSelId) {
      scSetStatus('先在左边选一个示例')
      return
    }
    scExImportOne(scExSelId)
  })
  btns.appendChild(impBtn)
  var spacer = document.createElement('span')
  spacer.style.flex = '1'
  btns.appendChild(spacer)
  var closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'dshpet-smp-btn'
  closeBtn.textContent = '关闭'
  closeBtn.addEventListener('click', function () {
    closeScExamples()
  })
  btns.appendChild(closeBtn)
  box.appendChild(btns)

  scRoot.appendChild(box)
  scExEl = box
  var vw = window.innerWidth
  var vh = window.innerHeight
  var w = box.offsetWidth
  var h = box.offsetHeight
  box.style.left = Math.max(8, Math.round((vw - w) / 2)) + 'px'
  box.style.top = Math.max(8, Math.round((vh - h) / 2.5)) + 'px'
  scExRefresh()
}

window.addEventListener(
  'pointerdown',
  function (e) {
    if (!scExEl) return
    // 编辑弹窗挂在管理器外面，点编辑弹窗不能把管理器关掉
    if (e.target && e.target.closest && (e.target.closest('#dshpet-smpexamples') || e.target.closest('#dshpet-smpexedit'))) return
    closeScExamples()
  },
  true,
)

// 右键菜单里的「存为示例」：把当前脚本的内容存进示例库（撞名自动加序号）
async function scSaveAsExample(it) {
  var code = ''
  if (bridge && bridge.read) {
    var res = await bridge.read(it.id)
    if (res && res.ok && res.exists === false) {
      scSetStatus('文件不存在，先在编辑器里保存再存为示例')
      return
    }
    if (res && res.ok) code = res.code || ''
  }
  var r = null
  if (bridge && bridge.exCreate) r = await bridge.exCreate({ name: it.name, lang: it.lang, code: code }, true)
  if (!r || !r.ok) {
    scSetStatus((r && r.error) || '存为示例失败')
    return
  }
  scSetStatus('已存为示例：' + r.item.file)
}

async function scDelete(it) {
  var delFile = false
  try {
    delFile = window.confirm('删除「' + it.name + '」\n\n确定 = 连同脚本文件一起删\n取消 = 只从列表移除（文件留在目录里）')
  } catch (err) {}
  var r = null
  if (bridge && bridge.remove) r = await bridge.remove(it.id, delFile)
  await scRefresh()
  if (r && !r.ok) scSetStatus((r && r.error) || '删除失败')
}

function scOp(label, fn, cls) {
  var b = document.createElement('button')
  b.type = 'button'
  b.className = 'dshpet-smp-op' + (cls ? ' ' + cls : '')
  b.textContent = label
  b.addEventListener('click', function (e) {
    fn(e)
  })
  return b
}

function scItemEl(it) {
  var box = document.createElement('div')
  box.className =
    'dshpet-smp-item' +
    (it.id === scSelId ? ' dshpet-smp-item-sel' : '') +
    (it.exists === false ? ' dshpet-smp-item-missing' : '') +
    (it.alarm ? ' dshpet-smp-item-alarm' : '')
  var name = document.createElement('div')
  name.className = 'dshpet-smp-item-name'
  var lang = document.createElement('span')
  lang.className = 'dshpet-smp-lang' + (it.lang === 'py' ? ' dshpet-smp-lang-py' : '')
  lang.textContent = it.lang === 'py' ? 'PY' : 'JS'
  name.appendChild(lang)
  name.appendChild(document.createTextNode(it.name))
  // 阶段三标记：⏱ 定时 / 🚀 随启动 / 🔁 长驻（悬停看细节）
  var mk = function (ch, tip) {
    var s = document.createElement('span')
    s.className = 'dshpet-smp-mk'
    s.textContent = ch
    s.title = tip
    name.appendChild(s)
  }
  if (it.cron) mk('⏱', '定时运行：' + it.cron + (it.nextRun ? '\n下次运行：' + scFmtDateTime(it.nextRun) : it.cronError ? '\n' + it.cronError : ''))
  if (it.onStartup) mk('🚀', '随桌宠启动')
  if (it.daemon) mk('🔁', '长驻后台：意外退出会自动拉起')
  box.appendChild(name)
  var sub = document.createElement('div')
  sub.className = 'dshpet-smp-item-sub'
  if (it.alarm) sub.textContent = '⚠ ' + it.alarm
  else if (it.cronError) sub.textContent = '⚠ ' + it.cronError
  else sub.textContent = (it.exists === false ? '找不到文件 · ' : '') + (it.running > 0 ? '运行中 ×' + it.running : '未运行')
  box.appendChild(sub)
  box.addEventListener('click', function () {
    scSelect(it.id)
  })
  // 右键弹出操作菜单：克隆 / 重命名 / 删除（运行/停止留在行尾按钮）
  box.addEventListener('contextmenu', function (e) {
    e.preventDefault()
    e.stopPropagation()
    openScCtxMenu(it, e.clientX, e.clientY)
  })
  var ops = document.createElement('div')
  ops.className = 'dshpet-smp-item-ops'
  ops.appendChild(
    scOp('运行', async function (e) {
      e.stopPropagation()
      var errMsg = null
      var launched = false
      if (bridge && bridge.run) {
        var r = await bridge.run(it.id)
        if (r && r.ok) launched = true
        else errMsg = (r && r.error) || '运行失败'
      }
      await scRefresh()
      if (errMsg) {
        // 失败要让人一眼看到：错误打进「运行日志」页，别只藏在底部状态条里
        await scSetTab('log')
        appendScLogLine({ kind: 'err', text: '✗ 运行失败：' + errMsg })
        scAutoScroll()
        scSetStatus(errMsg)
      } else if (launched && it.closeAfterRun) {
        // 「启动后自动关闭脚本管理器页面」：运行已交给后台，收起面板（有未保存改动先确认）
        if (confirmScriptPanelClose()) closeScriptPanel()
      } else {
        scSetTab('log')
      }
    }),
  )
  ops.appendChild(
    scOp('停止', async function (e) {
      e.stopPropagation()
      if (bridge && bridge.stop) await bridge.stop(it.id)
      await scRefresh()
    }),
  )
  // ⏱ 启动方式设置：设了定时/随启动/长驻就高亮
  ops.appendChild(
    scOp('⏱', function (e) {
      e.stopPropagation()
      openScSchedule(it)
    }, 'dshpet-smp-op-sched' + (it.cron || it.onStartup || it.daemon ? ' dshpet-smp-op-on' : '')),
  )
  box.appendChild(ops)
  return box
}

function renderScList() {
  if (!scListEl) return
  scListEl.textContent = ''
  if (!scDir) {
    var e1 = document.createElement('div')
    e1.className = 'dshpet-smp-empty'
    e1.textContent = '还没有选择脚本目录。\n点上面「选择/更换目录」挑一个文件夹放脚本。'
    scListEl.appendChild(e1)
    return
  }
  if (!scItems.length) {
    var e2 = document.createElement('div')
    e2.className = 'dshpet-smp-empty'
    e2.textContent = '还没有脚本。\n上面填个名字点「新建」。'
    scListEl.appendChild(e2)
    return
  }
  for (var i = 0; i < scItems.length; i++) {
    scListEl.appendChild(scItemEl(scItems[i]))
  }
}

function scFmtDateTime(ms) {
  var d = new Date(ms)
  return d.getFullYear() + '-' + scPad2(d.getMonth() + 1) + '-' + scPad2(d.getDate()) + ' ' + scPad2(d.getHours()) + ':' + scPad2(d.getMinutes())
}

function renderScStatus() {
  var item = scSelId ? scItemById(scSelId) : null
  var left = item ? (item.running > 0 ? item.name + '：运行中 ×' + item.running : item.name + '：未运行') : '未选择脚本'
  if (item && item.nextRun) left += '　|　下次运行：' + scFmtDateTime(item.nextRun)
  if (scStatusEl) scStatusEl.textContent = left + '　|　目录：' + (scDir || '（未选择）')
}

async function scLoadLog() {
  if (!scLogEl) return
  scLogEl.textContent = ''
  if (!scSelId) return
  if (!bridge || !bridge.logHistory) return
  var res = await bridge.logHistory(scSelId)
  var lines = (res && res.lines) || []
  for (var i = 0; i < lines.length; i++) {
    appendScLogLine(lines[i])
  }
  scAutoScroll()
}

async function scSetTab(tab) {
  scTab = tab
  if (scTabEditEl) scTabEditEl.classList.toggle('dshpet-smp-tab-sel', tab === 'edit')
  if (scTabLogEl) scTabLogEl.classList.toggle('dshpet-smp-tab-sel', tab === 'log')
  if (scCodeEl) scCodeEl.style.display = tab === 'edit' ? '' : 'none'
  if (scLogEl) scLogEl.style.display = tab === 'log' ? '' : 'none'
  if (tab === 'log') await scLoadLog()
}

async function scSelect(id) {
  // 切换前有未保存改动先确认，别把用户刚写的代码悄悄丢掉
  if (scDirty && scSelId !== id) {
    var cur = scItemById(scSelId)
    var ok = false
    try {
      ok = window.confirm('「' + (cur ? cur.name : '当前脚本') + '」有未保存的改动，切换会丢弃。确定切换吗？')
    } catch (err) {
      ok = true
    }
    if (!ok) return
  }
  scSelId = id
  scSetDirty(false)
  renderScList()
  var item = scItemById(id)
  if (!item) return
  if (bridge && bridge.read) {
    var res = await bridge.read(id)
    if (scCodeEl) scCodeEl.value = res && res.ok ? res.code || '' : '// 读取失败: ' + ((res && res.error) || '')
  }
  if (scTab === 'log') await scLoadLog()
  renderScStatus()
}

async function scSaveCode() {
  if (!scSelId) {
    scSetStatus('先在左侧选中一个脚本')
    return
  }
  var item = scItemById(scSelId)
  if (!item) return
  if (bridge && bridge.write) {
    var res = await bridge.write(scSelId, scCodeEl ? scCodeEl.value : '')
    if (res && res.ok) {
      scSetDirty(false)
      scSetStatus('已保存 ' + item.file)
    } else {
      scSetStatus((res && res.error) || '保存失败')
    }
  }
  await scRefresh()
}

async function scCreate() {
  if (!bridge || !bridge.save) return
  var name = (scNameIn ? scNameIn.value : '').trim()
  if (!name) {
    scSetStatus('先填个脚本名（不含扩展名）')
    return
  }
  var lang = scLangSel ? scLangSel.value : 'js'
  var ext = lang === 'py' ? '.py' : '.js'
  var res = await bridge.save({ name: name, lang: lang, file: name + ext })
  if (!res || !res.ok) {
    scSetStatus((res && res.error) || '新建失败')
    return
  }
  if (bridge.write) {
    await bridge.write(res.item.id, SC_TEMPLATES[lang] || SC_TEMPLATES.js)
  }
  if (scNameIn) scNameIn.value = ''
  await scRefresh()
  await scSelect(res.item.id)
  scSetStatus('已新建 ' + name + ext + '，试试点「运行」')
}

// ============================================================================
// 对外唯一出口：把面板挂到 root（宿主容器）下
// ============================================================================
// · opts 可选；opts.onClose 为函数时，点面板标题栏右上角 ✕ 调用它（宿主决定
//   关窗），否则 ✕ 只隐藏面板（再 mount 一次即重新显示）。
// · 幂等：已挂载就直接重新显示已有实例，不重复建 DOM。
function mountJiaobenPanel(root, opts) {
  opts = opts || {}
  if (scPanelEl) {
    if (root && root !== scRoot) {
      // 宿主容器换了：面板搬过去；旧宿主下的弹窗一并收掉
      closeScCtxMenu()
      closeScRename()
      closeScPaste()
      closeScExEdit()
      closeScExamples()
      closeScSched()
      closeScPyDlg()
      try {
        root.appendChild(scPanelEl)
        scRoot = root
      } catch (err) {}
    }
    scPanelEl.style.display = ''
    scRefresh()
    return scPanelEl
  }
  scRoot = root || document.body

  var box = document.createElement('div')
  box.id = SC_PANEL_ID

  var head = document.createElement('div')
  head.className = 'dshpet-smp-head'
  head.appendChild(document.createTextNode('⚙ 脚本管理器'))
  var x = document.createElement('button')
  x.type = 'button'
  x.className = 'dshpet-smp-close'
  x.textContent = '✕'
  x.addEventListener('click', function (e) {
    e.stopPropagation()
    if (!confirmScriptPanelClose()) return
    if (typeof opts.onClose === 'function') {
      opts.onClose()
      return
    }
    closeScriptPanel()
  })
  head.appendChild(x)
  head.style.userSelect = 'none'
  box.appendChild(head)

  var tb = document.createElement('div')
  tb.className = 'dshpet-smp-toolbar'
  scNameIn = document.createElement('input')
  scNameIn.type = 'text'
  scNameIn.className = 'dshpet-smp-input'
  scNameIn.placeholder = '新脚本名（不含扩展名）'
  scNameIn.style.width = '180px'
  scNameIn.maxLength = 100
  tb.appendChild(scNameIn)
  scLangSel = document.createElement('select')
  scLangSel.className = 'dshpet-smp-select'
  var optJs = document.createElement('option')
  optJs.value = 'js'
  optJs.textContent = 'JavaScript'
  var optPy = document.createElement('option')
  optPy.value = 'py'
  optPy.textContent = 'Python'
  scLangSel.appendChild(optJs)
  scLangSel.appendChild(optPy)
  tb.appendChild(scLangSel)
  var newBtn = document.createElement('button')
  newBtn.type = 'button'
  newBtn.className = 'dshpet-smp-btn dshpet-smp-btn-primary'
  newBtn.textContent = '新建'
  newBtn.addEventListener('click', function () {
    scCreate()
  })
  tb.appendChild(newBtn)
  var spacer = document.createElement('span')
  spacer.style.flex = '1'
  tb.appendChild(spacer)
  scPyEl = document.createElement('button')
  scPyEl.type = 'button'
  scPyEl.className = 'dshpet-smp-btn'
  scPyEl.addEventListener('click', function () {
    openScPyDlg()
  })
  tb.appendChild(scPyEl)
  renderScPython()
  box.appendChild(tb)

  // 第二行：文件操作（阶段二把「导入/粘贴/示例」和目录操作排成一行）
  var tb2 = document.createElement('div')
  tb2.className = 'dshpet-smp-toolbar dshpet-smp-toolbar2'
  var importBtn = document.createElement('button')
  importBtn.type = 'button'
  importBtn.className = 'dshpet-smp-btn'
  importBtn.textContent = '导入文件'
  importBtn.title = '从电脑里选已有的 .js / .py 文件，复制进脚本目录并登记（可多选）'
  importBtn.addEventListener('click', function () {
    scImport()
  })
  tb2.appendChild(importBtn)
  var pasteBtn = document.createElement('button')
  pasteBtn.type = 'button'
  pasteBtn.className = 'dshpet-smp-btn'
  pasteBtn.textContent = '粘贴代码'
  pasteBtn.title = '把剪贴板里的代码存成新脚本（自动预填，可改）'
  pasteBtn.addEventListener('click', function () {
    openScPaste()
  })
  tb2.appendChild(pasteBtn)
  var exBtn = document.createElement('button')
  exBtn.type = 'button'
  exBtn.className = 'dshpet-smp-btn'
  exBtn.textContent = '示例'
  exBtn.title = '示例库：可新建/编辑/删除示例，选中后能导入到脚本目录'
  exBtn.addEventListener('click', function () {
    openScExamples()
  })
  tb2.appendChild(exBtn)
  var spacer2 = document.createElement('span')
  spacer2.style.flex = '1'
  tb2.appendChild(spacer2)
  var dirBtn = document.createElement('button')
  dirBtn.type = 'button'
  dirBtn.className = 'dshpet-smp-btn'
  dirBtn.textContent = '选择/更换目录'
  dirBtn.addEventListener('click', async function () {
    if (bridge && bridge.dirSet) {
      var r = await bridge.dirSet()
      if (r && r.ok) {
        await scRefresh()
        scSetStatus(r.adopted > 0 ? '已更换目录，自动收编 ' + r.adopted + ' 个新脚本' : '已更换目录')
      } else if (r && r.error !== 'cancelled') scSetStatus(r.error || '选择目录失败')
    }
  })
  tb2.appendChild(dirBtn)
  var openBtn = document.createElement('button')
  openBtn.type = 'button'
  openBtn.className = 'dshpet-smp-btn'
  openBtn.textContent = '打开目录'
  openBtn.addEventListener('click', function () {
    if (bridge && bridge.openDir) bridge.openDir()
  })
  tb2.appendChild(openBtn)
  var scanBtn = document.createElement('button')
  scanBtn.type = 'button'
  scanBtn.className = 'dshpet-smp-btn'
  scanBtn.textContent = '重新扫描'
  scanBtn.addEventListener('click', function () {
    scRescan()
  })
  tb2.appendChild(scanBtn)
  box.appendChild(tb2)

  var main = document.createElement('div')
  main.className = 'dshpet-smp-main'

  scListEl = document.createElement('div')
  scListEl.className = 'dshpet-smp-list'
  main.appendChild(scListEl)

  var right = document.createElement('div')
  right.className = 'dshpet-smp-right'

  var tabs = document.createElement('div')
  tabs.className = 'dshpet-smp-tabs'
  scTabEditEl = document.createElement('button')
  scTabEditEl.type = 'button'
  scTabEditEl.className = 'dshpet-smp-tab dshpet-smp-tab-sel'
  scTabEditEl.textContent = '编辑'
  scTabEditEl.addEventListener('click', function () {
    scSetTab('edit')
  })
  tabs.appendChild(scTabEditEl)
  scTabLogEl = document.createElement('button')
  scTabLogEl.type = 'button'
  scTabLogEl.className = 'dshpet-smp-tab'
  scTabLogEl.textContent = '运行日志'
  scTabLogEl.addEventListener('click', function () {
    scSetTab('log')
  })
  tabs.appendChild(scTabLogEl)
  right.appendChild(tabs)

  var bar = document.createElement('div')
  bar.className = 'dshpet-smp-editor-bar'
  var saveBtn = document.createElement('button')
  saveBtn.type = 'button'
  saveBtn.className = 'dshpet-smp-btn dshpet-smp-btn-primary'
  saveBtn.textContent = '保存'
  saveBtn.addEventListener('click', function () {
    scSaveCode()
  })
  bar.appendChild(saveBtn)
  // 阶段二：在 VS Code 中打开（没装 VS Code 就自动改用系统默认程序）
  var vsBtn = document.createElement('button')
  vsBtn.type = 'button'
  vsBtn.className = 'dshpet-smp-btn'
  vsBtn.textContent = '在 VS Code 中打开'
  vsBtn.title = '没找到 VS Code 时会自动用系统默认程序打开（如记事本）'
  vsBtn.addEventListener('click', async function () {
    if (!scSelId) {
      scSetStatus('先在左侧选中一个脚本')
      return
    }
    var item = scItemById(scSelId)
    if (!item) return
    if (scDirty) {
      var ok = false
      try {
        ok = window.confirm('有未保存的改动。\n\n确定 = 先保存，再打开\n取消 = 不做任何事')
      } catch (err) {
        ok = true
      }
      if (!ok) return
      await scSaveCode()
      if (scDirty) return // 保存失败，状态条里已有原因
    }
    if (bridge && bridge.openEditor) {
      var r = await bridge.openEditor(scSelId)
      if (r && r.ok) {
        scSetStatus(r.how === 'default' ? '没找到 VS Code，已用系统默认程序打开 ' + item.file : '已在 VS Code 中打开 ' + item.file)
      } else {
        scSetStatus((r && r.error) || '打开失败')
      }
    }
  })
  bar.appendChild(vsBtn)
  scDirtyEl = document.createElement('span')
  scDirtyEl.className = 'dshpet-smp-hint'
  bar.appendChild(scDirtyEl)
  right.appendChild(bar)

  scCodeEl = document.createElement('textarea')
  scCodeEl.className = 'dshpet-smp-editor'
  scCodeEl.spellcheck = false
  scCodeEl.placeholder = '选中左侧脚本开始编辑'
  scCodeEl.addEventListener('input', function () {
    scSetDirty(true)
  })
  right.appendChild(scCodeEl)

  scLogEl = document.createElement('div')
  scLogEl.className = 'dshpet-smp-log'
  scLogEl.style.display = 'none'
  right.appendChild(scLogEl)

  main.appendChild(right)
  box.appendChild(main)

  scStatusEl = document.createElement('div')
  scStatusEl.className = 'dshpet-smp-status'
  box.appendChild(scStatusEl)

  scRoot.appendChild(box)
  scPanelEl = box
  scRefresh()
  return box
}

// 脚本输出订阅：只关心「当前面板开着 + 日志页 + 选中脚本」的行，别的丢弃（有环形缓冲兜底）
if (bridge && bridge.onScriptLog) {
  bridge.onScriptLog(function (batch) {
    if (!scPanelEl || !scLogEl || scTab !== 'log' || !scSelId) return
    if (!Array.isArray(batch)) batch = [batch]
    for (var i = 0; i < batch.length; i++) {
      var p = batch[i]
      if (p && p.id === scSelId) appendScLogLine(p)
    }
    scAutoScroll()
  })
}

// 诊断对象（供调试端点读取面板状态）
window.__jiaobenScr = {
  mount: mountJiaobenPanel,
  close: closeScriptPanel,
  panelRect: function () {
    if (!scPanelEl) return null
    var b = scPanelEl.getBoundingClientRect()
    return { l: Math.round(b.left), t: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }
  },
  state: function () {
    return { dir: scDir, count: scItems.length, selId: scSelId, tab: scTab, dirty: scDirty }
  },
}

export { mountJiaobenPanel }
