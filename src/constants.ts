export const BROWSER_OS_CONFIGS = {
  windows: {
    platform: 'Win_x64',
    zipName: 'chrome-win.zip',
    executablePath: 'chrome-win/chrome.exe',
  },
  darwin: {
    platform: 'Mac',
    zipName: 'chrome-mac.zip',
    executablePath: 'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
  },
  linux: {
    platform: 'Linux_x64',
    zipName: 'chrome-linux.zip',
    executablePath: 'chrome-linux/chrome',
  },
  freebsd: {
    platform: 'Linux_x64',
    zipName: 'chrome-linux.zip',
    executablePath: 'chrome-linux/chrome',
  },
  netbsd: {
    platform: 'Linux_x64',
    zipName: 'chrome-linux.zip',
    executablePath: 'chrome-linux/chrome',
  },
  aix: {
    platform: 'Linux_x64',
    zipName: 'chrome-linux.zip',
    executablePath: 'chrome-linux/chrome',
  },
  solaris: {
    platform: 'Linux_x64',
    zipName: 'chrome-linux.zip',
    executablePath: 'chrome-linux/chrome',
  },
  illumos: {
    platform: 'Linux_x64',
    zipName: 'chrome-linux.zip',
    executablePath: 'chrome-linux/chrome',
  },
  android: {
    platform: 'Linux_x64',
    zipName: 'chrome-linux.zip',
    executablePath: 'chrome-linux/chrome',
  },
} as const

export const CDP_SCHEMA_URLS = {
  BROWSER_PROTOCOL: 'https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/json/browser_protocol.json',
  JS_PROTOCOL: 'https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/json/js_protocol.json',
} as const

export const CHROMIUM_DATA_STORAGE_URL =
  'https://commondatastorage.googleapis.com/chromium-browser-snapshots' as const

export const CDP_WEBSOCKET_PATHS = ['/devtools/browser', '/devtools/page', '/devtools/inspector'] as const

export const CHROME_FLAGS = [
  '--headless=new',
  '--disable-gpu',
  '--disable-accelerated-video-decode',
  '--no-sandbox',
  '--enable-logging',
  '--v=1',
  '--enable-features=NetworkService,NetworkServiceInProcess',
  '--allow-pre-commit-input',
  '--disable-background-networking',
  '--disable-default-apps',
  '--disable-extensions',
  '--disable-sync',
  '--enable-automation',
  '--password-store=basic'
] as const

export const WEBSOCKET_MANAGER = {
  MAX_PENDING_MESSAGES: 1000,
  HEARTBEAT_INTERVAL: 30000,
  CLEANUP_TIMEOUT: 100,
  LOG_STYLE: 'color: rgb(50, 205, 50); font-weight: bold;',
} as const
