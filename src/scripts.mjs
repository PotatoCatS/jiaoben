// ============================================================================
// scripts.mjs —— jiaoben 脚本管理器核心引擎（零依赖，可跑在任何 Node ≥ 22 宿主）
// ============================================================================
// 职责两块：
//   1) 花名册存储：data/scripts.json 只存元数据（id/文件名/语言/定时配置…），
//      脚本文件本体在用户自选的「脚本目录」里，宿主不碰文件内容之外的任何事。
//   2) 运行器：每个脚本单独 spawn 一个**子进程**，跟宿主隔离。
//      * JS 脚本 → process.execPath + ELECTRON_RUN_AS_NODE=1：
//        在 Electron 宿主里等于用内置 Node 跑（开发版/打包版通用，不依赖用户装 Node）；
//        在纯 Node 宿主里就是 node.exe 自己。
//      * Python 脚本 → 系统里的 python（detectPython 按 py -3 → py → python 探测，
//        也允许用户自填解释器路径，probePython 验证后优先）。
//
// 与宿主的边界只有四个注入点（都在构造函数参数里）：
//   dataDir（数据目录）· log(msg)（宿主日志）· sendLog(batch)（输出推给 UI 的通道）
//   · getPython()（解释器解析）。除此之外只用 Node 内置模块。
//
// 日志管道（两个坑的取舍，都显式做掉）：
//   * 脚本一秒 print 几百行时，逐行推 IPC 会刷爆 → 攒 100ms 批量发（FLUSH_MS）。
//   * 面板经常是关着的 → 给每个脚本留 500 行环形缓冲，面板打开先拉历史再订阅增量。
//
// 停止语义：停止 = taskkill /T /F 杀**整个进程树**（脚本自己开的子进程一起带走），
// 保证「停止」按钮永远有效。用户主动停止会先打 exitRequested 标记，长驻自动拉起
// 逻辑靠这个标记区分「人停的」和「崩的」。
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'

const FILE_NAME = 'scripts.json'
const MAX_SCRIPTS = 100
const LOG_MAX = 500 // 每个脚本的环形缓冲行数
const FLUSH_MS = 100 // 日志批量推送间隔

function pad2(n) {
  return String(n).padStart(2, '0')
}

/** 供日志时间戳用（本地时间，和提醒模块一致的取向） */
function hms(ms) {
  const d = new Date(ms)
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
}

/** 按扩展名猜语言；不认识的当 JS（阶段二导入时会再校验） */
export function langOf(file) {
  const n = String(file || '').toLowerCase()
  if (n.endsWith('.py')) return 'py'
  return 'js'
}

/**
 * 检测电脑上的 Python：按 py -3 → py → python 的顺序，以「能打印出版本号」为准。
 * 为什么是这个顺序：没装 Python 的 Windows 上敲 `python` 会触发微软商店占位符
 * （app execution alias），先试 py 启动器能绕开这个坑。py 启动器不存在（execFile
 * 报 ENOENT）就往后顺延，最后才试裸 `python`。
 * 返回 { ok:true, cmd, args, version } 或 { ok:false }。
 */
export function detectPython({ log = function () {} } = {}) {
  const candidates = [
    { cmd: 'py', args: ['-3', '--version'] },
    { cmd: 'py', args: ['--version'] },
    { cmd: 'python', args: ['--version'] },
  ]
  function tryOne(c) {
    return new Promise(function (resolve) {
      execFile(c.cmd, c.args, { windowsHide: true, timeout: 6000, maxBuffer: 64 * 1024 }, function (err, stdout) {
        const ver = String(stdout || '').trim()
        if (!err && /python/i.test(ver)) {
          resolve({ ok: true, cmd: c.cmd, args: c.args.slice(0, -1), version: ver })
        } else {
          resolve(null)
        }
      })
    })
  }
  return (async function () {
    for (const c of candidates) {
      try {
        const hit = await tryOne(c)
        if (hit) {
          log('[script] Python 检测成功: ' + hit.cmd + (hit.args.length ? ' ' + hit.args.join(' ') : '') + ' → ' + hit.version)
          return hit
        }
      } catch (err) {}
    }
    log('[script] Python 检测失败（py -3 / py / python 都拿不到版本号）')
    return { ok: false }
  })()
}

// ============================================================================
// cron 解析（阶段三）：5 字段（分 时 日 月 周），支持 * , - */N 与单值，不引 npm 依赖。
// 两条语义约定（计划书拍板）：
//   * 日和周两个字段**同时受限**时按经典 cron 取「或」——任一匹配就触发；
//   * 无解表达式（如 2 月 30 日）在算下次运行时直接报「没有有效时间」，不空转四年。
// ============================================================================

const CRON_RANGES = [
  { name: '分', min: 0, max: 59 },
  { name: '时', min: 0, max: 23 },
  { name: '日', min: 1, max: 31 },
  { name: '月', min: 1, max: 12 },
  { name: '周', min: 0, max: 7 }, // 0 与 7 都表示周日，解析后统一成 0
]

