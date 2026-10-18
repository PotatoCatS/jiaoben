// 运行器测试：真实子进程跑 JS 脚本、日志缓冲、停止、超时、Python 门禁
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createScriptsStore, createScriptRunner } from '../src/scripts.mjs'

function tmp(t) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jb-run-'))
  const scripts = fs.mkdtempSync(path.join(os.tmpdir(), 'jb-run-dir-'))
  return { data, scripts }
}

/** 轮询直到条件成立或超时 */
async function waitFor(fn, timeoutMs, step) {
  timeoutMs = timeoutMs || 5000
  step = step || 50
  const t0 = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((r) => setTimeout(r, step))
  }
}

function setup(t, getPython) {
  const { data, scripts } = tmp(t)
  const store = createScriptsStore({ dataDir: data })
  store.setDir(scripts)
  const batches = []
  const runner = createScriptRunner({
    store: store,
    sendLog: (b) => batches.push(b),
    getPython: getPython || (() => null),
  })
  // 单一清理钩子，顺序固定：先杀光子进程，等退出事件落定，再删目录，
  // 避免 Windows 上「子进程 cwd 还在脚本目录里」导致 rmSync EPERM。
  t.after(async () => {
    await runner.stopAll()
    await waitFor(() => runner.running().size === 0, 5000).catch(() => {})
    await new Promise((r) => setTimeout(r, 100))
    fs.rmSync(data, { recursive: true, force: true })
    fs.rmSync(scripts, { recursive: true, force: true })
  })
  return { store, runner, batches, scripts }
}

/** 从日志批次/缓冲里拼出某脚本的纯文本行 */
function linesOf(batches, id) {
  const out = []
  for (const b of batches) {
    for (const p of b) {
      if (p.id === id) out.push(p.text)
    }
  }
  return out
}

test('runOne 跑 JS 脚本：stdout 进日志，退出带 code', async (t) => {
  const { store, runner, batches, scripts } = setup(t)
  fs.writeFileSync(path.join(scripts, 'hello.js'), 'console.log("你好"); console.error("警告");')
  const item = store.save({ name: 'hello', file: 'hello.js', lang: 'js' }).item
  const res = runner.runOne(item, scripts, {})
  assert.equal(res.ok, true)
  await waitFor(() => runner.status()[item.id] === undefined)
  const lines = linesOf(batches, item.id)
  assert.ok(lines.some((l) => l.includes('▶ 启动 hello')), '有启动行: ' + JSON.stringify(lines))
  assert.ok(lines.some((l) => l.includes('你好')), '有 stdout 行')
  assert.ok(lines.some((l) => l.includes('警告')), '有 stderr 行')
  assert.ok(lines.some((l) => l.includes('■ 结束 hello') && l.includes('code=0')), '有正常结束行')
})

test('history 环形缓冲：面板关了也能补历史', async (t) => {
  const { store, runner, scripts } = setup(t)
  fs.writeFileSync(path.join(scripts, 'h.js'), 'console.log("历史一"); console.log("历史二");')
  const item = store.save({ name: 'h', file: 'h.js', lang: 'js' }).item
  runner.runOne(item, scripts, {})
  await waitFor(() => runner.status()[item.id] === undefined)
  const h = runner.history(item.id)
  const text = h.map((p) => p.text).join('')
  assert.ok(text.includes('历史一') && text.includes('历史二'))
  assert.ok(h.some((p) => p.kind === 'sys'))
  assert.ok(h.some((p) => p.kind === 'out'))
  assert.ok(h.some((p) => p.kind === 'exit'))
})

test('stop 杀掉长跑脚本并标记 exitRequested，进程树一起带走', async (t) => {
  const { store, runner, scripts } = setup(t)
  // 脚本自己再 spawn 一个子进程（进程树），验证 /T 连坐
  fs.writeFileSync(
    path.join(scripts, 'long.js'),
    'const { spawn } = require("child_process");' +
      'spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });' +
      'setInterval(() => {}, 1000);',
  )
  const item = store.save({ name: 'long', file: 'long.js', lang: 'js' }).item
  const res = runner.runOne(item, scripts, {})
  assert.equal(res.ok, true)
  await waitFor(() => {
    const st = runner.status()[item.id]
    return st && st.length && st[0].pid
  })
  const st = await runner.stop(item.id)
  assert.equal(st.ok, true)
  assert.equal(st.stopped, 1)
  await waitFor(() => runner.status()[item.id] === undefined)
})

