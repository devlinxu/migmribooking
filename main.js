import holiday from './holidays.js'

const app = document.querySelector('#app')
const dialog = document.querySelector('#dialog')
const logout = document.querySelector('#logout')
const toast = document.querySelector('#toast')
const endpoint = 'https://zxbhvzfemuuhlhzducye.supabase.co/functions/v1/appointments'
const dayMs = 86400000
const periods = [
  { label: '18:00–19:00', start: '18:00', end: '19:00' },
  { label: '19:00–20:00', start: '19:00', end: '20:00' }
]
const fields = [
  ['record', '病案号'], ['name', '姓名'], ['sex', '性别'],
  ['birth', '出生日期'], ['phone', '联系电话'], ['diagnosis', '诊断']
]
const state = { unlocked: false, tab: 'book', week: 0, month: 0, history: false }
let activeDialogId
let detailSnapshot
let session = ''
let cachedRecords = []
let refreshSequence = 0
let busy = false
let toastTimer

function esc(value = '') {
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
  return String(value ?? '').replace(/[&<>"']/g, letter => entities[letter])
}

function records() { return cachedRecords.slice() }

async function request(action, payload = {}) {
  const usedSession = session
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-mri-session': usedSession },
    body: JSON.stringify({ action, ...payload }),
    cache: 'no-store',
    signal: AbortSignal.timeout(12000)
  })
  const result = await response.json().catch(() => ({}))
  if (response.status === 401 && action !== 'login' && session === usedSession) lock()
  if (!response.ok) {
    const error = new Error(result.error || '后台暂不可用，请检查部署设置。')
    error.status = response.status
    throw error
  }
  return result
}

async function refresh() {
  const sequence = ++refreshSequence
  const result = await request('list')
  if (sequence !== refreshSequence || !state.unlocked) return
  if (!Array.isArray(result.records)) throw new Error('后台返回的数据无效。')
  cachedRecords = result.records
}

async function update(record, revision) {
  await request('save', { id: record.id, revision, item: record })
}

async function refreshAfterSave() {
  try {
    await refresh()
    return true
  } catch {
    notice('后台已保存，列表暂未刷新。')
    return false
  }
}

function cnToday() { return new Date(Date.now() + 8 * 3600000) }
function key(date) { return date.toISOString().slice(0, 10) }
function at(date, time) { return Date.parse(date + 'T' + time + ':00+08:00') }
function ended(record) { return at(record.date, periods[record.period].end) <= Date.now() }
function time(record) { return periods[record.period].label }
function byTime(a, b) { return a.date.localeCompare(b.date) || a.period - b.period }
function recordFor(id) { return records().find(item => item.id === id) }

function formatBirth(value) {
  if (!value) return ''
  if (!/^\d{8}$/.test(value)) return null
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(4, 6))
  const day = Number(value.slice(6))
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  if (year < 1 || year !== date.getUTCFullYear() || month !== date.getUTCMonth() + 1 || day !== date.getUTCDate()) return null
  return year + '年' + month + '月' + day + '日'
}

function notice(message) {
  if (dialog.open) {
    let messageBox = dialog.querySelector('[data-notice]')
    if (!messageBox) {
      messageBox = document.createElement('p')
      messageBox.dataset.notice = ''
      messageBox.className = 'error'
      messageBox.setAttribute('role', 'alert')
      dialog.append(messageBox)
    }
    messageBox.textContent = message
    return
  }
  toast.textContent = message
  toast.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.hidden = true }, 3200)
}

function action(name, label, attributes = '') {
  return '<button type="button" data-action="' + name + '" ' + attributes + '>' + label + '</button>'
}

function badge(item) {
  return '<span class="badge ' + (item.attending ? 'yes">已确认出席' : '">未确认出席') + '</span>'
}

