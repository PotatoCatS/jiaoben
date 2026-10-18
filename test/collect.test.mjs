// 收纳管理测试：旧数据迁移、候选扫描（一级/递归）、收编、不收编名单、分组、停用、自动收纳轮询
// 调度器部分用真实子进程 + 短等待；时间线控制靠「种状态文件」伪造 lastMinute。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createScriptsStore, createScriptRunner, createScriptScheduler } from '../src/scripts.mjs'

const MARK = 'mark.txt'

function tmp(t) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jb-collect-'))
  const scripts = fs.mkdtempSync(path.join(os.tmpdir(), 'jb-collect-dir-'))
  t.after(() => {
    fs.rmSync(data, { recursive: true, force: true })
    fs.rmSync(scripts, { recursive: true, force: true })
  })
  return { data, scripts }
}

function mkStore(dataDir) {
  return createScriptsStore({ dataDir: dataDir, log: () => {} })
}

// ---------- 旧数据迁移 ----------
test('旧 scripts.json（无 groups/opts/enabled/group）读进来就是默认值', (t) => {
  const { data } = tmp(t)
  fs.writeFileSync(
    path.join(data, 'scripts.json'),
    JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      dir: 'E:\\some\\dir',
      items: [{ id: 'sc_old', name: '老脚本', file: 'old.js', lang: 'js', createdAt: 1, updatedAt: 1 }],
      excluded: ['drop.js'],
      pythonPath: null,
    }),
    'utf8',
  )
  const s = mkStore(data)
  const cfg = s.read()
  assert.deepEqual(cfg.groups, [])
  assert.deepEqual(cfg.opts, { deepAdopt: false, autoAdopt: false })
  assert.equal(cfg.items.length, 1)
  assert.equal(cfg.items[0].enabled, true)
  assert.equal(cfg.items[0].group, null)
})

// ---------- 候选扫描 ----------
test('scanCandidates：默认只扫一级，.js/.py 之外与已登记的不算候选', (t) => {
  const { data, scripts } = tmp(t)
  fs.writeFileSync(path.join(scripts, 'a.js'), 'x')
  fs.writeFileSync(path.join(scripts, 'b.py'), 'x')
  fs.writeFileSync(path.join(scripts, 'note.txt'), 'x')
  fs.mkdirSync(path.join(scripts, 'sub'))
  fs.writeFileSync(path.join(scripts, 'sub', 'c.js'), 'x')
  const s = mkStore(data)
  s.setDir(scripts)
  s.save({ name: 'a', file: 'a.js', lang: 'js' }) // 已登记，不再是候选
  const res = s.scanCandidates()
  assert.equal(res.ok, true)
  const rels = res.candidates.map((c) => c.rel).sort()
  assert.deepEqual(rels, ['b.py'])
  assert.equal(res.deep, false)
})

test('scanCandidates：开子目录收纳后递归扫出子目录文件（相对路径）', (t) => {
  const { data, scripts } = tmp(t)
  fs.mkdirSync(path.join(scripts, 'sub'))
  fs.mkdirSync(path.join(scripts, 'sub', 'nested'))
  fs.writeFileSync(path.join(scripts, 'a.js'), 'x')
  fs.writeFileSync(path.join(scripts, 'sub', 'c.js'), 'x')
  fs.writeFileSync(path.join(scripts, 'sub', 'nested', 'd.py'), 'x')
  const s = mkStore(data)
  s.setDir(scripts)
  s.setDeepAdopt(true)
  const res = s.scanCandidates()
  assert.equal(res.ok, true)
  assert.equal(res.deep, true)
  const rels = res.candidates.map((c) => c.rel).sort()
  assert.deepEqual(rels, ['a.js', 'sub/c.js', 'sub/nested/d.py'])
  // 关掉开关就回到只扫一级
  s.setDeepAdopt(false)
  const res2 = s.scanCandidates()
  assert.deepEqual(res2.candidates.map((c) => c.rel).sort(), ['a.js'])
  // 持久化：新实例读回开关状态
  const s2 = mkStore(data)
  assert.equal(s2.read().opts.deepAdopt, false)
})

