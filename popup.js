// Элементы DOM
const $ = (id) => document.getElementById(id)

const els = {
    version: $('version'),
    hero: $('hero'),
    webrtcToggle: $('webrtcToggle'),
    webrtcSub: $('webrtcSub'),
    incognitoSub: $('incognitoSub'),
    incognitoBtn: $('incognitoBtn'),
    incognitoOk: $('incognitoOk'),
    count: $('count'),
    importBtn: $('importBtn'),
    addBtn: $('addBtn'),
    searchWrap: $('searchWrap'),
    search: $('search'),
    list: $('list'),
    overlay: $('overlay'),
    profileSheet: $('profileSheet'),
    profileSheetTitle: $('profileSheetTitle'),
    profileForm: $('profileForm'),
    quickInput: $('quickInput'),
    quickHint: $('quickHint'),
    nameInput: $('nameInput'),
    typeSeg: $('typeSeg'),
    hostInput: $('hostInput'),
    portInput: $('portInput'),
    authFields: $('authFields'),
    socksNote: $('socksNote'),
    userInput: $('userInput'),
    passInput: $('passInput'),
    showPassBtn: $('showPassBtn'),
    formError: $('formError'),
    importSheet: $('importSheet'),
    importText: $('importText'),
    importTypeSeg: $('importTypeSeg'),
    importSummary: $('importSummary'),
    importErrors: $('importErrors'),
    exportBtn: $('exportBtn'),
    confirmImportBtn: $('confirmImportBtn'),
    toast: $('toast'),
    toastText: $('toastText'),
    toastAction: $('toastAction'),
}

// Адрес прокси: IP или домен, без схемы и порта
const HOST_PATTERN = /^[a-z0-9_.-]+$/i
// Поиск появляется, когда профилей больше этого числа
const SEARCH_THRESHOLD = 6
const TYPE_LABELS = { http: 'HTTP', socks5: 'SOCKS5', socks4: 'SOCKS4' }
const QUICK_HINT = 'Вставьте строку — поля заполнятся сами'

// Состояние
const state = {
    profiles: [],
    geoCache: {},
    lastProfileId: null,
    // Ответ background: state = active | conflict | off
    status: null,
    // Проверка через активный прокси: { ip, country, ping } или { error: true }
    exit: null,
    checking: false,
    checkId: 0,
    // Идёт включение или выключение
    busy: false,
    applyingId: null,
    incognitoAllowed: true,
    shortcut: '',
    query: '',
    editingId: null,
    formType: 'http',
    importType: 'http',
    geoTried: new Set(),
}

const icon = (name, cls = '') => `<svg class="i ${cls}" aria-hidden="true"><use href="#i-${name}" /></svg>`

// Инициализация
document.addEventListener('DOMContentLoaded', init)

async function init() {
    els.version.textContent = chrome.runtime.getManifest().version

    const stored = await chrome.storage.local.get(['profiles', 'geoCache', 'lastProfileId'])
    state.profiles = (stored.profiles || []).map((profile) => ({ ...profile, type: profile.type || 'http' }))
    state.geoCache = stored.geoCache || {}
    state.lastProfileId = stored.lastProfileId || null
    state.incognitoAllowed = await chrome.extension.isAllowedIncognitoAccess()

    const command = (await chrome.commands.getAll()).find((c) => c.name === 'toggle-proxy')
    state.shortcut = (command && command.shortcut) || ''

    bindEvents()
    setStatus(await chrome.runtime.sendMessage({ action: 'getStatus' }))
}