function cronFieldSet(field, def) {
  const parts = String(field).split(',')
  const out = []
  for (const raw of parts) {
    const p = raw.trim()
    if (!p) return { ok: false, error: '「' + def.name + '」字段里有空项：' + field }
    let start = null
    let end = null
    let step = null
    const mSlash = p.match(/^(.+)\/(\d+)$/)
    if (mSlash) {
      step = Number(mSlash[2])
      if (!(step >= 1)) return { ok: false, error: '「' + def.name + '」步长要 ≥ 1：' + p }
      const base = mSlash[1]
      if (base === '*') {
        start = def.min
        end = def.max
      } else {
        const mRange = base.match(/^(\d+)-(\d+)$/)
        if (!mRange) return { ok: false, error: '「' + def.name + '」写法不认识：' + p }
        start = Number(mRange[1])
        end = Number(mRange[2])
      }
    } else if (p === '*') {
      start = def.min
      end = def.max
      step = 1
    } else if (/^\d+$/.test(p)) {
      start = Number(p)
      end = start
      step = 1
    } else {
      const mRange = p.match(/^(\d+)-(\d+)$/)
      if (!mRange) return { ok: false, error: '「' + def.name + '」写法不认识：' + p + '（支持 * , - */N 和数字）' }
      start = Number(mRange[1])
      end = Number(mRange[2])
      step = 1
    }
    if (start < def.min || start > def.max || end < def.min || end > def.max) {
      return { ok: false, error: '「' + def.name + '」取值超范围（' + def.min + '-' + (def.name === '周' ? 6 : def.max) + '）：' + p }
    }
    if (start > end) return { ok: false, error: '「' + def.name + '」范围起始大于结束：' + p + '（不支持 5-2 这种回绕写法）' }
    for (let v = start; v <= end; v += step) out.push(v)
  }
  out.sort(function (a, b) { return a - b })
  // 去重（',1,1,5' 这种重复写不报错，只收一次）
  const set = out.filter(function (v, i) { return i === 0 || out[i - 1] !== v })
  return { ok: true, set: set, restricted: String(field).trim() !== '*' }
}

/**
 * 解析 cron 表达式为 5 组允许值集合。
 * 返回 { ok:true, min,hour,day,month,dow, dayRestricted, dowRestricted, expr }
 * 或 { ok:false, error }（error 直接给人看）。
 */
export function parseCron(expr) {
  const parts = String(expr == null ? '' : expr).trim().split(/\s+/)
  if (parts.length === 1 && !parts[0]) return { ok: false, error: '表达式为空，先写一个吧（例如 */5 * * * *）' }
  if (parts.length !== 5) {
    return { ok: false, error: '需要 5 个字段（分 时 日 月 周），现在有 ' + parts.length + ' 个' }
  }
  const fields = []
  for (let i = 0; i < 5; i++) {
    const r = cronFieldSet(parts[i], CRON_RANGES[i])
    if (!r.ok) return r
    fields.push(r)
  }
  // 周字段 7 → 0（都表示周日）
  const dowSet = fields[4].set.map(function (v) { return v === 7 ? 0 : v })
  fields[4].set = Array.from(new Set(dowSet)).sort(function (a, b) { return a - b })
  return {
    ok: true,
    expr: parts.join(' '),
    min: fields[0].set,
    hour: fields[1].set,
    day: fields[2].set,
    month: fields[3].set,
    dow: fields[4].set,
    dayRestricted: fields[2].restricted,
    dowRestricted: fields[4].restricted,
  }
}

/** 某一天（Date）是否满足日/月/周三个字段（含日与周的「或」语义） */
function cronDayMatches(parsed, d) {
  const day = d.getDate()
  const dow = d.getDay()
  const month = d.getMonth() + 1
  if (parsed.month.indexOf(month) < 0) return false
  if (parsed.dayRestricted && parsed.dowRestricted) {
    // 日和周同时受限：任一匹配就算这天行
    return parsed.day.indexOf(day) >= 0 || parsed.dow.indexOf(dow) >= 0
  }
  if (parsed.dayRestricted && parsed.day.indexOf(day) < 0) return false
  if (parsed.dowRestricted && parsed.dow.indexOf(dow) < 0) return false
  return true
}

/** 某分钟（ms）是否命中表达式——调度器每秒 tick 就用这个 */
export function cronMatchesMinute(parsed, ms) {
  const d = new Date(ms)
  if (parsed.min.indexOf(d.getMinutes()) < 0) return false
  if (parsed.hour.indexOf(d.getHours()) < 0) return false
  return cronDayMatches(parsed, d)
}

/**
 * 从 fromMs 之后算下一次触发时间。
 * 实现：按天扫（最多 4 年，约 1461 天），命中日再按小时/分钟用纯整数找，
 * 无解表达式也能很快返回「没有有效时间」，不会空转四年。
 * 返回 { ok:true, time } 或 { ok:false, error }。
 */
