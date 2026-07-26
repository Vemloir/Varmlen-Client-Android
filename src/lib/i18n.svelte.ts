import { browser } from "$app/environment";

export type Lang = "en" | "ru";
const KEY = "varmlen.lang";

type Dict = Record<string, string>;

const EN: Dict = {
  // nav
  "nav.home": "Home",
  "nav.split": "Split",
  "nav.settings": "Settings",

  // home / connection
  "status.disconnected": "Not connected",
  "status.connecting": "Connecting",
  "status.connected": "Connected",
  "status.dropped": "VPN dropped - traffic blocked",
  "conn.selectLocation": "Select a location first",
  "conn.dropped": "Connection lost. The kill switch is blocking all traffic. Reconnect, or allow traffic below.",
  "conn.droppedNoKill": "Connection lost.",
  "conn.allowTraffic": "Disconnect & allow traffic",
  "home.empty": "No subscriptions yet. Tap + in the top-right corner.",
  "home.autoUpdate": "auto-update {h}h",
  "home.expires": "Expires: {date}",

  // subscription menu
  "menu.info": "Subscription info",
  "menu.rename": "Rename",
  "menu.pin": "Pin",
  "menu.unpin": "Unpin",
  "menu.remove": "Remove subscription",

  // info modal
  "info.url": "URL",
  "info.imported": "Imported",
  "info.autoUpdate": "Auto-update",
  "info.everyH": "every {h} h",
  "info.traffic": "Traffic",
  "info.expires": "Expires",
  "info.servers": "Servers",
  "info.support": "Support",

  // rename modal
  "rename.title": "Rename subscription",

  // import modal
  "import.title": "Add subscription",
  "import.hint": "From the clipboard, or enter it by hand.",
  "import.importing": "Importing…",
  "import.add": "Add",
  "import.fromClipboard": "Paste from clipboard",
  "import.manual": "Enter manually",
  "import.manualHint": "A subscription URL, a vless:// / vmess:// / trojan:// / ss:// link, or JSON (xray config / outbounds).",
  "import.clipboardFail": "Couldn't read the clipboard - paste it below.",
  "import.clipboardEmpty": "The clipboard is empty - paste it below.",

  // generic
  "common.close": "Close",
  "common.cancel": "Cancel",
  "common.save": "Save",

  // split
  "split.title": "Split tunneling",
  "split.apps": "Apps",
  "split.websites": "Websites",
  "split.mode": "Mode",
  "split.modeGeneral": "General",
  "split.modeSelective": "Selective",
  "split.active": "{n} active",
  "split.mode.selective": "VPN works only for the listed entries here. Everything else stays direct.",
  "split.mode.general": "VPN works for everything except the listed entries here (which stay direct).",
  "split.searchApps": "Search apps",
  "split.noAppsTitle": "No apps yet",
  "split.noAppsHint": "Tap + to pick from your installed apps, or choose one by file.",
  "split.noAppsMatch": "No apps match the query.",
  "split.sitePlaceholder": "example.com or *.example.com",
  "split.noSitesTitle": "No websites yet",
  "split.noSitesHint": "Add a hostname (example.com) or a wildcard pattern (*.example.com).",
  "split.addApp": "Add app",
  "split.srcInstalled": "Installed",
  "split.srcRunning": "Running",
  "split.searchInstalled": "Search installed apps",
  "split.loadingApps": "Loading installed apps…",
  "split.noInstalled": "No installed apps found.",
  "split.noInstalledMatch": "Nothing matches your search.",
  "split.pickFileHint": "Don't see your app (e.g. a Steam game)? Pick its .desktop file or executable.",
  "split.manualHint": "Don't see your app (e.g. a Steam game)? Type its process name, or choose its file.",
  "split.manualPlaceholder": "Process name (e.g. cs2)",
  "split.chooseFile": "Choose from file…",
  "split.addSelected": "Add ({n})",

  // settings
  "settings.title": "Settings",
  "settings.appearance": "Appearance",
  "settings.dark": "Dark",
  "settings.light": "Light",
  "settings.general": "General",
  "settings.language": "Language",
  "settings.killswitch": "Killswitch",
  "settings.killswitchSub": "Block all traffic if the VPN connection drops.",
  "settings.androidKillswitch": "Android kill switch",
  "settings.androidKillswitchSub": "Enable Always-on VPN and Block connections without VPN in system settings.",
  "settings.allowLan": "Allow LAN traffic",
  "settings.allowLanSub": "Keep printers, NAS, and local devices reachable.",
  "settings.closeToTray": "Close to tray",
  "settings.closeToTraySub": "Closing the window keeps Varmlen running in the tray; off = quit fully.",
  "settings.autostart": "Launch at login",
  "settings.autostartSub": "Start Varmlen automatically when you sign in.",
  "settings.autostartMinimized": "Start minimized",
  "settings.autostartMinimizedSub": "Launch straight to the tray, without a window.",
  "settings.permissions": "Permissions",
  "settings.diagnostics": "Diagnostics",
  "settings.notifications": "Notifications",
  "settings.notificationsOn": "Enabled. Shows speed and uptime while connected.",
  "settings.notificationsOff": "Off. Tap to enable the VPN status notification.",
  "settings.logLevel": "Log level",
  "settings.logLevelSub": "Verbosity of the VPN log (xray + tun2socks).",
  "settings.viewLog": "View log",
  "settings.viewLogSub": "Open the VPN log - useful when a connection fails.",
  "settings.logEmpty": "(log is empty - connect once to populate it)",
  "settings.logClear": "Clear",
  "settings.logCopy": "Copy",
  "settings.logCopied": "Copied",
  "settings.logCopyFailed": "Copy failed",
  "settings.logRefresh": "Refresh",
  "settings.pingMethod": "Ping method",
  "settings.pingMethodSub": "How server latency is measured.",
  "ping.tcp": "TCP",
  "ping.proxy": "Via proxy (GET)",
  "ping.na": "n/a",
  "ping.ms": "{n} ms",

  // VPN mode
  "settings.vpnMode": "VPN mode",
  "mode.tun": "TUN (system-wide)",
  "mode.proxy": "Proxy (SOCKS/HTTP)",
  "mode.tunSub": "Routes every app. Needs network permissions.",
  "mode.proxySub": "Local proxy at 127.0.0.1:2081 - no root. Point your apps/system at it.",

  // VPN core (xray)
  "settings.core": "VPN core",
  "core.checking": "Checking for updates…",
  "core.checkFailed": "Couldn't check for updates",
  "core.notInstalled": "Not installed",
  "core.upToDate": "Up to date",
  "core.updateAvailable": "Update available",
  "core.latest": "latest {v}",
  "core.install": "Install",
  "core.update": "Update",
  "core.updating": "Downloading…",
  "core.versions": "Versions",
  "core.versionsTitle": "Core versions",
  "core.downloaded": "Downloaded",
  "core.available": "Available",
  "core.fetch": "Fetch",
  "core.fetchHint": "Fetch to see versions available to download.",
  "core.noDownloaded": "No versions downloaded yet.",
  "core.preview": "pre-release",
  "core.currentlyInstalled": "currently installed",
  "core.active": "Active",
  "core.use": "Use",
  "core.download": "Download",
  "core.reinstall": "Re-download",
  "core.delete": "Delete",

  // Network permissions (setcap on the cores; no root daemon)
  "settings.helper": "Network permissions",
  "helper.title": "Network permissions",
  "helper.ready": "Granted",
  "helper.notInstalled": "Not granted - required for TUN mode",
  "helper.checking": "Checking…",
  "helper.install": "Grant",
  "helper.reinstall": "Re-grant",
  "helper.installing": "Granting…",
};

