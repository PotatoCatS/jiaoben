// 花名册存储测试：持久化、目录、收编、导入、克隆、改名、删除、Python 路径
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createScriptsStore } from '../src/scripts.mjs'

/** 每个用例独立临时数据目录 + 脚本目录，用完删掉 */
function tmp(t) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jb-store-'))
  const scripts = fs.mkdtempSync(path.join(os.tmpdir(), 'jb-scripts-'))
  t.after(() => {
    fs.rmSync(data, { recursive: true, force: true })
    fs.rmSync(scripts, { recursive: true, force: true })
  })
  return { data, scripts }
}

function mkStore(dataDir) {
  return createScriptsStore({ dataDir: dataDir, log: () => {} })
}

// ---------- 保存与持久化 ----------
test('save 落盘，新 store 实例能读回', (t) => {
  const { data } = tmp(t)
  const s1 = mkStore(data)
  const res = s1.save({ name: '打招呼', file: 'hello.js', lang: 'js' })
  assert.equal(res.ok, true)
  assert.ok(res.item.id)
  assert.equal(res.item.cron, null)
  assert.equal(res.item.cronCatchUp, false)
  assert.equal(res.item.onStartup, false)
  assert.equal(res.item.daemon, false)
  assert.equal(res.item.closeAfterRun, false)
  assert.ok(res.item.createdAt > 0)
  // 换一个实例（模拟重启）读同一份数据
  const s2 = mkStore(data)
  const cfg = s2.read()
  assert.equal(cfg.items.length, 1)
  assert.equal(cfg.items[0].name, '打招呼')
  assert.equal(cfg.items[0].id, res.item.id)
  assert.equal(cfg.dir, null)
})

test('save 报错：名字为空', (t) => {
  const { data } = tmp(t)
  const s = mkStore(data)
  const res = s.save({ name: '   ', file: 'a.js' })
  assert.equal(res.ok, false)
  assert.match(res.error, /脚本名不能为空/)
})

test('save 报错：同文件名的两条目被拒绝', (t) => {
  const { data } = tmp(t)
  const s = mkStore(data)
  assert.equal(s.save({ name: '甲', file: 'a.js' }).ok, true)
  const res = s.save({ name: '乙', file: 'a.js' })
  assert.equal(res.ok, false)
  assert.match(res.error, /已存在同名脚本文件/)
})

test('save 更新已有条目：保留 createdAt', (t) => {
  const { data } = tmp(t)
  const s = mkStore(data)
  const first = s.save({ name: '旧名', file: 'a.js', lang: 'js' })
  const res = s.save({ id: first.item.id, name: '新名', file: 'a.js', lang: 'js', cron: '0 9 * * *' })
  assert.equal(res.ok, true)
  assert.equal(res.item.name, '新名')
  assert.equal(res.item.createdAt, first.item.createdAt)
  assert.equal(res.item.cron, '0 9 * * *')
  assert.equal(s.read().items.length, 1)
})

test('sanitize：cron 空白串落成 null，语言只认 py 否则 js', (t) => {
  const { data } = tmp(t)
  const s = mkStore(data)
  const a = s.save({ name: 'a', file: 'a.mjs', lang: 'mjs', cron: '   ' })
  const b = s.save({ name: 'b', file: 'b.py', lang: 'py' })
  assert.equal(a.item.lang, 'js')
  assert.equal(a.item.cron, null)
  assert.equal(b.item.lang, 'py')
})

// ---------- setDir 与 rescan ----------
test('setDir 换目录重置「不收编」名单', (t) => {
  const { data, scripts } = tmp(t)
  const s = mkStore(data)
  s.setDir(scripts)
  const it = s.save({ name: 'x', file: 'x.js' })
  // 只移出花名册（不删文件）→ 进 excluded
  const rm = s.remove(it.item.id, false)
  assert.equal(rm.ok, true)
  assert.ok(s.read().excluded.includes('x.js'))
  // 换目录 = 换地盘，excluded 作废
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'jb-dir2-'))
  t.after(() => fs.rmSync(dir2, { recursive: true, force: true }))
  s.setDir(dir2)
  assert.deepEqual(s.read().excluded, [])
})

