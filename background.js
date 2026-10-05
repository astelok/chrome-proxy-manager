// Состояние не держим в памяти: service worker в MV3 засыпает через ~30 с простоя,
// поэтому активный профиль читается из chrome.storage при каждом событии.

const PROXY_SCHEMES = ['http', 'socks4', 'socks5']
const WEBRTC_POLICY = 'disable_non_proxied_udp'
const ICONS_ON = { 16: 'icons/icon16.png', 32: 'icons/icon32.png' }
const ICONS_OFF = { 16: 'icons/icon16-off.png', 32: 'icons/icon32-off.png' }

// requestId → время ответа на запрос авторизации. Повторный запрос с тем же requestId значит,
// что прокси отверг логин/пароль: отменяем, иначе Chrome будет слать неверные данные по кругу
const answeredAuth = new Map()
const AUTH_RETRY_WINDOW = 60 * 1000

chrome.runtime.onInstalled.addListener(initExtension)
chrome.runtime.onStartup.addListener(initExtension)

async function initExtension() {
    await removeLegacyAuthRules()
    await initWebRTCProtection()
    await serialized(getProxyStatus)
}

// До 1.2.0 логин и пароль прокси ставились заголовком Proxy-Authorization через declarativeNetRequest
// и уходили всем сайтам внутри HTTPS. Удаляем оставшиеся правила.
async function removeLegacyAuthRules() {
    try {
        const rules = await chrome.declarativeNetRequest.getDynamicRules()
        if (rules.length > 0) {
            await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: rules.map((rule) => rule.id) })
            console.log('🧹 Удалены старые правила Proxy-Authorization:', rules.length)
        }
    } catch (error) {
        console.error('❌ Не удалось удалить старые правила авторизации:', error)
    }
}

// Операции с прокси выполняются строго по очереди, иначе два быстрых клика перемешивают set/get
let queue = Promise.resolve()

function serialized(task) {
    const run = queue.then(task, task)
    queue = run.catch(() => {})
    return run
}

async function getActiveProfile() {
    const { activeProfile } = await chrome.storage.local.get('activeProfile')
    return activeProfile || null
}

function isControllable(settings) {
    return settings.levelOfControl === 'controllable_by_this_extension' || settings.levelOfControl === 'controlled_by_this_extension'
}

function controlError(settings) {
    if (settings.levelOfControl === 'controlled_by_other_extensions') {
        return 'прокси управляет другое расширение, отключите его'
    }
    return 'прокси задан политикой и не может быть изменён'
}

// Действует ли в Chrome именно наш прокси, а не чужой или системный
function matchesProfile(settings, profile) {
    const proxy = settings.value.rules && settings.value.rules.singleProxy
    return (
        settings.levelOfControl === 'controlled_by_this_extension' &&
        settings.value.mode === 'fixed_servers' &&
        !!proxy &&
        (proxy.scheme || 'http') === profile.type &&
        proxy.host.toLowerCase() === profile.host.toLowerCase() &&
        proxy.port === Number(profile.port)
    )
}

function validateProfile(profile) {
    if (!profile || typeof profile.host !== 'string' || !/^[a-z0-9_.-]+$/i.test(profile.host)) {
        return 'некорректный адрес прокси'
    }
    const port = Number(profile.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return 'некорректный порт'
    }
    if (!PROXY_SCHEMES.includes(profile.type)) {
        return 'неизвестный тип прокси'
    }
    if (profile.type !== 'http' && (profile.username || profile.password)) {
        return 'Chrome не поддерживает логин и пароль для SOCKS, используйте HTTP или доступ по IP'
    }
    return null
}

// Сверяет сохранённый профиль с тем, что реально стоит в Chrome, и обновляет badge
async function getProxyStatus() {
    let status
    try {
        const [settings, profile] = await Promise.all([chrome.proxy.settings.get({}), getActiveProfile()])

        if (!profile) {
            // Осталась наша настройка без профиля — снимаем, чтобы не было «невидимого» прокси
            if (settings.levelOfControl === 'controlled_by_this_extension') {
                await chrome.proxy.settings.clear({})
            }
            status = { state: 'off' }
        } else if (matchesProfile(settings, profile)) {
            status = { state: 'active', profile }
        } else if (!isControllable(settings)) {
            status = { state: 'conflict', profile, error: controlError(settings) }
        } else {
            // Профиль включён, но настройки в Chrome нет или она другая — ставим заново
            console.log('🔄 Настройка прокси пропала, применяем профиль заново')
            const result = await applyProxy(profile)
            status = result.success ? { state: 'active', profile } : { state: 'off', error: result.error }
        }

        if (status.state === 'active') {
            status.exit = await getExitInfo(status.profile)
        }
    } catch (error) {
        console.error('❌ Ошибка проверки состояния прокси:', error)
        status = { state: 'off', error: error.message }
    }

    updateBadge(status)
    return status
}

