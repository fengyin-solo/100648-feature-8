import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'waste-to-energy-plant:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function storageAvailable(): boolean {
  return typeof window !== 'undefined' && Boolean(window.localStorage)
}

// cache 就是「上一次存好的版本」：任何时候读取失败都退回它，绝不清空成示例数据。
let cache: Record<string, EntryRow[]> | null = null

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (!storageAvailable()) {
    return cache ?? fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    // 第一次打开：播种示例数据。写不进去也只影响这次会话，下次再试。
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    } catch {
      // 存储不可用（隐私模式等），先按示例数据跑。
    }
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    const merged = { ...fallback, ...parsed }
    cache = merged
    return merged
  } catch {
    // 存进去的那份读不出来：退回上一次存好的版本，不要拿示例数据盖掉它。
    return cache ?? fallback
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
  const next = { ...allRows(), [key]: rows }
  if (storageAvailable()) {
    const payload = JSON.stringify(next)
    // 先写进存储再更新内存：写不进去就抛错，内存里保持上一次存好的版本。
    window.localStorage.setItem(STORAGE_KEY, payload)
    if (window.localStorage.getItem(STORAGE_KEY) !== payload) {
      throw new Error('本地存储写入后校验不一致，本次修改未保存')
    }
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