const RU: Dict = {
  "nav.home": "Главная",
  "nav.split": "Сплит",
  "nav.settings": "Настройки",

  "status.disconnected": "Не подключено",
  "status.connecting": "Подключение",
  "status.connected": "Подключено",
  "status.dropped": "VPN отвалился - трафик заблокирован",
  "conn.selectLocation": "Сначала выберите локацию",
  "conn.dropped": "Соединение потеряно. Kill switch блокирует весь трафик. Переподключитесь или разрешите трафик ниже.",
  "conn.droppedNoKill": "Соединение потеряно.",
  "conn.allowTraffic": "Отключить и разрешить трафик",
  "home.empty": "Пока нет подписок. Нажмите + в правом верхнем углу.",
  "home.autoUpdate": "автообновление {h}ч",
  "home.expires": "Истекает: {date}",

  "menu.info": "Информация о подписке",
  "menu.rename": "Переименовать",
  "menu.pin": "Закрепить",
  "menu.unpin": "Открепить",
  "menu.remove": "Удалить подписку",

  "info.url": "Ссылка",
  "info.imported": "Добавлена",
  "info.autoUpdate": "Автообновление",
  "info.everyH": "каждые {h} ч",
  "info.traffic": "Трафик",
  "info.expires": "Истекает",
  "info.servers": "Серверы",
  "info.support": "Поддержка",

  "rename.title": "Переименовать подписку",

  "import.title": "Добавить подписку",
  "import.hint": "Из буфера обмена или ввести вручную.",
  "import.importing": "Добавление…",
  "import.add": "Добавить",
  "import.fromClipboard": "Вставить из буфера",
  "import.manual": "Ввести вручную",
  "import.manualHint": "URL подписки, ссылка vless:// / vmess:// / trojan:// / ss:// или JSON (конфиг xray / outbounds).",
  "import.clipboardFail": "Не удалось прочитать буфер - вставьте ниже.",
  "import.clipboardEmpty": "Буфер обмена пуст - вставьте ниже.",

  "common.close": "Закрыть",
  "common.cancel": "Отмена",
  "common.save": "Сохранить",

  "split.title": "Раздельный туннель",
  "split.apps": "Приложения",
  "split.websites": "Сайты",
  "split.mode": "Режим",
  "split.modeGeneral": "Общий",
  "split.modeSelective": "Выборочный",
  "split.active": "активно: {n}",
  "split.mode.selective": "VPN работает только для записей из этого списка. Остальное - напрямую.",
  "split.mode.general": "VPN работает для всего, кроме записей из этого списка (они идут напрямую).",
  "split.searchApps": "Поиск приложений",
  "split.noAppsTitle": "Пока нет приложений",
  "split.noAppsHint": "Нажмите +, чтобы выбрать из установленных приложений или указать файл.",
  "split.noAppsMatch": "Ничего не найдено по запросу.",
  "split.sitePlaceholder": "example.com или *.example.com",
  "split.noSitesTitle": "Пока нет сайтов",
  "split.noSitesHint": "Добавьте домен (example.com) или шаблон (*.example.com).",
  "split.addApp": "Добавить приложение",
  "split.srcInstalled": "Установленные",
  "split.srcRunning": "Запущенные",
  "split.searchInstalled": "Поиск установленных приложений",
  "split.loadingApps": "Загрузка приложений…",
  "split.noInstalled": "Установленные приложения не найдены.",
  "split.noInstalledMatch": "Ничего не найдено.",
  "split.pickFileHint": "Нет вашего приложения (например, игры Steam)? Выберите его .desktop-файл или исполняемый файл.",
  "split.manualHint": "Нет приложения в списке (например, игра Steam)? Впишите имя его процесса или выберите файл.",
  "split.manualPlaceholder": "Имя процесса (например cs2)",
  "split.chooseFile": "Выбрать файл…",
  "split.addSelected": "Добавить ({n})",

  "settings.title": "Настройки",
  "settings.appearance": "Оформление",
  "settings.dark": "Тёмная",
  "settings.light": "Светлая",
  "settings.general": "Общие",
  "settings.language": "Язык",
  "settings.killswitch": "Killswitch",
  "settings.killswitchSub": "Блокировать весь трафик, если VPN отключился.",
  "settings.androidKillswitch": "Kill switch Android",
  "settings.androidKillswitchSub": "Включите «Постоянная VPN» и блокировку соединений без VPN в системных настройках.",
  "settings.allowLan": "Разрешить локальную сеть",
  "settings.allowLanSub": "Оставить доступными принтеры, NAS и локальные устройства.",
  "settings.closeToTray": "Закрывать в трей",
  "settings.closeToTraySub": "Крестик сворачивает Varmlen в трей; выкл - полный выход.",
  "settings.autostart": "Запуск при входе",
  "settings.autostartSub": "Запускать Varmlen автоматически при входе в систему.",
  "settings.autostartMinimized": "Запускать свёрнутым",
  "settings.autostartMinimizedSub": "Запуск сразу в трей, без окна.",
  "settings.permissions": "Разрешения",
  "settings.diagnostics": "Диагностика",
  "settings.notifications": "Уведомления",
  "settings.notificationsOn": "Включены. Показывают скорость и время подключения.",
  "settings.notificationsOff": "Выключены. Нажми, чтобы включить уведомление статуса VPN.",
  "settings.logLevel": "Уровень логов",
  "settings.logLevelSub": "Подробность VPN-лога (xray + tun2socks).",
  "settings.viewLog": "Посмотреть лог",
  "settings.viewLogSub": "Открыть VPN-лог - полезно, если не подключается.",
  "settings.logEmpty": "(лог пуст - заполнится после подключения)",
  "settings.logClear": "Очистить",
  "settings.logCopy": "Копировать",
  "settings.logCopied": "Скопировано",
  "settings.logCopyFailed": "Ошибка копирования",
  "settings.logRefresh": "Обновить",
  "settings.pingMethod": "Метод пинга",
  "settings.pingMethodSub": "Как измеряется задержка серверов.",
  "ping.tcp": "TCP",
  "ping.proxy": "Через прокси (GET)",
  "ping.na": "н/д",
  "ping.ms": "{n} мс",

  "settings.vpnMode": "Режим VPN",
  "mode.tun": "TUN (всё устройство)",
  "mode.proxy": "Прокси (SOCKS/HTTP)",
  "mode.tunSub": "Весь трафик системы. Нужны сетевые права.",
  "mode.proxySub": "Локальный прокси 127.0.0.1:2081 - без root. Укажи его в приложениях/системе.",

  "settings.core": "Ядро VPN",
  "core.checking": "Проверка обновлений…",
  "core.checkFailed": "Не удалось проверить обновления",
  "core.notInstalled": "Не установлено",
  "core.upToDate": "Актуальная версия",
  "core.updateAvailable": "Доступно обновление",
  "core.latest": "последняя {v}",
  "core.install": "Установить",
  "core.update": "Обновить",
  "core.updating": "Загрузка…",
  "core.versions": "Версии",
  "core.versionsTitle": "Версии ядра",
  "core.downloaded": "Скачанные",
  "core.available": "Доступные",
  "core.fetch": "Получить",
  "core.fetchHint": "Нажмите «Получить», чтобы увидеть доступные для скачивания версии.",
  "core.noDownloaded": "Пока нет скачанных версий.",
  "core.preview": "пре-релиз",
  "core.currentlyInstalled": "сейчас установлена",
  "core.active": "Активна",
  "core.use": "Выбрать",
  "core.download": "Скачать",
  "core.reinstall": "Перекачать",
  "core.delete": "Удалить",

  "settings.helper": "Сетевые права",
  "helper.title": "Сетевые права",
  "helper.ready": "Выданы",
  "helper.notInstalled": "Не выданы - нужны для режима TUN",
  "helper.checking": "Проверка…",
  "helper.install": "Выдать",
  "helper.reinstall": "Выдать заново",
  "helper.installing": "Выдача…",
};

const DICTS: Record<Lang, Dict> = { en: EN, ru: RU };

function detect(): Lang {
  if (!browser) return "en";
  const stored = localStorage.getItem(KEY);
  if (stored === "ru" || stored === "en") return stored;
  return navigator.language?.toLowerCase().startsWith("ru") ? "ru" : "en";
}

class I18n {
  lang = $state<Lang>(detect());

  set(l: Lang): void {
    this.lang = l;
    if (browser) localStorage.setItem(KEY, l);
  }

  /** Translate a key, substituting {placeholders} from vars. Falls back to
   *  English, then to the key itself. */
  t(key: string, vars?: Record<string, string | number>): string {
    let s = DICTS[this.lang][key] ?? EN[key] ?? key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        s = s.replaceAll(`{${k}}`, String(v));
      }
    }
    return s;
  }
}

export const i18n = new I18n();

/** Reactive translate helper - reads i18n.lang, so templates update on change. */
export function t(key: string, vars?: Record<string, string | number>): string {
  return i18n.t(key, vars);
}

export const LANGUAGES: { value: Lang; label: string }[] = [
  { value: "en", label: "English" },
  { value: "ru", label: "Русский" },
];
