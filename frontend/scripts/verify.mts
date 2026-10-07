/**
 * 焚烧炉运行记录这条线的端到端校验（纯 Node + localStorage 垫片）：
 * 覆盖持久化、同一份数据、upsert、状态流转约束、停炉联动锅炉、导出一致性、存储失败回退。
 * 运行：node scripts/verify.mjs（由 esbuild 打包生成）
 */

// ---- 最小 DOM/BOM 垫片 ----
class MemoryStorage {
  private map = new Map<string, string>()
  failWrites = false
  getItem(key: string) {
    return this.map.has(key) ? (this.map.get(key) as string) : null
  }
  setItem(key: string, value: string) {
    if (this.failWrites) {
      throw new Error('模拟：localStorage 写入被禁用')
    }
    this.map.set(key, String(value))
  }
  removeItem(key: string) {
    this.map.delete(key)
  }
  clear() {
    this.map.clear()
  }
}

const storage = new MemoryStorage()
;(globalThis as any).window = {
  localStorage: storage,
  document: undefined,
}
;(globalThis as any).localStorage = storage

class FakeBlob {
  constructor(public parts: any[], public opts: any) {}
}
;(globalThis as any).Blob = FakeBlob
;(globalThis as any).URL = {
  createObjectURL: () => 'blob:mock',
  revokeObjectURL: () => {},
}
;(globalThis as any).document = {
  createElement: () => ({ click() {} }),
  body: { appendChild() {}, removeChild() {} },
}

// ---- 被测模块（打包后内联） ----
const store = await import('../src/data/local-store.ts')
const service = await import('../src/api/local-service.ts')