// ---------- 收编 ----------
test('adopt：一级 + 子目录一起收编，file 记相对路径，重复收编跳过', (t) => {
  const { data, scripts } = tmp(t)
  fs.mkdirSync(path.join(scripts, 'sub'))
  fs.writeFileSync(path.join(scripts, 'a.js'), 'x')
  fs.writeFileSync(path.join(scripts, 'sub', 'c.py'), 'x')
  const s = mkStore(data)
  s.setDir(scripts)
  const res = s.adopt(['a.js', 'sub/c.py'])
  assert.equal(res.ok, true)
  assert.equal(res.added.length, 2)
  assert.deepEqual(res.failed, [])
  const files = s.read().items.map((x) => x.file).sort()
  assert.deepEqual(files, ['a.js', 'sub/c.py'])
  // 子目录脚本的显示名是文件名本身
  const sub = s.read().items.find((x) => x.file === 'sub/c.py')
  assert.equal(sub.name, 'c')
  assert.equal(sub.lang, 'py')
  // 再收编一遍：已登记的跳过，不会重复
  const res2 = s.adopt(['a.js'])
  assert.equal(res2.added.length, 0)
  assert.equal(s.read().items.length, 2)
})

test('adopt：非脚本与不存在的文件进 failed，不给花名册', (t) => {
  const { data, scripts } = tmp(t)
  fs.writeFileSync(path.join(scripts, 'a.js'), 'x')
  const s = mkStore(data)
  s.setDir(scripts)
  const res = s.adopt(['a.js', 'note.txt', 'ghost.js'])
  assert.equal(res.ok, true)
  assert.equal(res.added.length, 1)
  assert.equal(res.failed.length, 2)
  assert.ok(res.failed.some((f) => f.error.includes('不是 .js / .py')))
  assert.ok(res.failed.some((f) => f.error.includes('文件不存在')))
  assert.equal(s.read().items.length, 1)
})

// ---------- 不收编名单 ----------
test('ignore / listExcluded / unexclude：候选来回走一圈', (t) => {
  const { data, scripts } = tmp(t)
  fs.writeFileSync(path.join(scripts, 'a.js'), 'x')
  fs.mkdirSync(path.join(scripts, 'sub'))
  fs.writeFileSync(path.join(scripts, 'sub', 'b.js'), 'x')
  const s = mkStore(data)
  s.setDir(scripts)
  s.setDeepAdopt(true)
  s.ignore(['a.js', 'sub/b.js'])
  assert.deepEqual(s.listExcluded().sort(), ['a.js', 'sub/b.js'])
  // 收进名单后扫描不再出现
  assert.equal(s.scanCandidates().candidates.length, 0)
  // 放出来一个，又回到候选
  s.unexclude('sub/b.js')
  assert.deepEqual(s.listExcluded(), ['a.js'])
  assert.deepEqual(s.scanCandidates().candidates.map((c) => c.rel), ['sub/b.js'])
})

test('adopt 已收编的文件会自动从「不收编」名单里放出来', (t) => {
  const { data, scripts } = tmp(t)
  fs.writeFileSync(path.join(scripts, 'a.js'), 'x')
  const s = mkStore(data)
  s.setDir(scripts)
  s.ignore(['a.js'])
  const res = s.adopt(['a.js'])
  assert.equal(res.added.length, 1)
  assert.deepEqual(s.listExcluded(), [])
})

// ---------- 分组 ----------
test('分组：建组（空名/同名拦截）、改名、把脚本移进移出', (t) => {
  const { data, scripts } = tmp(t)
  const s = mkStore(data)
  s.setDir(scripts)
  const saved = s.save({ name: '甲', file: 'a.js', lang: 'js' }).item
  assert.equal(s.groupCreate('').ok, false)
  const g1 = s.groupCreate('Work')
  assert.equal(g1.ok, true)
  assert.equal(g1.group.name, 'Work')
  assert.equal(s.groupCreate('Work').ok, false) // 同名
  assert.equal(s.groupCreate('  WORK  ').ok, false) // 大小写不敏感 + 空白也算撞名
  const g2 = s.groupCreate('摸鱼')
  assert.equal(s.read().groups.length, 2)
  // 改名
  const rn = s.groupRename(g1.group.id, '正经工作')
  assert.equal(rn.ok, true)
  assert.equal(s.read().groups[0].name, '正经工作')
  assert.equal(s.groupRename(g1.group.id, g2.group.name).ok, false) // 撞别的组名
  // 移动脚本
  const mv = s.groupMove(saved.id, g1.group.id)
  assert.equal(mv.ok, true)
  assert.equal(s.read().items[0].group, g1.group.id)
  // 移回未分组
  const mv2 = s.groupMove(saved.id, null)
  assert.equal(mv2.ok, true)
  assert.equal(s.read().items[0].group, null)
  // 不存在的组
  assert.equal(s.groupMove(saved.id, 'grp_ghost').ok, false)
})

