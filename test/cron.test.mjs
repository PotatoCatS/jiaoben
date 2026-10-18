// cron 解析与下次运行时间测试（纯函数，不碰文件系统）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCron, cronMatchesMinute, cronNextParsed, cronNext } from '../src/scripts.mjs'

/** 本地时间构造（v0.1.3 教训：日期测试一律用本地时区，不能用 toISOString 的 UTC） */
function lt(y, m, d, h, mi, s) {
  return new Date(y, m - 1, d, h || 0, mi || 0, s || 0, 0).getTime()
}

// ---------- parseCron：合法表达式 ----------
test('parseCron 合法：*/5 分钟步进', () => {
  const r = parseCron('*/5 * * * *')
  assert.equal(r.ok, true)
  assert.deepEqual(r.min, [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55])
  assert.equal(r.dayRestricted, false)
  assert.equal(r.dowRestricted, false)
  assert.equal(r.expr, '*/5 * * * *')
})

test('parseCron 合法：列表与范围混合、去重', () => {
  const r = parseCron('1,1,5-7 * * * *')
  assert.equal(r.ok, true)
  assert.deepEqual(r.min, [1, 5, 6, 7])
})

test('parseCron 合法：周 7 归一成 0（周日）', () => {
  const r = parseCron('0 0 * * 7')
  assert.equal(r.ok, true)
  assert.deepEqual(r.dow, [0])
  assert.equal(r.dowRestricted, true)
})

test('parseCron 合法：周范围 0-7 都收且归一到 0-6', () => {
  const r = parseCron('0 0 * * 0-7')
  assert.equal(r.ok, true)
  assert.deepEqual(r.dow, [0, 1, 2, 3, 4, 5, 6])
})

test('parseCron 合法：首尾空白与多余空格被归一化', () => {
  const r = parseCron('  0   12   *  * 1-5  ')
  assert.equal(r.ok, true)
  assert.equal(r.expr, '0 12 * * 1-5')
})

// ---------- parseCron：错误表达式 ----------
test('parseCron 报错：空表达式', () => {
  const r = parseCron('')
  assert.equal(r.ok, false)
  assert.match(r.error, /表达式为空/)
})

test('parseCron 报错：字段数不对', () => {
  const r = parseCron('*/5 * * *')
  assert.equal(r.ok, false)
  assert.match(r.error, /需要 5 个字段/)
})

test('parseCron 报错：取值超范围', () => {
  const r = parseCron('60 * * * *')
  assert.equal(r.ok, false)
  assert.match(r.error, /取值超范围/)
})

test('parseCron 报错：步长为 0', () => {
  const r = parseCron('*/0 * * * *')
  assert.equal(r.ok, false)
  assert.match(r.error, /步长要 ≥ 1/)
})

test('parseCron 报错：回绕范围 5-2', () => {
  const r = parseCron('5-2 * * * *')
  assert.equal(r.ok, false)
  assert.match(r.error, /范围起始大于结束/)
})

test('parseCron 报错：空项（连续逗号）', () => {
  const r = parseCron('1,,5 * * * *')
  assert.equal(r.ok, false)
  assert.match(r.error, /空项/)
})

test('parseCron 报错：不认识的写法', () => {
  const r = parseCron('abc * * * *')
  assert.equal(r.ok, false)
  assert.match(r.error, /写法不认识/)
})

// ---------- cronMatchesMinute ----------
test('cronMatchesMinute：分钟/小时/月命中，日周或语义', () => {
  const parsed = parseCron('30 8 * * *')
  assert.equal(parsed.ok, true)
  assert.equal(cronMatchesMinute(parsed, lt(2026, 10, 17, 8, 30)), true)
  assert.equal(cronMatchesMinute(parsed, lt(2026, 10, 17, 8, 31)), false)
  assert.equal(cronMatchesMinute(parsed, lt(2026, 10, 17, 9, 30)), false)
})

