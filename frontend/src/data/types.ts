/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
  // 每个动作允许从哪些状态发起：不登记则保持「任何状态都可发起」的旧行为。
  actionSources?: Record<string, string[]>
  // 终态列表：进入终态后 pending=false，且不能再被任何动作改走。
  terminalStatuses?: string[]
  // 登记/修改记录时的业务主键字段（如运行编号）：同主键重复提交只更新同一条。
  upsertKey?: string
  // 页面上允许编辑的业务读数字段。
  editableFields?: string[]
  // 业务状态字段（如「炉况状态」）：它要与系统 status 始终保持一致。
  statusField?: string
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
  // 动作本身成了，但联动环节没跟上时的告警（如停炉后锅炉未同步）。
  warning?: string
}

export type SaveResult = {
  ok: boolean
  message: string
  row?: EntryRow
}

export type SaveEntryInput = {
  id?: number
  values: Record<string, string>
  // 登记新记录时的初始状态；编辑时不会用它覆盖现有状态。
  initialStatus?: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
