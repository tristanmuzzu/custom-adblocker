/*
 * background.js — MV3 service worker.
 *
 * Owns three things:
 *   1. Whether the extension's layers are live at all (the on/off switch has to
 *      genuinely turn every layer off, not just this file's tab guard).
 *   2. Registering and unregistering the content scripts, so "off" means "not
 *      injected" rather than "injected but asked to do nothing".
 *   3. The last line of defence: closing tabs and popup windows a page spawns
 *      toward another site that nothing the user did explains, and undoing
 *      a top-frame navigation of the same kind. Page-level shields can be
 *      bypassed; tab creation and navigation cannot be hidden from the
 *      extension API.
 */

const DEFAULTS = {
  enabled: true,
  // Hosts where any cross-site tab spawned by the page is closed on sight,
  // without waiting for the shield's explanation.
  strictHosts: ['aniwaves.ru'],
  // Never close tabs going to these, even in strict mode.
  allowHosts: ['accounts.google.com', 'vk.com', 'youtube.com'],
  // Sites the user has paused the extension on, from the popup.
  pausedHosts: [],
  log: [],
  totalBlocked: 0,
};

const RULESET_ID = 'adnetworks';

/* YouTube gets none of the general-purpose layers.
 *
 * Both of them are trivially visible to a page that looks: page-shield leaves
 * window.open reading as non-native, and overlay-killer's cosmetic CSS hides
 * any element with an ad-shaped class — which is the oldest anti-adblock probe
 * there is (drop an <ins class="adsbygoogle">, see if it vanished). Measured on
 * a live session 2026-09-01: both fired on YouTube, and YouTube was refusing
 * playback while they did.
 *
 * Neither layer earns its keep there anyway. YouTube does not throw popunders
 * or transparent click-catchers; its ads are handled by youtube.js, which
 * changes nothing observable. So on YouTube the extension is, to the page,
 * simply not present. */
const YOUTUBE = [
  '*://www.youtube.com/*',
  '*://m.youtube.com/*',
  '*://music.youtube.com/*',
  '*://www.youtube-nocookie.com/*',
];

const SCRIPTS = [
  {
    id: 'page-shield',
    js: ['src/content/page-shield.js'],
    matches: ['<all_urls>'],
    excludeMatches: YOUTUBE,
    runAt: 'document_start',
    allFrames: true,
    // about:blank and srcdoc frames take the shield too, under their
    // creator's origin: `frames[0].open(...)` on a blank iframe is the one
    // laundering route the contentWindow getter cannot intercept.
    matchOriginAsFallback: true,
    world: 'MAIN',
    persistAcrossSessions: true,
  },
  {
    id: 'bridge',
    js: ['src/content/bridge.js'],
    matches: ['<all_urls>'],
    runAt: 'document_start',
    allFrames: true,
    world: 'ISOLATED',
    persistAcrossSessions: true,
  },
  {
    id: 'youtube',
    js: ['src/content/youtube.js'],
    matches: YOUTUBE,
    runAt: 'document_start',
    allFrames: true,
    world: 'MAIN',
    persistAcrossSessions: true,
  },
  {
    // ISOLATED on purpose: the nag handler needs no page globals, and an
    // observer in the isolated world is invisible to page script.
    //
    // No stylesheet rides along any more. Even an extension's own user-origin
    // sheet is detectable the moment the page tests a bait element against
    // getComputedStyle, so everything this layer hides is now hidden with an
    // inline style on the one real element, at the moment it appears.
    id: 'youtube-nag',
    js: ['src/content/youtube-nag.js'],
    matches: YOUTUBE,
    runAt: 'document_start',
    allFrames: true,
    world: 'ISOLATED',
    persistAcrossSessions: true,
  },
  {
    id: 'overlay-killer',
    js: ['src/content/overlay-killer.js'],
    matches: ['<all_urls>'],
    excludeMatches: YOUTUBE,
    runAt: 'document_end',
    // The player embed is where a streaming site's ad furniture lives.
    allFrames: true,
    world: 'ISOLATED',
    persistAcrossSessions: true,
  },
];