// Привязка событий
function bindEvents() {
    els.hero.addEventListener('click', (e) => {
        const action = e.target.closest('[data-action]')
        if (!action) return
        if (action.dataset.action === 'power') onPower()
        if (action.dataset.action === 'refresh') checkConnection()
        if (action.dataset.action === 'copyIp') copyText(state.exit.ip, 'IP скопирован')
    })

    els.webrtcToggle.addEventListener('change', onWebRTCToggle)
    els.incognitoBtn.addEventListener('click', () => {
        chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` })
    })

    els.addBtn.addEventListener('click', () => openProfileSheet())
    els.importBtn.addEventListener('click', openImportSheet)
    els.search.addEventListener('input', () => {
        state.query = els.search.value
        renderProfiles()
    })

    els.list.addEventListener('click', onListClick)
    els.list.addEventListener('keydown', (e) => {
        const row = e.target.closest('.profile')
        if (row && e.target === row && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault()
            connect(row.dataset.id)
        }
    })

    // Флаг не загрузился — показываем глобус
    document.addEventListener(
        'error',
        (e) => {
            if (e.target.classList && e.target.classList.contains('flag')) {
                e.target.outerHTML = icon('globe')
            }
        },
        true
    )

    // Нижние панели
    els.overlay.addEventListener('click', closeSheets)
    document.querySelectorAll('[data-close]').forEach((btn) => btn.addEventListener('click', closeSheets))
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && document.querySelector('.sheet.is-open')) {
            e.preventDefault()
            closeSheets()
        } else if (e.key === '/' && !isTyping(e.target) && !els.searchWrap.classList.contains('hidden')) {
            e.preventDefault()
            els.search.focus()
        }
    })

    // Форма профиля
    els.profileForm.addEventListener('submit', onProfileSubmit)
    els.quickInput.addEventListener('input', onQuickInput)
    els.hostInput.addEventListener('paste', (e) => {
        // Вставили целую строку прокси в поле адреса — разбираем её
        const text = e.clipboardData.getData('text').trim()
        if (text.includes(':')) {
            e.preventDefault()
            els.quickInput.value = text
            onQuickInput()
        }
    })
    bindSegmented(els.typeSeg, (value) => setFormType(value))
    els.showPassBtn.addEventListener('click', () => {
        els.passInput.type = els.passInput.type === 'password' ? 'text' : 'password'
    })
    els.profileForm.addEventListener('input', (e) => {
        if (e.target.classList.contains('is-invalid')) {
            e.target.classList.remove('is-invalid')
            els.formError.textContent = ''
        }
    })

    // Импорт
    els.importText.addEventListener('input', updateImportPreview)
    els.importText.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) doImport()
    })
    bindSegmented(els.importTypeSeg, (value) => {
        state.importType = value
        updateImportPreview()
    })
    els.confirmImportBtn.addEventListener('click', doImport)
    els.exportBtn.addEventListener('click', exportProfiles)
}

function isTyping(target) {
    return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
}

// Статус от background
function setStatus(status) {
    const previous = state.status
    state.status = status

    if (status.state === 'active') {
        state.lastProfileId = status.profile.id
        const sameConnection =
            previous &&
            previous.state === 'active' &&
            previous.profile.id === status.profile.id &&
            previous.profile.host === status.profile.host &&
            previous.profile.port === status.profile.port
        // Пока идёт проверка, показываем последний известный IP приглушённо
        if (!sameConnection) state.exit = status.exit || null
    } else {
        state.exit = null
        state.checking = false
        state.checkId++
    }

    renderHero()
    renderGuard()
    renderProfiles()

    if (status.state === 'active') {
        checkConnection()
        loadMissingGeo()
    }
}

function lastProfile() {
    return state.profiles.find((p) => p.id === state.lastProfileId) || state.profiles[0] || null
}

// Карточка подключения
function renderHero() {
    const { status, exit, checking } = state
    if (!status) return

    let cls = 'hero'
    let stateText
    let title
    let line
    let meta
    let powerTitle

    if (status.state === 'active') {
        const failed = exit && exit.error
        cls += failed ? ' is-unreachable' : ' is-active'
        stateText = state.busy ? 'Отключение…' : failed ? 'Прокси не отвечает' : 'Подключено'
        title = `<span class="ellipsis">${escapeHtml(status.profile.name)}</span>`

        const refresh = `<button class="icon-btn${checking ? ' is-spinning' : ''}" data-action="refresh" title="Проверить ещё раз">${icon('refresh')}</button>`
        if (failed) {
            // Трафик не идёт мимо прокси, поэтому реальный IP не раскрыт
            line = 'Сайты не открываются, IP скрыт'
            meta = `Проверьте адрес, порт и пароль ${refresh}`
        } else if (exit) {
            line = `<button class="hero-ip${checking ? ' is-stale' : ''}" data-action="copyIp" title="Скопировать IP">${escapeHtml(exit.ip)}${icon('copy')}</button>`
            const parts = []
            if (exit.country) parts.push(`${flagImg(exit.country)}${escapeHtml(getCountryName(exit.country))}`)
            if (exit.ping !== null && exit.ping !== undefined) parts.push(`<span class="mono">${exit.ping} ms</span>`)
            meta = `<span class="hero-meta-text${checking ? ' is-stale' : ''}">${parts.join('<span class="sep">·</span>')}</span>${refresh}`
        } else {
            line = '<span class="skeleton"></span>'
            meta = 'Проверяем подключение…'
        }
        powerTitle = 'Отключить'
    } else if (status.state === 'conflict') {
        cls += ' is-error'
        stateText = 'Не работает'
        title = 'Прокси перехвачен'
        line = `<span class="ellipsis">${escapeHtml(capitalize(status.error))}</span>`
        meta = `<span class="ellipsis">Профиль «${escapeHtml(status.profile.name)}»</span>`
        powerTitle = 'Выключить профиль'
    } else {
        const last = lastProfile()
        stateText = state.busy ? 'Подключение…' : 'Не подключено'
        title = 'Прямое подключение'
        line = status.error
            ? `<span class="is-bad ellipsis">${escapeHtml(capitalize(status.error))}</span>`
            : 'Сайты видят ваш настоящий IP'
        if (last) {
            const kbd = state.shortcut ? `<span class="kbd">${escapeHtml(state.shortcut)}</span>` : ''
            meta = `<span class="ellipsis">Последний: ${escapeHtml(last.name)}</span>${kbd}`
            powerTitle = `Подключить «${last.name}»`
        } else {
            meta = 'Добавьте прокси, чтобы начать'
            powerTitle = 'Добавить прокси'
        }
    }

    els.hero.className = cls
    els.hero.innerHTML = `
        <div class="hero-body">
            <div class="hero-state"><span class="dot"></span>${stateText}</div>
            <div class="hero-title">${title}</div>
            <div class="hero-line">${line}</div>
            <div class="hero-meta">${meta}</div>
        </div>
        <button class="power" data-action="power" title="${escapeHtml(powerTitle)}"${state.busy ? ' disabled' : ''}>
            ${state.busy ? '<span class="spinner"></span>' : icon('power')}
        </button>`
}

// Блок защиты
function renderGuard() {
    const { webrtcBlocked, webrtcProtected } = state.status
    els.webrtcToggle.checked = !!webrtcBlocked

    if (!webrtcBlocked) {
        setText(els.webrtcSub, 'Выключено: сайты могут узнать реальный IP', 'is-warn')
    } else if (!webrtcProtected) {
        setText(els.webrtcSub, 'Не действует: управляет другое расширение', 'is-bad')
    } else {
        setText(els.webrtcSub, 'Реальный IP не утекает через WebRTC')
    }

    if (state.incognitoAllowed) {
        setText(els.incognitoSub, 'Прокси работает и в инкогнито')
    } else {
        setText(els.incognitoSub, 'Там сайты видят ваш реальный IP', 'is-warn')
    }
    els.incognitoBtn.classList.toggle('hidden', state.incognitoAllowed)
    els.incognitoOk.classList.toggle('hidden', !state.incognitoAllowed)
}

function setText(el, text, cls = '') {
    el.textContent = text
    el.title = text
    el.classList.remove('is-ok', 'is-warn', 'is-bad')
    if (cls) el.classList.add(cls)
}

// Список профилей
function renderProfiles() {
    const total = state.profiles.length
    els.count.textContent = total || ''
    // В пустом списке те же кнопки есть в подсказке — не дублируем их в шапке
    els.importBtn.classList.toggle('hidden', total === 0)
    els.addBtn.classList.toggle('hidden', total === 0)

    const searchable = total > SEARCH_THRESHOLD
    els.searchWrap.classList.toggle('hidden', !searchable)
    if (!searchable && state.query) {
        state.query = ''
        els.search.value = ''
    }

    if (total === 0) {
        els.list.innerHTML = `
            <div class="empty">
                <div class="empty-icon">${icon('shield')}</div>
                <div class="empty-title">Добавьте первый прокси</div>
                <div>Вставьте строку вида <code>user:pass@ip:port</code><br />или импортируйте список</div>
                <div class="empty-actions">
                    <button class="btn btn-primary btn-sm" data-action="add">${icon('plus')}Добавить</button>
                    <button class="btn btn-secondary btn-sm" data-action="import">Импорт списка</button>
                </div>
            </div>`
        return
    }

    const query = state.query.trim().toLowerCase()
    const visible = query
        ? state.profiles.filter((p) => p.name.toLowerCase().includes(query) || `${p.host}:${p.port}`.toLowerCase().includes(query))
        : state.profiles

    if (visible.length === 0) {
        els.list.innerHTML = '<div class="list-note">Ничего не найдено</div>'
        return
    }

    const activeId = state.status && state.status.state === 'active' ? state.status.profile.id : null
    els.list.innerHTML = visible.map((profile) => profileRow(profile, profile.id === activeId)).join('')
}

function profileRow(profile, isActive) {
    const geo = state.geoCache[profile.host]
    const flag = geo ? flagImg(geo.country) : icon('globe')
    const badge = profile.type !== 'http' ? `<span class="badge">${TYPE_LABELS[profile.type]}</span>` : ''
    const actions =
        state.applyingId === profile.id
            ? '<span class="spinner"></span>'
            : `<span class="profile-actions">
                <button class="icon-btn" data-action="copy" title="Скопировать строку прокси">${icon('copy')}</button>
                <button class="icon-btn" data-action="edit" title="Редактировать">${icon('pencil')}</button>
                <button class="icon-btn danger" data-action="delete" title="Удалить">${icon('trash')}</button>
            </span>`

    return `
        <div class="profile${isActive ? ' is-active' : ''}" role="button" tabindex="0" data-id="${escapeHtml(profile.id)}" title="${
        isActive ? 'Подключено' : 'Подключить'
    }">
            <span class="flag-slot">${flag}</span>
            <span class="profile-main">
                <span class="profile-name">${escapeHtml(profile.name)}</span>
                <span class="profile-addr"><span class="ellipsis">${escapeHtml(profile.host)}:${escapeHtml(profile.port)}</span>${badge}</span>
            </span>
            ${actions}
        </div>`
}

function onListClick(e) {
    const action = e.target.closest('[data-action]')
    const row = e.target.closest('.profile')

    if (!row) {
        if (action && action.dataset.action === 'add') openProfileSheet()
        if (action && action.dataset.action === 'import') openImportSheet()
        return
    }

    const id = row.dataset.id
    if (!action) {
        if (!row.classList.contains('is-active')) connect(id)
    } else if (action.dataset.action === 'copy') {
        const profile = state.profiles.find((p) => p.id === id)
        copyText(proxyString(profile), 'Строка прокси скопирована')
    } else if (action.dataset.action === 'edit') {
        openProfileSheet(id)
    } else if (action.dataset.action === 'delete') {
        deleteProfile(id)
    }
}

function flagImg(country) {
    const name = getCountryName(country)
    return `<img class="flag" src="https://flagcdn.com/w40/${country.toLowerCase()}.png" alt="${country}" title="${escapeHtml(name)}" />`
}

// Подключение и отключение
async function onPower() {
    if (state.busy) return
    if (state.status.state === 'off') {
        const last = lastProfile()
        if (last) {
            await connect(last.id)
        } else {
            openProfileSheet()
        }
    } else {
        await disconnect()
    }
}

async function connect(profileId) {
    const profile = state.profiles.find((p) => p.id === profileId)
    if (!profile || state.busy) return

    state.busy = true
    state.applyingId = profileId
    renderHero()
    renderProfiles()

    const response = await chrome.runtime.sendMessage({ action: 'applyProxy', profile })

    state.busy = false
    state.applyingId = null
    if (!response.success) {
        showToast(`Не удалось подключиться: ${response.error}`, { error: true })
    }
    setStatus(response.status)
}

async function disconnect() {
    if (state.busy) return
    state.busy = true
    renderHero()

    const response = await chrome.runtime.sendMessage({ action: 'disableProxy' })

    state.busy = false
    if (!response.success) {
        showToast(`Не удалось отключить: ${response.error}`, { error: true })
    }
    setStatus(response.status)
}

async function onWebRTCToggle() {
    const enabled = els.webrtcToggle.checked
    try {
        const response = await chrome.runtime.sendMessage({ action: 'toggleWebRTC', enabled })
        if (!response.success) {
            showToast(`Защита WebRTC: ${response.error}`, { error: true })
        }
        setStatus(response.status)
    } catch (error) {
        console.error('Ошибка управления WebRTC:', error)
        els.webrtcToggle.checked = !enabled
        showToast('Не удалось переключить защиту WebRTC', { error: true })
    }
}

// Проверка через активный прокси
async function fetchWithTimeout(url, timeout) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
        const response = await fetch(url, { cache: 'no-store', signal: controller.signal })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response
    } finally {
        clearTimeout(timer)
    }
}

// Первый запрос открывает соединение через прокси, второй идёт по готовому — это и есть пинг
async function measurePing() {
    let best = null
    for (let i = 0; i < 2; i++) {
        const start = performance.now()
        await fetchWithTimeout('https://www.gstatic.com/generate_204', 5000)
        const ping = Math.round(performance.now() - start)
        best = best === null ? ping : Math.min(best, ping)
    }
    return best
}

// Popup ходит в сеть через тот же прокси, что и вкладки: ipinfo.io видит внешний IP прокси,
// а пинг — задержка всего пути. Неактивные прокси не проверяем: запрос шёл бы с реального IP
async function checkConnection() {
    if (!state.status || state.status.state !== 'active') return

    const checkId = ++state.checkId
    const profileId = state.status.profile.id
    state.checking = true
    renderHero()

    let exit
    try {
        const info = await (await fetchWithTimeout('https://ipinfo.io/json', 6000)).json()
        exit = {
            ip: info.ip,
            country: /^[A-Z]{2}$/.test(info.country) ? info.country : null,
            ping: await measurePing().catch(() => null),
        }
    } catch (error) {
        console.log('Нет ответа через прокси:', error)
        exit = { error: true }
    }

    if (checkId !== state.checkId) return
    state.checking = false
    state.exit = exit
    renderHero()

    if (!exit.error) {
        chrome.runtime.sendMessage({ action: 'exitInfo', profileId, exit }).catch(() => {})
    }
}

// Геолокация серверов прокси для флагов. В ipinfo.io ходим только через активный прокси:
// без него ipinfo получил бы с реального IP весь список прокси
async function loadMissingGeo() {
    const queue = [...new Set(state.profiles.map((p) => p.host))].filter((host) => !state.geoCache[host] && !state.geoTried.has(host))
    if (queue.length === 0) return
    queue.forEach((host) => state.geoTried.add(host))

    let changed = false
    const worker = async () => {
        while (queue.length > 0 && state.status && state.status.state === 'active') {
            const host = queue.shift()
            try {
                const data = await (await fetchWithTimeout(`https://ipinfo.io/${encodeURIComponent(host)}/json`, 6000)).json()
                if (/^[A-Z]{2}$/.test(data.country)) {
                    state.geoCache[host] = { country: data.country }
                    changed = true
                }
            } catch (error) {
                console.log('Нет геолокации для', host, error.message)
            }
        }
    }
    await Promise.all([worker(), worker(), worker()])

    if (changed) {
        await chrome.storage.local.set({ geoCache: state.geoCache })
        renderProfiles()
    }
}