function fieldInputs(item) {
  return '<div class="fields">' + fields.map(([name, label]) => {
    const value = esc(item[name])
    if (name === 'birth') {
      const preview = formatBirth(item.birth) || '输入 8 位数字，例如 19910704'
      return '<label class="field">' + label + '<input name="birth" inputmode="numeric" maxlength="8" value="' + value + '" placeholder="YYYYMMDD"><small class="help muted" data-birth-help>' + preview + '</small></label>'
    }
    if (name === 'diagnosis') return '<label class="field wide">' + label + '<textarea name="diagnosis" rows="2">' + value + '</textarea></label>'
    const attributes = name === 'name' ? 'required' : name === 'phone' ? 'type="tel"' : ''
    return '<label class="field">' + label + '<input name="' + name + '" ' + attributes + ' value="' + value + '"></label>'
  }).join('') + '</div>'
}

function bookingView() {
  const today = cnToday()
  const first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))
  first.setUTCDate(first.getUTCDate() + (6 - first.getUTCDay() + 7) % 7 + state.week * 7)
  const all = records()
  let cards = ''
  for (let week = 0; week < 4; week += 1) {
    const date = key(new Date(first.getTime() + week * 7 * dayMs))
    const used = all.filter(item => item.date === date)
    const slots = periods.map((period, index) => {
      const selected = state.slot?.date === date && state.slot.period === index
      const taken = used.some(item => item.period === index)
      const past = at(date, period.start) <= Date.now()
      const status = taken ? '已预约' : past ? '已过期' : selected ? '已选择' : '可预约'
      return action('slot', '<span>' + period.label + '</span><small>' + status + '</small>',
        'class="slot ' + (selected ? 'selected' : '') + '" data-date="' + date + '" data-index="' + index + '"' + (taken || past ? ' disabled' : ''))
    }).join('')
    const form = state.slot?.date === date ? `<form class="form-area" data-form="booking">
      <h3>${state.rescheduleId ? '核对患者资料' : '患者资料'}</h3>
      ${fieldInputs(state.draft || {})}
      <div class="actions">${action('cancel-book', '取消')}<button class="primary">保存预约</button></div>
    </form>` : ''
    const festival = holiday(date)
    cards += `<article class="panel"><div class="row day-head"><h3>${date}</h3><span class="muted">周六${festival ? ' · ' + festival : ''}${used.length === 2 ? ' · 已满' : ''}</span></div><div class="slots">${slots}</div>${form}</article>`
  }
  return `<div class="section-head"><h2>${state.rescheduleId ? '更改预约' : '选择周六时段'}</h2><div class="row">${action('week', '‹ 前四周', 'data-step="-4"' + (state.week === 0 ? ' disabled' : ''))}${action('week', '后四周 ›', 'data-step="4"')}</div></div>
    ${state.rescheduleId ? '<p>' + action('cancel-book', '退出改约') + '</p>' : ''}<div class="weeks">${cards}</div>`
}

function listView() {
  const items = records().filter(item => ended(item) === state.history).sort((a, b) => state.history ? byTime(b, a) : byTime(a, b))
  const tabs = '<div class="switch">' + action('history', '已预约', 'data-history="no" class="' + (state.history ? '' : 'active') + '"') +
    action('history', '历史预约', 'data-history="yes" class="' + (state.history ? 'active' : '') + '"') + '</div>'
  if (!items.length) return tabs + '<p class="panel empty">' + (state.history ? '暂无历史预约' : '暂无待扫描预约') + '</p>'
  return tabs + '<div class="record-list">' + items.map(item => action('detail',
    '<span><strong>' + esc(item.name) + '</strong><small class="muted">' + esc(item.date) + ' ' + time(item) + '</small></span>' + badge(item) + '<span aria-hidden="true">›</span>',
    'class="record" data-id="' + esc(item.id) + '"')).join('') + '</div>'
}