export function cronNextParsed(parsed, fromMs) {
  const startMin = Math.floor(fromMs / 60000) + 1 // 从「下一分钟」起算，不算当前这分钟
  const startDate = new Date(startMin * 60000)
  const day0 = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate())
  const dayMax = new Date(day0.getFullYear() + 4, day0.getMonth(), day0.getDate())
  for (const d = new Date(day0.getTime()); d < dayMax; d.setDate(d.getDate() + 1)) {
    if (!cronDayMatches(parsed, d)) continue
    const isFirst = d.getTime() === day0.getTime()
    const hStart = isFirst ? startDate.getHours() : 0
    const mStart = isFirst ? startDate.getMinutes() : 0
    for (let h = hStart; h <= 23; h++) {
      if (parsed.hour.indexOf(h) < 0) continue
      const m0 = h === hStart ? mStart : 0
      for (let m = m0; m <= 59; m++) {
        if (parsed.min.indexOf(m) < 0) continue
        return { ok: true, time: new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0).getTime() }
      }
    }
  }
  return { ok: false, error: '没有有效时间（近 4 年里没有一次能触发，比如 2 月 30 日就是无解的）' }
}

/** 表达式 + 起始时刻 → 下次触发时间（先解析再算，错误直接带原因） */
export function cronNext(expr, fromMs) {
  const parsed = parseCron(expr)
  if (!parsed.ok) return parsed
  return cronNextParsed(parsed, fromMs)
}

/** 校验某个可执行文件是不是能用的 Python（自填路径用）：能打印出版本号才算数 */
export function probePython(cmd) {
  return new Promise(function (resolve) {
    execFile(cmd, ['--version'], { windowsHide: true, timeout: 6000, maxBuffer: 64 * 1024 }, function (err, stdout) {
      const ver = String(stdout || '').trim()
      if (!err && /python/i.test(ver)) resolve({ ok: true, version: ver })
      else resolve({ ok: false })
    })
  })
}

function sanitize(input, now) {
  if (!input || typeof input !== 'object') return null
  const name = String(input.name || '').trim().slice(0, 120)
  if (!name) return null
  const lang = input.lang === 'py' ? 'py' : 'js'
  const file = String(input.file || name)
  return {
    id: String(input.id || 'sc_' + now.toString(36) + Math.random().toString(36).slice(2, 6)),
    name: name,
    file: file,
    lang: lang,
    cron: typeof input.cron === 'string' && input.cron.trim() ? input.cron.trim() : null, // 阶段三：cron 表达式
    cronCatchUp: input.cronCatchUp === true, // 阶段三：开机补跑一次（错过策略可配置）
    onStartup: input.onStartup === true, // 阶段三：随应用启动
    daemon: input.daemon === true, // 阶段三：长驻自动拉起
    closeAfterRun: input.closeAfterRun === true, // 阶段三：启动成功后自动收起脚本管理器面板
    createdAt: Number(input.createdAt) || now,
    updatedAt: Number(input.updatedAt) || now,
  }
}