test('rescan 只收编一级 .js/.py，子目录与其它扩展名不动', (t) => {
  const { data, scripts } = tmp(t)
  fs.writeFileSync(path.join(scripts, 'a.js'), '')
  fs.writeFileSync(path.join(scripts, 'B.PY'), '') // 大写扩展名也认
  fs.writeFileSync(path.join(scripts, 'notes.txt'), '')
  fs.mkdirSync(path.join(scripts, 'sub'))
  fs.writeFileSync(path.join(scripts, 'sub', 'c.js'), '')
  const s = mkStore(data)
  s.setDir(scripts)
  const res = s.rescan()
  assert.equal(res.ok, true)
  assert.equal(res.added.length, 2)
  const files = res.added.map((x) => x.file).sort()
  assert.deepEqual(files, ['B.PY', 'a.js'])
  assert.equal(res.items.find((x) => x.file === 'a.js').lang, 'js')
  assert.equal(res.items.find((x) => x.file === 'B.PY').lang, 'py')
  assert.equal(res.items.some((x) => x.file === 'c.js'), false)
  // 再扫一遍：没有重复收编
  const again = s.rescan()
  assert.equal(again.added.length, 0)
})

test('rescan 跳过「不收编」名单', (t) => {
  const { data, scripts } = tmp(t)
  fs.writeFileSync(path.join(scripts, 'a.js'), '')
  const s = mkStore(data)
  s.setDir(scripts)
  const first = s.rescan()
  assert.equal(first.added.length, 1)
  s.remove(first.items[0].id, false) // 文件保留，仅移出花名册
  const again = s.rescan()
  assert.equal(again.added.length, 0)
  assert.ok(s.read().excluded.includes('a.js'))
})

test('rescan 报错：没选脚本目录', (t) => {
  const { data } = tmp(t)
  const s = mkStore(data)
  const res = s.rescan()
  assert.equal(res.ok, false)
  assert.match(res.error, /请先选择脚本目录/)
})

// ---------- importFile ----------
test('importFile 复制并登记；撞名自动加序号不覆盖', (t) => {
  const { data, scripts } = tmp(t)
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'jb-out-'))
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
  const src = path.join(outside, 'tool.js')
  fs.writeFileSync(src, 'console.log(1)')
  const s = mkStore(data)
  s.setDir(scripts)
  const r1 = s.importFile(src)
  assert.equal(r1.ok, true)
  assert.equal(r1.file, 'tool.js')
  assert.equal(r1.item.lang, 'js')
  assert.equal(fs.readFileSync(path.join(scripts, 'tool.js'), 'utf8'), 'console.log(1)')
  // 再次导入同名 → tool 2.js
  const r2 = s.importFile(src)
  assert.equal(r2.ok, true)
  assert.equal(r2.file, 'tool 2.js')
  assert.equal(fs.readFileSync(path.join(scripts, 'tool.js'), 'utf8'), 'console.log(1)')
  // .py 也认
  const srcPy = path.join(outside, 'p.py')
  fs.writeFileSync(srcPy, 'print(1)')
  const r3 = s.importFile(srcPy)
  assert.equal(r3.ok, true)
  assert.equal(r3.item.lang, 'py')
})

test('importFile 报错：非 .js/.py 扩展名', (t) => {
  const { data, scripts } = tmp(t)
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'jb-out-'))
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
  const src = path.join(outside, 'tool.txt')
  fs.writeFileSync(src, 'x')
  const s = mkStore(data)
  s.setDir(scripts)
  const res = s.importFile(src)
  assert.equal(res.ok, false)
  assert.match(res.error, /只支持导入/)
})

// ---------- clone / rename / remove ----------
test('clone 复制文件生成「副本」，连续克隆自动加序号', (t) => {
  const { data, scripts } = tmp(t)
  fs.writeFileSync(path.join(scripts, 'a.js'), 'const x=1')
  const s = mkStore(data)
  s.setDir(scripts)
  const it = s.save({ name: 'a', file: 'a.js', lang: 'js' })
  const c1 = s.clone(it.item.id)
  assert.equal(c1.ok, true)
  assert.equal(c1.item.file, 'a 副本.js')
  assert.equal(fs.readFileSync(path.join(scripts, 'a 副本.js'), 'utf8'), 'const x=1')
  const c2 = s.clone(it.item.id)
  assert.equal(c2.ok, true)
  assert.equal(c2.item.file, 'a 副本2.js')
  assert.equal(s.read().items.length, 3)
})

