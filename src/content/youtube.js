/*
 * youtube.js — MAIN world, document_start, youtube.com only.
 *
 * YouTube ads cannot be blocked at the network layer: they stream from
 * googlevideo.com, the same CDN as the video itself. But the *list* of ads to
 * play arrives as plain JSON fields inside the player response
 * (adPlacements / playerAds / adSlots). This script intercepts every route
 * that JSON can arrive by and deletes those fields before the player reads
 * them — so the player believes the video simply has no ads.
 *
 * The same responses also carry the "Ad blockers are not allowed on YouTube"
 * nag, as a renderer named enforcementMessageViewModel (the name changes every
 * enforcement wave, so the strip matches by pattern, not by exact key). It can
 * ride on the player response, on ytInitialData, or on any later
 * /youtubei/v1/ response, so all three routes are covered.
 *
 * Everything here also tries hard not to be *visible* as an adblocker:
 * replaced natives are Proxies, so they still report as native under
 * Function.prototype.toString without that intrinsic being touched; the
 * re-entry guard is a symbol rather than an enumerable window property; and
 * nothing is hidden with a stylesheet, because any rule that hides ad-shaped
 * things can be found by dropping a bait element and reading getComputedStyle.
 * See "Staying invisible" below.
 *
 * The default is 'prune' (1.8.0): delete the schedule, and when YouTube
 * answers by starving the player of media, ask again as a different client
 * screen — the recovery uBlock Origin ships. 'stealth' keeps every ad and
 * plays it muted, hidden and fast; it is still here as the safety net under
 * prune and as an A/B switch. See MODE below.
 */