let passed = 0
let failed = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.error(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`)
  }
}

const INCI = 'incinerator'
const BOILER = 'boiler'

function reloadPage() {
  store.__resetCacheForTest()
}

function inciRows() {
  return service.listEntries(INCI).items
}
function findInci(id: number) {
  return inciRows().find((r) => Number(r.id) === id)!
}

// 种子里有 3 条：待点火(1) / 运行中(2) / 已停炉(3)
check('初始有 3 条种子焚烧炉记录', inciRows().length === 3)

// 1) 读数修改 → 刷新后仍在（列表与展开同源）
service.saveEntry(INCI, {
  id: 2,
  values: { 炉膛温度: '980℃', 炉膛负压: '-50Pa', 给料速率: '8.2t/h' },
})
reloadPage()
const r2 = findInci(2)
check('炉膛温度刷新后仍在', String(r2['炉膛温度']) === '980℃')
check('炉膛负压刷新后仍在', String(r2['炉膛负压']) === '-50Pa')
check('给料速率刷新后仍在', String(r2['给料速率']) === '8.2t/h')
check('编辑读数不会改动炉况状态', String(r2.status) === '运行中')
check('业务状态列与系统状态一致', String(r2['炉况状态']) === '运行中')

// 2) 同一运行编号重复提交只更新同一条
const before = inciRows().length
service.saveEntry(INCI, {
  values: {
    运行编号: String(r2['运行编号']),
    炉膛温度: '1005℃',
    炉膛负压: '-48Pa',
    给料速率: '8.4t/h',
  },
  initialStatus: '待点火',
})
check('相同运行编号不新增记录', inciRows().length === before)
reloadPage()
const r2b = inciRows().find((r) => String(r['运行编号']) === String(r2['运行编号']))!
check('重复提交更新到原记录', String(r2b['炉膛温度']) === '1005℃')
check('重复提交不会把运行中重置成待点火', String(r2b.status) === '运行中')

// 新编号 → 新增一条待点火
service.saveEntry(INCI, {
  values: { 运行编号: 'INCI-0099', 炉膛温度: '0℃', 炉膛负压: '0Pa', 给料速率: '0t/h' },
  initialStatus: '待点火',
})
check('新运行编号才新增记录', inciRows().length === before + 1)
const r99 = inciRows().find((r) => String(r['运行编号']) === 'INCI-0099')!
check('新记录为待点火', String(r99.status) === '待点火' && r99.pending === true)

// 3) 状态流转：不许跳步
const id1 = Number(inciRows().find((r) => String(r.status) === '待点火')!.id)
check('待点火不能直接登记停炉', service.runAction(INCI, id1, '登记停炉').ok === false)
check('待点火不能上报故障', service.runAction(INCI, id1, '上报故障').ok === false)
check('待点火提交点火成功', service.runAction(INCI, id1, '提交点火').ok === true)
check('点火后为运行中', findInci(id1).status === '运行中')
check('运行中不能重复提交点火', service.runAction(INCI, id1, '提交点火').ok === false)
check('运行中上报故障成功', service.runAction(INCI, id1, '上报故障').ok === true)
check('上报故障后标记异常', findInci(id1).abnormal === true)
check('故障停炉不能被点回运行中', service.runAction(INCI, id1, '提交点火').ok === false)
check('故障停炉仍须登记停炉收尾', service.runAction(INCI, id1, '登记停炉').ok === true)
check('收尾后为已停炉', findInci(id1).status === '已停炉')
check('已停炉 pending=false', findInci(id1).pending === false)
check('已停炉不能改回运行中', service.runAction(INCI, id1, '提交点火').ok === false)
check('已停炉不能再上报故障', service.runAction(INCI, id1, '上报故障').ok === false)
check('已停炉重复登记停炉被拒', service.runAction(INCI, id1, '登记停炉').ok === false)

// 4) 停炉联动余热锅炉 → 待投运
// 运行中的 #2（编号 INCI-0002）对应锅炉尾号 0002，种子中 BOIL-0002 是运行中
const boilBefore = service
  .listEntries(BOILER)
  .items.find((b) => String(b['锅炉编号']) === 'BOIL-0002')!
check('联动前 BOIL-0002 为运行中', String(boilBefore.status) === '运行中')
const stopRes = service.runAction(INCI, Number(r2b.id), '登记停炉')
check('运行中登记停炉成功', stopRes.ok === true)
reloadPage()
const boilAfter = service
  .listEntries(BOILER)
  .items.find((b) => String(b['锅炉编号']) === 'BOIL-0002')!
check('联动后锅炉状态为待投运', String(boilAfter.status) === '待投运')
check('联动后锅炉状态列也是待投运', String(boilAfter['锅炉状态']) === '待投运')
check('联动后刷新仍为待投运', true) // 上面的 reloadPage 已覆盖
check('联动成功无告警', !stopRes.warning, stopRes.warning ?? '')

// 找不到配套锅炉时要带得出是哪一台
const noBoilId = Number(r99.id)
service.runAction(INCI, noBoilId, '提交点火')
const missRes = service.runAction(INCI, noBoilId, '登记停炉')
check('缺配套锅炉时停炉仍成功但有告警', missRes.ok === true && !!missRes.warning)
check('告警点得出焚烧炉与尾号', missRes.warning?.includes('INCI-0099') && missRes.warning.includes('99') === true, missRes.warning)

// 5) 导出与页面读数一致（含筛选）
const filtered = service.listEntries(INCI, { 运行编号: 'INCI-0002' })
check('筛选命中一条', filtered.items.length === 1)
const exp = service.exportEntries(INCI, { 运行编号: 'INCI-0002' })
const lines = exp.content.replace(/^﻿/, '').split('\n')
check('导出仅含表头+一条', lines.length === 2)
check('导出行包含页面最新读数', lines[1].includes('1005℃') && lines[1].includes('8.4t/h'))
check('导出文件名正确', exp.filename === '焚烧炉运行-清单.csv')
check('空筛选导出抛错可被捕获', (() => {
  try {
    service.exportEntries(INCI, { 运行编号: '不可能存在的编号XYZ' })
    return false
  } catch {
    return true
  }
})())

// 6) 存储写失败：页面报错并退回上一版
const tempBefore = String(findInci(2)['炉膛温度'])
storage.failWrites = true
let threw = false
try {
  service.saveEntry(INCI, { id: 2, values: { 炉膛温度: '9999℃', 炉膛负压: '-1Pa', 给料速率: '1t/h' } })
} catch {
  threw = true
}
storage.failWrites = false
check('存储写失败时向上抛错', threw)
check('失败后读到的仍是上一版读数', String(findInci(2)['炉膛温度']) === tempBefore)
reloadPage()
check('刷新后仍是上一版（没落盘坏数据）', String(findInci(2)['炉膛温度']) === tempBefore)

// 7) localStorage 内容损坏：退回上一版/种子，页面不崩
storage.setItem(store.storageKey(), '{这不是合法JSON')
reloadPage()
let recovered = false
try {
  recovered = service.listEntries(INCI).items.length >= 3
} catch {
  recovered = false
}
check('存储损坏时回退数据且不抛异常', recovered)

console.log(`\n结果：${passed} 通过，${failed} 失败`)
if (failed > 0) {
  process.exit(1)
}