export function createScriptsStore({ dataDir, log = function () {} }) {
  const file = path.join(dataDir, FILE_NAME)

  function read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      const now = Date.now()
      const items = Array.isArray(parsed && parsed.items)
        ? parsed.items.map(function (i) { return sanitize(i, now) }).filter(Boolean)
        : []
      return {
        dir: typeof (parsed && parsed.dir) === 'string' && parsed.dir ? parsed.dir : null,
        items: items,
        // 「不收编」名单：从列表删除但保留文件时记下文件名，重新扫描时跳过它，
        // 否则刚删掉的条目又会被对账捡回来。
        excluded: Array.isArray(parsed && parsed.excluded)
          ? parsed.excluded.filter(function (f) { return typeof f === 'string' })
          : [],
        // 阶段三：Python 自填路径（优先于自动检测；''/null 表示没自填）
        pythonPath: typeof (parsed && parsed.pythonPath) === 'string' && parsed.pythonPath ? parsed.pythonPath : null,
      }
    } catch (err) {
      return { dir: null, items: [], excluded: [], pythonPath: null }
    }
  }

  function write(cfg) {
    const body = JSON.stringify(
      {
        version: 1,
        updatedAt: new Date().toISOString(),
        dir: cfg.dir,
        items: cfg.items,
        excluded: cfg.excluded || [],
        pythonPath: cfg.pythonPath || null,
      },
      null,
      2,
    )
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = file + '.tmp-' + process.pid
    fs.writeFileSync(tmp, body, 'utf8')
    fs.renameSync(tmp, file)
    return cfg
  }

  return {
    file: file,
    read: read,
    setDir: function (dir) {
      const cfg = read()
      cfg.dir = dir
      // 换目录 = 换地盘，「不收编」名单是跟着旧目录记的，作废重来
      cfg.excluded = []
      write(cfg)
      return cfg
    },
    save: function (input) {
      const cfg = read()
      const clean = sanitize(input, Date.now())
      if (!clean) return { ok: false, error: '脚本名不能为空' }
      const i = cfg.items.findIndex(function (x) { return x.id === clean.id })
      if (i >= 0) {
        clean.createdAt = cfg.items[i].createdAt || clean.createdAt
        cfg.items[i] = clean
      } else {
        if (cfg.items.length >= MAX_SCRIPTS) return { ok: false, error: '最多 ' + MAX_SCRIPTS + ' 个脚本' }
        // 花名册按文件名唯一，避免两个条目指向同一个文件
        if (cfg.items.some(function (x) { return x.file === clean.file })) {
          return { ok: false, error: '已存在同名脚本文件：' + clean.file }
        }
        cfg.items.push(clean)
      }
      // 重新登记 = 收编回来，从「不收编」名单里拿掉
      cfg.excluded = (cfg.excluded || []).filter(function (f) {
        return String(f).toLowerCase() !== clean.file.toLowerCase()
      })
      write(cfg)
      return { ok: true, item: clean, items: cfg.items, dir: cfg.dir }
    },
    remove: function (id, deleteFile) {
      const cfg = read()
      const item = cfg.items.find(function (x) { return x.id === id })
      if (!item) return { ok: false, error: '找不到该脚本' }
      cfg.items = cfg.items.filter(function (x) { return x.id !== id })
      let deletedFile = false
      if (deleteFile && cfg.dir) {
        try {
          const p = path.join(cfg.dir, item.file)
          if (fs.existsSync(p)) {
            fs.unlinkSync(p)
            deletedFile = true
          }
        } catch (err) {
          log('[script] 删除文件失败: ' + ((err && err.message) || err))
        }
      } else {
        // 只移出花名册：记进「不收编」名单，否则重新扫描会把文件捡回来
        cfg.excluded = cfg.excluded || []
        const low = item.file.toLowerCase()
        if (!cfg.excluded.some(function (f) { return String(f).toLowerCase() === low })) {
          cfg.excluded.push(item.file)
        }
      }
      write(cfg)
      return { ok: true, items: cfg.items, dir: cfg.dir, deletedFile: deletedFile }
    },
    /**
     * 重新扫描：列表和目录对账。只收编目录**一级**的 .js / .py 新文件
     * （子目录不动——以后放示例/资源的地方），文件名按大小写不敏感去重；
     * 「找不到文件」的旧条目按计划不自动删，留给用户自己决定。
     */
    rescan: function () {
      const cfg = read()
      if (!cfg.dir) return { ok: false, error: '请先选择脚本目录' }
      let entries = []
      try {
        entries = fs
          .readdirSync(cfg.dir, { withFileTypes: true })
          .filter(function (d) { return d.isFile() })
          .map(function (d) { return d.name })
      } catch (err) {
        return { ok: false, error: '读取目录失败: ' + ((err && err.message) || err) }
      }
      const known = {}
      cfg.items.forEach(function (x) { known[String(x.file).toLowerCase()] = true })
      ;(cfg.excluded || []).forEach(function (f) { known[String(f).toLowerCase()] = true })
      const EXT = { '.js': 'js', '.py': 'py' }
      const added = []
      const self = this
      for (const f of entries) {
        const dot = f.lastIndexOf('.')
        if (dot <= 0) continue
        const lang = EXT[f.slice(dot).toLowerCase()]
        if (!lang) continue
        if (known[f.toLowerCase()]) continue
        const res = self.save({ name: f.slice(0, dot), file: f, lang: lang })
        if (res.ok) {
          added.push(res.item)
          known[f.toLowerCase()] = true
        }
      }
      return { ok: true, added: added, dir: cfg.dir, items: read().items }
    },
    /** 克隆：复制文件生成「xxx 副本.js」（撞名自动加 2、3…），并登记花名册 */
    clone: function (id) {
      const cfg = read()
      const item = cfg.items.find(function (x) { return x.id === id })
      if (!item) return { ok: false, error: '找不到该脚本' }
      if (!cfg.dir) return { ok: false, error: '请先选择脚本目录' }
      if (cfg.items.length >= MAX_SCRIPTS) return { ok: false, error: '最多 ' + MAX_SCRIPTS + ' 个脚本' }
      const dot = item.file.lastIndexOf('.')
      const base = dot > 0 ? item.file.slice(0, dot) : item.file
      const ext = dot > 0 ? item.file.slice(dot) : ''
      const srcPath = path.join(cfg.dir, item.file)
      if (!fs.existsSync(srcPath)) return { ok: false, error: '找不到源文件，无法克隆' }
      const taken = {}
      cfg.items.forEach(function (x) { taken[String(x.file).toLowerCase()] = true })
      let newFile = null
      for (let n = 0; n < 100; n++) {
        const cand = base + ' 副本' + (n ? String(n + 1) : '') + ext
        if (!taken[cand.toLowerCase()] && !fs.existsSync(path.join(cfg.dir, cand))) {
          newFile = cand
          break
        }
      }
      if (!newFile) return { ok: false, error: '副本名占满了，先清理几个再试' }
      try {
        fs.copyFileSync(srcPath, path.join(cfg.dir, newFile))
      } catch (err) {
        return { ok: false, error: '复制文件失败: ' + ((err && err.message) || err) }
      }
      const res = this.save({ name: newFile.slice(0, newFile.length - ext.length), file: newFile, lang: item.lang })
      if (!res.ok) return res
      return { ok: true, item: res.item }
    },
    /** 重命名：文件在磁盘上真改名，花名册同步更新（扩展名保持原样） */
    rename: function (id, newBase) {
      const cfg = read()
      const item = cfg.items.find(function (x) { return x.id === id })
      if (!item) return { ok: false, error: '找不到该脚本' }
      if (!cfg.dir) return { ok: false, error: '请先选择脚本目录' }
      let base = String(newBase == null ? '' : newBase).trim()
      // 允许用户顺手带上扩展名输入，统一摘掉，按原扩展名拼
      base = base.replace(/\.(js|py)$/i, '')
      base = base.slice(0, 120)
      if (!base) return { ok: false, error: '名字不能为空' }
      if (/[\\/:*?"<>|]/.test(base)) return { ok: false, error: '名字里不能有 \\ / : * ? " < > | 这些字符' }
      const dot = item.file.lastIndexOf('.')
      const ext = dot > 0 ? item.file.slice(dot) : ''
      const newFile = base + ext
      const lowNew = newFile.toLowerCase()
      const lowOld = item.file.toLowerCase()
      if (lowNew !== lowOld) {
        if (cfg.items.some(function (x) { return x.id !== id && x.file.toLowerCase() === lowNew })) {
          return { ok: false, error: '已有同名脚本：' + newFile }
        }
        if (fs.existsSync(path.join(cfg.dir, newFile))) {
          return { ok: false, error: '目录里已有同名文件：' + newFile }
        }
      }
      try {
        fs.renameSync(path.join(cfg.dir, item.file), path.join(cfg.dir, newFile))
      } catch (err) {
        return { ok: false, error: '改名失败（脚本在运行时会锁住文件，先停止再试）: ' + ((err && err.message) || err) }
      }
      item.name = base
      item.file = newFile
      item.updatedAt = Date.now()
      write(cfg)
      return { ok: true, item: item, items: cfg.items, dir: cfg.dir }
    },
    /**
     * 导入：把任意路径上的 .js/.py 文件复制进脚本目录一级，并登记花名册
     * （阶段二「本地文件导入」和「内置示例导入」共用）。
     * 撞名自动加序号（xxx 2.js、xxx 3.js…），不会覆盖目录里已有的文件。
     */
    importFile: function (srcPath) {
      const cfg = read()
      if (!cfg.dir) return { ok: false, error: '请先选择脚本目录' }
      const baseName = path.basename(String(srcPath || ''))
      const dot = baseName.lastIndexOf('.')
      const ext = dot > 0 ? baseName.slice(dot).toLowerCase() : ''
      if (ext !== '.js' && ext !== '.py') return { ok: false, error: '只支持导入 .js / .py 文件：' + baseName }
      if (cfg.items.length >= MAX_SCRIPTS) return { ok: false, error: '最多 ' + MAX_SCRIPTS + ' 个脚本' }
      const stem = dot > 0 ? baseName.slice(0, dot) : baseName
      const taken = {}
      cfg.items.forEach(function (x) { taken[String(x.file).toLowerCase()] = true })
      let target = null
      for (let n = 0; n < 1000; n++) {
        const cand = stem + (n ? ' ' + String(n + 1) : '') + ext
        if (!taken[cand.toLowerCase()] && !fs.existsSync(path.join(cfg.dir, cand))) {
          target = cand
          break
        }
      }
      if (!target) return { ok: false, error: '导入名占满了，先清理几个再试' }
      try {
        fs.copyFileSync(srcPath, path.join(cfg.dir, target))
      } catch (err) {
        return { ok: false, error: '复制文件失败: ' + ((err && err.message) || err) }
      }
      const res = this.save({ name: target.slice(0, target.length - ext.length), file: target, lang: ext === '.py' ? 'py' : 'js' })
      if (!res.ok) return res
      return { ok: true, item: res.item, file: target }
    },
    /** 阶段三：Python 自填路径（保存前主进程会先 probePython 验证，这里只负责落盘） */
    setPythonPath: function (p) {
      const cfg = read()
      cfg.pythonPath = typeof p === 'string' && p ? p : null
      write(cfg)
      return cfg
    },
    clearPythonPath: function () {
      const cfg = read()
      cfg.pythonPath = null
      write(cfg)
      return cfg
    },
  }
}

// 启动意图 → 系统日志里的中文标签（手动运行不标注，保持老日志干净）
const INTENT_LABEL = { manual: '', startup: '随启动', cron: '定时', daemon: '长驻' }

/**
 * 运行器：管理所有在跑的子进程与日志缓冲。
 * @param {object} opts
 *   store    —— createScriptsStore 的返回值（读花名册/目录用）
 *   sendLog  —— 批量日志回调（main.js 里转 webContents.send）
 *   getPython—— 阶段三接入的 Python 检测函数；返回 null 表示禁用 .py 运行
 *   log      —— 主进程日志函数
 */
export function createScriptRunner({ store, sendLog = function () {}, getPython = function () { return null }, log = function () {} }) {
  const running = new Map() // scriptId -> [instance, ...]
  const buffers = new Map() // scriptId -> [{kind,text,ts}]
  let seq = 0
  let pending = []
  let flushTimer = null

  function queueLine(id, payload) {
    pending.push({ id: id, kind: payload.kind, text: String(payload.text || ''), ts: payload.ts || Date.now() })
    if (!flushTimer) {
      flushTimer = setInterval(flush, FLUSH_MS)
      if (flushTimer.unref) flushTimer.unref()
    }
  }

  function flush() {
    if (!pending.length) return
    const batch = pending
    pending = []
    // 先落缓冲（面板关了也能查到），再推渲染进程
    batch.forEach(function (p) {
      let arr = buffers.get(p.id)
      if (!arr) {
        arr = []
        buffers.set(p.id, arr)
      }
      arr.push(p)
      if (arr.length > LOG_MAX) arr.splice(0, arr.length - LOG_MAX)
    })
    try {
      sendLog(batch)
    } catch (err) {}
  }

  function history(id) {
    return buffers.get(id) || []
  }

  function status() {
    const out = {}
    running.forEach(function (list, id) {
      out[id] = list.map(function (t) {
        return {
          inst: t.inst,
          startedAt: t.startedAt,
          exitRequested: t.exitRequested,
          pid: t.child && t.child.pid ? t.child.pid : null,
        }
      })
    })
    return out
  }

  function killTree(pid) {
    return new Promise(function (resolve) {
      if (!pid) return resolve(false)
      if (process.platform === 'win32') {
        // /T 杀整棵树 /F 强杀；进程已经死了也会报错，一律算「已不在跑」
        execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, function () {
          resolve(true)
        })
      } else {
        try {
          process.kill(pid, 'SIGKILL')
        } catch (err) {}
        resolve(true)
      }
    })
  }

  /**
   * 跑一个脚本实例。
   * @param {object} item 花名册条目
   * @param {string} dir  脚本目录（cwd 也用它，脚本里的相对路径才能找到旁边的文件）
   * @param {object} opts { intent: 'manual'|'startup'|'daemon'|'cron', onExit, timeoutMs, label }
   *   timeoutMs > 0 时到点强杀（定时运行 10 分钟超时；手动/随启动/长驻不设）
   *   label 覆盖启动行里的意图标签（如补跑要标「开机补跑」而不是笼统的「定时」）
   */
  function runOne(item, dir, opts) {
    opts = opts || {}
    const id = item.id
    const filePath = path.join(dir, item.file)
    let cmd = null
    let args = null
    const env = Object.assign({}, process.env)

    if (item.lang === 'py') {
      // getPython() 返回 [cmd, ...args]（如 ['py','-3'] 或 ['python']），null 表示没检测到
      const pyArr = getPython()
      if (!pyArr) return { ok: false, error: '没有检测到 Python，暂时只能运行 JS 脚本' }
      cmd = pyArr[0]
      args = pyArr.slice(1).concat([filePath])
      env.PYTHONIOENCODING = 'utf-8' // 否则 Windows 上 Python 默认 GBK 输出，中文会乱码
    } else {
      cmd = process.execPath
      args = [filePath]
      env.ELECTRON_RUN_AS_NODE = '1'
    }

    let child = null
    try {
      child = spawn(cmd, args, {
        cwd: dir,
        env: env,
        windowsHide: true, // 脚本不弹黑窗口（web-launcher 里踩过 detached 的坑，这里不 detached）
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) }
    }

    const inst = {
      id: id,
      inst: 's' + (++seq),
      startedAt: Date.now(),
      exitRequested: false,
      child: child,
      intent: opts.intent || 'manual',
      timeoutTimer: null,
    }
    if (!running.has(id)) running.set(id, [])
    running.get(id).push(inst)

    const label = opts.label || INTENT_LABEL[inst.intent] || ''
    queueLine(id, { kind: 'sys', text: '▶ 启动 ' + item.name + '（实例 ' + inst.inst + '，pid ' + child.pid + (label ? '，' + label : '') + '）' })

    // 超时强杀：定时运行 10 分钟封顶，防止脚本死循环把宿主拖累
    if (opts.timeoutMs > 0) {
      inst.timeoutTimer = setTimeout(function () {
        if (inst.timeoutTimer) {
          inst.timeoutTimer = null
          queueLine(id, { kind: 'err', text: '⏰ 运行超过 ' + Math.round(opts.timeoutMs / 60000) + ' 分钟，超时强制停止（实例 ' + inst.inst + '）' })
          killTree(child.pid)
        }
      }, opts.timeoutMs)
      if (inst.timeoutTimer.unref) inst.timeoutTimer.unref()
    }

    child.stdout.on('data', function (chunk) {
      queueLine(id, { kind: 'out', text: String(chunk) })
    })
    child.stderr.on('data', function (chunk) {
      queueLine(id, { kind: 'err', text: String(chunk) })
    })

    // spawn 失败（如阶段三 Python 路径不存在）只会发 error、不发 exit，
    // 这里统一收尾，避免运行表里留下僵尸条目。
    function finish(code, signal) {
      if (inst.timeoutTimer) {
        clearTimeout(inst.timeoutTimer)
        inst.timeoutTimer = null
      }
      flush() // 退出前把积压的日志推出去，保证顺序
      const list = running.get(id) || []
      const idx = list.indexOf(inst)
      if (idx >= 0) list.splice(idx, 1)
      if (!list.length) running.delete(id)
      queueLine(id, {
        kind: 'exit',
        text: '■ 结束 ' + item.name + '（实例 ' + inst.inst + '）' + (code === null ? '启动失败' : 'code=' + code + (signal ? ' signal=' + signal : '')),
      })
      flush()
      if (typeof opts.onExit === 'function') {
        try {
          opts.onExit({ item: item, inst: inst.inst, code: code, signal: signal, exitRequested: inst.exitRequested, intent: inst.intent })
        } catch (err) {}
      }
    }
    child.on('error', function (err) {
      queueLine(id, { kind: 'err', text: '启动失败: ' + ((err && err.message) || err) })
      finish(null, null)
    })
    child.on('exit', function (code, signal) {
      finish(code, signal)
    })

    return { ok: true, inst: inst.inst }
  }

  /** 停止：instId 给则只停那个实例，不给则停该脚本全部实例 */
  function stop(id, instId) {
    const list = running.get(id) || []
    const targets = instId ? list.filter(function (t) { return t.inst === instId }) : list.slice()
    if (!targets.length) return Promise.resolve({ ok: false, error: '没有在运行的实例', stopped: 0 })
    targets.forEach(function (t) { t.exitRequested = true })
    return Promise.all(targets.map(function (t) { return killTree(t.child && t.child.pid) })).then(function () {
      return { ok: true, stopped: targets.length }
    })
  }

  /** 宿主退出前调用：杀掉全部子进程，返回 Promise（before-quit 里 await 完再放行退出） */
  function stopAll() {
    const all = []
    running.forEach(function (list) {
      all.push.apply(all, list)
    })
    if (!all.length) return Promise.resolve(0)
    all.forEach(function (t) { t.exitRequested = true })
    return Promise.all(all.map(function (t) { return killTree(t.child && t.child.pid) })).then(function () {
      if (flushTimer) {
        clearInterval(flushTimer)
        flushTimer = null
      }
      flush()
      return all.length
    })
  }

  return {
    runOne: runOne,
    stop: stop,
    stopAll: stopAll,
    history: history,
    status: status,
    running: function () { return running },
    /** 调度器用：往脚本日志里插一条系统行（如「文件不存在，定时未启动」） */
    sysLine: function (id, text) {
      queueLine(id, { kind: 'sys', text: String(text || '') })
    },
  }
}