(() => {
  "use strict";

  if (!/(^|\.)youtube(-nocookie)?\.com$/.test(location.hostname)) return;

  /* ------------------------------------------------------------------ *
   * Staying invisible.
   *
   * An own property on window is one Object.getOwnPropertyNames(window) away
   * from being a detector's adblocker signature, so the re-entry guard is a
   * symbol key instead: not enumerable, not in getOwnPropertyNames.
   * ------------------------------------------------------------------ */
  const GUARD = Symbol.for("cab.yt");
  if (window[GUARD]) return;

  /* Bisecting switch. `sessionStorage['cab.yt.layer']` selects how much of
   * this file runs, so a stall can be attributed without rebuilding or
   * reloading the extension:
   *
   *   off    — nothing at all; the page is untouched by this script
   *   hooks  — the JSON interception only, no playback handling
   *   (unset)— everything
   *
   * Kept in the shipping code deliberately: every wrong theory in this
   * project's history cost a reload cycle, and the ones that cost the most
   * were the ones where "the extension is off" could not be tested quickly.
   *
   * sessionStorage, not localStorage, and that is a scar too: a bisecting run
   * on 2026-09-02 left `off` behind in localStorage, which persists across
   * every tab and restart, and the extension then did nothing on YouTube for
   * hours while reporting itself as enabled — the same silent failure as the
   * 1.5.0 registration bug, from the other side. A switch meant for one
   * debugging session must die with the tab it was set in. */
  let LAYER = "";
  try {
    LAYER = sessionStorage.getItem("cab.yt.layer") || "";
  } catch {
    /* storage blocked */
  }
  if (LAYER === "off") return;

  /* The guard doubles as the diagnostic channel the live tests read. A symbol
   * key is not listed by Object.getOwnPropertyNames(window), so this is the
   * same (nil) exposure the bare guard already had — and without it a break
   * that did not shorten is unattributable: an ignored Skip press and a pod of
   * two ads look identical from the outside. Measured 2026-09-02, and that
   * ambiguity cost a full round of runs. */
  const DIAG = {
    adStarts: 0,
    prunedSchedules: 0,
    prunedShorts: 0,
    transportEdits: 0,
    shellRecoveries: 0,
    /* The recovery's own account of itself, for the live tests and for a
     * console in Tristan's Chrome: read window[Symbol.for("cab.yt")]. */
    recovery: { attempt: 0, strategy: "", reloads: 0, exhaustedFor: "", playerRequests: 0, rewritten: 0, serialized: 0, last: "" },
  };
  Object.defineProperty(window, GUARD, { value: DIAG });

  /* ------------------------------------------------------------------ *
   * Three ways to not watch an ad.
   *
   * 'native'  — ask for the video as a client YouTube does not sell ads to,
   *             so the server never schedules one. Nothing is deleted,
   *             nothing is skipped, nothing is played fast: the ad break
   *             does not exist. See "The native route" below.
   *
   * 'prune'   — delete the ad schedule so no ad ever enters the player.
   *             Zero seconds of ad, and the default since 1.7.0.
   *
   *             This mode was retired in 1.4.0 on the finding that it
   *             "reliably ends in a blocked player", measured on a live
   *             signed-in session on 2026-09-01. That finding was
   *             contaminated. The same day, and recorded in the README's own
   *             Known limits, that account would not play video with this
   *             extension DISABLED, with every YouTube extension disabled,
   *             with nothing injected into the page at all — while the same
   *             videos played in incognito. An account-level block was read
   *             as evidence against the mode, and the zero-ad path was
   *             switched off for it.
   *
   *             Re-measured 2026-09-03 on the same signed-in account, seven
   *             runs across six videos at 140-150s each: zero ads, zero ads
   *             entering the player, playabilityStatus OK every time, no
   *             error screen, no enforcement dialog, content playing to the
   *             end of every run. Stealth on the same bench cost 18.5s of ad
   *             across four ads in 140s.
   *
   * 'stealth' — let every ad be requested, fetched, played and reported,
   *             exactly as YouTube expects. Nothing is blocked, nothing is
   *             abandoned, no ping goes unsent. The ad is merely muted,
   *             invisible and run at 16x, so a break costs a second or two of
   *             black instead of thirty of advertising. There is nothing for
   *             a detector to find, because nothing is missing.
   *
   * Prune is the default. Stealth's playback handling stays underneath it as
   * the safety net: anything that does reach the player — a route this file
   * does not know about, or a server-stitched ad — is still muted, hidden and
   * run at speed rather than watched. Override per-browser from the console
   * with `localStorage['cab.yt.mode'] = 'stealth'`, which is both the way back
   * if YouTube ever starts enforcing again and how the three are A/B tested
   * against the live site without reloading the extension.
   * ------------------------------------------------------------------ */

  const MODE = (() => {
    try {
      const forced = localStorage.getItem("cab.yt.mode");
      if (forced === "prune" || forced === "stealth" || forced === "native")
        return forced;
    } catch {
      /* storage blocked — fall through to the default */
    }
    /* Prune is the default again, 1.8.0, and this time the reasoning is not
     * "the bench was clean" — the bench has been clean for every mode and has
     * predicted nothing. It is two field facts from Tristan's own profile on
     * 2026-09-03, read out of the extension's log:
     *
     *   12:57  youtube-nag   the enforcement dialog, in stealth
     *   13:28  youtube-nag   again, in stealth, seconds after a reload
     *   15:08  youtube-ad    the stall watchdog reloading a video, in stealth
     *
     * So "stealth has never once been blocked" (1.7.1) was true of the bench
     * and false of the field. Both modes get enforced against; stealth merely
     * also pays seconds of black per break for the privilege. Once the choice
     * is between two enforced modes, the one with zero ads wins, provided the
     * enforcement itself is handled — and the shape it takes is now known.
     *
     * The 1.7.1 field failure of prune was a dead player:
     *
     *   Something went wrong. Please try again later.  282054944
     *
     * uBlock Origin's live YouTube rules (uAssets, read 2026-09-03) name the
     * same state — the player buffering with "0.00 s" of buffer and a "0x0"
     * resolution while the response says OK — and answer it by re-requesting
     * the video as a channel-page player (`clientScreen: CHANNEL`), then with
     * the `8AUB` params. That recovery is implemented below and runs in every
     * mode. It is the one measured, mass-deployed answer to the enforcement
     * this project kept meeting, and it is what turns prune from "zero ads
     * until the player dies" into "zero ads".
     *
     * The old degrade — flip to stealth for the tab after a nag — is gone,
     * because stealth is not a refuge any more. The flag the nag layer writes
     * (`cab.yt.enforced`) is kept as a diagnostic only.
     *
     * `stealth` remains one line away for A/B runs:
     *   localStorage['cab.yt.mode'] = 'stealth' */
    return "prune";
  })();

  /* Same reasoning applied to the nag itself. Deleting the renderer means the
   * message YouTube sent was never shown and never dismissed — another gap
   * where something should have happened and didn't. In stealth the nag is
   * allowed to arrive and youtube-nag.js dismisses it through YouTube's own
   * button, which reports the dismissal, hiding it inline in the same frame so
   * nobody sees it. Only 'prune' still deletes it from the JSON. */
  DIAG.mode = MODE;
  const STRIP_NAG = MODE === "prune";

  /* Every hook below replaces a native function, and a naive replacement gives
   * itself away instantly: JSON.parse.toString() returns the hook's source
   * instead of "function parse() { [native code] }".
   *
   * A Proxy around the original solves that for free: Function.prototype
   * .toString on a proxy of a callable returns the native-code string, and
   * name/length pass through to the target. The earlier attempt patched
   * Function.prototype.toString itself, which is a global intrinsic every
   * script on the page shares — including YouTube's own playback attestation,
   * which failed closed with "Something went wrong" on signed-in sessions
   * (1.3.0). Hooks must be local to what they hook. */
  const hook = (original, handler) => new Proxy(original, handler);

  /* ------------------------------------------------------------------ *
   * The native route.
   *
   * Every earlier version of this file argued with the ad after YouTube had
   * already decided to serve one. Deleting the schedule leaves a hole — an ad
   * scheduled and then never requested — which is what got the player blocked
   * in 1.4.0. Playing it fast costs whatever the ad's bytes cost: 8-10s for a
   * long pre-roll when the stream is healthy, and unbounded when it is not,
   * which is the minute of grey this release exists to remove.
   *
   * The decision to serve an ad is not made in the browser. It is made by
   * /youtubei/v1/player, and what it keys on is `context.client`. Asked as
   * WEB, the answer carries adPlacements / playerAds / adSlots. Asked as IOS
   * — the client the iPhone app uses — the same request, for the same video,
   * on the same signed-in account, answers:
   *
   *   playabilityStatus.status : OK
   *   adPlacements/playerAds   : absent
   *   streamingData            : 18-19 adaptiveFormats, each with a direct url
   *   playbackTracking         : complete (watchtime, ptracking, qoe, atr)
   *
   * Verified against Tristan's live signed-in session, 2026-09-02, on three
   * videos; range requests against the returned video and audio urls came
   * back 200 with real bytes, so those are playable streams and not a teaser.
   *
   * So nothing here is removed. A second question is asked, and its answer is
   * the one the player is given. The playback session that starts is the iOS
   * one — its own cpn, its own tracking urls, ad-free because YouTube itself
   * said so. No impression is faked, because none was ever promised.
   *
   * What this does NOT close: the watch page's own response still arrives
   * with an ad schedule on it, because that request is the navigation itself.
   * That schedule is never played — but it is also never started, which is a
   * different shape from `prune` (where a session begins and then skips the
   * ads it was given). It looks like a page that was opened and closed.
   * Closing even that would mean rewriting the outgoing request, and as of
   * 2026-09-02 YouTube no longer sends one: the player response rides inside
   * a compressed /youtubei/v1/get_watch POST, so there is no JSON body to
   * edit on the way out. Hence substitution rather than rewriting.
   * ------------------------------------------------------------------ */

  const NATIVE = MODE === "native";

  /* Observed on the way past, for the live tests: whether a native response
   * was actually served, and how it had to be fetched. */
  let nativeServed = 0;
  let nativeSync = 0;

  /* Captured before any hook below is installed, so the native fetch cannot
   * re-enter its own interception and substitute into itself. */
  const nativeParse = JSON.parse;
  const nativeStringify = JSON.stringify;
  const nativeFetch = typeof fetch === "function" ? fetch.bind(window) : null;

  const CLIENTS = {
    IOS: {
      clientName: "IOS",
      clientVersion: "20.10.4",
      deviceMake: "Apple",
      deviceModel: "iPhone16,2",
      osName: "iPhone",
      osVersion: "18.3.2.22D82",
    },
    ANDROID_VR: {
      clientName: "ANDROID_VR",
      clientVersion: "1.62.27",
      deviceMake: "Oculus",
      deviceModel: "Quest 3",
      osName: "Android",
      osVersion: "12",
      androidSdkVersion: 32,
    },
    TVHTML5: {
      clientName: "TVHTML5_SIMPLY_EMBEDDED_PLAYER",
      clientVersion: "2.0",
    },
    WEB_EMBEDDED: {
      clientName: "WEB_EMBEDDED_PLAYER",
      clientVersion: "1.20260901.00.00",
    },
    MWEB: { clientName: "MWEB", clientVersion: "2.20260901.00.00" },
  };
  /* Which ad-free client to ask as. `localStorage['cab.yt.client']` picks
   * another one for A/B measurement against the live site. */
  const IOS_CLIENT = (() => {
    try {
      const n = localStorage.getItem("cab.yt.client");
      if (n && CLIENTS[n]) return CLIENTS[n];
    } catch {
      /* storage blocked */
    }
    return CLIENTS.IOS;
  })();

  /* The public innertube key for the web client. ytcfg is the better source,
   * but at document_start it does not exist yet and the cold load is exactly
   * when the first request goes out, so the constant is the fallback rather
   * than the other way round. */
  const WEB_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";

  const innertubeUrl = () => {
    let key = WEB_KEY;
    try {
      key =
        (window.ytcfg &&
          window.ytcfg.data_ &&
          window.ytcfg.data_.INNERTUBE_API_KEY) ||
        key;
    } catch {
      /* ytcfg not up yet */
    }
    return `/youtubei/v1/player?key=${key}&prettyPrint=false`;
  };

  const iosBody = (videoId) => {
    let hl = "en";
    let gl = "US";
    let visitorData;
    try {
      const c =
        window.ytcfg &&
        window.ytcfg.data_ &&
        window.ytcfg.data_.INNERTUBE_CONTEXT;
      if (c && c.client) {
        hl = c.client.hl || hl;
        gl = c.client.gl || gl;
        visitorData = c.client.visitorData;
      }
    } catch {
      /* defaults are fine */
    }
    const body = {
      videoId,
      context: {
        client: {
          ...IOS_CLIENT,
          hl,
          gl,
          ...(visitorData ? { visitorData } : {}),
        },
      },
      contentCheckOk: true,
      racyCheckOk: true,
    };
    if (/EMBED/.test(IOS_CLIENT.clientName))
      body.context.thirdParty = { embedUrl: "https://www.youtube.com/" };
    return nativeStringify(body);
  };

  /* A response is only usable if YouTube says it is playable AND it came with
   * streams; an OK status with no streamingData is a shell, and handing that
   * to the player is worse than leaving the ad alone. */
  const usable = (r) =>
    !!r &&
    !!r.playabilityStatus &&
    /^(OK|LIVE_STREAM_OFFLINE)$/.test(r.playabilityStatus.status) &&
    !!r.streamingData &&
    ((r.streamingData.adaptiveFormats || []).length > 0 ||
      (r.streamingData.formats || []).length > 0);

  const idFromUrl = (href) => {
    const m = /[?&]v=([\w-]{6,20})/.exec(href || "");
    return m ? m[1] : "";
  };

  /** videoId -> iOS player response (or null once known to be unusable). */
  const iosCache = new Map();

  /* Started as early as the video id is known, so the substitution below
   * usually has its answer in hand and never has to block. */
  const prefetch = (videoId) => {
    if (!NATIVE || !videoId || iosCache.has(videoId) || !nativeFetch) return;
    iosCache.set(videoId, undefined); // in flight
    nativeFetch(innertubeUrl(), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: iosBody(videoId),
    })
      .then((r) => r.text())
      .then((t) => {
        const r = nativeParse(t);
        // Only land if nobody consumed the in-flight marker meanwhile.
        if (iosCache.has(videoId)) iosCache.set(videoId, usable(r) ? r : null);
      })
      .catch(() => {
        if (iosCache.has(videoId)) iosCache.set(videoId, null);
      });
  };

  /* The blocking fallback, for when the player asks before the prefetch has
   * landed — which is the normal case on a cold load, because the embedded
   * response is assigned by an inline script a few hundred milliseconds after
   * this file runs.
   *
   * A synchronous XHR on the main thread is a real cost and is not used
   * lightly. It is one same-origin round trip against a connection the page
   * has already opened, and it is spent instead of an ad break. */
  const iosSync = (videoId) => {
    try {
      const x = new XMLHttpRequest();
      x.open("POST", innertubeUrl(), false);
      x.setRequestHeader("Content-Type", "application/json");
      x.send(iosBody(videoId));
      if (x.status !== 200) return null;
      const r = nativeParse(x.responseText);
      nativeSync += 1;
      return usable(r) ? r : null;
    } catch {
      return null;
    }
  };

  /* A cached answer is good for exactly one player response. SABR tells the
   * player to reload its player response about a minute in (measured: the
   * content clock hit 59.9s and the player reset, every run), and the reload
   * carries a new streaming session. Handing the reload the same answer it
   * had before — same serverAbrStreamingUrl, same session — ends in
   * "Something went wrong" (282054944). So each player response YouTube
   * parses gets its own fresh iOS answer, and the cache only ever serves the
   * prefetch that was started for it. */
  const iosFor = (videoId) => {
    const cached = iosCache.get(videoId);
    if (cached !== undefined) {
      iosCache.delete(videoId);
      if (cached === null) return null; // known-bad: iOS cannot serve this one
      return cached;
    }
    iosCache.delete(videoId); // an in-flight prefetch, if any, lands in the void
    return iosSync(videoId);
  };

  /* Kept from YouTube's own answer rather than taken from the iOS one. Both
   * describe the response rather than the video, and the player checks them
   * against the request it believes it made: with the iOS ones in place it
   * plays but reports playabilityStatus ERROR to anything that asks (measured
   * 2026-09-02, every sample); with these kept it reports OK and plays the
   * same. */
  const SKIP = new Set(["responseContext", "trackingParams"]);

  /* Fields the web player uses that the iOS answer does not carry. They are
   * page furniture — chapter markers, the scrubber's storyboard, end cards —
   * and none of them schedule anything, so they are left in place while the
   * playback-bearing fields are replaced wholesale. */
  const IOS_KEEPS_WEB = new Set([
    "microformat",
    "storyboards",
    "endscreen",
    "cards",
    "annotations",
    "paidContentOverlay",
    "frameworkUpdates",
  ]);

  /**
   * Give the player the ad-free answer in place of the one it was handed.
   * Mutates rather than replacing the object, because callers hold references
   * to it. Returns true if the swap happened.
   */
  const serveNative = (o) => {
    if (!NATIVE || !o || typeof o !== "object") return false;
    const videoId = (o.videoDetails && o.videoDetails.videoId) || "";
    if (!videoId) return false;
    if (o.__cabNative) return true;
    /* Only the video actually being watched. A watch page parses a player
     * response for every recommendation in the sidebar too, and answering
     * each of those would mean ten blocking round trips for ten videos
     * nobody asked to play. */
    if (videoId !== idFromUrl(location.href)) return false;
    const ios = iosFor(videoId);
    if (!ios) {
      /* iOS is not allowed to serve this one (age gates and some licensing).
       * Leave YouTube's own answer exactly as it came and let the playback
       * fallback in `stomp` deal with the ads — a downgrade for one video is
       * not worth reloading the tab for. */
      return false;
    }
    /* Recorded before the schedule is replaced, so a measurement can still
     * tell "this video had no ads" apart from "this video's ads were avoided"
     * after the swap has hidden the evidence. Non-enumerable, so it does not
     * appear in JSON.stringify or Object.keys and cannot show up in anything
     * the page sends back to YouTube. */
    try {
      Object.defineProperty(o, "__cabPreSwapAds", {
        value: AD_KEYS.filter((k) => k in o).length,
        enumerable: false,
        configurable: true,
      });
    } catch {
      /* frozen object — the measurement is a nicety, the swap is not */
    }
    for (const k of AD_KEYS) delete o[k];
    for (const k of Object.keys(ios)) {
      if (IOS_KEEPS_WEB.has(k) || SKIP.has(k)) continue;
      o[k] = ios[k];
    }
    Object.defineProperty(o, "__cabNative", { value: true });
    nativeServed += 1;
    report();
    return true;
  };

  /* The video id is knowable long before the player asks for it: it is in the
   * address bar. Prefetch on load and on every SPA navigation, so the sync
   * path above is the exception rather than the rule. */
  if (NATIVE) {
    prefetch(idFromUrl(location.href));
    let lastHref = location.href;
    setInterval(() => {
      if (location.href === lastHref) return;
      lastHref = location.href;
      prefetch(idFromUrl(lastHref));
    }, 200);
  }

  /* ------------------------------------------------------------------ *
   * What gets removed.
   * ------------------------------------------------------------------ */

  // Only the three canonical ad-schedule keys. Touching the heartbeat/stats
  // machinery breaks the player's own "ad is over" bookkeeping and strands it
  // at the end of an ad (learned the hard way in 1.1.1).
  const AD_KEYS = ["adPlacements", "playerAds", "adSlots"];

  // Any key naming an anti-adblock renderer. Pattern, not a fixed list:
  // YouTube has renamed this renderer at every enforcement wave, and a key
  // with "adblock" or "enforcementMessage" in its name is never anything else.
  const NAG_KEY = /adblock|enforcementmessage/i;

  // Cheap gate before the expensive walk: if the raw JSON text does not even
  // contain the words, there is nothing to strip. Keeps the deep walk off the
  // hot path for the thousands of small JSON.parse calls a YouTube page makes.
  const NAG_HINT = /adblock|enforcementMessage/i;

  // Branches of a big response where popups and messages live. Walking these
  // is cheap; walking all of ytInitialData on every page load is not.
  const NAG_BRANCHES = [
    "popup",
    "popups",
    "onResponseReceivedActions",
    "onResponseReceivedEndpoints",
    "overlay",
    "playerOverlays",
    "auxiliaryUi",
    "alerts",
    "engagementPanels",
    "responseContext",
  ];

  /* Reporting is a postMessage the page could in principle listen for, so it
   * is throttled to one per 5s rather than one per prune: enough for the
   * popup's log and badge, minimal surface. */
  let lastReport = 0;
  const report = () => {
    const now = Date.now();
    if (now - lastReport < 5000) return;
    lastReport = now;
    try {
      window.postMessage(
        {
          source: "__customAdblock",
          kind: "youtube-ad",
          detail: location.href,
        },
        "*",
      );
    } catch {
      /* ignore */
    }
  };

  /** Delete every nag renderer anywhere under `root`. Returns how many. */
  const deepStrip = (root) => {
    if (!STRIP_NAG) return 0;
    if (!root || typeof root !== "object") return 0;
    let hits = 0;
    let budget = 300000; // walk cap: a malformed cycle must not hang the page
    const seen = new Set();
    const stack = [root];
    while (stack.length && budget-- > 0) {
      const node = stack.pop();
      if (!node || typeof node !== "object" || seen.has(node)) continue;
      seen.add(node);
      if (Array.isArray(node)) {
        for (const v of node) if (v && typeof v === "object") stack.push(v);
        continue;
      }
      for (const k of Object.keys(node)) {
        if (NAG_KEY.test(k)) {
          delete node[k];
          hits += 1;
          continue;
        }
        const v = node[k];
        if (v && typeof v === "object") stack.push(v);
      }
    }
    if (hits) report();
    return hits;
  };

  /** deepStrip, but only the branches a nag can appear in. */
  const stripBranches = (o) => {
    if (!STRIP_NAG) return 0;
    if (!o || typeof o !== "object") return 0;
    let hits = 0;
    for (const b of NAG_BRANCHES) if (o[b]) hits += deepStrip(o[b]);
    return hits;
  };

  /** A player response is the only object that carries these keys together. */
  const looksLikePlayerResponse = (o) =>
    o &&
    typeof o === "object" &&
    (o.playabilityStatus !== undefined ||
      o.videoDetails !== undefined ||
      o.adPlacements !== undefined ||
      o.playerAds !== undefined ||
      o.adSlots !== undefined);

  const prune = (o, seen = new Set()) => {
    if (!o || typeof o !== "object" || seen.has(o)) return o;
    seen.add(o);
    if (Array.isArray(o)) {
      for (const item of o) prune(item, seen);
      return o;
    }
    // Known response envelopes, including PBJ arrays and the Shorts wrapper.
    // Do not return early: get_watch can repeat the schedule on the envelope.
    for (const key of ["playerResponse", "response", "reelWatchSequenceResponse"]) {
      if (o[key] && typeof o[key] === "object") prune(o[key], seen);
    }
    if (o.playerResponse && o.playerResponse.__cabNative) {
      for (const key of AD_KEYS) delete o[key];
    }
    // Remove the sponsored entry itself. Erasing isAd relabels the ad as
    // ordinary content and leaves it in the viewer's feed.
    if (MODE === "prune" && Array.isArray(o.entries)) {
      for (let i = o.entries.length - 1; i >= 0; i -= 1) {
        const endpoint = o.entries[i]?.command?.reelWatchEndpoint;
        if (endpoint?.adClientParams?.isAd === true) {
          o.entries.splice(i, 1);
          DIAG.prunedShorts += 1;
          report();
        }
      }
    }
    if (!looksLikePlayerResponse(o)) return o;
    /* Native mode does not edit the answer, it replaces it — see above. If
     * iOS cannot serve this video, fall through and let the mode's own
     * handling (nag stripping off, playback fallback on) apply as before. */
    if (NATIVE && serveNative(o)) return o;
    let hit = false;
    // Stealth leaves the ad schedule intact on purpose — see MODE above. The
    // ads still never reach eyes or ears; they are dealt with in `stomp`.
    if (MODE === "prune") {
      for (const k of AD_KEYS) {
        if (k in o) {
          if (Array.isArray(o[k]) && o[k].length) DIAG.prunedSchedules += 1;
          delete o[k];
          hit = true;
        }
      }
    }
    // The nag arrives on the same object, under auxiliaryUi and friends.
    if (stripBranches(o)) hit = true;
    if (hit) report();
    return o;
  };

  /* Route 1: the initial page load embeds the player response in the HTML and
   * assigns it to a global. Trap the assignment.
   *
   * In native mode this trap does something different, and it is the one
   * piece of the native route that cannot be done by rewriting a request: the
   * embedded response arrived with the document, so its client context was
   * decided by the navigation, and it carries ads. Editing it would be
   * `prune` under another name — an ad scheduled and then abandoned, which is
   * the shape that gets caught.
   *
   * So it is not edited. It is not used. The getter reports no embedded
   * response at all, which is a state YouTube already handles (it is what a
   * cold player container sees), and the player goes and asks
   * /youtubei/v1/player for itself — which is the request the rewrite above
   * turns into an iOS one. One request per video, ad-free at the source, and
   * the WEB playback session the document opened simply never starts, the
   * same as a page the user closed before pressing play.
   *
   * `localStorage['cab.yt.initial'] = 'keep'` puts the embedded response back,
   * for bisecting a load that goes wrong. */
  let iprValue;
  try {
    Object.defineProperty(window, "ytInitialPlayerResponse", {
      configurable: true,
      get: () => iprValue,
      set: (v) => {
        iprValue = prune(v);
      },
    });
  } catch {
    /* already defined — page beat us here, routes 2/3 still cover it */
  }

  /* Route 1b: the page's *shell* data — everything outside the player. On a
   * first load the nag dialog is queued here, not in the player response, and
   * it never passes through JSON.parse (it is a literal in an inline script),
   * so this trap is the only place to catch it. */
  let dataValue;
  try {
    Object.defineProperty(window, "ytInitialData", {
      configurable: true,
      get: () => dataValue,
      set: (v) => {
        stripBranches(v);
        dataValue = v;
      },
    });
  } catch {
    /* already defined — the DOM layer (youtube-nag.js) still catches it */
  }

  const origParse = JSON.parse;

  /* Route 2: SPA navigation fetches the next video's player response as JSON.
   * The native call is left exactly as it is and only its result is walked —
   * an earlier version re-implemented json() on top of text(), which is more
   * deviation from stock behaviour than this layer is worth. The deep walk is
   * limited to innertube responses, the only ones that can carry a nag. */
  const origJson = Response.prototype.json;
  Response.prototype.json = hook(origJson, {
    apply(target, thisArg, args) {
      let url = "";
      try {
        url = thisArg.url || "";
      } catch {
        /* not a Response — let the native call be the one that complains */
      }
      return Reflect.apply(target, thisArg, args).then((data) => {
        prune(data);
        if (url.includes("/youtubei/")) deepStrip(data);
        return data;
      });
    },
  });

  /* Route 3: anything parsed by hand. The raw text is in hand here, so the
   * cheap NAG_HINT gate keeps the deep walk off the hot path entirely. */
  JSON.parse = hook(origParse, {
    apply(target, thisArg, args) {
      const out = Reflect.apply(target, thisArg, args);
      prune(out);
      const text = args[0];
      if (typeof text === "string" && NAG_HINT.test(text)) deepStrip(out);
      return out;
    },
  });

  /* ------------------------------------------------------------------ *
   * What the surviving blockers do, and this file now does too (1.8.0).
   *
   * uBlock Origin's live YouTube rules (uAssets `filters.txt`, read
   * 2026-09-03) are the one measured, mass-deployed answer to the current
   * enforcement. Each piece below maps to one of them:
   *
   *   trusted-prevent-dom-bypass, appendChild, JSON.parse | fetch | Request
   *     YouTube appends a throwaway iframe and takes THAT realm's untouched
   *     JSON.parse and fetch, which walk straight past routes 2 and 3. The
   *     guard hands the iframe this realm's hooked copies the instant it is
   *     attached, before any script in it can run.
   *
   *   set, ytcfg.data_.EXPERIMENT_FLAGS.all_web_enable_network_machine, false
   *   set, ytcfg.data_.EXPERIMENT_FLAGS.all_web_network_machine_raw_request, false
   *     Keeps the player on the request path the rewrite below can see.
   *
   *   trusted-json-edit-xhr-request … clientScreen="CHANNEL" / params="8AUB"
   *     The dead-player recovery. When the media bytes stop coming, the
   *     video is re-requested as a channel-page player, then with the 8AUB
   *     params and a fresh lact timestamp. See `recoverPlayback` below.
   *
   *   rpnt … onAbnormalityDetected → no-op
   *     The player's own "something is off" reporter is a then-callback of
   *     that name. It is replaced with a function that does nothing.
   *
   * None of this is bespoke to this extension, which is the point: it is
   * the same shape a few million uBO installs present to YouTube today.
   * ------------------------------------------------------------------ */

  /* Patch same-origin API borrowing at the contentWindow getter. appendChild
   * alone misses prepend(), append(), insertBefore() and parser-built frames.
   * Cross-origin frames are inaccessible and left to their own injection. */
  try {
    const proto = HTMLIFrameElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "contentWindow");
    const guardedFrames = new WeakSet();
    if (desc && desc.get) Object.defineProperty(proto, "contentWindow", {
      ...desc,
      get: hook(desc.get, {
        apply(target, thisArg, args) {
          const cw = Reflect.apply(target, thisArg, args);
          try {
            if (cw && !guardedFrames.has(cw.JSON)) {
              cw.JSON.parse = JSON.parse;
              cw.fetch = window.fetch;
              cw.Request = window.Request;
              cw.XMLHttpRequest = window.XMLHttpRequest;
              guardedFrames.add(cw.JSON);
            }
          } catch { /* cross-origin or detached */ }
          return cw;
        },
      }),
    });
  } catch { /* no DOM in this realm */ }

  /* Experiment flags, pinned as soon as ytcfg exists and again on every
   * ytcfg.set(), because the flags arrive in a later set() than the object. */
  const NETWORK_FLAGS = [
    "all_web_enable_network_machine",
    "all_web_network_machine_raw_request",
  ];
  const pinFlags = (cfg) => {
    try {
      const data =
        (cfg && cfg.data_) || (window.yt && window.yt.config_) || null;
      const f = data && data.EXPERIMENT_FLAGS;
      if (f && typeof f === "object") for (const k of NETWORK_FLAGS) f[k] = false;
    } catch {
      /* not there yet */
    }
  };
  let ytcfgValue;
  try {
    Object.defineProperty(window, "ytcfg", {
      configurable: true,
      get: () => ytcfgValue,
      set: (v) => {
        ytcfgValue = v;
        pinFlags(v);
        try {
          if (v && typeof v.set === "function" && !v[GUARD]) {
            v.set = hook(v.set, {
              apply(target, thisArg, args) {
                const r = Reflect.apply(target, thisArg, args);
                pinFlags(thisArg);
                return r;
              },
            });
            Object.defineProperty(v, GUARD, { value: true });
          }
        } catch {
          /* frozen config — the periodic pin in stomp still applies */
        }
      },
    });
  } catch {
    /* already defined — page beat us here; stomp pins the flags each tick */
  }

  /* The abnormality reporter. */
  try {
    const origThen = Promise.prototype.then;
    Promise.prototype.then = hook(origThen, {
      apply(target, thisArg, args) {
        const cb = args[0];
        if (typeof cb === "function") {
          let src = "";
          try {
            src = Function.prototype.toString.call(cb);
          } catch {
            /* exotic callable */
          }
          if (src.includes("onAbnormalityDetected")) args = [function () {}, args[1]];
        }
        return Reflect.apply(target, thisArg, args);
      },
    });
  } catch {
    /* frozen intrinsic */
  }

  /* The request rewrite. `recoveryStrategy` is "" until a player dies, and
   * then names how the next /youtubei/v1/player request is edited. It is
   * applied to both transports, because which one the player uses depends
   * on flags this file can only influence, not dictate. */
  const PLAYER_RE = /\/youtubei\/v1\/player(\?|$)/;
  let recoveryStrategy = "";
  const rewritePlayerObject = (b) => {
    if (!recoveryStrategy || !b || typeof b !== "object") return false;
    const c = b.context && b.context.client;
    if (!c || (c.clientName && c.clientName !== "WEB")) return false;
    const existing = b.playbackContext?.contentPlaybackContext;
    // A body already serialized for this retry must stay byte-for-byte stable
    // at fetch/XHR, including its timestamp and attestation-bound fields.
    if (existing?.lactMilliseconds && existing?.referer?.endsWith?.("#reloadxhr") &&
        (recoveryStrategy === "channel" ? c.clientScreen === "CHANNEL" : b.params === "8AUB"))
      return false;
    if (recoveryStrategy === "channel") c.clientScreen = "CHANNEL";
    else if (recoveryStrategy === "lactmilli") b.params = "8AUB";
    b.playbackContext = b.playbackContext || {};
    const ctx = b.playbackContext.contentPlaybackContext =
      b.playbackContext.contentPlaybackContext || {};
    ctx.lactMilliseconds = String(Date.now());
    const referer = typeof ctx.referer === "string" ? ctx.referer : location.href;
    ctx.referer = referer.replace(/(?:#reloadxhr)?$/, "#reloadxhr");
    return true;
  };
  // The network machine can encode player bodies before fetch/XHR, despite
  // the pinned experiment flags. Edit attested WEB player objects at their
  // serialization boundary, while leaving ordinary page JSON untouched.
  JSON.stringify = hook(nativeStringify, {
    apply(target, thisArg, args) {
      try {
        const b = args[0];
        if (recoveryStrategy && b?.attestationRequest && b?.videoId && rewritePlayerObject(b)) {
          DIAG.recovery.rewritten += 1;
          DIAG.recovery.serialized += 1;
        }
      } catch { /* frozen or exotic object: retain native serialization */ }
      return Reflect.apply(target, thisArg, args);
    },
  });
  const rewritePlayerBody = (body) => {
    DIAG.recovery.playerRequests += 1;
    if (!recoveryStrategy || typeof body !== "string" || body[0] !== "{")
      return body;
    let b;
    try {
      b = nativeParse(body);
    } catch {
      return body;
    }
    if (!b || typeof b !== "object") return body;
    try {
      if (!rewritePlayerObject(b)) return body;
      DIAG.recovery.rewritten += 1;
    } catch {
      return body;
    }
    return nativeStringify(b);
  };

  // Clean targeted response bodies before the consumer chooses a JSON, text,
  // stream or byte reader. Media, stats, and unrelated endpoints stay native.
  const adResponseUrl = (input) => {
    try {
      const u = new URL(input, location.href);
      return /(^|\.)youtube(-nocookie)?\.com$/.test(u.hostname) &&
        (/^\/youtubei\/v1\/(player|get_watch|reel_watch_sequence)$/.test(u.pathname) ||
          /^\/(watch|playlist)$/.test(u.pathname));
    } catch { return false; }
  };
  const cleanResponseText = (text) => {
    if (MODE !== "prune" || typeof text !== "string" ||
        !/"(?:adPlacements|adSlots|playerAds|isAd)"\s*:/.test(text)) return text;
    try {
      // Keep invalid JSON and non-JSON framing intact rather than guessing at
      // byte offsets or rewriting media. JSON.parse hooks remain underneath.
      const data = nativeParse(text);
      prune(data);
      deepStrip(data);
      const result = nativeStringify(data);
      if (result !== text) DIAG.transportEdits += 1;
      return result;
    } catch { return text; }
  };
  const responseMetadata = (response, original) => {
    for (const key of ["url", "type", "redirected"]) {
      Object.defineProperty(response, key, { value: original[key], configurable: true });
    }
    const clone = response.clone;
    Object.defineProperty(response, "clone", { configurable: true, value: hook(clone, {
      apply(target, thisArg, args) {
        return responseMetadata(Reflect.apply(target, thisArg, args), original);
      },
    }) });
    return response;
  };
  const cleanFetchResponse = async (response) => {
    if (MODE !== "prune" || !response || !adResponseUrl(response.url) ||
        !response.ok || !/json/i.test(response.headers.get("content-type") || "")) return response;
    try {
      // Read a clone, so a parse/read failure can return the untouched response.
      const text = await response.clone().text();
      const clean = cleanResponseText(text);
      if (clean === text) return response;
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.delete("content-encoding");
      return responseMetadata(new Response(clean, {
        status: response.status, statusText: response.statusText, headers,
      }), response);
    } catch { return response; }
  };

  const xhrUrls = new WeakMap();
  const xhrCleaned = new WeakMap();
  try {
    if (typeof XMLHttpRequest === "function" && XMLHttpRequest.prototype) {
      XMLHttpRequest.prototype.open = hook(XMLHttpRequest.prototype.open, {
        apply(target, thisArg, args) {
          try {
            xhrUrls.set(thisArg, String(args[1] || ""));
            xhrCleaned.delete(thisArg);
          } catch {
            /* not an object */
          }
          return Reflect.apply(target, thisArg, args);
        },
      });
      for (const key of ["response", "responseText"]) {
        const proto = XMLHttpRequest.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, key);
        if (!desc || !desc.get) continue;
        Object.defineProperty(proto, key, { ...desc, get: hook(desc.get, {
          apply(target, thisArg, args) {
            const value = Reflect.apply(target, thisArg, args);
            if (MODE !== "prune" || thisArg.readyState !== 4 ||
                !adResponseUrl(xhrUrls.get(thisArg))) return value;
            if (thisArg.responseType === "json") return prune(value);
            if (typeof value !== "string") return value;
            const cached = xhrCleaned.get(thisArg);
            if (cached && cached.raw === value) return cached.clean;
            const clean = cleanResponseText(value);
            xhrCleaned.set(thisArg, { raw: value, clean });
            return clean;
          },
        }) });
      }
      XMLHttpRequest.prototype.send = hook(XMLHttpRequest.prototype.send, {
        apply(target, thisArg, args) {
          try {
            const u = xhrUrls.get(thisArg) || "";
            if (PLAYER_RE.test(u)) args = [rewritePlayerBody(args[0])];
          } catch {
            /* leave the request as it was */
          }
          return Reflect.apply(target, thisArg, args);
        },
      });
    }
  } catch {
    /* no XHR in this realm */
  }
  try {
    if (typeof fetch === "function") {
      window.fetch = hook(fetch, {
        apply(target, thisArg, args) {
          try {
            const input = args[0];
            const init = args[1];
            const url =
              typeof input === "string"
                ? input
                : input && input.url
                  ? String(input.url)
                  : String(input);
            // fetch(new Request(...)) is common on newer player builds.
            // init.body-only interception silently left these retries unchanged.
            if (recoveryStrategy && adResponseUrl(url) && PLAYER_RE.test(url) &&
                typeof Request === "function" && input instanceof Request &&
                (!init || init.body === undefined) && !input.bodyUsed &&
                !/^(GET|HEAD)$/i.test(init?.method || input.method)) {
              return input.clone().text().then((body) => {
                const edited = rewritePlayerBody(body);
                // Compressed/protobuf bodies cannot round-trip through text:
                // invalid UTF-8 bytes become replacement characters (HTTP 400).
                // Send the original Request whenever no JSON edit was made.
                if (edited === body)
                  return Reflect.apply(target, thisArg, args).then(cleanFetchResponse);
                const request = new Request(input, { ...init, body: edited });
                return Reflect.apply(target, thisArg, [request]).then(cleanFetchResponse);
              });
            }
            if (
              recoveryStrategy &&
              adResponseUrl(url) && PLAYER_RE.test(url) &&
              init &&
              typeof init.body === "string"
            )
              args = [input, { ...init, body: rewritePlayerBody(init.body) }];
          } catch {
            /* leave the request as it was */
          }
          return Reflect.apply(target, thisArg, args).then(cleanFetchResponse);
        },
      });
    }
  } catch {
    /* no fetch in this realm */
  }

  /* The moment uBO arms its recovery on: the player emitting a snackbar
   * ("Something went wrong") while sitting in the dead state. It looks the
   * key up in a Map on the way, which is the hook point. */
  let snackbarWhileStuck = false;
  try {
    Map.prototype.has = hook(Map.prototype.has, {
      apply(target, thisArg, args) {
        if (args[0] === "onSnackbarMessage" && isStuck()) snackbarWhileStuck = true;
        return Reflect.apply(target, thisArg, args);
      },
    });
  } catch {
    /* frozen intrinsic */
  }

  /* ------------------------------------------------------------------ *
   * Fallback: the ad made it into the player anyway.
   * ------------------------------------------------------------------ */
  // The ad is hidden with an inline style on the real player elements, applied
  // when the break starts and removed when it ends. There is deliberately no
  // stylesheet: a rule that hides ad-shaped things is detectable by dropping a
  // bait element and reading getComputedStyle, whoever injected it. An inline
  // style on the actual ad, while the actual ad is playing, tells a probe
  // nothing it did not already know.

  // Restore state for when the ad ends: null means "not in an ad right now".
  let saved = null;
  // The hand-back window after a break: where the content clock was when the
  // ad ended, when we started waiting, and how long to wait before showing the
  // player regardless. Four seconds is long enough for the common stall and
  // short enough that a genuinely stuck player is never hidden from the user.
  let resumeFrom = null;
  let resumeSince = 0;
  const RESUME_CAP_MS = 4000;
  // When the ad's own buffer ran dry, so the speed-up can back off in stages
  // rather than giving up on the first dip.
  let starvedSince = 0;
  /* When the current break started, and the furthest the ad clock has reached
   * in it. A break that stops making progress is the failure Tristan hit:
   * the player sat on a grey frame for a minute because the ad's own stream
   * never arrived, and nothing in here was watching the clock. */
  let adSince = 0;
  let adFurthest = 0;
  let adStalledSince = 0;
  /* How long an ad may make no progress at all before the break is abandoned.
   * Abandoning leaves the impression unsent, which is the thing stealth
   * exists not to do — so this is deliberately long enough that no healthy
   * break ever reaches it, and it fires only when the alternative is a dead
   * player. */
  const AD_STALL_MS = 12000;
  /* The same watchdog for the other half of a break. The ad can finish
   * cleanly and the *content* still fail to arrive, which looks identical
   * from the sofa: a grey player that never starts. Reported from the field
   * as "it has been on that grey screen for a minute". Ten seconds of a
   * content stream that is not moving and not ready is not a slow start, it
   * is a stuck player, and the reload recovers it. */
  const CONTENT_STALL_MS = 10000;
  let contentStallSince = 0;
  // Content position, tracked only while NOT in an ad — during one, the
  // player's clock belongs to the ad.
  let lastContentTime = 0;
  let lastVideoId = "";
  // Escape-hatch throttle: more than 3 reloads in 30s means the reload route
  // is looping (a fresh ad on every reload) — stop and use the speed fallback.
  let reloadTimes = [];

  /* Everything the player paints for an ad: the container, the overlay layout
   * that carries the advertiser's title and "Sponsored" badge, and the banner
   * overlays. All of these only exist while a real ad is on, so hiding them
   * inline tells a bait probe nothing. */
  const AD_CHROME = [
    ".video-ads",
    ".ytp-ad-player-overlay",
    ".ytp-ad-player-overlay-layout",
    ".ytp-ad-overlay-container",
    ".ytp-ad-message-container",
  ].join(",");

  const moviePlayer = () => document.getElementById("movie_player");

  // The watch-page shell can keep player-unavailable after loadVideoById has
  // recovered the inner player. Its CSS hides a healthy video beneath error
  // 282054944. Clear the reflected flag only after real content advances;
  // never hide an error merely because formats exist or readyState is nonzero.
  let contentSample = null;
  const restorePlayableShell = (player, video) => {
    const previous = contentSample;
    contentSample = { video, time: video.currentTime };
    if (!previous || previous.video !== video || video.paused || video.ended ||
        video.readyState < 3 || video.currentTime <= previous.time + 0.05) return;
    const shell = player.closest?.("ytd-watch-flexy");
    if (!shell) return;
    if (shell.hasAttribute("player-unavailable")) {
      shell.removeAttribute("player-unavailable");
      DIAG.shellRecoveries += 1;
    }
    // In theater mode the error host can remain above the recovered player
    // even after that flag clears, intercepting its controls. Install this only
    // after content has advanced. A subsequent real unavailable state disables
    // the rule immediately, so new failures remain visible (including on SPA
    // navigation). Pausing healthy content must not resurrect the old error.
    if (shell.querySelector("#error-screen") &&
        !shell.querySelector("style[data-cab-shell-recovery]")) {
      const style = document.createElement("style");
      style.setAttribute("data-cab-shell-recovery", "");
      style.textContent = "ytd-watch-flexy:not([player-unavailable]) #error-screen { display: none !important; }";
      shell.appendChild(style);
    }
  };


  /* Primary escape: ask YouTube's own player to load the content video at the
   * position we were at. The ad break is simply abandoned — nothing to seek
   * through, nothing to complete, no completion signal to wait for. This is
   * the mechanism the surviving auto-skip projects settled on.
   *
   * Restored in 1.7.3. It was deleted by accident in 1.6.2: a block removal
   * that meant to take out the Skip-button experiment was bounded by "the
   * start of that block" and "the start of stomp", and this function lived
   * between the two. Nothing failed at load time — a missing function is only
   * a ReferenceError at the moment it is called — and it is called only when
   * a break or a hand-back has stalled for ten to twelve seconds. So every
   * suite stayed green, and on the exact occasions the watchdog was needed it
   * threw instead, taking the rest of stomp's tick with it: the cover stayed
   * on, the stall was never recovered, and Chrome logged
   * "reloadPastAd is not defined" against the extension. Reported from the
   * field 2026-09-03 with a screenshot of chrome://extensions. */
  const reloadPastAd = () => {
    const p = moviePlayer();
    if (!p) return false;
    const byId = p.loadVideoById;
    const byVars = p.loadVideoWithPlayerVars || p.loadVideoByPlayerVars;
    const data = typeof p.getVideoData === "function" ? p.getVideoData() : null;
    const videoId = (data && data.video_id) || idFromUrl(location.href);
    if ((typeof byId !== "function" && typeof byVars !== "function") || !videoId)
      return false;

    const now = Date.now();
    reloadTimes = reloadTimes.filter((t) => now - t < 30000);
    if (reloadTimes.length >= 3) return false;
    reloadTimes.push(now);

    // A pre-roll fires before any normal tick has seen the new video, so
    // lastContentTime still belongs to the PREVIOUS video. Resuming a new
    // video at the old position strands the user at (or past) the end.
    // Same video id → resume position; different id → start from 0.
    const start =
      videoId === lastVideoId ? Math.max(0, Math.floor(lastContentTime)) : 0;
    lastVideoId = videoId;
    lastContentTime = start;

    // loadVideoById is the call uBO's recovery uses; the player-vars form is
    // what this file used from 1.1.0 and stays as the fallback.
    if (typeof byId === "function") byId.call(p, videoId, start);
    else byVars.call(p, { videoId, start });
    report();
    return true;
  };

  /* ------------------------------------------------------------------ *
   * The dead player, and the way out of it.
   *
   * The state (from uBO's rule, and matching what 1.4.0 measured here as
   * "readyState 0, buffered 0, the bytes never come"): the player says it is
   * buffering, its own stats panel reports "0.00 s" of buffer and a "0x0"
   * resolution, and nothing changes. The response was fine; the media is
   * simply not sent for this playback session.
   *
   * The way out: ask again, differently. Each attempt reloads the video
   * through the player's own API at the position we were at, with the next
   * /youtubei/v1/player request rewritten by `recoveryStrategy`:
   *
   *   1. "channel"   — clientScreen: CHANNEL, i.e. the player a channel page
   *                    embeds. Same WEB client, different screen.
   *   2. "lactmilli" — params "8AUB" and a fresh lactMilliseconds.
   *   3. ""          — a plain reload, in case the first two were the problem.
   *
   * A strategy that worked is kept for the rest of the session, so later
   * videos do not each pay a stall before recovering. One that did not help
   * on the same video advances to the next; when all three have been tried on
   * one video it is left alone, and youtube-nag.js's page reload is the last
   * resort behind that.
   *
   * Three triggers, in order of how sure they are:
   *   - the player response itself says ERROR, or UNPLAYABLE with the
   *     "not available on this app" text (support answer 3037019);
   *   - the snackbar fired while the player was in the dead state (uBO's
   *     own arming condition);
   *   - the dead state has simply lasted CONTENT_STALL_MS.
   * ------------------------------------------------------------------ */
  const STRATEGIES = ["channel", "lactmilli", ""];
  let attempt = 0;
  let lastReloadKey = "";
  let exhaustedFor = "";
  let stuckSince = 0;
  /* When the last reload was asked for. The new player response takes a
   * round trip to arrive, and until it has, the old one is still what
   * getPlayerResponse() returns — so a dead response would re-trigger on the
   * very next tick and burn through every strategy in under a second. */
  let reloadedAt = 0;
  let reloadedResponse = null;
  let reloadedStatus = "";
  const RELOAD_GRACE_MS = 5000;

  const responseOf = (p) => {
    try { return p?.getPlayerResponse?.() || null; } catch { return null; }
  };
  const statusOf = (response) => {
    try { return nativeStringify(response?.playabilityStatus || null); } catch { return ""; }
  };
  // A fresh failed answer ends the wait for that request. Identity AND status
  // must change: a getter returning copies of the old error must not exhaust
  // every strategy. Identical/unknown answers retain the full safety grace.
  const freshFailedResponse = (p) => {
    const current = responseOf(p);
    return current && current !== reloadedResponse &&
      statusOf(current) !== reloadedStatus && deadResponse(p);
  };

  const statsOf = (p) => {
    try {
      return (typeof p.getStatsForNerds === "function" && p.getStatsForNerds()) || {};
    } catch {
      return {};
    }
  };

  const isStuck = () => {
    const p = moviePlayer();
    if (!p) return false;
    try {
      const st =
        typeof p.getPlayerStateObject === "function" ? p.getPlayerStateObject() : null;
      if (!st || !st.isBuffering) return false;
      const s = statsOf(p);
      /* The panel reports "current / optimal", e.g. "0x0@25 / 1920x1080@25"
       * (read live in Tristan's Chrome, 2026-09-03), so an exact "0x0" never
       * matched and this detector was silently dead on first contact. */
      return (
        String(s.buffer_health_seconds || "").startsWith("0.00") &&
        /^0x0(\b|@)/.test(String(s.resolution || ""))
      );
    } catch {
      return false;
    }
  };

  const UNAVAILABLE_HERE = /3037019|WEB_PAGE_TYPE_UNKNOWN/;
  const deadResponse = (p) => {
    try {
      const r = typeof p.getPlayerResponse === "function" ? p.getPlayerResponse() : null;
      const ps = r && r.playabilityStatus;
      if (!ps || !ps.errorScreen) return false;
      if (ps.status === "ERROR") return true;
      if (ps.status !== "UNPLAYABLE") return false;
      const es = ps.errorScreen;
      if (es.playerErrorMessageRenderer && es.playerErrorMessageRenderer.playerCaptchaViewModel)
        return false; // a captcha is for the viewer, not for us
      let text = "";
      try {
        text = nativeStringify(es);
      } catch {
        /* unstringifiable — treat as not ours */
      }
      return UNAVAILABLE_HERE.test(text);
    } catch {
      return false;
    }
  };

  const recoverPlayback = (why) => {
    const p = moviePlayer();
    // Unavailable/private/login-gated content has no media to buffer. Do not
    // misclassify that as transport starvation and reload it every ten seconds.
    try {
      const ps = p?.getPlayerResponse?.()?.playabilityStatus;
      if (ps?.status && ps.status !== 'OK' && ps.status !== 'ERROR' && !deadResponse(p))
        return false;
      if (ps?.errorScreen?.playerErrorMessageRenderer?.playerCaptchaViewModel) return false;
    } catch { /* player response not available yet */ }
    const data = p && typeof p.getVideoData === "function" ? p.getVideoData() : null;
    const videoId = (data && data.video_id) || idFromUrl(location.href);
    if (!videoId || exhaustedFor === videoId) return false;
    const key = recoveryStrategy + "|" + videoId;
    if (lastReloadKey === key) {
      attempt += 1;
      if (attempt >= STRATEGIES.length) {
        attempt = 0;
        recoveryStrategy = "";
        exhaustedFor = videoId;
        DIAG.recovery.exhaustedFor = videoId;
        return false;
      }
    }
    recoveryStrategy = STRATEGIES[attempt];
    lastReloadKey = recoveryStrategy + "|" + videoId;
    stuckSince = 0;
    snackbarWhileStuck = false;
    contentStallSince = 0;
    DIAG.recovery.attempt = attempt;
    DIAG.recovery.strategy = recoveryStrategy;
    DIAG.recovery.last = why + " " + new Date().toISOString().slice(11, 19);
    const previousResponse = responseOf(p);
    const previousStatus = statusOf(previousResponse);
    if (!reloadPastAd()) return false;
    reloadedResponse = previousResponse;
    reloadedStatus = previousStatus;
    DIAG.recovery.reloads += 1;
    reloadedAt = Date.now();
    return true;
  };

  /* ------------------------------------------------------------------ *
   * Why the Skip button is not pressed.
   *
   * A 2:30 skippable pre-roll is expensive even at 16x, because the cost is
   * the ad's bytes and not its playback rate, and a pod of two doubles it.
   * The obvious answer is the Skip button YouTube itself offers five seconds
   * in, and 1.6.2 shipped exactly that for a few hours. It does not work.
   *
   * Measured on a signed-in session, 2026-09-02, on a real break: the button
   * `button.ytp-skip-ad-button` was present and laid out, the ad clock was
   * already 21.8s (long past the five-second threshold), and it was clicked
   * 39 times across 15.5 seconds. The break ran to its end. A follow-up
   * probe with the extension's own layer disabled clicked the button, its
   * wrapper, its container and the element under the control's centre point,
   * with both `click()` and a full pointerdown/mousedown/pointerup/mouseup/
   * click sequence. Six attempts, no effect.
   *
   * So the 1.1.0 note was right and 1.6.2 was wrong to doubt it: the handler
   * wants `isTrusted`, and no page script can forge that.
   *
   * It is deliberately not left in as a harmless best-effort attempt, because
   * it is not harmless. Dispatching untrusted clicks at YouTube's own skip
   * button two and a half times a second, for the whole of every break, is a
   * behaviour a page can watch for directly — a click event on that element
   * with `isTrusted === false` is about as clean an adblocker signature as
   * exists. Paying a detection risk for a measured zero is the opposite of
   * what this file is for.
   *
   * What remains, if this is ever revisited: the player exposes
   * `onAdUxClicked` and `getAdState` on `movie_player`. Routing a skip
   * through YouTube's own API rather than a synthetic event might work, but
   * it is undocumented, the arguments are guesswork, and a malformed internal
   * signal is a worse failure than a slow ad. It was not shipped on that
   * basis.
   * ------------------------------------------------------------------ */

  /* Every `…Since` timestamp in here measures how long a condition has been
   * *observed* to hold, and the observation is a 250ms tick. When the tick
   * does not run — a background tab throttled to once a minute, a laptop that
   * slept, a debugger pause — the wall clock keeps moving and those timers
   * read as minutes of stalling that nobody actually watched. Caught by the
   * recovery suite: a forty-second gap fired a recovery on the very next
   * tick, before the new state of the page had been looked at even once.
   *
   * So a gap longer than a few ticks re-bases them. The condition may well
   * still hold; it gets timed again from here, on evidence. */
  let lastTick = 0;
  const TICK_GAP_MS = 2000;

  const stomp = () => {
    const tickNow = Date.now();
    if (lastTick && tickNow - lastTick > TICK_GAP_MS) {
      resumeSince = 0;
      starvedSince = 0;
      adSince = 0;
      adStalledSince = 0;
      contentStallSince = 0;
      stuckSince = 0;
    }
    lastTick = tickNow;

    const player = document.querySelector(".html5-video-player");
    if (!player) return;
    const inAd =
      player.classList.contains("ad-showing") ||
      player.classList.contains("ad-interrupting");
    const video = player.querySelector("video");

    if (!inAd) {
      adSince = 0;
      adFurthest = 0;
      adStalledSince = 0;
      /* The break is over, but the content stream is not ready: the player
       * spent the ad buffering the ad, and at 16x that ad was gone in a
       * second. What is on screen for the next few seconds is a stalled,
       * half-torn-down ad frame — the grey rectangle with the video outline.
       *
       * So the cover stays on until content actually moves, and the player
       * gets nudged the whole time. Black for four seconds beats grey for
       * four seconds, and the nudging usually makes it fewer than four. */
      if (saved && video) {
        video.muted = saved.muted;
        video.playbackRate = saved.rate;

        const moving = video.currentTime > (resumeFrom ?? -1) && !video.paused;
        const ready = video.readyState >= 3;
        if (resumeFrom === null) resumeFrom = video.currentTime;
        if (resumeSince === 0) resumeSince = Date.now();
        const waitedTooLong = Date.now() - resumeSince > RESUME_CAP_MS;

        starvedSince = 0;
        if ((moving && ready) || waitedTooLong) {
          video.style.opacity = saved.opacity;
          for (const [el, opacity] of saved.chrome) el.style.opacity = opacity;
          saved = null;
          resumeFrom = null;
          resumeSince = 0;
        } else {
          // Still covered. Keep asking the player to go.
          if (video.paused && !video.ended) video.play().catch(() => {});
        }
      }
      /* Whether the content is actually going, cover or no cover. This runs
       * after the hand-back above precisely so that lifting the cover does
       * not end the supervision: the four-second cap stops *hiding* a stuck
       * player from its owner, it does not mean the player is fine. */
      if (video) {
        const mp = moviePlayer();
        const now = Date.now();
        restorePlayableShell(player, video);
        pinFlags(window.ytcfg);

        /* The dead player, by YouTube's own account — see recoverPlayback. */
        let dead = "";
        const settling = now - reloadedAt < RELOAD_GRACE_MS && !freshFailedResponse(mp);
        const playing = !video.paused && !video.ended && video.readyState >= 3;
        if (settling) {
          /* a reload is in flight — judge the new response, not the old */
        } else if (!playing && mp && deadResponse(mp)) dead = "response";
        else if (isStuck()) {
          if (!stuckSince) stuckSince = now;
          if (snackbarWhileStuck) dead = "snackbar";
          else if (now - stuckSince > CONTENT_STALL_MS) dead = "stuck";
        } else {
          stuckSince = 0;
          snackbarWhileStuck = false;
        }
        if (dead && recoverPlayback(dead)) return;

        /* Starving, not merely stopped. A video the viewer paused sits at
         * readyState 3 or 4 with a full buffer and must never be touched;
         * only a stream with nothing decodable in it counts as stuck. The
         * player's own state is checked too, so a deliberate pause during a
         * slow patch is still left alone — and so is a player nobody has
         * started yet (unstarted -1, cued 5), which also sits at readyState
         * 0 and is not stuck, just waiting. */
        const state =
          mp && typeof mp.getPlayerState === "function" ? mp.getPlayerState() : NaN;
        const idle = state === 2 || state === -1 || state === 5;
        const starving = video.readyState < 3 && !video.ended && !idle;
        if (!starving) {
          contentStallSince = 0;
        } else {
          if (!contentStallSince) contentStallSince = now;
          if (video.paused) video.play().catch(() => {});
          if (now - contentStallSince > CONTENT_STALL_MS) {
            contentStallSince = 0;
            if (recoverPlayback("starving")) return;
          }
        }
      }

      const p = moviePlayer();
      if (p && typeof p.getCurrentTime === "function") {
        const t = p.getCurrentTime();
        if (isFinite(t) && t > 0) lastContentTime = t;
      }
      if (p && typeof p.getVideoData === "function") {
        const id = (p.getVideoData() || {}).video_id || "";
        if (id && id !== lastVideoId) {
          lastVideoId = id;
          lastContentTime = 0; // new video, stale position would skip real content
        }
      }
      return;
    }

    contentSample = null; // an ad clock is not evidence of content recovery
    if (video && !saved) {
      DIAG.adStarts += 1;
      saved = {
        muted: video.muted,
        rate: video.playbackRate,
        opacity: video.style.opacity,
        chrome: new Map(),
      };
    }
    if (video) {
      video.muted = true;
      video.style.opacity = "0";
    }
    /* The ad's own furniture, not just its picture. Hiding the <video> alone
     * still left the advertiser's title and "Sponsored" badge painted over the
     * black — caught on a screenshot of a real break, which is the only way
     * that sort of thing ever gets caught. */
    if (saved) {
      for (const el of player.querySelectorAll(AD_CHROME)) {
        if (!saved.chrome.has(el)) saved.chrome.set(el, el.style.opacity);
        el.style.opacity = "0";
      }
    }

    // YouTube Music's player lacks the reload API; there, the simple
    // jump-to-end works (its ads are plain separate clips).
    if (location.hostname === "music.youtube.com") {
      if (video && isFinite(video.duration) && video.duration > 0) {
        video.currentTime = video.duration;
      }
      return;
    }

    /* Only 'prune' abandons the break. Bailing out of an ad leaves its
     * completion ping unsent, which is precisely the hole a detector looks
     * through — so stealth never does it, and falls through to running the ad
     * at speed instead, letting the player report it normally. */
    if (MODE === "prune") {
      /* A server-stitched ad is part of the content stream, so reloading the
       * content just serves it again. The player's stats panel names the
       * state ("SSAP, AD…"), and uBO's answer is to seek past it through the
       * player's own API. The mute and the cover above already hold. */
      const mp = moviePlayer();
      const s = mp ? statsOf(mp) : {};
      if (
        mp &&
        String(s.debug_info || "").startsWith("SSAP, AD") &&
        typeof mp.getProgressState === "function" &&
        typeof mp.seekTo === "function"
      ) {
        const ps = mp.getProgressState();
        if (ps && ps.duration > 0 && ps.current < ps.duration) {
          mp.seekTo(ps.duration);
          report();
          return;
        }
      }
      if (reloadPastAd()) return;
    }

    /* Speed through, but only as fast as the buffer can feed it: 16x on a
     * starving stream stalls forever, which was the second-ad freeze.
     *
     * The old fallback dropped straight from 16x to 1x on any dip below
     * readyState 3, and measurement showed that is far too timid — a 13.3s
     * break spent 35 of its 53 samples crawling at normal speed. A starved
     * stream now gets 4x first, which still drains the ad several times faster
     * than watching it while letting the buffer refill, and only a stream that
     * stays starved for two full seconds falls back to 1x. */
    /* Has this break moved at all lately? An ad whose bytes never come sits
     * at readyState 0 with the clock frozen, and speeding up a stream that is
     * not arriving does nothing — 16x of nothing is still nothing. */
    if (video) {
      const now = Date.now();
      if (!adSince) adSince = now;
      if (video.currentTime > adFurthest + 0.05) {
        adFurthest = video.currentTime;
        adStalledSince = 0;
      } else if (video.currentTime + 1 < adFurthest) {
        /* The clock went backwards while still in the break: this is the next
         * ad in a pod, not a stalled one. Measured on a signed-in session
         * 2026-09-02 — the ad clock ran 22, 42, 49, 54, 71 and then restarted
         * at 0.
         *
         * Without this the watchdog was catastrophically wrong about exactly
         * the case it matters most for. `adFurthest` stayed at the first ad's
         * 71s, the second ad's clock could never beat it, so every sample
         * looked like no progress, and twelve seconds in the break was
         * abandoned through the reload — which is the one thing stealth exists
         * not to do, because it leaves the impression unsent. A pod of two was
         * therefore the single most likely way for this extension to look like
         * an adblocker to YouTube. */
        DIAG.adStarts += 1;
        adFurthest = video.currentTime;
        adStalledSince = 0;
      } else if (!adStalledSince) {
        adStalledSince = now;
      }

      if (adStalledSince && now - adStalledSince > AD_STALL_MS) {
        /* Last resort. The break is not going to finish on its own, so it is
         * abandoned the same way `prune` abandons one: reload the content
         * video at the position we were at. The impression goes unsent, which
         * is a cost — but the alternative measured on Tristan's session was a
         * minute of grey and a player that never recovered, and an extension
         * that hands back a dead page has already lost whatever it was
         * protecting. Throttled to three reloads per 30s by reloadPastAd. */
        adSince = 0;
        adFurthest = 0;
        adStalledSince = 0;
        if (reloadPastAd()) return;
      }
    }

    if (video) {
      let target;
      if (video.readyState >= 3) {
        starvedSince = 0;
        target = 16;
      } else {
        if (!starvedSince) starvedSince = Date.now();
        target = Date.now() - starvedSince > 2000 ? 1 : 4;
      }
      if (video.playbackRate !== target) video.playbackRate = target;
      if (video.paused && !video.ended) video.play().catch(() => {});

      /* Tried and rejected: jumping the playhead to the buffered edge instead
       * of playing up to it. It sounds like it should be free — the bytes have
       * already arrived — but under SABR a seek makes the server restart the
       * stream from the new position, so the buffer is thrown away and
       * refetched. Measured on live breaks: 8-10s became 14.3s. The break is
       * bounded by how fast YouTube ships the ad, and there is no way around
       * that while the ad is genuinely being played. */
    }
  };

  const start = () => {
    // 'hooks' keeps the JSON interception and skips all playback handling.
    if (LAYER === "hooks") return;
    const target = document.body || document.documentElement;
    new MutationObserver(stomp).observe(target, {
      attributes: true,
      attributeFilter: ["class"],
      subtree: true,
    });
    // 250ms rather than 500: the class change is caught by the observer, but
    // the hand-back after a break is a polled condition (has content actually
    // started moving?) and a coarser poll shows as a longer black hold.
    setInterval(stomp, 250);
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