test('cronMatchesMinute：日与周同时受限按「或」触发', () => {
  const parsed = parseCron('0 0 13 * 5') // 每月 13 号 或 每个周五
  assert.equal(parsed.ok, true)
  const friday = lt(2026, 10, 2, 0, 0) // 2026-10-02 是周五
  const thirteen = lt(2026, 10, 13, 0, 0) // 13 号（周二）
  assert.equal(cronMatchesMinute(parsed, friday), true)
  assert.equal(cronMatchesMinute(parsed, thirteen), true)
  assert.equal(cronMatchesMinute(parsed, lt(2026, 10, 3, 0, 0)), false)
})

// ---------- cronNextParsed：下次运行时间 ----------
test('cronNext 每天零点：跨天', () => {
  const n = cronNext('0 0 * * *', lt(2026, 10, 17, 12, 0))
  assert.equal(n.ok, true)
  assert.equal(n.time, lt(2026, 10, 18, 0, 0))
})

test('cronNext 从当前分钟之后起算（不含当前这分钟）', () => {
  const n = cronNext('*/5 * * * *', lt(2026, 10, 17, 12, 1, 30))
  assert.equal(n.ok, true)
  assert.equal(n.time, lt(2026, 10, 17, 12, 5))
})

test('cronNext 精确命中当下这一分钟时顺延到下个点', () => {
  const n = cronNext('30 8 * * *', lt(2026, 10, 17, 8, 30, 0))
  assert.equal(n.ok, true)
  assert.equal(n.time, lt(2026, 10, 18, 8, 30))
})

test('cronNext 跨年', () => {
  const n = cronNext('0 0 * * *', lt(2026, 12, 31, 23, 30))
  assert.equal(n.ok, true)
  assert.equal(n.time, lt(2027, 1, 1, 0, 0))
})

test('cronNext 限定月份：1 月 1 日', () => {
  const n = cronNext('0 0 1 1 *', lt(2026, 6, 15, 9, 0))
  assert.equal(n.ok, true)
  assert.equal(n.time, lt(2027, 1, 1, 0, 0))
})

test('cronNext 2 月 29 日：闰年命中', () => {
  const n = cronNext('0 0 29 2 *', lt(2024, 1, 1, 0, 0))
  assert.equal(n.ok, true)
  assert.equal(n.time, lt(2024, 2, 29, 0, 0))
})

test('cronNext 2 月 29 日：平年跳过，等下一个闰年', () => {
  const n = cronNext('0 0 29 2 *', lt(2025, 3, 1, 0, 0))
  assert.equal(n.ok, true)
  assert.equal(n.time, lt(2028, 2, 29, 0, 0))
})

test('cronNext 日周或语义：周五比 13 号先到', () => {
  const n = cronNext('0 0 13 * 5', lt(2026, 10, 1, 12, 0)) // 10-01 周四之后，先碰 10-02 周五
  assert.equal(n.ok, true)
  assert.equal(n.time, lt(2026, 10, 2, 0, 0))
})

test('cronNext 无解表达式快速失败（4 月没有 31 号）', () => {
  const n = cronNext('0 0 31 4 *', lt(2026, 1, 1, 0, 0))
  assert.equal(n.ok, false)
  assert.match(n.error, /没有有效时间/)
})

test('cronNext 无解表达式快速失败（2 月没有 30 号）', () => {
  const n = cronNext('0 0 30 2 *', lt(2026, 1, 1, 0, 0))
  assert.equal(n.ok, false)
  assert.match(n.error, /没有有效时间/)
})

test('cronNextParsed 用解析结果直接算（不重复解析）', () => {
  const parsed = parseCron('0 9 * * 1-5')
  assert.equal(parsed.ok, true)
  const n = cronNextParsed(parsed, lt(2026, 10, 16, 20, 0)) // 周五晚 → 下周一早 9 点
  assert.equal(n.ok, true)
  assert.equal(n.time, lt(2026, 10, 19, 9, 0))
})