// ============================================================================
// 阶段三：定时调度器 + 长驻守护（跑在宿主主进程（Electron 或普通 Node））
// ============================================================================
// 设计要点：
//   * 每秒 tick 一次，只在「分钟数变化」的瞬间检查定时 → 一分钟最多触发一次。
//   * fired 表（'id@minute'）防重，只留最近 5 分钟，防止长期运行涨内存。
//   * 心跳 lastMinute 落盘到 data/scripts-schedule.json：下次开机据此判断
//     「关机期间错过了几个点」。gap ≤ 1 分钟不动（可能是同分钟重启），
//     超过 7 天也放弃（太久之前的补跑没意义），中间这段对勾了「开机补跑一次」的
//     脚本，取错过的**最后一次**触发点补跑（intent='cron'，日志标「开机补跑」）。
//   * 长驻守护：daemon 实例意外退出（非用户停止）→ 1 秒后自动拉起；
//     30 秒窗口内崩 3 次 → 停止自动拉起并在列表标红（alarms 表）。
// ============================================================================

const SCHEDULE_STATE_FILE = 'scripts-schedule.json'
const CRON_TIMEOUT_MS = 10 * 60 * 1000 // 定时运行 10 分钟封顶
const CATCHUP_MAX_MIN = 7 * 24 * 60 // 补跑只认 7 天内的错过的点
const CRASH_WINDOW_MS = 30 * 1000 // 长驻冷却窗口
const CRASH_MAX = 3 // 窗口内崩 3 次停止自动拉起
const RELAUNCH_DELAY_MS = 1000 // 意外退出后 1 秒再拉起