test('clone 报错：源文件没了', (t) => {
  const { data, scripts } = tmp(t)
  const s = mkStore(data)
  s.setDir(scripts)
  const it = s.save({ name: 'a', file: 'a.js', lang: 'js' })
  const res = s.clone(it.item.id)
  assert.equal(res.ok, false)
  assert.match(res.error, /找不到源文件/)
})

test('rename 磁盘真改名 + 花名册同步（扩展名可带可不带）', (t) => {
  const { data, scripts } = tmp(t)
  fs.writeFileSync(path.join(scripts, 'a.js'), 'x')
  const s = mkStore(data)
  s.setDir(scripts)
  const it = s.save({ name: 'a', file: 'a.js', lang: 'js' })
  const res = s.rename(it.item.id, 'b.js')
  assert.equal(res.ok, true)
  assert.equal(res.item.file, 'b.js')
  assert.equal(res.item.name, 'b')
  assert.equal(fs.existsSync(path.join(scripts, 'a.js')), false)
  assert.equal(fs.existsSync(path.join(scripts, 'b.js')), true)
})

test('rename 报错：非法字符 / 空名 / 撞名', (t) => {
  const { data, scripts } = tmp(t)
  fs.writeFileSync(path.join(scripts, 'a.js'), 'x')
  fs.writeFileSync(path.join(scripts, 'c.js'), 'y')
  const s = mkStore(data)
  s.setDir(scripts)
  const a = s.save({ name: 'a', file: 'a.js', lang: 'js' })
  s.save({ name: 'c', file: 'c.js', lang: 'js' })
  assert.match(s.rename(a.item.id, 'bad:name').error, /不能有/)
  assert.match(s.rename(a.item.id, '   ').error, /名字不能为空/)
  assert.match(s.rename(a.item.id, 'c').error, /已有同名脚本/)
})

test('remove 删文件 vs 只移出花名册', (t) => {
  const { data, scripts } = tmp(t)
  fs.writeFileSync(path.join(scripts, 'a.js'), 'x')
  const s = mkStore(data)
  s.setDir(scripts)
  const a = s.save({ name: 'a', file: 'a.js', lang: 'js' })
  const r1 = s.remove(a.item.id, true)
  assert.equal(r1.ok, true)
  assert.equal(r1.deletedFile, true)
  assert.equal(fs.existsSync(path.join(scripts, 'a.js')), false)
  assert.equal(s.read().excluded.length, 0)
  // 第二条：不删文件
  fs.writeFileSync(path.join(scripts, 'b.js'), 'x')
  const b = s.save({ name: 'b', file: 'b.js', lang: 'js' })
  const r2 = s.remove(b.item.id, false)
  assert.equal(r2.ok, true)
  assert.equal(r2.deletedFile, false)
  assert.equal(fs.existsSync(path.join(scripts, 'b.js')), true)
  assert.ok(s.read().excluded.includes('b.js'))
})

test('remove 报错：id 不存在', (t) => {
  const { data } = tmp(t)
  const s = mkStore(data)
  const res = s.remove('nope', true)
  assert.equal(res.ok, false)
  assert.match(res.error, /找不到该脚本/)
})

// ---------- Python 路径 ----------
test('setPythonPath / clearPythonPath 落盘', (t) => {
  const { data } = tmp(t)
  const s = mkStore(data)
  assert.equal(s.read().pythonPath, null)
  s.setPythonPath('C:/Python/python.exe')
  assert.equal(s.read().pythonPath, 'C:/Python/python.exe')
  s.clearPythonPath()
  assert.equal(s.read().pythonPath, null)
})

// ---------- 上限 ----------
test('超过 100 个脚本被拒绝', (t) => {
  const { data } = tmp(t)
  const s = mkStore(data)
  for (let i = 0; i < 100; i++) {
    assert.equal(s.save({ name: 's' + i, file: 'f' + i + '.js' }).ok, true)
  }
  const res = s.save({ name: 'one more', file: 'f100.js' })
  assert.equal(res.ok, false)
  assert.match(res.error, /最多 100 个脚本/)
})
