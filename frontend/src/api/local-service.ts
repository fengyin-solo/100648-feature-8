import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 状态只能顺着走的模块在这里登记：当前状态 → 允许到达的下一个状态。
// 炉况状态：待点火 → 运行中 → 已停炉，中途不许跳；上报故障走旁路；已停炉、故障停炉是终态，不能再改回运行中。
const FLOW_RULES: Record<string, Record<string, string[]>> = {
  incinerator: {
    待点火: ['运行中', '故障停炉'],
    运行中: ['已停炉', '故障停炉'],
    已停炉: [],
    故障停炉: [],
  },
}

// 焚烧炉进入这些停炉态时，对应的余热锅炉要同步成待投运。
const BOILER_MODULE_KEY = 'boiler'
const BOILER_STANDBY_STATUS = '待投运'
const BOILER_SYNC_STATUSES = new Set(['已停炉', '故障停炉'])

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// 展开详情和列表读的是同一份数据：都从 listRows 里取。
export function getEntry(key: string, id: number): EntryRow | null {
  return listRows(key).find((row) => Number(row.id) === id) ?? null
}

function saveResult(key: string, meta: ModuleMeta, next: EntryRow[]): ActionResult | null {
  try {
    saveRows(key, next)
    return null
  } catch (error) {
    // 写不进去时内存里仍是上一次存好的版本，页面重新读取就会退回那份。
    return {
      ok: false,
      message: error instanceof Error ? error.message : `${meta.entity}保存失败，请重试`,
    }
  }
}

// 修改一条记录的字段（炉膛温度、炉膛负压、给料速率等），只接受模块登记过的字段。
export function updateEntry(key: string, id: number, patch: Record<string, string>): ActionResult {
  const meta = moduleMeta(key)
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const allowed = new Set(meta.fields)
  const cleaned: Record<string, string> = {}
  for (const [field, value] of Object.entries(patch)) {
    if (allowed.has(field)) {
      cleaned[field] = value
    }
  }
  const next = [...rows]
  next[index] = { ...rows[index], ...cleaned }
  const failure = saveResult(key, meta, next)
  if (failure) {
    return failure
  }
  return { ok: true, message: `${meta.entity}已保存` }
}

// 登记入口：按业务编号（第一个字段，如运行编号）upsert——同一炉次重复提交只更新同一条，不会多出一条。
export function submitEntry(key: string, values: Record<string, string>): ActionResult {
  const meta = moduleMeta(key)
  const codeField = meta.fields[0]
  const code = String(values[codeField] ?? '').trim()
  if (!code) {
    return { ok: false, message: `${codeField}不能为空` }
  }
  const allowed = new Set(meta.fields)
  const cleaned: Record<string, string> = {}
  for (const [field, value] of Object.entries(values)) {
    if (allowed.has(field)) {
      cleaned[field] = value.trim()
    }
  }
  const rows = listRows(key)
  const existing = rows.findIndex((row) => String(row[codeField] ?? '') === code)
  const next = [...rows]
  if (existing >= 0) {
    next[existing] = { ...rows[existing], ...cleaned }
  } else {
    const id = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
    next.push({
      id,
      status: meta.statuses[0],
      pending: true,
      abnormal: false,
      ...cleaned,
    })
  }
  const failure = saveResult(key, meta, next)
  if (failure) {
    return failure
  }
  return {
    ok: true,
    message:
      existing >= 0
        ? `${meta.entity}「${code}」已更新，同一${codeField}只保留一条`
        : `${meta.entity}「${code}」已登记，当前状态「${meta.statuses[0]}」`,
  }
}

// 当前状态下允许执行的动作：页面按它渲染按钮，走不到的动作不显示。
export function availableActions(key: string, status: string): string[] {
  const meta = moduleMeta(key)
  const flow = FLOW_RULES[key]
  if (!flow) {
    return meta.actions
  }
  const reachable = flow[status] ?? []
  return meta.actions.filter((action) => reachable.includes(meta.actionTargets[action]))
}

function trailingNumber(text: string): number | null {
  const groups = text.match(/\d+/g)
  return groups ? Number(groups[groups.length - 1]) : null
}

// 焚烧炉停炉后，把同一炉次的余热锅炉同步成待投运；同步不上要把是哪一台报出来。
function syncBoilersForShutdown(row: EntryRow): { synced: string[]; failed: string[] } {
  const runNo = String(row['运行编号'] ?? '').trim()
  const runSeq = trailingNumber(runNo)
  const boilers = listRows(BOILER_MODULE_KEY)
  const linked =
    runSeq === null
      ? []
      : boilers.filter(
          (boiler) => trailingNumber(String(boiler['锅炉编号'] ?? '')) === runSeq,
        )
  if (linked.length === 0) {
    return { synced: [], failed: [`炉次 ${runNo || '（无运行编号）'} 找不到对应的余热锅炉`] }
  }
  const linkedIds = new Set(linked.map((boiler) => Number(boiler.id)))
  const next = boilers.map((boiler) =>
    linkedIds.has(Number(boiler.id)) && boiler.status !== BOILER_STANDBY_STATUS
      ? { ...boiler, status: BOILER_STANDBY_STATUS, pending: true }
      : boiler,
  )
  try {
    saveRows(BOILER_MODULE_KEY, next)
  } catch (error) {
    const reason = error instanceof Error ? error.message : '本地存储写入失败'
    return {
      synced: [],
      failed: linked.map((boiler) => `${String(boiler['锅炉编号'] ?? boiler.id)}（${reason}）`),
    }
  }
  return {
    synced: linked.map((boiler) => String(boiler['锅炉编号'] ?? boiler.id)),
    failed: [],
  }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const flow = FLOW_RULES[key]
  if (flow && !(flow[current] ?? []).includes(target)) {
    const statusField = meta.fields[meta.fields.length - 1]
    return {
      ok: false,
      message: `${statusField}不能从「${current}」直接改为「${target}」，只能按顺序流转`,
    }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  const failure = saveResult(key, meta, next)
  if (failure) {
    return failure
  }
  let message = `${meta.entity}已${action}，当前状态「${target}」`
  let ok = true
  if (key === 'incinerator' && BOILER_SYNC_STATUSES.has(target)) {
    const sync = syncBoilersForShutdown(updated)
    if (sync.synced.length > 0) {
      message += `；余热锅炉 ${sync.synced.join('、')} 已同步为${BOILER_STANDBY_STATUS}`
    }
    if (sync.failed.length > 0) {
      ok = false
      message += `；未同步成${BOILER_STANDBY_STATUS}的余热锅炉：${sync.failed.join('、')}，请到余热锅炉运行页核对`
    }
  }
  return { ok, message }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

function csvCell(value: unknown): string {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

// 导出和页面看的是同一份数据：同一个存储、同一套筛选条件。
export function exportEntries(
  key: string,
  filters: Record<string, string> = {},
): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.map(csvCell).join(',')]
  for (const row of filterRows(listRows(key), filters)) {
    lines.push(
      [row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status]
        .map(csvCell)
        .join(','),
    )
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string, filters: Record<string, string> = {}): void {
  const { filename, content } = exportEntries(key, filters)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