test('删分组：组没了，组里脚本回到未分组，脚本本身不动', (t) => {
  const { data, scripts } = tmp(t)
  const s = mkStore(data)
  s.setDir(scripts)
  const saved = s.save({ name: '甲', file: 'a.js', lang: 'js' }).item
  const g = s.groupCreate('临时组')
  s.groupMove(saved.id, g.group.id)
  const rm = s.groupRemove(g.group.id)
  assert.equal(rm.ok, true)
  assert.equal(s.read().groups.length, 0)
  assert.equal(s.read().items.length, 1)
  assert.equal(s.read().items[0].group, null)
  assert.equal(s.groupRemove('grp_ghost').ok, false)
})

test('分组与停用状态持久化：新实例读回原样', (t) => {
  const { data, scripts } = tmp(t)
  const s = mkStore(data)
  s.setDir(scripts)
  const saved = s.save({ name: '甲', file: 'a.js', lang: 'js' }).item
  const g = s.groupCreate('持久组')
  s.groupMove(saved.id, g.group.id)
  s.setEnabled(saved.id, false)
  const cfg = mkStore(data).read()
  assert.equal(cfg.groups.length, 1)
  assert.equal(cfg.groups[0].name, '持久组')
  assert.equal(cfg.items[0].group, g.group.id)
  assert.equal(cfg.items[0].enabled, false)
})

// ---------- 停用 ----------
test('setEnabled：默认启用；停用后普通 save（不带 enabled）不把状态冲掉', (t) => {
  const { data } = tmp(t)
  const s = mkStore(data)
  const saved = s.save({ name: '甲', file: 'a.js', lang: 'js' }).item
  assert.equal(saved.enabled, true)
  assert.equal(s.setEnabled(saved.id, false).ok, true)
  assert.equal(s.read().items[0].enabled, false)
  // 编辑保存（只传名字/文件，不带 enabled/group）→ 沿用旧值
  const res = s.save({ id: saved.id, name: '甲改', file: 'a.js', lang: 'js' })
  assert.equal(res.ok, true)
  assert.equal(res.item.enabled, false)
  // 再启用
  assert.equal(s.setEnabled(saved.id, true).ok, true)
  assert.equal(s.read().items[0].enabled, true)
  assert.equal(s.setEnabled('sc_ghost', false).ok, false)
})

// ============================================================================
// 调度器：停用跳过四种自动方式 + 自动收纳轮询
// ============================================================================

function minOf(ms) {
  return Math.floor(ms / 60000)
}

async function waitFor(fn, timeoutMs, step, label) {
  timeoutMs = timeoutMs || 8000
  step = step || 50
  const t0 = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - t0 > timeoutMs) throw new Error(label || 'waitFor 超时')
    await new Promise((r) => setTimeout(r, step))
  }
}

function schedSetup(t, { extraOpts } = {}) {
  const { data, scripts } = tmp(t)
  const store = createScriptsStore({ dataDir: data })
  store.setDir(scripts)
  const logs = []
  const runner = createScriptRunner({ store: store, sendLog: () => {}, getPython: () => null, log: (m) => logs.push(m) })
  const scheduler = createScriptScheduler(
    Object.assign(
      { store: store, runner: runner, dataDir: data, log: (m) => logs.push(m), ready: () => Promise.resolve() },
      extraOpts || {},
    ),
  )
  t.after(async () => {
    scheduler.stop()
    await runner.stopAll()
    await waitFor(() => runner.running().size === 0, 5000).catch(() => {})
    await new Promise((r) => setTimeout(r, 100))
    fs.rmSync(data, { recursive: true, force: true })
    fs.rmSync(scripts, { recursive: true, force: true })
  })
  return { store, runner, scheduler, logs, scripts, data }
}

