// ============================================================================
// jiaoben —— 脚本管理器引擎库统一出口
// ============================================================================
// 用法：
//   import { createScriptsStore, createScriptRunner, createScriptScheduler } from 'jiaoben'
// 完整接口说明见 README.md。
// ============================================================================

export {
  langOf,
  detectPython,
  probePython,
  parseCron,
  cronMatchesMinute,
  cronNextParsed,
  cronNext,
  createScriptsStore,
  createScriptRunner,
  createScriptScheduler,
} from './scripts.mjs'

export { createExamplesStore } from './examples.mjs'