// Профили
async function saveProfiles() {
    await chrome.storage.local.set({ profiles: state.profiles })
}

function nextProfileName(offset = 0) {
    const numbers = state.profiles.map((p) => /^Профиль (\d+)$/.exec(p.name)).filter(Boolean).map((m) => Number(m[1]))
    return `Профиль ${Math.max(state.profiles.length, ...numbers) + 1 + offset}`
}

function newId() {
    return crypto.randomUUID()
}

// Строка в формате, который понимает импорт
function proxyString(profile) {
    const scheme = profile.type !== 'http' ? `${profile.type}://` : ''
    const auth = profile.username && profile.password ? `${profile.username}:${profile.password}@` : ''
    return `${scheme}${auth}${profile.host}:${profile.port}`
}

async function copyText(text, message) {
    try {
        await navigator.clipboard.writeText(text)
        showToast(message)
    } catch (error) {
        showToast('Не удалось скопировать', { error: true })
    }
}

function deleteProfile(id) {
    const index = state.profiles.findIndex((p) => p.id === id)
    if (index === -1) return

    const [profile] = state.profiles.splice(index, 1)
    const wasActive = state.status && state.status.state !== 'off' && state.status.profile.id === id
    saveProfiles()
    renderProfiles()
    renderHero()
    if (wasActive) disconnect()

    showToast(wasActive ? 'Профиль удалён, прокси отключён' : 'Профиль удалён', {
        action: 'Вернуть',
        onAction: () => {
            state.profiles.splice(Math.min(index, state.profiles.length), 0, profile)
            saveProfiles()
            renderProfiles()
            renderHero()
        },
    })
}