function calendarView() {
  const today = cnToday()
  const first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + state.month, 1))
  const all = records().sort(byTime)
  let cells = ['日', '一', '二', '三', '四', '五', '六'].map(day => '<span class="weekday">' + day + '</span>').join('')
  for (let index = 0; index < 42; index += 1) {
    const date = new Date(first.getTime() + (index - first.getUTCDay()) * dayMs)
    const dateKey = key(date)
    const active = date.getUTCMonth() === first.getUTCMonth()
    const saturday = active && date.getUTCDay() === 6
    const name = active && holiday(dateKey)
    const count = all.filter(item => item.date === dateKey).length
    const content = '<span>' + date.getUTCDate() + '</span>' +
      (name ? '<small class="holiday">' + name + '</small>' : '') +
      (saturday ? '<small class="count">' + (count === 2 ? '已满' : count + '/2') + '</small>' : '')
    cells += action('date', content, 'class="cell ' + (saturday ? 'saturday ' : '') + (state.date === dateKey ? 'selected' : '') + '" data-date="' + dateKey + '" aria-label="' + dateKey + '"' + (active ? '' : ' disabled'))
  }
  const patients = all.filter(item => item.date === state.date)
  const day = !state.date ? '<p class="empty">点选日期查看当天的预约。</p>' : `<p class="muted">${esc(state.date)}</p>` +
    (patients.length ? patients.map(item => `<div class="row patient"><span><strong>${esc(item.name)}</strong><br><small class="muted">${time(item)}</small></span>${badge(item)}</div>`).join('') :
      '<p class="empty">当天暂无预约</p>')
  const year = first.getUTCFullYear()
  return `<div class="calendar-wrap"><section class="panel"><div class="row">${action('month', '‹ 上月', 'data-step="-1"')}<h2>${year} 年 ${first.getUTCMonth() + 1} 月</h2>${action('month', '下月 ›', 'data-step="1"')}</div>
    <div class="grid">${cells}</div>${year !== 2026 && year !== 2027 ? '<p class="muted">该年份暂未内置放假安排。</p>' : ''}</section>
    <section class="panel"><h3>当日预约</h3>${day}</section></div>`
}

function render() {
  logout.hidden = !state.unlocked
  if (!state.unlocked) {
    app.innerHTML = `<div class="login"><div class="hero"><h1>磁共振预约</h1></div><form class="panel" data-form="access">
      <h2>访问验证</h2><label class="field">团队口令<input name="password" type="password" required autocomplete="current-password" placeholder="请输入团队口令"></label>
      <p class="error" role="alert" hidden>口令错误，无法进入。</p><button class="primary">验证并进入</button>
    </form></div>`
    return
  }
  const nav = [['book', '预约'], ['list', '已预约'], ['calendar', '日历']].map(([tab, label]) =>
    action('tab', label, 'data-tab="' + tab + '" class="' + (state.tab === tab ? 'active' : '') + '"' + (state.tab === tab ? ' aria-current="page"' : ''))).join('')
  const view = state.tab === 'book' ? bookingView() : state.tab === 'list' ? listView() : calendarView()
  app.innerHTML = `<header class="hero"><h1>偏头痛磁共振预约</h1><p>每周六 18:00–20:00 · 每位患者一小时</p></header>
    <nav class="nav" aria-label="功能导航">${nav}</nav>${view}`
}

function displayDialog(title, body) {
  dialog.innerHTML = '<div class="row section-head"><h2 id="dialog-title">' + title +
    '</h2>' + action('close', '关闭', 'class="quiet"') + '</div>' + body
  if (!dialog.open) dialog.showModal()
}

function detail(id) {
  const item = recordFor(id)
  if (!item) return
  activeDialogId = id
  detailSnapshot = item
  const phone = String(item.phone || '').replace(/[^0-9+]/g, '')
  const rows = fields.filter(([name]) => name !== 'name').map(([name, label]) => {
    const value = name === 'birth' ? formatBirth(item.birth) : item[name]
    return '<div class="detail-field">' + label + '：' + (name === 'phone' && phone ?
      '<a href="tel:' + phone + '">' + esc(value) + '</a>' : esc(value || '—')) + '</div>'
  }).join('')
  const checks = [['contacted', '已联系'], ['attending', '确认按时出席']].map(([name, label]) =>
    '<label><input type="checkbox" data-status="' + name + '"' + (item[name] ? ' checked' : '') + '>' + label + '</label>').join('')
  displayDialog('预约详情', `<h3>姓名：${esc(item.name)}</h3><p class="muted">预约时间：${esc(item.date)} ${time(item)}</p>
    ${rows}<div class="checks">${checks}</div><div class="note">备注：${esc(item.note || '—')}</div>
    <div class="actions">${action('edit', '编辑资料', 'class="primary"')}${action('reschedule', '改约')}${action('delete-confirm', '删除预约', 'class="danger"')}</div>`)
}