const registrable = (h) => (h || '').split('.').slice(-2).join('.');
const same = (a, b) => registrable(a) === registrable(b);
const hostOf = (url) => {
  try {
    return new URL(url || '').hostname;
  } catch {
    return '';
  }
};

/* Hosts that may always be spawned as a new tab, on top of the stored
 * allowHosts: sign-in providers that arrive by redirect from a same-site
 * "/auth/..." URL, which no page-level announcement can vouch for. */
const ALWAYS_ALLOW = [
  'accounts.google.com',
  'login.microsoftonline.com',
  'appleid.apple.com',
  'github.com',
  'paypal.com',
];

/* Hosts the general-purpose shield is deliberately absent from (see SCRIPTS),
 * so no page there can announce its own legitimate new tabs. */
const UNSHIELDED = ['youtube.com', 'youtube-nocookie.com', 'chromewebstore.google.com'];

/** Host of the tab that spawned each new tab, keyed by tab id. Mirrored to
 * session storage, because a service worker revived by a navigation event
 * starts with an empty Map. */
const openerHost = new Map();
const rememberHello = (tabId, host) => {
  openerHost.set(tabId, host);
  chrome.storage.session?.set({ [`hello:${tabId}`]: host }).catch(() => {});
};
const recallHello = async (tabId) => {
  if (openerHost.has(tabId)) return openerHost.get(tabId);
  try {
    const r = await chrome.storage.session.get(`hello:${tabId}`);
    return r[`hello:${tabId}`] || '';
  } catch {
    return '';
  }
};

/** Hosts each tab has announced it may spawn a tab toward: tabId -> (host -> expiry). */
const expected = new Map();
const expect = (tabId, host, ttl) => {
  const m = expected.get(tabId) || new Map();
  const life = Math.min(60000, Math.max(1000, Number(ttl) || 3000));
  m.set(/^(\*|nav:\*)$/.test(host) ? host : registrable(host), Date.now() + life);
  expected.set(tabId, m);
};
const isExpected = (tabId, host) => {
  const m = expected.get(tabId);
  if (!m) return false;
  const now = Date.now();
  for (const [h, t] of m) if (t < now) m.delete(h);
  return (m.get('*') || 0) > now || (m.get(registrable(host)) || 0) > now;
};

async function state() {
  const s = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...s };
}

/* ------------------------------------------------------------------ *
 * Applying the switch.
 *
 * Off has to mean off at every layer: no network rules, no injected
 * scripts, no tab guard. Anything less is a checkbox that lies.
 * ------------------------------------------------------------------ */
let applying = Promise.resolve();
const applyState = () => (applying = applying.then(applyStateNow, applyStateNow));

async function applyStateNow() {
  const s = await state();

  // Layer 1: network rules.
  try {
    await chrome.declarativeNetRequest.updateEnabledRulesets(
      s.enabled
        ? { enableRulesetIds: [RULESET_ID] }
        : { disableRulesetIds: [RULESET_ID] }
    );
  } catch (e) {
    console.warn('ruleset toggle failed', e);
  }

  // Per-site pause: an allow rule that outranks everything in the static set.
  const pauseRules = s.pausedHosts.map((h, i) => ({
    id: 9000 + i,
    priority: 100,
    action: { type: 'allowAllRequests' },
    condition: { requestDomains: [h], resourceTypes: ['main_frame', 'sub_frame'] },
  }));
  try {
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existing.map((r) => r.id),
      addRules: s.enabled ? pauseRules : [],
    });
  } catch (e) {
    console.warn('dynamic rules failed', e);
  }

  /* Layers 2-4: content scripts. Unregister entirely when off, so a disabled
   * extension costs the page nothing at all.
   *
   * Registration is done one script at a time, and the cleanup goes by known
   * id rather than by whatever getRegisteredContentScripts() admits to. Both
   * of those are scars from 1.5.0: `persistAcrossSessions` scripts are
   * restored by Chrome at profile load, so an upgrade that removes a file
   * leaves a restored entry pointing at something that no longer exists —
   *
   *   script registration failed Error: Could not load css
   *   'src/content/youtube.css' for script.
   *
   * — and because the whole batch was registered in one call, that single
   * stale entry took every other layer down with it. The extension then
   * injected nothing at all while still reporting itself as enabled, which is
   * the worst possible failure: silent, and indistinguishable from working
   * perfectly if you only test whether anything is detectable. */
  const ids = SCRIPTS.map((sc) => sc.id);
  for (const id of ids) {
    try {
      await chrome.scripting.unregisterContentScripts({ ids: [id] });
    } catch {
      /* not registered, or registered-but-broken — either way it is gone now */
    }
  }

  if (s.enabled) {
    const excludeMatches = s.pausedHosts.flatMap((h) => [`*://${h}/*`, `*://*.${h}/*`]);
    // Merge, never replace: several scripts carry their own excludeMatches
    // (YouTube), and overwriting those with the paused-host list would put the
    // general-purpose layers back onto YouTube the moment any site is paused.
    for (const sc of SCRIPTS) {
      const exclude = [...(sc.excludeMatches || []), ...excludeMatches];
      try {
        await chrome.scripting.registerContentScripts([
          exclude.length ? { ...sc, excludeMatches: exclude } : sc,
        ]);
      } catch (e) {
        console.warn(`content script "${sc.id}" failed to register`, e);
      }
    }
  }

  await updateBadge();
}