async function applyProxy(profile) {
    const invalid = validateProfile(profile)
    if (invalid) {
        return { success: false, error: invalid }
    }

    try {
        const current = await chrome.proxy.settings.get({})
        if (!isControllable(current)) {
            return { success: false, error: controlError(current) }
        }

        const config = {
            mode: 'fixed_servers',
            rules: {
                singleProxy: {
                    scheme: profile.type,
                    host: profile.host,
                    port: Number(profile.port),
                },
                bypassList: ['localhost', '127.0.0.1', '<local>'],
            },
        }

        // Профиль сохраняем до смены прокси: новый прокси может запросить авторизацию сразу
        const previous = await getActiveProfile()
        await chrome.storage.local.set({ activeProfile: profile })

        // Без clear() перед set(): set заменяет настройку сразу, а после clear() трафик какое-то время шёл бы напрямую
        try {
            await chrome.proxy.settings.set({ value: config, scope: 'regular' })
        } catch (error) {
            // В Chrome осталась прежняя настройка — возвращаем и прежний профиль
            if (previous) {
                await chrome.storage.local.set({ activeProfile: previous })
            } else {
                await chrome.storage.local.remove('activeProfile')
            }
            throw error
        }

        const applied = await chrome.proxy.settings.get({})
        if (!matchesProfile(applied, profile)) {
            await chrome.proxy.settings.clear({})
            await chrome.storage.local.remove('activeProfile')
            return { success: false, error: isControllable(applied) ? 'Chrome не применил настройки прокси' : controlError(applied) }
        }

        answeredAuth.clear()
        await chrome.storage.local.set({ lastProfileId: profile.id })
        console.log('✅ Прокси применён:', `${profile.type}://${profile.host}:${profile.port}`)
        return { success: true }
    } catch (error) {
        console.error('❌ Ошибка применения прокси:', error)
        return { success: false, error: error.message }
    }
}

async function disableProxy() {
    try {
        await chrome.proxy.settings.clear({})
        await chrome.storage.local.remove('activeProfile')
        console.log('🔌 Прокси отключен')
        return { success: true }
    } catch (error) {
        console.error('❌ Ошибка отключения прокси:', error)
        return { success: false, error: error.message }
    }
}

async function isWebRTCBlockEnabled() {
    const { webrtcBlocked } = await chrome.storage.local.get('webrtcBlocked')
    return webrtcBlocked !== false // По умолчанию включено
}

// Без этой политики WebRTC ходит мимо прокси по UDP и отдаёт сайту реальный IP
async function setWebRTCPolicy(enabled) {
    const policy = chrome.privacy.network.webRTCIPHandlingPolicy
    if (enabled) {
        await policy.set({ value: WEBRTC_POLICY, scope: 'regular' })
    } else {
        await policy.clear({ scope: 'regular' })
    }
}

async function isWebRTCProtected() {
    const setting = await chrome.privacy.network.webRTCIPHandlingPolicy.get({})
    return setting.value === WEBRTC_POLICY
}

async function initWebRTCProtection() {
    try {
        if (await isWebRTCBlockEnabled()) {
            await setWebRTCPolicy(true)
        }
    } catch (error) {
        console.error('❌ Не удалось включить защиту WebRTC:', error)
    }
}

async function toggleWebRTCProtection(enabled) {
    try {
        await chrome.storage.local.set({ webrtcBlocked: enabled })
        await setWebRTCPolicy(enabled)

        if (enabled && !(await isWebRTCProtected())) {
            return { success: false, error: 'политикой WebRTC управляет другое расширение' }
        }
        return { success: true }
    } catch (error) {
        console.error('❌ Ошибка управления WebRTC:', error)
        return { success: false, error: error.message }
    }
}

async function getStatus() {
    const status = await getProxyStatus()
    try {
        status.webrtcBlocked = await isWebRTCBlockEnabled()
        status.webrtcProtected = await isWebRTCProtected()
    } catch (error) {
        status.webrtcProtected = false
    }
    return status
}

// Внешний IP, который popup узнал через прокси. Действует, пока не сменился адрес профиля
async function getExitInfo(profile) {
    const { exitInfo } = await chrome.storage.local.get('exitInfo')
    if (!exitInfo || exitInfo.profileId !== profile.id || exitInfo.host !== profile.host || exitInfo.port !== String(profile.port)) {
        return null
    }
    return { ip: exitInfo.ip, country: exitInfo.country, ping: exitInfo.ping }
}