// Нижние панели
function openSheet(sheet) {
    closeSheets()
    els.overlay.classList.add('is-open')
    sheet.classList.add('is-open')
}

function closeSheets() {
    els.overlay.classList.remove('is-open')
    document.querySelectorAll('.sheet.is-open').forEach((sheet) => sheet.classList.remove('is-open'))
    state.editingId = null
}

function bindSegmented(container, onChange) {
    container.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-value]')
        if (btn) onChange(btn.dataset.value)
    })
}

function selectSegment(container, value) {
    container.querySelectorAll('button').forEach((btn) => {
        const selected = btn.dataset.value === value
        btn.classList.toggle('is-selected', selected)
        btn.setAttribute('aria-checked', selected)
    })
}

// Форма профиля
function openProfileSheet(id = null) {
    const profile = id ? state.profiles.find((p) => p.id === id) : null
    openSheet(els.profileSheet)
    state.editingId = profile ? profile.id : null

    els.profileSheetTitle.textContent = profile ? 'Редактирование' : 'Новый прокси'
    els.quickInput.value = ''
    setText(els.quickHint, QUICK_HINT)
    els.nameInput.value = profile ? profile.name : ''
    els.nameInput.placeholder = profile ? '' : nextProfileName()
    setFormType(profile ? profile.type : 'http')
    els.hostInput.value = profile ? profile.host : ''
    els.portInput.value = profile ? profile.port : ''
    els.userInput.value = profile ? profile.username || '' : ''
    els.passInput.value = profile ? profile.password || '' : ''
    els.passInput.type = 'password'
    clearFormError()

    setTimeout(() => (profile ? els.nameInput : els.quickInput).focus(), 50)
}