function selectSlot(date, period) {
  state.slot = { date, period }
  render()
  app.querySelector('.form-area')?.scrollIntoView({ block: 'nearest' })
}

function resetBooking() {
  delete state.slot
  delete state.draft
  delete state.rescheduleId
  delete state.rescheduleRevision
}

function captureDraft() {
  const form = app.querySelector('[data-form="booking"]')
  if (form) state.draft = Object.fromEntries(new FormData(form))
}

document.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]')
  if (!button || !state.unlocked || busy) return
  const data = button.dataset
  try {
    switch (data.action) {
      case 'tab': captureDraft(); state.tab = data.tab; render(); break
      case 'history': state.history = data.history === 'yes'; render(); break
      case 'week': captureDraft(); state.week += Number(data.step); render(); break
      case 'month': state.month += Number(data.step); delete state.date; render(); break
      case 'date': state.date = data.date; render(); break
      case 'slot':
        captureDraft()
        if (holiday(data.date)) {
          displayDialog('节假日预约', '<p>该日为法定节假日，是否继续预约？</p><div class="actions">' +
            action('close', '取消') + action('slot-confirm', '继续预约', 'class="primary" data-date="' + data.date + '" data-index="' + data.index + '"') + '</div>')
        } else selectSlot(data.date, Number(data.index))
        break
      case 'slot-confirm': dialog.close(); selectSlot(data.date, Number(data.index)); break
      case 'cancel-book': resetBooking(); render(); break
      case 'detail': detail(data.id); break
      case 'close': dialog.close(); break
      case 'edit': {
        const item = recordFor(activeDialogId)
        if (!item) return
        displayDialog('编辑资料', '<form data-form="edit">' + fieldInputs(item) +
          '<label class="field note">备注<textarea name="note" rows="3">' + esc(item.note) + '</textarea></label>' +
          '<div class="actions">' + action('back-detail', '取消') + '<button class="primary">保存修改</button></div></form>')
        break
      }
      case 'back-detail': detail(activeDialogId); break
      case 'reschedule': {
        const item = recordFor(activeDialogId)
        if (!item) return
        resetBooking()
        state.rescheduleId = item.id
        state.draft = item
        state.rescheduleRevision = item.revision
        state.tab = 'book'
        state.week = 0
        dialog.close()
        render()
        break
      }
      case 'delete-confirm':
        displayDialog('删除预约', '<p>确定删除这条预约吗？删除后无法恢复。</p><div class="actions">' +
          action('back-detail', '取消') + action('delete', '删除预约', 'class="danger"') + '</div>')
        break
      case 'delete': {
        busy = true
        await request('delete', { id: activeDialogId, revision: detailSnapshot.revision })
        dialog.close()
        if (await refreshAfterSave()) notice('已删除预约')
        render()
        break
      }
    }
  } catch (error) {
    notice(error.message || '操作失败，请重试。')
  } finally {
    busy = false
  }
})