export function createScriptScheduler({ store, runner, dataDir, log = function () {}, ready = function () { return Promise.resolve() } }) {
  const stateFile = path.join(dataDir, SCHEDULE_STATE_FILE)
  const alarms = new Map() // scriptId -> 标红文案
  const crashTimes = new Map() // scriptId -> [最近退出时间戳]
  const fired = new Map() // 'id@minute' -> minute（防重，只留最近 5 分钟）
  const cronCache = new Map() // 'id@表达式' -> parseCron 结果
  let timer = null
  let lastMinute = null
  let started = false

  function minOf(ms) {
    return Math.floor(ms / 60000)
  }

  function readState() {
    try {
      const j = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
      return { lastMinute: typeof (j && j.lastMinute) === 'number' ? j.lastMinute : null }
    } catch (err) {
      return { lastMinute: null }
    }
  }

  function writeState() {
    if (lastMinute === null) return
    try {
      const body = JSON.stringify(
        { version: 1, updatedAt: new Date().toISOString(), lastMinute: lastMinute },
        null,
        2,
      )
      fs.mkdirSync(path.dirname(stateFile), { recursive: true })
      const tmp = stateFile + '.tmp-' + process.pid
      fs.writeFileSync(tmp, body, 'utf8')
      fs.renameSync(tmp, stateFile)
    } catch (err) {
      log('调度器心跳写入失败: ' + ((err && err.message) || err))
    }
  }

  function parsedCron(item) {
    const key = item.id + '@' + item.cron
    let p = cronCache.get(key)
    if (!p) {
      const r = parseCron(item.cron)
      if (!r.ok) return null
      p = r
      cronCache.set(key, p)
    }
    return p
  }

  function launch(item, intent, label, timeoutMs) {
    const cfg = store.read()
    if (!cfg.dir) return
    const filePath = path.join(cfg.dir, item.file)
    if (!fs.existsSync(filePath)) {
      runner.sysLine(item.id, '⚠ 文件不存在，' + label + '未启动：' + item.file)
      return
    }
    const res = runner.runOne(item, cfg.dir, {
      intent: intent,
      label: label,
      timeoutMs: timeoutMs || 0,
      // 只有长驻启动的实例挂掉才自动拉起（手动跑的实例不算）
      onExit: intent === 'daemon' ? function (info) { onDaemonExit(item, info) } : undefined,
    })
    if (!res.ok) log('脚本「' + item.name + '」' + label + '启动失败: ' + res.error)
  }

  /** 当前分钟到点：对每个带 cron 的脚本做一次匹配，命中就开跑 */
  function fireCrons(minute) {
    const ms = minute * 60000
    const items = store.read().items
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      if (!it.cron) continue
      const parsed = parsedCron(it)
      if (!parsed) continue
      if (!cronMatchesMinute(parsed, ms)) continue
      const fk = it.id + '@' + minute
      if (fired.has(fk)) continue
      fired.set(fk, minute)
      launch(it, 'cron', '定时', CRON_TIMEOUT_MS)
    }
    // 只留最近 5 分钟的防重记录
    fired.forEach(function (m, k) {
      if (m < minute - 5) fired.delete(k)
    })
  }

  function tick() {
    const minute = minOf(Date.now())
    if (lastMinute !== null && minute <= lastMinute) {
      // 分钟没变，或者系统时钟被往回拨了（回拨就跟着回，别等它自己追上来）
      if (minute < lastMinute) lastMinute = minute
      return
    }
    lastMinute = minute
    writeState()
    fireCrons(minute)
  }

  /** 开机补跑：只补勾了「开机补跑一次」的脚本，取错过的最后一次触发点 */
  function catchUp(stateLastMinute) {
    const nowMin = minOf(Date.now())
    const gap = nowMin - stateLastMinute
    if (gap <= 1) return // 同分钟重启或只差一分钟，不算错过
    if (gap > CATCHUP_MAX_MIN) {
      log('距上次运行超过 7 天，跳过开机补跑（' + gap + ' 分钟）')
      return
    }
    const items = store.read().items
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      if (!it.cron || !it.cronCatchUp) continue
      const parsed = parsedCron(it)
      if (!parsed) continue
      let lastMissed = null
      // 当前分钟由 tick 负责，这里只扫严格错过的（stateLastMinute, nowMin）
      for (let m = stateLastMinute + 1; m < nowMin; m++) {
        if (cronMatchesMinute(parsed, m * 60000)) lastMissed = m
      }
      if (lastMissed !== null) {
        launch(it, 'cron', '开机补跑', CRON_TIMEOUT_MS)
      }
    }
  }

  /** 长驻守护：区分「人停的」和「崩的」 */
  function onDaemonExit(item, info) {
    if (info.exitRequested) {
      crashTimes.delete(item.id)
      return
    }
    const now = Date.now()
    const arr = (crashTimes.get(item.id) || []).filter(function (t) { return now - t <= CRASH_WINDOW_MS })
    arr.push(now)
    crashTimes.set(item.id, arr)
    if (arr.length >= CRASH_MAX) {
      alarms.set(item.id, '30 秒内崩溃 ' + arr.length + ' 次，已停止自动拉起')
      log('长驻脚本「' + item.name + '」连续崩溃 ' + arr.length + ' 次，停止自动拉起')
      return
    }
    log('长驻脚本「' + item.name + '」意外退出（code=' + info.code + '），' + RELAUNCH_DELAY_MS + 'ms 后自动拉起')
    setTimeout(function () {
      if (!started) return // 宿主正在退出（stop() 已清定时器），别在退出路上再拉起
      // 拉起前重读花名册：期间可能已被改名/删除/关掉长驻
      const it = store.read().items.find(function (x) { return x.id === item.id })
      if (!it || !it.daemon) return
      launch(it, 'daemon', '长驻', 0)
    }, RELAUNCH_DELAY_MS)
  }

  function start() {
    if (started) return
    started = true
    const state = readState()
    const stateLastMinute = state.lastMinute
    // 当前分钟交给 tick 的自然触发；没跑过（无状态文件）就把当前分钟记成基线，不触发
    lastMinute = typeof stateLastMinute === 'number' ? stateLastMinute : minOf(Date.now())
    timer = setInterval(tick, 1000)
    if (timer.unref) timer.unref()
    // 随启动 + 长驻 + 开机补跑，等 Python 检测（ready）落定再开跑，最多等 3 秒
    Promise.race([
      Promise.resolve().then(ready).catch(function () {}),
      new Promise(function (resolve) { setTimeout(resolve, 3000) }),
    ]).then(function () {
      if (!started) return
      const items = store.read().items
      for (let i = 0; i < items.length; i++) {
        const it = items[i]
        // 长驻优先（它必然带 onStartup）；普通随启动脚本跑一次就完事
        if (it.daemon) launch(it, 'daemon', '长驻', 0)
        else if (it.onStartup) launch(it, 'startup', '随启动', 0)
      }
      if (typeof stateLastMinute === 'number') catchUp(stateLastMinute)
    })
  }

  function stop() {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    started = false
    writeState()
  }

  return {
    start: start,
    stop: stop,
    /** 列表标红文案；没有就是 null */
    getAlarm: function (id) { return alarms.get(id) || null },
    clearAlarm: function (id) { alarms.delete(id) },
  }
}
