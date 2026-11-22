const registrable = (h) => (h || '').split('.').slice(-2).join('.');
const $ = (id) => document.getElementById(id);

const KIND_LABEL = {
  'window.open': 'popup',
  'synthetic-click': 'fake click',
  'overlay-click': 'overlay',
  'popunder-tab': 'popunder tab',
  overlay: 'overlay',
  'notification-request': 'notify prompt',
  'push-subscribe': 'push spam',
  'background-navigate': 'redirect',
  'youtube-ad': 'yt ad',
  'youtube-nag': 'yt nag',
};

async function currentHost() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const u = new URL(tab.url);
    return /^https?:$/.test(u.protocol) ? u.hostname : '';
  } catch {
    return '';
  }
}

async function render() {
  const s = await chrome.storage.local.get({
    enabled: true,
    strictHosts: [],
    pausedHosts: [],
    log: [],
    totalBlocked: 0,
    ytAdProbe: null,
  });
  const host = await currentHost();

  // A failed fetch cannot distinguish DNS filtering, another extension,
  // browser policy, or a transient connection failure.
  const probe = s.ytAdProbe;
  const probeFresh = !!probe && Date.now() - probe.t < 6 * 3600 * 1000;
  const pausedHere = s.pausedHosts.some((h) => registrable(h) === registrable(host));
  $('notice').hidden = !(s.enabled && !pausedHere && probeFresh && probe.ok === false &&
    /(^|\.)youtube(-nocookie)?\.com$/.test(host));

  document.body.classList.toggle('disabled', !s.enabled);
  $('status').textContent = s.enabled ? 'Protection on' : 'Paused everywhere';
  $('enabled').checked = s.enabled;
  $('count').textContent = s.totalBlocked;

  $('host').textContent = host || 'Not a web page';
  const on = (list) => list.some((h) => registrable(h) === registrable(host));
  $('paused').checked = !!host && on(s.pausedHosts);
  $('strict').checked = !!host && on(s.strictHosts);
  $('paused').disabled = !host;
  $('strict').disabled = !host;

  $('log').replaceChildren();
  if (!s.log.length) {
    const p = document.createElement('div');
    p.className = 'empty';
    p.textContent = 'Nothing blocked yet.';
    $('log').append(p);
  }
  for (const e of s.log.slice(0, 60)) {
    const row = document.createElement('div');
    row.className = 'row';
    const k = document.createElement('span');
    k.className = 'kind';
    k.textContent = KIND_LABEL[e.kind] || e.kind;
    const d = document.createElement('span');
    d.className = 'detail';
    let short = e.detail;
    try {
      short = new URL(e.detail).hostname;
    } catch {
      /* not a URL — show it raw */
    }
    d.textContent = short;
    d.title = `${e.detail}\n${e.why ? e.why + '\n' : ''}on ${e.page}`;
    row.append(k, d);
    $('log').append(row);
  }
}

/** Add or remove the current host from one of the stored host lists. */
async function toggleHostList(key, wanted) {
  const host = await currentHost();
  if (!host) return;
  const store = await chrome.storage.local.get({ [key]: [] });
  const list = store[key];
  const next = wanted
    ? [...new Set([...list, host])]
    : list.filter((h) => registrable(h) !== registrable(host));
  await chrome.storage.local.set({ [key]: next });
}

$('enabled').addEventListener('change', async (e) => {
  await chrome.storage.local.set({ enabled: e.target.checked });
  render();
});

$('paused').addEventListener('change', async (e) => {
  await toggleHostList('pausedHosts', e.target.checked);
  render();
});

$('strict').addEventListener('change', async (e) => {
  await toggleHostList('strictHosts', e.target.checked);
  render();
});

$('clear').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'clearLog' });
  render();
});

chrome.storage.onChanged.addListener(render);
render();