test('停用 = 停自动：长驻/随启动都不随启动，手动不受影响（enabled 脚本照跑）', async (t) => {
  const { store, runner, scheduler, scripts } = schedSetup(t)
  fs.writeFileSync(path.join(scripts, 'd.js'), 'require("fs").appendFileSync("' + MARK + '", "D"); setInterval(() => {}, 1000);')
  fs.writeFileSync(path.join(scripts, 's.js'), 'require("fs").appendFileSync("' + MARK + '", "S");')
  fs.writeFileSync(path.join(scripts, 'e.js'), 'require("fs").appendFileSync("' + MARK + '", "E");')
  const d = store.save({ name: 'd', file: 'd.js', lang: 'js', daemon: true, enabled: false }).item
  const s = store.save({ name: 's', file: 's.js', lang: 'js', onStartup: true, enabled: false }).item
  const e = store.save({ name: 'e', file: 'e.js', lang: 'js', onStartup: true }).item
  scheduler.start()
  // 启用的随启动脚本先跑起来
  await waitFor(() => (runner.status()[e.id] || []).length === 1)
  await new Promise((r) => setTimeout(r, 1200))
  const mark = fs.existsSync(path.join(scripts, MARK)) ? fs.readFileSync(path.join(scripts, MARK), 'utf8') : ''
  assert.equal(mark.includes('D'), false, '停用的长驻不该启动')
  assert.equal(mark.includes('S'), false, '停用的随启动不该启动')
  assert.equal(mark.includes('E'), true)
  assert.equal(runner.status()[d.id], undefined)
  assert.equal(runner.status()[s.id], undefined)
  // 手动运行不拦：停用只是停自动，直接 runOne 照跑（拍板 A 语义）
  const manual = await runner.runOne(d, scripts, {})
  assert.equal(manual.ok, true, '停用脚本手动运行应该成功: ' + (manual.error || ''))
  await waitFor(() => {
    const m = fs.existsSync(path.join(scripts, MARK)) ? fs.readFileSync(path.join(scripts, MARK), 'utf8') : ''
    return m.includes('D')
  }, 5000, 50, '停用脚本手动跑起来后应该写出标记')
  await runner.stop(d.id)
  await waitFor(() => runner.status()[d.id] === undefined)
})

test('停用 = 停自动：开机补跑跳过停用脚本（enabled 对照组照补）', async (t) => {
  const nowMin = minOf(Date.now())
  const { store, runner, scheduler, scripts, data } = schedSetup(t)
  fs.writeFileSync(path.join(scripts, 'off.js'), 'require("fs").appendFileSync("' + MARK + '", "OFF");')
  fs.writeFileSync(path.join(scripts, 'on.js'), 'require("fs").appendFileSync("' + MARK + '", "ON");')
  const off = store.save({ name: 'off', file: 'off.js', lang: 'js', cron: '*/1 * * * *', cronCatchUp: true, enabled: false }).item
  const on = store.save({ name: 'on', file: 'on.js', lang: 'js', cron: '*/1 * * * *', cronCatchUp: true }).item
  fs.writeFileSync(
    path.join(data, 'scripts-schedule.json'),
    JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), lastMinute: nowMin - 3 }),
    'utf8',
  )
  scheduler.start()
  await waitFor(() => runner.history(on.id).some((p) => p.text.includes('开机补跑')))
  await new Promise((r) => setTimeout(r, 800))
  assert.equal(runner.history(off.id).length, 0, '停用脚本不该被补跑')
  const mark = fs.existsSync(path.join(scripts, MARK)) ? fs.readFileSync(path.join(scripts, MARK), 'utf8') : ''
  assert.equal(mark.includes('OFF'), false)
  assert.equal(mark.includes('ON'), true)
})

test('自动收纳：开关开时新文件自动进列表，关时不动；名单里的不捡', async (t) => {
  const adopted = []
  const { store, runner, scheduler, scripts } = schedSetup(t, {
    extraOpts: { autoAdoptMs: 200, onAdopt: (list) => adopted.push(...list) },
  })
  fs.writeFileSync(path.join(scripts, 'a.js'), 'x')
  store.setAutoAdopt(true)
  scheduler.start()
  // 开关开着：轮询把 a.js 收编进来
  await waitFor(() => store.read().items.length === 1)
  assert.equal(store.read().items[0].file, 'a.js')
  assert.equal(adopted.length, 1)
  // 新放一个 b.py，也自动进来
  fs.writeFileSync(path.join(scripts, 'b.py'), 'x')
  await waitFor(() => store.read().items.length === 2)
  assert.equal(adopted.length, 2)
  // 名单里的文件不捡
  fs.writeFileSync(path.join(scripts, 'c.js'), 'x')
  store.ignore(['c.js'])
  await new Promise((r) => setTimeout(r, 500))
  assert.equal(store.read().items.length, 2)
  // 关掉开关：新文件不再自动进
  fs.writeFileSync(path.join(scripts, 'd.js'), 'x')
  store.setAutoAdopt(false)
  await new Promise((r) => setTimeout(r, 500))
  assert.equal(store.read().items.length, 2)
  // 手动 scanCandidates 还是能看到没被收编的 d.js（c.js 在名单里看不到）
  const cands = store.scanCandidates().candidates.map((c) => c.rel).sort()
  assert.deepEqual(cands, ['d.js'])
  await runner.stopAll()
})