async function updateBadge() {
  const s = await state();
  if (!s.enabled) {
    await chrome.action.setBadgeText({ text: 'off' });
    await chrome.action.setBadgeBackgroundColor({ color: '#555b66' });
    await chrome.action.setTitle({ title: 'Custom Adblocker — off' });
    return;
  }
  await chrome.action.setBadgeBackgroundColor({ color: '#c62828' });
  await chrome.action.setBadgeText({
    text: s.totalBlocked ? String(Math.min(9999, s.totalBlocked)) : '',
  });
  await chrome.action.setTitle({
    title: `Custom Adblocker — ${s.totalBlocked} blocked`,
  });
}

async function record(kind, detail, page, why = '') {
  const s = await state();
  if (!s.enabled) return;
  const log = [{ t: Date.now(), kind, detail, page, why }, ...s.log].slice(0, 200);
  await chrome.storage.local.set({ log, totalBlocked: s.totalBlocked + 1 });
  await updateBadge();
}

chrome.runtime.onInstalled.addListener(async () => {
  const s = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const missing = {};
  for (const [k, v] of Object.entries(DEFAULTS)) if (s[k] === undefined) missing[k] = v;
  if (Object.keys(missing).length) await chrome.storage.local.set(missing);
  await applyState();
});

chrome.runtime.onStartup.addListener(applyState);

// The popup writes to storage; the switch takes effect from here.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.enabled || changes.pausedHosts) applyState();
});

/* Keyboard shortcut: flip the master switch without opening the popup. */
chrome.commands?.onCommand.addListener(async (cmd) => {
  if (cmd !== 'toggle-enabled') return;
  const s = await state();
  await chrome.storage.local.set({ enabled: !s.enabled });
});

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg) return;
  if (msg.type === 'blocked') {
    record(msg.kind, msg.detail, msg.page, msg.why);
  } else if (msg.type === 'hello' && sender.tab) {
    rememberHello(sender.tab.id, msg.host);
  } else if (msg.type === 'expect' && sender.tab) {
    expect(sender.tab.id, String(msg.host || ''), msg.ttl);
  } else if (msg.type === 'unvouched' && sender.tab) {
    unvouched.set(sender.tab.id, Date.now() + Math.min(10000, Number(msg.ttl) || 3000));
  } else if (msg.type === 'adProbe' && sender.tab) {
    /* The YouTube layer's answer to "can this network reach YouTube's ad
     * servers at all?" — see youtube-nag.js. Kept as one small record for
     * the popup; a failure there is the network's, and the popup says so. */
    chrome.storage.local.set({
      ytAdProbe: { ok: !!msg.ok, why: msg.why || '', host: msg.host || '', t: Date.now() },
    });
  } else if (msg.type === 'clearLog') {
    chrome.storage.local.set({ log: [], totalBlocked: 0 }).then(async () => {
      await updateBadge();
      respond({ ok: true });
    });
    return true;
  }
});

