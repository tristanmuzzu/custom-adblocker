/*
 * page-shield.js — runs in the MAIN world at document_start, in every frame.
 *
 * This is the scriptlet layer. It executes before any page script, so the page
 * only ever sees our versions of the APIs a popunder needs. Everything here is
 * about intent, not about domain names, so it keeps working when the ad network
 * rotates hosts.
 */
(() => {
  'use strict';

  /* Re-entry guard. A named property — even a non-enumerable one — is listed
   * by Object.getOwnPropertyNames(window), which is a one-line adblocker
   * probe. A symbol key is not: it takes getOwnPropertySymbols to find, and
   * nothing walks that. */
  const GUARD = Symbol.for('cab.shield');
  if (window[GUARD]) return;
  Object.defineProperty(window, GUARD, {
    value: true,
    configurable: false,
    enumerable: false,
  });

  const TOP_HOST = (() => {
    try {
      return new URL(document.baseURI).hostname;
    } catch {
      return location.hostname;
    }
  })();

  /* ------------------------------------------------------------------ *
   * Talking to the service worker.
   *
   * The MAIN world has no chrome.*; bridge.js (ISOLATED world) listens for
   * this event and forwards. A DOM event, not postMessage, because dispatch
   * is synchronous: an "expect" sent just before window.open() reaches the
   * bridge before the tab it describes exists, which is the order the
   * service worker's tab guard needs.
   * ------------------------------------------------------------------ */
  const send = (payload) => {
    try {
      document.dispatchEvent(
        new CustomEvent('__customAdblock', { detail: JSON.stringify(payload) })
      );
    } catch {
      /* frame is being torn down */
    }
  };

  /** Report a block, for the popup's log. */
  const report = (kind, detail, why) =>
    send({ type: 'blocked', kind, detail: String(detail).slice(0, 300), why: why || '' });

  /** Tell the tab guard this page may legitimately spawn a tab toward `host`. */
  const expect = (host, ttl) => send({ type: 'expect', host, ttl });
  /** Tell it a window is about to open that nobody asked for. */
  const unvouched = () => send({ type: 'unvouched', ttl: 3000 });

  const registrable = (host) => host.split('.').slice(-2).join('.');
  const hostOf = (url) => {
    try {
      return new URL(url, location.href).hostname;
    } catch {
      return '';
    }
  };
  const isThirdParty = (url) => {
    const h = hostOf(url);
    return !!h && registrable(h) !== registrable(TOP_HOST);
  };

  /* ------------------------------------------------------------------ *
   * 0. What the user actually did.
   *
   * A trusted gesture on a link is the one thing that legitimately spawns a
   * cross-site tab without going through window.open, so every such gesture
   * is announced to the tab guard before the browser acts on it. pointerdown
   * runs before the click's default action; contextmenu gets a long lease
   * because "Open link in new tab" comes seconds later.
   * ------------------------------------------------------------------ */
  const INTERACTIVE =
    'a[href], button, input, select, textarea, summary, label, ' +
    '[role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="option"]';

  /** Host of the link under the most recent trusted gesture, and when. */
  let lastLink = { host: '', t: 0 };

  const noteGesture = (e, ttl) => {
    if (!e.isTrusted) return;
    const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    const host = hostOf(a.href);
    if (!host) return;
    lastLink = { host, t: Date.now() };
    expect(host, ttl);
  };
  for (const type of ['pointerdown', 'mousedown', 'click', 'auxclick']) {
    window.addEventListener(type, (e) => noteGesture(e, 3000), true);
  }
  window.addEventListener('contextmenu', (e) => noteGesture(e, 30000), true);
  // A control pressed in the top frame may send the tab wherever it likes
  // for a moment: checkout, SSO, "continue to partner". A press inside a
  // frame (the player) does not vouch for the top frame's whereabouts.
  window.addEventListener(
    'click',
    (e) => {
      if (!e.isTrusted || window.top !== window) return;
      const t = e.target;
      if (t && t.closest && t.closest(INTERACTIVE)) expect('nav:*', 3000);
    },
    true
  );
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Enter' || e.key === ' ') noteGesture(e, 3000);
    },
    true
  );

  /* ------------------------------------------------------------------ *
   * 1. window.open — the primary popunder verb.
   *
   * A user gesture is not consent. Every popunder fires inside one, because
   * Chromium's own popup blocker demands it; the loader measured on
   * ssflix.pro (2026-09-18) listens for mousedown on the whole window and
   * opens its ad from there, once an hour, so it is indistinguishable from a
   * real click by activation alone. What separates it from a sign-in or
   * share popup is *how* the call arrives:
   *
   *   - a real popup is opened synchronously from a click-type event, by a
   *     listener bound to the control (or the app root React delegates to),
   *     on something that is a control;
   *   - a popunder is opened from mousedown/mouseup/pointer events, from a
   *     listener on window/document/body that catches every click on the
   *     page, from a timer after the gesture, or from a click on the video.
   *
   * Same-site targets pass (a same-site popup is the page's own business —
   * the service worker still closes it if it redirects off-site), and so does
   * the host of the link the user just pressed.
   *
   * Returning null breaks pages that immediately touch the result
   * (`w.document.write(...)`), and a thrown TypeError can abort the click
   * handler that was also going to start the video. So we hand back an inert
   * stub that absorbs every common call.
   * ------------------------------------------------------------------ */
  const makeStubWindow = () => {
    const noop = () => {};
    const stubDoc = {
      write: noop,
      writeln: noop,
      open: noop,
      close: noop,
      body: null,
      documentElement: null,
      createElement: () => ({ style: {}, setAttribute: noop, appendChild: noop }),
    };
    const stub = {
      closed: true,
      opener: null,
      name: '',
      document: stubDoc,
      focus: noop,
      blur: noop,
      close: noop,
      moveTo: noop,
      moveBy: noop,
      resizeTo: noop,
      resizeBy: noop,
      scrollTo: noop,
      print: noop,
      postMessage: noop,
      addEventListener: noop,
      removeEventListener: noop,
      location: {
        href: 'about:blank',
        assign: noop,
        replace: noop,
        reload: noop,
        toString: () => 'about:blank',
      },
    };
    return stub;
  };

  const CLICK_EVENTS = new Set(['click', 'auxclick', 'keydown', 'keyup']);

  /** Is the current call happening inside a click-type event, on a control? */
  const fromControlClick = () => {
    const e = window.event;
    if (!e || !e.isTrusted || !CLICK_EVENTS.has(e.type)) return false;
    const on = e.currentTarget;
    // A listener on window/document/<html>/<body> sees every click on the
    // page; that is a popunder's vantage point, not a button's.
    if (!on || on === window || on === document) return false;
    if (on === document.documentElement || on === document.body) return false;
    const t = e.target;
    return !!(t && t.closest && t.closest(INTERACTIVE));
  };

  /**
   * Judge one open(): `why` is the reason it is a popunder ('' = allowed);
   * `vouch` says whether the user asked for it, in which case the tab guard
   * is told to expect it. A same-site window from a non-control gesture is
   * tolerated but not vouched for, because "/go/x" then a redirect off-site
   * is how popunders launder their URL; the tab guard judges where it lands.
   */
  const judgeOpen = (url, win) => {
    if (!(win.navigator?.userActivation?.isActive)) return { why: 'no user gesture' };
    const dest = /^about:blank$/i.test(url) ? '' : url;
    const host = dest ? hostOf(dest) : '';
    const asked =
      (host && lastLink.host === host && Date.now() - lastLink.t < 3000) || fromControlClick();
    if (asked) return { why: '', vouch: host || '*' };
    if (dest && !isThirdParty(dest)) return { why: '' };
    const e = window.event;
    if (!e) return { why: 'opened after the gesture, not from it' };
    if (!CLICK_EVENTS.has(e.type)) return { why: `opened from ${e.type}, not from a click` };
    return { why: 'opened by a page-wide listener, not a control' };
  };

  /** Judge, and tell the tab guard what to expect. Returns '' if allowed. */
  const permit = (url, win) => {
    const { why, vouch } = judgeOpen(url, win || window);
    if (why) return why;
    // The tab appears within milliseconds; a long lease would vouch for the
    // next popunder toward the same host.
    if (vouch) expect(vouch, 3000);
    else unvouched();
    return '';
  };

  const shieldWindowOpen = (win) => {
    try {
      const original = win.open;
      const guarded = function open(url, target, features) {
        // Same-tab navigation is not a popup. Chromium still applies its
        // normal policy to everything that passes; strict sites keep the
        // separate service-worker tab guard as well.
        if (/^_(self|top|parent)$/i.test(target || '')) {
          return Reflect.apply(original, win, arguments);
        }
        const href = String(url || '');
        const why = permit(href, win);
        if (!why) return Reflect.apply(original, win, arguments);
        report('window.open', href || '(no url)', why);
        return makeStubWindow();
      };
      // Keep toString() looking native so naive anti-adblock checks pass.
      guarded.toString = () => (original ? Function.prototype.toString.call(original) : 'function open() { [native code] }');
      Object.defineProperty(win, 'open', {
        value: guarded,
        writable: false,
        configurable: false,
      });
    } catch {
      /* cross-origin frame, nothing we can do from here */
    }
  };

  shieldWindowOpen(window);

  /* ------------------------------------------------------------------ *
   * 2. Same-origin iframe laundering.
   *
   * The classic bypass is: create an <iframe>, then call
   * `iframe.contentWindow.open(...)` — a pristine window.open that never saw
   * our patch, because content scripts do not reliably run in about:blank
   * frames. Patch the getter so every handed-out contentWindow is shielded.
   * ------------------------------------------------------------------ */
  try {
    const proto = HTMLIFrameElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'contentWindow');
    if (desc && desc.get) {
      Object.defineProperty(proto, 'contentWindow', {
        configurable: true,
        enumerable: desc.enumerable,
        get() {
          const win = desc.get.call(this);
          // Even READING a property on a cross-origin window throws a
          // SecurityError, so the whole probe lives inside the try.
          try {
            if (win && !win[GUARD]) {
              Object.defineProperty(win, GUARD, { value: true });
              shieldWindowOpen(win);
            }
          } catch {
            /* cross-origin frame — its own content-script injection covers it */
          }
          return win;
        },
      });
    }
  } catch {
    /* ignore */
  }

  /* ------------------------------------------------------------------ *
   * 3. Synthetic clicks.
   *
   * `a.click()` and `dispatchEvent(new MouseEvent('click'))` both produce an
   * event whose `isTrusted` is false. A human click is always true, and the
   * page cannot forge it. A synthetic click on a cross-site or
   * target="_blank" anchor is judged exactly like window.open: fine from a
   * control's own click handler, a popunder from anywhere else.
   *
   * Two routes. An anchor in the document dispatches through window, where
   * the capture listener sees it. An anchor that was never attached — the
   * player embed's route, measured 2026-09-18 — dispatches to itself alone,
   * so the prototype method is the only place to stand.
   *
   * Carve-outs: blob:/data: and same-origin downloads use exactly this
   * pattern legitimately, so those pass through.
   * ------------------------------------------------------------------ */
  const looksLikeDownload = (a) =>
    a.hasAttribute('download') ||
    /^(blob|data|filesystem):/i.test(a.getAttribute('href') || '');

  /** Why a synthetic click on this anchor is a popunder, or '' if not. */
  const judgeSyntheticClick = (a) => {
    if (looksLikeDownload(a)) return '';
    const opensNewContext = /^_(blank|new)$/i.test(a.target || '');
    if (!opensNewContext && !isThirdParty(a.href)) return '';
    return permit(a.href, window);
  };

  window.addEventListener(
    'click',
    (e) => {
      if (e.isTrusted) return;
      const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a) return;
      const why = judgeSyntheticClick(a);
      if (!why) return;
      report('synthetic-click', a.href, why);
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    true
  );

  try {
    const proto = HTMLElement.prototype;
    const original = proto.click;
    const guarded = function click() {
      if (this instanceof HTMLAnchorElement && this.hasAttribute('href')) {
        const why = judgeSyntheticClick(this);
        if (why) {
          report('synthetic-click', this.href, why);
          return;
        }
      }
      return Reflect.apply(original, this, arguments);
    };
    guarded.toString = () => Function.prototype.toString.call(original);
    Object.defineProperty(proto, 'click', { value: guarded, writable: true, configurable: true });
  } catch {
    /* ignore */
  }

  /* A form with target="_blank" submitted from script is the same thing with
   * a POST. A real submit button's click never comes through here. */
  try {
    const proto = HTMLFormElement.prototype;
    for (const name of ['submit', 'requestSubmit']) {
      const original = proto[name];
      if (typeof original !== 'function') continue;
      const guarded = function () {
        const opensNewContext = /^_(blank|new)$/i.test(this.target || '');
        const action = this.getAttribute('action') || location.href;
        if (opensNewContext || isThirdParty(action)) {
          const why = permit(action, window);
          if (why) {
            report('synthetic-submit', action, why);
            return;
          }
        }
        return Reflect.apply(original, this, arguments);
      };
      Object.defineProperty(guarded, 'name', { value: name });
      guarded.toString = () => Function.prototype.toString.call(original);
      Object.defineProperty(proto, name, { value: guarded, writable: true, configurable: true });
    }
  } catch {
    /* ignore */
  }

  /* ------------------------------------------------------------------ *
   * 4. Overlay click-catchers.
   *
   * The other half of the pattern needs no JS at all: a transparent anchor
   * stretched over the player. The first *real* click hits the ad, the site
   * removes it, the second click plays the video. Detect on the trusted click
   * path: if the clicked anchor is effectively invisible but huge, eat the
   * click and forward it to whatever sits underneath.
   * ------------------------------------------------------------------ */
  const isInvisibleOverlay = (el) => {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'absolute') return false;
    const r = el.getBoundingClientRect();
    if (r.width * r.height < 40000) return false; // smaller than ~200x200
    const transparent =
      parseFloat(cs.opacity) < 0.05 ||
      cs.backgroundColor === 'rgba(0, 0, 0, 0)' ||
      cs.backgroundColor === 'transparent';
    const empty = el.textContent.trim().length === 0 && !el.querySelector('img,svg,video');
    return transparent && empty;
  };

  window.addEventListener(
    'click',
    (e) => {
      if (!e.isTrusted) return;
      const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a || !isThirdParty(a.href)) return;
      let overlay = null;
      try {
        overlay = isInvisibleOverlay(a) ? a : null;
      } catch {
        return;
      }
      if (!overlay) return;
      report('overlay-click', a.href);
      e.preventDefault();
      e.stopImmediatePropagation();
      overlay.remove();
      // Replay the click on whatever the overlay was covering.
      const under = document.elementFromPoint(e.clientX, e.clientY);
      if (under && under !== overlay) under.click();
    },
    true
  );

  /* ------------------------------------------------------------------ *
   * 5. Assorted nuisance APIs.
   * ------------------------------------------------------------------ */

  // Auto-deny notification prompts instead of showing them.
  try {
    if (window.Notification) {
      Object.defineProperty(Notification, 'requestPermission', {
        value: () => {
          report('notification-request', location.href);
          return Promise.resolve('denied');
        },
        configurable: false,
      });
    }
  } catch {
    /* ignore */
  }

  // Push subscriptions are how ad networks keep spamming after you close the tab.
  try {
    if (window.PushManager) {
      PushManager.prototype.subscribe = function () {
        report('push-subscribe', location.href);
        return Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
      };
    }
  } catch {
    /* ignore */
  }

  // `self.blur()` / `opener.focus()` is what pushes the ad tab *under* the page.
  for (const method of ['blur', 'moveTo', 'moveBy', 'resizeTo', 'resizeBy']) {
    try {
      Object.defineProperty(window, method, { value: () => {}, configurable: false });
    } catch {
      /* ignore */
    }
  }

  // Some players stash a popunder behind a fake fullscreen request.
  try {
    const origAssign = Location.prototype.assign;
    Location.prototype.assign = function (url) {
      if (isThirdParty(url) && !document.hasFocus()) {
        report('background-navigate', url);
        return;
      }
      return origAssign.call(this, url);
    };
  } catch {
    /* ignore */
  }
})();
