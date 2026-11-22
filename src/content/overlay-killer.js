/*
 * overlay-killer.js — ISOLATED world, every frame, document_end.
 *
 * This is the procedural-cosmetic layer: it matches by geometry and behaviour
 * rather than by URL or selector, which is what you need when the site
 * generates a fresh random class name on every page load.
 *
 * Every frame, because the ad furniture that matters on a streaming site is
 * injected into the player embed, two iframes down, not into the page.
 */
(() => {
  'use strict';

  const STATIC_CSS = `
    /* Generic ad furniture — cheap wins, no JS cost. */
    ins.adsbygoogle,
    iframe[src*="doubleclick"],
    iframe[src*="googlesyndication"],
    iframe[id^="aswift_"],
    div[id^="google_ads_"],
    [class*="banner-ad"], [class*="ad-banner"],
    [id^="ad-container"], [id^="adunit"],
    [data-ad-slot], [data-adblockkey],
    a[href*="//propu."], a[href*="//rtmark."], a[href*="//monetag."] {
      display: none !important;
    }
    /* Anti-adblock overlays love locking the scroll. */
    html.__cab-unlock, body.__cab-unlock {
      overflow: auto !important;
      position: static !important;
    }
  `;

  const style = document.createElement('style');
  style.textContent = STATIC_CSS;
  (document.head || document.documentElement).appendChild(style);

  const registrable = (h) => h.split('.').slice(-2).join('.');
  const SITE = registrable(location.hostname);

  const vw = () => window.innerWidth;
  const vh = () => window.innerHeight;

  /** An element is a suspect overlay if it is big, floating, on top, and empty. */
  const isSuspectOverlay = (el) => {
    if (!(el instanceof HTMLElement)) return false;
    if (el === document.body || el === document.documentElement) return false;
    // Embedded content is content, whatever its geometry: an iframe has no
    // descendants in this document to count, and a full-size fixed one is
    // exactly how a player embed is mounted (moviesapi.to, 2026-09-18).
    if (el.matches('iframe, video, canvas, img, object, embed')) return false;
    if (el.closest('video, .player, #player, dialog, [role="dialog"], [aria-modal="true"]')) return false;
    // A legitimate modal's backdrop is intentionally large and empty.
    if ([...document.querySelectorAll('dialog[open], [aria-modal="true"]')]
      .some(d => d.getBoundingClientRect().width > 0)) return false;

    let cs;
    try {
      cs = getComputedStyle(el);
    } catch {
      return false;
    }
    if (cs.position !== 'fixed' && cs.position !== 'absolute') return false;
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.pointerEvents === 'none') return false;

    const z = parseInt(cs.zIndex, 10);
    // z-index:auto is ordinary page layout, not evidence of an overlay.
    // Player apps can insert an empty positioned root before mounting their
    // controls; hiding it here makes the later player invisible too.
    if (Number.isNaN(z) || z < 100) return false;

    const area = vw() * vh();
    if (!area) return false; // a hidden or collapsed frame: nothing to cover
    const r = el.getBoundingClientRect();
    const coverage = (r.width * r.height) / area;
    if (!(coverage >= 0.25)) return false;

    // An iframe is content: a lightbox player, or the player embed's own
    // wrapper (measured 2026-09-18: moviesapi.to mounts its player iframe in
    // a positioned full-size div, and killing that div is killing the film).
    // Ad iframes are judged by isAdDialog, on their own signature.
    const hasRealContent =
      el.querySelector('video, canvas, img, svg, iframe, input, textarea, button, form, a[href]') ||
      el.textContent.trim().length > 40 ||
      // A poster or backdrop painted as a background image is content too;
      // a click-catcher is transparent by definition.
      (cs.backgroundImage && cs.backgroundImage !== 'none');
    if (hasRealContent) return false;

    // An empty element that big, floating over everything, is a click-catcher.
    return true;
  };

  /* An ad SDK's dialog: measured on the ssflix.pro player embed 2026-09-18
   * ("Please prove you are human" with an OK that is the ad click, and a
   * native-ad card of the same build). The creative lives in a sandboxed
   * srcdoc iframe, inside a position:fixed container at the maximum z-index,
   * appended to <html> rather than <body>. A page's own lightbox player is a
   * fixed container with an iframe too, so the srcdoc + allow-popups sandbox
   * is what this keys on: a document authored inline, sandboxed, and allowed
   * to open windows, floating over everything, is an ad's shape and nothing
   * else's. */
  const AD_FRAME = 'iframe[srcdoc][sandbox~="allow-popups"]';
  const isAdDialog = (el) => {
    if (!(el instanceof HTMLElement)) return false;
    if (el === document.body || el === document.documentElement) return false;
    let cs;
    try {
      cs = getComputedStyle(el);
    } catch {
      return false;
    }
    if (cs.position !== 'fixed' && cs.position !== 'absolute') return false;
    const z = parseInt(cs.zIndex, 10);
    if (Number.isNaN(z) || z < 100000) return false;
    if (el.querySelector('video')) return false;
    return !!el.querySelector(AD_FRAME);
  };

  /** The floating container an injected node belongs to, if any. */
  const floatingAncestor = (node) => {
    let n = node instanceof HTMLElement ? node : node.parentElement;
    while (n && n !== document.body && n !== document.documentElement) {
      if (isAdDialog(n)) return n;
      n = n.parentElement;
    }
    return null;
  };

  let killed = 0;
  const kill = (el, why) => {
    killed += 1;
    const r = el.getBoundingClientRect();
    const name = `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${
      typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''
    }`;
    // Hide, never remove. The player embeds these land in are React apps,
    // and React throws on finding a node it owns gone from the DOM, which
    // takes the whole player down with the overlay (measured 2026-09-18 on
    // moviesapi.to: an empty root, no film). A hidden node is inert to the
    // user and invisible to the framework's bookkeeping.
    el.style.setProperty('display', 'none', 'important');
    el.style.setProperty('pointer-events', 'none', 'important');
    try {
      chrome.runtime.sendMessage({
        type: 'blocked',
        kind: 'overlay',
        detail: `${why} <${name}> ${Math.round(r.width)}x${Math.round(r.height)}`,
        page: location.href,
      });
    } catch {
      /* ignore */
    }
  };

  const sweep = () => {
    const killedBefore = killed;
    // Pass 1: anything obviously a full-page click-catcher.
    for (const el of document.querySelectorAll('body > *, body > * > *')) {
      if (isSuspectOverlay(el)) kill(el, 'full-page overlay');
    }
    // Pass 1b: ad dialogs, wherever they hang — including off <html>.
    for (const f of document.querySelectorAll(AD_FRAME)) {
      const box = floatingAncestor(f);
      if (box) kill(box, 'ad dialog');
    }

    // Pass 2: what is actually on top at the centre of the viewport?
    const stack = document.elementsFromPoint(vw() / 2, vh() / 2);
    for (const el of stack.slice(0, 3)) {
      if (el instanceof HTMLAnchorElement) {
        let host = '';
        try {
          host = new URL(el.href, location.href).hostname;
        } catch {
          /* ignore */
        }
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        const empty = !el.textContent.trim() && !el.querySelector('img,svg,video,canvas');
        const transparent = Number(cs.opacity) < 0.05 || cs.backgroundColor === 'rgba(0, 0, 0, 0)' || cs.backgroundColor === 'transparent';
        if (host && registrable(host) !== SITE && empty && transparent &&
            ['fixed','absolute'].includes(cs.position) && r.width * r.height >= 40000)
          kill(el, 'transparent anchor over content');
      }
    }

    // Pass 3: scroll locks left behind by removed modals.
    if (killed > killedBefore && getComputedStyle(document.body).overflow === 'hidden' &&
        !document.querySelector('dialog[open], [aria-modal="true"]')) {
      document.documentElement.classList.add('__cab-unlock');
      document.body.classList.add('__cab-unlock');
    }
  };

  sweep();

  const observer = new MutationObserver((records) => {
    for (const r of records) {
      for (const node of r.addedNodes) {
        if (isSuspectOverlay(node)) kill(node, 'injected overlay');
        else if (isAdDialog(node)) kill(node, 'ad dialog');
        else if (node instanceof HTMLElement && (node.matches(AD_FRAME) || node.querySelector(AD_FRAME))) {
          // The frame arrived after its container did.
          const box = floatingAncestor(node);
          if (box) kill(box, 'ad dialog');
        }
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Cheap periodic re-check: overlays are often (re)styled after insertion,
  // so a mutation-time geometry test alone misses them.
  const interval = setInterval(sweep, 2000);
  setTimeout(() => clearInterval(interval), 60000);

  window.addEventListener('beforeunload', () => observer.disconnect());
})();