document.addEventListener('submit', async event => {
  const form = event.target
  if (!form.dataset.form) return
  event.preventDefault()
  if (busy) return
  const values = Object.fromEntries(new FormData(form))
  if (form.dataset.form === 'access') {
    busy = true
    const submit = form.querySelector('button')
    submit.disabled = true
    try {
      const result = await request('login', { password: values.password })
      if (!result.token) throw new Error('后台未返回有效会话。')
      session = result.token
      state.unlocked = true
      await refresh()
      if (state.unlocked) render()
    } catch (error) {
      const label = form.querySelector('.error')
      label.textContent = error.message === 'Failed to fetch'
        ? '无法连接后台，请检查函数部署和网络。' : error.message
      label.hidden = false
      form.querySelector('input').setAttribute('aria-invalid', 'true')
      session = ''
      state.unlocked = false
    } finally {
      busy = false
      submit.disabled = false
    }
    return
  }
  if (!state.unlocked) return
  values.name = values.name.trim()
  if (!values.name) return notice('请输入姓名。')
  if (formatBirth(values.birth) === null) return notice('请输入有效的八位出生日期。')
  busy = true
  const button = form.querySelector('button.primary')
  button.disabled = true
  try {
    if (form.dataset.form === 'edit') {
      await update({ ...detailSnapshot, ...values }, detailSnapshot.revision)
      if (await refreshAfterSave()) {
        detail(activeDialogId)
        render()
        notice('已保存修改')
      }
      return
    }
    if (!state.slot || at(state.slot.date, periods[state.slot.period].start) <= Date.now()) {
      return notice('该时段已过去，请重新选择。')
    }
    const previous = state.rescheduleId && recordFor(state.rescheduleId)
    if (state.rescheduleId && !previous) return notice('原预约已不存在。')
    await update({
      ...previous, ...values, ...state.slot,
      id: previous ? previous.id : crypto.randomUUID(),
      attending: false
    }, previous ? state.rescheduleRevision : null)
    resetBooking()
    state.tab = 'list'
    state.history = false
    if (await refreshAfterSave()) notice('已保存预约')
    render()
  } catch (error) {
    if (error.status === 409 && form.dataset.form === 'booking' && state.unlocked) {
      captureDraft()
      delete state.slot
      try { await refresh() } catch {}
      render()
    }
    notice(error.message || '保存失败，请重试。')
  } finally {
    button.disabled = false
    busy = false
  }
})

document.addEventListener('input', event => {
  const input = event.target
  if (input.name !== 'birth') return
  input.value = input.value.replace(/\D/g, '').slice(0, 8)
  const help = input.parentElement.querySelector('[data-birth-help]')
  const formatted = formatBirth(input.value)
  const invalid = input.value.length === 8 && !formatted
  help.textContent = formatted || (invalid ? '日期无效，请检查年月日。' : '输入 8 位数字，例如 19910704')
  help.classList.toggle('error', invalid)
})

dialog.addEventListener('change', async event => {
  const status = event.target.dataset.status
  if (!state.unlocked || !status || !detailSnapshot) return
  if (busy) {
    event.target.checked = !event.target.checked
    return
  }
  busy = true
  try {
    await update({ ...detailSnapshot, [status]: event.target.checked }, detailSnapshot.revision)
    if (await refreshAfterSave()) {
      detail(activeDialogId)
      render()
    }
  } catch (error) {
    event.target.checked = !event.target.checked
    notice(error.message)
  } finally {
    busy = false
  }
})

function lock() {
  if (dialog.open) dialog.close()
  dialog.replaceChildren()
  detailSnapshot = null
  activeDialogId = null
  session = ''
  cachedRecords = []
  refreshSequence += 1
  resetBooking()
  Object.assign(state, { unlocked: false, tab: 'book', history: false, week: 0, month: 0, date: '' })
  render()
}

logout.addEventListener('click', () => { if (!busy) lock() })

let syncing = false
async function sync() {
  if (!state.unlocked || busy || syncing || document.hidden) return
  syncing = true
  try {
    const previous = JSON.stringify(cachedRecords)
    await refresh()
    const nowMinute = Math.floor(Date.now() / 60000)
    if (state.unlocked && (previous !== JSON.stringify(cachedRecords) || nowMinute !== sync.lastMinute)
      && !(state.tab === 'book' && state.slot)) render()
    sync.lastMinute = nowMinute
  } catch (error) {
    if (state.unlocked) notice(error.message || '同步暂不可用。')
  } finally {
    syncing = false
  }
}

setInterval(sync, 5000)
document.addEventListener('visibilitychange', sync)
render()
