// 调度器测试：分钟 tick、开机补跑、7 天上限、长驻守护与报警、随启动
// 全部用真实子进程 + 短等待，时间线控制靠「种状态文件」伪造 lastMinute。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createScriptsStore, createScriptRunner, createScriptScheduler } from '../src/scripts.mjs'

const MARK = 'mark.txt'

function tmp(t) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jb-sched-'))
  const scripts = fs.mkdtempSync(path.join(os.tmpdir(), 'jb-sched-dir-'))
  return { data, scripts }
}

function seedState(dataDir, lastMinute) {
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(
    path.join(dataDir, 'scripts-schedule.json'),
    JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), lastMinute: lastMinute }),
    'utf8',
  )
}

function minOf(ms) {
  return Math.floor(ms / 60000)
}

async function waitFor(fn, timeoutMs, step) {
  timeoutMs = timeoutMs || 8000
  step = step || 50
  const t0 = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((r) => setTimeout(r, step))
  }
}

function historyText(runner, id) {
  return runner.history(id).map((p) => p.text).join('\n')
}

function setup(t, { scriptBody, item, lastMinute }) {
  const { data, scripts } = tmp(t)
  const store = createScriptsStore({ dataDir: data })
  store.setDir(scripts)
  fs.writeFileSync(path.join(scripts, item.file), scriptBody)
  const saved = store.save(item).item
  const logs = []
  const runner = createScriptRunner({ store: store, sendLog: () => {}, getPython: () => null, log: (m) => logs.push(m) })
  if (lastMinute !== null) seedState(data, lastMinute)
  const scheduler = createScriptScheduler({ store: store, runner: runner, dataDir: data, log: (m) => logs.push(m), ready: () => Promise.resolve() })
  // 单一清理钩子：先停调度器、杀光子进程，等退出事件落定，再删目录
  // （Windows 上子进程 cwd 还在目录里时删目录会 EPERM）
  t.after(async () => {
    scheduler.stop()
    await runner.stopAll()
    await waitFor(() => runner.running().size === 0, 5000).catch(() => {})
    await new Promise((r) => setTimeout(r, 100))
    fs.rmSync(data, { recursive: true, force: true })
    fs.rmSync(scripts, { recursive: true, force: true })
  })
  return { store, runner, scheduler, logs, scripts, saved }
}

// ---------- 开机补跑 ----------
test('开机补跑：错过 3 分钟，勾了补跑的脚本补最后一次，日志带「开机补跑」', async (t) => {
  const nowMin = minOf(Date.now())
  const { runner, scheduler, scripts, saved } = setup(t, {
    scriptBody: 'require("fs").appendFileSync("' + MARK + '", "x");',
    item: { name: 'c', file: 'c.js', lang: 'js', cron: '*/1 * * * *', cronCatchUp: true },
    lastMinute: nowMin - 3,
  })
  scheduler.start()
  await waitFor(() => fs.existsSync(path.join(scripts, MARK)))
  await waitFor(() => historyText(runner, saved.id).includes('开机补跑'))
})

test('开机补跑：没勾「补跑」的脚本不补', async (t) => {
  const nowMin = minOf(Date.now())
  const { runner, scheduler, scripts, saved } = setup(t, {
    scriptBody: 'require("fs").appendFileSync("' + MARK + '", "x");',
    item: { name: 'c2', file: 'c2.js', lang: 'js', cron: '*/1 * * * *', cronCatchUp: false },
    lastMinute: nowMin - 3,
  })
  scheduler.start()
  await waitFor(() => historyText(runner, saved.id).includes('定时'), 3000)
  // 定时 tick 可能会跑（分钟推进），但补跑通道绝不能跑
  assert.equal(historyText(runner, saved.id).includes('开机补跑'), false)
})

test('开机补跑：只差 1 分钟不补（可能是同分钟重启）', async (t) => {
  const nowMin = minOf(Date.now())
  const { runner, scheduler, saved } = setup(t, {
    scriptBody: 'require("fs").appendFileSync("' + MARK + '", "x");',
    item: { name: 'c3', file: 'c3.js', lang: 'js', cron: '*/1 * * * *', cronCatchUp: true },
    lastMinute: nowMin - 1,
  })
  scheduler.start()
  // gap=1 → 补跑通道不动；但当前分钟由 tick 正常触发（标「定时」）是应该的
  await waitFor(() => historyText(runner, saved.id).includes('定时'), 3000)
  assert.equal(historyText(runner, saved.id).includes('开机补跑'), false)
})

