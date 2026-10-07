<template>
  <section class="page" data-module="incinerator">
    <header class="page-head">
      <div>
        <h2>焚烧炉运行管理</h2>
        <p class="page-desc">维护焚烧炉运行记录，围绕运行编号、炉膛温度、炉膛负压、给料速率做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记焚烧炉运行记录</button>
        <button class="btn" type="button" @click="exportRows">导出焚烧炉运行清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th></th>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="row in rows" :key="String(row.id)">
          <tr :class="{ 'row-expanded': expandedId === row.id }">
            <td>
              <button class="link" type="button" @click="toggleExpand(row)">{{ expandedId === row.id ? '收起' : '修改读数' }}</button>
            </td>
            <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
            <td>{{ row.status }}</td>
            <td class="row-actions">
              <template v-if="availableActions(row).length">
                <button
                  v-for="action in availableActions(row)"
                  :key="action"
                  class="link"
                  type="button"
                  @click="runAction(action, row)"
                >
                  {{ action }}
                </button>
              </template>
              <span v-else class="muted-text">—</span>
            </td>
          </tr>
          <tr v-if="expandedId === row.id">
            <td></td>
            <td :colspan="columns.length + 2" class="edit-panel-cell">
              <form class="inline-edit" @submit.prevent="saveDraft(row)">
                <label v-for="field in readingFields" :key="field" class="filter-item">
                  <span>{{ field }}</span>
                  <input v-model="draft[field]" :placeholder="`请输入${field}`" />
                </label>
                <button class="btn primary" type="submit">保存读数</button>
                <button class="btn ghost" type="button" @click="expandedId = null">取消</button>
                <span v-if="editError" class="error-text">{{ editError }}</span>
              </form>
            </td>
          </tr>
        </template>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无焚烧炉运行数据，可先登记焚烧炉运行记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条焚烧炉运行记录</span>
      <span class="foot-messages">
        <span v-if="successMessage" class="success-text">{{ successMessage }}</span>
        <span v-if="warningMessage" class="warning-text">{{ warningMessage }}</span>
        <span v-if="errorMessage" class="error-text">
          {{ errorMessage }}
          <button v-if="exportFailed" class="link retry-link" type="button" @click="exportRows">重试导出</button>
        </span>
      </span>
    </footer>

    <div v-if="createOpen" class="modal-mask" @click.self="closeCreate">
      <div class="modal">
        <h3 class="modal-title">登记焚烧炉运行记录</h3>
        <form @submit.prevent="submitCreate">
          <div class="form-grid">
            <label v-for="field in createFields" :key="field" class="filter-item">
              <span>{{ field }}<em v-if="requiredFields.includes(field)" class="required-mark">*</em></span>
              <input v-model="createForm[field]" :placeholder="`请输入${field}`" />
            </label>
          </div>
          <p class="form-tip">新记录炉况状态为「待点火」；相同运行编号重复提交只会更新原记录，不会多出一条。</p>
          <p v-if="createError" class="error-text">{{ createError }}</p>
          <div class="modal-actions">
            <button class="btn primary" type="submit">提交登记</button>
            <button class="btn ghost" type="button" @click="closeCreate">取消</button>
          </div>
        </form>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
  saveEntry,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('incinerator')
const columns = ['运行编号', '炉膛温度', '炉膛负压', '给料速率', '运行班次', '操作人员', '记录时间', '炉况状态']
const readingFields = ['炉膛温度', '炉膛负压', '给料速率']
const createFields = ['运行编号', ...readingFields, '运行班次', '操作人员', '记录时间']
const requiredFields = ['运行编号', ...readingFields]
// 页面与元数据保持一致：动作是否可点由状态白名单驱动，不许跳步、终态不可再动。
const actionSources = meta.actionSources ?? {}

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const successMessage = ref('')
const warningMessage = ref('')
const exportFailed = ref(false)
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const stats = computed(() => [
  { label: '运行中炉次', value: countByStatus('运行中') },
  { label: '已停炉炉次', value: countByStatus('已停炉') },
  { label: '故障停炉数', value: countByStatus('故障停炉') },
])

const statusSummary = computed(() =>
  meta.statuses.map((status: string) => ({
    status,
    count: countByStatus(status),
  })),
)

function countByStatus(status: string): number {
  return rows.value.filter((row) => String(row.status) === status).length
}

// 展开的那一份必须和列表读到的是同一份：每次展开都按 id 从存储重新取行，不用行外缓存。
const expandedId = ref<number | null>(null)
const draft = reactive<Record<string, string>>({})
const editError = ref('')