function setFormType(type) {
    state.formType = type
    selectSegment(els.typeSeg, type)

    // Chrome не умеет логин и пароль для SOCKS — вместо полей пояснение той же высоты
    const isSocks = type !== 'http'
    els.authFields.classList.toggle('hidden', isSocks)
    els.socksNote.classList.toggle('hidden', !isSocks)
    if (type === 'socks4') {
        els.socksNote.textContent = 'SOCKS4 отправляет DNS-запросы мимо прокси: провайдер видит, какие сайты вы открываете. Если можно, берите SOCKS5.'
        els.socksNote.className = 'note is-warn'
    } else if (isSocks) {
        els.socksNote.textContent = 'Логин и пароль для SOCKS Chrome не поддерживает — нужен прокси с доступом по IP.'
        els.socksNote.className = 'note'
    }
}

function onQuickInput() {
    const value = els.quickInput.value.trim()
    if (!value) {
        setText(els.quickHint, QUICK_HINT)
        return
    }

    const parsed = parseProxyString(value, state.formType)
    if (!parsed) {
        setText(els.quickHint, 'Формат не распознан', 'is-bad')
        return
    }

    setFormType(parsed.type)
    els.hostInput.value = parsed.host
    els.portInput.value = parsed.port
    clearFormError()

    if (parsed.type !== 'http' && parsed.username) {
        els.userInput.value = ''
        els.passInput.value = ''
        setText(els.quickHint, 'Логин и пароль для SOCKS Chrome не поддерживает', 'is-bad')
        return
    }

    els.userInput.value = parsed.username
    els.passInput.value = parsed.password
    setText(els.quickHint, `Распознано: ${TYPE_LABELS[parsed.type]}${parsed.username ? ' с логином и паролем' : ''}`, 'is-ok')
}

function formError(input, message) {
    input.classList.add('is-invalid')
    els.formError.textContent = message
    input.focus()
}

function clearFormError() {
    els.formError.textContent = ''
    els.profileForm.querySelectorAll('.is-invalid').forEach((input) => input.classList.remove('is-invalid'))
}