chrome.tabs.onRemoved.addListener((id) => {
  openerHost.delete(id);
  expected.delete(id);
  trusted.delete(id);
  spawned.delete(id);
  firstUrl.delete(id);
  watched.delete(id);
  closing.delete(id);
  unvouched.delete(id);
  chrome.storage.session?.remove(`hello:${id}`).catch(() => {});
});

/* ------------------------------------------------------------------ *
 * New-tab guard.
 *
 * A popunder is: a page created the tab, destination is a
 * different site, and nothing the user did explains it. The page shield
 * announces what would explain it — a trusted gesture on a link to that
 * host, or a window.open it judged to be a real control's — before the
 * browser acts, so by the time the tab exists the answer is usually here
 * already; a short grace covers the message losing that race.
 *
 * Strict hosts skip the explanations: every cross-site tab dies.
 * Browser-created tabs can also carry openerTabId, so that field alone
 * never authorizes closing one. Only onCreatedNavigationTarget establishes
 * that a page spawned a tab or popup window.
 *
 * Only tabs spawned by a page the shield runs on are judged this way (the
 * bridge said hello from the opener's current site). Pages that take no
 * content scripts — chrome://, the Web Store, other extensions — and
 * YouTube, which carries no shield on purpose, may spawn what they like.
 *
 * A same-site first URL is not vouched for, only tolerated: the launder is
 * window.open('/go/x') and a redirect off-site, so a spawned tab is judged
 * again on every URL change for its first seconds. A tab whose first URL
 * was expected is the user's own; whatever chain it enters is theirs.
 * ------------------------------------------------------------------ */
const GRACE_MS = 400;
const WATCH_MS = 15000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Tabs whose first URL was vouched for. */
const trusted = new Set();
/** Page-created tabs: tab id -> { openerTabId, born }. */
const spawned = new Map();
/** The URL each spawned tab was asked to load, before any redirect. */
const firstUrl = new Map();
/** Openers whose shield just let a same-site window through without
 * vouching for it, until when; consumed by the next tab they spawn. */
const unvouched = new Map();
/** Spawned tabs nobody vouched for: never trusted on their first URL. */
const watched = new Set();
/** Tabs already being closed; the judge runs from several events at once. */
const closing = new Set();

const allowed = (s, host) => [...s.allowHosts, ...ALWAYS_ALLOW].some((h) => same(h, host));

async function judgeNewTab(tab) {
  const openerTabId = spawned.get(tab.id)?.openerTabId;
  if (openerTabId === undefined) return;
  const s = await state();
  if (!s.enabled) return;
  if (trusted.has(tab.id) || closing.has(tab.id)) return;

  const url = tab.pendingUrl || tab.url || '';
  if (!/^https?:/i.test(url)) return; // about:blank first; onUpdated will re-judge
  const host = hostOf(url);
  if (!host) return;

  const liveHost = await chrome.tabs
    .get(openerTabId)
    .then((t) => hostOf(t.url))
    .catch(() => '');
  const helloHost = await recallHello(openerTabId);
  const parentHost = liveHost || helloHost;
  if (!parentHost) return;

  if (s.pausedHosts.some((h) => same(h, parentHost))) return;
  const askedFor = (h) => isExpected(openerTabId, h) || isExpected(tab.id, h);
  // A same-site tab the user asked for (a link they pressed, a control's
  // window.open) is theirs wherever it redirects. One nobody asked for is
  // tolerated on the site and judged again if it leaves.
  const own = () => {
    if (watched.has(tab.id)) return false;
    const first = hostOf(firstUrl.get(tab.id) || url);
    return !!first && same(first, parentHost) && askedFor(first);
  };
  if (same(host, parentHost)) {
    if (own()) trusted.add(tab.id);
    return;
  }
  if (allowed(s, host)) return;

  const strict = s.strictHosts.some((h) => same(h, parentHost));
  if (!strict) {
    if (!helloHost || !same(helloHost, parentHost)) return; // no shield there
    if (UNSHIELDED.some((h) => same(h, parentHost))) return;
    const vouched = () => own() || askedFor(host);
    if (!vouched()) await sleep(GRACE_MS);
    if (vouched()) {
      trusted.add(tab.id);
      return;
    }
  }

  // Another event may have trusted or removed the tab while we awaited
  // storage, its opener, or the gesture grace period.
  if (!spawned.has(tab.id) || trusted.has(tab.id) || closing.has(tab.id)) return;
  closing.add(tab.id);
  await chrome.tabs.remove(tab.id).catch(() => {});
  await record('popunder-tab', url, parentHost, strict ? 'strict site' : 'nothing you clicked leads there');
}

