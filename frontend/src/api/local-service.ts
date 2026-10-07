import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type {
  ActionResult,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
  SaveEntryInput,
  SaveResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']
// 目标态本身就是异常性质的：故障/异常类目标一律标异常。
const ABNORMAL_TARGET_TOKENS = ['故障', '异常']

// 系统 status 是唯一状态来源，页面上的业务状态列（炉况状态/锅炉状态…）始终跟它对齐。
function alignStatusField(row: EntryRow, meta: ModuleMeta): EntryRow {
  if (meta.statusField && String(row[meta.statusField] ?? '') !== row.status) {
    return { ...row, [meta.statusField]: row.status }
  }
  return row
}

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
  const meta = moduleMeta(key)
  const matched = filterRows(listRows(key), filters).map((row) => alignStatusField(row, meta))
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// 登记/修改记录：有主键（如运行编号）就按主键归并，同一炉次重复提交只更新同一条，不会新增。
export function saveEntry(key: string, input: SaveEntryInput): SaveResult {
  const meta = moduleMeta(key)
  const values: Record<string, string> = {}
  for (const [field, value] of Object.entries(input.values)) {
    values[field] = String(value ?? '').trim()
  }
  const rows = [...listRows(key)]
  let index = input.id === undefined ? -1 : rows.findIndex((row) => Number(row.id) === input.id)
  if (index < 0 && meta.upsertKey && values[meta.upsertKey]) {
    index = rows.findIndex((row) => String(row[meta.upsertKey as string]) === values[meta.upsertKey as string])
  }
  const existed = index >= 0
  // 业务主键只在新增时强制；按 id 修改读数时不要求带上主键。
  if (!existed && meta.upsertKey && !values[meta.upsertKey]) {
    return { ok: false, message: `${meta.upsertKey}不能为空` }
  }
  if (!existed) {
    const nextId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
    const status = input.initialStatus ?? meta.statuses[0]
    const pendingStatuses = meta.terminalStatuses ?? [meta.statuses[meta.statuses.length - 1]]
    const created: EntryRow = {
      id: nextId,
      status,
      pending: !pendingStatuses.includes(status),
      abnormal: false,
      ...values,
      ...(meta.statusField ? { [meta.statusField]: status } : {}),
    }
    rows.push(created)
    saveRows(key, rows)
    return { ok: true, message: `${meta.entity} ${values[meta.upsertKey as string] ?? '#' + nextId} 已登记`, row: created }
  }

  // 只改传进来的字段，状态由动作单独驱动，编辑读数不会把炉况改回去。
  const current = rows[index]
  const updated: EntryRow = { ...current, ...values }
  if (meta.statusField) {
    updated[meta.statusField] = current.status
  }
  rows[index] = updated
  saveRows(key, rows)
  const identity = meta.upsertKey ? String(current[meta.upsertKey]) : `#${current.id}`
  // 以存下来的为准：从存储里把这一条再读出来返回，页面展示与落盘内容必然一致。
  const stored = listRows(key).find((row) => Number(row.id) === Number(current.id)) ?? updated
  return { ok: true, message: `${meta.entity} ${identity} 已更新`, row: alignStatusField(stored, meta) }
}

function transitionBlocked(meta: ModuleMeta, action: string, current: string): string | null {
  const target = meta.actionTargets[action]
  const sources = meta.actionSources?.[action]
  if (sources && !sources.includes(current)) {
    if ((meta.terminalStatuses ?? []).includes(current)) {
      return `${meta.entity}当前是「${current}」，流程已经走完，不能再执行「${action}」改回其他状态`
    }
    return `炉况状态不能跳步：「${action}」只能在${sources
      .map((item) => `「${item}」`)
      .join('或')}时发起，当前是「${current}」`
  }
  if (!sources && (meta.terminalStatuses ?? []).includes(current)) {
    return `${meta.entity}当前是「${current}」，流程已经走完，不能再改状态`
  }
  if (current === target) {
    return `${meta.entity}已经是「${target}」，不用重复操作`
  }
  return null
}

// 焚烧炉登记停炉后，联动余热锅炉回到「待投运」；同步不上要把哪一台点出来。
function syncBoilerOnStop(inciRow: EntryRow): string | undefined {
  const inciNo = String(inciRow['运行编号'] ?? inciRow.id)
  const suffixMatch = inciNo.match(/(\d+)\s*$/)
  const suffix = suffixMatch ? suffixMatch[1] : String(inciRow.id)
  const boilerRows = [...listRows('boiler')]
  const boilerIndex = boilerRows.findIndex((row) => {
    const boilerNo = String(row['锅炉编号'] ?? '')
    const boilerSuffix = boilerNo.match(/(\d+)\s*$/)?.[1] ?? String(row.id)
    return boilerSuffix === suffix
  })
  if (boilerIndex < 0) {
    return `焚烧炉 ${inciNo} 已停炉，但没找到与之配套的余热锅炉（编号尾号 ${suffix}），锅炉状态未同步`
  }
  const boiler = boilerRows[boilerIndex]
  const boilerNo = String(boiler['锅炉编号'] ?? `#${boiler.id}`)
  const synced: EntryRow = {
    ...boiler,
    status: '待投运',
    pending: true,
    锅炉状态: '待投运',
  }
  boilerRows[boilerIndex] = synced
  try {
    saveRows('boiler', boilerRows)
  } catch (error) {
    return `焚烧炉 ${inciNo} 已停炉，但余热锅炉 ${boilerNo} 状态同步失败：${
      error instanceof Error ? error.message : '存储不可用'
    }`
  }
  // 复核：存下来的那一份必须确实变成待投运，对不上也当没同步上。
  const stored = listRows('boiler').find((row) => Number(row.id) === Number(boiler.id))
  if (!stored || String(stored.status) !== '待投运' || String(stored['锅炉状态'] ?? '') !== '待投运') {
    return `焚烧炉 ${inciNo} 已停炉，但余热锅炉 ${boilerNo} 复核仍不是「待投运」，请重新登记停炉`
  }
  return undefined
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = [...listRows(key)]
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  const blocked = transitionBlocked(meta, action, current)
  if (blocked) {
    return { ok: false, message: blocked }
  }

  const terminalStatuses = meta.terminalStatuses ?? [meta.statuses[meta.statuses.length - 1]]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: !terminalStatuses.includes(target),
    abnormal:
      rows[index].abnormal ||
      NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)) ||
      ABNORMAL_TARGET_TOKENS.some((token) => target.includes(token)),
  }
  if (meta.statusField) {
    updated[meta.statusField] = target
  }
  rows[index] = updated
  saveRows(key, rows)

  let warning: string | undefined
  if (key === 'incinerator' && action === '登记停炉') {
    warning = syncBoilerOnStop(updated)
  }
  return {
    ok: true,
    message: `${meta.entity}已${action}，当前状态「${target}」`,
    warning,
  }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

function csvCell(value: string | number | boolean | undefined): string {
  const text = String(value ?? '')
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

// 导出内容直接走与列表相同的过滤口径：页面看到哪些读数，清单里就是哪些。
export function exportEntries(key: string, filters: Record<string, string> = {}): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const { items, total } = listEntries(key, filters)
  if (total === 0) {
    throw new Error('当前筛选条件下没有可导出的焚烧炉运行记录')
  }
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.map(csvCell).join(',')]
  for (const row of items) {
    lines.push(
      [row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].map(csvCell).join(','),
    )
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string, filters: Record<string, string> = {}): void {
  const { filename, content } = exportEntries(key, filters)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  try {
    anchor.click()
  } finally {
    document.body.removeChild(anchor)
    URL.revokeObjectURL(url)
  }
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