async function onProfileSubmit(e) {
    e.preventDefault()
    clearFormError()

    const host = els.hostInput.value.trim()
    const port = Number(els.portInput.value.trim())
    const isHttp = state.formType === 'http'
    const username = isHttp ? els.userInput.value.trim() : ''
    // Пароль не обрезаем: пробелы по краям могут быть его частью
    const password = isHttp ? els.passInput.value : ''

    if (!host) return formError(els.hostInput, 'Укажите адрес прокси')
    if (!HOST_PATTERN.test(host)) return formError(els.hostInput, 'Адрес — это IP или домен, без схемы и порта')
    if (!Number.isInteger(port) || port < 1 || port > 65535) return formError(els.portInput, 'Порт — число от 1 до 65535')
    if (!!username !== !!password) return formError(username ? els.passInput : els.userInput, 'Укажите и логин, и пароль')

    const editingId = state.editingId
    const name = els.nameInput.value.trim() || nextProfileName()
    const duplicate = state.profiles.find((p) => p.name.toLowerCase() === name.toLowerCase() && p.id !== editingId)
    if (duplicate) return formError(els.nameInput, 'Профиль с таким названием уже есть')

    const profile = { id: editingId || newId(), name, type: state.formType, host, port: String(port), username, password }
    if (editingId) {
        state.profiles[state.profiles.findIndex((p) => p.id === editingId)] = profile
    } else {
        state.profiles.push(profile)
    }

    await saveProfiles()
    closeSheets()

    // Изменения активного профиля применяем сразу, иначе трафик идёт на старый адрес со старым паролем
    const isActive = state.status && state.status.state !== 'off' && state.status.profile.id === profile.id
    if (isActive) {
        await connect(profile.id)
        showToast('Сохранено и применено')
    } else {
        renderProfiles()
        renderHero()
        showToast(editingId ? 'Сохранено' : 'Прокси добавлен', editingId ? {} : { action: 'Подключить', onAction: () => connect(profile.id) })
    }
}

// Парсинг строки прокси: [scheme://]host:port:user:pass, [scheme://]user:pass@host:port, [scheme://]host:port
function parseProxyString(line, defaultType = 'http') {
    line = line.trim()
    if (!line) return null

    let type = defaultType
    const scheme = line.match(/^(http|socks4|socks5|socks):\/\//i)
    if (scheme) {
        type = scheme[1].toLowerCase() === 'socks' ? 'socks5' : scheme[1].toLowerCase()
        line = line.slice(scheme[0].length)
    } else if (/^[a-z0-9]+:\/\//i.test(line)) {
        return null
    }

    // host:port:user:pass проверяем первым: логин может быть e-mail с @
    let match = line.match(/^([a-z0-9_.-]+):(\d{1,5}):([^:]+):(.+)$/i)
    if (match) {
        return { type, host: match[1], port: parseInt(match[2]), username: match[3], password: match[4] }
    }

    // user:pass@host:port — в пароле могут быть @ и :, поэтому делим по последней @
    const at = line.lastIndexOf('@')
    if (at !== -1) {
        const credentials = line.slice(0, at)
        const colon = credentials.indexOf(':')
        match = line.slice(at + 1).match(/^([a-z0-9_.-]+):(\d{1,5})$/i)
        if (match && colon > 0) {
            return {
                type,
                host: match[1],
                port: parseInt(match[2]),
                username: credentials.slice(0, colon),
                password: credentials.slice(colon + 1),
            }
        }
        return null
    }

    match = line.match(/^([a-z0-9_.-]+):(\d{1,5})$/i)
    if (match) {
        return { type, host: match[1], port: parseInt(match[2]), username: '', password: '' }
    }

    return null
}

// Импорт
function openImportSheet() {
    openSheet(els.importSheet)
    els.importText.value = ''
    selectSegment(els.importTypeSeg, state.importType)
    els.exportBtn.classList.toggle('hidden', state.profiles.length === 0)
    updateImportPreview()
    setTimeout(() => els.importText.focus(), 50)
}

function analyzeImport(text, defaultType) {
    const items = []
    const errors = []
    const seen = new Set(state.profiles.map((p) => `${p.host}:${p.port}`))
    let duplicates = 0

    text.split('\n').forEach((raw, i) => {
        const line = raw.trim()
        if (!line) return

        const parsed = parseProxyString(line, defaultType)
        if (!parsed) return errors.push(`Строка ${i + 1}: формат не распознан`)
        if (parsed.port < 1 || parsed.port > 65535) return errors.push(`Строка ${i + 1}: неверный порт`)
        if (parsed.type !== 'http' && parsed.username) return errors.push(`Строка ${i + 1}: логин для SOCKS Chrome не поддерживает`)

        const key = `${parsed.host}:${parsed.port}`
        if (seen.has(key)) {
            duplicates++
            return
        }
        seen.add(key)
        items.push(parsed)
    })

    return { items, duplicates, errors }
}

function updateImportPreview() {
    const text = els.importText.value
    const { items, duplicates, errors } = analyzeImport(text, state.importType)

    if (!text.trim()) {
        els.importSummary.innerHTML = 'Форматы: <code>user:pass@ip:port</code>, <code>ip:port:user:pass</code>, <code>ip:port</code>. Схема в начале строки задаёт тип.'
    } else {
        const parts = [`Новых <b class="mono">${items.length}</b>`]
        if (duplicates) parts.push(`уже есть <b class="mono">${duplicates}</b>`)
        if (errors.length) parts.push(`<span class="is-bad">ошибок <b class="mono">${errors.length}</b></span>`)
        els.importSummary.innerHTML = parts.join(' · ')
    }

    const shown = errors.slice(0, errors.length > 3 ? 2 : 3)
    els.importErrors.innerHTML =
        shown.map((error) => `<div>${escapeHtml(error)}</div>`).join('') + (errors.length > shown.length ? `<div>…и ещё ${errors.length - shown.length}</div>` : '')

    els.confirmImportBtn.disabled = items.length === 0
    els.confirmImportBtn.textContent = items.length ? `Импортировать ${items.length}` : 'Импортировать'
}

async function doImport() {
    const { items } = analyzeImport(els.importText.value, state.importType)
    if (items.length === 0) return

    const profiles = items.map((item, i) => ({
        id: newId(),
        name: nextProfileName(i),
        type: item.type,
        host: item.host,
        port: String(item.port),
        username: item.username,
        password: item.password,
    }))
    state.profiles.push(...profiles)

    await saveProfiles()
    closeSheets()
    renderProfiles()
    renderHero()
    showToast(`Импортировано: ${profiles.length}`)
    if (state.status.state === 'active') loadMissingGeo()
}

function exportProfiles() {
    copyText(state.profiles.map(proxyString).join('\n'), `Скопировано профилей: ${state.profiles.length}`)
}

// Уведомление
let toastTimer = null

function showToast(message, { error = false, action = '', onAction = null } = {}) {
    clearTimeout(toastTimer)
    els.toastText.textContent = message
    els.toast.classList.toggle('is-error', error)
    els.toastAction.classList.toggle('hidden', !action)
    els.toastAction.textContent = action
    els.toastAction.onclick = action
        ? () => {
              hideToast()
              onAction()
          }
        : null
    els.toast.classList.add('is-shown')
    toastTimer = setTimeout(hideToast, action ? 5000 : error ? 4000 : 2200)
}

function hideToast() {
    els.toast.classList.remove('is-shown')
}

// Экранирование HTML (в том числе кавычек — значения попадают и в атрибуты)
function escapeHtml(text) {
    const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
    return String(text).replace(/[&<>"']/g, (char) => entities[char])
}

function capitalize(text) {
    return text ? text[0].toUpperCase() + text.slice(1) : ''
}

// Обработка сообщений от background
chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'proxyError') {
        showToast(`Ошибка прокси: ${message.error}`, { error: true })
    }
})

