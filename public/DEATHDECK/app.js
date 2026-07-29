(() => {
  const $ = (id) => document.getElementById(id);
  try {
    localStorage.removeItem('deathdeck-theme');
    document.documentElement.classList.remove('deck-dark');
  } catch {
    /* ignore */
  }

  const state = {
    tab: 'home',
    aiHistory: [],
    nes: null,
    arcade: null,
    keys: new Set(),
  };

  async function api(url, opts = {}) {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      ...opts,
    });
    let data = {};
    const raw = await res.text();
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = {
        ok: false,
        error:
          res.status === 404
            ? 'rota offline — reinicia o server'
            : `resposta inválida (${res.status})`,
      };
    }
    if (typeof data.status !== 'number') data.status = res.status;
    if (data.ok == null) data.ok = res.ok;
    return data;
  }

  let toastTimer = null;
  function notify(msg, ms = 2800) {
    const el = $('deckToast');
    if (!el) return;
    el.hidden = false;
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.remove('on');
      setTimeout(() => {
        if (!el.classList.contains('on')) el.hidden = true;
      }, 220);
    }, ms);
  }

  function isFullscreen() {
    return !!(
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone
    );
  }

  function syncFsBtn() {
    const on = !!(document.fullscreenElement || document.webkitFullscreenElement);
    document.querySelectorAll('.deck-fs-btn').forEach((btn) => {
      btn.textContent = on ? 'sair tela cheia' : 'tela cheia';
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    document.body.classList.toggle('deck-fs', on || isFullscreen());
  }

  async function toggleFullscreen() {
    const leaving = !!(document.fullscreenElement || document.webkitFullscreenElement);
    try {
      const root = document.documentElement;
      if (leaving) {
        if (document.exitFullscreen) await document.exitFullscreen();
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      } else if (root.requestFullscreen) {
        await root.requestFullscreen({ navigationUI: 'hide' });
      } else if (root.webkitRequestFullscreen) {
        root.webkitRequestFullscreen();
      } else {
        notify('no Chrome: ⋮ → Instalar app / Adicionar à tela inicial');
        showFsTip(true);
        return;
      }
    } catch {
      notify('se não abrir: ⋮ do Chrome → Instalar app (sem barra)');
      showFsTip(true);
    }
    setTimeout(syncFsBtn, 80);
    if (!leaving) showFsTip();
  }

  function showFsTip(force = false) {
    if (!force && sessionStorage.getItem('voidwire-fs-tip-v2') === '1') return;
    const tip = $('deckFsTip');
    if (!tip) return;
    tip.hidden = false;
    requestAnimationFrame(() => tip.classList.add('on'));
  }

  function hideFsTip() {
    const tip = $('deckFsTip');
    if (!tip) return;
    tip.classList.remove('on');
    sessionStorage.setItem('voidwire-fs-tip-v2', '1');
    setTimeout(() => {
      if (!tip.classList.contains('on')) tip.hidden = true;
    }, 220);
  }

  function isMobileDeck() {
    return (
      window.matchMedia('(max-width: 820px)').matches ||
      /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '')
    );
  }

  function showWelcome() {
    const el = $('deckWelcome');
    if (!el) return;
    document.body.classList.add('deck-welcome-open');
    el.setAttribute('aria-hidden', 'false');
    el.classList.add('on');
    window.__DECK_WELCOME_PENDING = true;
  }

  function hideWelcome() {
    const el = $('deckWelcome');
    if (!el) return;
    el.classList.remove('on');
    el.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('deck-welcome-open');
    window.__DECK_WELCOME_PENDING = false;
  }

  function wireWelcome() {
    // montagem / welcome só no mobile
    if (!isMobileDeck()) {
      hideWelcome();
      return;
    }
    const params = new URLSearchParams(location.search);
    const force = params.get('welcome') === '1' || params.get('boot') === '1';
    let done = false;
    try {
      done = localStorage.getItem('voidwire-boot-done-v3') === '1';
    } catch {
      done = false;
    }

    const el = $('deckWelcome');
    const pending = !!(el && el.classList.contains('on')) || window.__DECK_WELCOME_PENDING;

    if (!force && done && !pending) {
      hideWelcome();
      return;
    }
    if (!done || force || pending) showWelcome();

    const go = $('deckWelcomeGo');
    if (!go || go.dataset.wired === '1') return;
    go.dataset.wired = '1';
    go.addEventListener('click', async () => {
      go.disabled = true;
      hideWelcome();
      try {
        await playDeckAssemble();
      } catch (err) {
        console.warn('assemble', err);
      } finally {
        try {
          localStorage.setItem('voidwire-boot-done-v3', '1');
          localStorage.setItem('voidwire-boot-done', '1');
          localStorage.setItem('voidwire-welcome-v2', '1');
          localStorage.setItem('voidwire-welcome-v1', '1');
        } catch {
          /* ignore */
        }
        go.disabled = false;
        try {
          window.__DECK_MAYBE_INSTALL?.();
        } catch {
          /* ignore */
        }
        try {
          window.__DECK_APP_BOOT?.();
        } catch {
          /* ignore */
        }
      }
    });
  }

  /* —— instalar app (Android prompt / iOS instrução) —— */
  const InstallApp = (() => {
    const STORE = 'voidwire-install-dismiss-v1';
    let deferred = null;
    let wired = false;

    function isStandalone() {
      try {
        if (window.matchMedia('(display-mode: standalone)').matches) return true;
        if (window.matchMedia('(display-mode: fullscreen)').matches) return true;
        if (navigator.standalone === true) return true;
      } catch {
        /* ignore */
      }
      return false;
    }

    function isIos() {
      const ua = navigator.userAgent || '';
      if (/iPhone|iPad|iPod/i.test(ua)) return true;
      return /Macintosh/i.test(ua) && navigator.maxTouchPoints > 1;
    }

    function isAndroid() {
      return /Android/i.test(navigator.userAgent || '');
    }

    function dismissed() {
      try {
        return localStorage.getItem(STORE) === '1';
      } catch {
        return false;
      }
    }

    function markDismissed() {
      try {
        localStorage.setItem(STORE, '1');
      } catch {
        /* ignore */
      }
    }

    function clearDismissed() {
      try {
        localStorage.removeItem(STORE);
      } catch {
        /* ignore */
      }
    }

    function registerSw() {
      if (!('serviceWorker' in navigator)) return;
      const url = new URL('sw.js', location.href);
      navigator.serviceWorker.register(url.href).catch(() => {});
    }

    function iosStepsHtml() {
      return (
        '<li>toca <strong>Compartilhar</strong> (□↑) embaixo no Safari</li>' +
        '<li>desce e toca <strong>Adicionar à Tela de Início</strong></li>' +
        '<li>confirma <strong>Adicionar</strong></li>'
      );
    }

    function fillTipCopy() {
      const body = $('deckInstallTipBody');
      const list = $('deckInstallTipList');
      const ok = $('deckInstallTipOk');
      if (!body || !ok) return;
      if (isIos()) {
        body.textContent =
          'No iPhone/iPad o Safari não deixa instalar automático — é pelo compartilhar:';
        if (list) {
          list.hidden = false;
          list.innerHTML = iosStepsHtml();
        }
        ok.textContent = 'entendi';
      } else if (deferred) {
        body.textContent =
          'Vira app na home: abre mais rápido, tela cheia e sem barra do Chrome.';
        if (list) {
          list.hidden = true;
          list.innerHTML = '';
        }
        ok.textContent = 'instalar';
      } else {
        body.textContent = isAndroid()
          ? 'No Chrome: menu ⋮ → Instalar app / Adicionar à tela inicial.'
          : 'No navegador: menu → Instalar app / Adicionar à tela inicial.';
        if (list) {
          list.hidden = true;
          list.innerHTML = '';
        }
        ok.textContent = 'entendi';
      }
    }

    function syncPane() {
      const status = $('deckAppStatus');
      const steps = $('deckAppSteps');
      const btn = $('deckAppInstall');
      const lead = $('deckAppLead');
      const hint = $('deckAppHint');
      if (!status || !btn) return;

      if (isStandalone()) {
        status.textContent = 'já instalado · abrindo como app';
        if (lead) {
          lead.textContent =
            'Este aparelho já tem o DEATHDECK na home. Pode fechar o navegador e abrir pelo ícone.';
        }
        if (steps) {
          steps.hidden = true;
          steps.innerHTML = '';
        }
        btn.hidden = true;
        if (hint) hint.textContent = 'standalone · ok';
        return;
      }

      btn.hidden = false;
      if (isIos()) {
        status.textContent = 'iPhone / iPad · Safari';
        if (lead) {
          lead.textContent =
            'No iOS não tem botão mágico — é pelo Compartilhar. Passo a passo abaixo (se fechou o aviso, usa esta aba).';
        }
        if (steps) {
          steps.hidden = false;
          steps.innerHTML = iosStepsHtml();
        }
        btn.textContent = 'ver de novo';
        if (hint) hint.textContent = 'Safari → Compartilhar → Adicionar à Tela de Início';
        return;
      }

      if (deferred) {
        status.textContent = 'pronto pra instalar';
        if (lead) {
          lead.textContent =
            'Chrome liberou o install. Toca o botão — se tinha clicado “agora não”, ainda dá pra instalar daqui.';
        }
        if (steps) {
          steps.hidden = true;
          steps.innerHTML = '';
        }
        btn.textContent = 'instalar app';
        if (hint) hint.textContent = 'Android / Chrome · HTTPS';
        return;
      }

      status.textContent = isAndroid() ? 'Android · Chrome' : 'navegador';
      if (lead) {
        lead.textContent =
          'O aviso automático some se você toca “agora não”. Daqui você instala de novo (ou pelo menu do navegador).';
      }
      if (steps) {
        steps.hidden = false;
        steps.innerHTML = isAndroid()
          ? '<li>Chrome → menu <strong>⋮</strong></li><li><strong>Instalar app</strong> ou <strong>Adicionar à tela inicial</strong></li>'
          : '<li>menu do navegador</li><li><strong>Instalar app</strong> / <strong>Adicionar à tela inicial</strong></li>';
      }
      btn.textContent = 'tentar instalar';
      if (hint) hint.textContent = 'se o botão não abrir o prompt, usa o menu do navegador';
    }

    function isBootBusy() {
      if (document.body.classList.contains('deck-assembling')) return true;
      if (document.body.classList.contains('deck-welcome-open')) return true;
      if (document.body.classList.contains('deck-assemble-freeze')) return true;
      if ($('deckWelcome')?.classList.contains('on')) return true;
      if (window.__DECK_WELCOME_PENDING) return true;
      if ($('deckAssembleHud') && !$('deckAssembleHud').hidden) return true;
      return false;
    }

    function show() {
      if (isBootBusy()) return;
      const tip = $('deckInstallTip');
      if (!tip || tip.classList.contains('on')) return;
      fillTipCopy();
      tip.hidden = false;
      requestAnimationFrame(() => tip.classList.add('on'));
    }

    function hide(persist) {
      const tip = $('deckInstallTip');
      if (!tip) return;
      tip.classList.remove('on');
      if (persist) markDismissed();
      setTimeout(() => {
        if (!tip.classList.contains('on')) tip.hidden = true;
      }, 220);
      syncPane();
    }

    function stashDuringBoot() {
      const tip = $('deckInstallTip');
      if (!tip) return;
      tip.classList.remove('on');
      tip.hidden = true;
    }

    async function runInstall() {
      if (isStandalone()) {
        notify('já tá instalado');
        syncPane();
        return;
      }
      if (isIos()) {
        clearDismissed();
        show();
        return;
      }
      if (deferred) {
        const promptEvent = deferred;
        deferred = null;
        try {
          promptEvent.prompt();
          const choice = await promptEvent.userChoice;
          markDismissed();
          if (choice?.outcome === 'accepted') notify('app na home · sucesso');
          else notify('install cancelado · tenta de novo na aba APP');
        } catch {
          notify('não abriu o install · usa o menu do Chrome');
        }
        syncPane();
        return;
      }
      clearDismissed();
      show();
      notify('se não aparecer o prompt, usa o menu ⋮ do Chrome');
      syncPane();
    }

    function maybeShow() {
      if (!isMobileDeck()) return;
      if (isStandalone()) return;
      if (dismissed()) return;
      if (isBootBusy()) return;
      show();
    }

    function onEnter() {
      syncPane();
    }

    function wire() {
      if (wired) return;
      wired = true;
      registerSw();
      window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferred = e;
        fillTipCopy();
        syncPane();
      });
      window.addEventListener('appinstalled', () => {
        deferred = null;
        markDismissed();
        hide(false);
        syncPane();
        notify('app instalado');
      });
      $('deckInstallTipLater')?.addEventListener('click', () => hide(true));
      $('deckInstallTipOk')?.addEventListener('click', async () => {
        if (isIos() || !deferred) {
          hide(true);
          return;
        }
        await runInstall();
        hide(false);
      });
      $('deckAppInstall')?.addEventListener('click', () => runInstall());
      window.__DECK_MAYBE_INSTALL = () => {
        setTimeout(maybeShow, 700);
      };
      syncPane();
      /* não dispara no meio do welcome/assemble da 1ª visita */
      setTimeout(() => {
        let bootDone = false;
        try {
          bootDone = localStorage.getItem('voidwire-boot-done-v3') === '1';
        } catch {
          bootDone = false;
        }
        if (!bootDone || isBootBusy()) return;
        maybeShow();
      }, 1800);
    }

    return { wire, maybeShow, onEnter, syncPane, isStandalone, stashDuringBoot };
  })();

  /* —— splash ao abrir o app instalado —— */
  const AppBoot = (() => {
    const STORE = 'voidwire-app-boot-v1';
    let skipping = false;
    let running = false;

    function alreadyPlayed() {
      try {
        return sessionStorage.getItem(STORE) === '1';
      } catch {
        return false;
      }
    }

    function markPlayed() {
      try {
        sessionStorage.setItem(STORE, '1');
      } catch {
        /* ignore */
      }
    }

    function setLine(text) {
      const el = $('deckAppBootLine');
      if (el) el.textContent = text;
    }

    async function play() {
      if (running) return;
      if (!InstallApp.isStandalone()) return;
      if (alreadyPlayed()) return;
      if (document.body.classList.contains('deck-welcome-open')) return;
      if ($('deckWelcome')?.classList.contains('on')) return;

      const el = $('deckAppBoot');
      if (!el) return;
      running = true;
      skipping = false;
      markPlayed();
      el.hidden = false;
      el.setAttribute('aria-hidden', 'false');
      document.body.classList.add('deck-app-booting');
      setLine('BOOT · APP');
      requestAnimationFrame(() => el.classList.add('on'));

      const skipBtn = $('deckAppBootSkip');
      if (skipBtn) {
        skipBtn.hidden = false;
        skipBtn.onclick = () => {
          skipping = true;
        };
      }

      const wait = async (ms) => {
        const step = 40;
        let t = 0;
        while (t < ms && !skipping) {
          await sleep(step);
          t += step;
        }
      };

      try {
        await wait(280);
        if (!skipping) setLine('SIGNAL · LIVE');
        el.classList.add('phase-signal');
        await wait(420);
        if (!skipping) setLine('DECK · ONLINE');
        el.classList.add('phase-ready');
        await wait(520);
        if (!skipping) setLine('OK');
        await wait(280);
      } finally {
        el.classList.add('out');
        el.classList.remove('on');
        await sleep(380);
        el.classList.remove('out', 'phase-signal', 'phase-ready');
        el.hidden = true;
        el.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('deck-app-booting');
        if (skipBtn) {
          skipBtn.hidden = true;
          skipBtn.onclick = null;
        }
        running = false;
      }
    }

    function wire() {
      window.__DECK_APP_BOOT = () => {
        setTimeout(() => play(), 200);
      };
      setTimeout(() => play(), 400);
    }

    return { wire, play };
  })();

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  let assembleSkip = false;
  let assembleRunning = false;

  function setAssembleLine(text) {
    const line = $('deckAssembleLine');
    if (line) line.textContent = text;
  }

  function showAssembleHud(on) {
    const hud = $('deckAssembleHud');
    const lock = $('deckAssembleLock');
    if (hud) {
      if (on) {
        hud.hidden = false;
        requestAnimationFrame(() => hud.classList.add('on'));
      } else {
        hud.classList.remove('on');
        setTimeout(() => {
          if (!hud.classList.contains('on')) hud.hidden = true;
        }, 280);
      }
    }
    if (lock) {
      if (on) {
        lock.hidden = false;
        requestAnimationFrame(() => lock.classList.add('on'));
      } else {
        lock.classList.remove('on');
        setTimeout(() => {
          if (!lock.classList.contains('on')) lock.hidden = true;
        }, 280);
      }
    }
  }

  function freezeAssembleInput(on) {
    document.documentElement.classList.toggle('deck-assemble-freeze', on);
    document.body.classList.toggle('deck-assemble-freeze', on);
  }

  function blockAssembleEvent(e) {
    if (!assembleRunning && !document.body.classList.contains('deck-assembling')) return;
    e.preventDefault();
    e.stopPropagation();
    return false;
  }

  async function typeAssemble(el, text, cps = 32) {
    if (!el) return;
    const full = text ?? '';
    el.textContent = '';
    el.classList.add('assemble-typing');
    for (let i = 0; i < full.length; i += 1) {
      if (assembleSkip) {
        el.textContent = full;
        break;
      }
      el.textContent = full.slice(0, i + 1);
      await sleep(cps);
    }
    el.classList.remove('assemble-typing');
  }

  function markAssembleBits(root) {
    if (!root) return [];
    const found = [
      ...root.querySelectorAll(
        [
          '.eyebrow',
          '.lede',
          '.section-title',
          '.home-actions',
          '.fx-panel',
          '.stat-row',
          '.boot-tape',
          '.cover-plate',
          '.track',
          '.hint-line',
          '.timeline > li',
          '.band-card',
          '.disc-card',
          '.link-card',
          '.out-card',
          '.play-shell > *',
          '.comms-lobby > *:not([hidden])',
          '.comms-room > *:not([hidden])',
          'figure',
          'h2',
          'h3',
          'img',
        ].join(',')
      ),
    ];
    const out = [];
    const seen = new Set();
    for (const el of found) {
      if (seen.has(el)) continue;
      if ([...seen].some((p) => p.contains(el))) continue;
      seen.add(el);
      out.push(el);
      if (out.length >= 18) break;
    }
    return out;
  }

  async function assembleElement(el, opts = {}) {
    if (!el) return;
    if (assembleSkip) {
      el.classList.add('is-assembled');
      return;
    }
    const text = (el.textContent || '').trim();
    const typeIt =
      opts.type ||
      (el.matches('.section-title, .eyebrow, h2, h3') && text.length > 0 && text.length <= 64);
    if (typeIt) {
      const original = el.textContent;
      el.classList.add('is-assembled', 'assemble-typing');
      await typeAssemble(el, original, opts.cps || 12);
      return;
    }
    if (el.matches('img, .cover-plate, figure') || el.querySelector?.(':scope > img')) {
      el.classList.add('is-assembled', 'assemble-img');
      await sleep(opts.dwell ?? 95);
      return;
    }
    el.classList.add('is-assembled');
    await sleep(opts.dwell ?? 42);
  }

  async function assemblePane(pane) {
    if (!pane) return;
    const bits = markAssembleBits(pane);
    bits.forEach((el) => el.classList.remove('is-assembled', 'assemble-img', 'assemble-typing'));
    pane.classList.add('assemble-pane-active');
    for (const el of bits) {
      if (assembleSkip) {
        bits.forEach((b) => b.classList.add('is-assembled'));
        break;
      }
      await assembleElement(el);
    }
    pane.classList.remove('assemble-pane-active');
  }

  function clearAssembleMarks() {
    document.querySelectorAll('.is-assembled, .assemble-img, .assemble-typing, .assemble-pane-active').forEach((el) => {
      el.classList.remove('is-assembled', 'assemble-img', 'assemble-typing', 'assemble-pane-active');
    });
    document.body.classList.remove(
      'deck-assembling',
      'assemble-frame',
      'assemble-mast',
      'assemble-tabs',
      'assemble-viewport',
      'assemble-foot'
    );
  }

  async function playDeckAssemble() {
    if (assembleRunning) return;
    if (!isMobileDeck()) return;

    assembleRunning = true;
    assembleSkip = false;
    try {
      InstallApp.stashDuringBoot?.();
    } catch {
      /* ignore */
    }
    const startTab = state.tab || 'home';
    const locked = document.body.classList.contains('comms-locked');
    const brand = document.querySelector('.brand');
    const model = document.querySelector('.model');
    const brandText = brand?.textContent || 'Panchiko';
    const modelText = model?.textContent || 'D>E>A>T>H>D>E>C>K';
    const chips = [...document.querySelectorAll('.mast-meta .chip, .mast-meta .deck-fs-btn')];
    const tabs = [...document.querySelectorAll('#tabs .tab')];
    const sessions = ['home', 'ep', 'hunt', 'wbm', 'band', 'rot', 'disco', 'play', 'link', 'comms', 'app', 'out'];

    clearAssembleMarks();
    document.body.classList.add('deck-assembling');
    freezeAssembleInput(true);
    showAssembleHud(true);
    setAssembleLine('BOOT · DEATHDECK');
    if (brand) brand.textContent = '';
    if (model) model.textContent = '';
    chips.forEach((c) => c.classList.remove('is-assembled'));
    tabs.forEach((t) => t.classList.remove('is-assembled'));

    const lock = $('deckAssembleLock');
    const blockOpts = { capture: true, passive: false };
    const onBlock = (e) => blockAssembleEvent(e);
    const onKeyBlock = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    ['pointerdown', 'pointerup', 'click', 'touchstart', 'touchmove', 'touchend', 'wheel', 'contextmenu'].forEach((type) => {
      lock?.addEventListener(type, onBlock, blockOpts);
      window.addEventListener(type, onBlock, blockOpts);
    });
    window.addEventListener('keydown', onKeyBlock, true);

    try {
      await sleep(280);
      if (!assembleSkip) {
        document.body.classList.add('assemble-frame');
        setAssembleLine('FRAME · chassis');
        await sleep(320);
      }

      document.body.classList.add('assemble-mast');
      setAssembleLine('MAST · brand');
      await typeAssemble(brand, brandText, 38);
      setAssembleLine('MAST · model');
      await typeAssemble(model, modelText, 14);
      for (const chip of chips) {
        if (assembleSkip) break;
        chip.classList.add('is-assembled');
        setAssembleLine(`CHIP · ${chip.textContent.trim().slice(0, 18) || 'meta'}`);
        await sleep(70);
      }

      document.body.classList.add('assemble-tabs');
      setAssembleLine('TABS · session map');
      for (const tab of tabs) {
        if (assembleSkip) break;
        tab.classList.add('is-assembled');
        setAssembleLine(`TAB · ${tab.textContent.trim()}`);
        await sleep(65);
      }

      document.body.classList.add('assemble-viewport');
      const tour = locked ? ['comms'] : sessions;
      for (const id of tour) {
        if (assembleSkip) break;
        setTab(id, { fromAssemble: true });
        setAssembleLine(`SESSION · ${id.toUpperCase()}`);
        await sleep(90);
        await assemblePane($(`pane-${id}`));
        await sleep(120);
      }

      if (!assembleSkip) {
        document.body.classList.add('assemble-foot');
        setAssembleLine('FOOT · rail live');
        await sleep(260);
        setAssembleLine('OK · DEATHDECK ONLINE');
        await sleep(420);
      } else {
        sessions.forEach((id) => {
          const pane = $(`pane-${id}`);
          if (!pane) return;
          markAssembleBits(pane).forEach((el) => el.classList.add('is-assembled'));
        });
        chips.forEach((c) => c.classList.add('is-assembled'));
        tabs.forEach((t) => t.classList.add('is-assembled'));
        if (brand) brand.textContent = brandText;
        if (model) model.textContent = modelText;
      }

      setTab(locked ? 'comms' : startTab, { fromAssemble: true });
    } finally {
      ['pointerdown', 'pointerup', 'click', 'touchstart', 'touchmove', 'touchend', 'wheel', 'contextmenu'].forEach((type) => {
        lock?.removeEventListener(type, onBlock, blockOpts);
        window.removeEventListener(type, onBlock, blockOpts);
      });
      window.removeEventListener('keydown', onKeyBlock, true);
      showAssembleHud(false);
      freezeAssembleInput(false);
      await sleep(180);
      clearAssembleMarks();
      if (brand && !brand.textContent) brand.textContent = brandText;
      if (model && !model.textContent) model.textContent = modelText;
      assembleRunning = false;
      assembleSkip = false;
    }
  }

  function wireFullscreen() {
    document.querySelectorAll('.deck-fs-btn').forEach((btn) => {
      btn.addEventListener('click', toggleFullscreen);
    });
    document.addEventListener('fullscreenchange', syncFsBtn);
    document.addEventListener('webkitfullscreenchange', syncFsBtn);
    $('deckFsTipOk')?.addEventListener('click', hideFsTip);
    $('deckFsTip')?.addEventListener('click', (e) => {
      if (e.target === $('deckFsTip')) hideFsTip();
    });
    syncFsBtn();
  }

  function tickClock() {
    const d = new Date();
    $('clock').textContent =
      `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  /* —— Tabs —— */
  function setTab(id, opts = {}) {
    if (document.body.classList.contains('deck-assembling') && !opts.fromAssemble) {
      return;
    }
    if (document.body.classList.contains('comms-locked') && id !== 'comms') {
      return;
    }
    if (!document.querySelector(`.pane[data-pane="${id}"]`)) {
      id = 'home';
    }
    state.tab = id;
    document.body.dataset.tab = id;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === id));
    document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('on', p.dataset.pane === id));

    const activeTabBtn = document.querySelector(`.tab[data-tab="${id}"]`);
    if (activeTabBtn && typeof activeTabBtn.scrollIntoView === 'function') {
      try {
        activeTabBtn.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
      } catch {
        activeTabBtn.scrollIntoView(false);
      }
    }

    if (id === 'comms') Comms.onEnter();
    else Comms.onLeaveTab();

    if (id === 'rot') RotViz.start();
    else RotViz.stop();

    if (id === 'play') {
      AlbumPlayer.ensure();
      AlbumPlayer.startViz?.();
    } else {
      AlbumPlayer.stopViz?.();
    }

    if (id === 'wbm') Wbm.onEnter();
    if (id === 'app') InstallApp.onEnter();

    if (window.DeckToys) {
      window.DeckToys.stopAll();
    }

    if (!document.body.classList.contains('comms-locked') && window.matchMedia('(max-width: 720px)').matches) {
      requestAnimationFrame(() => {
        try {
          window.scrollTo({ top: 0, behavior: 'smooth' });
        } catch {
          window.scrollTo(0, 0);
        }
      });
    }
  }

  document.getElementById('tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab]');
    if (btn) setTab(btn.dataset.tab);
  });
  document.querySelectorAll('[data-jump]').forEach((btn) => {
    btn.addEventListener('click', () => setTab(btn.dataset.jump));
  });

  /* —— Boot / status —— */
  async function bootHome() {
    const tape = $('bootTape');
    if (tape) tape.textContent = 'Panchiko D>E>A>T>H>D>E>C>K · reading oxfam cdr…\n';
    try {
      const [status, ai] = await Promise.all([
        api('/api/deck/status'),
        api('/api/deck/ai/status'),
      ]);

      $('aiChip').textContent = ai.ready ? `CD-R · ${ai.model || 'ok'}` : 'CD-R · OFF';
      $('aiChip').classList.toggle('live', !!ai.ready);
      $('aiChip').classList.toggle('warn', !ai.ready);
      $('pyChip').textContent = status.python ? 'PY · OK' : 'PY · OFF';
      $('pyChip').classList.toggle('live', !!status.python);
      $('pyChip').classList.toggle('warn', !status.python);
      $('netPill').textContent = status.python && ai.ready ? '/mu/ HOT' : 'SIGNAL WEAK';

      if ($('homeStats')) {
        $('homeStats').innerHTML = `
          <div class="stat"><span>YEAR</span><strong>2000</strong></div>
          <div class="stat"><span>COPIES</span><strong>~30 CD-R</strong></div>
          <div class="stat"><span>FOUND</span><strong>Oxfam /mu/</strong></div>
          <div class="stat"><span>GHOST</span><strong>${ai.ready ? 'CD-R LIVE' : 'NO KEY'}</strong></div>`;
      }

      if (tape) {
        tape.textContent += `cover …… manga scan + Haettenschweiler + Arial\n`;
        tape.textContent += `audio …… disc rot / bedroom demo / not death metal\n`;
        tape.textContent += `python …… ${status.python ? 'OK' : status.error || 'fail'}\n`;
        tape.textContent += `cd-r …… ${ai.ready ? 'OK · ' + (ai.model || '') : 'missing gemini key'}\n`;
        tape.textContent += '\nplease reinsert disc.';
      }
    } catch (err) {
      $('aiChip').textContent = 'CD-R · ERR';
      $('aiChip').classList.add('warn');
      $('pyChip').textContent = 'PY · ERR';
      $('pyChip').classList.add('warn');
      $('netPill').textContent = 'SIGNAL DEAD';
      if (tape) tape.textContent += `\nboot fail · ${err.message || err}\n`;
    }
    window.DeckToys?.stopAll();
  }

  /* —— AI / LINK —— */
  function pushBubble(role, text) {
    const feed = $('aiFeed');
    const el = document.createElement('div');
    el.className = `bubble ${role}`;
    el.innerHTML = `<span class="who">${role === 'user' ? 'YOU' : 'CD-R'}</span><p class="bubble-text">${escapeHtml(text)}</p>`;
    feed.appendChild(el);
    feed.scrollTop = feed.scrollHeight;
    return el;
  }

  function showTyping() {
    const feed = $('aiFeed');
    const el = document.createElement('div');
    el.className = 'bubble rig typing';
    el.id = 'aiTyping';
    el.innerHTML =
      '<span class="who">CD-R</span><span class="typing-dots" aria-label="digitando"><i></i><i></i><i></i></span>';
    feed.appendChild(el);
    feed.scrollTop = feed.scrollHeight;
    return el;
  }

  function hideTyping() {
    $('aiTyping')?.remove();
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function initAi() {
    pushBubble('rig', 'eae. cd-r no ar — meio chiado, mas vivo. manda aí.');
    $('aiForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = $('aiInput');
      const btn = e.target.querySelector('button[type="submit"]');
      const msg = input.value.trim();
      if (!msg || input.disabled) return;
      input.value = '';
      input.disabled = true;
      if (btn) btn.disabled = true;
      pushBubble('user', msg);
      state.aiHistory.push({ role: 'user', text: msg });
      $('netPill').textContent = 'TX…';
      showTyping();
      try {
        const r = await api('/api/deck/ai/chat', {
          method: 'POST',
          body: JSON.stringify({ message: msg, history: state.aiHistory.slice(0, -1) }),
        });
        hideTyping();
        if (!r.ok) {
          pushBubble('rig', r.error || 'falha no link');
          $('netPill').textContent = 'TX FAIL';
          return;
        }
        state.aiHistory.push({ role: 'model', text: r.reply });
        pushBubble('rig', r.reply);
        $('netPill').textContent = 'LINK HOT';
        window.DeckToys?.bumpXp?.(2);
      } catch (err) {
        hideTyping();
        pushBubble('rig', err.message || 'link caiu');
        $('netPill').textContent = 'TX FAIL';
      } finally {
        input.disabled = false;
        if (btn) btn.disabled = false;
        input.focus();
      }
    });
  }

  /* —— Arcade —— */
  const Arcade = {
    snake() {
      const canvas = $('arcadeCanvas');
      const ctx = canvas.getContext('2d');
      const cell = 16;
      const cols = Math.floor(canvas.width / cell);
      const rows = Math.floor(canvas.height / cell);
      let snake = [{ x: 8, y: 8 }];
      let dir = { x: 1, y: 0 };
      let next = { x: 1, y: 0 };
      let food = { x: 14, y: 10 };
      let score = 0;
      let dead = false;
      let paused = false;
      let acc = 0;

      const placeFood = () => {
        food = {
          x: Math.floor(Math.random() * cols),
          y: Math.floor(Math.random() * rows),
        };
      };

      return {
        name: 'snake',
        hint: 'WASD/setas · espaço pause · come o bloco ácido',
        onKey(code) {
          if (code === 'Space') paused = !paused;
          if (code === 'ArrowUp' || code === 'KeyW') if (dir.y !== 1) next = { x: 0, y: -1 };
          if (code === 'ArrowDown' || code === 'KeyS') if (dir.y !== -1) next = { x: 0, y: 1 };
          if (code === 'ArrowLeft' || code === 'KeyA') if (dir.x !== 1) next = { x: -1, y: 0 };
          if (code === 'ArrowRight' || code === 'KeyD') if (dir.x !== -1) next = { x: 1, y: 0 };
        },
        update(dt) {
          if (dead || paused) return;
          acc += dt;
          if (acc < 110) return;
          acc = 0;
          dir = next;
          const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };
          if (head.x < 0 || head.y < 0 || head.x >= cols || head.y >= rows) {
            dead = true;
            return;
          }
          if (snake.some((s) => s.x === head.x && s.y === head.y)) {
            dead = true;
            return;
          }
          snake.unshift(head);
          if (head.x === food.x && head.y === food.y) {
            score += 10;
            placeFood();
          } else snake.pop();
          $('arcadeScore').textContent = `SCORE ${score}${paused ? ' · PAUSE' : ''}`;
        },
        draw() {
          ctx.fillStyle = '#050403';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = '#c6f000';
          ctx.fillRect(food.x * cell, food.y * cell, cell - 1, cell - 1);
          snake.forEach((s, i) => {
            ctx.fillStyle = i === 0 ? '#e8a35a' : '#c47a3a';
            ctx.fillRect(s.x * cell, s.y * cell, cell - 1, cell - 1);
          });
          if (dead) {
            ctx.fillStyle = 'rgba(0,0,0,0.55)';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = '#f3ebe1';
            ctx.font = '20px Chakra Petch';
            ctx.fillText('GAME OVER · troca de aba ou pill pra restart', 40, canvas.height / 2);
          }
        },
      };
    },

    breakout() {
      const canvas = $('arcadeCanvas');
      const ctx = canvas.getContext('2d');
      const paddle = { x: 200, w: 70, h: 10, y: canvas.height - 24 };
      const ball = { x: 240, y: 200, vx: 2.4, vy: -2.6, r: 5 };
      const bricks = [];
      const cols = 10;
      const rows = 5;
      const bw = canvas.width / cols - 4;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          bricks.push({ x: c * (bw + 4) + 2, y: 30 + r * 18, w: bw, h: 12, alive: true });
        }
      }
      let score = 0;
      let paused = false;
      let dead = false;

      return {
        name: 'breakout',
        hint: '← → ou A/D · espaço pause',
        onKey(code) {
          if (code === 'Space') paused = !paused;
        },
        update() {
          if (dead || paused) return;
          if (state.keys.has('ArrowLeft') || state.keys.has('KeyA')) paddle.x -= 5;
          if (state.keys.has('ArrowRight') || state.keys.has('KeyD')) paddle.x += 5;
          paddle.x = Math.max(0, Math.min(canvas.width - paddle.w, paddle.x));
          ball.x += ball.vx;
          ball.y += ball.vy;
          if (ball.x < ball.r || ball.x > canvas.width - ball.r) ball.vx *= -1;
          if (ball.y < ball.r) ball.vy *= -1;
          if (ball.y > canvas.height) {
            dead = true;
            return;
          }
          if (
            ball.y + ball.r > paddle.y &&
            ball.x > paddle.x &&
            ball.x < paddle.x + paddle.w &&
            ball.vy > 0
          ) {
            ball.vy *= -1;
            ball.vx += (ball.x - (paddle.x + paddle.w / 2)) * 0.05;
          }
          for (const b of bricks) {
            if (!b.alive) continue;
            if (ball.x > b.x && ball.x < b.x + b.w && ball.y > b.y && ball.y < b.y + b.h) {
              b.alive = false;
              ball.vy *= -1;
              score += 5;
            }
          }
          $('arcadeScore').textContent = `SCORE ${score}${paused ? ' · PAUSE' : ''}`;
        },
        draw() {
          ctx.fillStyle = '#050403';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          bricks.forEach((b, i) => {
            if (!b.alive) return;
            ctx.fillStyle = i % 2 ? '#c47a3a' : '#e4572e';
            ctx.fillRect(b.x, b.y, b.w, b.h);
          });
          ctx.fillStyle = '#c6f000';
          ctx.fillRect(paddle.x, paddle.y, paddle.w, paddle.h);
          ctx.beginPath();
          ctx.arc(ball.x, ball.y, ball.r, 0, Math.PI * 2);
          ctx.fillStyle = '#f3ebe1';
          ctx.fill();
          if (dead) {
            ctx.fillStyle = 'rgba(0,0,0,0.55)';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = '#f3ebe1';
            ctx.font = '20px Chakra Petch';
            ctx.fillText('GAME OVER', 180, canvas.height / 2);
          }
        },
      };
    },

    pulse() {
      const canvas = $('arcadeCanvas');
      const ctx = canvas.getContext('2d');
      const player = { x: 240, y: 280 };
      const shots = [];
      const foes = [];
      let score = 0;
      let t = 0;
      let paused = false;
      let dead = false;
      let cooldown = 0;

      return {
        name: 'pulse',
        hint: 'mover WASD · Z/espaço atira',
        onKey(code) {
          if (code === 'Space') {
            if (!state.keys.has('KeyZ')) paused = !paused;
          }
        },
        update(dt) {
          if (dead || paused) return;
          t += dt;
          cooldown = Math.max(0, cooldown - dt);
          const sp = 3.2;
          if (state.keys.has('ArrowLeft') || state.keys.has('KeyA')) player.x -= sp;
          if (state.keys.has('ArrowRight') || state.keys.has('KeyD')) player.x += sp;
          if (state.keys.has('ArrowUp') || state.keys.has('KeyW')) player.y -= sp;
          if (state.keys.has('ArrowDown') || state.keys.has('KeyS')) player.y += sp;
          player.x = Math.max(10, Math.min(canvas.width - 10, player.x));
          player.y = Math.max(10, Math.min(canvas.height - 10, player.y));
          if ((state.keys.has('KeyZ') || state.keys.has('Space')) && cooldown <= 0) {
            shots.push({ x: player.x, y: player.y - 8, vy: -6 });
            cooldown = 140;
          }
          if (Math.random() < 0.03) {
            foes.push({ x: Math.random() * canvas.width, y: -10, vy: 1.5 + Math.random() });
          }
          for (const s of shots) s.y += s.vy;
          for (const f of foes) f.y += f.vy;
          for (let i = shots.length - 1; i >= 0; i--) {
            for (let j = foes.length - 1; j >= 0; j--) {
              const s = shots[i];
              const f = foes[j];
              if (Math.hypot(s.x - f.x, s.y - f.y) < 12) {
                shots.splice(i, 1);
                foes.splice(j, 1);
                score += 15;
                break;
              }
            }
          }
          for (const f of foes) {
            if (Math.hypot(f.x - player.x, f.y - player.y) < 14) dead = true;
          }
          while (shots.length && shots[0].y < -20) shots.shift();
          while (foes.length && foes[0].y > canvas.height + 20) {
            foes.shift();
            score = Math.max(0, score - 2);
          }
          $('arcadeScore').textContent = `SCORE ${score}${paused ? ' · PAUSE' : ''}`;
        },
        draw() {
          ctx.fillStyle = '#050403';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = '#c6f000';
          shots.forEach((s) => ctx.fillRect(s.x - 1, s.y - 6, 2, 8));
          ctx.fillStyle = '#e4572e';
          foes.forEach((f) => {
            ctx.beginPath();
            ctx.arc(f.x, f.y, 7, 0, Math.PI * 2);
            ctx.fill();
          });
          ctx.fillStyle = '#e8a35a';
          ctx.beginPath();
          ctx.moveTo(player.x, player.y - 10);
          ctx.lineTo(player.x - 9, player.y + 8);
          ctx.lineTo(player.x + 9, player.y + 8);
          ctx.fill();
          if (dead) {
            ctx.fillStyle = 'rgba(0,0,0,0.55)';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = '#f3ebe1';
            ctx.font = '20px Chakra Petch';
            ctx.fillText('SIGNAL LOST', 170, canvas.height / 2);
          }
        },
      };
    },
  };

  let lastTs = 0;
  let raf = 0;

  function arcadeLoop(ts) {
    if (!state.arcade) return;
    const dt = lastTs ? ts - lastTs : 16;
    lastTs = ts;
    state.arcade.update(dt);
    state.arcade.draw();
    raf = requestAnimationFrame(arcadeLoop);
  }

  function startArcade(name) {
    stopArcade();
    const factory = Arcade[name] || Arcade.snake;
    state.arcade = factory();
    $('arcadeHint').textContent = state.arcade.hint;
    document.querySelectorAll('[data-game]').forEach((p) => {
      p.classList.toggle('on', p.dataset.game === state.arcade.name);
    });
    lastTs = 0;
    raf = requestAnimationFrame(arcadeLoop);
  }

  function stopArcade() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    state.arcade = null;
  }

  document.querySelector('.arcade-bar')?.addEventListener('click', (e) => {
    const pill = e.target.closest('[data-game]');
    if (pill) startArcade(pill.dataset.game);
  });

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    state.keys.add(e.code);
    if (state.tab === 'arcade' && state.arcade) {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
        e.preventDefault();
      }
      state.arcade.onKey?.(e.code);
    }
  });
  window.addEventListener('keyup', (e) => state.keys.delete(e.code));

  /* —— NES / JSNES —— */
  function destroyNes() {
    if (state.nes) {
      try {
        state.nes.destroy();
      } catch {
        try {
          state.nes.stop();
        } catch {
          /* ignore */
        }
      }
      state.nes = null;
    }
    const mount = $('nesMount');
    mount.innerHTML = '';
    mount.hidden = true;
    $('nesDrop').hidden = false;
  }

  function loadRomData(data) {
    if (typeof jsnes === 'undefined' || !jsnes.Browser) {
      alert('JSNES não carregou. Confira a rede/CDN.');
      return;
    }
    destroyNes();
    const mount = $('nesMount');
    mount.hidden = false;
    $('nesDrop').hidden = true;
    state.nes = new jsnes.Browser({
      container: mount,
      romData: data,
      onError(err) {
        console.error(err);
        $('netPill').textContent = 'NES ERR';
      },
    });
    try {
      state.nes.fitInParent?.();
    } catch {
      /* ignore */
    }
    $('netPill').textContent = 'CART LIVE';
  }

  async function loadRomUrl(url) {
    $('netPill').textContent = 'LOADING ROM…';
    if (jsnes?.Browser?.loadROMFromURL) {
      jsnes.Browser.loadROMFromURL(url, (err, data) => {
        if (err) {
          $('netPill').textContent = 'ROM FAIL';
          alert(err.message || String(err));
          return;
        }
        loadRomData(data);
      });
      return;
    }
    const buf = await fetch(url).then((r) => r.arrayBuffer());
    loadRomData(buf);
  }

  function wireCart() {
    if (!$('loadCroom')) return;
    $('loadCroom').addEventListener('click', () => loadRomUrl('roms/croom.nes'));
    $('romFile').addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const buf = await file.arrayBuffer();
      loadRomData(buf);
    });
    $('nesPause').addEventListener('click', () => {
      if (!state.nes) return;
      try {
        if (state.nes._running === false) state.nes.start();
        else state.nes.stop();
      } catch {
        state.nes.stop?.();
      }
    });
    $('nesStop').addEventListener('click', destroyNes);

    const stage = $('nesStage');
    ['dragenter', 'dragover'].forEach((ev) => {
      stage.addEventListener(ev, (e) => {
        e.preventDefault();
        stage.classList.add('drag');
      });
    });
    ['dragleave', 'drop'].forEach((ev) => {
      stage.addEventListener(ev, (e) => {
        e.preventDefault();
        stage.classList.remove('drag');
      });
    });
    stage.addEventListener('drop', async (e) => {
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      const buf = await file.arrayBuffer();
      loadRomData(buf);
    });
  }

  /* —— Radio / Lock —— */
  async function runRadioScan() {
    const list = $('radioList');
    list.innerHTML = '<div class="node"><strong>varrendo…</strong></div>';
    const seed = $('radioSeed').value.trim() || 'deck';
    const r = await api('/api/deck/intel', {
      method: 'POST',
      body: JSON.stringify({ op: 'scan', seed, count: 8 }),
    });
    if (!r.ok) {
      list.innerHTML = `<div class="node"><strong>${escapeHtml(r.error || 'erro')}</strong></div>`;
      return;
    }
    list.innerHTML = '';
    for (const n of r.data.nodes) {
      const el = document.createElement('div');
      el.className = 'node';
      el.innerHTML = `
        <strong>${escapeHtml(n.sigil)} ${escapeHtml(n.host)}</strong>
        <span class="badge ${n.status}">${n.status}</span>
        <div class="meta">${n.ip}:${n.port} · ${n.latency_ms}ms</div>`;
      list.appendChild(el);
    }
  }

  function renderVault(notes) {
    const box = $('vaultList');
    box.innerHTML = '';
    for (const n of notes || []) {
      const el = document.createElement('div');
      el.className = 'note';
      el.innerHTML = `
        <strong>${escapeHtml(n.title)}</strong>
        <div class="meta">${new Date(n.at).toLocaleString('pt-BR')}</div>
        <div>${escapeHtml(n.body)}</div>
        <button type="button" class="btn" data-del="${n.id}" style="margin-top:0.4rem">apagar</button>`;
      box.appendChild(el);
    }
    box.querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const r = await api(`/api/deck/vault/${btn.dataset.del}`, { method: 'DELETE' });
        if (r.ok) renderVault(r.notes);
      });
    });
  }

  async function loadVault() {
    const r = await api('/api/deck/vault');
    if (r.ok) renderVault(r.notes);
  }

  function wireLock() {
    if (!$('radioScan')) return;
    $('radioScan').addEventListener('click', runRadioScan);
    $('noteSave').addEventListener('click', async () => {
      const r = await api('/api/deck/vault', {
        method: 'POST',
        body: JSON.stringify({
          title: $('noteTitle').value.trim() || 'NOTE',
          body: $('noteBody').value,
        }),
      });
      if (r.ok) {
        $('noteBody').value = '';
        renderVault(r.notes);
      }
    });
    $('encBtn').addEventListener('click', async () => {
      const r = await api('/api/deck/intel', {
        method: 'POST',
        body: JSON.stringify({ op: 'encrypt', plain: $('decIn').value, key: $('decKey').value }),
      });
      $('decOut').textContent = r.ok ? `${r.data.algo}\n${r.data.cipher_hex}` : r.error;
    });
    $('decBtn').addEventListener('click', async () => {
      const r = await api('/api/deck/intel', {
        method: 'POST',
        body: JSON.stringify({ op: 'decrypt', cipher: $('decIn').value, key: $('decKey').value }),
      });
      $('decOut').textContent = r.ok ? `${r.data.algo}\n${r.data.plain}` : r.error;
    });
    $('hashBtn').addEventListener('click', async () => {
      const r = await api('/api/deck/intel', {
        method: 'POST',
        body: JSON.stringify({ op: 'hash', text: $('decIn').value || 'deck' }),
      });
      $('decOut').textContent = r.ok
        ? `md5  ${r.data.md5}\nsha1 ${r.data.sha1}\nsha2 ${r.data.sha256}`
        : r.error;
    });
  }

  /* —— Disc rot visualizer —— */
  const RotViz = (() => {
    let raf = 0;
    let running = false;
    let t = 0;
    let burst = 0;

    function frame() {
      if (!running) return;
      const canvas = $('rotCanvas');
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      const w = canvas.width;
      const h = canvas.height;
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, w, h);
      t += 1;
      for (let x = 0; x < w; x += 3) {
        const n = Math.sin(x * 0.05 + t * 0.08) * 0.5 + Math.random() * (0.15 + burst);
        const bar = Math.abs(n) * h * (0.35 + burst);
        ctx.fillStyle = burst > 0.2 ? '#ccc' : '#666';
        ctx.fillRect(x, h / 2 - bar / 2, 2, bar);
      }
      // dropouts
      if (Math.random() < 0.08 + burst * 0.2) {
        ctx.fillStyle = '#000';
        ctx.fillRect(Math.random() * w, 0, 20 + Math.random() * 80, h);
      }
      burst = Math.max(0, burst - 0.02);
      raf = requestAnimationFrame(frame);
    }

    return {
      start() {
        running = true;
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(frame);
        const btn = $('rotPulse');
        if (btn && !btn.dataset.wired) {
          btn.dataset.wired = '1';
          btn.addEventListener('click', () => {
            burst = 1;
            const hint = $('rotHint');
            if (hint) hint.textContent = 'signal corrupted — like the oxfam rip';
          });
        }
      },
      stop() {
        running = false;
        cancelAnimationFrame(raf);
      },
    };
  })();

  /* —— COMMS (2 pessoas) —— */
  const Comms = (() => {
    const storeKey = 'voidwire-comms';
    const avatarKey = 'voidwire-comms-avatar';
    let pollTimer = null;
    let activeTab = false;
    let typingIdle = null;
    let typingOn = false;
    let typingPosting = false;
    let recordingOn = false;
    let recordingPosting = false;
    let recordingKeepalive = null;
    let localAvatar = '';
    let avatarDirty = false;
    const avatarCache = new Map(); /* peerId -> { at, data } */
    const avatarFetching = new Map();
    const state = {
      code: null,
      peerId: null,
      name: '',
      seat: '',
      after: 0,
      known: new Set(),
      cdr: false,
      cdrTyping: false,
      slotsMax: 2,
      slotsUsed: 0,
      listeningByPeer: {},
      listeningKey: '',
      alongWith: null,
      alongByPeer: {},
      alongTrackKey: '',
      lastPlaySyncAt: 0,
    };

    const VISUAL_KEY = 'deathdeck-comms-visual-v2';
    const VISUAL_LOCAL_KEY = 'deathdeck-comms-visual-local-v1';
    const VISUAL_DEFAULT = {
      bubbleMe: 'classic',
      bubbleThem: 'classic',
      theme: 'paper',
      wallpaper: null,
      wallX: 50,
      wallY: 50,
      wallZoom: 1,
      highlightStyle: 'pulse',
      highlightColorMe: '#fff',
      highlightColorThem: '#000',
    };
    const HIGHLIGHT_IDS = new Set(['pulse', 'glow', 'border', 'shake']);
    const HIGHLIGHT_COLOR_IDS = new Set(['#fff', '#ffd700', '#00ff00', '#ff6b6b', '#4ecdc4', '#000']);
    const BASE_BUBBLE_IDS = new Set(['classic', 'soft', 'candy', 'ghost']);
    const ROSE_BUBBLE_IDS = new Set(['petal', 'blush', 'bow', 'heart']);
    const BUBBLE_IDS = new Set([...BASE_BUBBLE_IDS, ...ROSE_BUBBLE_IDS]);
    const ROSE_BUBBLE_DEFAULT = 'petal';
    const THEME_IDS = new Set(['paper', 'ocean', 'rose', 'dusk', 'night']);
    const BUBBLE_FALLBACK = { stamp: 'soft', mint: 'candy' };
    const THEME_FALLBACK = {
      plain: 'paper',
      grid: 'paper',
      sand: 'paper',
      forest: 'dusk',
      mono: 'night',
    };

    function clampWall(n, min, max) {
      const v = Number(n);
      if (!Number.isFinite(v)) return min;
      return Math.min(max, Math.max(min, v));
    }

    function sanitizeWallPos(raw) {
      const x = raw?.wallX ?? raw?.x;
      const y = raw?.wallY ?? raw?.y;
      const z = raw?.wallZoom ?? raw?.zoom;
      return {
        wallX: x == null || !Number.isFinite(Number(x)) ? 50 : clampWall(x, 0, 100),
        wallY: y == null || !Number.isFinite(Number(y)) ? 50 : clampWall(y, 0, 100),
        wallZoom: z == null || !Number.isFinite(Number(z)) ? 1 : clampWall(z, 1, 2.5),
      };
    }

    function wallZoomCss(zoom) {
      return String(clampWall(zoom, 1, 2.5));
    }

    function isWallLockedTheme(theme) {
      return theme === 'paper' || theme === 'rose';
    }

    function coerceBubblesForTheme(theme, bubbleMe, bubbleThem) {
      if (theme === 'paper') {
        return { bubbleMe: 'classic', bubbleThem: 'classic' };
      }
      if (theme === 'rose') {
        return {
          bubbleMe: ROSE_BUBBLE_IDS.has(bubbleMe) ? bubbleMe : ROSE_BUBBLE_DEFAULT,
          bubbleThem: ROSE_BUBBLE_IDS.has(bubbleThem) ? bubbleThem : ROSE_BUBBLE_DEFAULT,
        };
      }
      return {
        bubbleMe: BASE_BUBBLE_IDS.has(bubbleMe) ? bubbleMe : 'classic',
        bubbleThem: BASE_BUBBLE_IDS.has(bubbleThem) ? bubbleThem : 'classic',
      };
    }

    function draftForTheme(theme, draft) {
      const next = { ...draft, theme };
      if (isWallLockedTheme(theme)) {
        next.wallpaper = null;
        next.wallX = 50;
        next.wallY = 50;
        next.wallZoom = 1;
      }
      return { ...next, ...coerceBubblesForTheme(theme, next.bubbleMe, next.bubbleThem) };
    }

    function sanitizeVisual(raw) {
      const pickBubble = (id) => {
        if (BUBBLE_IDS.has(id)) return id;
        if (BUBBLE_FALLBACK[id]) return BUBBLE_FALLBACK[id];
        return null;
      };
      const legacyBubble = pickBubble(raw?.bubble);
      let bubbleMe = pickBubble(raw?.bubbleMe) || legacyBubble || VISUAL_DEFAULT.bubbleMe;
      let bubbleThem = pickBubble(raw?.bubbleThem) || VISUAL_DEFAULT.bubbleThem;
      let theme = raw?.theme;
      if (!THEME_IDS.has(theme)) theme = THEME_FALLBACK[theme] || VISUAL_DEFAULT.theme;
      let highlightStyle = raw?.highlightStyle;
      if (!HIGHLIGHT_IDS.has(highlightStyle)) highlightStyle = VISUAL_DEFAULT.highlightStyle;
      let highlightColorMe = raw?.highlightColorMe;
      if (!HIGHLIGHT_COLOR_IDS.has(highlightColorMe)) highlightColorMe = VISUAL_DEFAULT.highlightColorMe;
      let highlightColorThem = raw?.highlightColorThem;
      if (!HIGHLIGHT_COLOR_IDS.has(highlightColorThem)) highlightColorThem = VISUAL_DEFAULT.highlightColorThem;
      let wallpaper = null;
      if (typeof raw?.wallpaper === 'string' && raw.wallpaper.startsWith('data:image/')) {
        wallpaper = raw.wallpaper.length <= 450000 ? raw.wallpaper : null;
      }
      let pos = sanitizeWallPos(raw);
      /* papel / rosa: sem wallpaper */
      if (isWallLockedTheme(theme)) {
        wallpaper = null;
        pos = { wallX: 50, wallY: 50, wallZoom: 1 };
      }
      ({ bubbleMe, bubbleThem } = coerceBubblesForTheme(theme, bubbleMe, bubbleThem));
      return { bubbleMe, bubbleThem, theme, highlightStyle, highlightColorMe, highlightColorThem, wallpaper, ...pos };
    }

    function loadVisual() {
      try {
        const v2 = localStorage.getItem(VISUAL_KEY);
        if (v2) return sanitizeVisual(JSON.parse(v2));
        const v1 = localStorage.getItem('deathdeck-comms-visual-v1');
        if (v1) return sanitizeVisual(JSON.parse(v1));
      } catch {
        /* ignore */
      }
      return { ...VISUAL_DEFAULT };
    }

    function saveVisual(opts) {
      try {
        localStorage.setItem(VISUAL_KEY, JSON.stringify(sanitizeVisual(opts)));
      } catch {
        notify('não deu pra salvar o fundo · imagem grande demais pro browser');
      }
    }

    function loadPreferLocalVisual() {
      try {
        return localStorage.getItem(VISUAL_LOCAL_KEY) === '1';
      } catch {
        return false;
      }
    }

    function savePreferLocalVisual(on) {
      try {
        localStorage.setItem(VISUAL_LOCAL_KEY, on ? '1' : '0');
      } catch {
        /* ignore */
      }
    }

    let visualApplied = loadVisual();
    let visualDraft = { ...visualApplied };
    let preferLocalVisual = loadPreferLocalVisual();
    let roomVisual = null; // { at, by, name, theme, bubbleMe, bubbleThem, hasWall, wallX... }
    let roomWallData = null;
    let roomVisualFetchAt = 0;
    let wallDrag = null;

    function applyVisualAttrs(el, opts) {
      if (!el) return;
      const v = sanitizeVisual(opts);
      el.setAttribute('data-comms-bubble-me', v.bubbleMe);
      el.setAttribute('data-comms-bubble-them', v.bubbleThem);
      el.setAttribute('data-comms-theme', v.theme);
      el.dataset.commsBubbleMe = v.bubbleMe;
      el.dataset.commsBubbleThem = v.bubbleThem;
      el.dataset.commsTheme = v.theme;
      delete el.dataset.commsBubble;
    }

    const THEME_BODY_CLASSES = ['paper', 'ocean', 'rose', 'dusk', 'night'].map(
      (t) => `comms-theme-${t}`
    );

    function syncBodyThemeClass(theme) {
      document.body.classList.remove(...THEME_BODY_CLASSES);
      if (theme && THEME_IDS.has(theme)) {
        document.body.classList.add(`comms-theme-${theme}`);
      }
    }

    function displayVisual(opts = visualApplied) {
      const local = sanitizeVisual(opts);
      /* visual só pra ti: ignora o compartilhado do canal */
      if (preferLocalVisual || !roomVisual?.at) return local;
      return sanitizeVisual({
        ...local,
        theme: roomVisual.theme || local.theme,
        bubbleMe: roomVisual.bubbleMe || local.bubbleMe,
        bubbleThem: roomVisual.bubbleThem || local.bubbleThem,
        wallpaper: roomWallData || (roomVisual.hasWall ? local.wallpaper : null) || null,
        wallX: roomVisual.wallX ?? local.wallX,
        wallY: roomVisual.wallY ?? local.wallY,
        wallZoom: roomVisual.wallZoom ?? local.wallZoom,
      });
    }

    function effectiveWallpaper(opts = visualApplied) {
      if (!preferLocalVisual && roomVisual?.at) {
        return roomWallData || (roomVisual.hasWall ? opts?.wallpaper || null : null);
      }
      return opts?.wallpaper || null;
    }

    function effectiveWallPos(opts = visualApplied) {
      if (!preferLocalVisual && roomVisual?.at) return sanitizeWallPos(roomVisual);
      return sanitizeWallPos(opts);
    }

    function setWallLayer(wallEl, hostEl, url, pos) {
      if (!wallEl && !hostEl) return;
      const p = sanitizeWallPos(pos);
      const isLiveWall = wallEl?.id === 'commsWall';
      const room = isLiveWall
        ? $('commsRoom') || document.querySelector('#pane-comms .comms-room')
        : null;
      if (url) {
        let pic = wallEl?.querySelector('.comms-wall-pic');
        if (wallEl && !pic) {
          pic = document.createElement('div');
          pic.className = 'comms-wall-pic';
          wallEl.appendChild(pic);
        }
        const target = pic || wallEl || hostEl;
        target.style.setProperty('--comms-wall', `url("${url}")`);
        target.style.setProperty('--comms-wall-x', `${p.wallX}%`);
        target.style.setProperty('--comms-wall-y', `${p.wallY}%`);
        target.style.setProperty('--comms-wall-zoom', wallZoomCss(p.wallZoom));
        if (wallEl) {
          wallEl.hidden = false;
          wallEl.classList.add('on');
          wallEl.setAttribute('aria-hidden', 'true');
        }
        hostEl?.classList.add('has-wall');
        if (isLiveWall) {
          hostEl?.closest('.comms-feed-shell')?.classList.add('has-wall');
          room?.classList.add('has-wall');
          if (document.body.classList.contains('comms-locked')) {
            document.body.classList.add('has-comms-wall');
          }
        }
      } else {
        if (wallEl) {
          wallEl.hidden = true;
          wallEl.classList.remove('on');
          wallEl.replaceChildren();
          wallEl.style.removeProperty('--comms-wall');
          wallEl.style.removeProperty('--comms-wall-x');
          wallEl.style.removeProperty('--comms-wall-y');
          wallEl.style.removeProperty('--comms-wall-zoom');
        }
        hostEl?.classList.remove('has-wall');
        if (isLiveWall) {
          const shell = hostEl?.closest('.comms-feed-shell') || $('commsFeed')?.closest('.comms-feed-shell');
          shell?.classList.remove('has-wall');
          room?.classList.remove('has-wall');
          document.body.classList.remove('has-comms-wall');
          [hostEl, shell, room].forEach((el) => {
            if (!el) return;
            el.style.removeProperty('--comms-wall');
            el.style.removeProperty('--comms-wall-x');
            el.style.removeProperty('--comms-wall-y');
            el.style.removeProperty('--comms-wall-zoom');
            el.style.removeProperty('--comms-wall-size');
          });
        }
      }
    }

    function applyWallpaperLayers(opts = visualApplied) {
      const liveUrl = effectiveWallpaper(opts);
      const livePos = effectiveWallPos(opts);
      const feed = $('commsFeed');
      const room = $('commsRoom') || document.querySelector('#pane-comms .comms-room');
      const shell = feed?.closest('.comms-feed-shell');
      setWallLayer($('commsWall'), room || shell || feed, liveUrl, livePos);
      if (feed) feed.classList.toggle('has-wall', !!liveUrl);
      if (shell) shell.classList.toggle('has-wall', !!liveUrl);
      if (room) room.classList.toggle('has-wall', !!liveUrl);
      document.body.classList.toggle(
        'has-comms-wall',
        !!(liveUrl && document.body.classList.contains('comms-locked'))
      );
      const preview = $('commsVisualPreviewFeed');
      setWallLayer($('commsVisualWall'), preview, visualDraft.wallpaper || null, visualDraft);
    }

    function setWallOnEl(el, url, pos) {
      /* compat: prévia / drag atualiza a mesma camada */
      if (!el) return;
      if (el.id === 'commsVisualPreviewFeed' || el.classList?.contains('comms-visual-preview-feed')) {
        setWallLayer($('commsVisualWall'), el, url, pos);
        return;
      }
      if (el.id === 'commsRoom' || el.classList?.contains('comms-room')) {
        setWallLayer($('commsWall'), el, url, pos);
        $('commsFeed')?.classList.toggle('has-wall', !!url);
        $('commsFeed')?.closest('.comms-feed-shell')?.classList.toggle('has-wall', !!url);
        return;
      }
      if (el.id === 'commsFeed' || el.classList?.contains('comms-feed')) {
        const room = el.closest('.comms-room');
        const shell = el.closest('.comms-feed-shell');
        setWallLayer($('commsWall'), room || shell || el, url, pos);
        el.classList.toggle('has-wall', !!url);
        return;
      }
      if (el.classList?.contains('comms-feed-shell')) {
        const room = el.closest('.comms-room');
        setWallLayer($('commsWall'), room || el, url, pos);
        $('commsFeed')?.classList.toggle('has-wall', !!url);
      }
    }

    function applyVisualToRoom(opts = visualApplied) {
      visualApplied = sanitizeVisual(opts);
      const shown = displayVisual(visualApplied);
      applyVisualAttrs($('pane-comms'), shown);
      applyVisualAttrs($('commsRoom') || document.querySelector('#pane-comms .comms-room'), shown);
      if (document.body.classList.contains('comms-locked')) {
        applyVisualAttrs(document.body, shown);
        syncBodyThemeClass(shown.theme);
      } else {
        delete document.body.dataset.commsBubbleMe;
        delete document.body.dataset.commsBubbleThem;
        delete document.body.dataset.commsTheme;
        delete document.body.dataset.commsBubble;
        syncBodyThemeClass(null);
      }
      applyVisualAttrs($('commsVisualPreview'), visualDraft);
      applyWallpaperLayers(visualApplied);
    }

    function visualCaption() {
      const d = visualDraft;
      const a = visualApplied;
      const bMe = d.bubbleMe !== a.bubbleMe;
      const bThem = d.bubbleThem !== a.bubbleThem;
      const t = d.theme !== a.theme;
      const w = (d.wallpaper || '') !== (a.wallpaper || '');
      const p =
        d.wallX !== a.wallX || d.wallY !== a.wallY || d.wallZoom !== a.wallZoom;
      const parts = [bMe, bThem, t, w || p].filter(Boolean).length;
      if (parts >= 2) return 'o visual ficará assim';
      if (bMe) return 'seu balão de fala ficará assim';
      if (bThem) return 'o balão da outra pessoa ficará assim';
      if (t) return 'o tema da sala ficará assim';
      if (w || p) return 'seu plano de fundo ficará assim';
      return 'visual atual';
    }

    function syncBubbleOptButtons(rootId, side, selectedId, theme) {
      const rose = theme === 'rose';
      const paper = theme === 'paper';
      $(rootId)?.querySelectorAll(side === 'me' ? '[data-bubble-me]' : '[data-bubble-them]').forEach((btn) => {
        const id = side === 'me' ? btn.dataset.bubbleMe : btn.dataset.bubbleThem;
        const pack = btn.dataset.bubblePack || 'base';
        const show = rose ? pack === 'rose' : pack === 'base';
        btn.hidden = !show;
        btn.classList.toggle('on', show && id === selectedId);
        const lockedOut = paper && id !== 'classic';
        btn.disabled = !show || lockedOut;
        btn.setAttribute('aria-disabled', btn.disabled ? 'true' : 'false');
      });
    }

    function syncVisualOptsUi() {
      const theme = visualDraft.theme;
      const wallLocked = isWallLockedTheme(theme);
      visualDraft = draftForTheme(theme, visualDraft);

      syncBubbleOptButtons('commsBubbleMeOpts', 'me', visualDraft.bubbleMe, theme);
      syncBubbleOptButtons('commsBubbleThemOpts', 'them', visualDraft.bubbleThem, theme);
      syncBubbleOptButtons('commsEditorBubbleMeOpts', 'me', visualDraft.bubbleMe, theme);
      syncBubbleOptButtons('commsEditorBubbleThemOpts', 'them', visualDraft.bubbleThem, theme);

      $('commsThemeOpts')?.querySelectorAll('[data-theme]').forEach((btn) => {
        btn.classList.toggle('on', btn.dataset.theme === theme);
      });
      $('commsEditorThemeOpts')?.querySelectorAll('[data-theme]').forEach((btn) => {
        btn.classList.toggle('on', btn.dataset.theme === theme);
      });
      $('commsEditorHighlightOpts')?.querySelectorAll('[data-highlight]').forEach((btn) => {
        btn.classList.toggle('on', btn.dataset.highlight === visualDraft.highlightStyle);
      });
      $('commsEditorHighlightColorMeOpts')?.querySelectorAll('[data-highlight-color-me]').forEach((btn) => {
        btn.classList.toggle('on', btn.dataset.highlightColorMe === visualDraft.highlightColorMe);
      });
      $('commsEditorHighlightColorThemOpts')?.querySelectorAll('[data-highlight-color-them]').forEach((btn) => {
        btn.classList.toggle('on', btn.dataset.highlightColorThem === visualDraft.highlightColorThem);
      });
      const cap = $('commsVisualCaption');
      if (cap) {
        if (theme === 'paper') cap.textContent = 'papel · só balão clássico · sem wallpaper';
        else if (theme === 'rose') cap.textContent = 'rosa · balões fofos · sem wallpaper';
        else cap.textContent = visualCaption();
      }
      applyVisualAttrs($('commsVisualPreview'), visualDraft);
      setWallOnEl($('commsVisualPreviewFeed'), visualDraft.wallpaper || null, visualDraft);
      const clearBtn = $('commsWallClear');
      if (clearBtn) clearBtn.disabled = wallLocked || !visualDraft.wallpaper;
      const expandBtn = $('commsWallExpand');
      if (expandBtn) expandBtn.disabled = wallLocked;
      const wallRow = document.querySelector('.comms-visual-wall-row');
      wallRow?.classList.toggle('is-paper-locked', wallLocked);
      $('commsWallEdit')?.classList.toggle('is-paper-locked', wallLocked);
      document.querySelectorAll('.comms-visual-wall-pick').forEach((el) => {
        el.classList.toggle('is-paper-locked', wallLocked);
        const input = el.querySelector('input[type="file"]');
        if (input) input.disabled = wallLocked;
      });
      const paperHint = $('commsPaperLockHint');
      if (paperHint) {
        paperHint.hidden = !wallLocked;
        if (theme === 'paper') {
          paperHint.textContent = 'tema papel · wallpaper bloqueado · só balão clássico';
        } else if (theme === 'rose') {
          paperHint.textContent = 'tema rosa · wallpaper bloqueado · só balões fofos';
        }
      }
      const zoom = $('commsWallEditorZoom');
      if (zoom) zoom.value = String(Math.round(clampWall(visualDraft.wallZoom, 1, 2.5) * 100));
      syncWallEditorUi();
    }

    function compressImageFile(file) {
      return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
          URL.revokeObjectURL(url);
          const maxW = 900;
          const scale = Math.min(1, maxW / Math.max(1, img.width));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            reject(new Error('canvas'));
            return;
          }
          ctx.drawImage(img, 0, 0, w, h);
          let quality = 0.72;
          let data = canvas.toDataURL('image/jpeg', quality);
          while (data.length > 420000 && quality > 0.35) {
            quality -= 0.08;
            data = canvas.toDataURL('image/jpeg', quality);
          }
          if (data.length > 450000) {
            reject(new Error('imagem ainda grande · tenta outra'));
            return;
          }
          resolve(data);
        };
        img.onerror = () => {
          URL.revokeObjectURL(url);
          reject(new Error('não abriu a imagem'));
        };
        img.src = url;
      });
    }

    async function syncRoomVisual(meta) {
      if (!meta?.at) {
        roomVisual = null;
        roomWallData = null;
        roomVisualFetchAt = 0;
        applyVisualToRoom(visualApplied);
        return;
      }
      const isNewShare = meta.at !== roomVisualFetchAt;
      /* visual novo no canal sobrescreve o “só pra ti” */
      if (isNewShare) {
        preferLocalVisual = false;
        savePreferLocalVisual(false);
      }
      const nextMeta = {
        at: meta.at,
        by: meta.by || '',
        name: meta.name || '',
        theme: meta.theme || 'paper',
        bubbleMe: meta.bubbleMe || 'classic',
        bubbleThem: meta.bubbleThem || 'classic',
        hasWall: !!meta.hasWall,
        ...sanitizeWallPos(meta),
      };
      const sameAt = roomVisualFetchAt === meta.at;
      roomVisual = nextMeta;
      if (sameAt && (!meta.hasWall || roomWallData)) {
        applyVisualToRoom(visualApplied);
        return;
      }
      if (!state.code) return;
      if (meta.hasWall) {
        try {
          const r = await api(`/api/deck/comms/${state.code}/visual`);
          if (r?.ok && r.visual) {
            roomVisual = {
              at: r.visual.at,
              by: r.visual.by,
              name: r.visual.name,
              theme: r.visual.theme,
              bubbleMe: r.visual.bubbleMe,
              bubbleThem: r.visual.bubbleThem,
              hasWall: !!r.visual.wallpaper || !!r.visual.hasWall,
              ...sanitizeWallPos(r.visual),
            };
            roomWallData = r.visual.wallpaper || null;
            roomVisualFetchAt = r.visual.at;
          }
          if (!roomWallData) {
            const w = await api(`/api/deck/comms/${state.code}/wallpaper`);
            if (w?.ok && w.wallpaper?.data) {
              roomWallData = w.wallpaper.data;
              roomVisual = {
                ...(roomVisual || nextMeta),
                hasWall: true,
                ...sanitizeWallPos(w.wallpaper),
                at: w.wallpaper.at || roomVisual?.at || meta.at,
              };
              roomVisualFetchAt = roomVisual.at;
            }
          }
          if (!roomWallData) {
            roomVisualFetchAt = meta.at;
          }
        } catch {
          roomVisualFetchAt = meta.at;
        }
      } else {
        roomWallData = null;
        roomVisualFetchAt = meta.at;
        try {
          const r = await api(`/api/deck/comms/${state.code}/visual`);
          if (r?.ok && r.visual) {
            roomVisual = {
              at: r.visual.at,
              by: r.visual.by,
              name: r.visual.name,
              theme: r.visual.theme,
              bubbleMe: r.visual.bubbleMe,
              bubbleThem: r.visual.bubbleThem,
              hasWall: false,
              ...sanitizeWallPos(r.visual),
            };
            roomVisualFetchAt = r.visual.at;
          }
        } catch {
          /* ignore */
        }
      }
      applyVisualToRoom(visualApplied);
    }

    function showVisualTip() {
      visualDraft = { ...displayVisual(visualApplied) };
      const share = $('commsWallShare');
      if (share) share.checked = false;
      syncVisualOptsUi();
      const tip = $('commsVisualTip');
      if (!tip) return;
      tip.hidden = false;
      requestAnimationFrame(() => tip.classList.add('on'));
    }

    function hideVisualTip() {
      wallDrag = null;
      $('commsVisualPreviewFeed')?.classList.remove('is-dragging');
      const tip = $('commsVisualTip');
      if (!tip) return;
      tip.classList.remove('on');
      setTimeout(() => {
        if (!tip.classList.contains('on')) tip.hidden = true;
      }, 220);
    }

    async function publishRoomVisual(opts, extra = {}) {
      if (!state.code || !state.peerId) return null;
      const v = sanitizeVisual(opts || visualApplied);
      const body = {
        peerId: state.peerId,
        theme: v.theme,
        bubbleMe: v.bubbleMe,
        bubbleThem: v.bubbleThem,
        wallpaper: v.wallpaper || null,
        wallX: v.wallX,
        wallY: v.wallY,
        wallZoom: v.wallZoom,
      };
      if (extra?.adm) body.adm = true;
      return api(`/api/deck/comms/${state.code}/visual`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    }

    const ADM_WALL_SRC = 'assets/wall-adm-batman.png';
    let admWallCache = null;

    async function loadAdmWallDataUrl() {
      if (admWallCache) return admWallCache;
      const res = await fetch(ADM_WALL_SRC, { cache: 'force-cache' });
      if (!res.ok) throw new Error('fundo do adm não carregou');
      const blob = await res.blob();
      const dataUrl = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result || ''));
        fr.onerror = () => reject(new Error('falha ao ler o fundo'));
        fr.readAsDataURL(blob);
      });
      if (!dataUrl.startsWith('data:image/')) throw new Error('fundo inválido');
      if (dataUrl.length > 450000) throw new Error('fundo do adm grande demais');
      admWallCache = dataUrl;
      return dataUrl;
    }

    async function applyAdmVisualToChannel() {
      if (!state.code || !state.peerId) {
        notify('entra num canal pra aplicar');
        return;
      }
      const btn = $('commsVisualAdm');
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'aplicando…';
      }
      try {
        const wallpaper = await loadAdmWallDataUrl();
        const next = sanitizeVisual({
          bubbleMe: 'ghost',
          bubbleThem: 'ghost',
          theme: 'dusk',
          wallpaper,
          wallX: 42,
          wallY: 48,
          wallZoom: 1.2,
        });
        visualDraft = { ...next };
        visualApplied = { ...next };
        saveVisual(visualApplied);
        preferLocalVisual = false;
        savePreferLocalVisual(false);
        syncVisualOptsUi();
        const share = $('commsWallShare');
        if (share) share.checked = true;
        const r = await publishRoomVisual(visualApplied, { adm: true });
        if (r?.ok && r.visual) {
          const wall =
            r.visual.wallpaper ||
            (r.visual.hasWall ? visualApplied.wallpaper : null) ||
            null;
          roomVisual = {
            at: r.visual.at,
            by: r.visual.by,
            name: r.visual.name,
            theme: r.visual.theme,
            bubbleMe: r.visual.bubbleMe,
            bubbleThem: r.visual.bubbleThem,
            hasWall: !!wall || !!r.visual.hasWall,
            ...sanitizeWallPos(r.visual),
          };
          roomWallData = wall;
          roomVisualFetchAt = r.visual.at;
          applyVisualToRoom(visualApplied);
          notify('visual do adm aplicado pra todo o canal :D');
          hideVisualTip();
        } else {
          preferLocalVisual = true;
          savePreferLocalVisual(true);
          applyVisualToRoom(visualApplied);
          notify(r?.error || 'não deu pra mandar o visual do adm');
        }
      } catch (err) {
        notify(err?.message || 'falha no visual do adm');
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.textContent = 'Aplicar o visual do adm :D';
        }
      }
    }

    function pointerPos(e) {
      if (e.touches?.[0]) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
      return { x: e.clientX, y: e.clientY };
    }

    function wireWallDrag() {
      const feed = $('commsVisualPreviewFeed');
      if (!feed) return;

      const onMove = (e) => {
        if (!wallDrag || !visualDraft.wallpaper) return;
        e.preventDefault();
        const p = pointerPos(e);
        const dx = p.x - wallDrag.x;
        const dy = p.y - wallDrag.y;
        wallDrag.x = p.x;
        wallDrag.y = p.y;
        const rect = feed.getBoundingClientRect();
        const zoom = Math.max(1, visualDraft.wallZoom || 1);
        const sensX = (100 / Math.max(1, rect.width)) / zoom;
        const sensY = (100 / Math.max(1, rect.height)) / zoom;
        visualDraft = {
          ...visualDraft,
          wallX: clampWall(visualDraft.wallX - dx * sensX, 0, 100),
          wallY: clampWall(visualDraft.wallY - dy * sensY, 0, 100),
        };
        setWallOnEl(feed, visualDraft.wallpaper, visualDraft);
        const cap = $('commsVisualCaption');
        if (cap) cap.textContent = visualCaption();
      };

      const onUp = () => {
        if (!wallDrag) return;
        wallDrag = null;
        feed.classList.remove('is-dragging');
      };

      feed.addEventListener('pointerdown', (e) => {
        if (!visualDraft.wallpaper) return;
        if (e.button != null && e.button !== 0) return;
        e.preventDefault();
        const p = pointerPos(e);
        wallDrag = { x: p.x, y: p.y };
        feed.classList.add('is-dragging');
        feed.setPointerCapture?.(e.pointerId);
      });
      feed.addEventListener('pointermove', onMove);
      feed.addEventListener('pointerup', onUp);
      feed.addEventListener('pointercancel', onUp);
      feed.addEventListener('lostpointercapture', onUp);
    }

    function syncWallEditorUi() {
      const stage = $('commsWallEditorStage');
      const bubbles = $('commsWallEditorBubbles');
      const hasPhoto = !!visualDraft.wallpaper;
      stage?.classList.toggle('has-photo', hasPhoto);
      const tools = $('commsWallEditorTools');
      if (tools) tools.hidden = !hasPhoto;
      const empty = $('commsWallEditorEmpty');
      if (empty) empty.hidden = hasPhoto;
      applyVisualAttrs(bubbles, visualDraft);
      applyVisualAttrs(stage, visualDraft);
      $('commsEditorBubbleMeOpts')?.querySelectorAll('[data-bubble-me]').forEach((btn) => {
        btn.classList.toggle('on', btn.dataset.bubbleMe === visualDraft.bubbleMe);
      });
      $('commsEditorBubbleThemOpts')?.querySelectorAll('[data-bubble-them]').forEach((btn) => {
        btn.classList.toggle('on', btn.dataset.bubbleThem === visualDraft.bubbleThem);
      });
      $('commsEditorThemeOpts')?.querySelectorAll('[data-theme]').forEach((btn) => {
        btn.classList.toggle('on', btn.dataset.theme === visualDraft.theme);
      });
      syncWallEditorStage();
    }

    function syncWallEditorStage() {
      const pic = $('commsWallEditorPic');
      const wall = $('commsWallEditorWall');
      if (!pic) return;
      if (!visualDraft.wallpaper) {
        pic.style.removeProperty('--comms-wall');
        wall?.classList.remove('on');
        if (wall) wall.hidden = true;
        return;
      }
      const p = sanitizeWallPos(visualDraft);
      pic.style.setProperty('--comms-wall', `url("${visualDraft.wallpaper}")`);
      pic.style.setProperty('--comms-wall-x', `${p.wallX}%`);
      pic.style.setProperty('--comms-wall-y', `${p.wallY}%`);
      pic.style.setProperty('--comms-wall-zoom', wallZoomCss(p.wallZoom));
      if (wall) {
        wall.hidden = false;
        wall.classList.add('on');
      }
      const zoom = $('commsWallEditorZoom');
      if (zoom) zoom.value = String(Math.round(p.wallZoom * 100));
    }

    const WALL_HOWTO_KEY = 'deathdeck-wall-howto-v1';
    let wallHowtoStep = 0;

    function wallHowtoSeen() {
      try {
        return localStorage.getItem(WALL_HOWTO_KEY) === '1';
      } catch {
        return false;
      }
    }

    function markWallHowtoSeen() {
      try {
        localStorage.setItem(WALL_HOWTO_KEY, '1');
      } catch {
        /* ignore */
      }
    }

    function syncWallHowtoUi() {
      const root = $('commsWallHowto');
      if (!root) return;
      root.querySelectorAll('.comms-wall-howto-step').forEach((el) => {
        const on = Number(el.dataset.wallTip) === wallHowtoStep;
        el.classList.toggle('on', on);
        if (on) {
          const demo = el.querySelector('.comms-wall-howto-demo');
          if (demo) {
            demo.classList.remove('tip-anim');
            void demo.offsetWidth;
            demo.classList.add('tip-anim');
          }
        }
      });
      root.querySelectorAll('#commsWallHowtoDots i').forEach((dot, i) => {
        dot.classList.toggle('on', i === wallHowtoStep);
      });
      const next = $('commsWallHowtoNext');
      if (next) next.textContent = wallHowtoStep >= 2 ? 'entendi' : 'próximo';
    }

    function showWallHowto() {
      wallHowtoStep = 0;
      syncWallHowtoUi();
      const tip = $('commsWallHowto');
      if (tip) tip.hidden = false;
    }

    function hideWallHowto(persist) {
      if (persist) markWallHowtoSeen();
      const tip = $('commsWallHowto');
      if (tip) tip.hidden = true;
    }

/* user pediu tutorial ao entrar — mostra sempre na abertura do editor */
    function showWallEditor() {
      syncWallEditorUi();
      const tip = $('commsWallEditorTip');
      if (!tip) return;
      tip.hidden = false;
      requestAnimationFrame(() => tip.classList.add('on'));
      showWallHowto();
    }

    function hideWallEditor() {
      wallEditorDrag = null;
      wallEditorPinch = null;
      hideWallHowto(false);
      $('commsWallEditorStage')?.classList.remove('is-dragging');
      const tip = $('commsWallEditorTip');
      if (!tip) return;
      tip.classList.remove('on');
      setTimeout(() => {
        if (!tip.classList.contains('on')) tip.hidden = true;
      }, 220);
      syncVisualOptsUi();
    }

    let wallEditorDrag = null;
    let wallEditorPinch = null;

    function wireWallEditor() {
      const stage = $('commsWallEditorStage');
      if (!stage) return;

      const applyDraftPos = () => {
        syncWallEditorStage();
        setWallOnEl($('commsVisualPreviewFeed'), visualDraft.wallpaper || null, visualDraft);
      };

      const onMove = (e) => {
        if (!visualDraft.wallpaper) return;
        if (wallEditorPinch && e.touches?.length === 2) {
          e.preventDefault();
          const [a, b] = e.touches;
          const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
          if (wallEditorPinch.dist > 0) {
            const ratio = dist / wallEditorPinch.dist;
            visualDraft = {
              ...visualDraft,
              wallZoom: clampWall(wallEditorPinch.zoom * ratio, 1, 2.5),
            };
            applyDraftPos();
          }
          return;
        }
        if (!wallEditorDrag) return;
        e.preventDefault();
        const p = pointerPos(e);
        const dx = p.x - wallEditorDrag.x;
        const dy = p.y - wallEditorDrag.y;
        wallEditorDrag.x = p.x;
        wallEditorDrag.y = p.y;
        const rect = stage.getBoundingClientRect();
        const zoom = Math.max(1, visualDraft.wallZoom || 1);
        const sensX = (100 / Math.max(1, rect.width)) / zoom;
        const sensY = (100 / Math.max(1, rect.height)) / zoom;
        visualDraft = {
          ...visualDraft,
          wallX: clampWall(visualDraft.wallX - dx * sensX, 0, 100),
          wallY: clampWall(visualDraft.wallY - dy * sensY, 0, 100),
        };
        applyDraftPos();
      };

      const onUp = () => {
        wallEditorDrag = null;
        wallEditorPinch = null;
        stage.classList.remove('is-dragging');
      };

      stage.addEventListener(
        'touchstart',
        (e) => {
          if (!visualDraft.wallpaper) return;
          if (e.touches.length === 2) {
            e.preventDefault();
            const [a, b] = e.touches;
            wallEditorPinch = {
              dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
              zoom: visualDraft.wallZoom || 1,
            };
            wallEditorDrag = null;
            return;
          }
          if (e.touches.length === 1) {
            const t = e.touches[0];
            wallEditorDrag = { x: t.clientX, y: t.clientY };
            stage.classList.add('is-dragging');
          }
        },
        { passive: false }
      );
      stage.addEventListener('touchmove', onMove, { passive: false });
      stage.addEventListener('touchend', onUp);
      stage.addEventListener('touchcancel', onUp);

      stage.addEventListener('pointerdown', (e) => {
        if (!visualDraft.wallpaper) return;
        if (e.pointerType === 'touch') return;
        if (e.button != null && e.button !== 0) return;
        e.preventDefault();
        const p = pointerPos(e);
        wallEditorDrag = { x: p.x, y: p.y };
        stage.classList.add('is-dragging');
        stage.setPointerCapture?.(e.pointerId);
      });
      stage.addEventListener('pointermove', onMove);
      stage.addEventListener('pointerup', onUp);
      stage.addEventListener('pointercancel', onUp);
      stage.addEventListener('lostpointercapture', onUp);

      $('commsWallEditorZoom')?.addEventListener('input', (e) => {
        const pct = clampWall(e.target.value, 100, 250);
        visualDraft = { ...visualDraft, wallZoom: pct / 100 };
        applyDraftPos();
      });
      $('commsWallEditorCenter')?.addEventListener('click', () => {
        visualDraft = { ...visualDraft, wallX: 50, wallY: 50, wallZoom: 1 };
        applyDraftPos();
      });
      $('commsWallEditorDone')?.addEventListener('click', hideWallEditor);
      $('commsWallEditorTip')?.addEventListener('click', (e) => {
        if (e.target === $('commsWallEditorTip')) hideWallEditor();
      });

      const pickEditorFile = async (file) => {
        if (!file) return;
        if (isWallLockedTheme(visualDraft.theme)) {
          notify(
            visualDraft.theme === 'rose'
              ? 'tema rosa · sem wallpaper'
              : 'tema papel · sem wallpaper'
          );
          return;
        }
        try {
          const data = await compressImageFile(file);
          visualDraft = {
            ...visualDraft,
            wallpaper: data,
            wallX: 50,
            wallY: 50,
            wallZoom: 1,
          };
          syncVisualOptsUi();
          syncWallEditorUi();
        } catch (err) {
          notify(err?.message || 'falha na imagem');
        }
      };
      $('commsWallEditorFile')?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        await pickEditorFile(file);
      });

      $('commsEditorBubbleMeOpts')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-bubble-me]');
        if (!btn || btn.disabled || btn.hidden || !BUBBLE_IDS.has(btn.dataset.bubbleMe)) return;
        if (visualDraft.theme === 'paper' && btn.dataset.bubbleMe !== 'classic') return;
        if (visualDraft.theme === 'rose' && !ROSE_BUBBLE_IDS.has(btn.dataset.bubbleMe)) return;
        if (visualDraft.theme !== 'rose' && !BASE_BUBBLE_IDS.has(btn.dataset.bubbleMe)) return;
        visualDraft = { ...visualDraft, bubbleMe: btn.dataset.bubbleMe };
        syncVisualOptsUi();
        syncWallEditorUi();
      });
      $('commsEditorBubbleThemOpts')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-bubble-them]');
        if (!btn || btn.disabled || btn.hidden || !BUBBLE_IDS.has(btn.dataset.bubbleThem)) return;
        if (visualDraft.theme === 'paper' && btn.dataset.bubbleThem !== 'classic') return;
        if (visualDraft.theme === 'rose' && !ROSE_BUBBLE_IDS.has(btn.dataset.bubbleThem)) return;
        if (visualDraft.theme !== 'rose' && !BASE_BUBBLE_IDS.has(btn.dataset.bubbleThem)) return;
        visualDraft = { ...visualDraft, bubbleThem: btn.dataset.bubbleThem };
        syncVisualOptsUi();
        syncWallEditorUi();
      });
      $('commsEditorThemeOpts')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-theme]');
        if (!btn || !THEME_IDS.has(btn.dataset.theme)) return;
        const theme = btn.dataset.theme;
        visualDraft = draftForTheme(theme, visualDraft);
        syncVisualOptsUi();
        syncWallEditorUi();
        if (isWallLockedTheme(theme)) hideWallEditor();
      });
      $('commsEditorHighlightOpts')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-highlight]');
        if (!btn || !HIGHLIGHT_IDS.has(btn.dataset.highlight)) return;
        visualDraft = { ...visualDraft, highlightStyle: btn.dataset.highlight };
        syncVisualOptsUi();
      });
      $('commsEditorHighlightColorMeOpts')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-highlight-color-me]');
        if (!btn || !HIGHLIGHT_COLOR_IDS.has(btn.dataset.highlightColorMe)) return;
        visualDraft = { ...visualDraft, highlightColorMe: btn.dataset.highlightColorMe };
        syncVisualOptsUi();
      });
      $('commsEditorHighlightColorThemOpts')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-highlight-color-them]');
        if (!btn || !HIGHLIGHT_COLOR_IDS.has(btn.dataset.highlightColorThem)) return;
        visualDraft = { ...visualDraft, highlightColorThem: btn.dataset.highlightColorThem };
        syncVisualOptsUi();
      });

      $('commsWallHowtoSkip')?.addEventListener('click', () => hideWallHowto(true));
      $('commsWallHowtoNext')?.addEventListener('click', () => {
        if (wallHowtoStep >= 2) {
          hideWallHowto(true);
          return;
        }
        wallHowtoStep += 1;
        syncWallHowtoUi();
      });
    }

    function wireVisual() {
      applyVisualToRoom(visualApplied);
      wireWallDrag();
      wireWallEditor();
      $('commsVisualBtn')?.addEventListener('click', () => {
        const panel = $('commsMorePanel');
        if (panel) panel.hidden = true;
        $('commsMoreBtn')?.setAttribute('aria-expanded', 'false');
        showVisualTip();
      });
      $('commsBubbleMeOpts')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-bubble-me]');
        if (!btn || btn.disabled || btn.hidden || !BUBBLE_IDS.has(btn.dataset.bubbleMe)) return;
        if (visualDraft.theme === 'paper' && btn.dataset.bubbleMe !== 'classic') return;
        if (visualDraft.theme === 'rose' && !ROSE_BUBBLE_IDS.has(btn.dataset.bubbleMe)) return;
        if (visualDraft.theme !== 'rose' && !BASE_BUBBLE_IDS.has(btn.dataset.bubbleMe)) return;
        visualDraft = { ...visualDraft, bubbleMe: btn.dataset.bubbleMe };
        syncVisualOptsUi();
      });
      $('commsBubbleThemOpts')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-bubble-them]');
        if (!btn || btn.disabled || btn.hidden || !BUBBLE_IDS.has(btn.dataset.bubbleThem)) return;
        if (visualDraft.theme === 'paper' && btn.dataset.bubbleThem !== 'classic') return;
        if (visualDraft.theme === 'rose' && !ROSE_BUBBLE_IDS.has(btn.dataset.bubbleThem)) return;
        if (visualDraft.theme !== 'rose' && !BASE_BUBBLE_IDS.has(btn.dataset.bubbleThem)) return;
        visualDraft = { ...visualDraft, bubbleThem: btn.dataset.bubbleThem };
        syncVisualOptsUi();
      });
      $('commsThemeOpts')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-theme]');
        if (!btn || !THEME_IDS.has(btn.dataset.theme)) return;
        visualDraft = draftForTheme(btn.dataset.theme, visualDraft);
        syncVisualOptsUi();
      });
      $('commsWallFile')?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        if (isWallLockedTheme(visualDraft.theme)) {
          notify(
            visualDraft.theme === 'rose'
              ? 'tema rosa · sem wallpaper'
              : 'tema papel · sem wallpaper'
          );
          return;
        }
        try {
          const data = await compressImageFile(file);
          visualDraft = {
            ...visualDraft,
            wallpaper: data,
            wallX: 50,
            wallY: 50,
            wallZoom: 1,
          };
          syncVisualOptsUi();
          showWallEditor();
        } catch (err) {
          notify(err?.message || 'falha na imagem');
        }
      });
      $('commsWallClear')?.addEventListener('click', () => {
        if (isWallLockedTheme(visualDraft.theme)) return;
        visualDraft = {
          ...visualDraft,
          wallpaper: null,
          wallX: 50,
          wallY: 50,
          wallZoom: 1,
        };
        syncVisualOptsUi();
      });
      $('commsWallExpand')?.addEventListener('click', () => {
        if (isWallLockedTheme(visualDraft.theme)) {
          notify(
            visualDraft.theme === 'rose'
              ? 'tema rosa · sem wallpaper'
              : 'tema papel · sem wallpaper'
          );
          return;
        }
        showWallEditor();
      });
      $('commsVisualCancel')?.addEventListener('click', hideVisualTip);
      $('commsPreviewHighlightTest')?.addEventListener('click', () => {
        const msgMe = $('commsPreviewMsgMe');
        const msgThem = $('commsPreviewMsgThem');
        if (!msgMe || !msgThem) return;
        const highlightStyle = visualDraft.highlightStyle || 'pulse';
        const colorMe = visualDraft.highlightColorMe || '#fff';
        const colorThem = visualDraft.highlightColorThem || '#000';

        [msgMe, msgThem].forEach((msg) => {
          msg.classList.remove('highlighted');
          msg.removeAttribute('data-highlight-style');
          msg.style.removeProperty('--highlight-color');
          void msg.offsetWidth;
        });

        msgMe.classList.add('highlighted');
        msgMe.setAttribute('data-highlight-style', highlightStyle);
        msgMe.style.setProperty('--highlight-color', colorMe);

        msgThem.classList.add('highlighted');
        msgThem.setAttribute('data-highlight-style', highlightStyle);
        msgThem.style.setProperty('--highlight-color', colorThem);

        setTimeout(() => {
          [msgMe, msgThem].forEach((msg) => {
            msg.classList.remove('highlighted');
            msg.removeAttribute('data-highlight-style');
            msg.style.removeProperty('--highlight-color');
          });
        }, 4000);
      });
      $('commsVisualAdm')?.addEventListener('click', () => {
        applyAdmVisualToChannel();
      });
      $('commsVisualApply')?.addEventListener('click', async () => {
        const share = !!$('commsWallShare')?.checked;
        visualApplied = sanitizeVisual(visualDraft);
        saveVisual(visualApplied);
        if (share) {
          /* mantém o wallpaper local até o server confirmar o compartilhado */
          preferLocalVisual = false;
          savePreferLocalVisual(false);
          const r = await publishRoomVisual(visualApplied);
          if (r?.ok && r.visual) {
            const wall =
              r.visual.wallpaper ||
              (r.visual.hasWall ? visualApplied.wallpaper : null) ||
              null;
            roomVisual = {
              at: r.visual.at,
              by: r.visual.by,
              name: r.visual.name,
              theme: r.visual.theme,
              bubbleMe: r.visual.bubbleMe,
              bubbleThem: r.visual.bubbleThem,
              hasWall: !!wall || !!r.visual.hasWall,
              ...sanitizeWallPos(r.visual),
            };
            roomWallData = wall;
            roomVisualFetchAt = r.visual.at;
            applyVisualToRoom(visualApplied);
            notify('visual aplicado pra todos no canal');
          } else {
            preferLocalVisual = true;
            savePreferLocalVisual(true);
            applyVisualToRoom(visualApplied);
            notify(r?.error || 'não deu pra mandar o visual');
          }
        } else {
          preferLocalVisual = true;
          savePreferLocalVisual(true);
          applyVisualToRoom(visualApplied);
          notify(
            roomVisual?.at
              ? 'visual só pra ti · o canal continua com o compartilhado pros outros'
              : 'visual do chat atualizado'
          );
        }
        hideVisualTip();
      });
      $('commsVisualTip')?.addEventListener('click', (e) => {
        if (e.target === $('commsVisualTip')) hideVisualTip();
      });
    }

    const Radio = (() => {
      let ytPlayer = null;
      let ytReady = null;
      let ytApiLoading = false;
      let activePlay = null; // { kind, title, videoId?, stream? }
      let pausedPlay = null; // último stop — pra /resume
      let keepAliveTimer = null;
      let keepAliveWorker = null;
      let wakeLock = null;
      let foregroundResumeTimer = 0;
      let playbackDone = false; /* true depois que a faixa acabou — bloqueia auto-resume */
      const lyrics =
        window.DeckLyrics?.createPanel?.('commsLyrics') || {
          load: async () => {},
          clear: () => {},
          stop: () => {},
        };

      const LYRICS_PREF = 'voidwire-comms-lyrics-on';

      function lyricsEnabled() {
        try {
          return localStorage.getItem(LYRICS_PREF) === '1';
        } catch {
          return false;
        }
      }

      function setLyricsEnabled(on) {
        try {
          localStorage.setItem(LYRICS_PREF, on ? '1' : '0');
        } catch {
          /* ignore */
        }
      }

      function updateLyricsGate() {
        const enable = $('commsLyricsEnable');
        if (!enable) return;
        const show = !!activePlay && !lyricsEnabled();
        enable.hidden = !show;
        if (show) lyrics.clear();
      }

      function showLyricsTip() {
        const tip = $('commsLyricsTip');
        if (!tip) return;
        tip.hidden = false;
        requestAnimationFrame(() => tip.classList.add('on'));
      }

      function hideLyricsTip() {
        const tip = $('commsLyricsTip');
        if (!tip) return;
        tip.classList.remove('on');
        setTimeout(() => {
          if (!tip.classList.contains('on')) tip.hidden = true;
        }, 220);
      }

      /* viz do painel de letras — só álbum (mesmo-origin); YT usa tempo da faixa */
      let vizCtx = null;
      let vizAnalyser = null;
      let vizSource = null;
      const vizWave = new Uint8Array(256);

      function ensureAlbumVizGraph() {
        const a = audioEl();
        if (!a || vizSource) return;
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        try {
          vizCtx = vizCtx || new Ctx();
          vizAnalyser = vizCtx.createAnalyser();
          vizAnalyser.fftSize = 512;
          vizAnalyser.smoothingTimeConstant = 0.72;
          /* MediaElementSource só uma vez por <audio> */
          vizSource = vizCtx.createMediaElementSource(a);
          vizSource.connect(vizAnalyser);
          vizAnalyser.connect(vizCtx.destination);
        } catch {
          vizSource = null;
          vizAnalyser = null;
        }
      }

      async function resumeVizCtx() {
        if (vizCtx && vizCtx.state === 'suspended') {
          try {
            await vizCtx.resume();
          } catch {
            /* ignore */
          }
        }
      }

      function getWaveform() {
        if (activePlay?.kind !== 'album' || !vizAnalyser) return null;
        try {
          vizAnalyser.getByteTimeDomainData(vizWave);
          return vizWave;
        } catch {
          return null;
        }
      }

      function isPlayingNow() {
        try {
          if (activePlay?.kind === 'album') {
            const a = audioEl();
            return !!(a && a.src && !a.paused && !a.ended);
          }
          if (activePlay?.kind === 'yt') return ytIsPlaying();
          if (activePlay?.kind === 'spotify') return !!activePlay && !spotPaused;
        } catch {
          /* ignore */
        }
        return false;
      }

      function lyricsClock() {
        const kind = activePlay?.kind;
        /* Spotify Web Playback reporta posição atrasada vs o áudio */
        const lead = kind === 'spotify' ? 0.85 : kind === 'yt' ? 0.35 : 0.15;
        return {
          getPos: getPosition,
          isPlaying: isPlayingNow,
          getWaveform,
          lead,
        };
      }

      /* —— Spotify Web Playback —— */
      const SPOT_KEY = 'voidwire-spotify-v1';
      let spotPlayer = null;
      let spotDeviceId = null;
      let spotReady = null;
      let spotCfgOk = null;
      let spotPosSec = 0;
      let spotPosAt = 0; /* performance.now() quando spotPosSec foi setado */
      let spotPaused = true;
      let spotNearEnd = false;
      let lastSpotPlayReq = null; /* { uri, id, title, seek, ytFallback } */
      let spotProduct = null; /* 'premium' | 'free' | ... */
      let spotReclaimTimer = 0;
      let spotReclaimBusy = false;
      let spotReclaimLastAt = 0;
      let audioGestureAt = 0;
      let radioAdvanceBusy = false;

      /** Chrome/iOS: play via poll (CD-R) começa mudo — força volume */
      function unlockAudioGesture() {
        audioGestureAt = Date.now();
        try {
          spotPlayer?.activateElement?.();
        } catch {
          /* ignore */
        }
      }

      function ensurePlaybackAudible() {
        try {
          if (activePlay?.kind === 'yt' && ytPlayer) {
            ytPlayer.unMute?.();
            ytPlayer.setVolume?.(80);
            if (!ytIsPlaying?.() && !playbackDone) ytPlayer.playVideo?.();
          }
        } catch {
          /* ignore */
        }
        try {
          if (activePlay?.kind === 'spotify' && spotPlayer) {
            spotPlayer.activateElement?.();
            spotPlayer.setVolume?.(0.8)?.catch?.(() => {});
            if (!spotPaused && !playbackDone) spotPlayer.resume?.().catch?.(() => {});
          }
        } catch {
          /* ignore */
        }
      }

      function setSpotPos(sec, paused) {
        spotPosSec = Math.max(0, Number(sec) || 0);
        spotPosAt = performance.now();
        if (typeof paused === 'boolean') spotPaused = paused;
      }

      function getSpotPosEst() {
        if (spotPaused) return spotPosSec;
        const elapsed = (performance.now() - spotPosAt) / 1000;
        /* +0.25s: SDK costuma reportar um pouco atrás do áudio real */
        return Math.max(0, spotPosSec + elapsed + 0.25);
      }

      function finishSpotifyTrack() {
        if (spotReclaimTimer) {
          clearTimeout(spotReclaimTimer);
          spotReclaimTimer = 0;
        }
        if (playbackDone && !activePlay) {
          killSpotifyOutput();
          return;
        }
        playbackDone = true;
        activePlay = null;
        spotNearEnd = false;
        spotPaused = true;
        lastSpotPlayReq = null;
        lyrics.clear();
        stopKeepAlive();
        setMediaSession(null);
        killSpotifyOutput();
        requestRadioAdvance();
      }

      /** fim natural da faixa → pede próxima do rádio/mix se estiver ligado */
      async function requestRadioAdvance() {
        try {
          if (state.peerId) {
            delete state.listeningByPeer[String(state.peerId)];
          }
          state.alongWith = null;
          state.alongTrackKey = '';
          refreshNowPlayingFromState();
        } catch {
          /* ignore */
        }
        try {
          updateLyricsGate();
        } catch {
          /* ignore */
        }
        if (!state.code || !state.peerId) return;
        if (radioAdvanceBusy) return;
        radioAdvanceBusy = true;
        try {
          const r = await postPresence({
            trackEnded: true,
            listening: null,
            alongWith: null,
          });
          if (!r?.ok) return;
          (r.messages || []).forEach(pushMsg);
          if (typeof r.cdr === 'boolean') state.cdr = r.cdr;
          if (r.pendingPlay?.kind && r.pendingPlay.kind !== 'stop') {
            state.alongWith = null;
            state.alongTrackKey = trackKeyOf(r.pendingPlay);
            await apply(r.pendingPlay);
            ensurePlaybackAudible();
            await postPresence();
          }
        } catch {
          /* ignore */
        } finally {
          radioAdvanceBusy = false;
        }
      }

      /** para o áudio no Spotify do user (browser + Connect) */
      function killSpotifyOutput() {
        try {
          spotPlayer?.pause?.();
        } catch {
          /* ignore */
        }
        const deviceId = spotDeviceId;
        if (spotConnected()) {
          const q = deviceId
            ? `/me/player/pause?device_id=${encodeURIComponent(deviceId)}`
            : '/me/player/pause';
          spotApi(q, { method: 'PUT' }).catch(() => {});
          /* sem device também — às vezes o play foi pro app do PC/celular */
          if (deviceId) {
            spotApi('/me/player/pause', { method: 'PUT' }).catch(() => {});
          }
        }
      }

      /**
       * App Spotify / outro device roubou o Connect → puxa de volta pro deck.
       * Só no meio da faixa (não no fim).
       */
      async function reclaimSpotifyPlayback() {
        if (spotReclaimBusy || playbackDone) return false;
        if (!activePlay || activePlay.kind !== 'spotify' || !activePlay.uri) return false;
        if (isNearTrackEnd()) return false;
        if (!spotConnected()) return false;
        if (Date.now() - spotReclaimLastAt < 2500) return false;
        spotReclaimBusy = true;
        spotReclaimLastAt = Date.now();
        try {
          let deviceId = spotDeviceId;
          if (!deviceId) {
            try {
              deviceId = await ensureSpotPlayer();
            } catch {
              return false;
            }
          }
          try {
            await spotPlayer?.activateElement?.();
          } catch {
            /* ignore */
          }
          const seekMs = Math.floor(Math.max(0, getSpotPosEst()) * 1000);
          await spotApi(`/me/player/play?device_id=${encodeURIComponent(deviceId)}`, {
            method: 'PUT',
            body: JSON.stringify({
              uris: [activePlay.uri],
              position_ms: seekMs,
            }),
          });
          setSpotPos(seekMs / 1000, false);
          spotPaused = false;
          return true;
        } catch {
          return false;
        } finally {
          spotReclaimBusy = false;
        }
      }

      function scheduleSpotifyReclaim(delayMs = 500) {
        if (playbackDone || activePlay?.kind !== 'spotify') return;
        if (spotNearEnd || isNearTrackEnd()) return;
        if (spotReclaimTimer) clearTimeout(spotReclaimTimer);
        spotReclaimTimer = setTimeout(() => {
          spotReclaimTimer = 0;
          if (playbackDone || spotNearEnd || isNearTrackEnd()) return;
          reclaimSpotifyPlayback(); /* silencioso — sem toast (toast confundia com fim da faixa) */
        }, delayMs);
      }

      function isNearTrackEnd() {
        if (!activePlay) return true;
        try {
          if (activePlay.kind === 'album') {
            const a = audioEl();
            if (!a?.duration || !Number.isFinite(a.duration)) return false;
            return a.ended || a.currentTime >= a.duration - 1.25;
          }
          if (activePlay.kind === 'yt' && ytPlayer?.getDuration) {
            const dur = Number(ytPlayer.getDuration()) || 0;
            const t = Number(ytPlayer.getCurrentTime?.()) || 0;
            if (dur < 5) return false;
            return t >= dur - 1.25;
          }
          if (activePlay.kind === 'spotify') {
            const dur = Number(activePlay.duration) || 0;
            if (dur < 5) return false;
            return getSpotPosEst() >= dur - 1.5;
          }
        } catch {
          /* ignore */
        }
        return false;
      }

      /** true se a faixa acabou (ou o Spotify tentou repetir) */
      function handleSpotifyState(st) {
        if (!st) return false;
        const pos = Math.max(0, (Number(st.position) || 0) / 1000);
        const dur = Math.max(0, (Number(st.duration) || 0) / 1000);
        setSpotPos(pos, !!st.paused);
        if (!activePlay || activePlay.kind !== 'spotify') return false;
        if (dur >= 5) activePlay.duration = dur;

        /* acabou de verdade */
        if (st.paused && dur >= 5 && pos >= dur - 1.25) {
          finishSpotifyTrack();
          return true;
        }
        /* Spotify reiniciou sozinho (repeat / resume) — mata na hora */
        if (!st.paused && dur >= 15 && pos < 2.5 && spotNearEnd) {
          finishSpotifyTrack();
          return true;
        }
        /* faixa terminou e o SDK ainda “toca” no zero */
        if (!st.paused && dur >= 15 && pos < 0.35 && (Number(st.position) || 0) === 0) {
          const wasNear = spotNearEnd;
          if (wasNear) {
            finishSpotifyTrack();
            return true;
          }
        }
        spotNearEnd = dur >= 5 && pos >= Math.max(0, dur - 4);
        return false;
      }

      function readSpotTokens() {
        try {
          const raw = localStorage.getItem(SPOT_KEY);
          if (!raw) return null;
          const j = JSON.parse(raw);
          if (!j?.access || !j?.refresh) return null;
          return j;
        } catch {
          return null;
        }
      }

      function writeSpotTokens( partial ) {
        const cur = readSpotTokens() || {};
        const next = { ...cur, ...partial };
        try {
          localStorage.setItem(SPOT_KEY, JSON.stringify(next));
        } catch {
          /* ignore */
        }
        syncSpotifyBtn();
      }

      function clearSpotTokens() {
        try {
          localStorage.removeItem(SPOT_KEY);
        } catch {
          /* ignore */
        }
        syncSpotifyBtn();
      }

      function spotConnected() {
        return !!readSpotTokens()?.refresh;
      }

      async function ensureSpotifyConfigured() {
        if (spotCfgOk != null) return spotCfgOk;
        try {
          const r = await fetch('/api/deck/spotify/status').then((x) => x.json());
          spotCfgOk = !!r?.configured;
        } catch {
          spotCfgOk = false;
        }
        syncSpotifyBtn();
        return spotCfgOk;
      }

      function syncSpotifyBtn() {
        const btn = $('commsSpotifyBtn');
        if (!btn) return;
        btn.hidden = false;
        if (spotCfgOk === false) {
          btn.textContent = 'Spotify · setup';
          btn.classList.remove('on');
          btn.title = 'falta configurar spotify.local.json no server';
          return;
        }
        const on = spotConnected();
        if (on && spotProduct && spotProduct !== 'premium') {
          btn.textContent = 'Spotify · free';
          btn.classList.toggle('on', true);
          btn.title = 'conta Free — no canal o play cai no YouTube. Premium libera o player Spotify.';
        } else {
          btn.textContent = on ? 'Spotify · ok' : 'conectar Spotify';
          btn.classList.toggle('on', on);
          btn.title = on
            ? 'Spotify conectado (Premium). Clique pra desconectar.'
            : 'conectar Spotify Premium pra tocar no canal';
        }
      }

      async function refreshSpotProduct() {
        if (!spotConnected()) {
          spotProduct = null;
          return null;
        }
        try {
          const me = await spotApi('/me');
          spotProduct = String(me?.product || '').toLowerCase() || null;
          /* guarda pra debug no console */
          try {
            console.info(
              '[spotify]',
              me?.display_name || '?',
              'product=',
              spotProduct,
              'id=',
              (me?.id || '').slice(0, 6) + '…'
            );
          } catch {
            /* ignore */
          }
        } catch (e) {
          spotProduct = null;
          try {
            console.warn('[spotify] /me falhou', e?.message || e);
          } catch {
            /* ignore */
          }
        }
        syncSpotifyBtn();
        return spotProduct;
      }

      function showSpotifySetupTip() {
        const tip = $('commsSpotifyTip');
        if (!tip) {
          notify('falta DEATHDECK/spotify.local.json · vê o example');
          return;
        }
        tip.hidden = false;
        requestAnimationFrame(() => tip.classList.add('on'));
      }

      function hideSpotifySetupTip() {
        const tip = $('commsSpotifyTip');
        if (!tip) return;
        tip.classList.remove('on');
        setTimeout(() => {
          if (!tip.classList.contains('on')) tip.hidden = true;
        }, 220);
      }

      function showDeckTip(id) {
        const tip = $(id);
        if (!tip) return false;
        tip.hidden = false;
        requestAnimationFrame(() => tip.classList.add('on'));
        return true;
      }

      function hideDeckTip(id) {
        const tip = $(id);
        if (!tip) return;
        tip.classList.remove('on');
        setTimeout(() => {
          if (!tip.classList.contains('on')) tip.hidden = true;
        }, 220);
      }

      function showSpotifyConnectTip() {
        return showDeckTip('commsSpotifyConnectTip');
      }

      function hideSpotifyConnectTip() {
        hideDeckTip('commsSpotifyConnectTip');
      }

      function showSpotifyDisconnectTip() {
        return showDeckTip('commsSpotifyDisconnectTip');
      }

      function hideSpotifyDisconnectTip() {
        hideDeckTip('commsSpotifyDisconnectTip');
      }

      function disconnectSpotifyLocal() {
        clearSpotTokens();
        try {
          spotPlayer?.disconnect?.();
        } catch {
          /* ignore */
        }
        spotPlayer = null;
        spotDeviceId = null;
        spotReady = null;
        spotProduct = null;
        syncSpotifyBtn();
        notify('Spotify desconectado');
      }

      async function getSpotAccessToken() {
        let t = readSpotTokens();
        if (!t?.refresh) throw new Error('conecta o Spotify no ⋯');
        if (t.access && t.exp && Date.now() < t.exp - 20000) return t.access;
        const r = await fetch('/api/deck/spotify/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: t.refresh }),
        }).then((x) => x.json());
        if (!r?.ok || !r.access_token) {
          /* só limpa se o refresh realmente morreu */
          const fatal = /invalid|revoked|expired|ausente/i.test(String(r?.error || ''));
          if (fatal) clearSpotTokens();
          throw new Error(r?.error || 'Spotify expirou — conecta de novo');
        }
        writeSpotTokens({
          access: r.access_token,
          refresh: r.refresh_token || t.refresh,
          exp: Date.now() + Number(r.expires_in || 3600) * 1000,
        });
        return r.access_token;
      }

      function loadSpotifySdk() {
        return new Promise((resolve, reject) => {
          if (window.Spotify?.Player) {
            resolve(window.Spotify);
            return;
          }
          let settled = false;
          const done = (ok, err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (ok) resolve(window.Spotify);
            else reject(err || new Error('Spotify SDK falhou'));
          };
          const prev = window.onSpotifyWebPlaybackSDKReady;
          const timer = setTimeout(() => done(false, new Error('Spotify SDK timeout')), 12000);
          window.onSpotifyWebPlaybackSDKReady = () => {
            try {
              if (typeof prev === 'function') prev();
            } catch {
              /* ignore */
            }
            if (window.Spotify?.Player) done(true);
            else done(false, new Error('Spotify SDK falhou'));
          };
          const existing = [...document.scripts].find((s) => /spotify-player\.js/.test(s.src));
          if (existing) {
            if (window.Spotify?.Player) done(true);
            return;
          }
          const s = document.createElement('script');
          s.src = 'https://sdk.scdn.co/spotify-player.js';
          s.async = true;
          s.onerror = () => done(false, new Error('Spotify SDK load fail'));
          document.head.appendChild(s);
        });
      }

      async function ensureSpotPlayer() {
        if (spotPlayer && spotDeviceId) return spotDeviceId;
        if (spotReady) return spotReady;
        spotReady = (async () => {
          if (spotPlayer) {
            try {
              spotPlayer.disconnect();
            } catch {
              /* ignore */
            }
            spotPlayer = null;
            spotDeviceId = null;
          }
          const Spotify = await loadSpotifySdk();
          await getSpotAccessToken();
          spotPlayer = new Spotify.Player({
            name: 'DEATHDECK · COMMS',
            getOAuthToken: (cb) => {
              getSpotAccessToken()
                .then((tok) => cb(tok))
                .catch(() => {
                  /* não passa '' — isso dispara authentication_error e matava o login */
                });
            },
            volume: 0.7,
          });
          await new Promise((resolve, reject) => {
            let settled = false;
            const ok = () => {
              if (settled) return;
              settled = true;
              resolve();
            };
            const bad = (e) => {
              if (settled) return;
              settled = true;
              reject(e || new Error('Spotify player'));
            };
            spotPlayer.addListener('ready', ({ device_id }) => {
              spotDeviceId = device_id;
              ok();
            });
            spotPlayer.addListener('not_ready', () => {
              spotDeviceId = null;
            });
            spotPlayer.addListener('initialization_error', ({ message }) => bad(new Error(message)));
            spotPlayer.addListener('authentication_error', ({ message }) => {
              /* mantém refresh no localStorage — só desconecta o player */
              spotDeviceId = null;
              bad(new Error(message || 'auth Spotify'));
            });
            spotPlayer.addListener('account_error', ({ message }) =>
              bad(new Error(message || 'precisa Premium'))
            );
            spotPlayer.addListener('autoplay_failed', () => {
              const req = lastSpotPlayReq;
              if (!req?.ytFallback?.videoId) {
                notify('Chrome bloqueou o Spotify · clica em qualquer lugar do site e manda /coloca de novo');
                return;
              }
              const fb = req.ytFallback;
              activePlay = null;
              stopSpotify().catch(() => {});
              playYt({ ...fb, seek: req.seek || 0 }).then(() => {
                notify('Chrome bloqueou Spotify · toquei no YouTube');
              });
            });
            spotPlayer.addListener('player_state_changed', (st) => {
              if (handleSpotifyState(st)) return;
              if (!activePlay || activePlay.kind !== 'spotify' || playbackDone) return;
              if (spotNearEnd || isNearTrackEnd()) return;
              /* app Spotify / outro device: state some ou pausa no meio (NÃO no fim) */
              if (!st) {
                scheduleSpotifyReclaim(400);
                return;
              }
              if (st.paused) {
                const pos = Math.max(0, (Number(st.position) || 0) / 1000);
                const dur = Math.max(0, (Number(st.duration) || 0) / 1000);
                if (dur >= 5 && pos >= dur - 3) {
                  finishSpotifyTrack();
                  return;
                }
                scheduleSpotifyReclaim(550);
              }
            });
            /* resync do relógio + recupera se o app roubar o device */
            if (!spotPlayer._deckPosPoll) {
              spotPlayer._deckPosPoll = setInterval(() => {
                if (!spotPlayer || activePlay?.kind !== 'spotify' || playbackDone) return;
                if (spotNearEnd || isNearTrackEnd()) return;
                spotPlayer
                  .getCurrentState()
                  .then((st) => {
                    if (handleSpotifyState(st)) return;
                    if (
                      !st &&
                      activePlay?.kind === 'spotify' &&
                      !playbackDone &&
                      !spotNearEnd
                    ) {
                      scheduleSpotifyReclaim(600);
                    }
                  })
                  .catch(() => {});
                if (!spotDeviceId || !spotConnected()) return;
                spotApi('/me/player')
                  .then((cur) => {
                    if (!cur || playbackDone || activePlay?.kind !== 'spotify') return;
                    if (spotNearEnd || isNearTrackEnd()) return;
                    const dev = cur.device?.id;
                    /* só reclama se OUTRO device está ativo — não no fim da faixa */
                    if (dev && spotDeviceId && dev !== spotDeviceId && cur.is_playing) {
                      scheduleSpotifyReclaim(350);
                    }
                  })
                  .catch(() => {});
              }, 2000);
            }
            spotPlayer.connect().then((success) => {
              if (!success) bad(new Error('não conectou o player'));
            });
            setTimeout(() => {
              if (!spotDeviceId) bad(new Error('device Spotify timeout'));
            }, 10000);
          });
          return spotDeviceId;
        })();
        try {
          return await spotReady;
        } catch (e) {
          spotReady = null;
          spotPlayer = null;
          spotDeviceId = null;
          throw e;
        }
      }

      async function spotApi(path, opts = {}) {
        const token = await getSpotAccessToken();
        const res = await fetch(`https://api.spotify.com/v1${path}`, {
          ...opts,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...(opts.headers || {}),
          },
        });
        if (res.status === 204) return null;
        const text = await res.text();
        let data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          data = { raw: text };
        }
        if (!res.ok) {
          const msg = data?.error?.message || data?.error || `Spotify ${res.status}`;
          const reason = data?.error?.reason ? ` · ${data.error.reason}` : '';
          throw new Error(`${String(msg)}${reason}`.trim());
        }
        return data;
      }

      async function stopSpotify() {
        killSpotifyOutput();
      }

      async function playSpotify(play) {
        stopYt();
        stopAlbum();
        if (!play?.uri) return;
        playbackDone = false;

        async function fallbackYt(reason) {
          if (play.ytFallback?.videoId) {
            await playYt({ ...play.ytFallback, seek: play.seek || 0 });
            notify(reason || 'toquei no YouTube');
            return true;
          }
          return false;
        }

        if (!spotConnected()) {
          if (await fallbackYt('Spotify off · YouTube')) return;
          notify('conecta o Spotify no ⋯ (Premium)');
          return;
        }

        if (spotProduct == null) {
          await refreshSpotProduct().catch(() => {});
        }
        /* Free: Web Playback /me/player sempre 403 — vai pro YT sem drama */
        if (spotProduct && spotProduct !== 'premium') {
          if (await fallbackYt('Spotify Free · toquei no YouTube')) return;
          notify('precisa Spotify Premium pra tocar no player do site');
          return;
        }

        try {
          const deviceId = await ensureSpotPlayer();
          try {
            await spotPlayer?.activateElement?.();
          } catch {
            /* ignore */
          }
          lastSpotPlayReq = {
            uri: play.uri,
            id: play.id,
            title: play.title,
            seek: play.seek || 0,
            ytFallback: play.ytFallback || null,
          };
          activePlay = {
            kind: 'spotify',
            title: play.title || 'Spotify',
            uri: play.uri,
            id: play.id,
          };
          const seekMs =
            typeof play.seek === 'number' && play.seek > 0.4
              ? Math.floor(play.seek * 1000)
              : 0;
          /* play direto no device — transfer /me/player costuma 403 e polui o console */
          const playBody = JSON.stringify({
            uris: [play.uri],
            position_ms: seekMs,
          });
          const playPath = `/me/player/play?device_id=${encodeURIComponent(deviceId)}`;
          try {
            await spotApi(playPath, { method: 'PUT', body: playBody });
          } catch (firstErr) {
            /* device às vezes ainda não “assentou” — espera e tenta 1x */
            await new Promise((r) => setTimeout(r, 700));
            try {
              await spotPlayer?.activateElement?.();
            } catch {
              /* ignore */
            }
            await spotApi(playPath, { method: 'PUT', body: playBody });
          }
          spotApi(
            `/me/player/repeat?state=off&device_id=${encodeURIComponent(deviceId)}`,
            { method: 'PUT' }
          ).catch(() => {});
          spotNearEnd = false;
          setSpotPos(seekMs / 1000, false);
          try {
            await spotPlayer?.setVolume?.(0.8);
          } catch {
            /* ignore */
          }
          ensurePlaybackAudible();
          setMediaSession(activePlay);
          startKeepAlive();
          loadLyricsForPlay(activePlay);
          notify(
            seekMs > 0
              ? `♪ sync · ${play.title || 'Spotify'}`
              : `♪ ${play.title || 'Spotify'}`
          );
        } catch (err) {
          activePlay = null;
          lyrics.clear();
          const msg = String(err?.message || '');
          const premiumBlock =
            /403|premium|restriction|not available|forbidden/i.test(msg);
          if (premiumBlock) {
            spotProduct = spotProduct === 'premium' ? spotProduct : 'free';
            syncSpotifyBtn();
            if (await fallbackYt('Spotify bloqueou o play · YouTube')) return;
            notify('Spotify recusou (Premium / restrição). Conecta Premium ou usa YouTube.');
            return;
          }
          if (await fallbackYt('Spotify falhou · YouTube')) return;
          notify(msg || 'Spotify falhou');
        }
      }

      function parseYtMeta(title) {
        const parsed = window.DeckLyrics?.parseTitle?.(title) || {
          track: title || '',
          artist: '',
        };
        return parsed;
      }

      async function loadLyricsForPlay(play) {
        updateLyricsGate();
        if (!lyricsEnabled()) {
          lyrics.clear();
          return;
        }
        if (!play?.title) {
          lyrics.clear();
          return;
        }
        if (play.kind === 'album') {
          await lyrics.load(
            {
              track: play.title,
              artist: play.artist || 'Panchiko',
              album: play.album || 'D>E>A>T>H>M>E>T>A>L',
              duration: play.duration || 0,
            },
            lyricsClock()
          );
          return;
        }
        if (play.kind === 'yt') {
          const meta = parseYtMeta(play.title);
          let duration = Number(play.duration) || 0;
          try {
            if (!duration && ytPlayer?.getDuration) {
              duration = Number(ytPlayer.getDuration()) || 0;
            }
          } catch {
            /* ignore */
          }
          await lyrics.load(
            {
              track: meta.track || play.title,
              artist: meta.artist || '',
              duration: duration >= 20 ? duration : 0,
            },
            lyricsClock()
          );
          return;
        }
        if (play.kind === 'spotify') {
          const meta = parseYtMeta(play.title);
          await lyrics.load(
            {
              track: meta.track || play.title,
              artist: meta.artist || '',
              duration: 0,
            },
            lyricsClock()
          );
        }
      }
      let resumeLock = false;

      function audioEl() {
        return $('commsRadioAudio');
      }

      function clearListeningPresence() {
        /* some a UI na hora — não espera o próximo poll */
        try {
          if (state.peerId) {
            delete state.listeningByPeer[String(state.peerId)];
          }
          state.alongWith = null;
          state.alongTrackKey = '';
          refreshNowPlayingFromState();
        } catch {
          /* ignore */
        }
        try {
          updateLyricsGate();
        } catch {
          /* ignore */
        }
        if (!state.code || !state.peerId) return;
        api(`/api/deck/comms/${state.code}/presence`, {
          method: 'POST',
          body: JSON.stringify({
            peerId: state.peerId,
            name: state.name,
            after: state.after,
            listening: null,
            alongWith: null,
          }),
        }).catch(() => {});
      }

      function setMediaSession(play) {
        if (!('mediaSession' in navigator)) return;
        try {
          if (!play) {
            navigator.mediaSession.metadata = null;
            navigator.mediaSession.playbackState = 'none';
            return;
          }
          navigator.mediaSession.metadata = new MediaMetadata({
            title: play.title || (play.kind === 'yt' ? 'YouTube' : play.kind === 'spotify' ? 'Spotify' : 'faixa'),
            artist: 'Panchiko · COMMS',
            album: play.kind === 'yt' ? 'YouTube' : play.kind === 'spotify' ? 'Spotify' : 'DEATHDECK',
          });
          navigator.mediaSession.playbackState = 'playing';
          navigator.mediaSession.setActionHandler?.('play', () => {
            if (!playbackDone && activePlay) resumePlayback();
          });
          navigator.mediaSession.setActionHandler?.('pause', () => {
            /* no fim da faixa o SO manda pause — não reinicia */
            if (playbackDone || isNearTrackEnd()) {
              if (activePlay?.kind === 'spotify') finishSpotifyTrack();
              else if (activePlay) {
                playbackDone = true;
                activePlay = null;
                lyrics.clear();
                stopKeepAlive();
                setMediaSession(null);
                requestRadioAdvance();
              }
              return;
            }
            /* mid-track: Chrome às vezes pausa sozinho no background */
            resumePlayback();
          });
        } catch {
          /* ignore */
        }
      }

      function stopKeepAliveWorker() {
        try {
          keepAliveWorker?.terminate?.();
        } catch {
          /* ignore */
        }
        keepAliveWorker = null;
      }

      function startKeepAliveWorker() {
        stopKeepAliveWorker();
        if (!activePlay || typeof Worker === 'undefined') return;
        if (document.visibilityState !== 'hidden') return;
        try {
          const src = 'setInterval(function(){postMessage(1)},1000);';
          const blob = new Blob([src], { type: 'application/javascript' });
          const url = URL.createObjectURL(blob);
          keepAliveWorker = new Worker(url);
          URL.revokeObjectURL(url);
          keepAliveWorker.onmessage = () => {
            if (!activePlay || playbackDone) return;
            if (isNearTrackEnd()) return;
            if (document.visibilityState === 'hidden') resumePlayback();
          };
        } catch {
          keepAliveWorker = null;
        }
      }

      function stopKeepAlive() {
        if (keepAliveTimer) {
          clearInterval(keepAliveTimer);
          keepAliveTimer = null;
        }
        if (foregroundResumeTimer) {
          clearTimeout(foregroundResumeTimer);
          foregroundResumeTimer = 0;
        }
        stopKeepAliveWorker();
        releasePlayWakeLock();
      }

      function startKeepAlive() {
        if (keepAliveTimer) {
          clearInterval(keepAliveTimer);
          keepAliveTimer = null;
        }
        if (!activePlay) {
          stopKeepAlive();
          return;
        }
        const hidden = document.visibilityState === 'hidden';
        if (hidden) {
          startKeepAliveWorker();
        } else {
          stopKeepAliveWorker();
          requestPlayWakeLock();
        }
        keepAliveTimer = setInterval(() => {
          if (!activePlay || playbackDone) {
            stopKeepAlive();
            return;
          }
          if (isNearTrackEnd()) return;
          if (document.visibilityState === 'hidden') resumePlayback();
        }, hidden ? 1000 : 4000);
      }

      function ytIsPlaying() {
        try {
          const st = ytPlayer?.getPlayerState?.();
          return st === 1 || st === 3; /* playing | buffering */
        } catch {
          return false;
        }
      }

      function resumePlayback() {
        if (!activePlay || resumeLock || playbackDone) return;
        if (isNearTrackEnd()) {
          if (activePlay.kind === 'spotify') finishSpotifyTrack();
          else {
            playbackDone = true;
            activePlay = null;
            lyrics.clear();
            stopKeepAlive();
            setMediaSession(null);
            requestRadioAdvance();
          }
          return;
        }
        resumeLock = true;
        try {
          if (activePlay.kind === 'yt' && ytPlayer?.playVideo) {
            try {
              ytPlayer.playVideo();
            } catch {
              /* ignore */
            }
          } else if (activePlay.kind === 'album') {
            const a = audioEl();
            if (a?.src && a.paused) a.play().catch(() => {});
          } else if (activePlay.kind === 'spotify') {
            /* NUNCA resume automático do Spotify — isso religa o app/conta do user */
            return;
          }
          if ('mediaSession' in navigator) {
            try {
              navigator.mediaSession.playbackState = 'playing';
            } catch {
              /* ignore */
            }
          }
        } catch {
          /* ignore */
        }
        resumeLock = false;
      }

      /** Ao voltar pra aba: o YT iframe muitas vezes morre — recria se não tocаr */
      async function hardResumeForeground() {
        if (!activePlay || playbackDone) return;
        if (isNearTrackEnd()) return;
        stopKeepAliveWorker();
        resumePlayback();
        if (activePlay.kind === 'album') {
          const a = audioEl();
          if (a?.src) {
            try {
              await a.play();
            } catch {
              /* autoplay bloqueado — user precisa tocar de novo */
            }
          }
          startKeepAlive();
          return;
        }
        if (activePlay.kind === 'spotify') {
          /* não chama resume — evita play fantasma no Spotify do user */
          startKeepAlive();
          return;
        }
        if (activePlay.kind !== 'yt' || !activePlay.videoId) {
          startKeepAlive();
          return;
        }
        await new Promise((r) => {
          foregroundResumeTimer = setTimeout(r, 350);
        });
        foregroundResumeTimer = 0;
        if (!activePlay || activePlay.kind !== 'yt') return;
        if (ytIsPlaying()) {
          startKeepAlive();
          return;
        }
        const seek = getPosition();
        const play = {
          kind: 'yt',
          videoId: activePlay.videoId,
          title: activePlay.title,
          seek: seek > 1 ? seek : 0,
        };
        try {
          await playYt(play);
        } catch {
          resumePlayback();
        }
        startKeepAlive();
      }

      async function requestPlayWakeLock() {
        try {
          if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
          if (wakeLock) return;
          wakeLock = await navigator.wakeLock.request('screen');
          wakeLock.addEventListener?.('release', () => {
            wakeLock = null;
          });
        } catch {
          wakeLock = null;
        }
      }

      function releasePlayWakeLock() {
        try {
          wakeLock?.release?.();
        } catch {
          /* ignore */
        }
        wakeLock = null;
      }

      function stopAlbum() {
        const a = audioEl();
        if (!a) return;
        try {
          a.pause();
          a.removeAttribute('src');
          a.load();
        } catch {
          /* ignore */
        }
      }

      function stopYt() {
        try {
          ytPlayer?.stopVideo?.();
          ytPlayer?.destroy?.();
        } catch {
          /* ignore */
        }
        ytPlayer = null;
        const host = $('commsYtHost');
        if (host) host.innerHTML = '';
      }

      function stopAll(clearPresence = true) {
        if (activePlay) {
          const stash = { ...activePlay };
          if (activePlay.kind === 'album') {
            const a = audioEl();
            try {
              stash.seek = a?.currentTime || 0;
              a?.pause();
            } catch {
              /* ignore */
            }
          } else if (activePlay.kind === 'yt') {
            try {
              ytPlayer?.pauseVideo?.();
            } catch {
              /* ignore */
            }
          } else if (activePlay.kind === 'spotify') {
            stash.seek = getSpotPosEst();
            stash.uri = activePlay.uri;
            try {
              spotPlayer?.pause?.();
            } catch {
              /* ignore */
            }
          }
          pausedPlay = stash;
        }
        activePlay = null;
        lyrics.clear();
        updateLyricsGate();
        stopKeepAlive();
        setMediaSession(null);
        if (clearPresence) clearListeningPresence();
      }

      async function resumeLast() {
        if (activePlay) {
          resumePlayback();
          return true;
        }
        const play = pausedPlay;
        if (!play?.kind) return false;

        if (play.kind === 'album') {
          const a = audioEl();
          const sameSrc =
            a &&
            play.stream &&
            (a.getAttribute('src') === play.stream ||
              (a.src && a.src.includes(encodeURIComponent(play.id || ''))));
          if (sameSrc) {
            activePlay = {
              kind: 'album',
              title: play.title,
              stream: play.stream,
              id: play.id,
              artist: play.artist,
              album: play.album,
              duration: play.duration,
            };
            try {
              if (typeof play.seek === 'number' && play.seek > 0) a.currentTime = play.seek;
              await a.play();
              setMediaSession(activePlay);
              startKeepAlive();
              loadLyricsForPlay(activePlay);
              pausedPlay = null;
              return true;
            } catch {
              /* apply completo abaixo */
            }
          }
          await playAlbum(play);
          const a2 = audioEl();
          if (a2 && typeof play.seek === 'number' && play.seek > 1) {
            try {
              a2.currentTime = play.seek;
            } catch {
              /* ignore */
            }
          }
          pausedPlay = null;
          return true;
        }

        if (play.kind === 'yt') {
          if (ytPlayer?.playVideo && play.videoId) {
            try {
              activePlay = {
                kind: 'yt',
                title: play.title,
                videoId: play.videoId,
              };
              ytPlayer.playVideo();
              setMediaSession(activePlay);
              startKeepAlive();
              loadLyricsForPlay(activePlay);
              pausedPlay = null;
              return true;
            } catch {
              /* recreate */
            }
          }
          await playYt(play);
          pausedPlay = null;
          return true;
        }

        if (play.kind === 'spotify' && play.uri) {
          await playSpotify(play);
          pausedPlay = null;
          return true;
        }
        return false;
      }

      function loadYtApi() {
        if (window.YT?.Player) return Promise.resolve(window.YT);
        if (ytReady) return ytReady;
        ytApiLoading = true;
        ytReady = new Promise((resolve, reject) => {
          const prev = window.onYouTubeIframeAPIReady;
          window.onYouTubeIframeAPIReady = () => {
            try {
              prev?.();
            } catch {
              /* ignore */
            }
            resolve(window.YT);
          };
          if (![...document.scripts].some((s) => /youtube\.com\/iframe_api/.test(s.src))) {
            const s = document.createElement('script');
            s.src = 'https://www.youtube.com/iframe_api';
            s.onerror = () => reject(new Error('YouTube API falhou'));
            document.head.appendChild(s);
          }
          setTimeout(() => {
            if (window.YT?.Player) resolve(window.YT);
          }, 4000);
        }).finally(() => {
          ytApiLoading = false;
        });
        return ytReady;
      }

      function getPosition() {
        try {
          if (activePlay?.kind === 'album') {
            const a = audioEl();
            return a && !Number.isNaN(a.currentTime) ? a.currentTime : 0;
          }
          if (activePlay?.kind === 'yt' && ytPlayer?.getCurrentTime) {
            return Number(ytPlayer.getCurrentTime()) || 0;
          }
          if (activePlay?.kind === 'spotify') {
            return getSpotPosEst();
          }
        } catch {
          /* ignore */
        }
        return 0;
      }

      function seekTo(sec) {
        if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 0) return;
        try {
          if (activePlay?.kind === 'album') {
            const a = audioEl();
            if (a && a.src) a.currentTime = sec;
          } else if (activePlay?.kind === 'yt' && ytPlayer?.seekTo) {
            ytPlayer.seekTo(sec, true);
            ytPlayer.playVideo?.();
          } else if (activePlay?.kind === 'spotify' && spotDeviceId) {
            setSpotPos(sec, spotPaused);
            spotApi(`/me/player/seek?position_ms=${Math.floor(sec * 1000)}&device_id=${encodeURIComponent(spotDeviceId)}`, {
              method: 'PUT',
            }).catch(() => {});
          }
        } catch {
          /* ignore */
        }
      }

      function listeningSnapshot() {
        if (!activePlay || playbackDone) return null;
        return {
          title: activePlay.title,
          kind: activePlay.kind,
          id: activePlay.id,
          videoId: activePlay.videoId,
          uri: activePlay.uri,
          pos: getPosition(),
          posAt: Date.now(),
        };
      }

      async function playAlbum(play) {
        stopYt();
        await stopSpotify();
        const a = audioEl();
        if (!a || !play?.stream) return;
        playbackDone = false;
        activePlay = {
          kind: 'album',
          title: play.title || 'faixa',
          stream: play.stream,
          id: play.id,
          artist: play.artist,
          album: play.album,
          duration: play.duration,
        };
        a.onended = () => {
          playbackDone = true;
          activePlay = null;
          lyrics.clear();
          stopKeepAlive();
          setMediaSession(null);
          requestRadioAdvance();
        };
        a.src = play.stream;
        try {
          ensureAlbumVizGraph();
          await resumeVizCtx();
          await a.play();
          if (typeof play.seek === 'number' && play.seek > 0.4) {
            try {
              a.currentTime = play.seek;
            } catch {
              /* ignore */
            }
          }
          setMediaSession(activePlay);
          startKeepAlive();
          loadLyricsForPlay(activePlay);
          notify(
            play.seek > 0.4
              ? `♪ sync · ${play.title || 'faixa'}`
              : `♪ ${play.title || 'faixa'}`
          );
        } catch (err) {
          activePlay = null;
          lyrics.clear();
          notify(err?.message || 'não rolou o play — toca de novo');
        }
      }

      async function playYt(play) {
        stopAlbum();
        await stopSpotify();
        if (!play?.videoId) return;
        playbackDone = false;
        const host = $('commsYtHost');
        if (!host) return;
        host.innerHTML = '';
        const box = document.createElement('div');
        box.id = 'commsYtPlayer';
        host.appendChild(box);
        const seekToSec = typeof play.seek === 'number' && play.seek > 0.4 ? play.seek : 0;
        activePlay = {
          kind: 'yt',
          title: play.title || 'YouTube',
          videoId: play.videoId,
        };
        try {
          const YT = await loadYtApi();
          await new Promise((resolve, reject) => {
            ytPlayer = new YT.Player('commsYtPlayer', {
              width: 2,
              height: 2,
              videoId: play.videoId,
              playerVars: {
                autoplay: 1,
                controls: 0,
                disablekb: 1,
                fs: 0,
                modestbranding: 1,
                playsinline: 1,
                rel: 0,
                start: seekToSec > 0 ? Math.floor(seekToSec) : undefined,
                origin: location.origin,
              },
              events: {
                onReady: (e) => {
                  try {
                    /* Chrome autoplay sem gesto inicia MUDO — desmuta na hora */
                    e.target.unMute?.();
                    e.target.setVolume(80);
                    if (seekToSec > 0) e.target.seekTo(seekToSec, true);
                    e.target.playVideo();
                    const dur = Number(e.target.getDuration?.()) || 0;
                    if (activePlay?.kind === 'yt' && dur >= 20) {
                      activePlay.duration = dur;
                    }
                  } catch {
                    /* ignore */
                  }
                  resolve();
                },
                onError: () => reject(new Error('YouTube não tocou')),
                onStateChange: (e) => {
                  if (e.data === YT.PlayerState.PLAYING) {
                    try {
                      e.target.unMute?.();
                      if (Number(e.target.isMuted?.()) === 1 || e.target.isMuted?.() === true) {
                        e.target.unMute?.();
                      }
                      e.target.setVolume?.(80);
                    } catch {
                      /* ignore */
                    }
                  }
                  if (e.data === YT.PlayerState.ENDED) {
                    playbackDone = true;
                    activePlay = null;
                    lyrics.clear();
                    stopKeepAlive();
                    setMediaSession(null);
                    requestRadioAdvance();
                    return;
                  }
                  if (
                    e.data === YT.PlayerState.PAUSED &&
                    activePlay?.kind === 'yt'
                  ) {
                    /* fim da faixa: não reinicia (antes caía no keep-alive e tocava de novo) */
                    try {
                      const dur = Number(ytPlayer?.getDuration?.()) || 0;
                      const t = Number(ytPlayer?.getCurrentTime?.()) || 0;
                      if (dur >= 5 && t >= dur - 1.5) {
                        playbackDone = true;
                        activePlay = null;
                        lyrics.clear();
                        stopKeepAlive();
                        setMediaSession(null);
                        requestRadioAdvance();
                        return;
                      }
                    } catch {
                      /* ignore */
                    }
                    const delay = document.visibilityState === 'hidden' ? 120 : 280;
                    setTimeout(() => {
                      if (playbackDone || !activePlay || activePlay.kind !== 'yt') return;
                      if (isNearTrackEnd()) return;
                      if (!ytIsPlaying()) resumePlayback();
                    }, delay);
                  }
                },
              },
            });
          });
          ensurePlaybackAudible();
          setMediaSession(activePlay);
          startKeepAlive();
          loadLyricsForPlay(activePlay);
          notify(
            seekToSec > 0
              ? `♪ sync · ${play.title || 'YouTube'}`
              : `♪ ${play.title || 'YouTube'}`
          );
        } catch (err) {
          activePlay = null;
          lyrics.clear();
          notify(err?.message || 'YouTube falhou');
          stopYt();
        }
      }

      async function apply(play) {
        if (!play?.kind) return;
        if (play.kind === 'stop') {
          /* sync do host: mantém alongWith pra /resume pegar os dois */
          if (!play.keepAlong) {
            state.alongWith = null;
            state.alongTrackKey = '';
          }
          stopAll(true);
          notify(play.keepAlong ? 'host pausou · /resume no host' : 'pausou · /resume pra voltar');
          return;
        }
        if (play.resume) {
          const same =
            (pausedPlay?.kind === 'album' &&
              play.kind === 'album' &&
              (pausedPlay.id === play.id || pausedPlay.stream === play.stream)) ||
            (pausedPlay?.kind === 'yt' &&
              play.kind === 'yt' &&
              pausedPlay.videoId === play.videoId) ||
            (pausedPlay?.kind === 'spotify' &&
              play.kind === 'spotify' &&
              (pausedPlay.uri === play.uri || pausedPlay.id === play.id));
          if (same && (await resumeLast())) {
            notify(`♪ retomou · ${play.title || ''}`);
            return;
          }
        }
        pausedPlay = null;
        if (play.kind === 'album') {
          await playAlbum(play);
          return;
        }
        if (play.kind === 'yt') {
          await playYt(play);
          return;
        }
        if (play.kind === 'spotify') {
          await playSpotify(play);
        }
        ensurePlaybackAudible();
      }

      function trackKeyOf(play) {
        if (!play) return '';
        if (play.kind === 'yt') return `yt:${play.videoId || ''}`;
        if (play.kind === 'album') return `album:${play.id || play.title || ''}`;
        if (play.kind === 'spotify') return `sp:${play.uri || play.id || ''}`;
        return '';
      }

      function onVisibility() {
        if (!activePlay) return;
        if (document.visibilityState === 'visible') {
          hardResumeForeground();
          return;
        }
        /* minimizou: tenta manter o YT vivo */
        resumePlayback();
        startKeepAlive();
      }

      document.addEventListener('visibilitychange', onVisibility);
      window.addEventListener('pageshow', () => {
        if (activePlay) hardResumeForeground();
      });
      window.addEventListener('focus', () => {
        if (activePlay && document.visibilityState === 'visible') {
          resumePlayback();
        }
      });
      window.addEventListener('pagehide', () => {
        if (activePlay) resumePlayback();
      });

      $('commsLyricsEnableBtn')?.addEventListener('click', () => {
        if (!activePlay) return;
        showLyricsTip();
      });
      $('commsLyricsTipOk')?.addEventListener('click', () => {
        setLyricsEnabled(true);
        hideLyricsTip();
        updateLyricsGate();
        if (activePlay) loadLyricsForPlay(activePlay);
      });
      $('commsLyricsTip')?.addEventListener('click', (e) => {
        if (e.target === $('commsLyricsTip')) hideLyricsTip();
      });

      $('commsSpotifyBtn')?.addEventListener('click', async () => {
        const ok = await ensureSpotifyConfigured();
        if (!ok) {
          showSpotifySetupTip();
          return;
        }
        if (spotConnected()) {
          if (!showSpotifyDisconnectTip()) disconnectSpotifyLocal();
          return;
        }
        if (!showSpotifyConnectTip()) {
          location.href = '/api/deck/spotify/login';
        }
      });
      /* qualquer interação desbloqueia autoplay (CD-R play chega no poll, fora do clique) */
      document.addEventListener(
        'pointerdown',
        () => {
          unlockAudioGesture();
          ensurePlaybackAudible();
        },
        { capture: true, passive: true }
      );
      $('commsSpotifyTipOk')?.addEventListener('click', hideSpotifySetupTip);
      $('commsSpotifyTip')?.addEventListener('click', (e) => {
        if (e.target === $('commsSpotifyTip')) hideSpotifySetupTip();
      });
      $('commsSpotifyConnectOk')?.addEventListener('click', () => {
        hideSpotifyConnectTip();
        location.href = '/api/deck/spotify/login';
      });
      $('commsSpotifyConnectCancel')?.addEventListener('click', hideSpotifyConnectTip);
      $('commsSpotifyConnectTip')?.addEventListener('click', (e) => {
        if (e.target === $('commsSpotifyConnectTip')) hideSpotifyConnectTip();
      });
      $('commsSpotifyDisconnectOk')?.addEventListener('click', () => {
        hideSpotifyDisconnectTip();
        disconnectSpotifyLocal();
      });
      $('commsSpotifyDisconnectCancel')?.addEventListener('click', hideSpotifyDisconnectTip);
      $('commsSpotifyDisconnectTip')?.addEventListener('click', (e) => {
        if (e.target === $('commsSpotifyDisconnectTip')) hideSpotifyDisconnectTip();
      });

      ensureSpotifyConfigured()
        .then(async () => {
          syncSpotifyBtn();
          if (spotConnected()) {
            try {
              await refreshSpotProduct();
              await ensureSpotPlayer();
              syncSpotifyBtn();
            } catch (e) {
              syncSpotifyBtn();
            }
          }
        })
        .catch(() => {});
      if (/[?&]spotify=1(?:&|$)/.test(location.search)) {
        notify('Spotify conectado');
        try {
          history.replaceState({}, '', location.pathname + location.hash);
        } catch {
          /* ignore */
        }
        refreshSpotProduct()
          .then((product) => {
            if (product && product !== 'premium') {
              notify(`Spotify diz que a conta é "${product}" (precisa premium)`);
            } else if (product === 'premium') {
              notify('Spotify Premium ok · player pronto');
            }
            return ensureSpotPlayer();
          })
          .then(() => syncSpotifyBtn())
          .catch((e) => notify(e?.message || 'player Spotify'));
      }
      syncSpotifyBtn();

      return {
        apply,
        stopAll,
        resumePlayback,
        resumeLast,
        trackKeyOf,
        getActive: () => activePlay,
        getPosition,
        seekTo,
        listeningSnapshot,
        unlockAudioGesture,
        ensurePlaybackAudible,
      };
    })();

    function loadSaved() {
      try {
        return JSON.parse(localStorage.getItem(storeKey) || '{}');
      } catch {
        return {};
      }
    }

    function loadLocalAvatar() {
      try {
        const raw = localStorage.getItem(avatarKey) || '';
        if (
          raw &&
          /^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/i.test(raw) &&
          raw.length <= 120000
        ) {
          return raw;
        }
      } catch {
        /* ignore */
      }
      return '';
    }

    function persistLocalAvatar(data) {
      localAvatar = data || '';
      avatarDirty = true;
      try {
        if (localAvatar) localStorage.setItem(avatarKey, localAvatar);
        else localStorage.removeItem(avatarKey);
      } catch {
        /* quota / private mode */
      }
      if (state.peerId && localAvatar) {
        avatarCache.set(state.peerId, { at: Date.now(), url: '', data: localAvatar });
      } else if (state.peerId) {
        avatarCache.delete(state.peerId);
      }
      refreshAvatarUi();
      refreshFeedFaces();
      if (typeof VoiceCall !== 'undefined' && VoiceCall?.refreshPeople) {
        VoiceCall.refreshPeople();
      }
    }

    function refreshAvatarUi() {
      const name = ($('commsName')?.value || state.name || '').trim();
      const initial = (name.charAt(0) || '?').toUpperCase();
      [
        ['commsAvatarPreview', 'commsAvatarFallback', 'commsAvatarBtn', 'commsAvatarClear'],
        ['commsRoomAvatarPreview', 'commsRoomAvatarFallback', 'commsRoomAvatarBtn', 'commsRoomAvatarClear'],
      ].forEach(([previewId, fallbackId, puckId, clearId]) => {
        const preview = $(previewId);
        const fallback = $(fallbackId);
        const puck = $(puckId);
        const clearBtn = $(clearId);
        if (fallback) fallback.textContent = initial;
        if (preview) {
          if (localAvatar) {
            preview.src = localAvatar;
            preview.hidden = false;
          } else {
            preview.removeAttribute('src');
            preview.hidden = true;
          }
        }
        if (puck) puck.classList.toggle('has-photo', !!localAvatar);
        if (clearBtn) clearBtn.hidden = !localAvatar;
      });
    }

    function syncRoomProfileUi() {
      const roomName = $('commsRoomName');
      if (roomName && state.name) roomName.value = state.name;
      if ($('commsName') && state.name) $('commsName').value = state.name;
      refreshAvatarUi();
    }

    async function applyRoomNick(force = false) {
      if (!state.code || !state.peerId) return;
      const input = $('commsRoomName');
      if (!input) return;
      const n = input.value.trim().slice(0, 24);
      if (!n) {
        input.value = state.name || '';
        notify('nick nao pode ficar vazio');
        return;
      }
      if (n === state.name && !force) return;
      state.name = n;
      if ($('commsName')) $('commsName').value = n;
      save();
      const r = await postPresence({ name: n });
      if (r?.ok) {
        notify('nick atualizado');
        if (r.peers) renderPeers(r.peers, r.slots);
        refreshAvatarUi();
        refreshFeedFaces();
        if (typeof VoiceCall !== 'undefined' && VoiceCall?.refreshPeople) VoiceCall.refreshPeople();
      } else {
        notify(r?.error || 'falha ao salvar nick');
      }
    }

    const AVATAR_FILTERS = {
      none: { css: 'none', canvas: 'none' },
      mono: { css: 'grayscale(1) contrast(1.05)', canvas: 'grayscale(1) contrast(1.05)' },
      warm: {
        css: 'sepia(0.35) saturate(1.15) brightness(1.03)',
        canvas: 'sepia(0.35) saturate(1.15) brightness(1.03)',
      },
      cool: {
        css: 'hue-rotate(195deg) saturate(0.85) brightness(1.02)',
        canvas: 'hue-rotate(195deg) saturate(0.85) brightness(1.02)',
      },
      punch: {
        css: 'contrast(1.28) saturate(1.35) brightness(1.02)',
        canvas: 'contrast(1.28) saturate(1.35) brightness(1.02)',
      },
      fade: {
        css: 'contrast(0.88) brightness(1.08) saturate(0.75)',
        canvas: 'contrast(0.88) brightness(1.08) saturate(0.75)',
      },
      noir: {
        css: 'grayscale(1) contrast(1.45) brightness(0.95)',
        canvas: 'grayscale(1) contrast(1.45) brightness(0.95)',
      },
      vhs: {
        css: 'hue-rotate(28deg) saturate(1.55) contrast(1.12) brightness(1.04)',
        canvas: 'hue-rotate(28deg) saturate(1.55) contrast(1.12) brightness(1.04)',
      },
    };

    let avatarEditor = {
      img: null,
      objectUrl: '',
      filter: 'none',
      zoom: 1,
      x: 0,
      y: 0,
      baseW: 0,
      baseH: 0,
      drag: null,
    };

    function avatarEditorEls() {
      return {
        tip: $('commsAvatarEditorTip'),
        stage: $('commsAvatarEditorStage'),
        viewport: $('commsAvatarEditorViewport'),
        img: $('commsAvatarEditorImg'),
        zoom: $('commsAvatarEditorZoom'),
        filters: $('commsAvatarEditorFilters'),
      };
    }

    function syncAvatarEditorTransform() {
      const { img, viewport } = avatarEditorEls();
      if (!img || !viewport || !avatarEditor.img) return;
      const vw = viewport.clientWidth || 1;
      const vh = viewport.clientHeight || 1;
      const cover = Math.max(vw / avatarEditor.baseW, vh / avatarEditor.baseH);
      const w = avatarEditor.baseW * cover * avatarEditor.zoom;
      const h = avatarEditor.baseH * cover * avatarEditor.zoom;
      const maxX = Math.max(0, (w - vw) / 2);
      const maxY = Math.max(0, (h - vh) / 2);
      avatarEditor.x = Math.min(maxX, Math.max(-maxX, avatarEditor.x));
      avatarEditor.y = Math.min(maxY, Math.max(-maxY, avatarEditor.y));
      img.style.width = `${w}px`;
      img.style.height = `${h}px`;
      img.style.transform = `translate(-50%, -50%) translate(${avatarEditor.x}px, ${avatarEditor.y}px)`;
      const f = AVATAR_FILTERS[avatarEditor.filter] || AVATAR_FILTERS.none;
      img.style.filter = f.css;
    }

    function syncAvatarEditorUi() {
      const { zoom, filters } = avatarEditorEls();
      if (zoom) zoom.value = String(Math.round(avatarEditor.zoom * 100));
      filters?.querySelectorAll('[data-avatar-filter]').forEach((btn) => {
        btn.classList.toggle('on', btn.dataset.avatarFilter === avatarEditor.filter);
      });
      syncAvatarEditorTransform();
    }

    function resetAvatarEditorPose() {
      avatarEditor.zoom = 1;
      avatarEditor.x = 0;
      avatarEditor.y = 0;
      avatarEditor.filter = 'none';
      syncAvatarEditorUi();
    }

    function hideAvatarEditor() {
      const { tip, img, viewport } = avatarEditorEls();
      if (tip) {
        tip.hidden = true;
        tip.classList.remove('on');
      }
      if (avatarEditor.objectUrl) {
        URL.revokeObjectURL(avatarEditor.objectUrl);
        avatarEditor.objectUrl = '';
      }
      avatarEditor.img = null;
      avatarEditor.drag = null;
      if (img) {
        img.removeAttribute('src');
        img.style.cssText = '';
      }
      viewport?.classList.remove('is-dragging');
    }

    function showAvatarEditor(file) {
      return new Promise((resolve, reject) => {
        if (!file || !/^image\//i.test(file.type || '')) {
          reject(new Error('escolhe uma imagem'));
          return;
        }
        const { tip, img } = avatarEditorEls();
        if (!tip || !img) {
          reject(new Error('editor offline'));
          return;
        }
        hideAvatarEditor();
        const objectUrl = URL.createObjectURL(file);
        const probe = new Image();
        probe.onload = () => {
          avatarEditor = {
            img: probe,
            objectUrl,
            filter: 'none',
            zoom: 1,
            x: 0,
            y: 0,
            baseW: Math.max(1, probe.naturalWidth || probe.width),
            baseH: Math.max(1, probe.naturalHeight || probe.height),
            drag: null,
            _resolve: resolve,
            _reject: reject,
          };
          img.src = objectUrl;
          tip.hidden = false;
          requestAnimationFrame(() => {
            tip.classList.add('on');
            resetAvatarEditorPose();
          });
        };
        probe.onerror = () => {
          URL.revokeObjectURL(objectUrl);
          reject(new Error('não abriu a imagem'));
        };
        probe.src = objectUrl;
      });
    }

    function exportAvatarEditor() {
      const { viewport } = avatarEditorEls();
      if (!avatarEditor.img || !viewport) throw new Error('sem foto');
      const vw = viewport.clientWidth || 1;
      const vh = viewport.clientHeight || 1;
      const cover = Math.max(vw / avatarEditor.baseW, vh / avatarEditor.baseH);
      const f = AVATAR_FILTERS[avatarEditor.filter] || AVATAR_FILTERS.none;
      const maxChars = 115000;

      const drawAt = (size) => {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('canvas');
        const scale = cover * avatarEditor.zoom * (size / vw);
        const drawnW = avatarEditor.baseW * scale;
        const drawnH = avatarEditor.baseH * scale;
        const dx = size / 2 + (avatarEditor.x * size) / vw - drawnW / 2;
        const dy = size / 2 + (avatarEditor.y * size) / vh - drawnH / 2;
        ctx.save();
        ctx.beginPath();
        ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        ctx.filter = f.canvas;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(avatarEditor.img, dx, dy, drawnW, drawnH);
        ctx.restore();
        return canvas;
      };

      const encode = (canvas) => {
        let useWebp = false;
        try {
          useWebp = canvas.toDataURL('image/webp', 0.8).startsWith('data:image/webp');
        } catch {
          useWebp = false;
        }
        const mime = useWebp ? 'image/webp' : 'image/jpeg';
        let quality = useWebp ? 0.86 : 0.9;
        const minQ = useWebp ? 0.72 : 0.74;
        let data = canvas.toDataURL(mime, quality);
        while (data.length > maxChars && quality > minQ) {
          quality -= 0.04;
          data = canvas.toDataURL(mime, quality);
        }
        return data;
      };

      /* 160px + JPEG agressivo deixava tudo borrado no popup/retina */
      for (const size of [512, 384, 256]) {
        const data = encode(drawAt(size));
        if (data.length <= maxChars) return data;
      }
      throw new Error('foto ainda grande · tenta outra');
    }

    function applyAvatarEditor() {
      try {
        const data = exportAvatarEditor();
        const done = avatarEditor._resolve;
        hideAvatarEditor();
        persistLocalAvatar(data);
        notify('foto de perfil ok');
        if (state.code && state.peerId) {
          postPresence({ avatar: localAvatar || null })
            .then((r) => {
              if (r?.ok && r.peers) renderPeers(r.peers, r.slots);
            })
            .catch(() => {});
        }
        done?.(data);
      } catch (err) {
        notify(err?.message || 'falha na foto');
      }
    }

    function cancelAvatarEditor() {
      const done = avatarEditor._resolve;
      hideAvatarEditor();
      done?.(null);
    }

    function wireAvatarEditor() {
      const { tip, viewport, zoom, filters } = avatarEditorEls();
      if (!tip || tip.dataset.wired) return;
      tip.dataset.wired = '1';

      $('commsAvatarEditorCancel')?.addEventListener('click', cancelAvatarEditor);
      $('commsAvatarEditorApply')?.addEventListener('click', applyAvatarEditor);
      $('commsAvatarEditorReset')?.addEventListener('click', resetAvatarEditorPose);
      tip.addEventListener('click', (e) => {
        if (e.target === tip) cancelAvatarEditor();
      });
      zoom?.addEventListener('input', () => {
        avatarEditor.zoom = Math.min(2.8, Math.max(1, Number(zoom.value) / 100 || 1));
        syncAvatarEditorTransform();
      });
      filters?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-avatar-filter]');
        if (!btn || !AVATAR_FILTERS[btn.dataset.avatarFilter]) return;
        avatarEditor.filter = btn.dataset.avatarFilter;
        syncAvatarEditorUi();
      });

      const pointerPos = (e) => ({ x: e.clientX, y: e.clientY });
      const onMove = (e) => {
        if (!avatarEditor.drag) return;
        const p = pointerPos(e);
        avatarEditor.x = avatarEditor.drag.startX + (p.x - avatarEditor.drag.x);
        avatarEditor.y = avatarEditor.drag.startY + (p.y - avatarEditor.drag.y);
        syncAvatarEditorTransform();
      };
      const onUp = () => {
        if (!avatarEditor.drag) return;
        avatarEditor.drag = null;
        viewport?.classList.remove('is-dragging');
      };
      viewport?.addEventListener('pointerdown', (e) => {
        if (!avatarEditor.img) return;
        if (e.button != null && e.button !== 0) return;
        e.preventDefault();
        const p = pointerPos(e);
        avatarEditor.drag = {
          x: p.x,
          y: p.y,
          startX: avatarEditor.x,
          startY: avatarEditor.y,
        };
        viewport.classList.add('is-dragging');
        viewport.setPointerCapture?.(e.pointerId);
      });
      viewport?.addEventListener('pointermove', onMove);
      viewport?.addEventListener('pointerup', onUp);
      viewport?.addEventListener('pointercancel', onUp);
      viewport?.addEventListener('lostpointercapture', onUp);
      window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && tip && !tip.hidden) cancelAvatarEditor();
      });
    }

    async function pickLocalAvatar(file) {
      try {
        wireAvatarEditor();
        await showAvatarEditor(file);
      } catch (err) {
        notify(err?.message || 'falha na foto');
      }
    }

    function clearLocalAvatar() {
      persistLocalAvatar('');
      if (state.code && state.peerId) {
        postPresence({ avatar: null })
          .then((r) => {
            if (r?.ok && r.peers) renderPeers(r.peers, r.slots);
          })
          .catch(() => {});
      }
    }

    function avatarPayload() {
      return localAvatar || null;
    }

    function seedOwnAvatarCache() {
      if (!state.peerId) return;
      if (localAvatar) avatarCache.set(state.peerId, { at: Date.now(), data: localAvatar });
      else avatarCache.delete(state.peerId);
    }

    async function fetchPeerAvatar(peerId, wantAt) {
      if (!state.code || !peerId) return;
      const key = String(peerId);
      const cur = avatarCache.get(key);
      if (cur && cur.at === wantAt && (cur.url || cur.data)) return;
      if (avatarFetching.has(key)) return avatarFetching.get(key);
      const job = (async () => {
        try {
          const r = await api(
            `/api/deck/comms/${encodeURIComponent(state.code)}/avatar/${encodeURIComponent(key)}`
          );
          if (!r?.ok) return;
          const at = Number(r.avatarAt) || 0;
          if (r.avatarUrl) avatarCache.set(key, { at, url: r.avatarUrl, data: '' });
          else if (r.avatar) avatarCache.set(key, { at, url: '', data: r.avatar });
          else avatarCache.delete(key);
        } catch {
          /* ignore */
        } finally {
          avatarFetching.delete(key);
        }
      })();
      avatarFetching.set(key, job);
      return job;
    }

    function rememberPeerFace(peerId, face = {}) {
      const key = String(peerId || '');
      if (!key) return false;
      const at = Number(face.avatarAt) || Date.now();
      const url = face.avatarUrl ? String(face.avatarUrl) : '';
      const data = face.avatar && /^data:image\//i.test(String(face.avatar)) ? face.avatar : '';
      if (!url && !data) return false;
      const cur = avatarCache.get(key);
      if (cur && cur.at === at && cur.url === url && cur.data === data) return false;
      avatarCache.set(key, { at, url, data });
      return true;
    }

    function syncPeerAvatars(list) {
      const peers = Array.isArray(list) ? list : [];
      let needRedraw = false;
      const jobs = [];
      for (const p of peers) {
        if (!p?.id) continue;
        const key = String(p.id);
        const at = Number(p.avatarAt) || 0;
        const mine = key === String(state.peerId || '');
        if (rememberPeerFace(key, p)) needRedraw = true;
        if (p.avatarUrl || p.avatar) continue;
        const cur = avatarCache.get(key);
        if (!at) {
          if (mine && localAvatar) {
            if (!cur?.data && !cur?.url) {
              avatarCache.set(key, { at: Date.now(), url: '', data: localAvatar });
              needRedraw = true;
            }
            avatarDirty = true;
            continue;
          }
          /* não apaga foto de outro só porque o poll veio sem at — espera URL nova */
          continue;
        }
        if (cur && cur.at === at && (cur.url || cur.data)) continue;
        jobs.push(
          fetchPeerAvatar(key, at).then(() => {
            needRedraw = true;
          })
        );
      }
      if (mineHasLocalFace()) needRedraw = true;
      const finish = () => {
        if (!needRedraw) return;
        refreshFeedFaces();
        if (typeof VoiceCall !== 'undefined' && VoiceCall?.refreshPeople) {
          VoiceCall.refreshPeople();
        }
      };
      if (!jobs.length) {
        finish();
        return;
      }
      Promise.all(jobs).then(finish);
    }

    function mineHasLocalFace() {
      if (!state.peerId || !localAvatar) return false;
      const cur = avatarCache.get(String(state.peerId));
      if (cur?.url || cur?.data === localAvatar) return false;
      avatarCache.set(String(state.peerId), { at: Date.now(), url: '', data: localAvatar });
      return true;
    }

    function peerFaceHtml(peerId, name, hue, face = {}) {
      const initial = (String(name || '?').trim().charAt(0) || '?').toUpperCase();
      const key = String(peerId || '');
      rememberPeerFace(key, face);
      let cached = avatarCache.get(key);
      if ((!cached?.url && !cached?.data) && key && key === String(state.peerId || '') && localAvatar) {
        cached = { at: Date.now(), url: '', data: localAvatar };
        avatarCache.set(key, cached);
      }
      const src = cached?.url || cached?.data || '';
      if (src) {
        const safe = String(src).replace(/"/g, '');
        return `<span class="comms-call-avatar has-photo" style="--chip-hue:${hue}"><img src="${safe}" alt="" draggable="false" /></span>`;
      }
      return `<span class="comms-call-avatar" style="--chip-hue:${hue}">${escapeHtml(initial)}</span>`;
    }

    function faceHue(name) {
      let h = 0;
      const s = String(name || '');
      for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
      return h % 360;
    }

    function msgFaceHtml(peerId, name) {
      const initial = (String(name || '?').trim().charAt(0) || '?').toUpperCase();
      const hue = faceHue(name);
      const key = String(peerId || '');
      let cached = avatarCache.get(key);
      if ((!cached?.url && !cached?.data) && key && key === String(state.peerId || '') && localAvatar) {
        cached = { at: Date.now(), url: '', data: localAvatar };
        avatarCache.set(key, cached);
      }
      const src = cached?.url || cached?.data || '';
      const attrs =
        ` class="comms-msg-face${src ? ' has-photo' : ''}"` +
        ` data-face-peer="${escapeHtml(key)}"` +
        ` data-face-name="${escapeHtml(name || '')}"` +
        ` role="button" tabindex="0" title="ver foto"` +
        ` aria-label="ver foto de ${escapeHtml(name || 'ghost')}"`;
      if (src) {
        const safe = String(src).replace(/"/g, '');
        return `<span${attrs} style="--face-hue:${hue}"><img src="${safe}" alt="" draggable="false" /></span>`;
      }
      return `<span${attrs} style="--face-hue:${hue}">${escapeHtml(initial)}</span>`;
    }

    let facePopTarget = null;
    let faceLikeBusy = false;
    let faceTapCount = 0;
    let faceTapTimer = null;
    let faceSuperDone = false;
    let faceNormalSent = false;
    const FACE_SUPER_TAPS = 8;

    function hideFacePop() {
      const pop = $('commsFacePop');
      if (!pop) return;
      pop.hidden = true;
      facePopTarget = null;
      faceTapCount = 0;
      faceSuperDone = false;
      faceNormalSent = false;
      clearTimeout(faceTapTimer);
      faceTapTimer = null;
      const fx = $('commsFacePopFx');
      if (fx) fx.innerHTML = '';
      const pic = $('commsFacePopPic');
      if (pic) {
        pic.classList.remove('is-liked', 'is-super', 'is-tap', 'has-photo');
        pic.innerHTML = '';
        pic.textContent = '';
      }
      const card = pop.querySelector('.comms-face-pop-card');
      card?.classList.remove('is-super');
      const banner = $('commsFacePopBanner');
      if (banner) {
        banner.hidden = true;
        banner.classList.remove('on');
      }
    }

    function burstFaceHearts(superMode = false) {
      const fx = $('commsFacePopFx');
      const pic = $('commsFacePopPic');
      const btn = $('commsFacePopLike');
      if (!fx) return;
      fx.innerHTML = '';
      const glyphs = superMode
        ? ['♥', '★', '✦', ':P', '♪', '✧', '✧', '⚡', '✦', '★']
        : ['♥', '★', '✦', ':P', '♪', '✧'];
      const n = superMode ? 28 : 12;
      for (let i = 0; i < n; i += 1) {
        const bit = document.createElement('i');
        const ang = (Math.PI * 2 * i) / n + (Math.random() * 0.35 - 0.17);
        const dist = (superMode ? 70 : 54) + Math.random() * (superMode ? 110 : 70);
        bit.textContent = glyphs[i % glyphs.length];
        bit.className = superMode ? 'is-super' : '';
        bit.style.setProperty('--dx', `${Math.cos(ang) * dist}px`);
        bit.style.setProperty('--dy', `${Math.sin(ang) * dist - 18}px`);
        bit.style.setProperty('--rot', `${(Math.random() * 50 - 25).toFixed(1)}deg`);
        bit.style.animationDelay = `${(i * (superMode ? 0.018 : 0.03)).toFixed(2)}s`;
        fx.appendChild(bit);
      }
      pic?.classList.remove('is-liked', 'is-super');
      void pic?.offsetWidth;
      pic?.classList.add(superMode ? 'is-super' : 'is-liked');
      btn?.classList.remove('is-boom');
      void btn?.offsetWidth;
      btn?.classList.add('is-boom');
      if (navigator.vibrate) {
        navigator.vibrate(superMode ? [18, 40, 18, 40, 30] : [12, 30, 18]);
      }
    }

    function showSuperBanner() {
      const banner = $('commsFacePopBanner');
      const card = $('commsFacePop')?.querySelector?.('.comms-face-pop-card');
      if (!banner) return;
      banner.hidden = false;
      banner.classList.remove('on');
      void banner.offsetWidth;
      banner.classList.add('on');
      card?.classList.add('is-super');
    }

    function syncFaceLikeUi() {
      const likeBtn = $('commsFacePopLike');
      const hint = $('commsFacePopHint');
      if (!facePopTarget || facePopTarget.mine || facePopTarget.bot) return;
      if (faceSuperDone) {
        if (likeBtn) {
          likeBtn.disabled = false;
          likeBtn.textContent = 'SUPER MANEIRA :P';
        }
        if (hint) hint.textContent = 'já foi SUPER · manda de novo depois';
        return;
      }
      if (likeBtn) {
        likeBtn.disabled = false;
        likeBtn.textContent =
          faceTapCount <= 0
            ? 'Curte se achar maneira'
            : faceTapCount >= FACE_SUPER_TAPS - 1
              ? 'mais 1 · SUPER :P'
              : `maneira · ${faceTapCount}/${FACE_SUPER_TAPS}`;
      }
      if (hint) {
        hint.textContent =
          faceTapCount <= 0
            ? 'Curte se achar maneira'
            : `continua clicando · ${faceTapCount}/${FACE_SUPER_TAPS}`;
      }
    }

    function openFacePop(peerId, name) {
      const pop = $('commsFacePop');
      const pic = $('commsFacePopPic');
      const nameEl = $('commsFacePopName');
      const likeBtn = $('commsFacePopLike');
      if (!pop || !pic || !nameEl) return;
      const key = String(peerId || '');
      const label = String(name || 'ghost').trim() || 'ghost';
      const mine = key && key === String(state.peerId || '');
      const bot = key === 'cdr' || key === 'deck';
      let cached = avatarCache.get(key);
      if ((!cached?.url && !cached?.data) && mine && localAvatar) {
        cached = { at: Date.now(), url: '', data: localAvatar };
      }
      const src = cached?.url || cached?.data || '';
      facePopTarget = { peerId: key, name: label, mine, bot };
      faceTapCount = 0;
      faceSuperDone = false;
      faceNormalSent = false;
      clearTimeout(faceTapTimer);
      nameEl.textContent = label;
      pic.style.setProperty('--face-hue', String(faceHue(label)));
      pic.classList.remove('is-liked', 'is-super', 'is-tap', 'has-photo');
      pic.innerHTML = '';
      pop.querySelector('.comms-face-pop-card')?.classList.remove('is-super');
      const banner = $('commsFacePopBanner');
      if (banner) {
        banner.hidden = true;
        banner.classList.remove('on');
      }
      if (src) {
        pic.classList.add('has-photo');
        const img = document.createElement('img');
        img.src = src;
        img.alt = '';
        img.draggable = false;
        pic.appendChild(img);
      } else {
        pic.textContent = (label.charAt(0) || '?').toUpperCase();
      }
      if (likeBtn) {
        likeBtn.hidden = !!(mine || bot);
        likeBtn.disabled = false;
        likeBtn.classList.remove('is-boom');
      }
      const hint = $('commsFacePopHint');
      if (hint) {
        hint.textContent = mine
          ? 'essa é a sua foto'
          : bot
            ? 'CD-R · sem curtida'
            : 'Curte se achar maneira';
      }
      if (!mine && !bot) syncFaceLikeUi();
      $('commsFacePopFx') && ($('commsFacePopFx').innerHTML = '');
      pop.hidden = false;
    }

    async function sendFaceLike(superMode) {
      if (!facePopTarget || facePopTarget.mine || facePopTarget.bot) return null;
      if (!state.code || !state.peerId) return null;
      const r = await api(`/api/deck/comms/${state.code}/face-like`, {
        method: 'POST',
        body: JSON.stringify({
          peerId: state.peerId,
          targetPeerId: facePopTarget.peerId,
          super: !!superMode,
        }),
      });
      if (r?.ok) (r.messages || []).forEach(pushMsg);
      return r;
    }

    async function onFaceEngage() {
      if (!facePopTarget || facePopTarget.mine || facePopTarget.bot) return;
      if (faceSuperDone) {
        burstFaceHearts(true);
        return;
      }

      faceTapCount += 1;
      clearTimeout(faceTapTimer);
      faceTapTimer = setTimeout(() => {
        /* não zera o progresso se a pessoa só pausar um pouco */
      }, 8000);

      const pic = $('commsFacePopPic');
      pic?.classList.remove('is-tap');
      void pic?.offsetWidth;
      pic?.classList.add('is-tap');

      /* 1º clique: elogio normal (sem travar o botão) */
      if (faceTapCount === 1 && !faceNormalSent && !faceLikeBusy) {
        faceLikeBusy = true;
        faceNormalSent = true;
        burstFaceHearts(false);
        try {
          const r = await sendFaceLike(false);
          if (r?.ok) notify('mandou o elogio no canal');
          else if (r && !r.ok) {
            /* se já tinha elogiado, segue o spam pra SUPER */
            faceNormalSent = true;
          }
        } catch {
          /* ignora — spam pra SUPER ainda vale */
        } finally {
          faceLikeBusy = false;
          syncFaceLikeUi();
        }
      } else if (faceTapCount === 3 || faceTapCount === 5 || faceTapCount === 7) {
        burstFaceHearts(false);
      }

      syncFaceLikeUi();

      if (faceTapCount >= FACE_SUPER_TAPS && !faceSuperDone) {
        if (faceLikeBusy) {
          /* espera o like normal terminar e tenta SUPER */
          const wait = setInterval(async () => {
            if (faceLikeBusy) return;
            clearInterval(wait);
            if (faceSuperDone) return;
            faceLikeBusy = true;
            faceSuperDone = true;
            burstFaceHearts(true);
            showSuperBanner();
            try {
              const r = await sendFaceLike(true);
              if (r?.ok) notify('SUPER MANEIRA no canal :P');
              else {
                faceSuperDone = false;
                notify(r?.error || 'não deu o SUPER');
              }
            } catch {
              faceSuperDone = false;
              notify('não deu o SUPER');
            } finally {
              faceLikeBusy = false;
              syncFaceLikeUi();
            }
          }, 80);
          return;
        }
        faceLikeBusy = true;
        faceSuperDone = true;
        burstFaceHearts(true);
        showSuperBanner();
        try {
          const r = await sendFaceLike(true);
          if (r?.ok) notify('SUPER MANEIRA no canal :P');
          else {
            faceSuperDone = false;
            notify(r?.error || 'não deu o SUPER');
          }
        } catch {
          faceSuperDone = false;
          notify('não deu o SUPER');
        } finally {
          faceLikeBusy = false;
          syncFaceLikeUi();
        }
      }
    }

    function wireFacePop() {
      const pop = $('commsFacePop');
      if (!pop || pop.dataset.wired === '1') return;
      pop.dataset.wired = '1';
      $('commsFacePopClose')?.addEventListener('click', hideFacePop);
      $('commsFacePopDismiss')?.addEventListener('click', hideFacePop);
      /* botão e foto contam pro mesmo spam → SUPER */
      $('commsFacePopLike')?.addEventListener('click', (e) => {
        e.preventDefault();
        onFaceEngage();
      });
      $('commsFacePopPic')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        onFaceEngage();
      });
      pop.addEventListener('click', (e) => {
        if (e.target === pop) hideFacePop();
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && pop && !pop.hidden) hideFacePop();
      });
      $('commsFeed')?.addEventListener('click', (e) => {
        const face = e.target.closest('.comms-msg-face[data-face-peer]');
        if (!face) return;
        e.preventDefault();
        e.stopPropagation();
        openFacePop(face.dataset.facePeer || '', face.dataset.faceName || '');
      });
    }

    function refreshFeedFaces() {
      const feed = $('commsFeed');
      if (feed) {
        feed.querySelectorAll('.comms-msg[data-peer] .comms-msg-face').forEach((face) => {
          const msg = face.closest('.comms-msg');
          if (!msg) return;
          const peerId = msg.dataset.peer || '';
          const name = msg.querySelector('.who-name')?.textContent || '';
          const next = msgFaceHtml(peerId, name);
          if (face.outerHTML !== next) face.outerHTML = next;
        });
      }
      const typing = $('commsTyping');
      if (typing && !typing.hidden) {
        typing.querySelectorAll('.comms-typing-row[data-peer] .comms-msg-face').forEach((face) => {
          const row = face.closest('.comms-typing-row');
          if (!row) return;
          const peerId = row.dataset.peer || '';
          const name = row.querySelector('.who-name')?.textContent || '';
          const next = msgFaceHtml(peerId, name);
          if (face.outerHTML !== next) face.outerHTML = next;
        });
      }
    }

    function save() {
      const prev = loadSaved();
      localStorage.setItem(
        storeKey,
        JSON.stringify({
          peerId: state.peerId,
          name: state.name,
          code: state.code,
          seat: state.seat,
          lastCode: state.code || prev.lastCode || null,
        })
      );
    }

    let pendingInvite = null;

    function setInviteAvatar(name, src) {
      const wrap = $('commsInviteAvatar');
      const img = $('commsInviteAvatarImg');
      const fallback = $('commsInviteAvatarFallback');
      const initial = (String(name || '?').trim().charAt(0) || '?').toUpperCase();
      if (wrap) wrap.style.setProperty('--face-hue', faceHue(name));
      if (fallback) fallback.textContent = initial;
      if (!wrap || !img) return;
      if (src) {
        img.src = src;
        img.hidden = false;
        wrap.classList.add('has-photo');
      } else {
        img.removeAttribute('src');
        img.hidden = true;
        wrap.classList.remove('has-photo');
      }
    }

    async function loadInviteAvatar(invite) {
      if (!invite) return;
      setInviteAvatar(invite.from, '');
      let peerId = String(invite.fromId || '').trim();
      if (invite.code) {
        try {
          const room = await api(`/api/deck/comms/${encodeURIComponent(invite.code)}`);
          if (pendingInvite !== invite) return;
          if (room.ok && room.peers) {
            const match =
              room.peers.find((p) => p.id && peerId && p.id === peerId) ||
              room.peers.find(
                (p) =>
                  String(p.name || '')
                    .trim()
                    .toLowerCase() === String(invite.from || '').trim().toLowerCase()
              );
            if (match) {
              peerId = match.id || peerId;
              if (match.avatarUrl) {
                setInviteAvatar(invite.from, match.avatarUrl);
                return;
              }
            }
          }
        } catch {
          /* ignore */
        }
      }
      if (!peerId || !invite.code) return;
      try {
        const r = await api(
          `/api/deck/comms/${encodeURIComponent(invite.code)}/avatar/${encodeURIComponent(peerId)}`
        );
        if (pendingInvite !== invite) return;
        if (r.ok) {
          const src = r.avatarUrl || r.avatar || '';
          if (src) setInviteAvatar(invite.from, src);
        }
      } catch {
        /* ignore */
      }
    }

    function refreshInviteUi() {
      const banner = $('commsInviteBanner');
      if (!banner) return;
      if (!pendingInvite || state.code) {
        banner.hidden = true;
        return;
      }
      banner.hidden = false;
      const text = $('commsInviteText');
      if (text) {
        text.innerHTML = `<strong>${escapeHtml(pendingInvite.from)}</strong> te mandou um link de um canal — entrar?`;
      }
      if ($('commsJoinCode') && pendingInvite.code) {
        $('commsJoinCode').value = pendingInvite.code;
      }
      loadInviteAvatar(pendingInvite);
    }

    function showInviteFromLink(from, code, fromId) {
      pendingInvite = {
        from: String(from || '').trim().slice(0, 24),
        code,
        fromId: String(fromId || '').trim().slice(0, 32),
      };
      refreshInviteUi();
    }

    function dismissInvite() {
      pendingInvite = null;
      refreshInviteUi();
    }

    function refreshResumeUi() {
      const row = $('commsResumeRow');
      const btn = $('commsResume');
      if (!row || !btn) return;
      const last = loadSaved().lastCode;
      if (last && !state.code) {
        row.hidden = false;
        btn.textContent = `voltar ao canal ${last}`;
        if ($('commsJoinCode') && !$('commsJoinCode').value) {
          $('commsJoinCode').value = last;
        }
      } else {
        row.hidden = true;
      }
    }

    function showLobby() {
      peersRenderKey = '';
      $('commsLobby').hidden = false;
      $('commsRoom').hidden = true;
      const feed = $('commsFeed');
      if (feed) feed.innerHTML = '';
      hideNewMsgHint();
      ensureTypingEl();
      setTypingUi([]);
      const nowEl = $('commsNowPlaying');
      if (nowEl) {
        nowEl.hidden = true;
        nowEl.innerHTML = '';
      }
      const lyrics = $('commsLyrics');
      if (lyrics) lyrics.hidden = true;
      setLocked(false);
      refreshResumeUi();
      refreshInviteUi();
    }

    function showRoom() {
      $('commsLobby').hidden = true;
      $('commsRoom').hidden = false;
      $('commsCodeLabel').textContent = state.code;
      setLocked(true);
      setTab('comms');
      activeTab = true;
      // no mobile, não abre o teclado sozinho (quebra o layout)
      if (!window.matchMedia('(max-width: 720px)').matches) {
        setTimeout(() => $('commsInput')?.focus(), 80);
      }
    }

    function setLocked(on) {
      document.body.classList.toggle('comms-locked', !!on);
      const brand = document.querySelector('.model');
      if (brand) brand.textContent = on ? 'L>I>V>E>L>I>N>K' : 'D>E>A>T>H>D>E>C>K';
      if (on) {
        applyVisualToRoom(visualApplied);
        syncVisualViewport();
        bindVisualViewport(true);
      } else {
        delete document.body.dataset.commsBubbleMe;
        delete document.body.dataset.commsBubbleThem;
        delete document.body.dataset.commsTheme;
        delete document.body.dataset.commsBubble;
        syncBodyThemeClass(null);
        bindVisualViewport(false);
        document.body.classList.remove('comms-kb');
        document.documentElement.style.removeProperty('--vvh');
        document.documentElement.style.removeProperty('--vv-top');
        document.documentElement.style.removeProperty('--kb-inset');
      }
    }

    function isFeedNearBottom(px = 100) {
      const feed = $('commsFeed');
      if (!feed) return true;
      return feed.scrollHeight - feed.scrollTop - feed.clientHeight < px;
    }

    let newMsgCount = 0;

    function hideNewMsgHint() {
      newMsgCount = 0;
      const btn = $('commsNewMsg');
      if (btn) btn.hidden = true;
    }

    function showNewMsgHint() {
      newMsgCount += 1;
      const btn = $('commsNewMsg');
      const label = $('commsNewMsgLabel');
      if (!btn) return;
      btn.hidden = false;
      if (label) label.textContent = newMsgCount <= 1 ? 'nova' : `${newMsgCount} novas`;
    }

    function scrollFeedToEnd(force = false) {
      const feed = $('commsFeed');
      if (!feed) return;
      if (!force && !isFeedNearBottom(80)) return;
      const go = () => {
        feed.scrollTop = feed.scrollHeight;
      };
      go();
      requestAnimationFrame(go);
      hideNewMsgHint();
    }

    function scrollFeedForMedia(el) {
      scrollFeedToEnd(true);
      if (!el) return;
      el.querySelectorAll('img, video').forEach((media) => {
        const bump = () => scrollFeedToEnd(true);
        media.addEventListener('load', bump, { once: true });
        media.addEventListener('loadeddata', bump, { once: true });
        media.addEventListener('error', bump, { once: true });
      });
      setTimeout(() => scrollFeedToEnd(true), 80);
      setTimeout(() => scrollFeedToEnd(true), 280);
    }

    function syncVisualViewport() {
      if (!document.body.classList.contains('comms-locked')) return;
      const vv = window.visualViewport;
      const layoutH = window.innerHeight || document.documentElement.clientHeight || 0;
      let usable = layoutH;
      let kb = 0;
      if (vv) {
        usable = Math.round(vv.height);
        kb = Math.max(0, Math.round(layoutH - vv.height - (vv.offsetTop || 0)));
      }
      try {
        const vk = navigator.virtualKeyboard?.boundingRect;
        if (vk && vk.height > kb) {
          kb = Math.round(vk.height);
          usable = Math.max(180, layoutH - kb);
        }
      } catch {
        /* ignore */
      }
      /* se o input tá focado e ainda não detectou teclado, usa fallback */
      const inputFocused = document.activeElement === $('commsInput');
      const mobile = window.matchMedia('(max-width: 820px)').matches;
      if (mobile && inputFocused && kb < 80 && vv) {
        /* alguns Chrome atrasam o resize — ainda assim encolhe pelo vv */
        usable = Math.round(vv.height);
        kb = Math.max(kb, Math.round(layoutH - vv.height));
      }
      const h = Math.max(Math.round(usable), 180);
      document.documentElement.style.setProperty('--vvh', `${h}px`);
      document.documentElement.style.setProperty('--vv-top', '0px');
      document.documentElement.style.setProperty('--kb-inset', `${kb}px`);
      /* força no elemento — CSS var às vezes não reaplica a tempo */
      const rig = document.getElementById('rig');
      if (rig) {
        rig.style.height = `${h}px`;
        rig.style.maxHeight = `${h}px`;
        rig.style.top = '0px';
      }
      const wasKb = document.body.classList.contains('comms-kb');
      /* no mobile: input focado = modo teclado na hora (não espera o resize do Chrome) */
      const nowKb =
        mobile &&
        (inputFocused ||
          kb > 60 ||
          (vv && layoutH - Math.round(vv.height) > 60) ||
          h < layoutH - 60);
      document.body.classList.toggle('comms-kb', nowKb);
      if (nowKb && !wasKb) {
        const more = $('commsMorePanel');
        if (more) more.hidden = true;
        const btn = $('commsMoreBtn');
        if (btn) btn.setAttribute('aria-expanded', 'false');
        showQr(false);
        requestAnimationFrame(() => scrollFeedToEnd(true));
      }
      if (!nowKb && wasKb) {
        requestAnimationFrame(() => scrollFeedToEnd(true));
      }
    }

    let vvPollTimer = null;
    function pollViewportWhileFocused() {
      clearInterval(vvPollTimer);
      let n = 0;
      vvPollTimer = setInterval(() => {
        syncVisualViewport();
        if (++n >= 20 || document.activeElement !== $('commsInput')) {
          clearInterval(vvPollTimer);
          vvPollTimer = null;
        }
      }, 100);
    }

    function bindVisualViewport(on) {
      const vv = window.visualViewport;
      if (on) {
        if (bindVisualViewport._bound) return;
        const bump = () => syncVisualViewport();
        vv?.addEventListener('resize', bump);
        /* scroll só atualiza altura (top fica 0) — necessário em Android */
        vv?.addEventListener('scroll', bump);
        window.addEventListener('resize', bump);
        try {
          if (navigator.virtualKeyboard) {
            navigator.virtualKeyboard.overlaysContent = false;
            navigator.virtualKeyboard.addEventListener?.('geometrychange', bump);
          }
        } catch {
          /* ignore */
        }
        bindVisualViewport._bump = bump;
        bindVisualViewport._bound = true;
        syncVisualViewport();
      } else if (bindVisualViewport._bound) {
        const bump = bindVisualViewport._bump;
        vv?.removeEventListener('resize', bump);
        vv?.removeEventListener('scroll', bump);
        window.removeEventListener('resize', bump);
        try {
          navigator.virtualKeyboard?.removeEventListener?.('geometrychange', bump);
        } catch {
          /* ignore */
        }
        clearInterval(vvPollTimer);
        vvPollTimer = null;
        const rig = document.getElementById('rig');
        if (rig) {
          rig.style.height = '';
          rig.style.maxHeight = '';
          rig.style.top = '';
        }
        document.documentElement.style.removeProperty('--kb-inset');
        bindVisualViewport._bound = false;
      }
    }

    const REACTS = ['😈', '😛', '😝', '🔥', '👍'];
    let replyTo = null;
    let stopCommsVoice = () => {};

    function bumpAfter(m) {
      const stamp = Math.max(Number(m.at) || 0, Number(m.touch) || 0);
      if (stamp > state.after) state.after = stamp;
    }

    function clearReply() {
      replyTo = null;
      const bar = $('commsReplyBar');
      if (bar) bar.hidden = true;
      if ($('commsReplyName')) $('commsReplyName').textContent = '';
      if ($('commsReplyPreview')) $('commsReplyPreview').textContent = '';
    }

    function setReply(m) {
      if (!m || m.sys) return;
      replyTo = { id: m.id, name: m.name, text: m.text };
      $('commsReplyName').textContent = m.name || 'alguém';
      const preview =
        m.text ||
        (m.voice
          ? '🎤 áudio'
          : msgImages(m).length > 1
            ? `🖼 ${msgImages(m).length} imagens`
            : msgImages(m).length
              ? '🖼 imagem'
              : m.sticker || m.stickerCustom
                ? 'sticker'
                : '…');
      $('commsReplyPreview').textContent = String(preview).slice(0, 80);
      $('commsReplyBar').hidden = false;
      const input = $('commsInput');
      if (input) {
        const isCdr = !!(m.bot || m.seat === 'CDR' || m.peerId === 'cdr' || m.name === 'CD-R');
        if (isCdr && state.cdr) {
          const cur = input.value;
          if (!cur.trim().startsWith('/')) {
            input.value = '/' + (cur.trim() ? cur.replace(/^\s+/, '') : '');
          }
        }
        input.focus();
        // cursor no fim pra digitar depois do /
        const len = input.value.length;
        try {
          input.setSelectionRange(len, len);
        } catch {
          /* ignore */
        }
      }
    }

    function joinUrl(code, fromName, fromId) {
      const u = new URL(location.href);
      u.searchParams.set('comms', code);
      const nick = String(fromName || state.name || callsign() || '')
        .trim()
        .slice(0, 24);
      const pid = String(fromId || state.peerId || '')
        .trim()
        .slice(0, 32);
      if (nick) {
        u.searchParams.set('from', nick);
        if (pid) u.searchParams.set('fromId', pid);
        else u.searchParams.delete('fromId');
      } else {
        u.searchParams.delete('from');
        u.searchParams.delete('fromId');
      }
      return u.toString();
    }

    let qrInstance = null;

    async function showQr(show) {
      const panel = $('commsQrPanel');
      if (!panel) return;
      if (!show) {
        panel.hidden = true;
        return;
      }
      if (!state.code) return;
      panel.hidden = false;
      const box = $('commsQrBox');
      const hint = $('commsQrHint');
      const url = joinUrl(state.code);
      if (hint) hint.textContent = `escaneia · código ${state.code}`;
      if (!box) return;
      box.innerHTML = '';
      try {
        if (typeof QRCode === 'undefined') throw new Error('no QRCode');
        if (qrInstance) {
          try { qrInstance.clear(); } catch { /* ignore */ }
          qrInstance = null;
        }
        qrInstance = new QRCode(box, {
          text: url,
          width: 160,
          height: 160,
          colorDark: '#111111',
          colorLight: '#ffffff',
          correctLevel: QRCode.CorrectLevel.M,
        });
        if (hint) hint.textContent = `escaneia pra entrar · ${state.code}`;
      } catch {
        if (hint) {
          hint.innerHTML = `QR indisponível · usa o código <strong>${escapeHtml(state.code)}</strong> ou copia:<br><a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`;
        }
      }
    }

    function reactionsHtml(m) {
      const reactions = m.reactions || {};
      const chips = Object.entries(reactions)
        .filter(([, peers]) => Array.isArray(peers) && peers.length)
        .map(([emoji, peers]) => `<span data-react-chip="${emoji}">${emoji} ${peers.length}</span>`)
        .join('');
      return chips ? `<div class="comms-reacts">${chips}</div>` : '';
    }

    /** @type {Record<string, { src: string, kind?: string, creator?: string, description?: string, custom?: boolean }>} */
    let STICKERS = {};
    /** rascunho do criador de figurinha */
    let stickerDraft = null;
    const CUSTOM_STICKER_STORE = 'voidwire-stickers-custom-v1';

    function saveCustomStickersLocal() {
      try {
        const list = Object.entries(STICKERS)
          .filter(([, meta]) => meta?.custom)
          .map(([id, meta]) => ({
            id,
            src: meta.src,
            kind: meta.kind || 'image',
            creator: meta.creator || '',
            description: meta.description || '',
            at: meta.at || 0,
          }));
        localStorage.setItem(CUSTOM_STICKER_STORE, JSON.stringify(list));
      } catch {
        /* quota / private mode */
      }
    }

    function loadCustomStickersLocal() {
      try {
        const list = JSON.parse(localStorage.getItem(CUSTOM_STICKER_STORE) || '[]');
        if (!Array.isArray(list)) return;
        for (const s of list) {
          if (!s?.id || !s?.src) continue;
          STICKERS[s.id] = {
            src: s.src,
            kind: s.kind || 'image',
            creator: s.creator || '',
            description: s.description || '',
            custom: true,
            at: Number(s.at) || 0,
          };
        }
      } catch {
        /* ignore */
      }
    }

    function rememberCustomSticker(sc) {
      if (!sc?.id) return;
      const existing = STICKERS[sc.id];
      let src = sc.file
        ? `stickers/${sc.file}`
        : sc.data || (existing && existing.src);
      if (!src) return;
      /* msg antiga com .mp4: se o pack já tem .webp do mesmo id, mantém o webp */
      if (
        existing?.src &&
        sc.file &&
        /\.mp4$/i.test(sc.file) &&
        /\.webp$/i.test(String(existing.src))
      ) {
        src = existing.src;
      }
      const kindFromSrc =
        String(src).includes('.webm') ||
        String(src).includes('.mp4') ||
        String(src).startsWith('data:video/')
          ? 'video'
          : 'image';
      STICKERS[sc.id] = {
        src,
        kind:
          src === existing?.src
            ? existing.kind || kindFromSrc
            : sc.kind || kindFromSrc,
        creator: sc.creator || existing?.creator || '',
        description: sc.description || existing?.description || '',
        custom: true,
        at: Number(sc.at) || existing?.at || Date.now(),
      };
      saveCustomStickersLocal();
    }

    function renderStickerTray() {
      const tray = $('commsStickers');
      if (!tray) return;
      const entries = Object.entries(STICKERS).sort((a, b) => {
        const ca = a[1]?.custom ? 1 : 0;
        const cb = b[1]?.custom ? 1 : 0;
        if (ca !== cb) return cb - ca; // custom primeiro
        if (ca && cb) return (Number(b[1]?.at) || 0) - (Number(a[1]?.at) || 0); // mais recente primeiro
        return 0;
      });
      const bits = entries.map(([id, meta]) => {
        const src = typeof meta === 'string' ? meta : meta.src;
        const kind = typeof meta === 'string' ? 'image' : meta.kind || 'image';
        const media =
          kind === 'video'
            ? `<video src="${escapeHtml(src)}" muted playsinline loop autoplay preload="metadata"></video>`
            : `<img src="${escapeHtml(src)}" alt="" draggable="false" />`;
        return `<button type="button" data-sticker="${escapeHtml(id)}" title="${escapeHtml((meta && meta.creator) || id)}">${media}</button>`;
      });
      bits.push(
        `<button type="button" class="comms-sticker-add" id="commsStickerAdd" title="criar figurinha" aria-label="criar figurinha">+</button>`
      );
      tray.innerHTML = bits.join('') || bits[bits.length - 1];
    }

    function ingestPackList(list, packMeta, custom) {
      for (const s of list || []) {
        const id = String(s.id || '').trim();
        const file = String(s.file || '').trim();
        if (!id || !file) continue;
        if (!/^[a-z0-9][a-z0-9-]{0,40}$/i.test(id)) continue;
        if (!/^(custom\/)?[a-z0-9._-]+\.(webp|png|gif|jpe?g|webm|mp4)$/i.test(file)) continue;
        const kind =
          s.kind ||
          (/\.(webm|mp4)$/i.test(file) ? 'video' : /\.gif$/i.test(file) ? 'gif' : 'image');
        STICKERS[id] = {
          src: `stickers/${file}`,
          kind,
          creator: String(s.creator || packMeta?.publisher || packMeta?.name || 'pack').slice(0, 24),
          description: String(s.description || packMeta?.name || '').slice(0, 80),
          custom: !!custom,
          at: Number(s.at) || 0,
        };
      }
    }

    async function loadStickers() {
      STICKERS = {};

      try {
        const packRes = await fetch('stickers/pack.json', { cache: 'no-cache' });
        if (packRes.ok) {
          const pack = await packRes.json();
          ingestPackList(pack.stickers, pack, false);
        }
      } catch {
        /* ignore */
      }

      // custom.json = fonte da verdade (arquivo vazio / [] = limpa o tray e o cache)
      let customFromServer = null;
      try {
        const customRes = await fetch('stickers/custom.json', { cache: 'no-cache' });
        if (customRes.ok) {
          const text = await customRes.text();
          const trimmed = String(text || '').trim();
          customFromServer = trimmed ? JSON.parse(trimmed) : { stickers: [] };
          if (!customFromServer || typeof customFromServer !== 'object') customFromServer = { stickers: [] };
          if (!Array.isArray(customFromServer.stickers)) customFromServer.stickers = [];
        }
      } catch {
        customFromServer = null;
      }

      if (customFromServer) {
        ingestPackList(customFromServer.stickers, { name: 'custom' }, true);
        try {
          const keep = (customFromServer.stickers || [])
            .filter((s) => s?.id && s?.file)
            .map((s) => ({
              id: s.id,
              src: `stickers/${s.file}`,
              kind: s.kind || 'image',
              creator: s.creator || '',
              description: s.description || '',
              at: Number(s.at) || 0,
            }));
          localStorage.setItem(CUSTOM_STICKER_STORE, JSON.stringify(keep));
        } catch {
          /* ignore */
        }
      } else {
        try {
          const list = JSON.parse(localStorage.getItem(CUSTOM_STICKER_STORE) || '[]');
          if (Array.isArray(list)) {
            for (const s of list) {
              if (!s?.id || !s?.src) continue;
              STICKERS[s.id] = {
                src: s.src,
                kind: s.kind || 'image',
                creator: s.creator || '',
                description: s.description || '',
                custom: true,
                at: Number(s.at) || 0,
              };
            }
          }
        } catch {
          /* ignore */
        }
      }

      renderStickerTray();
      pruneBrokenCustomStickers();
    }

    function pruneBrokenCustomStickers() {
      Object.entries(STICKERS)
        .filter(([, m]) => m?.custom && m?.src && !String(m.src).startsWith('data:'))
        .forEach(([id, meta]) => {
          const kind = meta.kind || 'image';
          const src = meta.src;
          const drop = () => {
            if (!STICKERS[id]?.custom) return;
            delete STICKERS[id];
            saveCustomStickersLocal();
            renderStickerTray();
          };
          if (kind === 'video' || /\.(webm|mp4)$/i.test(src)) {
            const v = document.createElement('video');
            v.preload = 'metadata';
            v.onerror = drop;
            v.src = src;
            return;
          }
          const probe = new Image();
          probe.onerror = drop;
          probe.src = src;
        });
    }

    function safeImageSrc(src) {
      const s = String(src || '');
      const isGif = /^data:image\/gif;base64,/i.test(s);
      if (s.length > (isGif ? 22000000 : 1200000)) return '';
      if (!/^data:image\/(jpeg|jpg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(s)) return '';
      return s;
    }

    function safeStickerSrc(src) {
      const s = String(src || '');
      if (s.length > 2500000) return '';
      if (/^data:(image\/(jpeg|jpg|png|webp|gif)|video\/(webm|mp4));base64,[A-Za-z0-9+/=]+$/i.test(s)) {
        return s;
      }
      if (/^stickers\/(custom\/)?[a-z0-9._-]+\.(webp|png|gif|jpe?g|webm|mp4)$/i.test(s)) return s;
      return '';
    }

    function msgImages(m) {
      if (Array.isArray(m?.images) && m.images.length) return m.images;
      if (m?.image) return [m.image];
      return [];
    }

    function stickerMetaOf(m) {
      if (m?.stickerCustom) {
        rememberCustomSticker(m.stickerCustom);
        const cached = STICKERS[m.stickerCustom.id];
        if (cached) {
          return {
            id: m.stickerCustom.id,
            src: cached.src,
            kind: cached.kind || 'image',
            creator: m.stickerCustom.creator || cached.creator || m.name || '',
            description: m.stickerCustom.description || cached.description || '',
          };
        }
      }
      if (m?.sticker && STICKERS[m.sticker]) {
        const meta = STICKERS[m.sticker];
        return {
          id: m.sticker,
          src: typeof meta === 'string' ? meta : meta.src,
          kind: typeof meta === 'string' ? 'image' : meta.kind || 'image',
          creator: typeof meta === 'string' ? '' : meta.creator || '',
          description: typeof meta === 'string' ? '' : meta.description || '',
        };
      }
      return null;
    }

    function safeVoiceSrc(raw) {
      const s = String(raw || '');
      if (!s || s.length > 4_500_000) return '';
      if (
        /^data:audio\/(webm|ogg|mp4|mpeg|mp3|aac|wav|x-m4a|m4a|x-wav)(;[\w.=-]+)*;base64,[A-Za-z0-9+/=]+$/i.test(
          s
        )
      ) {
        return s;
      }
      return '';
    }

    function fmtVoiceMs(ms) {
      const total = Math.max(0, Math.round(Number(ms) / 1000) || 0);
      const m = Math.floor(total / 60);
      const s = String(total % 60).padStart(2, '0');
      return `${m}:${s}`;
    }

    const VOICE_WAVE_BARS = 28;
    const voiceWaveCache = new Map(); /* key -> number[] heights 0..1 */
    const voiceWavePending = new Set();
    let voiceWaveCtx = null;
    const voiceWaveWaiters = new Set();

    function normalizeVoiceWave(raw, bars = VOICE_WAVE_BARS) {
      if (!Array.isArray(raw) || !raw.length) return null;
      const n = Math.max(8, bars | 0);
      const src = raw.map((v) => Number(v)).filter((v) => Number.isFinite(v));
      if (src.length < 4) return null;
      const out = new Array(n);
      for (let i = 0; i < n; i += 1) {
        const t = (i / Math.max(1, n - 1)) * (src.length - 1);
        const a = Math.floor(t);
        const b = Math.min(src.length - 1, a + 1);
        const f = t - a;
        const v = src[a] * (1 - f) + src[b] * f;
        out[i] = Math.max(0.1, Math.min(1, v));
      }
      return out;
    }

    function peaksFromChannelData(ch, bars = VOICE_WAVE_BARS) {
      const total = ch?.length || 0;
      if (!total) return null;
      const n = Math.max(8, bars | 0);
      const block = Math.max(1, Math.floor(total / n));
      const peaks = new Array(n);
      let max = 0;
      for (let i = 0; i < n; i += 1) {
        const startI = i * block;
        const endI = i === n - 1 ? total : Math.min(total, startI + block);
        const span = Math.max(1, endI - startI);
        const step = Math.max(1, Math.floor(span / 64));
        let peak = 0;
        let sum = 0;
        let samples = 0;
        for (let j = startI; j < endI; j += step) {
          const v = Math.abs(ch[j]);
          if (v > peak) peak = v;
          sum += v * v;
          samples += 1;
        }
        const rms = samples ? Math.sqrt(sum / samples) : 0;
        const val = peak * 0.55 + rms * 1.8;
        peaks[i] = val;
        if (val > max) max = val;
      }
      if (max < 0.0005) return peaks.map(() => 0.12);
      return peaks.map((v) => {
        const shaped = Math.pow(v / max, 0.65);
        return Math.max(0.1, Math.min(1, 0.1 + shaped * 0.9));
      });
    }

    function voiceWaveHtml(m) {
      const id = m?.id ? String(m.id) : '';
      const fromMsg = normalizeVoiceWave(m?.voiceWave, VOICE_WAVE_BARS);
      const cached = id ? voiceWaveCache.get(id) : null;
      const heights = fromMsg || cached;
      if (id && fromMsg) voiceWaveCache.set(id, fromMsg);
      const bars = [];
      for (let i = 0; i < VOICE_WAVE_BARS; i += 1) {
        const h = heights?.[i] != null ? heights[i] : 0.14;
        bars.push('<i style="--h:' + Number(h).toFixed(3) + '"></i>');
      }
      return (
        '<div class="comms-voice-wave' + (heights ? ' is-ready' : ' is-pending') + '" data-voice-wave aria-hidden="true">' +
          bars.join('') +
        '</div>'
      );
    }

    function applyVoiceWaveHeights(wrap, heights) {
      const wave = wrap?.querySelector?.('[data-voice-wave]');
      if (!wave || !heights?.length) return;
      const bars = wave.children;
      const n = Math.min(bars.length, heights.length);
      for (let i = 0; i < n; i += 1) {
        bars[i].style.setProperty('--h', Number(heights[i]).toFixed(3));
      }
      wave.classList.remove('is-pending');
      wave.classList.add('is-ready');
    }

    async function peaksFromArrayBuffer(raw, bars = VOICE_WAVE_BARS) {
      const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      const AC = window.AudioContext || window.webkitAudioContext;
      let audioBuf = null;
      if (Offline) {
        const probe = new Offline(1, 1, 22050);
        audioBuf = await probe.decodeAudioData(raw.slice(0));
      } else if (AC) {
        if (!voiceWaveCtx || voiceWaveCtx.state === 'closed') {
          voiceWaveCtx = new AC();
        }
        const ctx = voiceWaveCtx;
        if (ctx.state === 'suspended') {
          try { await ctx.resume(); } catch { /* ignore */ }
        }
        audioBuf = await ctx.decodeAudioData(raw.slice(0));
      } else {
        return null;
      }
      const ch =
        audioBuf.numberOfChannels > 1
          ? (() => {
              const a = audioBuf.getChannelData(0);
              const b = audioBuf.getChannelData(1);
              const out = new Float32Array(a.length);
              const len = Math.min(a.length, b.length);
              for (let i = 0; i < len; i += 1) out[i] = (a[i] + b[i]) * 0.5;
              return out;
            })()
          : audioBuf.getChannelData(0);
      return peaksFromChannelData(ch, bars);
    }

    async function decodeVoicePeaks(src, bars = VOICE_WAVE_BARS) {
      const res = await fetch(src);
      const raw = await res.arrayBuffer();
      return peaksFromArrayBuffer(raw, bars);
    }

    async function peaksFromBlob(blob, bars = VOICE_WAVE_BARS) {
      if (!blob) return null;
      try {
        return await peaksFromArrayBuffer(await blob.arrayBuffer(), bars);
      } catch {
        return null;
      }
    }

    async function hydrateVoiceWave(wrap, m) {
      const src = safeVoiceSrc(m?.voice || wrap?.querySelector?.('audio')?.getAttribute?.('src'));
      if (!wrap || !src) return;
      const id = String(m?.id || wrap.dataset.voiceId || '');
      const fromMsg = normalizeVoiceWave(m?.voiceWave, VOICE_WAVE_BARS);
      if (fromMsg) {
        if (id) voiceWaveCache.set(id, fromMsg);
        applyVoiceWaveHeights(wrap, fromMsg);
        return;
      }
      if (id && voiceWaveCache.has(id)) {
        applyVoiceWaveHeights(wrap, voiceWaveCache.get(id));
        return;
      }
      const jobKey = id || src.slice(0, 64);
      if (voiceWavePending.has(jobKey)) return;
      voiceWavePending.add(jobKey);
      try {
        const heights = await decodeVoicePeaks(src, VOICE_WAVE_BARS);
        if (!heights) {
          voiceWaveWaiters.add(wrap);
          return;
        }
        if (id) voiceWaveCache.set(id, heights);
        if (m && Array.isArray(heights)) m.voiceWave = heights;
        if (wrap.isConnected) applyVoiceWaveHeights(wrap, heights);
        voiceWaveWaiters.delete(wrap);
      } catch {
        voiceWaveWaiters.add(wrap);
      } finally {
        voiceWavePending.delete(jobKey);
      }
    }

    function flushVoiceWaveWaiters() {
      for (const wrap of [...voiceWaveWaiters]) {
        if (!wrap?.isConnected) {
          voiceWaveWaiters.delete(wrap);
          continue;
        }
        const msg = wrap.closest?.('.comms-msg')?._msg;
        voiceWaveWaiters.delete(wrap);
        hydrateVoiceWave(wrap, msg || {
          voice: wrap.querySelector('audio')?.getAttribute('src'),
          id: wrap.dataset.voiceId,
          voiceMs: wrap.dataset.voiceMs,
        });
      }
    }

    function voiceHtml(m) {
      const src = safeVoiceSrc(m?.voice);
      if (!src) return '';
      const ms = Number(m.voiceMs) || 0;
      const label = ms > 0 ? fmtVoiceMs(ms) : 'áudio';
      return (
        '<div class="comms-voice" data-voice-id="' + escapeHtml(m.id || '') + '" data-voice-ms="' + (ms > 0 ? ms : '') + '">' +
          '<button type="button" class="btn comms-ico-btn comms-voice-play" data-voice-play aria-label="tocar áudio">' +
            '<svg class="comms-ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
              '<path d="M9 6.2v11.6l9.2-5.8L9 6.2z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/>' +
            '</svg>' +
          '</button>' +
          voiceWaveHtml(m) +
          '<span class="comms-voice-time">' + escapeHtml(label) + '</span>' +
          '<audio preload="metadata" playsinline src="' + src + '" hidden></audio>' +
        '</div>'
      );
    }

    function mediaDlIconSvg() {
      return (
        '<svg class="comms-ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
          '<path d="M12 4v10m0 0l3.5-3.5M12 14L8.5 10.5M6 19h12" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>' +
        '</svg>'
      );
    }

    function guessMediaExt(src, fallback = 'jpg') {
      const s = String(src || '');
      const data = s.match(/^data:image\/([a-z0-9+.-]+)/i);
      if (data) {
        const t = data[1].toLowerCase().replace('jpeg', 'jpg');
        if (t === 'svg+xml') return 'svg';
        return t.slice(0, 8) || fallback;
      }
      const path = s.split('?')[0].split('#')[0];
      const m = path.match(/\.([a-z0-9]{2,5})$/i);
      return m ? m[1].toLowerCase() : fallback;
    }

    async function downloadMediaSrc(src, nameHint = 'comms') {
      const url = String(src || '').trim();
      if (!url) return;
      const base =
        String(nameHint || 'comms')
          .replace(/[^\w\-]+/g, '_')
          .replace(/^_+|_+$/g, '')
          .slice(0, 32) || 'comms';
      const filename = `${base}-${Date.now()}.${guessMediaExt(url)}`;
      try {
        let href = url;
        let revoke = null;
        if (!url.startsWith('data:')) {
          const res = await fetch(url);
          if (!res.ok) throw new Error('falha no download');
          const blob = await res.blob();
          href = URL.createObjectURL(blob);
          revoke = href;
        }
        const a = document.createElement('a');
        a.href = href;
        a.download = filename;
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
        if (revoke) setTimeout(() => URL.revokeObjectURL(revoke), 1500);
        notify('baixando…');
      } catch {
        try {
          window.open(url, '_blank', 'noopener');
        } catch {
          notify('não deu pra baixar');
        }
      }
    }

    function mediaHtml(m) {
      const voice = voiceHtml(m);
      if (voice) return voice;
      const who = String(m.name || (m.bot || m.peerId === 'cdr' ? 'CD-R' : 'ghost')).trim() || 'ghost';
      const imgs = msgImages(m)
        .map((raw, i) => {
          const src = safeImageSrc(raw);
          if (!src) return '';
          const safe = String(src).replace(/"/g, '');
          return (
            `<span class="comms-pic-wrap">` +
              `<img class="comms-pic" src="${safe}" alt="imagem ${i + 1}" loading="lazy" data-gallery-i="${i}" style="max-width:100%;width:auto;height:auto;display:block;" />` +
              `<button type="button" class="comms-media-dl" data-dl-src="${encodeURIComponent(src)}" data-dl-name="${escapeHtml(who)}" title="baixar mídia" aria-label="baixar mídia de ${escapeHtml(who)}">${mediaDlIconSvg()}</button>` +
            `</span>`
          );
        })
        .filter(Boolean)
        .join('');
      const gallery = imgs
        ? `<div class="comms-pics${msgImages(m).length > 1 ? ' multi' : ''}">${imgs}</div>`
        : '';
      if (gallery) return gallery;
      const st = stickerMetaOf(m);
      if (!st) return '';
      const src = safeStickerSrc(st.src);
      if (!src) return '';
      const wrapStyle =
        'display:flex;align-items:center;justify-content:center;width:100%;height:140px;margin:0.2rem 0 0.05rem;overflow:hidden;line-height:0;box-sizing:border-box';
      const mediaStyle =
        'display:block;width:140px;height:140px;max-width:100%;object-fit:contain;object-position:center center;border:0;margin:0 auto;background:transparent';
      if (st.kind === 'video') {
        return `<div class="comms-sticker-wrap" style="${wrapStyle}"><video class="comms-sticker comms-sticker-vid" src="${escapeHtml(src)}" width="140" height="140" style="${mediaStyle}" autoplay loop muted playsinline preload="metadata" data-sticker-id="${escapeHtml(st.id || '')}"></video></div>`;
      }
      return `<div class="comms-sticker-wrap" style="${wrapStyle}"><img class="comms-sticker" src="${escapeHtml(src)}" width="140" height="140" style="${mediaStyle}" alt="sticker" draggable="false" data-sticker-id="${escapeHtml(st.id || '')}" /></div>`;
    }

    function playlistHtml(m) {
      const pl = m.playlist;
      if (!pl?.tracks?.length) return '';
      const rows = pl.tracks
        .map((t) => {
          const cmd = String(t.cmd || `/music ${t.title || ''}`).trim();
          const num = String(t.num ?? '').padStart(2, '0');
          return (
            `<div class="comms-pl-row">` +
              `<span class="comms-pl-num">${escapeHtml(num)}</span>` +
              `<span class="comms-pl-title">${escapeHtml(t.title || '')}</span>` +
              `<button type="button" class="comms-pl-copy" data-copy-cmd="${encodeURIComponent(cmd)}" title="${escapeHtml(cmd)}">copiar</button>` +
            `</div>`
          );
        })
        .join('');
      return (
        `<div class="comms-playlist">` +
          `<p class="comms-pl-head">PLAY · ${escapeHtml(pl.album || 'album')}</p>` +
          `<div class="comms-pl-list">${rows}</div>` +
          `<p class="comms-pl-hint">/comando · /yt link · /stop · pede música pro CD-R no papo</p>` +
        `</div>`
      );
    }

    function commandsHtml(m) {
      const pack = m.commands;
      if (!pack?.items?.length) return '';
      const rows = pack.items
        .map((c) => {
          const cmd = String(c.cmd || '').trim();
          if (!cmd) return '';
          return (
            `<div class="comms-pl-row comms-cmd-row">` +
              `<span class="comms-pl-title"><code class="comms-cmd">${escapeHtml(cmd)}</code></span>` +
              `<span class="comms-cmd-label">${escapeHtml(c.label || '')}</span>` +
              `<button type="button" class="comms-pl-copy" data-copy-cmd="${encodeURIComponent(cmd)}" title="${escapeHtml(cmd)}">copiar</button>` +
            `</div>`
          );
        })
        .filter(Boolean)
        .join('');
      return (
        `<div class="comms-playlist comms-commands">` +
          `<p class="comms-pl-head">${escapeHtml(pack.title || 'COMANDOS')}</p>` +
          `<div class="comms-pl-list">${rows}</div>` +
        `</div>`
      );
    }

    function msgStackKey(m) {
      if (!m || m.sys) return null;
      if (m.bot || m.peerId === 'cdr' || m.peerId === 'deck' || m.seat === 'CDR') return 'cdr';
      return m.peerId ? String(m.peerId) : null;
    }

    function restackMsgFaces() {
      const feed = $('commsFeed');
      if (!feed) return;
      let prev = null;
      for (const el of feed.children) {
        if (!el?.classList?.contains('comms-msg')) continue;
        if (el.classList.contains('sys')) {
          prev = null;
          continue;
        }
        const m = el._msg;
        if (!m) continue;
        const peer = msgStackKey(m);
        /* 1º da sequência (ou reply) mostra foto+nick; o resto só balão — igual texto/figurinha/mídia */
        const showFace = !!(m.reply || !prev || msgStackKey(prev) !== peer);
        el.classList.toggle('is-stack', !showFace);
        el.classList.toggle('has-face', showFace);
        prev = m;
      }
    }

    function fillMsgEl(el, m) {
      const isBot = !!(m.bot || m.seat === 'CDR' || m.peerId === 'cdr' || m.peerId === 'deck');
      const kind = isBot ? 'bot' : m.peerId === state.peerId ? 'me' : 'them';
      const hasSticker = !!m.sticker || !!m.stickerCustom;
      const hasVoice = !!safeVoiceSrc(m.voice);
      /* voz NÃO é has-media — senão herda max-width/overflow de imagem e some nick/foto */
      const hasMedia = msgImages(m).length > 0 || hasSticker;
      const hasPlaylist = !!(m.playlist?.tracks?.length);
      const hasCommands = !!(m.commands?.items?.length);
      el.className = `comms-msg ${kind}${hasMedia ? ' has-media' : ''}${hasSticker ? ' has-sticker' : ''}${hasVoice ? ' has-voice' : ''}${hasPlaylist || hasCommands ? ' has-playlist' : ''}`;
      el.dataset.id = m.id;
      if (m.peerId) el.dataset.peer = m.peerId;
      el.style.transform = '';
      el.style.width = '';
      el.style.maxWidth = '';
      el.classList.remove('swiping', 'swipe-armed');
      const quote = m.reply
        ? `<div class="comms-quote" data-reply-id="${escapeHtml(m.reply.id || '')}" role="button" tabindex="0" aria-label="Ver mensagem original de ${escapeHtml(m.reply.name || '')}"><strong>${escapeHtml(m.reply.name || '')}</strong><em>${escapeHtml(m.reply.text || '')}</em></div>`
        : '';
      const special = commandsHtml(m) || playlistHtml(m);
      const formatCommsBody = (text) =>
        escapeHtml(text)
          .replace(
            /\[\[JOIN:([A-Za-z0-9_-]+)\]\]/g,
            (_m, id) =>
              `<button type="button" class="comms-join-here" data-along="${escapeHtml(id)}">clica aqui</button>`
          )
          .replace(/\n/g, '<br/>');
      const body =
        !special && m.text
          ? `<p class="comms-body">${formatCommsBody(m.text)}</p>`
          : '';
      const displayName = m.name || (isBot ? 'CD-R' : 'ghost');
      el.innerHTML =
        `<span class="comms-swipe-ico" aria-hidden="true">↩</span>` +
        `<span class="comms-msg-aside">` +
          `<b class="who-name">${escapeHtml(displayName)}</b>` +
          `${msgFaceHtml(m.peerId, displayName)}` +
        `</span>` +
        `${quote}${mediaHtml(m)}${special || body}${reactionsHtml(m)}`;
      el._msg = m;
      if (hasVoice) {
        const voiceWrap = el.querySelector('.comms-voice');
        if (voiceWrap) {
          /* analisa o áudio real — silêncio baixo, fala alta */
          queueMicrotask(() => hydrateVoiceWave(voiceWrap, m));
        }
      }
      if (m.stickerCustom?.id) {
        const was = !!STICKERS[m.stickerCustom.id];
        rememberCustomSticker(m.stickerCustom);
        if (!was) renderStickerTray();
      }
    }

    function renderNowPlaying(peers) {
      const el = $('commsNowPlaying');
      if (!el) return;
      const humans = humanPeers(peers || []);
      const myL = state.listeningByPeer[String(state.peerId || '')];
      const myKey = listeningTrackKey(myL);
      const rows = [];
      for (const p of humans) {
        const L = state.listeningByPeer[String(p.id || '')];
        if (!L?.title) continue;
        const mine = p.id === state.peerId;
        const name = escapeHtml(mine ? state.name || 'você' : p.name || 'ghost');
        const panchiko = L.kind === 'album' ? ' panchiko' : '';
        const syncedHere = state.alongWith === p.id;
        const syncedMe = mine && !!state.alongWith;
        const followingMe = !mine && state.alongByPeer?.[p.id] === state.peerId;
        const sameAsMe = !mine && !!myKey && listeningTrackKey(L) === myKey;
        const juntos = syncedHere || followingMe || sameAsMe;
        let along = '';
        if (syncedMe) {
          along =
            `<button type="button" class="comms-now-along leave" data-leave-along="1" title="sair do sync e deixar o outro no solo">sair do sync</button>`;
        } else if (juntos) {
          along = `<span class="comms-now-tag" title="ouvindo junto">juntos</span>`;
        } else if (!mine) {
          along =
            `<button type="button" class="comms-now-along" data-along="${escapeHtml(p.id)}" title="se juntar ao play">se juntar</button>`;
        }
        rows.push(
          `<div class="comms-now-row${panchiko}${mine ? ' mine' : ' theirs'}${juntos || syncedMe ? ' synced' : ''}" data-peer="${escapeHtml(p.id)}">` +
            `<span class="comms-now-note" aria-hidden="true">♪</span>` +
            `<b class="comms-now-who">${name}</b>` +
            `<span class="comms-now-track">${escapeHtml(L.title)}</span>` +
            along +
          `</div>`
        );
      }
      if (!rows.length) {
        el.hidden = true;
        el.innerHTML = '';
        return;
      }
      el.hidden = false;
      el.innerHTML = rows.join('');
    }

    let alongBusy = false;
    let alongApplyAt = 0;
    let lastAlongSeekAt = 0;

    function listeningTrackKey(L) {
      if (!L?.title) return '';
      if (L.kind === 'spotify' || L.uri) return `sp:${L.uri || L.id || L.title}`;
      if (L.videoId || L.kind === 'yt') return `yt:${L.videoId || ''}`;
      return `album:${L.id || L.title || ''}`;
    }

    function refreshNowPlayingFromState() {
      const peers = Object.keys(state.listeningByPeer).map((id) => ({
        id,
        name: id === state.peerId ? state.name : '…',
        listening: state.listeningByPeer[id],
      }));
      renderNowPlaying(peers);
    }

    async function leaveAlong() {
      if (!state.alongWith && !Radio.getActive()) return;
      const was = state.alongWith;
      state.alongWith = null;
      state.alongTrackKey = '';
      Radio.stopAll(true);
      notify('saiu do sync · a outra pessoa segue solo');
      refreshNowPlayingFromState();
      try {
        const r = await postPresence({ listening: null });
        if (r?.peers) renderPeers(r.peers, r.slots);
        else refreshNowPlayingFromState();
      } catch {
        refreshNowPlayingFromState();
      }
      return was;
    }

    function playFromListening(L) {
      if (!L?.title) return null;
      if ((L.kind === 'spotify' || L.uri) && (L.uri || L.id)) {
        return {
          kind: 'spotify',
          uri: L.uri || `spotify:track:${L.id}`,
          id: L.id,
          title: L.title,
        };
      }
      if ((L.kind === 'yt' || L.videoId) && L.videoId) {
        return { kind: 'yt', videoId: L.videoId, title: L.title };
      }
      if ((L.kind === 'album' || !L.kind) && L.id) {
        return {
          kind: 'album',
          id: L.id,
          title: L.title,
          stream: `/api/deck/album/stream/${encodeURIComponent(L.id)}`,
        };
      }
      return null;
    }

    async function listenAlong(fromPeerId) {
      if (!state.code || !state.peerId || !fromPeerId || fromPeerId === state.peerId) return;
      if (alongBusy) return;

      const L = state.listeningByPeer[String(fromPeerId)];
      if (!L?.title) {
        notify('ninguém tocando aí');
        return;
      }

      const wantKey = listeningTrackKey(L);
      const active = Radio.getActive();
      /* já no sync da mesma faixa: só corrige UI / clock, sem reiniciar áudio */
      if (
        state.alongWith === fromPeerId &&
        active &&
        (wantKey === state.alongTrackKey || wantKey === Radio.trackKeyOf(active))
      ) {
        state.alongTrackKey = wantKey || state.alongTrackKey;
        refreshNowPlayingFromState();
        syncAlongClock();
        return;
      }

      alongBusy = true;
      alongApplyAt = Date.now();
      try {
        const r = await api(`/api/deck/comms/${state.code}/listen-along`, {
          method: 'POST',
          body: JSON.stringify({ peerId: state.peerId, fromPeerId }),
        });
        if (r?.ok && r.play) {
          state.alongWith = fromPeerId;
          state.alongTrackKey =
            Radio.trackKeyOf(r.play) || wantKey;
          if (r.peers) renderPeers(r.peers, r.slots);
          else refreshNowPlayingFromState();
          await Radio.apply(r.play);
          refreshNowPlayingFromState();
          notify(`se juntou · sync · ${r.play.title || L.title}`);
          return;
        }

        const play = playFromListening(L);
        if (play) {
          play.seek = estimatedPeerSeek(L);
          state.alongWith = fromPeerId;
          state.alongTrackKey = Radio.trackKeyOf(play) || wantKey;
          refreshNowPlayingFromState();
          api(`/api/deck/comms/${state.code}/presence`, {
            method: 'POST',
            body: JSON.stringify({
              peerId: state.peerId,
              name: state.name,
              after: state.after,
              alongWith: fromPeerId,
              listening: {
                title: L.title,
                kind: play.kind,
                id: L.id || play.id,
                videoId: L.videoId || play.videoId,
                uri: L.uri || play.uri,
                pos: play.seek,
                posAt: Date.now(),
              },
            }),
          }).catch(() => {});
          await Radio.apply(play);
          refreshNowPlayingFromState();
          notify(`se juntou · sync · ${play.title || L.title}`);
          return;
        }

        notify(r?.error || 'tentando /junto…');
        await sendMessage({ text: '/junto' });
      } finally {
        alongBusy = false;
        alongApplyAt = Date.now();
      }
    }

    function estimatedPeerSeek(L) {
      if (!L) return 0;
      const pos = typeof L.pos === 'number' ? L.pos : 0;
      const at = typeof L.posAt === 'number' ? L.posAt : 0;
      if (!at) return pos;
      return Math.max(0, pos + Math.max(0, (Date.now() - at) / 1000));
    }

    function syncAlongClock() {
      if (!state.alongWith || !Radio.getActive()) return;
      if (alongBusy) return;
      if (Date.now() - lastAlongSeekAt < 2500) return;
      const L = state.listeningByPeer[String(state.alongWith)];
      if (!L?.title) return;
      const target = estimatedPeerSeek(L);
      const mine = Radio.getPosition();
      if (Math.abs(target - mine) > 2.8) {
        lastAlongSeekAt = Date.now();
        Radio.seekTo(target);
      }
    }

    function syncAlongIfNeeded() {
      if (!state.alongWith) return;
      if (alongBusy) return;
      /* evita re-apply no meio do boot do player */
      if (Date.now() - alongApplyAt < 1800) return;

      const L = state.listeningByPeer[String(state.alongWith)];
      if (!L?.title) {
        /* host saiu do canal — quem ficou no sync continua solo, sem parar */
        state.alongWith = null;
        if (Radio.getActive()) {
          state.alongTrackKey = Radio.trackKeyOf(Radio.getActive()) || '';
          postPresence().catch(() => {});
        } else {
          state.alongTrackKey = '';
        }
        refreshNowPlayingFromState();
        return;
      }

      const key = listeningTrackKey(L);
      const active = Radio.getActive();
      const activeKey = Radio.trackKeyOf(active);

      if (active && (key === state.alongTrackKey || key === activeKey)) {
        state.alongTrackKey = key;
        syncAlongClock();
        return;
      }

      /* mesma faixa já marcada, player ainda subindo */
      if (!active && key && key === state.alongTrackKey) {
        return;
      }

      listenAlong(state.alongWith);
    }

    function applyPlaySync(sync) {
      if (!sync || !sync.at || sync.at === state.lastPlaySyncAt) return;
      if (sync.by === state.peerId) {
        state.lastPlaySyncAt = sync.at;
        return;
      }
      /* só quem está de fato no sync do host — não acopla quem só toca a mesma faixa */
      if (state.alongWith !== sync.by) return;
      state.lastPlaySyncAt = sync.at;
      if (sync.kind === 'stop') {
        if (sync.track) {
          state.alongTrackKey = listeningTrackKey(sync.track);
        }
        Radio.apply({ kind: 'stop', keepAlong: true });
        refreshNowPlayingFromState();
        return;
      }
      if (sync.kind === 'resume' && sync.play) {
        state.alongTrackKey = Radio.trackKeyOf(sync.play);
        alongApplyAt = Date.now();
        Radio.apply(sync.play);
        refreshNowPlayingFromState();
        notify(`♪ sync · retomou · ${sync.play.title || ''}`);
      }
    }

    const MAX_PENDING = 6;
    let pendingImages = [];

    function renderAttachBar() {
      const bar = $('commsAttachBar');
      const list = $('commsAttachList');
      if (!bar || !list) return;
      if (!pendingImages.length) {
        bar.hidden = true;
        list.innerHTML = '';
        return;
      }
      bar.hidden = false;
      const canAdd = pendingImages.length < MAX_PENDING;
      const addBtn = canAdd
        ? `<button type="button" class="comms-attach-add" data-add-more aria-label="adicionar mais imagens">+</button>`
        : '';
      list.innerHTML =
        addBtn +
        pendingImages
          .map(
            (src, i) =>
              `<div class="comms-attach-item"><img src="${src}" alt="preview ${i + 1}" /><button type="button" data-rm="${i}" aria-label="remover">×</button></div>`
          )
          .join('');
      $('commsStickers').hidden = true;
    }

    function clearAttach() {
      pendingImages = [];
      renderAttachBar();
    }

    function addAttach(dataUrl) {
      if (pendingImages.length >= MAX_PENDING) {
        notify(`máx. ${MAX_PENDING} imagens por mensagem`);
        return false;
      }
      pendingImages.push(dataUrl);
      renderAttachBar();
      return true;
    }

    const MAX_GIF_BYTES = 15 * 1024 * 1024;
    const MAX_GIF_DATA_CHARS = 22_000_000;

    function isGifFile(file) {
      const type = String(file?.type || '').toLowerCase();
      const name = String(file?.name || '').toLowerCase();
      return type === 'image/gif' || name.endsWith('.gif');
    }

    function readFileAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('falha ao ler arquivo'));
        reader.readAsDataURL(file);
      });
    }

    async function prepareAttachFile(file) {
      if (!file) throw new Error('arquivo vazio');
      if (isGifFile(file)) {
        if (file.size > MAX_GIF_BYTES) throw new Error('gif grande demais (máx. 15MB)');
        const data = await readFileAsDataUrl(file);
        if (!/^data:image\/gif;base64,/i.test(data)) throw new Error('gif inválido');
        if (data.length > MAX_GIF_DATA_CHARS) throw new Error('gif grande demais (máx. 15MB)');
        return data;
      }
      return compressImageFile(file);
    }

    function compressImageFile(file) {
      return new Promise((resolve, reject) => {
        if (!file || !String(file.type || '').startsWith('image/')) {
          reject(new Error('arquivo não é imagem'));
          return;
        }
        if (isGifFile(file)) {
          prepareAttachFile(file).then(resolve, reject);
          return;
        }
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
          URL.revokeObjectURL(url);
          const max = 1440;
          let w = img.naturalWidth || img.width;
          let h = img.naturalHeight || img.height;
          if (!w || !h) {
            reject(new Error('imagem inválida'));
            return;
          }
          const scale = Math.min(1, max / Math.max(w, h));
          w = Math.max(1, Math.round(w * scale));
          h = Math.max(1, Math.round(h * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, 0, 0, w, h);

          const softCap = 900000;
          const hardCap = 1200000;
          const tryEncode = (mime, startQ) => {
            let quality = startQ;
            let out = canvas.toDataURL(mime, quality);
            // se o browser ignorar o mime (ex: webp), cai fora
            if (!out.startsWith(`data:${mime}`)) return null;
            while (out.length > softCap && quality > 0.78) {
              quality -= 0.04;
              out = canvas.toDataURL(mime, quality);
            }
            return out;
          };

          let out = tryEncode('image/webp', 0.9) || tryEncode('image/jpeg', 0.92);
          if (!out || out.length > hardCap) {
            // último recurso: jpeg um pouco mais compacto, ainda legível
            let quality = 0.84;
            out = canvas.toDataURL('image/jpeg', quality);
            while (out.length > hardCap && quality > 0.7) {
              quality -= 0.04;
              out = canvas.toDataURL('image/jpeg', quality);
            }
          }
          if (!out || out.length > hardCap) {
            reject(new Error('imagem ainda grande demais'));
            return;
          }
          resolve(out);
        };
        img.onerror = () => {
          URL.revokeObjectURL(url);
          reject(new Error('falha ao ler imagem'));
        };
        img.src = url;
      });
    }

    let lightboxGallery = [];
    let lightboxIndex = 0;
    let lightboxFrom = null;
    let lbSettling = false;
    let lbScale = 1;
    let lbX = 0;
    let lbY = 0;
    let lbBound = false;
    const LB_TIP_KEY = 'voidwire-lightbox-tip-v2';
    let tipTimer = null;
    let tipStep = 0;
    const TIP_STEPS = [
      { title: 'ampliar', cap: 'pinça com 2 dedos pra dar zoom' },
      { title: 'toque duplo', cap: 'toca 2× (ou scroll no PC) pra ampliar' },
      { title: 'carrossel', cap: 'arrasta pro lado pra trocar de imagem' },
    ];

    function setTipStep(i) {
      tipStep = ((i % TIP_STEPS.length) + TIP_STEPS.length) % TIP_STEPS.length;
      const step = TIP_STEPS[tipStep];
      const title = $('commsLightboxTipTitle');
      const cap = $('commsLightboxTipCap');
      if (title) title.textContent = step.title;
      if (cap) cap.textContent = step.cap;
      document.querySelectorAll('#commsLightboxTip .tip-demo').forEach((el) => {
        el.classList.toggle('on', Number(el.dataset.tipStep) === tipStep);
      });
      document.querySelectorAll('#commsLightboxTipSteps i').forEach((el, idx) => {
        el.classList.toggle('on', idx === tipStep);
      });
    }

    function showLightboxTip() {
      const tip = $('commsLightboxTip');
      if (!tip) return;
      try {
        if (localStorage.getItem(LB_TIP_KEY) === '1') return;
      } catch {
        /* ignore */
      }
      tip.hidden = false;
      setTipStep(0);
      clearInterval(tipTimer);
      tipTimer = setInterval(() => setTipStep(tipStep + 1), 2600);
    }

    function dismissLightboxTip() {
      const tip = $('commsLightboxTip');
      if (tip) tip.hidden = true;
      clearInterval(tipTimer);
      tipTimer = null;
      try {
        localStorage.setItem(LB_TIP_KEY, '1');
      } catch {
        /* ignore */
      }
    }

    function resetLightboxZoom() {
      lbScale = 1;
      lbX = 0;
      lbY = 0;
      applyLightboxTransform();
    }

    function applyLightboxTransform() {
      const img = $('commsLightboxImg');
      if (!img) return;
      img.style.transform = `translate(${lbX}px, ${lbY}px) scale(${lbScale})`;
      img.classList.toggle('zoomed', lbScale > 1.05);
      const stage = $('commsLightboxStage');
      if (stage) stage.classList.toggle('zoomed', lbScale > 1.05);
    }

    function setLightboxZoom(next, cx, cy) {
      const stage = $('commsLightboxStage');
      const img = $('commsLightboxImg');
      if (!stage || !img) return;
      const rect = stage.getBoundingClientRect();
      const originX = (cx ?? rect.left + rect.width / 2) - rect.left - rect.width / 2;
      const originY = (cy ?? rect.top + rect.height / 2) - rect.top - rect.height / 2;
      const prev = lbScale || 1;
      const scale = Math.max(1, Math.min(4.5, next));
      if (scale === 1) {
        resetLightboxZoom();
        return;
      }
      const ratio = scale / prev;
      lbX = originX - (originX - lbX) * ratio;
      lbY = originY - (originY - lbY) * ratio;
      lbScale = scale;
      applyLightboxTransform();
    }

    function renderLightboxDots() {
      const dots = $('commsLightboxDots');
      if (!dots) return;
      const many = lightboxGallery.length > 1;
      dots.hidden = !many;
      if (!many) {
        dots.innerHTML = '';
        return;
      }
      dots.innerHTML = lightboxGallery
        .map((_, i) => `<button type="button" class="${i === lightboxIndex ? 'on' : ''}" data-dot="${i}" aria-label="imagem ${i + 1}"></button>`)
        .join('');
    }

    function galleryAt(i) {
      const n = lightboxGallery.length;
      if (!n) return '';
      return lightboxGallery[((i % n) + n) % n];
    }

    function setTrackOffset(px, animate = false) {
      const track = $('commsLightboxTrack');
      if (!track) return;
      // base = -33.333% (slide do meio) + arraste em px relativo à largura do stage
      const stage = $('commsLightboxStage');
      const w = stage?.clientWidth || 1;
      const pct = -33.333 + (px / w) * 33.333;
      track.classList.toggle('animating', !!animate);
      track.classList.toggle('dragging', !animate && px !== 0);
      track.style.transform = `translateX(${pct}%)`;
    }

    function resetTrack(instant = true) {
      const track = $('commsLightboxTrack');
      if (!track) return;
      track.classList.remove('animating', 'dragging');
      if (instant) {
        track.style.transition = 'none';
        track.style.transform = 'translateX(-33.333%)';
        // force reflow
        void track.offsetWidth;
        track.style.transition = '';
      } else {
        track.style.transform = 'translateX(-33.333%)';
      }
    }

    function fillLightboxSlides() {
      const curr = $('commsLightboxImg');
      const prev = $('commsLightboxImgPrev');
      const next = $('commsLightboxImgNext');
      if (!curr || !lightboxGallery.length) return;
      curr.src = galleryAt(lightboxIndex);
      if (lightboxGallery.length > 1) {
        if (prev) prev.src = galleryAt(lightboxIndex - 1);
        if (next) next.src = galleryAt(lightboxIndex + 1);
      } else {
        if (prev) prev.removeAttribute('src');
        if (next) next.removeAttribute('src');
      }
    }

    function showLightboxSlide() {
      const count = $('commsLightboxCount');
      const prevBtn = $('commsLightboxPrev');
      const nextBtn = $('commsLightboxNext');
      if (!lightboxGallery.length) return;
      resetLightboxZoom();
      fillLightboxSlides();
      resetTrack(true);
      const many = lightboxGallery.length > 1;
      if (count) {
        count.hidden = !many;
        count.textContent = `${lightboxIndex + 1} / ${lightboxGallery.length}`;
      }
      if (prevBtn) prevBtn.hidden = !many;
      if (nextBtn) nextBtn.hidden = !many;
      renderLightboxDots();
    }

    function stepLightbox(delta, withSlide = true) {
      if (lightboxGallery.length < 2) {
        resetTrack(true);
        return;
      }
      if (lbSettling) return;
      if (lbScale > 1.05) resetLightboxZoom();

      if (!withSlide) {
        lightboxIndex = (lightboxIndex + delta + lightboxGallery.length) % lightboxGallery.length;
        showLightboxSlide();
        return;
      }

      const track = $('commsLightboxTrack');
      const stage = $('commsLightboxStage');
      if (!track || !stage) {
        lightboxIndex = (lightboxIndex + delta + lightboxGallery.length) % lightboxGallery.length;
        showLightboxSlide();
        return;
      }

      lbSettling = true;
      const w = stage.clientWidth || 1;
      const targetPx = delta > 0 ? -w : w;
      setTrackOffset(targetPx, true);

      let finished = false;
      const onEnd = (ev) => {
        if (finished) return;
        if (ev && ev.target !== track) return;
        finished = true;
        track.removeEventListener('transitionend', onEnd);
        lightboxIndex = (lightboxIndex + delta + lightboxGallery.length) % lightboxGallery.length;
        fillLightboxSlides();
        resetTrack(true);
        const count = $('commsLightboxCount');
        if (count && lightboxGallery.length > 1) {
          count.textContent = `${lightboxIndex + 1} / ${lightboxGallery.length}`;
        }
        renderLightboxDots();
        lbSettling = false;
      };
      track.addEventListener('transitionend', onEnd);
      setTimeout(() => onEnd(), 320);
    }

    function syncLightboxMeta() {
      const by = $('commsLightboxBy');
      if (!by) return;
      const name = String(lightboxFrom?.name || '').trim();
      if (!lightboxGallery.length || !name) {
        by.hidden = true;
        by.textContent = '';
        return;
      }
      by.hidden = false;
      by.textContent = name;
    }

    function openLightbox(srcs, start = 0, from = null) {
      const box = $('commsLightbox');
      if (!box || !srcs?.length) return;
      lightboxGallery = srcs.filter(Boolean);
      lightboxIndex = Math.max(0, Math.min(start, lightboxGallery.length - 1));
      lightboxFrom = from && typeof from === 'object' ? { name: from.name || '', peerId: from.peerId || '' } : null;
      showLightboxSlide();
      syncLightboxMeta();
      box.hidden = false;
      document.body.classList.add('lightbox-open');
      bindLightboxGestures();
      showLightboxTip();
    }

    function closeLightbox() {
      const box = $('commsLightbox');
      const tip = $('commsLightboxTip');
      if (!box) return;
      box.hidden = true;
      if (tip) tip.hidden = true;
      clearInterval(tipTimer);
      tipTimer = null;
      ['commsLightboxImg', 'commsLightboxImgPrev', 'commsLightboxImgNext'].forEach((id) => {
        const el = $(id);
        if (!el) return;
        el.removeAttribute('src');
        el.style.transform = '';
        el.classList.remove('zoomed');
      });
      resetLightboxZoom();
      resetTrack(true);
      lbSettling = false;
      lightboxGallery = [];
      lightboxIndex = 0;
      lightboxFrom = null;
      syncLightboxMeta();
      document.body.classList.remove('lightbox-open');
    }

    function bindLightboxGestures() {
      if (lbBound) return;
      const stage = $('commsLightboxStage');
      const img = $('commsLightboxImg');
      if (!stage || !img) return;
      lbBound = true;

      let pointers = new Map();
      let pinchStartDist = 0;
      let pinchStartScale = 1;
      let panStartX = 0;
      let panStartY = 0;
      let panOriginX = 0;
      let panOriginY = 0;
      let startX = 0;
      let startY = 0;
      let dragX = 0;
      let moved = false;
      let lastTapAt = 0;
      let lastTapX = 0;
      let lastTapY = 0;

      const dist = () => {
        const pts = [...pointers.values()];
        if (pts.length < 2) return 0;
        return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      };

      const canSwipe = () => lightboxGallery.length > 1 && lbScale <= 1.05 && !lbSettling;

      stage.addEventListener(
        'wheel',
        (e) => {
          if ($('commsLightbox')?.hidden) return;
          e.preventDefault();
          const delta = e.deltaY > 0 ? -0.2 : 0.2;
          setLightboxZoom(lbScale + delta, e.clientX, e.clientY);
        },
        { passive: false }
      );

      stage.addEventListener('pointerdown', (e) => {
        if ($('commsLightbox')?.hidden || lbSettling) return;
        if (e.button != null && e.button !== 0) return;
        e.preventDefault();
        try {
          stage.setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        moved = false;
        dragX = 0;
        if (pointers.size === 2) {
          pinchStartDist = dist() || 1;
          pinchStartScale = lbScale;
        } else if (pointers.size === 1) {
          panStartX = e.clientX;
          panStartY = e.clientY;
          panOriginX = lbX;
          panOriginY = lbY;
          startX = e.clientX;
          startY = e.clientY;
        }
      });

      stage.addEventListener(
        'pointermove',
        (e) => {
          if (!pointers.has(e.pointerId)) return;
          pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (pointers.size === 2 && pinchStartDist) {
            moved = true;
            const d = dist();
            setLightboxZoom(pinchStartScale * (d / pinchStartDist), e.clientX, e.clientY);
            return;
          }
          if (pointers.size !== 1) return;
          const dx = e.clientX - panStartX;
          const dy = e.clientY - panStartY;
          if (Math.hypot(dx, dy) > 8) moved = true;
          if (lbScale > 1.05) {
            lbX = panOriginX + dx;
            lbY = panOriginY + dy;
            applyLightboxTransform();
          } else if (canSwipe()) {
            dragX = dx;
            setTrackOffset(dx, false);
          }
        },
        { passive: true }
      );

      const endPointer = (e) => {
        if (!pointers.has(e.pointerId)) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        const wasSingle = pointers.size === 1;
        pointers.delete(e.pointerId);
        if (pointers.size < 2) pinchStartDist = 0;
        if (!wasSingle) return;

        if (canSwipe() && Math.abs(dx) > 56 && Math.abs(dx) > Math.abs(dy) * 1.15) {
          const delta = dx < 0 ? 1 : -1;
          stepLightbox(delta, true);
          dragX = 0;
          return;
        }

        // soltou sem trocar → snap de volta (com a vizinha voltando)
        if (lbScale <= 1.05 && lightboxGallery.length > 1 && Math.abs(dragX) > 2) {
          setTrackOffset(0, true);
          const track = $('commsLightboxTrack');
          let snapped = false;
          const done = (ev) => {
            if (snapped) return;
            if (ev && track && ev.target !== track) return;
            snapped = true;
            track?.removeEventListener('transitionend', done);
            resetTrack(true);
          };
          track?.addEventListener('transitionend', done);
          setTimeout(() => done(), 300);
        } else if (lbScale <= 1.05) {
          resetTrack(true);
        }

        dragX = 0;

        if (moved || Math.hypot(dx, dy) > 14) return;
        const now = Date.now();
        const near = Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY) < 40;
        if (now - lastTapAt < 420 && near) {
          if (lbScale > 1.2) resetLightboxZoom();
          else setLightboxZoom(2.6, e.clientX, e.clientY);
          lastTapAt = 0;
        } else {
          lastTapAt = now;
          lastTapX = e.clientX;
          lastTapY = e.clientY;
        }
      };

      stage.addEventListener('pointerup', endPointer);
      stage.addEventListener('pointercancel', (e) => {
        if (!pointers.has(e.pointerId)) return;
        pointers.delete(e.pointerId);
        pinchStartDist = 0;
        dragX = 0;
        if (lbScale <= 1.05) resetTrack(true);
      });
      stage.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    async function sendMessage({
      text = '',
      images = null,
      image = null,
      sticker = null,
      stickerCustom = null,
      voice = null,
      voiceMs = 0,
      voiceWave = null,
    } = {}) {
      if (!state.code || !state.peerId) return false;
      const list = Array.isArray(images) && images.length
        ? images.slice(0, MAX_PENDING)
        : image
          ? [image]
          : [];
      const payload = { peerId: state.peerId, text: String(text || '').trim() };
      if (list.length) payload.images = list;
      if (sticker) payload.sticker = sticker;
      if (stickerCustom) payload.stickerCustom = stickerCustom;
      if (voice) {
        payload.voice = voice;
        const ms = Number(voiceMs) || 0;
        if (ms > 0) payload.voiceMs = ms;
        const wave = normalizeVoiceWave(voiceWave, VOICE_WAVE_BARS);
        if (wave) payload.voiceWave = wave;
      }
      if (replyTo?.id) payload.replyTo = replyTo.id;
      if (!payload.text && !list.length && !payload.sticker && !payload.stickerCustom && !payload.voice) {
        return false;
      }

      /* gesto do TX — desbloqueia áudio pro pendingPlay do CD-R */
      Radio.unlockAudioGesture?.();

      clearTimeout(typingIdle);
      typingOn = false;
      clearReply();
      clearAttach();
      const input = $('commsInput');
      if (input) input.value = '';
      $('commsStickers').hidden = true;

      let r = await api(`/api/deck/comms/${state.code}/message`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (!r.ok && (r.rejoin || r.status === 403)) {
        const back = await tryRejoin();
        if (back) {
          r = await api(`/api/deck/comms/${state.code}/message`, {
            method: 'POST',
            body: JSON.stringify(payload),
          });
        }
      }
      if (r.ok) {
        (r.messages || []).forEach(pushMsg);
        if (r.message) pushMsg(r.message);
        if (typeof r.cdr === 'boolean') state.cdr = r.cdr;
        state.cdrTyping = !!r.cdrTyping;
        syncCdrUi();
        renderPeers(r.peers, r.slots);
        if (r.play) {
          if (r.play.kind !== 'stop') {
            const wasJoin = /^\/(junto|join|ouvir)\b/i.test(String(payload.text || ''));
            if (wasJoin) {
              const other = (r.peers || []).find(
                (p) => p.id !== state.peerId && !p.bot && p.listening?.title
              );
              state.alongWith = other?.id || null;
              refreshNowPlayingFromState();
            } else {
              state.alongWith = null;
            }
            state.alongTrackKey = Radio.trackKeyOf(r.play);
          } else {
            state.alongWith = null;
            state.alongTrackKey = '';
          }
          await Radio.apply(r.play);
          await postPresence();
        }
        keepCommsKeyboard();
        return true;
      }
      if (r?.error) notify(r.error);
      keepCommsKeyboard();
      return false;
    }

    function keepCommsKeyboard() {
      const input = $('commsInput');
      if (!input || !state.code || $('commsRoom')?.hidden) return;
      try {
        input.focus({ preventScroll: true });
      } catch {
        input.focus();
      }
      requestAnimationFrame(() => {
        try {
          input.focus({ preventScroll: true });
        } catch {
          input.focus();
        }
      });
    }

    function fileToDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('não deu pra ler o arquivo'));
        reader.readAsDataURL(file);
      });
    }

    function compressStickerImage(file) {
      return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
          URL.revokeObjectURL(url);
          const max = 512;
          let w = img.naturalWidth || img.width;
          let h = img.naturalHeight || img.height;
          if (!w || !h) {
            reject(new Error('imagem inválida'));
            return;
          }
          const scale = Math.min(1, max / Math.max(w, h));
          w = Math.max(1, Math.round(w * scale));
          h = Math.max(1, Math.round(h * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.clearRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          let out = '';
          try {
            out = canvas.toDataURL('image/webp', 0.88);
          } catch {
            out = '';
          }
          if (!out || out.length > 2500000) out = canvas.toDataURL('image/png');
          if (!out || out.length > 2500000) {
            reject(new Error('figurinha grande demais'));
            return;
          }
          resolve(out);
        };
        img.onerror = () => {
          URL.revokeObjectURL(url);
          reject(new Error('imagem inválida'));
        };
        img.src = url;
      });
    }

    async function prepareStickerFile(file) {
      if (!file) throw new Error('sem arquivo');
      const type = String(file.type || '').toLowerCase();
      const name = String(file.name || '').toLowerCase();
      const isGif = type === 'image/gif' || name.endsWith('.gif');
      const isVideo = type.startsWith('video/') || /\.(mp4|webm|mov)$/i.test(name);
      const isImage = type.startsWith('image/') && !isGif;

      if (isGif) {
        if (file.size > 1.8e6) throw new Error('gif grande demais (máx. ~1.8MB)');
        const data = await fileToDataUrl(file);
        if (data.length > 2500000) throw new Error('gif grande demais');
        return { data, kind: 'gif' };
      }

      if (isVideo) {
        if (file.size > 2.4e6) throw new Error('vídeo grande demais (máx. ~2.4MB)');
        const data = await new Promise((resolve, reject) => {
          const url = URL.createObjectURL(file);
          const v = document.createElement('video');
          v.preload = 'metadata';
          v.muted = true;
          v.playsInline = true;
          v.onloadedmetadata = async () => {
            const dur = Number(v.duration) || 0;
            if (!dur || dur > 5.05) {
              URL.revokeObjectURL(url);
              reject(new Error('vídeo máx. 5 segundos'));
              return;
            }
            try {
              const dataUrl = await fileToDataUrl(file);
              URL.revokeObjectURL(url);
              if (dataUrl.length > 2500000) {
                reject(new Error('vídeo grande demais'));
                return;
              }
              resolve(dataUrl);
            } catch (err) {
              URL.revokeObjectURL(url);
              reject(err);
            }
          };
          v.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('vídeo inválido'));
          };
          v.src = url;
        });
        return { data, kind: 'video' };
      }

      if (isImage) {
        const data = await compressStickerImage(file);
        return { data, kind: 'image' };
      }

      throw new Error('use imagem, gif ou vídeo (≤5s)');
    }

    function setStickerForgeProgress(pct, label) {
      const bar = $('commsStickerMakerBar');
      const lab = $('commsStickerMakerProgressLabel');
      if (bar) bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
      if (lab && label) lab.textContent = label;
    }

    function showStickerForge(on) {
      const card = $('commsStickerMaker')?.querySelector('.comms-sticker-maker-card');
      const prog = $('commsStickerMakerProgress');
      if (card) card.classList.toggle('is-forging', !!on);
      if (prog) prog.hidden = !on;
      if (!on) setStickerForgeProgress(0, 'criando figurinha…');
    }

    function wait(ms) {
      return new Promise((r) => setTimeout(r, ms));
    }

    function closeStickerMaker() {
      const box = $('commsStickerMaker');
      if (box) box.hidden = true;
      stickerDraft = null;
      showStickerForge(false);
      const prev = $('commsStickerMakerPreview');
      if (prev) {
        prev.hidden = true;
        prev.innerHTML = '';
      }
      if ($('commsStickerMakerFile')) $('commsStickerMakerFile').value = '';
      if ($('commsStickerMakerDesc')) $('commsStickerMakerDesc').value = '';
      if ($('commsStickerMakerSave')) $('commsStickerMakerSave').disabled = true;
    }

    function openStickerMaker() {
      const box = $('commsStickerMaker');
      if (!box) return;
      if ($('commsStickerMakerSign')) {
        $('commsStickerMakerSign').textContent = state.name || callsign(false) || 'anon';
      }
      showStickerForge(false);
      $('commsStickers').hidden = true;
      box.hidden = false;
    }

    function showStickerInfo(meta) {
      const box = $('commsStickerInfo');
      const prev = $('commsStickerInfoPreview');
      if (!box || !prev || !meta?.src) return;
      const src = safeStickerSrc(meta.src);
      if (!src) return;
      // fora do .rig pra position:fixed não quebrar no mobile
      if (box.parentElement !== document.body) {
        document.body.appendChild(box);
      }
      prev.innerHTML =
        meta.kind === 'video'
          ? `<video src="${escapeHtml(src)}" autoplay loop muted playsinline></video>`
          : `<img src="${escapeHtml(src)}" alt="" />`;
      if ($('commsStickerInfoCreator')) {
        $('commsStickerInfoCreator').textContent = meta.creator || 'anon';
      }
      if ($('commsStickerInfoDesc')) {
        $('commsStickerInfoDesc').textContent = meta.description || 'sem descrição';
      }
      box.hidden = false;
    }

    function hideStickerInfo() {
      const box = $('commsStickerInfo');
      if (box) box.hidden = true;
      const prev = $('commsStickerInfoPreview');
      if (prev) prev.innerHTML = '';
    }

    let holdTimer = null;
    let holdMsgEl = null;
    let popMsg = null;

    function hideReactPop() {
      const pop = $('commsReactPop');
      if (pop) pop.hidden = true;
      document.querySelectorAll('.comms-msg.holding').forEach((el) => el.classList.remove('holding'));
      holdMsgEl = null;
      popMsg = null;
    }

    function openReactPop(msgEl) {
      const pop = $('commsReactPop');
      if (!pop || !msgEl) return;
      // fora do .rig (animation/transform quebra position:fixed)
      if (pop.parentElement !== document.body) {
        document.body.appendChild(pop);
      }
      popMsg = msgEl._msg || {
        id: msgEl.dataset.id,
        name: msgEl.querySelector('.who-name')?.textContent?.trim() ||
          msgEl.querySelector('.who')?.textContent?.split('·')[0]?.trim() ||
          '…',
        text: msgEl.querySelector('.comms-body')?.textContent || '',
      };
      holdMsgEl = msgEl;
      document.querySelectorAll('.comms-msg.holding').forEach((el) => el.classList.remove('holding'));
      msgEl.classList.add('holding');
      pop.hidden = false;

      const place = () => {
        const msgRect = msgEl.getBoundingClientRect();
        const pr = pop.getBoundingClientRect();
        const pad = 10;
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        let left = msgRect.left + msgRect.width / 2 - pr.width / 2;
        let top = msgRect.bottom + 8;

        left = Math.max(pad, Math.min(left, vw - pr.width - pad));
        if (top + pr.height > vh - pad) {
          top = Math.max(pad, msgRect.top - pr.height - 8);
        }

        pop.style.left = `${Math.round(left)}px`;
        pop.style.top = `${Math.round(top)}px`;
      };

      // mede depois de pintar
      pop.style.left = '0px';
      pop.style.top = '0px';
      requestAnimationFrame(() => {
        place();
        requestAnimationFrame(place);
      });
      if (navigator.vibrate) navigator.vibrate(12);
    }

    function clearHold() {
      if (holdTimer) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }
    }

    function resetSwipe(el) {
      if (!el) return;
      el.classList.remove('swiping', 'swipe-armed');
      el.style.transform = '';
    }

    function bindHold(feed) {
      if (!feed || feed._holdBound) return;
      feed._holdBound = true;
      let startX = 0;
      let startY = 0;
      let msgEl = null;
      let mode = null; // null | hold | swipe | scroll
      let drag = 0;
      let armed = false;
      let activePointer = null;
      const SWIPE_MAX = 72;
      const SWIPE_ARM = 52;

      const endPointer = (commit) => {
        if (!msgEl && !mode) return;
        clearHold();
        if (mode === 'swipe' && msgEl) {
          const shouldReply = commit && armed && msgEl._msg;
          if (shouldReply) {
            setReply(msgEl._msg);
            if (navigator.vibrate) navigator.vibrate(10);
          }
          resetSwipe(msgEl);
        }
        mode = null;
        msgEl = null;
        drag = 0;
        armed = false;
        activePointer = null;
      };

      const onDown = (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        const el = e.target.closest('.comms-msg[data-id]');
        if (!el || el.classList.contains('sys')) return;
        if (e.target.closest('.comms-react-pop')) return;
        if (e.target.closest('[data-react-chip]')) return;
        if (e.target.closest('.comms-msg-face')) return;
        if (e.target.closest('.comms-voice')) return;
        if (e.target.closest('.comms-pl-copy')) return;
        if (e.target.closest('.comms-join-here')) return;
        msgEl = el;
        mode = null;
        drag = 0;
        armed = false;
        activePointer = e.pointerId;
        startX = e.clientX;
        startY = e.clientY;
        clearHold();
        holdTimer = setTimeout(() => {
          if (!msgEl || mode === 'swipe' || mode === 'scroll') return;
          holdTimer = null;
          mode = 'hold';
          openReactPop(msgEl);
        }, 420);
      };

      const onMove = (e) => {
        if (!msgEl || activePointer !== e.pointerId) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        if (!mode) {
          if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.15) {
            clearHold();
            hideReactPop();
            mode = 'swipe';
            msgEl.classList.add('swiping');
            try {
              feed.setPointerCapture(e.pointerId);
            } catch {
              /* ignore */
            }
          } else if (Math.abs(dy) > 10) {
            clearHold();
            mode = 'scroll';
            return;
          } else {
            return;
          }
        }

        if (mode !== 'swipe') return;

        // them → direita; me → esquerda (estilo Zap)
        const isMe = msgEl.classList.contains('me');
        const raw = isMe ? Math.min(0, dx) : Math.max(0, dx);
        drag = Math.max(-SWIPE_MAX, Math.min(SWIPE_MAX, raw));
        msgEl.style.transform = `translateX(${drag}px)`;
        const nowArmed = Math.abs(drag) >= SWIPE_ARM;
        if (nowArmed && !armed && navigator.vibrate) navigator.vibrate(8);
        armed = nowArmed;
        msgEl.classList.toggle('swipe-armed', armed);
        e.preventDefault();
      };

      const onUp = (e) => {
        if (activePointer != null && e.pointerId !== activePointer) return;
        endPointer(true);
      };
      const onCancel = (e) => {
        if (activePointer != null && e.pointerId !== activePointer) return;
        endPointer(false);
      };

      feed.addEventListener('pointerdown', onDown);
      feed.addEventListener('pointermove', onMove, { passive: false });
      feed.addEventListener('pointerup', onUp);
      feed.addEventListener('pointercancel', onCancel);
      feed.addEventListener('contextmenu', (e) => {
        const el = e.target.closest('.comms-msg[data-id]');
        if (!el || el.classList.contains('sys')) return;
        e.preventDefault();
        openReactPop(el);
      });
    }

    function messageCopyText(m, msgEl) {
      const fromDom = msgEl?.querySelector('.comms-body')?.innerText?.trim();
      if (fromDom) return fromDom;
      const raw = String(m?.text || '')
        .replace(/\[\[JOIN:[^\]]+\]\]/gi, 'clica aqui')
        .trim();
      if (raw) return raw;
      if (m?.sticker || m?.stickerCustom) return '';
      if (m?.voice) return '';
      const nImg = Array.isArray(m?.images) ? m.images.length : m?.image ? 1 : 0;
      if (nImg) return '';
      return '';
    }

    async function copyText(text, okLabel) {
      try {
        await navigator.clipboard.writeText(text);
        if (okLabel) notify(okLabel);
        return true;
      } catch {
        /* fallback antigo */
        try {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.setAttribute('readonly', '');
          ta.style.position = 'fixed';
          ta.style.left = '-9999px';
          document.body.appendChild(ta);
          ta.select();
          const ok = document.execCommand('copy');
          document.body.removeChild(ta);
          if (ok && okLabel) notify(okLabel);
          return ok;
        } catch {
          notify('não deu pra copiar');
          return false;
        }
      }
    }

    function humanPeers(peers) {
      return (peers || []).filter(
        (p) => !p.bot && p.seat !== 'CDR' && p.id !== 'cdr'
      );
    }

    function syncCdrUi() {
      const input = $('commsInput');
      if (!input) return;
      if (state.cdr) {
    input.placeholder = 'msg… /pro CD-R · pede música no papo';
      } else {
        input.placeholder = 'msg… /music · /yt · /comando';
      }
    }

    let peersRenderKey = '';

    function renderPeers(peers, slots) {
      const el = $('commsPeers');
      if (!el) return;
      state._lastPeers = peers || [];
      const humans = humanPeers(peers);
      const others = humans.filter((p) => p.id !== state.peerId);
      const me = escapeHtml(state.name || 'você');
      const max = Math.max(
        2,
        Math.min(10, Number(slots?.max || state.slotsMax || 2) || 2)
      );
      const used = Math.max(humans.length, Number(slots?.used || humans.length) || 1);
      state.slotsMax = max;
      state.slotsUsed = used;
      const cdrMark = state.cdr
        ? `<span class="peer-cdr" title="CD-R no canal">· CD-R</span>`
        : '';

      const map = {};
      const mapMeta = {};
      const alongMap = {};
      for (const p of humans) {
        if (p?.id && p.alongWith) {
          alongMap[p.id] = String(p.alongWith);
        }
        if (p?.id && p.listening?.title) {
          const L = p.listening;
          const kind =
            L.kind === 'spotify' || L.uri
              ? 'spotify'
              : L.videoId || L.kind === 'yt'
                ? 'yt'
                : 'album';
          map[p.id] = {
            title: String(L.title).slice(0, 140),
            kind,
            id: L.id ? String(L.id) : undefined,
            videoId: L.videoId ? String(L.videoId) : undefined,
            uri: L.uri ? String(L.uri) : undefined,
            pos: typeof L.pos === 'number' ? L.pos : undefined,
            posAt: typeof L.posAt === 'number' ? L.posAt : undefined,
          };
          mapMeta[p.id] = {
            title: map[p.id].title,
            kind: map[p.id].kind,
            id: map[p.id].id,
            videoId: map[p.id].videoId,
            uri: map[p.id].uri,
          };
        }
      }
      const listenKey =
        JSON.stringify(mapMeta) +
        `|along:${state.alongWith || ''}` +
        `|by:${JSON.stringify(alongMap)}`;
      state.listeningByPeer = map;
      state.alongByPeer = alongMap;
      if (listenKey !== state.listeningKey) {
        state.listeningKey = listenKey;
        syncAlongIfNeeded();
      } else {
        syncAlongClock();
      }
      /* sempre redesenha o now-playing: alongWith / botão se juntar↔sair */
      renderNowPlaying(humans);

      const show = others.slice(0, 2);
      const extra = Math.max(0, others.length - show.length);
      const anyAway = others.some((p) => p.online === false);
      const parts = [`<b class="peer-name">${me}</b>`];
      if (!others.length) {
        parts.push(`<span class="peer-x" aria-hidden="true">/</span>`);
        parts.push(`<span class="peer-name ghost">?</span>`);
      } else {
        for (const them of show) {
          parts.push(`<span class="peer-x" aria-hidden="true">/</span>`);
          parts.push(`<b class="peer-name">${escapeHtml(them.name || 'ghost')}</b>`);
        }
        if (extra > 0) {
          parts.push(`<span class="peer-more" title="${others
            .slice(2)
            .map((p) => p.name || 'ghost')
            .join(', ')}">+${extra}</span>`);
        }
      }
      const pairClass = !others.length ? 'solo' : anyAway ? 'away' : 'live';
      const html =
        `<span class="peer-pair ${pairClass}">` + parts.join('') + `</span>${cdrMark}`;
      let pill = `COMMS · ${used}/${max}`;
      if (state.cdr) pill += ' · CD-R';
      else if (others.length && !anyAway) pill += ' LIVE';
      else if (others.length && anyAway) pill += ' AWAY';

      const key = html + '|' + pill;
      if (key !== peersRenderKey) {
        peersRenderKey = key;
        el.innerHTML = html;
        $('netPill').textContent = pill;
      }
      setTypingUi(peers);
    }

    function ensureTypingEl() {
      const feed = $('commsFeed');
      if (!feed) return null;
      let el = $('commsTyping');
      if (!el) {
        el = document.createElement('div');
        el.id = 'commsTyping';
        el.className = 'comms-typing';
        el.hidden = true;
        el.setAttribute('aria-live', 'polite');
      }
      if (el.parentElement !== feed || feed.lastElementChild !== el) {
        feed.appendChild(el);
      }
      return el;
    }

    function setTypingUi(peers) {
      const el = ensureTypingEl();
      if (!el) return;
      const near = isFeedNearBottom(120);
      const humans = humanPeers(peers).filter((p) => p.id !== state.peerId);
      const recording = humans.filter((p) => p.recording);
      const typing = humans.filter((p) => p.typing && !p.recording);
      const micSvg =
        `<svg class="comms-recording-mic" viewBox="0 0 24 24" aria-hidden="true" focusable="false">` +
          `<rect x="9" y="3.5" width="6" height="11" rx="3" fill="none" stroke="currentColor" stroke-width="1.75"/>` +
          `<path d="M6.5 11.5a5.5 5.5 0 0 0 11 0" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>` +
          `<path d="M12 17v3.2M9 20.2h6" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>` +
        `</svg>`;
      const rows = [
        ...recording.map((p) => {
          const name = p.name || 'ghost';
          rememberPeerFace(p.id, p);
          return (
            `<div class="comms-typing-row is-recording" data-peer="${escapeHtml(p.id)}">` +
              `<span class="comms-msg-aside">` +
                `<b class="who-name">${escapeHtml(name)}</b>` +
                `${msgFaceHtml(p.id, name)}` +
              `</span>` +
              `<div class="comms-msg them comms-typing-bubble comms-recording-bubble" aria-label="${escapeHtml(name)} gravando áudio">` +
                `<span class="comms-recording-pulse" aria-hidden="true"></span>` +
                `${micSvg}` +
                `<em class="comms-recording-label">gravando áudio…</em>` +
              `</div>` +
            `</div>`
          );
        }),
        ...typing.map((p) => {
          const name = p.name || 'ghost';
          rememberPeerFace(p.id, p);
          return (
            `<div class="comms-typing-row" data-peer="${escapeHtml(p.id)}">` +
              `<span class="comms-msg-aside">` +
                `<b class="who-name">${escapeHtml(name)}</b>` +
                `${msgFaceHtml(p.id, name)}` +
              `</span>` +
              `<div class="comms-msg them comms-typing-bubble" aria-label="${escapeHtml(name)} digitando">` +
                `<span class="comms-typing-dots" aria-hidden="true"><i></i><i></i><i></i></span>` +
              `</div>` +
            `</div>`
          );
        }),
      ];
      if (state.cdrTyping) {
        rows.push(
          `<div class="comms-typing-row bot" data-peer="cdr">` +
            `<span class="comms-msg-aside">` +
              `<b class="who-name">CD-R</b>` +
              `${msgFaceHtml('cdr', 'CD-R')}` +
            `</span>` +
            `<div class="comms-msg bot comms-typing-bubble" aria-label="CD-R digitando">` +
              `<span class="comms-typing-dots" aria-hidden="true"><i></i><i></i><i></i></span>` +
            `</div>` +
          `</div>`
        );
      }
      if (!rows.length) {
        el.hidden = true;
        el.innerHTML = '';
        return;
      }
      el.hidden = false;
      el.innerHTML = rows.join('');
      if (near) scrollFeedToEnd(true);
    }

    function pushMsg(m) {
      if (!m?.id) return;
      bumpAfter(m);
      const feed = $('commsFeed');
      if (!feed) return;
      const near = isFeedNearBottom();
      const mine = !m.sys && m.peerId === state.peerId;

      if (m.sys) {
        if (state.known.has(m.id)) return;
        state.known.add(m.id);
        const el = document.createElement('div');
        el.className = 'comms-msg sys';
        el.dataset.id = m.id;
        el.textContent = m.text;
        feed.appendChild(el);
        restackMsgFaces();
        if (near) scrollFeedToEnd(true);
        else showNewMsgHint();
        return;
      }

      let el = feed.querySelector(`[data-id="${(window.CSS && CSS.escape) ? CSS.escape(m.id) : String(m.id).replace(/"/g, '')}"]`);
      if (el) {
        fillMsgEl(el, m);
        restackMsgFaces();
        if (mine || near) scrollFeedForMedia(el);
        return;
      }
      state.known.add(m.id);
      el = document.createElement('div');
      fillMsgEl(el, m);
      feed.appendChild(el);
      ensureTypingEl();
      restackMsgFaces();
      if (mine || near) scrollFeedForMedia(el);
      else showNewMsgHint();
    }

    async function reactTo(msgId, emoji) {
      if (!state.code || !state.peerId) return;
      const r = await api(`/api/deck/comms/${state.code}/react`, {
        method: 'POST',
        body: JSON.stringify({ peerId: state.peerId, msgId, emoji }),
      });
      if (r.ok && r.message) {
        pushMsg(r.message);
        return;
      }
      if (r?.error) notify(r.error);
    }

      async function postPresence(extra = {}) {
      if (!state.code || !state.peerId) return null;
      const body = {
          peerId: state.peerId,
          name: state.name,
          after: state.after,
          typing: typingOn,
          recording: recordingOn,
          ...extra,
      };
      if (avatarDirty && !('avatar' in extra)) {
        body.avatar = avatarPayload();
      }
      /* host e quem se juntou publicam posição pra sync simultâneo */
      if (!('listening' in extra)) {
        const snap = Radio.listeningSnapshot();
        if (snap) body.listening = snap;
      }
      const r = await api(`/api/deck/comms/${state.code}/presence`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (r?.ok && ('avatar' in body)) {
        const me = (r.peers || []).find((p) => p.id === state.peerId);
        avatarDirty = !(me && (me.avatarUrl || me.avatarAt));
        if (me) rememberPeerFace(state.peerId, me);
      }
      return r;
    }

    async function tryRejoin() {
      if (!state.code) return null;
      const r = await api('/api/deck/comms/join', {
        method: 'POST',
        body: JSON.stringify({
          code: state.code,
          name: state.name || callsign() || loadSaved().name || 'ghost',
          peerId: state.peerId || loadSaved().peerId,
          avatar: avatarPayload(),
        }),
      });
      if (!r?.ok) return null;
      state.peerId = r.peerId;
      state.name = r.name;
      state.seat = r.seat;
      const me = (r.peers || []).find((p) => p.id === r.peerId);
      avatarDirty = !(me && (me.avatarUrl || me.avatarAt)) && !!localAvatar;
      if (me) rememberPeerFace(r.peerId, me);
      seedOwnAvatarCache();
      save();
      return r;
    }

    async function tryRejoinWithRetry(attempts = 5) {
      let last = null;
      for (let i = 0; i < attempts; i += 1) {
        last = await tryRejoin();
        if (last) return last;
        await sleep(350 * (i + 1));
      }
      return null;
    }

    function keepSessionOnDisk(forceCode) {
      const prev = loadSaved();
      const code = forceCode || state.code || prev.code || prev.lastCode || null;
      localStorage.setItem(
        storeKey,
        JSON.stringify({
          peerId: state.peerId || prev.peerId,
          name: state.name || prev.name,
          // mantém o código pra reconectar no próximo reload
          code,
          seat: state.seat || prev.seat || '',
          lastCode: code || prev.lastCode || null,
        })
      );
    }

    async function dropToLobbySoft(hint) {
      stopPoll();
      const code = state.code || loadSaved().code || loadSaved().lastCode;
      state.code = null;
      keepSessionOnDisk(code);
      showLobby();
      if (hint && $('commsLobbyHint')) $('commsLobbyHint').textContent = hint;
      if (code && $('commsJoinCode') && !$('commsJoinCode').value) {
        $('commsJoinCode').value = code;
      }
      refreshResumeUi();
      refreshInviteUi();
    }

    async function setTyping(on) {
      if (!state.code || !state.peerId) return;
      if (on && recordingOn) return;
      if (typingOn === on) return;
      typingOn = on;
      if (typingPosting) return;
      typingPosting = true;
      try {
        const r = await postPresence({ typing: on });
        if (r?.ok) {
          (r.messages || []).forEach(pushMsg);
          if (typeof r.cdr === 'boolean') state.cdr = r.cdr;
          state.cdrTyping = !!r.cdrTyping;
          renderPeers(r.peers, r.slots);
        }
      } catch {
        /* ignore */
      } finally {
        typingPosting = false;
      }
    }

    async function setRecording(on) {
      if (!state.code || !state.peerId) return;
      if (recordingOn === on) return;
      recordingOn = on;
      if (on) {
        clearTimeout(typingIdle);
        typingOn = false;
      }
      if (recordingKeepalive) {
        clearInterval(recordingKeepalive);
        recordingKeepalive = null;
      }
      if (on) {
        recordingKeepalive = setInterval(() => {
          if (!recordingOn) return;
          postPresence({ recording: true }).catch(() => {});
        }, 2500);
      }
      if (recordingPosting) return;
      recordingPosting = true;
      try {
        const r = await postPresence({ recording: on, typing: false });
        if (r?.ok) {
          (r.messages || []).forEach(pushMsg);
          if (typeof r.cdr === 'boolean') state.cdr = r.cdr;
          state.cdrTyping = !!r.cdrTyping;
          renderPeers(r.peers, r.slots);
        }
      } catch {
        /* ignore */
      } finally {
        recordingPosting = false;
      }
    }

    function onLocalType() {
      const has = !!$('commsInput')?.value.trim();
      if (!has) {
        clearTimeout(typingIdle);
        setTyping(false);
        return;
      }
      setTyping(true);
      clearTimeout(typingIdle);
      typingIdle = setTimeout(() => setTyping(false), 2200);
    }

    let leaveMusicHold = null; /* { code, trackKey, preferPeerId } */

    function pickRejoinSyncPeer(peers, hold) {
      const humans = (peers || []).filter(
        (p) => p?.id && p.id !== state.peerId && !p.bot && p.listening?.title
      );
      if (!humans.length) return null;
      if (hold?.preferPeerId) {
        const pref = humans.find((p) => p.id === hold.preferPeerId);
        if (pref) return pref;
      }
      if (hold?.trackKey) {
        const same = humans.find((p) => listeningTrackKey(p.listening) === hold.trackKey);
        if (same) return same;
      }
      return null;
    }

    async function resumeAfterLeaveHold(peers) {
      const hold = leaveMusicHold;
      leaveMusicHold = null;
      if (!hold?.code || hold.code !== state.code) return;
      try {
        const syncPeer = pickRejoinSyncPeer(peers, hold);
        if (syncPeer) {
          await listenAlong(syncPeer.id);
          return;
        }
        const ok = await Radio.resumeLast();
        if (ok) {
          notify(`♪ retomou · ${Radio.getActive()?.title || 'play'}`);
          refreshNowPlayingFromState();
          postPresence().catch(() => {});
        }
      } catch {
        /* ignore */
      }
    }

    async function enterRoom(payload) {
      state.code = payload.code;
      state.peerId = payload.peerId;
      state.name = payload.name;
      pendingInvite = null;
      state.seat = payload.seat;
      state.cdr = !!payload.cdr;
      state.cdrTyping = !!payload.cdrTyping;
      state.slotsMax = Math.max(2, Math.min(10, Number(payload.slots?.max || payload.maxPeers || 2) || 2));
      state.slotsUsed = Number(payload.slots?.used || 1) || 1;
      state.listeningByPeer = {};
      state.listeningKey = '';
      state.alongWith = null;
      state.alongTrackKey = '';
      state.after = 0;
      state.known = new Set();
      typingOn = false;
      seedOwnAvatarCache();
      if (localAvatar) avatarDirty = true;
      clearReply();
      clearAttach();
      showQr(false);
      $('commsStickers') && ($('commsStickers').hidden = true);
      $('commsFeed').innerHTML = '';
      hideNewMsgHint();
      ensureTypingEl();
      setTypingUi([]);
      save();
      showRoom();
      syncRoomProfileUi();
      applyVisualToRoom(visualApplied);
      syncPeerAvatars(payload.peers || []);
      if (payload.visual) syncRoomVisual(payload.visual);
      else if (payload.wallpaper) {
        /* compat com sala que só tinha wallpaper */
        syncRoomVisual({
          ...payload.wallpaper,
          hasWall: true,
          theme: visualApplied.theme,
          bubbleMe: visualApplied.bubbleMe,
          bubbleThem: visualApplied.bubbleThem,
        });
      } else {
        roomVisual = null;
        roomWallData = null;
        roomVisualFetchAt = 0;
        applyWallpaperLayers(visualApplied);
      }
      refreshResumeUi();
      syncCdrUi();
      peersRenderKey = '';
      (payload.messages || []).forEach(pushMsg);
      renderPeers(payload.peers, payload.slots);
      startPoll();
      await resumeAfterLeaveHold(payload.peers);
    }

    async function poll() {
      if (!state.code || !state.peerId) return;
      try {
        const presenceExtra = VoiceCall.inCall
          ? { callMuted: !!VoiceCall.isMuted() }
          : {};
        let r = await postPresence(presenceExtra);
        if (r && !r.ok && (r.rejoin || r.status === 403 || /peer|canal/i.test(String(r.error || '')))) {
          const back = await tryRejoin();
          if (back) {
            if (typeof back.cdr === 'boolean') state.cdr = back.cdr;
            state.cdrTyping = !!back.cdrTyping;
            syncCdrUi();
            (back.messages || []).forEach(pushMsg);
            renderPeers(back.peers, back.slots);
            r = await postPresence();
          }
        }
        if (!r || !r.ok) {
          // 404 = canal realmente morto; tenta rejoin antes de desistir
          if (r && (r.status === 404 || /offline|não encontrado/i.test(String(r.error || '')))) {
            const back = await tryRejoinWithRetry(3);
            if (back) {
              await enterRoom(back);
              return;
            }
            if (activeTab) {
              await dropToLobbySoft(r?.error || 'canal caiu — tenta voltar pelo código');
            } else {
              keepSessionOnDisk();
          stopPoll();
          state.code = null;
            }
          }
          return;
        }
        (r.messages || []).forEach(pushMsg);
        if (typeof r.cdr === 'boolean') state.cdr = r.cdr;
        state.cdrTyping = !!r.cdrTyping;
        syncCdrUi();
        renderPeers(r.peers, r.slots);
        syncPeerAvatars([...(r.peers || []), ...(r.call?.people || [])]);
        applyPlaySync(r.playSync);
        if (r.visual?.at !== roomVisualFetchAt) {
          syncRoomVisual(r.visual || null);
        } else if (!r.visual && r.wallpaper?.at !== roomVisualFetchAt) {
          syncRoomVisual(
            r.wallpaper
              ? {
                  ...r.wallpaper,
                  hasWall: true,
                  theme: visualApplied.theme,
                  bubbleMe: visualApplied.bubbleMe,
                  bubbleThem: visualApplied.bubbleThem,
                }
              : null
          );
        }
        if (r.pendingPlay?.kind) {
          if (r.pendingPlay.kind !== 'stop') {
            state.alongWith = null;
            state.alongTrackKey = Radio.trackKeyOf(r.pendingPlay);
          } else {
            state.alongWith = null;
            state.alongTrackKey = '';
          }
          await Radio.apply(r.pendingPlay);
          Radio.ensurePlaybackAudible?.();
          await postPresence();
        }
        try {
          await VoiceCall.onPresence(r);
        } catch {
          /* ignore */
        }
      } catch {
        /* ignore transient */
      }
    }

    function startPoll() {
      stopPoll();
      const loop = () => {
        if (!state.code) return;
        const ms = VoiceCall?.inCall ? 400 : activeTab ? 1000 : 4000;
        pollTimer = setTimeout(async () => {
          try {
            await poll();
          } catch {
            /* ignore */
          }
          loop();
        }, ms);
      };
      poll();
      loop();
    }

    function stopPoll() {
      if (pollTimer) {
        clearTimeout(pollTimer);
        clearInterval(pollTimer);
      }
      pollTimer = null;
    }

    function callsign(required = false) {
      const n = $('commsName').value.trim().slice(0, 24);
      if (required && !n) {
        $('commsLobbyHint').textContent = 'username obrigatório';
        const input = $('commsName');
        if (input) {
          input.classList.remove('comms-need-nick');
          void input.offsetWidth;
          input.classList.add('comms-need-nick');
          input.focus();
          setTimeout(() => input.classList.remove('comms-need-nick'), 600);
        }
        notify('username obrigatório — digita um nick pra criar ou entrar no canal');
        return null;
      }
      if (n) $('commsName').value = n;
      return n || null;
    }

    async function create() {
      const name = callsign(true);
      if (!name) return;
      $('commsLobbyHint').textContent = 'abrindo canal…';
      const cdr = !!$('commsAddCdr')?.checked;
      const maxPeers = Math.max(
        2,
        Math.min(10, Number($('commsMaxPeers')?.value || 4) || 4)
      );
      const r = await api('/api/deck/comms/create', {
        method: 'POST',
        body: JSON.stringify({
          name,
          peerId: loadSaved().peerId,
          cdr,
          maxPeers,
          avatar: avatarPayload(),
        }),
      });
      if (!r.ok) {
        $('commsLobbyHint').textContent = r.error || 'falha';
        return;
      }
      const me = (r.peers || []).find((p) => p.peerId === r.peerId || p.id === r.peerId);
      avatarDirty = !(me && (me.avatarUrl || me.avatarAt)) && !!localAvatar;
      if (me) rememberPeerFace(r.peerId, me);
      await enterRoom(r);
      $('commsLobbyHint').textContent = cdr
        ? `canal aberto · até ${maxPeers} · CD-R no ar`
        : `canal aberto · até ${maxPeers} pessoas`;
    }

    async function join() {
      const name = callsign(true);
      if (!name) return;
      const code = $('commsJoinCode').value.trim().toUpperCase();
      if (!code) {
        $('commsLobbyHint').textContent = 'digite o código';
        return;
      }
      $('commsLobbyHint').textContent = 'entrando…';
      const r = await api('/api/deck/comms/join', {
        method: 'POST',
        body: JSON.stringify({
          code,
          name,
          peerId: loadSaved().peerId,
          avatar: avatarPayload(),
        }),
      });
      if (!r.ok) {
        $('commsLobbyHint').textContent = r.error || 'falha';
        return;
      }
      const me = (r.peers || []).find((p) => p.id === r.peerId);
      avatarDirty = !(me && (me.avatarUrl || me.avatarAt)) && !!localAvatar;
      if (me) rememberPeerFace(r.peerId, me);
      await enterRoom(r);
    }

    /* —— ligação de voz (WebRTC mesh + sinal no poll) —— */
    const VoiceCall = (() => {
      const ICE = {
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
          { urls: "stun:stun.metered.ca:80" },
          /* TURN: celular (4G/NAT) ↔ PC (Wi‑Fi) precisa de relay */
          {
            urls: [
              "turn:openrelay.metered.ca:80",
              "turn:openrelay.metered.ca:80?transport=tcp",
              "turn:openrelay.metered.ca:443",
              "turns:openrelay.metered.ca:443",
            ],
            username: "openrelayproject",
            credential: "openrelayproject",
          },
        ],
      };
      let localStream = null;
      let pcs = new Map();
      let remotes = new Map();
      let remoteGraphs = new Map(); /* fallback WebAudio no desktop */
      let muted = false;
      let inCall = false;
      let callId = "";
      let callHostId = "";
      let lastCall = null;
      let callStartedAt = 0;
      let tickTimer = null;
      let ringingShownFor = "";
      let pendingStart = false;
      let vibeTimer = null;
      let ignoredCallId = "";
      let remotePlayTimer = null;
      let meshTail = Promise.resolve();
      let callAudioCtx = null;
      let callSyncing = false;
      let callSyncGen = 0;
      let speakMeters = new Map(); /* peerId -> { analyser, source, data } */
      let speakRaf = 0;
      let speakingIds = new Set();
      const SPEAK_RMS = 0.045;
      const SILENT_WAV =
        "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA==";

      function isAppleMobile() {
        return (
          /iPad|iPhone|iPod/i.test(navigator.userAgent || "") ||
          (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
        );
      }

      function micErrorMessage(err) {
        const name = String(err?.name || "");
        if (name === "NotAllowedError" || name === "PermissionDeniedError") {
          return "libera o microfone nas configurações do navegador";
        }
        if (name === "NotFoundError" || name === "DevicesNotFoundError") {
          return "nenhum microfone encontrado";
        }
        if (name === "NotReadableError" || name === "TrackStartError") {
          return "microfone ocupado por outro app — fecha e tenta de novo";
        }
        if (/https|secure|mediaDevices/i.test(String(err?.message || ""))) {
          return "microfone precisa de HTTPS no celular";
        }
        return "não rolou abrir o microfone";
      }

      const MIC_ON_SVG =
        '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.49 6-3.31 6-6.72h-1.7z"/></svg>';
      const MIC_OFF_SVG =
        '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S8 3.34 8 5v.18l5.98 5.99zM4.27 3 3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/></svg>';

      function showTip(show) {
        const tip = $("commsCallTip");
        if (!tip) return;
        tip.hidden = !show;
        tip.classList.toggle("on", !!show);
      }

      function setBubble(show, text, actions) {
        const bubble = $("commsCallBubble");
        const actionsEl = $("commsCallBubbleActions");
        if (!bubble) return;
        bubble.hidden = !show;
        if ($("commsCallBubbleText") && text != null) {
          $("commsCallBubbleText").textContent = text;
        }
        if (actionsEl) actionsEl.hidden = !actions;
      }

      function setPhoneUi({ on, ringing }) {
        const btn = $("commsCallBtn");
        if (!btn) return;
        btn.classList.toggle("on", !!on && !ringing);
        btn.classList.toggle("ringing", !!ringing);
        btn.setAttribute("aria-pressed", on || ringing ? "true" : "false");
      }

      function clearVibe() {
        if (vibeTimer) clearInterval(vibeTimer);
        vibeTimer = null;
      }

      function startVibe() {
        clearVibe();
        if (navigator.vibrate) navigator.vibrate([100, 70, 100]);
        vibeTimer = setInterval(() => {
          if (navigator.vibrate) navigator.vibrate([90, 60, 90]);
        }, 2200);
      }

      function uiBar(show, label) {
        const bar = $("commsCallBar");
        if (bar) bar.hidden = !show;
        if (label && $("commsCallLabel")) $("commsCallLabel").textContent = label;
        if (!show) {
          const people = $("commsCallPeople");
          if (people) people.innerHTML = "";
          hideCallSync();
        }
      }

      function setCallSync(show, text, step) {
        const el = $("commsCallSync");
        if (!el) return;
        el.hidden = !show;
        el.setAttribute("aria-busy", show ? "true" : "false");
        if (text && $("commsCallSyncText")) $("commsCallSyncText").textContent = text;
        el.querySelectorAll("[data-sync-step]").forEach((n) => {
          const s = Number(n.getAttribute("data-sync-step"));
          n.classList.toggle("done", show && s < step);
          n.classList.toggle("active", show && s === step);
        });
      }

      function hideCallSync() {
        callSyncing = false;
        callSyncGen += 1;
        setCallSync(false, "", 0);
      }

      function anyPeerLive() {
        for (const pc of pcs.values()) {
          const cs = pc.connectionState;
          const ice = pc.iceConnectionState;
          if (cs === "connected" || cs === "completed") return true;
          if (ice === "connected" || ice === "completed") return true;
        }
        return false;
      }

      function sleep(ms) {
        return new Promise((r) => setTimeout(r, ms));
      }

      /** overlay de sync — espera conexão + tempo mínimo pra não bugarem áudio */
      async function runCallSync({ expectPeers = true } = {}) {
        const gen = ++callSyncGen;
        callSyncing = true;
        setCallSync(true, "abrindo microfone…", 1);
        await unlockCallPlayback();
        if (gen !== callSyncGen || !inCall) return;

        setCallSync(true, expectPeers ? "montando conexão…" : "preparando chamada…", 2);
        await sleep(500);
        if (gen !== callSyncGen || !inCall) return;
        const started = Date.now();
        const minMs = 4200;
        const maxMs = expectPeers ? 12000 : 4500;

        while (Date.now() - started < maxMs) {
          if (gen !== callSyncGen || !inCall) return;
          const elapsed = Date.now() - started;
          const live = anyPeerLive();
          const hasPc = pcs.size > 0;

          if (live) {
            setCallSync(true, "sincronizando áudio…", 3);
            remotes.forEach((_, id) => resumeRemoteAudio(id));
          } else if (hasPc) {
            setCallSync(true, "negociando peers…", 2);
          } else if (expectPeers) {
            setCallSync(true, "aguardando sinal…", 2);
          }

          const readyEnough =
            elapsed >= minMs &&
            (!expectPeers || live || (elapsed >= 8000 && hasPc) || elapsed >= 10000);

          if (readyEnough) break;
          remotes.forEach((_, id) => resumeRemoteAudio(id));
          await sleep(420);
        }

        if (gen !== callSyncGen || !inCall) return;
        setCallSync(true, "tudo sincronizado", 4);
        remotes.forEach((_, id) => resumeRemoteAudio(id));
        await sleep(1200);
        if (gen !== callSyncGen || !inCall) return;
        callSyncing = false;
        setCallSync(false, "", 0);
        startSpeakWatch();
        if (localStream && state.peerId) attachSpeakMeter(state.peerId, localStream);
      }

      function peopleLabel(call) {
        const names = (call?.people || [])
          .map((p) => p.name || "ghost")
          .filter(Boolean);
        if (!names.length) return "ligação";
        if (names.length === 1) return `${names[0]} na call`;
        if (names.length === 2) return `${names[0]} e ${names[1]}`;
        return `${names[0]} +${names.length - 1}`;
      }

      function chipHue(name) {
        let h = 0;
        const s = String(name || "?");
        for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
        return h % 360;
      }

      function applyLocalMicMute(next) {
        muted = !!next;
        const live = !muted;
        try {
          localStream?.getAudioTracks?.().forEach((t) => {
            t.enabled = live;
          });
        } catch {
          /* ignore */
        }
        pcs.forEach((pc) => {
          try {
            if (pc._commsSendTrack) pc._commsSendTrack.enabled = live;
            pc.getSenders().forEach((sender) => {
              if (sender.track?.kind === "audio") sender.track.enabled = live;
            });
          } catch {
            /* ignore */
          }
        });
        const muteBtn = $("commsCallMute");
        if (muteBtn) {
          muteBtn.textContent = muted ? "ativar mic" : "mutar mic";
          muteBtn.setAttribute("aria-pressed", muted ? "true" : "false");
          muteBtn.title = muted ? "ativar seu microfone" : "mutar só o seu microfone";
        }
      }

      function patchSelfMuteOnCall(call) {
        if (!call?.people) return call;
        return {
          ...call,
          people: call.people.map((p) =>
            p.id === state.peerId ? { ...p, muted } : { ...p, muted: !!p.muted }
          ),
        };
      }

      function renderPeople(call) {
        const el = $("commsCallPeople");
        if (!el) return;
        const people = call?.people || [];
        for (const p of people) {
          if (p?.id) rememberPeerFace(p.id, p);
        }
        if (state.peerId && localAvatar) {
          const key = String(state.peerId);
          const cur = avatarCache.get(key);
          if (!cur?.url && !cur?.data) {
            avatarCache.set(key, { at: Date.now(), url: '', data: localAvatar });
          }
        }
        const iAmHost = call?.from === state.peerId;
        callHostId = call?.from || "";
        if (!people.length) {
          el.innerHTML = "";
          return;
        }
        el.innerHTML = people
          .map((p) => {
            const name = p.name || "ghost";
            const isHost = !!(p.host || p.id === call.from);
            const isMuted = p.id === state.peerId ? muted : !!p.muted;
            const canKick = iAmHost && p.id !== state.peerId;
            const hue = chipHue(name);
            const isSpeaking = !isMuted && speakingIds.has(p.id);
            const classes = [
              "comms-call-chip",
              isHost ? "host" : "",
              isMuted ? "mic-off" : "mic-on",
              p.id === state.peerId ? "me" : "",
              isSpeaking ? "speaking" : "",
            ]
              .filter(Boolean)
              .join(" ");
            const hostBadge = isHost
              ? `<span class="comms-call-host-badge">host</span>`
              : "";
            const mic = isMuted
              ? `<span class="comms-call-mic is-off" title="mic desativado" aria-label="microfone desativado">${MIC_OFF_SVG}</span>`
              : `<span class="comms-call-mic is-on" title="mic ativo" aria-label="microfone ativo">${MIC_ON_SVG}</span>`;
            const kick = canKick
              ? `<button type="button" class="comms-call-kick" data-call-kick="${escapeHtml(p.id)}" title="remover da call" aria-label="remover ${escapeHtml(name)}">×</button>`
              : "";
            return `<span class="${classes}" data-call-peer="${escapeHtml(p.id)}" title="${escapeHtml(name)}${isMuted ? " · mudo" : isSpeaking ? " · falando" : " · mic on"}">
              <span class="comms-call-puck">
                ${peerFaceHtml(p.id, name, hue, p)}
                ${mic}${kick}
              </span>
              <span class="comms-call-chip-name">${escapeHtml(name)}</span>
              ${hostBadge}
            </span>`;
          })
          .join("");
      }

      function ensureSpeakCtx() {
        try {
          const AC = window.AudioContext || window.webkitAudioContext;
          if (!AC) return null;
          if (!callAudioCtx) callAudioCtx = new AC();
          if (callAudioCtx.state === "suspended") callAudioCtx.resume().catch(() => {});
          return callAudioCtx;
        } catch {
          return null;
        }
      }

      function detachSpeakMeter(peerId) {
        const m = speakMeters.get(peerId);
        if (!m) return;
        try {
          m.source.disconnect();
        } catch {
          /* ignore */
        }
        speakMeters.delete(peerId);
        speakingIds.delete(peerId);
      }

      function attachSpeakMeter(peerId, mediaStream) {
        if (!peerId || !mediaStream) return;
        const ctx = ensureSpeakCtx();
        if (!ctx) return;
        const tracks = mediaStream.getAudioTracks?.() || [];
        if (!tracks.length) return;
        detachSpeakMeter(peerId);
        try {
          const source = ctx.createMediaStreamSource(mediaStream);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 512;
          analyser.smoothingTimeConstant = 0.4;
          source.connect(analyser);
          speakMeters.set(peerId, {
            analyser,
            source,
            data: new Uint8Array(analyser.fftSize),
          });
        } catch (err) {
          console.warn("call speak meter", err);
        }
      }

      function speakLevel(meter) {
        try {
          meter.analyser.getByteTimeDomainData(meter.data);
          let sum = 0;
          for (let i = 0; i < meter.data.length; i++) {
            const v = (meter.data[i] - 128) / 128;
            sum += v * v;
          }
          return Math.sqrt(sum / meter.data.length);
        } catch {
          return 0;
        }
      }

      function paintSpeakingChips() {
        const el = $("commsCallPeople");
        if (!el) return;
        el.querySelectorAll("[data-call-peer]").forEach((chip) => {
          const id = chip.getAttribute("data-call-peer");
          const on = speakingIds.has(id) && !chip.classList.contains("mic-off");
          chip.classList.toggle("speaking", on);
        });
      }

      function stopSpeakWatch() {
        if (speakRaf) cancelAnimationFrame(speakRaf);
        speakRaf = 0;
        speakingIds.clear();
        paintSpeakingChips();
      }

      function startSpeakWatch() {
        if (speakRaf) return;
        const tick = () => {
          speakRaf = 0;
          if (!inCall) {
            speakingIds.clear();
            paintSpeakingChips();
            return;
          }
          ensureSpeakCtx();
          if (localStream && state.peerId && !speakMeters.has(state.peerId)) {
            attachSpeakMeter(state.peerId, localStream);
          }
          remotes.forEach((audio, id) => {
            const stream = audio?.srcObject || audio?._commsStream;
            if (stream && !speakMeters.has(id)) attachSpeakMeter(id, stream);
          });

          const next = new Set();
          speakMeters.forEach((meter, id) => {
            if (id === state.peerId && muted) return;
            if (speakLevel(meter) >= SPEAK_RMS) next.add(id);
          });
          speakingIds = next;
          paintSpeakingChips();
          speakRaf = requestAnimationFrame(tick);
        };
        speakRaf = requestAnimationFrame(tick);
      }

      function clearSpeakMeters() {
        stopSpeakWatch();
        [...speakMeters.keys()].forEach(detachSpeakMeter);
      }

      function clearTick() {
        if (tickTimer) clearInterval(tickTimer);
        tickTimer = null;
      }

      function startTick(fromMs) {
        clearTick();
        callStartedAt = fromMs || Date.now();
        const paint = () => {
          if ($("commsCallTimer")) $("commsCallTimer").textContent = fmtVoiceMs(Date.now() - callStartedAt);
        };
        paint();
        tickTimer = setInterval(paint, 1000);
      }

      async function unlockCallPlayback() {
        Radio.unlockAudioGesture?.();
        try {
          const AC = window.AudioContext || window.webkitAudioContext;
          if (AC) {
            if (!callAudioCtx) callAudioCtx = new AC();
            if (callAudioCtx.state === "suspended") await callAudioCtx.resume();
          }
        } catch {
          /* ignore */
        }
        try {
          const a = new Audio(SILENT_WAV);
          a.setAttribute("playsinline", "");
          a.setAttribute("webkit-playsinline", "");
          a.volume = 0.01;
          await a.play();
          a.pause();
        } catch {
          /* ignore */
        }
      }

      function detachRemoteGraph(remoteId) {
        const g = remoteGraphs.get(remoteId);
        if (!g) return;
        try {
          g.source.disconnect();
        } catch {
          /* ignore */
        }
        try {
          g.gain.disconnect();
        } catch {
          /* ignore */
        }
        remoteGraphs.delete(remoteId);
      }

      function attachRemoteGraph(remoteId, stream) {
        if (!stream || remoteGraphs.has(remoteId)) return false;
        try {
          const AC = window.AudioContext || window.webkitAudioContext;
          if (!AC) return false;
          if (!callAudioCtx) callAudioCtx = new AC();
          if (callAudioCtx.state === "suspended") callAudioCtx.resume();
          const source = callAudioCtx.createMediaStreamSource(stream);
          const gain = callAudioCtx.createGain();
          gain.gain.value = 1.2;
          source.connect(gain);
          gain.connect(callAudioCtx.destination);
          remoteGraphs.set(remoteId, { source, gain });
          return true;
        } catch {
          return false;
        }
      }

      function resumeRemoteAudio(remoteId) {
        const audio = remotes.get(remoteId);
        if (!audio?.srcObject) return;
        try {
          if (callAudioCtx?.state === "suspended") callAudioCtx.resume();
        } catch {
          /* ignore */
        }
        try {
          audio.muted = false;
          audio.volume = 1;
          const p = audio.play();
          if (p?.catch) p.catch(() => {});
        } catch {
          /* ignore */
        }
        /* desktop às vezes bloqueia <audio> — fallback WebAudio */
        setTimeout(() => {
          if (!inCall) return;
          const el = remotes.get(remoteId);
          if (!el?.srcObject) return;
          if (!el.paused && el.currentTime > 0) return;
          if (attachRemoteGraph(remoteId, el.srcObject)) {
            el.muted = true;
          }
        }, 700);
      }

      function startRemotePlayWatch() {
        if (remotePlayTimer) return;
        remotePlayTimer = setInterval(() => {
          if (!inCall) return;
          remotes.forEach((_, id) => resumeRemoteAudio(id));
        }, 600);
      }

      function stopRemotePlayWatch() {
        if (remotePlayTimer) clearInterval(remotePlayTimer);
        remotePlayTimer = null;
      }

      function descPayload(desc) {
        if (!desc) return null;
        return { type: desc.type, sdp: desc.sdp };
      }

      function waitIceGathering(pc, ms = 3500) {
        if (!pc || pc.iceGatheringState === "complete") return Promise.resolve();
        return new Promise((resolve) => {
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            try {
              pc.removeEventListener("icegatheringstatechange", onState);
            } catch {
              /* ignore */
            }
            resolve();
          };
          const onState = () => {
            if (pc.iceGatheringState === "complete") finish();
          };
          pc.addEventListener("icegatheringstatechange", onState);
          setTimeout(finish, ms);
        });
      }

      async function flushIceBuf(pc) {
        if (!pc?._commsIceBuf?.length) return;
        const buf = pc._commsIceBuf.splice(0, pc._commsIceBuf.length);
        for (const c of buf) {
          try {
            await pc.addIceCandidate(c);
          } catch {
            /* ignore */
          }
        }
      }

      async function ensureMic() {
        if (localStream) {
          const live = localStream.getAudioTracks().some((t) => t.readyState === "live");
          if (live) {
            localStream.getAudioTracks().forEach((t) => {
              t.enabled = true;
            });
            return localStream;
          }
          stopMic();
        }
        if (!navigator.mediaDevices?.getUserMedia) {
          throw Object.assign(new Error("mic indisponível"), { name: "NotSupportedError" });
        }
        /* no mobile, constraints rígidas falham — tenta simples primeiro */
        const tries = [
          { audio: true, video: false },
          { audio: { echoCancellation: true }, video: false },
          {
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
            video: false,
          },
        ];
        let lastErr = null;
        for (const constraints of tries) {
          try {
            localStream = await navigator.mediaDevices.getUserMedia(constraints);
            break;
          } catch (err) {
            lastErr = err;
          }
        }
        if (!localStream) throw lastErr || new Error("mic falhou");
        localStream.getAudioTracks().forEach((t) => {
          t.enabled = true;
        });
        return localStream;
      }

      function stopMic() {
        try {
          localStream?.getTracks?.().forEach((t) => t.stop());
        } catch {
          /* ignore */
        }
        localStream = null;
      }

      function killPc(id) {
        const pc = pcs.get(id);
        if (pc) {
          try {
            if (pc._commsSendCloned) pc._commsSendTrack?.stop?.();
          } catch {
            /* ignore */
          }
          try {
            pc.close();
          } catch {
            /* ignore */
          }
          pcs.delete(id);
        }
        detachSpeakMeter(id);
        detachRemoteGraph(id);
        const a = remotes.get(id);
        if (a) {
          try {
            a.pause();
            a.srcObject = null;
            a.remove();
          } catch {
            /* ignore */
          }
          remotes.delete(id);
        }
      }

      function killAllPcs() {
        [...pcs.keys()].forEach(killPc);
        [...remoteGraphs.keys()].forEach(detachRemoteGraph);
      }

      async function postSignal(to, type, payload) {
        if (!state.code || !state.peerId) return;
        await api(`/api/deck/comms/${state.code}/call/signal`, {
          method: "POST",
          body: JSON.stringify({ peerId: state.peerId, to, type, payload }),
        });
      }

      function ensureRemoteEl(remoteId) {
        let audio = remotes.get(remoteId);
        if (audio) return audio;
        audio = document.createElement("audio");
        audio.autoplay = true;
        audio.playsInline = true;
        audio.setAttribute("playsinline", "true");
        audio.setAttribute("webkit-playsinline", "true");
        audio.setAttribute("autoplay", "");
        audio.preload = "auto";
        audio.controls = false;
        audio.volume = 1;
        audio.muted = false;
        /* iOS ignora áudio com display:none / opacity:0 / z-index:-1 */
        audio.style.cssText =
          "position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:0.02;pointer-events:none;";
        document.body.appendChild(audio);
        remotes.set(remoteId, audio);
        return audio;
      }

      async function makePc(remoteId) {
        if (pcs.has(remoteId)) return pcs.get(remoteId);
        const stream = await ensureMic();
        const pc = new RTCPeerConnection(ICE);
        pcs.set(remoteId, pc);
        pc._commsIceBuf = [];

        const src = stream.getAudioTracks()[0];
        if (src) {
          /*
            Mesma track original em mobile e PC (1:1).
            clone() no iOS = silêncio; no desktop com mesh 3+ ainda usamos original
            pra os dois lados falarem ao mesmo tempo sem divergir.
          */
          src.enabled = !muted;
          pc._commsSendTrack = src;
          pc._commsSendCloned = false;
          pc.addTrack(src, stream);
        }

        pc.onicecandidate = (ev) => {
          /* trickle + SDP bundle: celular↔PC precisa dos dois */
          if (ev.candidate) {
            postSignal(remoteId, "ice", ev.candidate.toJSON?.() || ev.candidate);
          }
        };

        pc.ontrack = (ev) => {
          try {
            if (ev.track) ev.track.enabled = true;
          } catch {
            /* ignore */
          }
          const audio = ensureRemoteEl(remoteId);
          const inbound = ev.streams?.[0] || new MediaStream([ev.track]);
          audio.srcObject = inbound;
          audio._commsStream = inbound;
          audio.muted = false;
          audio.volume = 1;
          attachSpeakMeter(remoteId, inbound);
          startSpeakWatch();
          resumeRemoteAudio(remoteId);
          setTimeout(() => resumeRemoteAudio(remoteId), 200);
          setTimeout(() => resumeRemoteAudio(remoteId), 800);
          setTimeout(() => resumeRemoteAudio(remoteId), 1600);
        };

        pc.onconnectionstatechange = () => {
          if (pc.connectionState === "connected" || pc.connectionState === "completed") {
            resumeRemoteAudio(remoteId);
          }
        };

        return pc;
      }

      async function offerTo(remoteId) {
        const pc = await makePc(remoteId);
        if (pc._commsOffered) return;
        if (pc.signalingState !== "stable") return;
        pc._commsOffered = true;
        ensureRemoteEl(remoteId);
        try {
          /* sem offerToReceiveAudio: addTrack já cria sendrecv (evita 2 m-lines no Chrome) */
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          await waitIceGathering(pc);
          await postSignal(remoteId, "offer", descPayload(pc.localDescription));
        } catch (err) {
          pc._commsOffered = false;
          console.warn("call offer", err);
        }
      }

      async function handleSignal(sig) {
        if (!sig?.from || !sig.type) return;
        if (sig.from === state.peerId) return;
        try {
          if (sig.type === "offer") {
            const pc = await makePc(sig.from);
            if (pc._commsOffered && String(state.peerId) < String(sig.from)) return;
            if (pc.remoteDescription) return;
            if (pc.signalingState !== "stable" && pc.signalingState !== "have-local-offer") return;

            ensureRemoteEl(sig.from);
            await pc.setRemoteDescription(sig.payload);
            await flushIceBuf(pc);
            try {
              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);
              await waitIceGathering(pc);
              await postSignal(sig.from, "answer", descPayload(pc.localDescription));
            } catch (err) {
              console.warn("call answer", err);
            }
            resumeRemoteAudio(sig.from);
          } else if (sig.type === "answer") {
            const pc = pcs.get(sig.from) || (await makePc(sig.from));
            if (pc.signalingState === "have-local-offer" && !pc.currentRemoteDescription) {
              await pc.setRemoteDescription(sig.payload);
              await flushIceBuf(pc);
            }
            resumeRemoteAudio(sig.from);
          } else if (sig.type === "ice") {
            const pc = pcs.get(sig.from) || (await makePc(sig.from));
            if (pc.remoteDescription) {
              try {
                await pc.addIceCandidate(sig.payload);
              } catch {
                /* ignore */
              }
            } else {
              pc._commsIceBuf = pc._commsIceBuf || [];
              pc._commsIceBuf.push(sig.payload);
            }
          }
        } catch (err) {
          console.warn("call signal", err);
        }
      }

      function syncMesh(joined) {
        meshTail = meshTail
          .then(() => syncMeshInner(joined))
          .catch((err) => console.warn("call mesh", err));
        return meshTail;
      }

      async function syncMeshInner(joined) {
        const others = (joined || []).filter((id) => id && id !== state.peerId);
        for (const id of [...pcs.keys()]) {
          if (!others.includes(id)) killPc(id);
        }
        for (const id of others) {
          ensureRemoteEl(id);
          if (String(state.peerId) < String(id)) await offerTo(id);
          else await makePc(id);
        }
        for (const id of others) resumeRemoteAudio(id);
      }

      function requestStart() {
        if (!state.code || !state.peerId) return;
        const humans = humanPeers(state._lastPeers || []).filter((p) => p.id !== state.peerId);
        if (!humans.length) {
          notify("precisa de alguém no canal pra ligar");
          return;
        }
        pendingStart = true;
        showTip(true);
      }

      async function start() {
        if (!state.code || !state.peerId) return;
        showTip(false);
        pendingStart = false;
        try {
          /* iOS: getUserMedia TEM que ser o primeiro await do gesto */
          await ensureMic();
          await unlockCallPlayback();
        } catch (err) {
          notify(micErrorMessage(err));
          return;
        }
        const r = await api(`/api/deck/comms/${state.code}/call/start`, {
          method: "POST",
          body: JSON.stringify({ peerId: state.peerId }),
        });
        if (!r?.ok) {
          notify(r?.error || "não deu pra ligar");
          stopMic();
          return;
        }
        inCall = true;
        startRemotePlayWatch();
        callId = r.call?.id || "";
        callHostId = r.call?.from || state.peerId;
        ignoredCallId = "";
        clearVibe();
        setBubble(false);
        setPhoneUi({ on: true, ringing: false });
        uiBar(true, "sincronizando…");
        lastCall = patchSelfMuteOnCall(r.call);
        renderPeople(lastCall);
        startTick(Date.now());
        try {
          if (Radio.getActive()) Radio.apply?.({ kind: "stop" });
        } catch {
          /* ignore */
        }
        const joined = r.call?.joined || [state.peerId];
        const expectPeers = joined.filter((id) => id !== state.peerId).length > 0;
        setCallSync(true, "abrindo microfone…", 1);
        await syncMesh(joined);
        await runCallSync({ expectPeers });
        if (inCall) uiBar(true, expectPeers ? "em ligação" : "chamando…");
        applyCallState(r.call);
      }

      async function answer() {
        if (!state.code || !state.peerId) return;
        try {
          /* iOS: getUserMedia TEM que ser o primeiro await do gesto */
          await ensureMic();
          await unlockCallPlayback();
        } catch (err) {
          notify(micErrorMessage(err));
          return;
        }
        const r = await api(`/api/deck/comms/${state.code}/call/answer`, {
          method: "POST",
          body: JSON.stringify({ peerId: state.peerId }),
        });
        if (!r?.ok) {
          notify(r?.error || "não deu pra entrar");
          return;
        }
        inCall = true;
        startRemotePlayWatch();
        callId = r.call?.id || "";
        ignoredCallId = "";
        ringingShownFor = "";
        clearVibe();
        setBubble(false);
        setPhoneUi({ on: true, ringing: false });
        uiBar(true, "sincronizando…");
        lastCall = patchSelfMuteOnCall(r.call);
        renderPeople(lastCall);
        startTick(r.call?.activeAt || Date.now());
        const joined = r.call?.joined || [];
        setCallSync(true, "abrindo microfone…", 1);
        await syncMesh(joined);
        await runCallSync({ expectPeers: true });
        if (inCall) uiBar(true, "em ligação");
        applyCallState(r.call);
      }

      async function hangup(localOnly = false) {
        const wasIn = inCall || !!callId;
        const wasRinging = !!ringingShownFor;
        const was = wasIn || wasRinging;
        if (wasRinging && lastCall?.id) ignoredCallId = lastCall.id;
        ringingShownFor = "";
        pendingStart = false;
        showTip(false);
        clearVibe();
        setBubble(false);
        clearTick();
        hideCallSync();
        clearSpeakMeters();
        stopRemotePlayWatch();
        killAllPcs();
        stopMic();
        inCall = false;
        const oldId = callId;
        callId = "";
        callHostId = "";
        lastCall = null;
        uiBar(false);
        setPhoneUi({ on: false, ringing: false });
        applyLocalMicMute(false);
        if (!localOnly && was && state.code && state.peerId && (oldId || wasRinging)) {
          await api(`/api/deck/comms/${state.code}/call/hangup`, {
            method: "POST",
            body: JSON.stringify({ peerId: state.peerId }),
          }).catch(() => {});
        }
      }

      async function kick(targetId) {
        if (!state.code || !state.peerId || !targetId) return;
        if (callHostId !== state.peerId) {
          notify("só quem criou a call pode remover");
          return;
        }
        const r = await api(`/api/deck/comms/${state.code}/call/kick`, {
          method: "POST",
          body: JSON.stringify({ peerId: state.peerId, targetId }),
        });
        if (!r?.ok) {
          notify(r?.error || "não deu pra remover");
          return;
        }
        applyCallState(r.call);
      }

      async function toggleMute() {
        if (!inCall) return;
        applyLocalMicMute(!muted);
        await unlockCallPlayback();
        remotes.forEach((_, id) => resumeRemoteAudio(id));
        if (lastCall) {
          lastCall = patchSelfMuteOnCall(lastCall);
          renderPeople(lastCall);
        }
        if (!state.code || !state.peerId) return;
        try {
          const r = await api(`/api/deck/comms/${state.code}/call/mute`, {
            method: "POST",
            body: JSON.stringify({ peerId: state.peerId, muted }),
          });
          if (r?.ok && r.call) {
            lastCall = patchSelfMuteOnCall(r.call);
            renderPeople(lastCall);
          } else {
            postPresence({ callMuted: muted }).catch(() => {});
          }
        } catch {
          postPresence({ callMuted: muted }).catch(() => {});
        }
      }

      function applyCallState(call) {
        lastCall = call || null;
        if (!call) {
          ignoredCallId = "";
          if (inCall || ringingShownFor) hangup(true);
          else {
            clearVibe();
            setBubble(false);
            setPhoneUi({ on: false, ringing: false });
            uiBar(false);
          }
          return;
        }
        if (ignoredCallId && call.id === ignoredCallId) {
          clearVibe();
          setBubble(false);
          setPhoneUi({ on: false, ringing: false });
          return;
        }
        const joined = call.joined || [];
        const iAmIn = joined.includes(state.peerId);
        callHostId = call.from || "";

        if (call.status === "ringing" && !iAmIn && call.from !== state.peerId) {
          if (ringingShownFor !== call.id) {
            ringingShownFor = call.id;
            startVibe();
          }
          setPhoneUi({ on: false, ringing: true });
          setBubble(true, `${call.fromName || "alguém"} está na call — entra?`, true);
          return;
        }

        if (call.status === "active" && !iAmIn) {
          setPhoneUi({ on: true, ringing: false });
          setBubble(true, `${peopleLabel(call)} — toca no telefone pra entrar`, false);
          clearVibe();
          ringingShownFor = "";
          return;
        }

        if ((call.status === "active" || call.status === "ringing") && iAmIn) {
          const was = inCall;
          inCall = true;
          startRemotePlayWatch();
          startSpeakWatch();
          callId = call.id;
          ringingShownFor = "";
          clearVibe();
          setBubble(false);
          setPhoneUi({ on: true, ringing: false });
          uiBar(true, call.status === "ringing" ? "chamando…" : "em ligação");
          const painted = patchSelfMuteOnCall(call);
          lastCall = painted;
          renderPeople(painted);
          if (!was || !tickTimer) startTick(call.activeAt || call.at || Date.now());
          syncMesh(joined).catch(() => {});
          return;
        }
      }

      async function onPresence(r) {
        if (Array.isArray(r?.callSignals)) {
          for (const sig of r.callSignals) {
            await handleSignal(sig);
          }
        }
        const call = r?.call || null;
        if (call && inCall && callId && !(call.joined || []).includes(state.peerId)) {
          notify("você foi removido da ligação");
          await hangup(true);
          applyCallState(call);
          return;
        }
        applyCallState(call);
      }

      function bind() {
        $("commsCallBtn")?.addEventListener("click", async () => {
          /* não await unlock antes do answer — iOS perde o gesto do mic */
          if (pendingStart) {
            showTip(false);
            pendingStart = false;
            return;
          }
          if (inCall && (lastCall?.joined || []).includes(state.peerId)) {
            await hangup(false);
            return;
          }
          if (ringingShownFor || (lastCall && !(lastCall.joined || []).includes(state.peerId))) {
            await answer();
            return;
          }
          requestStart();
        });
        $("commsCallHang")?.addEventListener("click", () => hangup(false));
        $("commsCallMute")?.addEventListener("click", () => toggleMute());
        $("commsCallAccept")?.addEventListener("click", () => answer());
        $("commsCallDecline")?.addEventListener("click", () => hangup(false));
        $("commsCallTipOk")?.addEventListener("click", () => start());
        $("commsCallTipCancel")?.addEventListener("click", () => {
          pendingStart = false;
          showTip(false);
        });
        $("commsCallPeople")?.addEventListener("click", (e) => {
          const btn = e.target.closest("[data-call-kick]");
          if (!btn) return;
          kick(btn.getAttribute("data-call-kick"));
        });
      }

      return {
        bind,
        onPresence,
        hangup,
        refreshPeople() {
          if (lastCall) renderPeople(lastCall);
        },
        get inCall() {
          return inCall;
        },
        isMuted() {
          return muted;
        },
      };
    })();

    async function leave() {
      clearTimeout(typingIdle);
      typingOn = false;
      if (recordingKeepalive) {
        clearInterval(recordingKeepalive);
        recordingKeepalive = null;
      }
      recordingOn = false;
      clearReply();
      clearAttach();
      try {
        hideFacePop();
      } catch {
        /* ignore */
      }
      try {
        stopCommsVoice();
      } catch {
        /* ignore */
      }
      try {
        await VoiceCall.hangup(false);
      } catch {
        /* ignore */
      }
      showQr(false);
      const more = $('commsMorePanel');
      if (more) more.hidden = true;
      const moreBtn = $('commsMoreBtn');
      if (moreBtn) moreBtn.setAttribute('aria-expanded', 'false');
      if ($('commsStickers')) $('commsStickers').hidden = true;
      const leftCode = state.code;
      const snap = Radio.listeningSnapshot();
      const trackKey = listeningTrackKey(snap);
      const preferPeerId = state.alongWith || null;
      const hadMusic = !!Radio.getActive();
      if (state.code && state.peerId) {
        await api(`/api/deck/comms/${state.code}/leave`, {
          method: 'POST',
          body: JSON.stringify({ peerId: state.peerId }),
        }).catch(() => {});
      }
      stopPoll();
      state.code = null;
      state.cdr = false;
      state.cdrTyping = false;
      state.listeningByPeer = {};
      state.listeningKey = '';
      state.alongWith = null;
      state.alongTrackKey = '';
      /* para local; quem ficou no sync segue tocando */
      Radio.stopAll(false);
      leaveMusicHold =
        hadMusic && leftCode
          ? { code: leftCode, trackKey: trackKey || '', preferPeerId }
          : null;
      const nowEl = $('commsNowPlaying');
      if (nowEl) {
        nowEl.hidden = true;
        nowEl.innerHTML = '';
      }
      const callBar = $('commsCallBar');
      if (callBar) callBar.hidden = true;
      const callBubble = $('commsCallBubble');
      if (callBubble) callBubble.hidden = true;
      const callTip = $('commsCallTip');
      if (callTip) {
        callTip.hidden = true;
        callTip.classList.remove('on');
      }
      $('commsCallBtn')?.classList.remove('on', 'ringing');
      localStorage.setItem(
        storeKey,
        JSON.stringify({
          peerId: state.peerId,
          name: state.name,
          code: null,
          seat: state.seat,
          lastCode: leftCode || loadSaved().lastCode || null,
        })
      );
      showLobby();
      $('netPill').textContent = 'COMMS IDLE';
      if (leftCode) {
        $('commsLobbyHint').textContent = `saiu · canal ${leftCode} ainda pode existir se o outro ficar`;
      }
    }

    function wire() {
      const saved = loadSaved();
      if (saved.name) $('commsName').value = saved.name;
      if (saved.peerId) state.peerId = saved.peerId;
      localAvatar = loadLocalAvatar();
      avatarDirty = !!localAvatar;
      refreshAvatarUi();
      loadStickers();

      $('commsCreate').addEventListener('click', create);
      $('commsJoin').addEventListener('click', join);
      $('commsLeave').addEventListener('click', leave);
      $('commsName')?.addEventListener('input', refreshAvatarUi);
      const openAvatarPicker = () => $('commsAvatarFile')?.click();
      $('commsAvatarBtn')?.addEventListener('click', openAvatarPicker);
      $('commsAvatarPick')?.addEventListener('click', openAvatarPicker);
      $('commsAvatarClear')?.addEventListener('click', () => clearLocalAvatar());
      $('commsRoomAvatarBtn')?.addEventListener('click', openAvatarPicker);
      $('commsRoomAvatarPick')?.addEventListener('click', openAvatarPicker);
      $('commsRoomAvatarClear')?.addEventListener('click', () => clearLocalAvatar());
      $('commsRoomName')?.addEventListener('input', refreshAvatarUi);
      $('commsRoomName')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          applyRoomNick(true);
        }
      });
      $('commsRoomName')?.addEventListener('blur', () => applyRoomNick());
      $('commsRoomNickApply')?.addEventListener('click', () => applyRoomNick(true));
      $('commsAvatarFile')?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        await pickLocalAvatar(file);
      });
      $('commsMoreBtn')?.addEventListener('click', () => {
        const panel = $('commsMorePanel');
        const btn = $('commsMoreBtn');
        if (!panel || !btn) return;
        const open = panel.hidden;
        panel.hidden = !open;
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) showQr(false);
      });
      wireVisual();
      $('commsNowPlaying')?.addEventListener('click', (e) => {
        const leaveBtn = e.target.closest('[data-leave-along]');
        if (leaveBtn) {
          e.preventDefault();
          leaveAlong();
          return;
        }
        const btn = e.target.closest('[data-along]');
        if (!btn) return;
        e.preventDefault();
        listenAlong(btn.getAttribute('data-along'));
      });
      $('commsFeed')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.comms-join-here[data-along]');
        if (!btn) return;
        e.preventDefault();
        listenAlong(btn.getAttribute('data-along'));
      });
      $('commsResume')?.addEventListener('click', async () => {
        const last = loadSaved().lastCode || $('commsJoinCode')?.value?.trim();
        if (!last) return;
        $('commsJoinCode').value = last;
        await join();
      });
      refreshResumeUi();

      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        if (!state.code || !state.peerId) return;
        poll();
      });
      window.addEventListener('pageshow', () => {
        if (!state.code || !state.peerId) return;
        poll();
      });

      $('commsCopy').addEventListener('click', async () => {
        if (!state.code) return;
        const ok = await copyText(state.code, `código ${state.code} copiado`);
        if (!ok) $('commsLobbyHint').textContent = state.code;
      });
      $('commsCopyUrl')?.addEventListener('click', async () => {
        if (!state.code) return;
        const url = joinUrl(state.code, state.name);
        const ok = await copyText(url, 'link do canal copiado');
        if (!ok && $('commsPeers')) notify(url);
      });
      $('commsQrCopyUrl')?.addEventListener('click', async () => {
        if (!state.code) return;
        const url = joinUrl(state.code, state.name);
        const ok = await copyText(url, 'link do canal copiado');
        const hint = $('commsQrHint');
        if (hint) hint.textContent = ok ? 'URL copiada' : url;
      });
      $('commsQrBtn')?.addEventListener('click', () => {
        const panel = $('commsQrPanel');
        showQr(!!panel?.hidden);
      });
      $('commsQrClose')?.addEventListener('click', () => showQr(false));
      $('commsReplyClear')?.addEventListener('click', clearReply);

      bindHold($('commsFeed'));
      wireFacePop();
      $('commsNewMsg')?.addEventListener('click', () => {
        scrollFeedToEnd(true);
        keepCommsKeyboard();
      });
      $('commsFeed')?.addEventListener(
        'scroll',
        () => {
          if (isFeedNearBottom(120)) hideNewMsgHint();
        },
        { passive: true }
      );

      $('commsFeed')?.addEventListener('click', (e) => {
        const copyBtn = e.target.closest('[data-copy-cmd]');
        if (copyBtn) {
          e.preventDefault();
          e.stopPropagation();
          let cmd = '';
          try {
            cmd = decodeURIComponent(copyBtn.getAttribute('data-copy-cmd') || '');
        } catch {
            cmd = copyBtn.getAttribute('data-copy-cmd') || '';
          }
          if (!cmd) return;
          const input = $('commsInput');
          if (input) {
            input.value = cmd;
            input.focus({ preventScroll: true });
          }
          copyText(cmd, `copiado · ${cmd}`);
          return;
        }
        const chip = e.target.closest('[data-react-chip]');
        if (!chip) return;
        const msgEl = chip.closest('.comms-msg[data-id]');
        if (!msgEl) return;
        e.preventDefault();
        e.stopPropagation();
        reactTo(msgEl.dataset.id, chip.dataset.reactChip);
      });

      $('commsReactPop')?.addEventListener('click', async (e) => {
        const reactBtn = e.target.closest('[data-react]');
        const replyBtn = e.target.closest('[data-reply]');
        const copyBtn = e.target.closest('[data-copy]');
        if (!popMsg) {
          hideReactPop();
          return;
        }
        if (reactBtn) {
          reactTo(popMsg.id, reactBtn.dataset.react);
          hideReactPop();
          return;
        }
        if (copyBtn) {
          const text = messageCopyText(popMsg, holdMsgEl);
          if (!text) {
            notify('nada pra copiar nessa mensagem');
            hideReactPop();
            return;
          }
          await copyText(text, 'mensagem copiada');
          hideReactPop();
          return;
        }
        if (replyBtn) {
          setReply(popMsg);
          hideReactPop();
        }
      });

      document.addEventListener('pointerdown', (e) => {
        const pop = $('commsReactPop');
        if (!pop || pop.hidden) return;
        if (e.target.closest('#commsReactPop') || e.target.closest('.comms-msg.holding')) return;
        hideReactPop();
      });

      /* —— mensagem de voz —— */
      const VOICE_MAX_MS = 120000;
      let voiceRec = null;
      let voiceStream = null;
      let voiceChunks = [];
      let voiceStartedAt = 0;
      let voiceTick = null;
      let voiceSending = false;
      let activeVoiceAudio = null;

      function pickVoiceMime() {
        const types = [
          'audio/webm;codecs=opus',
          'audio/webm',
          'audio/mp4',
          'audio/ogg;codecs=opus',
          'audio/aac',
        ];
        if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) {
          return '';
        }
        return types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
      }

      function setVoiceUi(recording) {
        const bar = $('commsVoiceBar');
        const btn = $('commsVoiceBtn');
        const form = $('commsForm');
        if (bar) bar.hidden = !recording;
        if (form) form.classList.toggle('is-recording', !!recording);
        if (btn) {
          btn.classList.toggle('recording', !!recording);
          btn.setAttribute('aria-pressed', recording ? 'true' : 'false');
        }
        if (!recording) {
          if ($('commsVoiceTimer')) $('commsVoiceTimer').textContent = '0:00';
          if ($('commsVoiceHint')) $('commsVoiceHint').textContent = 'gravando áudio…';
        } else if ($('commsVoiceHint')) {
          $('commsVoiceHint').textContent = 'gravando áudio…';
        }
        setRecording(!!recording);
      }

      function stopVoiceTracks() {
        try {
          voiceStream?.getTracks?.().forEach((t) => t.stop());
        } catch {
          /* ignore */
        }
        voiceStream = null;
      }

      function clearVoiceTick() {
        if (voiceTick) clearInterval(voiceTick);
        voiceTick = null;
      }

      async function cancelVoiceRecord() {
        clearVoiceTick();
        const rec = voiceRec;
        voiceRec = null;
        voiceChunks = [];
        voiceStartedAt = 0;
        if (rec && rec.state !== 'inactive') {
          try {
            rec.ondataavailable = null;
            rec.onstop = null;
            rec.stop();
          } catch {
            /* ignore */
          }
        }
        stopVoiceTracks();
        setVoiceUi(false);
      }

      function blobToDataUrl(blob) {
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ''));
          reader.onerror = () => reject(new Error('não deu pra ler o áudio'));
          reader.readAsDataURL(blob);
        });
      }

      async function finishVoiceRecord({ send }) {
        if (voiceSending) return;
        clearVoiceTick();
        const rec = voiceRec;
        const started = voiceStartedAt;
        if (!rec) {
          setVoiceUi(false);
          return;
        }
        voiceRec = null;
        const ms = Math.max(0, Date.now() - (started || Date.now()));
        const blob = await new Promise((resolve) => {
          const chunks = voiceChunks;
          rec.ondataavailable = (e) => {
            if (e.data?.size) chunks.push(e.data);
          };
          rec.onstop = () => {
            const type = rec.mimeType || pickVoiceMime() || 'audio/webm';
            resolve(new Blob(chunks, { type }));
          };
          try {
            if (rec.state !== 'inactive') rec.stop();
            else resolve(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
          } catch {
            resolve(new Blob(chunks, { type: 'audio/webm' }));
          }
        });
        stopVoiceTracks();
        voiceChunks = [];
        voiceStartedAt = 0;
        setVoiceUi(false);

        if (!send) return;
        if (!blob || blob.size < 400 || ms < 450) {
          notify('áudio muito curto');
          return;
        }
        if (ms > VOICE_MAX_MS + 1500) {
          notify('áudio longo demais (máx. 2 min)');
          return;
        }
        voiceSending = true;
        try {
          const dataUrl = await blobToDataUrl(blob);
          if (!safeVoiceSrc(dataUrl)) {
            notify('formato de áudio não suportado');
            return;
          }
          Radio.unlockAudioGesture?.();
          flushVoiceWaveWaiters();
          const wave = (await peaksFromBlob(blob, VOICE_WAVE_BARS)) || null;
          await sendMessage({
            voice: dataUrl,
            voiceMs: Math.min(VOICE_MAX_MS, ms),
            voiceWave: wave,
          });
          scrollFeedToEnd(true);
        } catch (err) {
          notify(err?.message || 'falha ao enviar áudio');
        } finally {
          voiceSending = false;
        }
      }

      async function startVoiceRecord() {
        if (!state.code || !state.peerId) return;
        if (typeof MediaRecorder === 'undefined') {
          notify('este navegador não grava áudio');
          return;
        }
        if (!navigator.mediaDevices?.getUserMedia) {
          notify('microfone indisponível (precisa HTTPS)');
          return;
        }
        if (voiceRec) return;
        try {
          $('commsStickers').hidden = true;
          clearAttach();
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
          });
          voiceStream = stream;
          const mime = pickVoiceMime();
          const rec = mime
            ? new MediaRecorder(stream, { mimeType: mime })
            : new MediaRecorder(stream);
          voiceChunks = [];
          voiceStartedAt = Date.now();
          rec.ondataavailable = (e) => {
            if (e.data?.size) voiceChunks.push(e.data);
          };
          rec.onerror = () => {
            notify('erro na gravação');
            cancelVoiceRecord();
          };
          voiceRec = rec;
          rec.start(250);
          setVoiceUi(true);
          clearVoiceTick();
          voiceTick = setInterval(() => {
            const elapsed = Date.now() - voiceStartedAt;
            if ($('commsVoiceTimer')) $('commsVoiceTimer').textContent = fmtVoiceMs(elapsed);
            if (elapsed >= VOICE_MAX_MS) {
              finishVoiceRecord({ send: true });
            }
          }, 200);
          Radio.unlockAudioGesture?.();
        } catch (err) {
          stopVoiceTracks();
          setVoiceUi(false);
          const name = String(err?.name || '');
          if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
            notify('libera o microfone pra gravar');
          } else if (name === 'NotFoundError') {
            notify('nenhum microfone achado');
          } else {
            notify('não deu pra gravar');
          }
        }
      }

      function pauseActiveVoice() {
        const a = activeVoiceAudio;
        if (!a) return;
        try {
          a.pause();
        } catch {
          /* ignore */
        }
        const wrap = a.closest?.('.comms-voice');
        stopVoiceProgressTick(wrap);
        syncVoicePlayUi(wrap, false);
        activeVoiceAudio = null;
      }

      function syncVoicePlayUi(wrap, playing) {
        if (!wrap) return;
        const btn = wrap.querySelector('[data-voice-play]');
        if (!btn) return;
        btn.classList.toggle('is-playing', !!playing);
        btn.innerHTML = playing
          ? `<svg class="comms-ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">` +
              `<rect x="7.2" y="6" width="3.2" height="12" rx="0.6" fill="none" stroke="currentColor" stroke-width="1.75"/>` +
              `<rect x="13.6" y="6" width="3.2" height="12" rx="0.6" fill="none" stroke="currentColor" stroke-width="1.75"/>` +
            `</svg>`
          : `<svg class="comms-ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">` +
              `<path d="M9 6.2v11.6l9.2-5.8L9 6.2z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/>` +
            `</svg>`;
        btn.setAttribute('aria-label', playing ? 'pausar áudio' : 'tocar áudio');
      }

      function voiceDurSec(wrap, audio) {
        const d = Number(audio?.duration);
        if (Number.isFinite(d) && d > 0) return d;
        const ms = Number(wrap?.dataset?.voiceMs) || 0;
        if (ms > 0) return ms / 1000;
        const msgMs = Number(wrap?.closest?.('.comms-msg')?._msg?.voiceMs) || 0;
        return msgMs > 0 ? msgMs / 1000 : 0;
      }

      function stopVoiceProgressTick(wrap) {
        if (wrap?._voiceTick) {
          clearInterval(wrap._voiceTick);
          wrap._voiceTick = null;
        }
      }

      function startVoiceProgressTick(wrap, audio) {
        stopVoiceProgressTick(wrap);
        if (!wrap || !audio) return;
        wrap._voiceTick = setInterval(() => {
          if (audio.paused || audio.ended) {
            stopVoiceProgressTick(wrap);
            return;
          }
          wrap._voiceUpdate?.();
        }, 100);
      }

      function setVoiceWaveProgress(wrap, ratio) {
        const wave = wrap?.querySelector?.('[data-voice-wave]');
        if (!wave) return;
        const bars = wave.children;
        const n = bars.length;
        if (!n) return;
        const lit = Math.max(0, Math.min(n, Math.round(Math.max(0, Math.min(1, ratio)) * n)));
        for (let i = 0; i < n; i += 1) {
          bars[i].classList.toggle('on', i < lit);
        }
      }

      function bindVoiceEl(wrap) {
        const audio = wrap.querySelector('audio');
        const timeEl = wrap.querySelector('.comms-voice-time');
        if (!audio || audio._commsVoiceBound) return;
        audio._commsVoiceBound = true;
        const msg = wrap.closest?.('.comms-msg')?._msg;
        if (wrap.querySelector('.comms-voice-wave.is-pending')) {
          hydrateVoiceWave(wrap, msg || { voice: audio.getAttribute('src'), id: wrap.dataset.voiceId, voiceMs: wrap.dataset.voiceMs });
        }
        const update = () => {
          const dur = voiceDurSec(wrap, audio);
          const cur = Math.max(0, Number(audio.currentTime) || 0);
          if (dur > 0) {
            setVoiceWaveProgress(wrap, cur / dur);
          } else if (cur > 0) {
            setVoiceWaveProgress(wrap, 0);
          }
          if (timeEl && dur > 0) {
            const left = Math.max(0, (dur - cur) * 1000);
            timeEl.textContent = fmtVoiceMs(left);
          } else if (timeEl && cur > 0) {
            timeEl.textContent = fmtVoiceMs(cur * 1000);
          }
        };
        wrap._voiceUpdate = update;
        audio.addEventListener('timeupdate', update);
        audio.addEventListener('durationchange', update);
        audio.addEventListener('loadedmetadata', update);
        audio.addEventListener('playing', () => {
          update();
          startVoiceProgressTick(wrap, audio);
        });
        audio.addEventListener('ended', () => {
          stopVoiceProgressTick(wrap);
          setVoiceWaveProgress(wrap, 0);
          const dur = voiceDurSec(wrap, audio);
          if (timeEl && dur > 0) timeEl.textContent = fmtVoiceMs(dur * 1000);
          syncVoicePlayUi(wrap, false);
          if (activeVoiceAudio === audio) activeVoiceAudio = null;
        });
        audio.addEventListener('pause', () => {
          stopVoiceProgressTick(wrap);
          if (audio.ended) return;
          update();
          syncVoicePlayUi(wrap, false);
          if (activeVoiceAudio === audio) activeVoiceAudio = null;
        });
        update();
      }

      async function toggleVoicePlay(wrap) {
        const audio = wrap?.querySelector?.('audio');
        if (!audio) return;
        bindVoiceEl(wrap);
        Radio.unlockAudioGesture?.();
        flushVoiceWaveWaiters();
        if (activeVoiceAudio && activeVoiceAudio !== audio) {
          pauseActiveVoice();
        }
        if (!audio.paused && activeVoiceAudio === audio) {
          audio.pause();
          return;
        }
        try {
          /* webm: duration às vezes só chega depois — força metadata 1x */
          if (!audio._commsMetaTried) {
            audio._commsMetaTried = true;
            try {
              if (audio.readyState < 1) audio.load();
            } catch {
              /* ignore */
            }
          }
          await audio.play();
          activeVoiceAudio = audio;
          syncVoicePlayUi(wrap, true);
          wrap._voiceUpdate?.();
          startVoiceProgressTick(wrap, audio);
        } catch {
          notify('não deu pra tocar o áudio');
          syncVoicePlayUi(wrap, false);
          stopVoiceProgressTick(wrap);
        }
      }

      $('commsVoiceBtn')?.addEventListener('click', async () => {
        if (voiceRec) {
          await finishVoiceRecord({ send: true });
          return;
        }
        await startVoiceRecord();
      });
      $('commsVoiceCancel')?.addEventListener('click', () => {
        cancelVoiceRecord();
      });
      $('commsVoiceSend')?.addEventListener('click', async () => {
        await finishVoiceRecord({ send: true });
      });

      VoiceCall.bind();

      $('commsFeed')?.addEventListener('click', (e) => {
        const playBtn = e.target.closest('[data-voice-play]');
        if (!playBtn) return;
        e.preventDefault();
        e.stopPropagation();
        const wrap = playBtn.closest('.comms-voice');
        if (wrap) toggleVoicePlay(wrap);
      });

      stopCommsVoice = () => {
        cancelVoiceRecord();
        pauseActiveVoice();
      };

      document.addEventListener(
        'pointerdown',
        () => {
          if (voiceWaveWaiters.size) flushVoiceWaveWaiters();
        },
        { passive: true }
      );

      $('commsForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        if (voiceRec) await cancelVoiceRecord();
        const text = $('commsInput').value.trim();
        if ((!text && !pendingImages.length) || !state.code) {
          keepCommsKeyboard();
          return;
        }
        await sendMessage({ text, images: pendingImages.slice() });
        keepCommsKeyboard();
      });
      // no mobile, o TX rouba o foco e fecha o teclado — impede isso
      $('commsForm')
        ?.querySelector('button[type="submit"]')
        ?.addEventListener('pointerdown', (e) => {
          e.preventDefault();
        });

      $('commsStickerBtn')?.addEventListener('click', () => {
        const tray = $('commsStickers');
        if (!tray) return;
        tray.hidden = !tray.hidden;
      });
      $('commsStickers')?.addEventListener('click', async (e) => {
        if (e.target.closest('#commsStickerAdd') || e.target.closest('.comms-sticker-add')) {
          openStickerMaker();
          return;
        }
        const btn = e.target.closest('[data-sticker]');
        if (!btn || !state.code) return;
        const id = btn.dataset.sticker;
        const meta = STICKERS[id];
        if (meta?.custom) {
          await sendMessage({
            stickerCustom: meta.src?.startsWith('data:')
              ? {
                  id,
                  data: meta.src,
                  creator: meta.creator,
                  description: meta.description,
                }
              : { id },
          });
        } else {
          await sendMessage({ sticker: id });
        }
        const tray = $('commsStickers');
        if (tray) tray.hidden = true;
        scrollFeedToEnd(true);
        setTimeout(() => scrollFeedToEnd(true), 200);
      });

      $('commsStickerMakerClose')?.addEventListener('click', closeStickerMaker);
      $('commsStickerMakerCancel')?.addEventListener('click', closeStickerMaker);
      $('commsStickerMaker')?.addEventListener('click', (e) => {
        if (e.target === $('commsStickerMaker')) closeStickerMaker();
      });
      $('commsStickerMakerFile')?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        const prev = $('commsStickerMakerPreview');
        const save = $('commsStickerMakerSave');
        showStickerForge(true);
        setStickerForgeProgress(12, 'lendo arquivo…');
        try {
          await wait(180);
          setStickerForgeProgress(38, 'processando mídia…');
          const prepared = await prepareStickerFile(file);
          setStickerForgeProgress(72, 'montando preview…');
          await wait(160);
          stickerDraft = prepared;
          if (prev) {
            prev.hidden = false;
            prev.innerHTML =
              prepared.kind === 'video'
                ? `<video src="${prepared.data}" autoplay loop muted playsinline></video>`
                : `<img src="${prepared.data}" alt="preview" />`;
          }
          setStickerForgeProgress(100, 'pronta pra assinar');
          await wait(280);
          showStickerForge(false);
          if (save) save.disabled = false;
        } catch (err) {
          stickerDraft = null;
          if (prev) {
            prev.hidden = true;
            prev.innerHTML = '';
          }
          if (save) save.disabled = true;
          showStickerForge(false);
          notify(err.message || 'arquivo inválido');
        }
      });
      $('commsStickerMakerSave')?.addEventListener('click', async () => {
        if (!stickerDraft?.data || !state.code) return;
        const creator = state.name || callsign(false) || 'anon';
        const description = ($('commsStickerMakerDesc')?.value || '').trim().slice(0, 80);
        const save = $('commsStickerMakerSave');
        if (save) save.disabled = true;
        showStickerForge(true);
        setStickerForgeProgress(18, 'forjando figurinha…');
        /* gif/vídeo: server converte pra webp animado na hora de salvar */
        await wait(220);
        setStickerForgeProgress(48, 'gravando no deck…');
        const ok = await sendMessage({
          stickerCustom: {
            data: stickerDraft.data,
            creator,
            description,
          },
        });
        if (!ok) {
          showStickerForge(false);
          if (save) save.disabled = false;
          return;
        }
        setStickerForgeProgress(82, 'selando pra sempre…');
        await loadStickers();
        setStickerForgeProgress(100, 'pronta · ficou pra sempre');
        await wait(520);
        closeStickerMaker();
        const tray = $('commsStickers');
        if (tray) tray.hidden = false;
        notify('figurinha criada · ficou na bandeja');
      });

      $('commsFeed')?.addEventListener('click', (e) => {
        const stEl = e.target.closest('.comms-sticker');
        if (!stEl) return;
        e.stopPropagation();
        const msgEl = stEl.closest('.comms-msg');
        const meta = stickerMetaOf(msgEl?._msg) || STICKERS[stEl.dataset.stickerId];
        if (!meta) return;
        const normalized =
          meta.src
            ? meta
            : {
                src: typeof meta === 'string' ? meta : meta.src,
                kind: typeof meta === 'string' ? 'image' : meta.kind,
                creator: typeof meta === 'string' ? '' : meta.creator,
                description: typeof meta === 'string' ? '' : meta.description,
              };
        showStickerInfo(normalized);
      });
      $('commsStickerInfoOk')?.addEventListener('click', hideStickerInfo);
      $('commsStickerInfo')?.addEventListener('click', (e) => {
        if (e.target === $('commsStickerInfo')) hideStickerInfo();
      });

      $('commsAttachClear')?.addEventListener('click', clearAttach);
      $('commsAttachList')?.addEventListener('click', (e) => {
        if (e.target.closest('[data-add-more]')) {
          if (pendingImages.length >= MAX_PENDING) {
            notify(`máx. ${MAX_PENDING} imagens por mensagem`);
            return;
          }
          $('commsFile')?.click();
          return;
        }
        const btn = e.target.closest('[data-rm]');
        if (!btn) return;
        const i = Number(btn.dataset.rm);
        if (Number.isNaN(i)) return;
        pendingImages.splice(i, 1);
        renderAttachBar();
      });
      $('commsFile')?.addEventListener('change', async (e) => {
        const files = [...(e.target.files || [])];
        e.target.value = '';
        for (const file of files) {
          if (pendingImages.length >= MAX_PENDING) {
            notify(`máx. ${MAX_PENDING} imagens por mensagem`);
            break;
          }
          try {
            const data = await prepareAttachFile(file);
            addAttach(data);
          } catch (err) {
            notify(err.message || 'não deu pra usar essa imagem');
          }
        }
      });

      const onPasteImage = async (e) => {
        if (!state.code) return;
        const items = [...(e.clipboardData?.items || [])];
        const imageItems = items.filter((item) => item.type.startsWith('image/'));
        if (!imageItems.length) return;
        e.preventDefault();
        for (const item of imageItems) {
          if (pendingImages.length >= MAX_PENDING) {
            notify(`máx. ${MAX_PENDING} imagens por mensagem`);
            break;
          }
          const file = item.getAsFile();
          if (!file) continue;
          try {
            const data = await prepareAttachFile(file);
            addAttach(data);
          } catch (err) {
            notify(err.message || 'imagem inválida');
          }
        }
        if (pendingImages.length) notify(`${pendingImages.length} imagem(ns) · manda com TX`);
      };
      $('commsInput')?.addEventListener('paste', onPasteImage);
      $('commsForm')?.addEventListener('paste', onPasteImage);

      $('commsFeed')?.addEventListener('click', (e) => {
        const dl = e.target.closest('.comms-media-dl');
        if (dl) {
          e.preventDefault();
          e.stopPropagation();
          const wrap = dl.closest('.comms-pic-wrap');
          const src =
            wrap?.querySelector('.comms-pic')?.currentSrc ||
            wrap?.querySelector('.comms-pic')?.src ||
            decodeURIComponent(dl.dataset.dlSrc || '');
          const name = dl.dataset.dlName || 'comms';
          downloadMediaSrc(src, name);
          return;
        }
        const pic = e.target.closest('.comms-pic');
        if (!pic?.src) return;
        e.preventDefault();
        e.stopPropagation();
        const msgEl = pic.closest('.comms-msg');
        const m = msgEl?._msg;
        const wrap = pic.closest('.comms-pics') || pic.parentElement;
        const all = [...(wrap?.querySelectorAll('.comms-pic') || [pic])]
          .map((el) => el.src)
          .filter(Boolean);
        const start = Math.max(0, all.indexOf(pic.src));
        openLightbox(all.length ? all : [pic.src], start, {
          name: m?.name || '',
          peerId: m?.peerId || '',
        });
      });

      /* clique no quote → scroll até mensagem original + highlight */
      $('commsFeed')?.addEventListener('click', (e) => {
        const quote = e.target.closest('.comms-quote[data-reply-id]');
        if (!quote) return;
        e.preventDefault();
        e.stopPropagation();
        const replyId = quote.dataset.replyId;
        if (!replyId) return;
        const feed = $('commsFeed');
        if (!feed) return;
        const targetMsg = feed.querySelector(`.comms-msg[data-id="${escapeHtml(replyId)}"]`);
        if (!targetMsg) return;
        targetMsg.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const highlightStyle = visualApplied.highlightStyle || 'pulse';
        const isMe = targetMsg.classList.contains('me');
        const highlightColor = isMe ? (visualApplied.highlightColorMe || '#fff') : (visualApplied.highlightColorThem || '#000');
        targetMsg.classList.remove('highlighted');
        targetMsg.removeAttribute('data-highlight-style');
        targetMsg.style.removeProperty('--highlight-color');
        void targetMsg.offsetWidth;
        targetMsg.classList.add('highlighted');
        targetMsg.setAttribute('data-highlight-style', highlightStyle);
        targetMsg.style.setProperty('--highlight-color', highlightColor);
        setTimeout(() => {
          targetMsg.classList.remove('highlighted');
          targetMsg.removeAttribute('data-highlight-style');
          targetMsg.style.removeProperty('--highlight-color');
        }, 4000);
      });

      $('commsLightboxDl')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const src = lightboxGallery[lightboxIndex];
        if (!src) return;
        downloadMediaSrc(src, lightboxFrom?.name || 'comms');
      });

      $('commsLightboxClose')?.addEventListener('click', (e) => {
        e.stopPropagation();
        closeLightbox();
      });
      $('commsLightboxPrev')?.addEventListener('click', (e) => {
        e.stopPropagation();
        stepLightbox(-1);
      });
      $('commsLightboxNext')?.addEventListener('click', (e) => {
        e.stopPropagation();
        stepLightbox(1);
      });
      $('commsLightboxDots')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-dot]');
        if (!btn) return;
        e.stopPropagation();
        const i = Number(btn.dataset.dot);
        if (Number.isNaN(i)) return;
        lightboxIndex = i;
        showLightboxSlide();
      });
      $('commsLightboxTipOk')?.addEventListener('click', (e) => {
        e.stopPropagation();
        dismissLightboxTip();
      });
      $('commsLightboxTip')?.addEventListener('click', (e) => {
        // toca no card = próxima animação; fundo = fecha tutorial
        if (e.target.closest('.comms-lightbox-tip-card') && !e.target.closest('#commsLightboxTipOk')) {
          e.stopPropagation();
          setTipStep(tipStep + 1);
          clearInterval(tipTimer);
          tipTimer = setInterval(() => setTipStep(tipStep + 1), 2600);
          return;
        }
        if (e.target === $('commsLightboxTip')) dismissLightboxTip();
      });
      $('commsLightbox')?.addEventListener('click', (e) => {
        if (e.target === $('commsLightbox')) {
          if (lbScale > 1.05) resetLightboxZoom();
          else closeLightbox();
        }
      });
      document.addEventListener('keydown', (e) => {
        if ($('commsLightbox')?.hidden) return;
        if (e.key === 'Escape') {
          if (!$('commsLightboxTip')?.hidden) dismissLightboxTip();
          else if (lbScale > 1.05) resetLightboxZoom();
          else closeLightbox();
        }
        if (e.key === 'ArrowLeft') stepLightbox(-1);
        if (e.key === 'ArrowRight') stepLightbox(1);
        if (e.key === '+' || e.key === '=') setLightboxZoom(lbScale + 0.35);
        if (e.key === '-' || e.key === '_') setLightboxZoom(lbScale - 0.35);
      });

      $('commsInput')?.addEventListener('input', onLocalType);
      $('commsInput')?.addEventListener('focus', () => {
        /* marca teclado na hora — não espera o visualViewport do Android */
        if (
          document.body.classList.contains('comms-locked') &&
          window.matchMedia('(max-width: 820px)').matches
        ) {
          document.body.classList.add('comms-kb');
        }
        syncVisualViewport();
        pollViewportWhileFocused();
        setTimeout(() => {
          syncVisualViewport();
          scrollFeedToEnd(true);
        }, 50);
        setTimeout(() => syncVisualViewport(), 250);
        setTimeout(() => {
          syncVisualViewport();
          scrollFeedToEnd(true);
        }, 450);
      });
      $('commsInput')?.addEventListener('blur', () => {
        clearTimeout(typingIdle);
        setTyping(false);
        clearInterval(vvPollTimer);
        vvPollTimer = null;
        /* tira o modo teclado; se o teclado ainda estiver abrindo, o sync recoloca */
          document.body.classList.remove('comms-kb');
        setTimeout(() => syncVisualViewport(), 80);
        setTimeout(() => syncVisualViewport(), 280);
      });
      $('commsJoinCode').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          join();
        }
      });
      $('commsInviteJoin')?.addEventListener('click', () => join());
      $('commsInviteDismiss')?.addEventListener('click', dismissInvite);

      // deep link ?comms=CODE&from=NICK&fromId=PEER — não bloqueia reconnect dos membros
      const params = new URLSearchParams(location.search);
      const deep = String(params.get('comms') || '')
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .slice(0, 8);
      const fromNick = String(params.get('from') || '').trim().slice(0, 24);
      const fromId = String(params.get('fromId') || '')
        .trim()
        .replace(/[^a-f0-9]/gi, '')
        .slice(0, 32);
      if (deep) $('commsJoinCode').value = deep;
      if (deep && fromNick && !(saved.code && saved.peerId)) {
        showInviteFromLink(fromNick, deep, fromId);
      }

      if (saved.code && saved.peerId) {
        // refresh / fechar aba sem "sair": criador e membros voltam pro canal
        state.code = saved.code;
        state.peerId = saved.peerId;
        state.name = saved.name || callsign() || 'ghost';
        state.seat = saved.seat || '';
        if ($('commsJoinCode') && !$('commsJoinCode').value) {
          $('commsJoinCode').value = saved.code;
        }
        setTimeout(async () => {
          while (
            document.body.classList.contains('deck-welcome-open') ||
            document.body.classList.contains('deck-assembling') ||
            assembleRunning
          ) {
            await sleep(200);
          }
          $('commsLobbyHint').textContent = `reconnectando ${saved.code}…`;
          setTab('comms');
          const back = await tryRejoinWithRetry(6);
          if (back) {
            await enterRoom(back);
            $('commsLobbyHint').textContent = 'de volta ao canal';
          } else {
            await dropToLobbySoft('não reconnectou agora — usa “voltar ao canal”');
          }
        }, 250);
      } else if (deep) {
        setTimeout(() => setTab('comms'), 200);
      }
    }

    return {
      wire,
      onEnter() {
        activeTab = true;
        if (state.code) startPoll();
      },
      onLeaveTab() {
        // canal ativo = tela travada em COMMS; não sai
        if (document.body.classList.contains('comms-locked')) {
          activeTab = true;
          return;
        }
        activeTab = false;
        // continua heartbeat mais lento — NÃO encerra o canal
        if (state.code && state.peerId) startPoll();
      },
      isLocked() {
        return document.body.classList.contains('comms-locked');
      },
    };
  })();

  /* —— PLAY · D>E>A>T>H>M>E>T>A>L —— */
  const AlbumPlayer = (() => {
    const audio = () => $('playAudio');
    let tracks = [];
    let index = 0;
    let loaded = false;
    let loading = false;
    let seeking = false;

    /* visualizer */
    let actx = null;
    let analyser = null;
    let sourceNode = null;
    let vizRaf = 0;
    let vizMode = 'bars';
    let vizRunning = false;
    const freq = new Uint8Array(128);
    const wave = new Uint8Array(256);

    function fmt(sec) {
      const s = Math.max(0, Math.floor(sec || 0));
      const m = Math.floor(s / 60);
      return `${m}:${String(s % 60).padStart(2, '0')}`;
    }

    function setHint(t) {
      const el = $('playHint');
      if (el) el.textContent = t;
    }

    function ensureAudioGraph() {
      const a = audio();
      if (!a || sourceNode) return;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      actx = actx || new Ctx();
      analyser = actx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.72;
      sourceNode = actx.createMediaElementSource(a);
      sourceNode.connect(analyser);
      analyser.connect(actx.destination);
    }

    async function resumeCtx() {
      ensureAudioGraph();
      if (actx && actx.state === 'suspended') {
        try {
          await actx.resume();
        } catch {
          /* ignore */
        }
      }
    }

    function resizeViz() {
      const canvas = $('playViz');
      if (!canvas) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = canvas.clientWidth || 640;
      const h = canvas.clientHeight || 110;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function drawIdle(ctx, w, h) {
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = 'rgba(244,241,234,0.12)';
      ctx.beginPath();
      ctx.moveTo(0, h * 0.5);
      ctx.lineTo(w, h * 0.5);
      ctx.stroke();
      ctx.fillStyle = 'rgba(244,241,234,0.28)';
      ctx.font = '11px Courier New, monospace';
      ctx.fillText('viz idle · dá play', 10, h * 0.5 + 4);
    }

    function drawBars(ctx, w, h, data, rot) {
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, w, h);
      const n = 48;
      const gap = 2;
      const bw = (w - gap * (n - 1)) / n;
      for (let i = 0; i < n; i++) {
        const v = data[i] / 255;
        let bh = Math.max(2, v * (h - 8));
        if (rot) {
          bh *= 0.55 + Math.random() * 0.7;
          ctx.fillStyle = i % 5 === 0 ? '#c0392b' : '#e8e2d6';
        } else {
          ctx.fillStyle = '#f4f1ea';
        }
        const x = i * (bw + gap);
        const y = h - bh;
        ctx.fillRect(x, y, Math.max(1, bw), bh);
        if (rot && Math.random() < 0.08) {
          ctx.fillStyle = 'rgba(0,0,0,0.55)';
          ctx.fillRect(x, y + bh * Math.random(), bw, 3);
        }
      }
      if (rot) {
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        for (let y = 0; y < h; y += 3) ctx.fillRect(0, y, w, 1);
      }
    }

    function drawWave(ctx, w, h, data, rot) {
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, w, h);
      ctx.beginPath();
      const mid = h * 0.5;
      for (let i = 0; i < data.length; i++) {
        const x = (i / (data.length - 1)) * w;
        let y = mid + ((data[i] - 128) / 128) * (h * 0.42);
        if (rot && i % 11 === 0) y += (Math.random() - 0.5) * 14;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = rot ? '#c0392b' : '#f4f1ea';
      ctx.lineWidth = rot ? 1.2 : 1.6;
      ctx.stroke();
      if (rot) {
        ctx.strokeStyle = 'rgba(244,241,234,0.25)';
        ctx.beginPath();
        for (let i = 0; i < data.length; i += 3) {
          const x = (i / (data.length - 1)) * w;
          const y = mid + ((data[i] - 128) / 128) * (h * 0.42) + 4;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }

    function tickViz() {
      if (!vizRunning) return;
      const canvas = $('playViz');
      const a = audio();
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      const w = canvas.clientWidth || 640;
      const h = canvas.clientHeight || 110;
      const playing = a && !a.paused && analyser;
      if (!playing) {
        drawIdle(ctx, w, h);
      } else {
        const rot = vizMode === 'rot' || tracks[index]?.rot;
        if (vizMode === 'wave') {
          analyser.getByteTimeDomainData(wave);
          drawWave(ctx, w, h, wave, rot || vizMode === 'rot');
        } else {
          analyser.getByteFrequencyData(freq);
          drawBars(ctx, w, h, freq, vizMode === 'rot' || rot);
        }
      }
      vizRaf = requestAnimationFrame(tickViz);
    }

    function startViz() {
      if (vizRunning) return;
      vizRunning = true;
      resizeViz();
      cancelAnimationFrame(vizRaf);
      vizRaf = requestAnimationFrame(tickViz);
    }

    function stopViz() {
      vizRunning = false;
      cancelAnimationFrame(vizRaf);
    }

    function setVizMode(mode) {
      vizMode = mode;
      document.querySelectorAll('#playVizModes [data-viz]').forEach((b) => {
        b.classList.toggle('on', b.dataset.viz === mode);
      });
    }

    function highlight() {
      document.querySelectorAll('.play-track').forEach((b, i) => {
        b.classList.toggle('on', i === index);
        b.classList.toggle('playing', i === index && !audio()?.paused);
      });
      const t = tracks[index];
      if (!t) return;
      $('playNowTitle').textContent = t.title;
      $('playNowLabel').textContent = t.rot
        ? `faixa ${String(t.num).padStart(2, '0')} · R>O>T`
        : `faixa ${String(t.num).padStart(2, '0')}`;
      $('playDur').textContent = fmt(t.duration || audio()?.duration);
    }

    function renderList() {
      const box = $('playTracks');
      if (!box) return;
      box.innerHTML = tracks
        .map(
          (t, i) => `<li>
          <button type="button" class="track play-track${t.rot ? ' rot' : ''}${i === index ? ' on' : ''}" data-i="${i}">
            <span>${String(t.num).padStart(2, '0')}</span>
            <strong>${escapeHtml(t.title)}</strong>
            <em>${fmt(t.duration)}</em>
          </button>
        </li>`
        )
        .join('');
    }

    function escapeHtml(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    async function ensure() {
      if (loaded || loading) return;
      loading = true;
      setHint('carregando faixas do Bandcamp…');
      try {
        const data = await api('/api/deck/album/deathmetal');
        if (!data.ok || !data.tracks?.length) throw new Error(data.error || 'sem faixas');
        tracks = data.tracks;
        loaded = true;
        renderList();
        highlight();
        setHint(`${tracks.length} faixas · stream Bandcamp · clique ou ▶ play`);
        startViz();
      } catch (err) {
        setHint(`falha: ${err.message || err}. Abre o Bandcamp ↗`);
      } finally {
        loading = false;
      }
    }

    async function playAt(i, autoplay = true) {
      await ensure();
      if (!tracks.length) return;
      index = ((i % tracks.length) + tracks.length) % tracks.length;
      const t = tracks[index];
      const a = audio();
      if (!a || !t) return;
      await resumeCtx();
      a.src = t.stream;
      highlight();
      $('playToggle').textContent = '…';
      try {
        if (autoplay) {
          await a.play();
          await resumeCtx();
          startViz();
          $('playToggle').textContent = '❚❚ pause';
          setHint(`tocando · ${t.title}`);
          window.DeckToys?.bumpXp?.(1);
        } else {
          $('playToggle').textContent = '▶ play';
        }
      } catch (err) {
        $('playToggle').textContent = '▶ play';
        setHint(`não rolou play: ${err.message || 'gesto do browser'}`);
      }
      highlight();
    }

    async function toggle() {
      await ensure();
      const a = audio();
      if (!a) return;
      if (!a.src) {
        await playAt(index, true);
        return;
      }
      if (a.paused) {
        try {
          await resumeCtx();
          await a.play();
          startViz();
          $('playToggle').textContent = '❚❚ pause';
        } catch (err) {
          setHint(err.message || 'play bloqueado');
        }
      } else {
        a.pause();
        $('playToggle').textContent = '▶ play';
      }
      highlight();
    }

    function wire() {
      const a = audio();
      if (!a) return;

      resizeViz();
      window.addEventListener('resize', resizeViz);
      startViz();

      $('playToggle')?.addEventListener('click', () => toggle());
      $('playPrev')?.addEventListener('click', () => playAt(index - 1, true));
      $('playNext')?.addEventListener('click', () => playAt(index + 1, true));

      $('playTracks')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-i]');
        if (!btn) return;
        playAt(Number(btn.dataset.i), true);
      });

      $('playVizModes')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-viz]');
        if (!btn) return;
        setVizMode(btn.dataset.viz);
        startViz();
      });

      const seek = $('playSeek');
      seek?.addEventListener('pointerdown', () => {
        seeking = true;
      });
      seek?.addEventListener('pointerup', () => {
        seeking = false;
        if (a.duration) a.currentTime = (Number(seek.value) / 1000) * a.duration;
      });
      seek?.addEventListener('change', () => {
        if (a.duration) a.currentTime = (Number(seek.value) / 1000) * a.duration;
        seeking = false;
      });

      a.addEventListener('timeupdate', () => {
        $('playCur').textContent = fmt(a.currentTime);
        if (a.duration) $('playDur').textContent = fmt(a.duration);
        if (!seeking && a.duration && seek) {
          seek.value = String(Math.round((a.currentTime / a.duration) * 1000));
        }
      });
      a.addEventListener('ended', () => playAt(index + 1, true));
      a.addEventListener('play', () => {
        $('playToggle').textContent = '❚❚ pause';
        highlight();
        resumeCtx().then(() => startViz());
      });
      a.addEventListener('pause', () => {
        $('playToggle').textContent = '▶ play';
        highlight();
      });
      a.addEventListener('error', () => {
        setHint('erro no stream — tenta de novo ou abre o Bandcamp');
        $('playToggle').textContent = '▶ play';
      });
    }

    return {
      wire,
      ensure,
      startViz,
      stopViz,
    };
  })();

  /* —— WBM · navegador webring (capturas + /pc) —— */
  const Wbm = (() => {
    const CAP = {
      '2001': {
        stamp: '23:41:08 Jun 14, 2001',
        url: 'file:///C:/Nero/burn_session_14.txt',
        page: '2001',
        about: 'local burn log · Nero session',
      },
      '2004': {
        stamp: '09:41:02 Mar 03, 2004',
        url: 'http://www.geocities.com/panchiko_uk/',
        page: '2004',
        about: 'GeoCities free homepage',
      },
      '2007': {
        stamp: '21:06:44 Sep 22, 2007',
        url: 'https://www.myspace.com/panchikouk',
        page: '2007',
        about: 'MySpace profile · Top 8 intact',
      },
      '2009': {
        stamp: '12:04:33 Aug 12, 2009',
        url: 'http://www.panchiko-deathmetal.co.uk/',
        page: '2009',
        about: 'fan site · 8 pages + /hidden/',
        sub: 'home',
      },
      '2012': {
        stamp: '16:08:55 Nov 19, 2012',
        url: 'http://www.panchiko-deathmetal.co.uk/',
        page: '2012',
        about: 'parked domain · ads only',
      },
      '2016': {
        stamp: '14:22:08 Jul 21, 2016',
        url: 'https://boards.4chan.org/mu/',
        outUrl: 'https://boards.4chan.org/mu/',
        page: '2016',
        about: '/mu/ thread · the spark',
      },
      '2017': {
        stamp: '19:33:10 Aug 09, 2017',
        url: 'https://www.youtube.com/watch?v=rotwave',
        page: '2017',
        about: 'YouTube rotting rip · comments',
      },
      '2018': {
        stamp: '03:14:01 Feb 02, 2018',
        url: 'https://pastebin.com/raw/panchikord_leads',
        page: '2018',
        about: 'Panchikord working notes',
      },
      '2019': {
        stamp: '11:02:17 Jan 11, 2019',
        url: 'tel:+44-oxfam-sherwood',
        page: '2019',
        about: 'phone transcript · Oxfam',
      },
      '2020': {
        stamp: '18:02:44 Feb 16, 2020',
        url: 'https://panchiko.bandcamp.com/album/d-e-a-t-h-m-e-t-a-l',
        page: '2020',
        about: 'Bandcamp · reissue day',
      },
      '2021': {
        stamp: '08:15:02 Mar 03, 2021',
        url: 'https://en.wikipedia.org/wiki/Panchiko',
        page: '2021',
        about: 'Wikipedia stub · citations needed',
      },
    };

    /** Webring: capturas locais + PC (já em /pc) — sem mexer no projeto do PC */
    const RING = [
      {
        id: 'pc',
        kind: 'embed',
        label: 'PC · Adri16bit',
        title: 'Adri16bit · personal computer',
        url: '/pc/',
        tags: 'pc desktop computador win98 adri16bit personal computer desk',
        about: 'live desk · mesmo hub · /pc',
        stamp: 'live · local hub',
        live: true,
      },
      {
        id: 'cap-2009',
        kind: 'cap',
        cap: '2009',
        label: 'fan site 09',
        title: 'Panchiko fan site 2009',
        tags: 'panchiko fan site cdr deathmetal nottingham',
      },
      {
        id: 'cap-2004',
        kind: 'cap',
        cap: '2004',
        label: 'GeoCities 04',
        title: 'GeoCities panchiko_uk',
        tags: 'geocities homepage midi under construction',
      },
      {
        id: 'cap-2007',
        kind: 'cap',
        cap: '2007',
        label: 'MySpace 07',
        title: 'MySpace panchikouk',
        tags: 'myspace top8 profile',
      },
      {
        id: 'cap-2001',
        kind: 'cap',
        cap: '2001',
        label: 'burn log 01',
        title: 'Nero burn session',
        tags: 'nero burn cdr session notepad',
      },
      {
        id: 'cap-2016',
        kind: 'cap',
        cap: '2016',
        label: '/mu/ 16',
        title: '4chan /mu/ thread',
        tags: '4chan mu lostwave hunt',
      },
      {
        id: 'cap-2020',
        kind: 'cap',
        cap: '2020',
        label: 'Bandcamp 20',
        title: 'Bandcamp reissue',
        tags: 'bandcamp reissue album',
      },
      {
        id: 'cap-2021',
        kind: 'cap',
        cap: '2021',
        label: 'Wiki 21',
        title: 'Wikipedia Panchiko',
        tags: 'wikipedia stub biography',
      },
      {
        id: 'out-bandcamp',
        kind: 'external',
        label: 'Bandcamp ↗',
        title: 'panchiko.bandcamp.com',
        url: 'https://panchiko.bandcamp.com/',
        tags: 'bandcamp oficial official',
        about: 'oficial · pode bloquear iframe',
        stamp: 'live · external',
      },
    ];

    const SUB_URL = {
      home: 'http://www.panchiko-deathmetal.co.uk/',
      mp3s: 'http://www.panchiko-deathmetal.co.uk/mp3s.htm',
      photos: 'http://www.panchiko-deathmetal.co.uk/photos.htm',
      lyrics: 'http://www.panchiko-deathmetal.co.uk/lyrics.htm',
      guestbook: 'http://www.panchiko-deathmetal.co.uk/guestbook.htm',
      links: 'http://www.panchiko-deathmetal.co.uk/links.htm',
      zine: 'http://www.panchiko-deathmetal.co.uk/zine.htm',
      contact: 'http://www.panchiko-deathmetal.co.uk/contact.htm',
      hidden: 'http://www.panchiko-deathmetal.co.uk/hidden/',
    };
    const SUB_MIDI = {
      home: 'laputa_lofi.mid',
      mp3s: 'winamp_eq.mid',
      photos: 'camera_shutter.mid',
      lyrics: 'typewriter.mid',
      guestbook: 'guestbook_chime.mid',
      links: 'modem_handshake.mid',
      zine: 'xerox_hum.mid',
      contact: 'hold_music.mid',
      hidden: 'static_loop.mid',
    };

    let wired = false;
    let hits = 28;
    let eggArmed = false;
    let currentCap = '2009';
    let ringIndex = 1; /* fan site 09 */
    let mode = 'cap'; /* cap | embed | external */
    const history = [];
    let histPos = -1;
    let histLock = false;

    function showEgg(on) {
      const egg = $('wbmEgg');
      if (!egg) return;
      egg.hidden = !on;
      if (on) {
        window.DeckToys?.bumpXp?.(3);
        notify('side channel · oxfam_note.txt');
        try {
          egg.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        } catch {
          /* ignore */
        }
      }
    }

    function deadLink(name) {
      notify(`HTTP 404 · ${name || 'resource'} · not in archive`);
    }

    function setChrome({ url, stamp, about, extHref }) {
      if ($('wbmUrl') && url != null) $('wbmUrl').value = url;
      if ($('wbmStamp') && stamp != null) $('wbmStamp').textContent = stamp;
      if ($('wbmAbout') && about != null) {
        $('wbmAbout').textContent = about.startsWith('about')
          ? about
          : `about · ${about}`;
      }
      const ext = $('wbmOpenExt');
      if (ext) {
        if (extHref) {
          ext.hidden = false;
          ext.href = extHref;
        } else {
          ext.hidden = true;
        }
      }
      syncHistButtons();
    }

    function syncHistButtons() {
      const back = $('wbmBack');
      const fwd = $('wbmFwd');
      if (back) back.disabled = histPos <= 0;
      if (fwd) fwd.disabled = histPos < 0 || histPos >= history.length - 1;
    }

    function pushHist(entry) {
      if (histLock) return;
      const key = JSON.stringify(entry);
      if (histPos >= 0 && JSON.stringify(history[histPos]) === key) return;
      history.splice(histPos + 1);
      history.push(entry);
      if (history.length > 40) history.shift();
      histPos = history.length - 1;
      syncHistButtons();
    }

    function hideEmbed() {
      const embed = $('wbmEmbed');
      const fail = $('wbmEmbedFail');
      const root = $('wbmRoot');
      root?.classList.remove('is-embed');
      if (embed) {
        embed.hidden = true;
        embed.removeAttribute('src');
        embed.onload = null;
      }
      if (fail) fail.hidden = true;
    }

    function fitEmbedDesktop(iframe) {
      /* só DOM ao vivo no iframe — não mexe nos arquivos do PC */
      try {
        const doc = iframe?.contentDocument;
        if (!doc) return;
        const html = doc.documentElement;
        const body = doc.body;
        if (html) {
          html.style.height = '100%';
          html.style.overflow = 'hidden';
          html.style.background = '#111';
        }
        if (body) {
          body.style.height = '100%';
          body.style.margin = '0';
          body.style.overflow = 'hidden';
          body.style.display = 'flex';
          body.style.alignItems = 'center';
          body.style.justifyContent = 'center';
          body.style.background = '#111';
        }
        const main = doc.querySelector('.main');
        if (main) {
          /* caixa = tamanho real do CRT; o scale centra no meio do frame */
          main.style.width = '1000px';
          main.style.height = '1010px';
          main.style.minHeight = '1010px';
          main.style.maxHeight = 'none';
          main.style.margin = '0';
          main.style.flexShrink = '0';
          main.style.transformOrigin = 'center center';
          main.style.position = 'relative';
        }
      } catch {
        /* ignore */
      }
    }

    function hideCaptures() {
      document.querySelectorAll('.wbm-page').forEach((p) => {
        p.hidden = true;
        p.classList.remove('on');
      });
      const no = $('wbmNoCap');
      if (no) no.hidden = true;
      showEgg(false);
    }

    function paintRingBar() {
      const bar = $('wbmRingBar');
      if (!bar) return;
      const cur = RING[ringIndex];
      bar.innerHTML = RING.map(
        (r, i) =>
          `<button type="button" class="wbm-ring-chip${i === ringIndex ? ' on' : ''}${
            r.live ? ' live' : ''
          }" data-ring="${escapeHtml(r.id)}" role="listitem" title="${escapeHtml(
            r.title || r.label
          )}">${escapeHtml(r.label)}</button>`
      ).join('');
      void cur;
    }

    function setSub(sub) {
      const id = SUB_URL[sub] ? sub : 'home';
      document.querySelectorAll('#wbmPage2009 [data-wbm-subpage]').forEach((el) => {
        const on = el.getAttribute('data-wbm-subpage') === id;
        el.hidden = !on;
        el.classList.toggle('on', on);
      });
      document.querySelectorAll('#wbmNav2009 [data-wbm-sub]').forEach((a) => {
        a.classList.toggle('on', a.getAttribute('data-wbm-sub') === id);
      });
      setChrome({
        url: SUB_URL[id],
        stamp: CAP['2009'].stamp + (id !== 'home' ? ` · /${id}` : ''),
        about: `fan site · /${id}`,
      });
      if ($('wbmMidiName')) $('wbmMidiName').textContent = SUB_MIDI[id] || 'laputa_lofi.mid';
      if (id === 'hidden') eggArmed = true;
      try {
        $('wbmFrame')?.scrollTo?.({ top: 0 });
      } catch {
        /* ignore */
      }
    }

    function openCapEmbed(key, opts = {}) {
      const cap = CAP[key];
      if (!cap?.outUrl) {
        setCapture(key, opts);
        return;
      }
      currentCap = key;
      const ringId = `cap-${key}`;
      const idx = RING.findIndex((r) => r.id === ringId);
      if (idx >= 0) ringIndex = idx;
      paintRingBar();
      document.querySelectorAll('#wbmCal .wbm-dot').forEach((d) => {
        d.classList.toggle('on', d.dataset.cap === key);
      });
      showEmbed(cap.outUrl, {
        displayUrl: cap.url,
        stamp: cap.stamp,
        about: cap.about || '/mu/ thread',
        ringId,
        external: true,
        silentHist: opts.silentHist,
      });
    }

    function setCapture(key, opts = {}) {
      const cap = CAP[key] || CAP['2009'];
      currentCap = key;
      mode = 'cap';
      hideEmbed();
      document.querySelectorAll('#wbmCal .wbm-dot').forEach((d) => {
        d.classList.toggle('on', d.dataset.cap === key);
      });

      const ringHit = RING.findIndex((r) => r.kind === 'cap' && r.cap === key);
      if (ringHit >= 0) ringIndex = ringHit;
      paintRingBar();

      setChrome({
        url: cap.url,
        stamp: cap.stamp,
        about: `about this capture · ${cap.about || ''}`,
        extHref: cap.outUrl || null,
      });

      hideCaptures();
      const no = $('wbmNoCap');
      const msg = $('wbmNoCapMsg');

      if (cap.miss) {
        if (no) no.hidden = false;
        if (msg) msg.textContent = cap.msg || 'This URL has not been archived for the selected date.';
        if (!opts.silentHist) pushHist({ type: 'cap', cap: key });
        return;
      }
      if (no) no.hidden = true;
      const page = document.querySelector(`.wbm-page[data-wbm-page="${cap.page}"]`);
      if (page) {
        page.hidden = false;
        page.classList.add('on');
      }
      if (cap.page === '2009') setSub(opts.sub || cap.sub || 'home');
      if (!opts.silentHist) pushHist({ type: 'cap', cap: key });
    }

    function showEmbed(url, meta = {}) {
      mode = meta.external ? 'external' : 'embed';
      hideCaptures();
      document.querySelectorAll('#wbmCal .wbm-dot').forEach((d) => d.classList.remove('on'));
      const root = $('wbmRoot');
      root?.classList.add('is-embed');
      const embed = $('wbmEmbed');
      const fail = $('wbmEmbedFail');
      if (fail) fail.hidden = true;
      if (!embed) return;
      embed.hidden = false;
      embed.onload = () => {
        if (meta.external) return;
        fitEmbedDesktop(embed);
        /* React monta depois do load */
        setTimeout(() => fitEmbedDesktop(embed), 120);
        setTimeout(() => fitEmbedDesktop(embed), 450);
      };
      embed.src = url;
      setChrome({
        url: meta.displayUrl || url,
        stamp: meta.stamp || 'live',
        about: meta.about || 'webring · live frame',
        extHref: url,
      });
      if (!meta.silentHist) {
        pushHist({
          type: meta.external ? 'external' : 'embed',
          url,
          ringId: meta.ringId || null,
        });
      }
      /* sites externos às vezes bloqueiam — oferece fallback rápido */
      if (meta.external) {
        window.setTimeout(() => {
          if (mode !== 'external') return;
          const open = $('wbmEmbedFailOpen');
          const msg = $('wbmEmbedFailMsg');
          if (open) open.href = url;
          if (msg) {
            msg.textContent =
              'se a janela ficou em branco, o site bloqueou o frame. usa ↗ ou o botão abaixo.';
          }
        }, 1800);
      }
    }

    function goRing(index, opts = {}) {
      const i = ((index % RING.length) + RING.length) % RING.length;
      ringIndex = i;
      paintRingBar();
      const site = RING[i];
      if (!site) return;
      if (site.kind === 'cap') {
        if (CAP[site.cap]?.outUrl) {
          openCapEmbed(site.cap, opts);
          return;
        }
        setCapture(site.cap, opts);
        return;
      }
      if (site.kind === 'embed' || site.kind === 'external') {
        showEmbed(site.url, {
          displayUrl: site.url,
          stamp: site.stamp,
          about: site.about || site.title,
          ringId: site.id,
          external: site.kind === 'external',
          silentHist: opts.silentHist,
        });
      }
    }

    function ringStep(delta) {
      goRing(ringIndex + delta);
      notify(`webring · ${RING[ringIndex]?.label || ''}`);
    }

    function normalizeWbmUrl(raw) {
      return String(raw || '')
        .trim()
        .toLowerCase()
        .replace(/\/+$/, '');
    }

    function matchCaptureFromUrl(raw) {
      const lower = normalizeWbmUrl(raw);
      if (!lower) return null;

      for (const [sub, url] of Object.entries(SUB_URL)) {
        if (lower === normalizeWbmUrl(url)) return { cap: '2009', sub };
      }

      const hits = [];
      for (const [key, cap] of Object.entries(CAP)) {
        if (!cap.url || cap.miss) continue;
        const capUrl = normalizeWbmUrl(cap.url);
        const bare = capUrl.replace(/^https?:\/\//, '');
        const queryBare = lower.replace(/^https?:\/\//, '');
        if (lower === capUrl || queryBare === bare || queryBare.endsWith(`/${bare}`) || queryBare.includes(bare)) {
          hits.push(key);
        }
      }
      if (!hits.length) return null;
      const pick = hits.includes(currentCap) ? currentCap : hits.includes('2009') ? '2009' : hits[0];
      const cap = CAP[pick];
      return { cap: pick, sub: cap.sub || (pick === '2009' ? 'home' : null) };
    }

    function searchRing(q) {
      const raw = String(q || '').trim();
      if (!raw) return null;
      const lower = raw.toLowerCase();

      /* atalhos diretos pro PC */
      if (/^\/?pc\/?$/i.test(raw) || lower === 'pc' || /personal\s*computer|adri16bit|meu\s*pc/.test(lower)) {
        const idx = RING.findIndex((r) => r.id === 'pc');
        return idx >= 0 ? RING[idx] : null;
      }

      /* dominio / URL das capturas fake — nao abrir iframe externo */
      if (/^https?:\/\//i.test(raw) || raw.startsWith('/') || /^[\w.-]+\.[a-z]{2,}/i.test(raw)) {
        const capFromUrl = matchCaptureFromUrl(raw.startsWith('/') ? `${location.origin}${raw}` : raw);
        if (capFromUrl) {
          return {
            kind: 'cap',
            cap: capFromUrl.cap,
            sub: capFromUrl.sub,
            id: `cap-${capFromUrl.cap}`,
            label: CAP[capFromUrl.cap]?.about || capFromUrl.cap,
          };
        }
        const hit = RING.find((r) => r.url && r.url.toLowerCase() === lower);
        if (hit) return hit;
        if (/^https?:\/\//i.test(raw) || raw.startsWith('/')) {
          return { kind: 'external', url: raw.startsWith('/') ? raw : raw, title: raw, id: 'typed' };
        }
      }

      /* match no anel */
      const scored = RING.map((r) => {
        const hay = `${r.label} ${r.title} ${r.tags || ''} ${r.url || ''} ${r.cap || ''}`.toLowerCase();
        let score = 0;
        if (hay.includes(lower)) score += 5;
        lower.split(/\s+/).forEach((w) => {
          if (w.length > 1 && hay.includes(w)) score += 2;
        });
        if (r.cap && lower === r.cap) score += 8;
        if (CAP[raw] || CAP[lower]) score += 10;
        return { r, score };
      })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score);

      if (scored[0]) return scored[0].r;

      /* ano digitado → captura */
      const year = raw.replace(/\D/g, '').slice(-2);
      if (year && CAP[year]) {
        return RING.find((r) => r.cap === year) || { kind: 'cap', cap: year, id: `cap-${year}` };
      }
      return null;
    }

    function navigateQuery(q) {
      const hit = searchRing(q);
      if (!hit) {
        notify('nada no webring · tenta: pc · 2009 · geocities · /mu');
        return;
      }
      if (hit.id && hit.id !== 'typed') {
        const idx = RING.findIndex((r) => r.id === hit.id);
        if (idx >= 0) {
          goRing(idx);
          notify(`GO · ${hit.label || hit.title}`);
          return;
        }
      }
      if (hit.kind === 'cap' && hit.cap) {
        if (CAP[hit.cap]?.outUrl) {
          openCapEmbed(hit.cap);
          notify(`GO · ${hit.label || '/mu/'} · carregando no WBM`);
          return;
        }
        setCapture(hit.cap, { sub: hit.sub });
        notify(`GO · ${hit.label || `capture ${hit.cap}`}`);
        return;
      }
      if (hit.url) {
        const idx = RING.findIndex((r) => r.url === hit.url);
        if (idx >= 0) ringIndex = idx;
        paintRingBar();
        showEmbed(hit.url, {
          displayUrl: hit.url,
          about: hit.title || 'typed url',
          stamp: 'live',
          external: /^https?:\/\//i.test(hit.url) && !hit.url.includes(location.host),
          ringId: hit.id,
        });
        notify(`GO · ${hit.url}`);
      }
    }

    function histGo(pos) {
      if (pos < 0 || pos >= history.length) return;
      histLock = true;
      histPos = pos;
      const e = history[pos];
      try {
        if (e.type === 'cap') setCapture(e.cap, { silentHist: true });
        else if (e.type === 'embed' || e.type === 'external') {
          if (e.ringId) {
            const idx = RING.findIndex((r) => r.id === e.ringId);
            if (idx >= 0) {
              goRing(idx, { silentHist: true });
              return;
            }
          }
          showEmbed(e.url, {
            silentHist: true,
            external: e.type === 'external',
            ringId: e.ringId,
          });
        }
      } finally {
        histLock = false;
        syncHistButtons();
      }
    }

    function wire() {
      if (wired) return;
      wired = true;
      const root = $('wbmRoot');
      if (!root) return;

      paintRingBar();

      $('wbmCal')?.addEventListener('click', (e) => {
        const dot = e.target.closest('[data-cap]');
        if (!dot) return;
        setCapture(dot.dataset.cap);
      });

      $('wbmRingBar')?.addEventListener('click', (e) => {
        const chip = e.target.closest('[data-ring]');
        if (!chip) return;
        const idx = RING.findIndex((r) => r.id === chip.dataset.ring);
        if (idx >= 0) goRing(idx);
      });

      $('wbmRingPrev')?.addEventListener('click', () => ringStep(-1));
      $('wbmRingNext')?.addEventListener('click', () => ringStep(1));
      $('wbmBack')?.addEventListener('click', () => histGo(histPos - 1));
      $('wbmFwd')?.addEventListener('click', () => histGo(histPos + 1));

      const go = () => navigateQuery($('wbmUrl')?.value || '');
      $('wbmGo')?.addEventListener('click', go);
      $('wbmUrl')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          go();
        }
      });

      $('wbmEmbedFailBack')?.addEventListener('click', () => {
        const fan = RING.findIndex((r) => r.id === 'cap-2009');
        goRing(fan >= 0 ? fan : 1);
      });

      root.addEventListener('click', (e) => {
        const ringJump = e.target.closest('[data-wbm-ring]');
        if (ringJump) {
          e.preventDefault();
          const id = ringJump.getAttribute('data-wbm-ring');
          const idx = RING.findIndex((r) => r.id === id);
          if (idx >= 0) goRing(idx);
          return;
        }
        const sub = e.target.closest('[data-wbm-sub]');
        if (sub) {
          e.preventDefault();
          if (currentCap !== '2009' || mode !== 'cap') setCapture('2009');
          setSub(sub.getAttribute('data-wbm-sub'));
          return;
        }
        const dead = e.target.closest('[data-wbm-dead]');
        if (dead) {
          e.preventDefault();
          deadLink(dead.getAttribute('data-wbm-dead'));
          return;
        }
        const muLive = e.target.closest('[data-wbm-mu-live]');
        if (muLive) {
          e.preventDefault();
          openCapEmbed('2016');
          return;
        }
        const jump = e.target.closest('[data-jump]');
        if (jump) {
          e.preventDefault();
          setTab(jump.dataset.jump);
        }
      });

      $('wbmCounter')?.addEventListener('click', () => {
        hits = Math.min(999999, hits + 1);
        const el = $('wbmCounter');
        if (el) el.textContent = String(hits).padStart(6, '0');
        if (hits === 30) {
          notify('~30 CD-Rs · counter coincidência?');
          eggArmed = true;
        }
        if (hits >= 31 && eggArmed) showEgg(true);
      });

      $('wbmMissing')?.addEventListener('click', () => {
        deadLink('oxfam_find.jpg');
        if (eggArmed) showEgg(true);
      });

      $('wbmEggLink')?.addEventListener('click', () => {
        eggArmed = true;
        showEgg(true);
      });

      $('wbmEggFromDir')?.addEventListener('click', () => {
        eggArmed = true;
        showEgg(true);
      });

      $('wbmEggDot')?.addEventListener('click', () => {
        eggArmed = true;
        showEgg(true);
      });

      $('wbmEggClose')?.addEventListener('click', () => showEgg(false));

      $('wbmContactForm')?.addEventListener('submit', (e) => {
        e.preventDefault();
        const hint = $('wbmContactHint');
        if (hint) hint.textContent = '550 relay denied · message stuck in 2009';
        notify('cgi mailer · archive stub only');
      });
    }

    function onEnter() {
      wire();
      const pc = RING.findIndex((r) => r.id === 'pc');
      goRing(pc >= 0 ? pc : 0);
    }

    return { wire, onEnter };
  })();

  /* —— init —— */
  window.notify = notify;
  try {
  setInterval(tickClock, 1000);
  tickClock();
  } catch {
    /* ignore */
  }
  document.body.dataset.tab = 'home';
  try {
  window.DeckToys?.syncXp();
  window.DeckToys?.wireExtras();
  } catch {
    /* ignore */
  }
  // welcome PRIMEIRO — se o resto quebrar, popup já está na tela
  try {
    wireWelcome();
    InstallApp.wire();
    AppBoot.wire();
  } catch (err) {
    console.warn('welcome', err);
  }
  try {
  initAi();
  } catch (err) {
    console.warn('ai', err);
  }
  try {
  wireCart();
  } catch (err) {
    console.warn('cart', err);
  }
  try {
  wireLock();
  } catch (err) {
    console.warn('lock', err);
  }
  try {
    wireFullscreen();
  } catch (err) {
    console.warn('fs', err);
  }
  try {
  Comms.wire();
  } catch (err) {
    console.warn('comms', err);
  }
  try {
  AlbumPlayer.wire();
  } catch (err) {
    console.warn('player', err);
  }
  try {
  bootHome();
  } catch (err) {
    console.warn('boot', err);
  }
})();