test('开机补跑：超过 7 天直接放弃并记日志', async (t) => {
  const nowMin = minOf(Date.now())
  const { runner, scheduler, logs, saved } = setup(t, {
    scriptBody: 'require("fs").appendFileSync("' + MARK + '", "x");',
    item: { name: 'c4', file: 'c4.js', lang: 'js', cron: '*/1 * * * *', cronCatchUp: true },
    lastMinute: nowMin - (7 * 24 * 60 + 5),
  })
  scheduler.start()
  await waitFor(() => logs.some((l) => l.includes('超过 7 天')))
  assert.equal(historyText(runner, saved.id).includes('开机补跑'), false)
})

// ---------- 定时 tick ----------
test('分钟推进触发定时，日志带「定时」且防重表拦重复', async (t) => {
  const nowMin = minOf(Date.now())
  const { runner, scheduler, saved } = setup(t, {
    scriptBody: 'require("fs").appendFileSync("' + MARK + '", "x");',
    item: { name: 't1', file: 't1.js', lang: 'js', cron: '* * * * *' },
    lastMinute: nowMin - 1,
  })
  scheduler.start()
  await waitFor(() => historyText(runner, saved.id).includes('定时'), 3000)
  // 同一分钟内 tick 多次也只能跑一次（跨分钟边界时再触发一次是正常行为，
  // 所以这里只等 1 秒内查重，撞上边界的概率极小）
  const before = historyText(runner, saved.id).split('\n').filter((l) => l.includes('，定时')).length
  await new Promise((r) => setTimeout(r, 1000))
  const after = historyText(runner, saved.id).split('\n').filter((l) => l.includes('，定时')).length
  assert.equal(after, before)
  assert.ok(before >= 1)
})

// ---------- 随启动 ----------
test('onStartup 脚本随启动跑一次，日志带「随启动」', async (t) => {
  const { runner, scheduler, scripts, saved } = setup(t, {
    scriptBody: 'require("fs").appendFileSync("' + MARK + '", "x");',
    item: { name: 's1', file: 's1.js', lang: 'js', onStartup: true },
    lastMinute: null,
  })
  scheduler.start()
  await waitFor(() => fs.existsSync(path.join(scripts, MARK)))
  await waitFor(() => historyText(runner, saved.id).includes('随启动'))
  // 没有状态文件时：当前分钟记成基线，不触发定时（无 cron 也触发不了）
})

// ---------- 长驻守护 ----------
test('长驻脚本连崩 3 次：报警标红、停止自动拉起', async (t) => {
  const { runner, scheduler, logs, saved } = setup(t, {
    scriptBody: 'process.exit(1);',
    item: { name: 'd1', file: 'd1.js', lang: 'js', daemon: true },
    lastMinute: null,
  })
  scheduler.start()
  await waitFor(() => scheduler.getAlarm(saved.id), 15000)
  const alarm = scheduler.getAlarm(saved.id)
  assert.match(alarm, /已停止自动拉起/)
  // 报警后再等一个拉起周期，确认没有第 4 次拉起
  await new Promise((r) => setTimeout(r, 1500))
  assert.equal(runner.status()[saved.id], undefined)
  // 「意外退出 / 连续崩溃」是主进程日志（log 回调），不在脚本日志缓冲里
  assert.ok(logs.some((l) => l.includes('意外退出')), '日志: ' + JSON.stringify(logs))
  assert.ok(logs.some((l) => l.includes('连续崩溃')), '日志: ' + JSON.stringify(logs))
})

test('长驻脚本用户主动停止：不打报警、不自动拉起', async (t) => {
  const { runner, scheduler, saved } = setup(t, {
    scriptBody: 'setInterval(() => {}, 1000);',
    item: { name: 'd2', file: 'd2.js', lang: 'js', daemon: true },
    lastMinute: null,
  })
  scheduler.start()
  await waitFor(() => (runner.status()[saved.id] || []).length === 1)
  const st = await runner.stop(saved.id)
  assert.equal(st.ok, true)
  await waitFor(() => runner.status()[saved.id] === undefined)
  // 等 1.5 秒（超过拉起延迟），确认没有自动拉起
  await new Promise((r) => setTimeout(r, 1500))
  assert.equal(runner.status()[saved.id], undefined)
  assert.equal(scheduler.getAlarm(saved.id), null)
})