async function saveExitInfo(profileId, exit) {
    const profile = await getActiveProfile()
    if (!profile || profile.id !== profileId || !exit || typeof exit.ip !== 'string') return

    await chrome.storage.local.set({
        exitInfo: {
            profileId: profile.id,
            host: profile.host,
            port: String(profile.port),
            ip: exit.ip,
            country: /^[A-Z]{2}$/.test(exit.country) ? exit.country : null,
            ping: Number.isFinite(exit.ping) ? exit.ping : null,
        },
    })
}

// Значок: серый — прокси выключен, цветной — включён, на бейдже страна выхода
function updateBadge(status) {
    const icons = status.state === 'off' ? ICONS_OFF : ICONS_ON
    chrome.action.setIcon({ path: icons }).catch(() => {})

    if (status.state === 'active') {
        const exit = status.exit
        chrome.action.setBadgeText({ text: (exit && exit.country) || '●' })
        chrome.action.setBadgeBackgroundColor({ color: '#13a05a' })
        chrome.action.setTitle({ title: `Proxy Manager — ${status.profile.name}${exit ? `, IP ${exit.ip}` : ''}` })
    } else if (status.state === 'conflict') {
        chrome.action.setBadgeText({ text: '!' })
        chrome.action.setBadgeBackgroundColor({ color: '#e0434a' })
        chrome.action.setTitle({ title: `Proxy Manager — не работает: ${status.error}` })
    } else {
        chrome.action.setBadgeText({ text: '' })
        chrome.action.setTitle({ title: 'Proxy Manager — прокси выключен' })
    }
}

// Горячая клавиша: выключает прокси или включает последний профиль
async function toggleProxy() {
    const status = await getProxyStatus()
    if (status.state !== 'off') {
        await disableProxy()
    } else {
        const { profiles = [], lastProfileId } = await chrome.storage.local.get(['profiles', 'lastProfileId'])
        const profile = profiles.find((p) => p.id === lastProfileId) || profiles[0]
        if (!profile) return

        const result = await applyProxy({ ...profile, type: profile.type || 'http' })
        if (!result.success) {
            console.error('❌ Не удалось включить прокси с клавиатуры:', result.error)
        }
    }
    await getProxyStatus()
}

chrome.commands.onCommand.addListener((command) => {
    if (command === 'toggle-proxy') serialized(toggleProxy)
})

function notifyPopup(message) {
    chrome.runtime.sendMessage(message).catch(() => {})
}

async function handleAuthRequired(details) {
    if (!details.isProxy) return {}

    const profile = await getActiveProfile()
    if (!profile || !profile.username || !profile.password) return {}

    // Данные отдаём только нашему прокси, а не любому, кто спросит
    const { host, port } = details.challenger
    if (host.toLowerCase() !== profile.host.toLowerCase() || port !== Number(profile.port)) return {}

    const now = Date.now()
    for (const [requestId, time] of answeredAuth) {
        if (now - time > AUTH_RETRY_WINDOW) answeredAuth.delete(requestId)
    }

    if (answeredAuth.has(details.requestId)) {
        console.error('❌ Прокси отклонил логин или пароль')
        notifyPopup({ action: 'proxyError', error: 'прокси отклонил логин или пароль' })
        return { cancel: true }
    }

    answeredAuth.set(details.requestId, now)
    return { authCredentials: { username: profile.username, password: profile.password } }
}

chrome.webRequest.onAuthRequired.addListener(
    (details, callback) => {
        handleAuthRequired(details).then(callback, (error) => {
            console.error('❌ Ошибка авторизации прокси:', error)
            callback({})
        })
    },
    { urls: ['<all_urls>'] },
    ['asyncBlocking']
)

chrome.proxy.onProxyError.addListener((details) => {
    console.error('Ошибка прокси:', details)
    if (details.error) {
        notifyPopup({ action: 'proxyError', error: details.error })
    }
})

// Обработка сообщений от popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    switch (request.action) {
        case 'getStatus':
            serialized(getStatus).then(sendResponse)
            return true

        case 'applyProxy':
            serialized(async () => ({ ...(await applyProxy(request.profile)), status: await getStatus() })).then(sendResponse)
            return true

        case 'disableProxy':
            serialized(async () => ({ ...(await disableProxy()), status: await getStatus() })).then(sendResponse)
            return true

        case 'toggleWebRTC':
            serialized(async () => ({ ...(await toggleWebRTCProtection(request.enabled)), status: await getStatus() })).then(sendResponse)
            return true

        case 'exitInfo':
            serialized(async () => {
                await saveExitInfo(request.profileId, request.exit)
                await getProxyStatus()
            })
            return false
    }
})
