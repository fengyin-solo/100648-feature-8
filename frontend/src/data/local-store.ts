import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'waste-to-energy-plant:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 上一次确认落盘成功的原始字符串：一旦当前这次写坏了，拿它退回上一版。
let lastStorage = ''
let cache: Record<string, EntryRow[]> | null = null

function isEntryStore(value: unknown): value is Record<string, EntryRow[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  return Object.values(value as Record<string, unknown>).every((rows) => Array.isArray(rows))
}

function seedStore(): Record<string, EntryRow[]> {
  return clone(SEED_ROWS)
}

function readStorage(): Record<string, EntryRow[]> {
  // 取不到（隐私模式/被禁用/内容损坏）：优先退回本会话上一次存好的版本，再退种子。
  if (typeof window === 'undefined' || !window.localStorage) {
    cache = cache ?? seedStore()
    return cache
  }
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(STORAGE_KEY)
  } catch {
    return cache ?? seedStore()
  }
  if (!raw) {
    const fallback = seedStore()
    const seeded = JSON.stringify(fallback)
    try {
      window.localStorage.setItem(STORAGE_KEY, seeded)
      lastStorage = seeded
    } catch {
      // 写不进去也不挡页面，先用内存里的种子数据。
    }
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!isEntryStore(parsed)) {
      throw new Error('存储内容结构不正确')
    }
    lastStorage = raw
    // 新模块以种子为准，已经在用的模块以浏览器里存的为准。
    return { ...seedStore(), ...parsed }
  } catch {
    return cache ?? seedStore()
  }
}

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const previous = allRows()
  const next = { ...previous, [key]: rows }

  let raw = ''
  try {
    raw = JSON.stringify(next)
  } catch {
    throw new Error('保存的数据无法序列化，已保留上一次存好的版本')
  }

  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      window.localStorage.setItem(STORAGE_KEY, raw)
      // 存完立刻读回来比对：对不上就当这次没存成，退回去。
      if (window.localStorage.getItem(STORAGE_KEY) !== raw) {
        throw new Error('写入后复核不一致')
      }
    } catch (error) {
      // 内存与浏览器存储都退回上一版，页面上显示的仍是上一次存好的内容。
      cache = previous
      if (lastStorage) {
        try {
          window.localStorage.setItem(STORAGE_KEY, lastStorage)
        } catch {
          /* 存储整体不可用，至少内存已经回退 */
        }
      }
      throw new Error('浏览器存储不可用，改动没有落盘，已退回上一次存好的版本')
    }
    lastStorage = raw
  }
  cache = next
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

// 仅供自动化校验：丢掉内存缓存，模拟刷新页面后从 localStorage 重新读取。
export function __resetCacheForTest(): void {
  cache = null
  lastStorage = ''
}
