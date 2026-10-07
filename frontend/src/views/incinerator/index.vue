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
        <button v-if="exportFailed" class="btn" type="button" @click="exportRows">重试导出</button>
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

    <form v-if="showCreate" class="create-form" @submit.prevent="submitCreate">
      <label v-for="field in createFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input
          v-model="createForm[field]"
          :type="field === '记录时间' ? 'date' : 'text'"
          :required="field === '运行编号'"
          :placeholder="`填写${field}`"
        />
      </label>
      <button class="btn primary" type="submit">提交</button>
      <button class="btn ghost" type="button" @click="showCreate = false">取消</button>
      <span class="form-hint">同一运行编号重复提交只会更新同一条记录</span>
    </form>

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
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="row in rows" :key="String(row.id)">
          <tr>
            <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
            <td>{{ row.status }}</td>
            <td class="row-actions">
              <button class="link" type="button" @click="toggleDetail(row)">
                {{ expandedId === Number(row.id) ? '收起' : '展开' }}
              </button>
              <button
                v-for="action in rowActions(row)"
                :key="action"
                class="link"
                type="button"
                @click="runAction(action, row)"
              >
                {{ action }}
              </button>
            </td>
          </tr>
          <tr v-if="expandedId === Number(row.id)" class="detail-row">
            <td :colspan="columns.length + 2">
              <div v-if="detail" class="detail-panel">
                <dl class="detail-grid">
                  <template v-for="column in columns" :key="column">
                    <dt>{{ column }}</dt>
                    <dd v-if="editableFields.includes(column)">
                      <input v-model="detailDraft[column]" :placeholder="`填写${column}`" />
                    </dd>
                    <dd v-else>{{ detail[column] ?? '—' }}</dd>
                  </template>
                  <dt>当前状态</dt>
                  <dd>{{ detail.status }}</dd>
                </dl>
                <div class="detail-actions">
                  <button class="btn primary" type="button" @click="saveDetail">保存修改</button>
                  <button class="btn ghost" type="button" @click="toggleDetail(row)">收起</button>
                </div>
              </div>
            </td>
          </tr>
        </template>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无焚烧炉运行数据，可先登记焚烧炉运行记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条焚烧炉运行记录</span>
      <span v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  availableActions,
  downloadEntries,
  getEntry,
  listEntries,
  moduleMeta,
  runAction as applyAction,
  submitEntry,
  updateEntry,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('incinerator')
const columns = ["运行编号", "炉膛温度", "炉膛负压", "给料速率", "运行班次", "操作人员", "记录时间", "炉况状态"]
const statuses = ["待点火", "运行中", "已停炉", "故障停炉"]
// 展开详情里允许修改的读数：炉膛温度、炉膛负压、给料速率。
const editableFields = ["炉膛温度", "炉膛负压", "给料速率"]
const createFields = ["运行编号", "炉膛温度", "炉膛负压", "给料速率", "运行班次", "操作人员", "记录时间"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const exportFailed = ref(false)
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const showCreate = ref(false)
const createForm = ref<Record<string, string>>({})

const expandedId = ref<number | null>(null)
const detail = ref<EntryRow | null>(null)
const detailDraft = ref<Record<string, string>>({})

const stats = computed(() => [
  { label: '运行中炉次', value: rows.value.filter((row) => row.status === '运行中').length },
  { label: '已停炉炉次', value: rows.value.filter((row) => row.status === '已停炉').length },
  { label: '故障停炉数', value: rows.value.filter((row) => row.status === '故障停炉').length },
])
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function rowActions(row: EntryRow): string[] {
  return availableActions(meta.key, String(row.status))
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  errorMessage.value = ''
  noticeMessage.value = ''
  try {
    // 导出跟着当前筛选条件走，清单读数和页面上看到的一致。
    downloadEntries(meta.key, filters.value)
    exportFailed.value = false
    noticeMessage.value = '焚烧炉运行清单已导出'
  } catch (error) {
    exportFailed.value = true
    errorMessage.value =
      error instanceof Error ? `导出失败：${error.message}，可点「重试导出」再来一次` : '导出失败，可点「重试导出」再来一次'
  }
}

function openCreate() {
  errorMessage.value = ''
  noticeMessage.value = ''
  showCreate.value = !showCreate.value
  if (showCreate.value && !createForm.value['记录时间']) {
    createForm.value = { ...createForm.value, 记录时间: new Date().toISOString().slice(0, 10) }
  }
}

function submitCreate() {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = submitEntry(meta.key, createForm.value)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  showCreate.value = false
  createForm.value = {}
  reload()
}

function toggleDetail(row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  if (expandedId.value === Number(row.id)) {
    expandedId.value = null
    detail.value = null
    return
  }
  // 展开的那份和列表读的是同一份数据，都从一个存储里取。
  const fresh = getEntry(meta.key, Number(row.id))
  if (!fresh) {
    errorMessage.value = '这条焚烧炉运行记录读取失败，已退回列表里能读到的版本'
    reload()
    return
  }
  expandedId.value = Number(row.id)
  detail.value = fresh
  detailDraft.value = Object.fromEntries(
    editableFields.map((field) => [field, String(fresh[field] ?? '')]),
  )
}

function refreshDetail() {
  if (expandedId.value === null) {
    return
  }
  const fresh = getEntry(meta.key, expandedId.value)
  detail.value = fresh
  if (fresh) {
    detailDraft.value = Object.fromEntries(
      editableFields.map((field) => [field, String(fresh[field] ?? '')]),
    )
  }
}

function saveDetail() {
  if (expandedId.value === null) {
    return
  }
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = updateEntry(meta.key, expandedId.value, detailDraft.value)
  if (!result.ok) {
    // 没存上：存储里还是上一次存好的版本，重新读回来，页面不显示没存上的值。
    errorMessage.value = result.message
    reload()
    refreshDetail()
    return
  }
  noticeMessage.value = result.message
  reload()
  refreshDetail()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  reload()
  refreshDetail()
  if (result.ok) {
    noticeMessage.value = result.message
  } else {
    errorMessage.value = result.message
  }
}

function reload() {
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