// The requested URL of every spawned tab, before the server gets to redirect
// it; tabs.onCreated often sees only about:blank and tabs.onUpdated only the
// landing page. This event covers both tabs and popup windows, including
// targets without openerTabId (for example, noopener links).
chrome.webNavigation.onCreatedNavigationTarget.addListener(async (d) => {
  if (!spawned.has(d.tabId)) {
    spawned.set(d.tabId, { openerTabId: d.sourceTabId, born: Date.now() });
    if ((unvouched.get(d.sourceTabId) || 0) > Date.now()) {
      unvouched.delete(d.sourceTabId);
      watched.add(d.tabId);
    }
  }
  if (!firstUrl.has(d.tabId)) firstUrl.set(d.tabId, d.url);
  // Judge from here as well: a target the network layer blocks never shows
  // an http URL to tabs.onCreated or tabs.onUpdated, only chrome-error://,
  // and would otherwise sit there as an open error tab.
  const t = await chrome.tabs.get(d.tabId).catch(() => null);
  if (!t) return;
  judgeNewTab({ ...t, pendingUrl: t.pendingUrl || d.url });
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  const born = spawned.get(tabId)?.born;
  if (born === undefined || !info.url) return;
  if (Date.now() - born > WATCH_MS) {
    spawned.delete(tabId);
    return;
  }
  judgeNewTab(tab);
});

/* ------------------------------------------------------------------ *
 * Hijack guard: the same judgement, for the tab itself.
 *
 * The other way to sell a click is to send the whole tab away: a page-wide
 * script sets location.href to an ad chain after the user presses play.
 * Measured on ssflix.pro 2026-09-18, three hops to a YouTube video. That
 * setter is unforgeable, so no page-level shield can catch it; what the
 * service worker can see is the commit. A renderer-initiated ("link")
 * navigation off-site that nothing the user did explains — no link toward
 * that host, no control pressed in the top frame just before — is undone by
 * sending the tab back where it was. Typed URLs, bookmarks, reloads and
 * form posts carry their own transition types and are never touched.
 * ------------------------------------------------------------------ */
const lastCommitted = new Map();

chrome.webNavigation.onCommitted.addListener(async (d) => {
  if (d.frameId !== 0) return;
  const from = lastCommitted.get(d.tabId) || '';
  lastCommitted.set(d.tabId, d.url);
  if (d.transitionType !== 'link') return;
  if (!/^https?:/i.test(from) || !/^https?:/i.test(d.url)) return;
  const fromHost = hostOf(from);
  const toHost = hostOf(d.url);
  if (!fromHost || !toHost || same(fromHost, toHost)) return;
  // Decide from what was announced before the navigation, not after: the
  // page that just arrived is already sending its own hello.
  const explained =
    isExpected(d.tabId, toHost) || isExpected(d.tabId, '*') || isExpected(d.tabId, 'nav:*');
  const s = await state();
  if (!s.enabled) return;
  if (s.pausedHosts.some((h) => same(h, fromHost))) return;
  if (UNSHIELDED.some((h) => same(h, fromHost))) return;
  if (allowed(s, toHost)) return;
  if (explained) return;

  lastCommitted.set(d.tabId, from);
  await chrome.tabs.update(d.tabId, { url: from }).catch(() => {});
  await record('hijack', d.url, fromHost, 'the page sent itself to another site; brought back');
});

// Cover the case where the worker was evicted and revived by an event.
applyState();
