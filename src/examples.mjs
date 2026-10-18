// ============================================================================
// examples.mjs —— jiaoben 示例库存储（零依赖，可跑在任何 Node ≥ 22 宿主）
// ============================================================================
// 「脚本管理器」的示例库：用户自己的脚本样例收藏夹，可在面板里增删改查。
// 存放规则（原 pet-sq 项目 2026-10-17 用户拍板，随引擎一并继承）：
//   * 示例库放在数据目录的 examples/ 子目录，跟脚本目录无关——换脚本目录不丢。
//   * 从零开始：不内置示例。
//   * 一个示例 = examples/ 里的一个文件（<名字>.js / <名字>.py），
//     examples.json 只存元数据（id/名字/文件名/语言/时间），不存代码。
// 注意和脚本花名册（scripts.mjs）的分工：这里的文件就是「示例本体」，
// 引擎直接读写它们；导入到脚本目录时才复制一份过去。
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'

const FILE_NAME = 'examples.json'
const MAX_EXAMPLES = 200

function pad2(n) {
  return String(n).padStart(2, '0')
}

/** 文件名安全检查：Windows 不允许这些字符；也挡掉路径穿越 */
function badNameChars(name) {
  return /[\\/:*?"<>|]/.test(name)
}

function sanitize(input, now) {
  if (!input || typeof input !== 'object') return null
  const name = String(input.name || '').trim().slice(0, 120)
  if (!name) return null
  const lang = input.lang === 'py' ? 'py' : 'js'
  const file = String(input.file || name + (lang === 'py' ? '.py' : '.js'))
  return {
    id: String(input.id || 'ex_' + now.toString(36) + Math.random().toString(36).slice(2, 6)),
    name: name,
    file: file,
    lang: lang,
    createdAt: Number(input.createdAt) || now,
    updatedAt: Number(input.updatedAt) || now,
  }
}

export function createExamplesStore({ dataDir, log = function () {} }) {
  const dir = path.join(dataDir, 'examples')
  const indexFile = path.join(dir, FILE_NAME)

  function read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
      const now = Date.now()
      const items = Array.isArray(parsed && parsed.items)
        ? parsed.items.map(function (i) { return sanitize(i, now) }).filter(Boolean)
        : []
      return { items: items }
    } catch (err) {
      return { items: [] }
    }
  }

  function write(items) {
    const body = JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), items: items }, null, 2)
    fs.mkdirSync(dir, { recursive: true })
    const tmp = indexFile + '.tmp-' + process.pid
    fs.writeFileSync(tmp, body, 'utf8')
    fs.renameSync(tmp, indexFile)
  }

  function filePathOf(item) {
    return path.join(dir, item.file)
  }

  /** 文件名按大小写不敏感去重（Windows 文件系统也大小写不敏感） */
  function takenName(items, file) {
    const low = String(file).toLowerCase()
    return items.some(function (x) { return String(x.file).toLowerCase() === low })
  }

  function saveItem(cfg, clean) {
    const i = cfg.items.findIndex(function (x) { return x.id === clean.id })
    if (i >= 0) {
      clean.createdAt = cfg.items[i].createdAt || clean.createdAt
      cfg.items[i] = clean
    } else {
      cfg.items.push(clean)
    }
    write(cfg.items)
    return clean
  }

  return {
    dir: dir,
    read: read,
    list: function () {
      const cfg = read()
      // 元数据 + 文件是否还在（文件被用户手动删了要能看出来）
      return cfg.items.map(function (it) {
        let exists = false
        try { exists = fs.existsSync(filePathOf(it)) } catch (err) {}
        return { ...it, exists: exists }
      })
    },
    /** 读代码；文件没了返回 exists:false（列表里能看到，不自动删记录） */
    readCode: function (id) {
      const item = read().items.find(function (x) { return x.id === id })
      if (!item) return { ok: false, error: '找不到该示例' }
      try {
        return { ok: true, code: fs.readFileSync(filePathOf(item), 'utf8'), exists: true }
      } catch (err) {
        return { ok: true, code: '', exists: false }
      }
    },
    /**
     * 新建示例。opts.autoRename 为 true 时撞名自动加序号（「存为示例」用），
     * 否则撞名直接报错（「新建示例」弹窗用——名字是用户亲手填的，撞了要让他知道）。
     */
    create: function (input, opts) {
      opts = opts || {}
      const now = Date.now()
      const clean = sanitize(input, now)
      if (!clean) return { ok: false, error: '示例名不能为空' }
      if (badNameChars(clean.name)) return { ok: false, error: '名字里不能有 \\ / : * ? " < > | 这些字符' }
      const cfg = read()
      if (cfg.items.length >= MAX_EXAMPLES) return { ok: false, error: '最多 ' + MAX_EXAMPLES + ' 个示例' }
      const ext = clean.lang === 'py' ? '.py' : '.js'
      let file = clean.name + ext
      if (takenName(cfg.items, file)) {
        if (!opts.autoRename) return { ok: false, error: '已有同名示例：' + file }
        for (let n = 2; n < 1000; n++) {
          const cand = clean.name + ' ' + n + ext
          if (!takenName(cfg.items, cand) && !fs.existsSync(path.join(dir, cand))) {
            file = cand
            break
          }
        }
        if (file === clean.name + ext) return { ok: false, error: '示例名占满了，先清理几个再试' }
      }
      clean.file = file
      try {
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, file), String(input.code == null ? '' : input.code), 'utf8')
      } catch (err) {
        return { ok: false, error: '写入文件失败: ' + ((err && err.message) || err) }
      }
      saveItem(cfg, clean)
      log('[examples] 新建示例：' + file)
      return { ok: true, item: clean, items: read().items }
    },
    /** 改名字/语言/代码；名字或语言变了就真改名文件（撞名先拦） */
    update: function (id, input) {
      const cfg = read()
      const item = cfg.items.find(function (x) { return x.id === id })
      if (!item) return { ok: false, error: '找不到该示例' }
      const name = String((input && input.name) == null ? item.name : input.name).trim().slice(0, 120)
      if (!name) return { ok: false, error: '示例名不能为空' }
      if (badNameChars(name)) return { ok: false, error: '名字里不能有 \\ / : * ? " < > | 这些字符' }
      const lang = input && input.lang === 'py' ? 'py' : input && input.lang === 'js' ? 'js' : item.lang
      const ext = lang === 'py' ? '.py' : '.js'
      const newFile = name + ext
      if (newFile.toLowerCase() !== item.file.toLowerCase()) {
        if (takenName(cfg.items, newFile)) return { ok: false, error: '已有同名示例：' + newFile }
        try {
          fs.renameSync(filePathOf(item), path.join(dir, newFile))
        } catch (err) {
          return { ok: false, error: '改名失败: ' + ((err && err.message) || err) }
        }
      }
      if (input && typeof input.code === 'string') {
        try {
          fs.writeFileSync(path.join(dir, newFile), input.code, 'utf8')
        } catch (err) {
          return { ok: false, error: '写入文件失败: ' + ((err && err.message) || err) }
        }
      }
      item.name = name
      item.file = newFile
      item.lang = lang
      item.updatedAt = Date.now()
      saveItem(cfg, item)
      log('[examples] 更新示例：' + newFile)
      return { ok: true, item: item, items: read().items }
    },
    /** 删除示例：元数据和文件一起删（文件没了也照样清记录） */
    remove: function (id) {
      const cfg = read()
      const item = cfg.items.find(function (x) { return x.id === id })
      if (!item) return { ok: false, error: '找不到该示例' }
      cfg.items = cfg.items.filter(function (x) { return x.id !== id })
      try {
        const p = filePathOf(item)
        if (fs.existsSync(p)) fs.unlinkSync(p)
      } catch (err) {
        log('[examples] 删除文件失败: ' + ((err && err.message) || err))
      }
      write(cfg.items)
      log('[examples] 删除示例：' + item.file)
      return { ok: true, items: read().items }
    },
  }
}
