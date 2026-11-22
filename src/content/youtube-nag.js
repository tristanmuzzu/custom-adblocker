/*
 * youtube-nag.js — ISOLATED world, document_start, youtube.com only.
 *
 * Handles the "Ad blockers are not allowed on YouTube" dialog, and the
 * doctrine here reversed on evidence in 1.5.0.
 *
 * The old version deleted the renderer from the JSON so the dialog was never
 * built, and refused to click YouTube's dismiss button on the grounds that
 * dismissing reports the dismissal. That reasoning was backwards. YouTube
 * knows it sent the message; what it watches for is the gap where a response
 * should have been and wasn't — the same gap that deleting the ad schedule
 * leaves. A message shown and dismissed is a client behaving normally.
 *
 * So now: let the dialog arrive, hide it with an inline style the instant it
 * is inserted (before it can paint), click YouTube's own dismiss button so the
 * dismissal is reported, and clean up whatever is left. The user sees nothing;
 * YouTube sees a viewer who read the notice and closed it.
 *
 * Nothing here uses a stylesheet. A rule that hides ad-shaped things can be
 * found by dropping a bait element and reading getComputedStyle — an inline
 * style on the one real dialog cannot.
 *
 * Since 1.8.0 this layer is the last resort, not the first: youtube.js
 * recovers a dead player in place (see recoverPlayback there), and the page
 * reload below waits ERROR_GRACE_MS for that to work first. The enforced flag
 * it writes no longer changes the mode; it is a diagnostic.
 *
 * ISOLATED because nothing here needs page globals, and an observer in the
 * isolated world is invisible to page script: no listener to enumerate, no
 * function to fingerprint. The price is that page-defined APIs are out of
 * reach, so resuming playback goes through the <video> element's own native
 * play(), which is not.
 */
