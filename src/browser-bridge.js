import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const CDP_VERSION = '1.3'
const MAX_RPC_BUFFER_BYTES = 16 * 1024 * 1024

/**
 * Owns browser-plugin WebContentsViews for the desktop shell. The Harness
 * process reaches it over authenticated loopback JSON-RPC; no browser command
 * is accepted until the caller proves it inherited this launch's random token.
 */
export class DesktopBrowserBridge {
  constructor({ WebContentsView, getWindow, paneWidth = 0.46 }) {
    this.WebContentsView = WebContentsView
    this.getWindow = getWindow
    this.paneWidth = paneWidth
    this.token = randomBytes(24).toString('hex')
    this.server = undefined
    this.port = undefined
    this.views = new Map()
    this.connections = new Set()
    this.toolbar = undefined
    this.topInset = process.platform === 'darwin' ? 52 : 0
  }

  async start() {
    if (this.server) return this.environment()
    this.server = createServer(socket => this.attach(socket))
    this.server.unref()
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', resolve)
    })
    const address = this.server.address()
    this.port = typeof address === 'object' && address ? address.port : undefined
    if (!this.port) throw new Error('Desktop browser bridge did not receive a loopback port')
    return this.environment()
  }

  environment() {
    if (!this.port) throw new Error('Desktop browser bridge has not started')
    return {
      DSH_DESKTOP_BROWSER_RPC_PORT: String(this.port),
      DSH_DESKTOP_BROWSER_RPC_TOKEN: this.token,
    }
  }

  stop() {
    for (const socket of this.connections) socket.destroy()
    this.connections.clear()
    for (const entry of this.views.values()) this.destroyEntry(entry)
    this.views.clear()
    try { this.toolbar?.webContents.close() } catch {}
    try { this.getWindow()?.contentView.removeChildView(this.toolbar) } catch {}
    this.toolbar = undefined
    this.restoreHarnessWidth()
    this.server?.close()
    this.server = undefined
    this.port = undefined
  }

  attach(socket) {
    this.connections.add(socket)
    socket.setEncoding('utf8')
    let buffer = ''
    let authenticated = false
    socket.on('error', () => {})
    socket.on('close', () => this.connections.delete(socket))
    socket.on('data', chunk => {
      buffer += chunk
      if (buffer.length > MAX_RPC_BUFFER_BYTES) return socket.destroy()
      let nl
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        let message
        try { message = JSON.parse(line) } catch { socket.destroy(); return }
        if (!authenticated) {
          if (message?.op !== 'hello' || message.token !== this.token) { socket.destroy(); return }
          authenticated = true
          continue
        }
        void this.dispatch(message).then(
          result => this.reply(socket, message.id, true, result),
          error => this.reply(socket, message.id, false, undefined, error instanceof Error ? error.message : String(error)),
        )
      }
    })
  }

  reply(socket, id, ok, result, err) {
    if (typeof id !== 'number' || socket.destroyed) return
    socket.write(JSON.stringify({ id, ok, ...(ok ? { result } : { err }) }) + '\n')
  }

  async dispatch(message) {
    const viewId = message.viewId
    switch (message.op) {
      case 'ping': return { ready: true }
      case 'groupView': return {}
      case 'createView': return this.createView(viewId)
      case 'destroyView': return this.destroyView(viewId)
      case 'showView': return this.showView(viewId)
      case 'command': return this.command(viewId, message.method, message.params)
      case 'capture': return this.capture(viewId, message)
      case 'download': return this.download(viewId, message.url, message.savePath)
      case 'flushAuth': return this.flushAuth(viewId)
      case 'restoreAuth': return this.restoreAuth(viewId, message.cookies)
      default: throw new Error(`unknown browser bridge operation: ${String(message.op)}`)
    }
  }

  createView(viewId) {
    if (typeof viewId !== 'string') throw new Error('createView missing viewId')
    if (this.views.has(viewId)) return {}
    const win = this.getWindow()
    if (!win || !this.WebContentsView) throw new Error('Desktop window is not available')
    this.ensureToolbar(win)
    const view = new this.WebContentsView()
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) {
        void view.webContents.loadURL(url).catch(() => {})
      }
      return { action: 'deny' }
    })
    view.webContents.debugger.attach(CDP_VERSION)
    view.webContents.on('did-navigate', () => this.syncToolbar())
    view.webContents.on('did-navigate-in-page', () => this.syncToolbar())
    view.setVisible(false)
    win.contentView.addChildView(view)
    this.views.set(viewId, { view, visible: false })
    this.layout()
    return {}
  }

  destroyView(viewId) {
    const entry = this.entry(viewId)
    this.destroyEntry(entry)
    this.views.delete(viewId)
    this.layout()
    return {}
  }

  destroyEntry(entry) {
    try { entry.view.webContents.debugger.detach() } catch {}
    try { entry.view.webContents.close() } catch {}
    try { this.getWindow()?.contentView.removeChildView(entry.view) } catch {}
  }

  showView(viewId) {
    const entry = this.entry(viewId)
    for (const candidate of this.views.values()) candidate.view.setVisible(false)
    entry.visible = true
    entry.view.setVisible(true)
    const win = this.getWindow()
    try { win?.contentView.removeChildView(entry.view); win?.contentView.addChildView(entry.view) } catch {}
    this.layout()
    this.syncToolbar()
    return {}
  }

  async command(viewId, method, params = {}) {
    if (typeof method !== 'string') throw new Error('command missing method')
    return this.entry(viewId).view.webContents.debugger.sendCommand(method, params)
  }

  async capture(viewId, options) {
    const image = await this.entry(viewId).view.webContents.capturePage()
    const format = options.format === 'jpeg' ? 'jpeg' : 'png'
    const buffer = format === 'jpeg' ? image.toJPEG(typeof options.quality === 'number' ? options.quality : 80) : image.toPNG()
    if (!buffer.length) throw new Error('capture produced no image')
    return { base64: buffer.toString('base64'), mime: format === 'jpeg' ? 'image/jpeg' : 'image/png' }
  }

  async download(viewId, url, savePath) {
    if (typeof url !== 'string' || typeof savePath !== 'string') throw new Error('download missing url or savePath')
    const response = await this.command(viewId, 'Runtime.evaluate', {
      expression: `(async () => { const r = await fetch(${JSON.stringify(url)}, { credentials: 'include' }); if (!r.ok) throw new Error('HTTP ' + r.status); const b = new Uint8Array(await r.arrayBuffer()); let s=''; for (let i=0;i<b.length;i+=0x8000) s += String.fromCharCode(...b.subarray(i,i+0x8000)); return btoa(s) })()`,
      awaitPromise: true,
      returnByValue: true,
    })
    const base64 = response?.result?.value
    if (typeof base64 !== 'string') throw new Error('download failed')
    const temporary = `${savePath}.part`
    mkdirSync(dirname(savePath), { recursive: true })
    writeFileSync(temporary, Buffer.from(base64, 'base64'))
    try { renameSync(temporary, savePath) } catch (error) { try { unlinkSync(temporary) } catch {}; throw error }
    return { path: savePath }
  }

  async flushAuth(viewId) {
    const cookies = await this.entry(viewId).view.webContents.session.cookies.get({})
    return { cookies: cookies.map(cookie => ({
      url: `http${cookie.secure ? 's' : ''}://${cookie.domain?.replace(/^\./, '') ?? ''}${cookie.path ?? '/'}`,
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain ?? '',
      path: cookie.path ?? '/',
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      expirationDate: cookie.expirationDate,
    })) }
  }

  async restoreAuth(viewId, cookies) {
    if (!Array.isArray(cookies)) throw new Error('restoreAuth missing cookies array')
    let restored = 0
    for (const cookie of cookies) {
      if (!cookie || typeof cookie.url !== 'string' || typeof cookie.name !== 'string' || typeof cookie.value !== 'string') continue
      await this.entry(viewId).view.webContents.session.cookies.set(cookie)
      restored++
    }
    return { restored }
  }

  showPane() {
    let entry = [...this.views.values()].find(candidate => candidate.visible) ?? [...this.views.values()][0]
    if (!entry) {
      const id = 'desktop-manual-browser'
      this.createView(id)
      entry = this.views.get(id)
    }
    if (!entry) return false
    entry.visible = true
    entry.view.setVisible(true)
    this.layout()
    this.syncToolbar()
    return true
  }

  /**
   * Return the shared right-hand area to DSH. DSH owns the Files panel, so we
   * deliberately ask its real "Open sidebar" control to reveal it instead of
   * maintaining a second, incomplete file browser in the desktop wrapper.
   */
  showFiles() {
    for (const entry of this.views.values()) {
      entry.visible = false
      entry.view.setVisible(false)
    }
    this.toolbar?.setVisible(false)
    this.restoreHarnessWidth()
    this.openHarnessSidebar()
    return true
  }

  ensureToolbar(win) {
    if (this.toolbar) return
    const toolbar = new this.WebContentsView({ webPreferences: { nodeIntegration: true, contextIsolation: false } })
    const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#27272a;color:#eee;font:13px -apple-system,sans-serif;display:flex;align-items:center;gap:6px;padding:3px 7px}.tab{border:0;border-radius:6px;background:transparent;color:#b9b9c0;height:28px;padding:0 9px;font-size:13px}.tab:hover{background:#404045;color:#fff}.tab[aria-selected=true]{background:#404045;color:#fff;font-weight:600}.icon{border:0;border-radius:6px;background:#404045;color:#eee;width:28px;height:28px;font-size:17px}.icon:hover{background:#555}.divider{width:1px;height:20px;background:#555;margin:0 2px}input{flex:1;min-width:0;height:26px;border:1px solid #555;border-radius:6px;background:#1d1d20;color:#eee;padding:0 9px;font-size:13px}</style><button class="tab" id="files" title="Show Files">Files</button><button class="tab" id="browser" aria-selected="true" title="Show Browser">Browser</button><span class="divider"></span><button class="icon" id="back" title="Back">‹</button><button class="icon" id="forward" title="Forward">›</button><button class="icon" id="reload" title="Reload">↻</button><input id="url" placeholder="Enter URL"><button class="icon" id="close" title="Close browser">×</button><script>const{ipcRenderer}=require('electron');for(const id of ['files','browser','back','forward','reload','close'])document.getElementById(id).onclick=()=>ipcRenderer.send('dsh-browser-toolbar',{action:id});const input=document.getElementById('url');input.onkeydown=e=>{if(e.key==='Enter')ipcRenderer.send('dsh-browser-toolbar',{action:'navigate',url:input.value})};ipcRenderer.on('browser-state',(_,state)=>{if(document.activeElement!==input)input.value=state.url||'';document.getElementById('back').disabled=!state.canBack;document.getElementById('forward').disabled=!state.canForward})</script>`
    toolbar.webContents.on('ipc-message', (_event, channel, message) => {
      if (channel === 'dsh-browser-toolbar') this.handleToolbar(message)
    })
    toolbar.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)).catch(() => {})
    win.contentView.addChildView(toolbar)
    this.toolbar = toolbar
  }

  handleToolbar(message) {
    const entry = [...this.views.values()].find(candidate => candidate.visible) ?? [...this.views.values()][0]
    if (!entry || !message || typeof message.action !== 'string') return
    const contents = entry.view.webContents
    switch (message.action) {
      case 'files':
        this.showFiles()
        return
      case 'browser':
        this.showPane()
        return
      case 'back': if (contents.canGoBack()) contents.goBack(); break
      case 'forward': if (contents.canGoForward()) contents.goForward(); break
      case 'reload': contents.reload(); break
      case 'close':
        entry.view.setVisible(false)
        entry.visible = false
        this.toolbar?.setVisible(false)
        this.restoreHarnessWidth()
        return
      case 'navigate': {
        if (typeof message.url !== 'string' || message.url.trim() === '') return
        const url = /^[a-z][a-z0-9+.-]*:/i.test(message.url) ? message.url : 'https://' + message.url
        void contents.loadURL(url).catch(() => {})
        break
      }
    }
    this.syncToolbar()
  }

  syncToolbar() {
    const entry = [...this.views.values()].find(candidate => candidate.visible) ?? [...this.views.values()][0]
    if (!entry || !this.toolbar) return
    const contents = entry.view.webContents
    try { this.toolbar.webContents.send('browser-state', { url: contents.getURL(), canBack: contents.canGoBack(), canForward: contents.canGoForward() }) } catch {}
  }

  entry(viewId) {
    if (typeof viewId !== 'string') throw new Error('browser operation missing viewId')
    const entry = this.views.get(viewId)
    if (!entry) throw new Error(`unknown browser view ${viewId}`)
    return entry
  }

  layout() {
    const win = this.getWindow()
    const visible = [...this.views.values()].find(entry => entry.visible)
    if (!win || !visible) { this.restoreHarnessWidth(); return }
    const bounds = win.getContentBounds()
    const width = Math.min(Math.max(420, Math.round(bounds.width * this.paneWidth)), Math.max(320, bounds.width - 360))
    const toolbarHeight = this.toolbar ? 36 : 0
    const y = this.topInset
    const height = Math.max(0, bounds.height - y - toolbarHeight)
    for (const entry of this.views.values()) entry.view.setBounds({ x: bounds.width - width, y: y + toolbarHeight, width, height })
    this.toolbar?.setBounds({ x: bounds.width - width, y, width, height: toolbarHeight })
    this.toolbar?.setVisible(true)
    this.setHarnessWidth(width)
  }

  setHarnessWidth(width) {
    const contents = this.getWindow()?.webContents
    if (!contents || contents.isDestroyed?.() || typeof contents.executeJavaScript !== 'function') return
    void contents.executeJavaScript(`(() => { let s=document.getElementById('dsh-desktop-browser-pane'); if (!s) { s=document.createElement('style'); s.id='dsh-desktop-browser-pane'; document.head.appendChild(s) }; s.textContent='html, body { pointer-events: none !important; } #root { width: calc(100% - ${width}px) !important; max-width: calc(100% - ${width}px) !important; pointer-events: auto !important; }'; })()`).catch(() => {})
  }

  restoreHarnessWidth() {
    const contents = this.getWindow()?.webContents
    if (!contents || contents.isDestroyed?.() || typeof contents.executeJavaScript !== 'function') return
    void contents.executeJavaScript("document.getElementById('dsh-desktop-browser-pane')?.remove()").catch(() => {})
  }

  openHarnessSidebar() {
    const contents = this.getWindow()?.webContents
    if (!contents || contents.isDestroyed?.() || typeof contents.executeJavaScript !== 'function') return
    // DSH owns the Files UI. Locate its accessible control instead of relying
    // on generated client CSS class names.
    const script = `(() => {
      const label = element => [element.getAttribute('aria-label'), element.getAttribute('title'), element.textContent].filter(Boolean).join(' ')
      const button = [...document.querySelectorAll('button,[role="button"]')]
        .find(element => /open sidebar/i.test(label(element)))
      if (button) { button.click(); return true }
      return false
    })()`
    void contents.executeJavaScript(script).catch(() => {})
  }
}
