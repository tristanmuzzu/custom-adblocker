/*
 * bridge.js — ISOLATED world. The MAIN-world shield has no chrome.* access,
 * so it dispatches a DOM event here and this forwards to the service worker.
 *
 * The event's detail is a JSON string, not an object: an object built in the
 * MAIN world is not readable from the ISOLATED one, a string is.
 */
(() => {
  'use strict';

  document.addEventListener('__customAdblock', (e) => {
    let d = null;
    try {
      d = JSON.parse(e.detail);
    } catch {
      return;
    }
    if (!d || typeof d !== 'object') return;
    let msg = null;
    if (d.type === 'blocked') {
      msg = { type: 'blocked', kind: d.kind, detail: d.detail, why: d.why, page: location.href };
    } else if (d.type === 'expect') {
      msg = { type: 'expect', host: d.host, ttl: d.ttl };
    } else if (d.type === 'unvouched') {
      msg = { type: 'unvouched', ttl: d.ttl };
    }
    if (!msg) return;
    try {
      chrome.runtime.sendMessage(msg);
    } catch {
      /* service worker asleep / extension reloading */
    }
  });

  // Tell the service worker which top-level host this tab is on, so its
  // new-tab guard knows what counts as "same site" and that the shield runs
  // here.
  if (window.top === window) {
    try {
      chrome.runtime.sendMessage({ type: 'hello', host: location.hostname });
    } catch {
      /* ignore */
    }
  }
})();