// База названий стран
function getCountryName(countryCode) {
    const countries = {
        AD: 'Андорра',
        AE: 'ОАЭ',
        AF: 'Афганистан',
        AG: 'Антигуа и Барбуда',
        AI: 'Ангилья',
        AL: 'Албания',
        AM: 'Армения',
        AO: 'Ангола',
        AQ: 'Антарктида',
        AR: 'Аргентина',
        AS: 'Американское Самоа',
        AT: 'Австрия',
        AU: 'Австралия',
        AW: 'Аруба',
        AX: 'Аландские острова',
        AZ: 'Азербайджан',
        BA: 'Босния и Герцеговина',
        BB: 'Барбадос',
        BD: 'Бангладеш',
        BE: 'Бельгия',
        BF: 'Буркина-Фасо',
        BG: 'Болгария',
        BH: 'Бахрейн',
        BI: 'Бурунди',
        BJ: 'Бенин',
        BL: 'Сен-Бартелеми',
        BM: 'Бермуды',
        BN: 'Бруней',
        BO: 'Боливия',
        BQ: 'Карибские Нидерланды',
        BR: 'Бразилия',
        BS: 'Багамы',
        BT: 'Бутан',
        BV: 'Остров Буве',
        BW: 'Ботсвана',
        BY: 'Беларусь',
        BZ: 'Белиз',
        CA: 'Канада',
        CC: 'Кокосовые острова',
        CD: 'ДР Конго',
        CF: 'ЦАР',
        CG: 'Республика Конго',
        CH: 'Швейцария',
        CI: "Кот-д'Ивуар",
        CK: 'Острова Кука',
        CL: 'Чили',
        CM: 'Камерун',
        CN: 'Китай',
        CO: 'Колумбия',
        CR: 'Коста-Рика',
        CU: 'Куба',
        CV: 'Кабо-Верде',
        CW: 'Кюрасао',
        CX: 'Остров Рождества',
        CY: 'Кипр',
        CZ: 'Чехия',
        DE: 'Германия',
        DJ: 'Джибути',
        DK: 'Дания',
        DM: 'Доминика',
        DO: 'Доминиканская Республика',
        DZ: 'Алжир',
        EC: 'Эквадор',
        EE: 'Эстония',
        EG: 'Египет',
        EH: 'Западная Сахара',
        ER: 'Эритрея',
        ES: 'Испания',
        ET: 'Эфиопия',
        FI: 'Финляндия',
        FJ: 'Фиджи',
        FK: 'Фолклендские острова',
        FM: 'Микронезия',
        FO: 'Фарерские острова',
        FR: 'Франция',
        GA: 'Габон',
        GB: 'Великобритания',
        GD: 'Гренада',
        GE: 'Грузия',
        GF: 'Французская Гвиана',
        GG: 'Гернси',
        GH: 'Гана',
        GI: 'Гибралтар',
        GL: 'Гренландия',
        GM: 'Гамбия',
        GN: 'Гвинея',
        GP: 'Гваделупа',
        GQ: 'Экваториальная Гвинея',
        GR: 'Греция',
        GS: 'Южная Георгия',
        GT: 'Гватемала',
        GU: 'Гуам',
        GW: 'Гвинея-Бисау',
        GY: 'Гайана',
        HK: 'Гонконг',
        HM: 'Остров Херд',
        HN: 'Гондурас',
        HR: 'Хорватия',
        HT: 'Гаити',
        HU: 'Венгрия',
        ID: 'Индонезия',
        IE: 'Ирландия',
        IL: 'Израиль',
        IM: 'Остров Мэн',
        IN: 'Индия',
        IO: 'Британская территория',
        IQ: 'Ирак',
        IR: 'Иран',
        IS: 'Исландия',
        IT: 'Италия',
        JE: 'Джерси',
        JM: 'Ямайка',
        JO: 'Иордания',
        JP: 'Япония',
        KE: 'Кения',
        KG: 'Киргизия',
        KH: 'Камбоджа',
        KI: 'Кирибати',
        KM: 'Коморы',
        KN: 'Сент-Китс и Невис',
        KP: 'КНДР',
        KR: 'Южная Корея',
        KW: 'Кувейт',
        KY: 'Каймановы острова',
        KZ: 'Казахстан',
        LA: 'Лаос',
        LB: 'Ливан',
        LC: 'Сент-Люсия',
        LI: 'Лихтенштейн',
        LK: 'Шри-Ланка',
        LR: 'Либерия',
        LS: 'Лесото',
        LT: 'Литва',
        LU: 'Люксембург',
        LV: 'Латвия',
        LY: 'Ливия',
        MA: 'Марокко',
        MC: 'Монако',
        MD: 'Молдова',
        ME: 'Черногория',
        MF: 'Сен-Мартен',
        MG: 'Мадагаскар',
        MH: 'Маршалловы острова',
        MK: 'Северная Македония',
        ML: 'Мали',
        MM: 'Мьянма',
        MN: 'Монголия',
        MO: 'Макао',
        MP: 'Северные Марианские острова',
        MQ: 'Мартиника',
        MR: 'Мавритания',
        MS: 'Монтсеррат',
        MT: 'Мальта',
        MU: 'Маврикий',
        MV: 'Мальдивы',
        MW: 'Малави',
        MX: 'Мексика',
        MY: 'Малайзия',
        MZ: 'Мозамбик',
        NA: 'Намибия',
        NC: 'Новая Каледония',
        NE: 'Нигер',
        NF: 'Остров Норфолк',
        NG: 'Нигерия',
        NI: 'Никарагуа',
        NL: 'Нидерланды',
        NO: 'Норвегия',
        NP: 'Непал',
        NR: 'Науру',
        NU: 'Ниуэ',
        NZ: 'Новая Зеландия',
        OM: 'Оман',
        PA: 'Панама',
        PE: 'Перу',
        PF: 'Французская Полинезия',
        PG: 'Папуа-Новая Гвинея',
        PH: 'Филиппины',
        PK: 'Пакистан',
        PL: 'Польша',
        PM: 'Сен-Пьер и Микелон',
        PN: 'Питкэрн',
        PR: 'Пуэрто-Рико',
        PS: 'Палестина',
        PT: 'Португалия',
        PW: 'Палау',
        PY: 'Парагвай',
        QA: 'Катар',
        RE: 'Реюньон',
        RO: 'Румыния',
        RS: 'Сербия',
        RU: 'Россия',
        RW: 'Руанда',
        SA: 'Саудовская Аравия',
        SB: 'Соломоновы острова',
        SC: 'Сейшелы',
        SD: 'Судан',
        SE: 'Швеция',
        SG: 'Сингапур',
        SH: 'Остров Святой Елены',
        SI: 'Словения',
        SJ: 'Шпицберген и Ян-Майен',
        SK: 'Словакия',
        SL: 'Сьерра-Леоне',
        SM: 'Сан-Марино',
        SN: 'Сенегал',
        SO: 'Сомали',
        SR: 'Суринам',
        SS: 'Южный Судан',
        ST: 'Сан-Томе и Принсипи',
        SV: 'Сальвадор',
        SX: 'Синт-Мартен',
        SY: 'Сирия',
        SZ: 'Эсватини',
        TC: 'Теркс и Кайкос',
        TD: 'Чад',
        TF: 'Французские южные территории',
        TG: 'Того',
        TH: 'Таиланд',
        TJ: 'Таджикистан',
        TK: 'Токелау',
        TL: 'Восточный Тимор',
        TM: 'Туркменистан',
        TN: 'Тунис',
        TO: 'Тонга',
        TR: 'Турция',
        TT: 'Тринидад и Тобаго',
        TV: 'Тувалу',
        TW: 'Тайвань',
        TZ: 'Танзания',
        UA: 'Украина',
        UG: 'Уганда',
        UM: 'Внешние малые острова США',
        US: 'США',
        UY: 'Уругвай',
        UZ: 'Узбекистан',
        VA: 'Ватикан',
        VC: 'Сент-Винсент и Гренадины',
        VE: 'Венесуэла',
        VG: 'Британские Виргинские острова',
        VI: 'Виргинские острова США',
        VN: 'Вьетнам',
        VU: 'Вануату',
        WF: 'Уоллис и Футуна',
        WS: 'Самоа',
        YE: 'Йемен',
        YT: 'Майотта',
        ZA: 'ЮАР',
        ZM: 'Замбия',
        ZW: 'Зимбабве',
    }
    return countries[countryCode] || countryCode
}
