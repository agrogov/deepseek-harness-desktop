export const FILE_BROWSER_HTML = String.raw`<!doctype html>
<meta charset="utf-8">
<style>
  :root { color-scheme: dark; }
  body { margin: 0; color: #ececef; background: #18181b; font: 14px -apple-system, BlinkMacSystemFont, sans-serif; }
  header { height: 44px; display: flex; align-items: center; gap: 8px; padding: 0 12px; border-bottom: 1px solid #38383d; background: #27272a; box-sizing: border-box; }
  button { border: 0; border-radius: 7px; padding: 6px 9px; background: #414147; color: #f1f1f2; cursor: pointer; font: inherit; }
  button:hover { background: #55555d; }
  input { flex: 1; min-width: 0; border: 1px solid #55555d; border-radius: 7px; padding: 6px 9px; color: inherit; background: #1c1c1f; font: inherit; }
  #status { color: #a4a4ad; padding: 10px 14px 4px; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #list { padding: 0 8px 12px; overflow: auto; height: calc(100vh - 72px); box-sizing: border-box; }
  .entry { display: flex; align-items: center; width: 100%; gap: 9px; padding: 7px 8px; border-radius: 7px; box-sizing: border-box; background: transparent; color: inherit; text-align: left; }
  .entry:hover { background: #303036; }
  .icon { width: 18px; text-align: center; color: #8ab4f8; flex: none; }
  .file .icon { color: #b5b5bd; }
  #empty { padding: 24px 14px; color: #a4a4ad; }
</style>
<header>
  <button id="up" title="Parent folder">↑</button>
  <button id="home" title="Home folder">⌂</button>
  <input id="path" aria-label="Folder path">
</header>
<div id="status"></div>
<div id="list"></div>
<script>
  const fs = require('node:fs')
  const path = require('node:path')
  const { shell } = require('electron')
  const pathInput = document.getElementById('path')
  const status = document.getElementById('status')
  const list = document.getElementById('list')
  let current = process.env.HOME || process.cwd()

  const escapeHtml = value => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
  const render = () => {
    pathInput.value = current
    status.textContent = current
    try {
      const entries = fs.readdirSync(current, { withFileTypes: true })
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      list.innerHTML = entries.length ? entries.map(entry => {
        const target = path.join(current, entry.name)
        const directory = entry.isDirectory()
        return '<button class="entry ' + (directory ? 'folder' : 'file') + '" data-path="' + encodeURIComponent(target) + '">' +
          '<span class="icon">' + (directory ? '▰' : '▱') + '</span><span>' + escapeHtml(entry.name) + '</span></button>'
      }).join('') : '<div id="empty">This folder is empty.</div>'
      for (const button of list.querySelectorAll('[data-path]')) button.onclick = () => navigate(decodeURIComponent(button.dataset.path))
    } catch (error) {
      list.innerHTML = '<div id="empty">Unable to open this folder: ' + escapeHtml(String(error.message || error)) + '</div>'
    }
  }
  const navigate = target => {
    const next = path.resolve(target)
    try {
      if (fs.statSync(next).isDirectory()) { current = next; render() }
      else void shell.openPath(next)
    } catch (error) { status.textContent = String(error.message || error) }
  }
  window.__dshFileNavigate = navigate
  window.__dshFileParent = () => navigate(path.dirname(current))
  document.getElementById('up').onclick = window.__dshFileParent
  document.getElementById('home').onclick = () => navigate(process.env.HOME || process.cwd())
  pathInput.onkeydown = event => { if (event.key === 'Enter') navigate(pathInput.value) }
  render()
</script>`
