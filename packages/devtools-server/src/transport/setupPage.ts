import { CONSOLE_KEYS_URL } from '../security/credentials.ts';

/** Local page (loopback only) where the developer pastes their Anthropic API key. */
export function setupPageHtml(state: { configured: boolean; source: string; reason?: string }): string {
  const status = state.configured
    ? `<p class="ok">✓ The in-app agent is ready (credentials: ${escapeHtml(state.source)}).</p>`
    : `<p class="warn">The in-app agent is not configured yet.${state.reason ? ` <span class="dim">${escapeHtml(state.reason)}</span>` : ''}</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Agent DevTools setup</title>
<style>
  :root { --bg:#faf9f5; --card:#fff; --text:#1f1e1c; --muted:#6f6c65; --accent:#d97757; --border:#e6e3dc; --ok:#2f8a50; --warn:#b9851f; }
  @media (prefers-color-scheme: dark) { :root { --bg:#1d1c1a; --card:#272623; --text:#f2f0eb; --muted:#a29f97; --border:#3a3833; --ok:#4caf73; --warn:#d9a441; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  main { max-width: 560px; margin: 48px auto; padding: 0 16px; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:16px; padding:24px; }
  h1 { font-size:22px; margin:0 0 4px; } .dim { color:var(--muted); }
  ol { padding-left: 20px; } li { margin: 10px 0; }
  a.button, button { display:inline-block; border:0; border-radius:10px; padding:10px 16px; font:inherit; font-weight:600; cursor:pointer; text-decoration:none; }
  a.button, button.primary { background:var(--accent); color:#fff; }
  button.secondary { background:transparent; color:var(--muted); border:1px solid var(--border); }
  input { width:100%; padding:10px 12px; border-radius:10px; border:1px solid var(--border); background:var(--bg); color:var(--text); font:14px Menlo, monospace; }
  .row { display:flex; gap:8px; margin-top:10px; } .ok { color:var(--ok); } .warn { color:var(--warn); }
  #msg { min-height: 1.5em; margin-top: 10px; } small { color: var(--muted); }
</style>
</head>
<body>
<main>
  <div class="card">
    <h1>✦ Set up the in-app agent</h1>
    ${status}
    <ol>
      <li>Sign in to the Anthropic Console with your Anthropic account and create an API key.<br />
        <a class="button" href="${CONSOLE_KEYS_URL}" target="_blank" rel="noopener noreferrer">Open Anthropic Console</a><br />
        <small>Organization accounts: use the key your admin or IT team provides. API usage is billed to that Console account.</small></li>
      <li>Paste the key here. It is saved only on this computer (file mode 0600) and is never sent to the app.
        <form id="f" autocomplete="off">
          <input id="key" type="password" placeholder="sk-ant-…" spellcheck="false" />
          <div class="row">
            <button class="primary" type="submit">Save key</button>
            ${state.source === 'stored' ? '<button class="secondary" type="button" id="clear">Remove saved key</button>' : ''}
          </div>
        </form>
        <div id="msg"></div>
      </li>
      <li>Go back to the app. The chat activates automatically.</li>
    </ol>
    <p class="dim"><small>Prefer your Claude Code login instead? Run <code>claude mcp add --transport http rn-agent ${'${location.origin}'}/mcp</code> and drive the app from Claude Code in your terminal.</small></p>
  </div>
</main>
<script>
  const msg = document.getElementById('msg');
  document.querySelectorAll('code').forEach((c) => (c.textContent = c.textContent.replace('\${location.origin}', location.origin)));
  document.getElementById('f').addEventListener('submit', async (e) => {
    e.preventDefault();
    msg.textContent = 'Checking…'; msg.className = 'dim';
    const res = await fetch('/setup/key', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: document.getElementById('key').value }) });
    const body = await res.json().catch(() => ({}));
    document.getElementById('key').value = '';
    msg.textContent = body.ok ? '✓ Saved. The in-app agent is ready.' : '✗ ' + (body.error || 'Could not save the key.');
    msg.className = body.ok ? 'ok' : 'warn';
  });
  const clear = document.getElementById('clear');
  if (clear) clear.addEventListener('click', async () => {
    await fetch('/setup/key', { method: 'DELETE', headers: { 'content-type': 'application/json' } });
    location.reload();
  });
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