(() => {
  'use strict';

  if (!/(^|\.)youtube(-nocookie)?\.com$/.test(location.hostname)) return;

  // Bisecting switch, same as youtube.js: sessionStorage['cab.yt.layer'] set
  // to 'off' or 'hooks' takes this layer out without an extension reload.
  // Session-scoped on purpose — see youtube.js for the day it was not.
  try {
    const layer = sessionStorage.getItem('cab.yt.layer');
    if (layer === 'off' || layer === 'hooks') return;
  } catch {
    /* storage blocked */
  }

  /* The renderer's tag name has changed at every enforcement wave, so match
   * the stable part of the name rather than one exact element. */
  const NAG = [
    'ytd-enforcement-message-view-model',
    '[class*="enforcement-message"]',
    '[id*="enforcement-message"]',
  ].join(',');

  /* Where YouTube hangs it: a modal dialog over the page, or the player's own
   * error screen. */
  const HOST = 'tp-yt-paper-dialog, ytd-popup-container > *, #error-screen';

  /* Seeing this dialog at all means the current mode has been noticed. Record
   * it for the tab. Until 1.8.0 youtube.js read this to degrade to stealth on
   * the next load; stealth was then nagged in the field too, so the flag is
   * now a diagnostic (the live suite and the popup log read it), not a mode
   * switch.
   *
   * Written on the first real nag and never cleared: one enforcement is enough
   * to know, and the flag dies with the tab anyway. */
  const markEnforced = () => {
    try {
      sessionStorage.setItem('cab.yt.enforced', '1');
    } catch {
      /* storage blocked */
    }
  };

  /* ------------------------------------------------------------------ *
   * The other face of enforcement: no dialog, just a dead player.
   *
   * Reported from the field 2026-09-03, with the zero-ad `prune` mode on:
   *
   *   Something went wrong. Please try again later.
   *   282054944
   *
   * No nag, no explanation, nothing to dismiss — so the dialog handler above
   * never fired and the degrade never happened. The player simply does not
   * play, which from the sofa is worse than any ad.
   *
   * Unlike the dialog, this cannot be left for the *next* load: the current
   * page is already broken and the viewer is looking at it. youtube.js gets
   * the first ERROR_GRACE_MS to recover it in place; if the error is still
   * there after that, this one reloads the page, once.
   *
   * Hard-capped at two reloads per tab. If the third would be needed then
   * reloading is not the answer and a viewer staring at an error is at least
   * a truthful state, rather than a page that refreshes itself forever.
   *
   * 282054944 is not unique to enforcement — the same code appears when an
   * unattested playback session is cut — so the text is matched too, and the
   * only cost of a false positive is one reload into a mode that still hides
   * every ad.
   * ------------------------------------------------------------------ */
  const ERROR_TEXT = /something went wrong|282054944/i;
  const RELOAD_CAP = 2;
  const ERROR_GRACE_MS = 12000;
  let errorSince = 0;
  let errorLastCheck = 0;

  const reloads = () => {
    try {
      return Number(sessionStorage.getItem('cab.yt.reloads') || '0');
    } catch {
      return RELOAD_CAP; // storage blocked: never reload
    }
  };

  const handlePlaybackError = () => {
    const now = Date.now();
    if (errorLastCheck && now - errorLastCheck > 2000) errorSince = 0;
    errorLastCheck = now;
    /* Every match, not the first. YouTube's player ships an `#error-screen`
     * element that sits empty and hidden on a perfectly healthy page, so
     * `querySelector` returns that one, its text is blank, and the real error
     * two nodes later is never looked at. Caught by the planted-error test
     * rather than by reading the code, which is the only reason the recovery
     * path is not silently dead. */
    const screens = document.querySelectorAll(
      '#error-screen, .ytp-error, .ytp-error-content-wrap-reason'
    );
    let screen = null;
    for (const el of screens) {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' &&
          style.display !== 'none' && style.opacity !== '0' &&
          ERROR_TEXT.test((el.textContent || '').trim())) {
        screen = el;
        break;
      }
    }
    if (!screen) {
      errorSince = 0;
      return false;
    }
    /* Not straight away. Since 1.8.0 youtube.js recovers a dead player in
     * place — it re-requests the video with a different client screen through
     * the player's own API, which keeps the position and costs no page load.
     * That gets ERROR_GRACE_MS to work before this layer reaches for the
     * blunt instrument. */
    if (!errorSince) errorSince = now;
    markEnforced();
    report();
    if (now - errorSince < ERROR_GRACE_MS) return false;
    const n = reloads();
    if (n >= RELOAD_CAP) return false;
    try {
      sessionStorage.setItem('cab.yt.reloads', String(n + 1));
    } catch {
      return false;
    }
    location.reload();
    return true;
  };

  let lastReport = 0;
  const report = () => {
    const now = Date.now();
    if (now - lastReport < 5000) return;
    lastReport = now;
    try {
      chrome.runtime.sendMessage({
        type: 'blocked',
        kind: 'youtube-nag',
        detail: location.href,
        page: location.href,
      });
    } catch {
      /* service worker asleep / extension reloading */
    }
  };

  /* Polymer locks page scroll while a modal is open. Dismissing normally
   * unlocks it; this is the belt for when the dialog is torn out instead. */
  let unlockTimer = 0;
  const unlockScroll = () => {
    const b = document.body;
    if (!b) return;
    b.style.setProperty('overflow', 'auto', 'important');
    b.style.setProperty('overflow-y', 'auto', 'important');
    clearTimeout(unlockTimer);
    unlockTimer = setTimeout(() => {
      b.style.removeProperty('overflow');
      b.style.removeProperty('overflow-y');
    }, 5000);
  };

  const resume = () => {
    const v = document.querySelector('video');
    if (v && v.paused && !v.ended) v.play().catch(() => {});
  };

  const handle = () => {
    if (handlePlaybackError()) return true;
    const nag = document.querySelector(NAG);
    if (!nag) return false;

    const host = nag.closest(HOST) || nag;

    // 1. Invisible immediately. This runs inside the MutationObserver callback
    //    that saw the insertion, so it lands before the frame is painted.
    host.style.setProperty('display', 'none', 'important');

    // 2. Dismissed properly, through YouTube's own control, so the dismissal
    //    is reported like any other viewer's. If the button is not there (or
    //    ignores an untrusted click, as YouTube does for some controls), step
    //    3 still gets rid of it.
    //    Looked up in order of preference rather than DOM order: a single
    //    selector list returns whichever matches first in the document, and
    //    on the current dialog that is the "Allow YouTube ads" action, not
    //    the close control.
    let button = null;
    for (const sel of [
      '#dismiss-button',
      '[aria-label="Close" i]',
      '[aria-label*="close" i]',
      '[id*="dismiss"]',
      'tp-yt-paper-button',
    ]) {
      button = host.querySelector(sel);
      if (button) break;
    }
    if (button) button.click();

    // 3. Whatever survived the dismissal, and the modal furniture with it.
    setTimeout(() => {
      if (host.isConnected) host.remove();
      // Only the nag's backdrop, never someone else's: YouTube keeps dialogs
      // in the DOM after closing them, so "is any dialog marked opened" is not
      // the question — "is any dialog actually on screen" is.
      const dialogVisible = [...document.querySelectorAll('tp-yt-paper-dialog[opened]')].some(
        (d) => d.offsetParent !== null
      );
      if (!dialogVisible) {
        document.querySelectorAll('tp-yt-iron-overlay-backdrop').forEach((el) => {
          el.removeAttribute('opened');
          el.remove();
        });
      }
      unlockScroll();
      resume();
    }, 250);

    unlockScroll();
    resume();
    setTimeout(resume, 800);
    markEnforced();
    report();
    return true;
  };

  /* Debounced: a YouTube page mutates constantly, and the scan should cost one
   * querySelector per animation frame at worst, not one per mutation. */
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      handle();
    });
  };

  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  // Backstop for anything that arrives without a childList mutation we see.
  setInterval(handle, 1000);
  handle();

  /* Reachability diagnostic only. A failed fetch does not establish DNS
   * filtering or explain an account's playback error: other extensions,
   * policies, timeouts and ordinary network failures can all reject it. */
  if (window === window.top) {
    const probe = async () => {
      const ctl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = setTimeout(() => ctl && ctl.abort(), 4000);
      let ok = false;
      let why = '';
      try {
        await fetch('https://static.doubleclick.net/instream/ad_status.js', {
          mode: 'no-cors',
          cache: 'no-store',
          credentials: 'omit',
          signal: ctl ? ctl.signal : undefined,
        });
        ok = true;
      } catch (e) {
        why = (e && e.name) || 'error';
      }
      clearTimeout(timer);
      try {
        chrome.runtime.sendMessage({ type: 'adProbe', ok, why, host: location.hostname });
      } catch {
        /* service worker asleep / extension reloading */
      }
    };
    setTimeout(probe, 1500);
  }
})();