test('stop 指定实例：只停那一个', async (t) => {
  const { store, runner, scripts } = setup(t)
  fs.writeFileSync(path.join(scripts, 'l.js'), 'setInterval(() => {}, 1000);')
  const item = store.save({ name: 'l', file: 'l.js', lang: 'js' }).item
  const a = runner.runOne(item, scripts, {})
  const b = runner.runOne(item, scripts, {})
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  await waitFor(() => (runner.status()[item.id] || []).length === 2)
  const st = await runner.stop(item.id, a.inst)
  assert.equal(st.ok, true)
  assert.equal(st.stopped, 1)
  await waitFor(() => (runner.status()[item.id] || []).length === 1)
  const left = runner.status()[item.id][0]
  assert.equal(left.inst, b.inst)
})

test('timeoutMs 到点强杀，日志带超时提示', async (t) => {
  const { store, runner, batches, scripts } = setup(t)
  fs.writeFileSync(path.join(scripts, 'loop.js'), 'setInterval(() => {}, 1000);')
  const item = store.save({ name: 'loop', file: 'loop.js', lang: 'js' }).item
  runner.runOne(item, scripts, { intent: 'cron', timeoutMs: 800 })
  await waitFor(() => (runner.status()[item.id] || []).length === 1)
  // 800ms 后超时强杀，不用手动 stop
  await waitFor(() => runner.status()[item.id] === undefined, 8000)
  const lines = linesOf(batches, item.id)
  assert.ok(lines.some((l) => l.includes('超时')), '有超时日志: ' + JSON.stringify(lines))
})

test('没有 Python 时跑 .py 被拦下', (t) => {
  const { store, runner, scripts } = setup(t, () => null)
  fs.writeFileSync(path.join(scripts, 'p.py'), 'print(1)')
  const item = store.save({ name: 'p', file: 'p.py', lang: 'py' }).item
  const res = runner.runOne(item, scripts, {})
  assert.equal(res.ok, false)
  assert.match(res.error, /没有检测到 Python/)
})

test('有 Python 时跑 .py：cwd 是脚本目录、PYTHONIOENCODING 已设', async (t) => {
  // 用引擎自己的探测找解释器（py 启动器不一定装了），找不到就跳过
  const { detectPython } = await import('../src/scripts.mjs')
  const py = await detectPython({})
  if (!py.ok) {
    t.skip('本机检测不到 Python: ' + JSON.stringify(py))
    return
  }
  const { store, runner, batches, scripts } = setup(t, () => [py.cmd].concat(py.args))
  fs.writeFileSync(path.join(scripts, 'p.py'), 'import os; print(os.getcwd()); print(os.environ["PYTHONIOENCODING"])')
  const item = store.save({ name: 'p', file: 'p.py', lang: 'py' }).item
  const res = runner.runOne(item, scripts, {})
  assert.equal(res.ok, true)
  await waitFor(() => runner.status()[item.id] === undefined)
  const lines = linesOf(batches, item.id)
  assert.ok(lines.some((l) => l.includes(scripts)), 'cwd 应是脚本目录，实际日志: ' + JSON.stringify(lines))
  assert.ok(lines.some((l) => l.includes('utf-8')), 'PYTHONIOENCODING=utf-8')
})

test('脚本文件不存在：spawn 报错收尾，不留僵尸条目', async (t) => {
  const { store, runner, scripts } = setup(t)
  const item = store.save({ name: 'ghost', file: 'ghost.js', lang: 'js' }).item
  const res = runner.runOne(item, scripts, {})
  // Windows 上 spawn 不存在的文件也会返回 ok（报错走 error 事件），等它自己收尾
  await waitFor(() => runner.status()[item.id] === undefined)
  assert.ok(res.ok === true || res.ok === false)
})