function fillDraft(row: EntryRow) {
  for (const field of readingFields) {
    draft[field] = String(row[field] ?? '')
  }
}

function toggleExpand(row: EntryRow) {
  editError.value = ''
  if (expandedId.value === row.id) {
    expandedId.value = null
    return
  }
  const latest = listEntries(meta.key).items.find((item) => Number(item.id) === Number(row.id))
  if (!latest) {
    setError(`运行编号为 ${row['运行编号'] ?? row.id} 的记录已取不到，未保存的改动请以列表为准`)
    reload()
    return
  }
  expandedId.value = Number(latest.id)
  fillDraft(latest)
}

function saveDraft(row: EntryRow) {
  editError.value = ''
  const empty = readingFields.filter((field) => !String(draft[field] ?? '').trim())
  if (empty.length) {
    editError.value = `${empty.join('、')}不能为空`
    return
  }
  const values: Record<string, string> = {}
  for (const field of readingFields) {
    values[field] = String(draft[field]).trim()
  }
  try {
    const result = saveEntry(meta.key, { id: Number(row.id), values })
    if (!result.ok) {
      editError.value = result.message
      return
    }
    expandedId.value = null
    reload()
    successMessage.value = result.message
  } catch (error) {
    // 落盘失败时存储层已回退到上一版：重新取行回填，让页面与上一次存好的内容对上。
    const latest = listEntries(meta.key).items.find((item) => Number(item.id) === Number(row.id))
    if (latest) {
      fillDraft(latest)
    }
    editError.value = error instanceof Error ? error.message : '读数保存失败，已退回上一次存好的版本'
  }
}

const createOpen = ref(false)
const createError = ref('')

function todayLabel(): string {
  return new Date().toISOString().slice(0, 10)
}

function emptyCreateForm(): Record<string, string> {
  return {
    运行编号: '',
    炉膛温度: '',
    炉膛负压: '',
    给料速率: '',
    运行班次: '',
    操作人员: '',
    记录时间: todayLabel(),
  }
}
const createForm = reactive<Record<string, string>>(emptyCreateForm())

function openCreate() {
  setError('')
  createError.value = ''
  Object.assign(createForm, emptyCreateForm())
  createOpen.value = true
}

function closeCreate() {
  createOpen.value = false
  createError.value = ''
}

function submitCreate() {
  createError.value = ''
  const missing = requiredFields.filter((field) => !String(createForm[field] ?? '').trim())
  if (missing.length) {
    createError.value = `${missing.join('、')}不能为空`
    return
  }
  const values: Record<string, string> = {}
  for (const field of createFields) {
    const value = String(createForm[field] ?? '').trim()
    if (value) {
      values[field] = value
    }
  }
  try {
    const result = saveEntry(meta.key, { values, initialStatus: '待点火' })
    if (!result.ok) {
      createError.value = result.message
      return
    }
    closeCreate()
    reload()
    successMessage.value = result.message
  } catch (error) {
    createError.value = error instanceof Error ? error.message : '登记失败，改动未保存，请重试'
  }
}

function availableActions(row: EntryRow): string[] {
  return meta.actions.filter((action) => {
    const sources = actionSources[action]
    return sources ? sources.includes(String(row.status)) : true
  })
}

function runAction(action: string, row: EntryRow) {
  setError('')
  editError.value = ''
  let result
  try {
    result = applyAction(meta.key, Number(row.id), action)
  } catch (error) {
    setError(error instanceof Error ? error.message : '状态变更失败，已保留上一次存好的版本')
    return
  }
  if (!result.ok) {
    setError(result.message)
    return
  }
  expandedId.value = null
  reload()
  successMessage.value = result.message
  warningMessage.value = result.warning ?? ''
}

function resetFilters() {
  filters.value = {}
  reload()
}

// 导出与页面同一份过滤口径；失败给提示并允许原地再来一次。
function exportRows() {
  setError('')
  exportFailed.value = false
  try {
    downloadEntries(meta.key, filters.value)
    successMessage.value = `已按当前页面读数导出${total.value}条焚烧炉运行记录`
  } catch (error) {
    exportFailed.value = true
    setError(error instanceof Error ? error.message : '导出失败，请重试')
  }
}

function setError(message: string) {
  errorMessage.value = message
  if (message) {
    successMessage.value = ''
    warningMessage.value = ''
  }
}

function reload() {
  setError('')
  exportFailed.value = false
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '焚烧炉运行列表读取失败'
  }
}

onMounted(reload)
</script>
