// The iOS Simulator pane, as in Claude's desktop app: a live picture of a booted
// simulator in a device frame that you tap, swipe, type into and press the buttons of.
//
// The backend (simulator.py) streams frames and takes input in fractions of the picture
// (0-1 from its top left), so this page never needs the device's size or orientation to
// aim a touch: it only has to know where on the picture the pointer is. Frames are
// acknowledged once shown; the backend sends at most two ahead, so a busy window gets the
// newest picture rather than a backlog.
//
// Pure helpers are exported for node --test (tests/web/simulator.test.mjs).
(function (root) {
  'use strict';

  // HID keyboard usages (page 7) by KeyboardEvent.code: the physical key, whatever the
  // Mac's layout, as a hardware keyboard on the device would send it.
  const KEY_USAGE = (() => {
    const map = {
      Enter: 40, Escape: 41, Backspace: 42, Tab: 43, Space: 44, Minus: 45, Equal: 46,
      BracketLeft: 47, BracketRight: 48, Backslash: 49, Semicolon: 51, Quote: 52,
      Backquote: 53, Comma: 54, Period: 55, Slash: 56, CapsLock: 57,
      Insert: 73, Home: 74, PageUp: 75, Delete: 76, End: 77, PageDown: 78,
      ArrowRight: 79, ArrowLeft: 80, ArrowDown: 81, ArrowUp: 82, NumpadEnter: 88,
      ControlLeft: 224, ShiftLeft: 225, AltLeft: 226, MetaLeft: 227,
      ControlRight: 228, ShiftRight: 229, AltRight: 230, MetaRight: 231,
    };
    for (let i = 0; i < 26; i++) map[`Key${String.fromCharCode(65 + i)}`] = 4 + i;
    for (let i = 1; i <= 9; i++) map[`Digit${i}`] = 29 + i;
    map.Digit0 = 39;
    for (let i = 1; i <= 12; i++) map[`F${i}`] = 57 + i;
    return map;
  })();

  function keyUsage(code) {
    return KEY_USAGE[code] || 0;
  }

  // Where a pointer is on the picture, in fractions of it, kept inside it.
  function toFraction(clientX, clientY, rect) {
    const clamp = (v) => Math.min(1, Math.max(0, v));
    return {
      x: rect.width ? clamp((clientX - rect.left) / rect.width) : 0,
      y: rect.height ? clamp((clientY - rect.top) / rect.height) : 0,
    };
  }

  // ⌥-drag pinches, as in Simulator: a second finger mirrored through the centre.
  function mirror(p) {
    return { x: 1 - p.x, y: 1 - p.y };
  }

  // The device frame's size for a picture of frameW × frameH in a box of boxW × boxH:
  // the screen keeps the picture's shape, the bezel is a share of the short side.
  function fitDevice(boxW, boxH, frameW, frameH, family) {
    if (!(boxW > 0 && boxH > 0 && frameW > 0 && frameH > 0)) return null;
    const share = family === 'iPad' ? 0.035 : 0.045;
    const short = Math.min(frameW, frameH);
    // The bezel grows with the screen, so solve for the scale with it included, then fix
    // the bezel to whole pixels (never thinner than 6) and fit the screen inside the rest.
    const k = Math.min(boxW / (frameW + 2 * share * short), boxH / (frameH + 2 * share * short));
    const bezel = Math.max(6, Math.round(share * short * k));
    const fit = Math.min((boxW - 2 * bezel) / frameW, (boxH - 2 * bezel) / frameH);
    if (!(fit > 0)) return null;
    const screenW = Math.floor(frameW * fit);
    const screenH = Math.floor(frameH * fit);
    const radius = Math.round(Math.min(screenW, screenH) * (family === 'iPad' ? 0.045 : 0.137));
    return { screenW, screenH, bezel, radius, width: screenW + 2 * bezel, height: screenH + 2 * bezel };
  }

  // Frames a second, from the arrival times of the last ones (ms).
  function fps(times, now) {
    const recent = times.filter((t) => now - t <= 1000);
    return recent.length;
  }

  const ICONS = {
    home: '<rect x="4" y="4" width="12" height="12" rx="3.5"/>',
    lock: '<rect x="5" y="9" width="10" height="7.5" rx="1.8"/><path d="M7.2 9V7a2.8 2.8 0 0 1 5.6 0v2"/>',
    left: '<path d="M8 4.5 4.5 8 8 11.5"/><path d="M4.8 8H11a4.5 4.5 0 0 1 0 9h-1"/>',
    right: '<path d="M12 4.5 15.5 8 12 11.5"/><path d="M15.2 8H9a4.5 4.5 0 0 0 0 9h1"/>',
    shot: '<path d="M3.5 7.2c0-1 .8-1.8 1.8-1.8h1.5l1.3-1.9h3.8l1.3 1.9h1.5c1 0 1.8.8 1.8 1.8v7c0 1-.8 1.8-1.8 1.8H5.3c-1 0-1.8-.8-1.8-1.8z"/><circle cx="10" cy="10.6" r="2.8"/>',
    link: '<path d="M8.6 11.4a3 3 0 0 0 4.2 0l2.4-2.4a3 3 0 0 0-4.2-4.2l-1 1"/><path d="M11.4 8.6a3 3 0 0 0-4.2 0L4.8 11a3 3 0 0 0 4.2 4.2l1-1"/>',
    apps: '<rect x="3.5" y="3.5" width="5" height="5" rx="1.4"/><rect x="11.5" y="3.5" width="5" height="5" rx="1.4"/><rect x="3.5" y="11.5" width="5" height="5" rx="1.4"/><rect x="11.5" y="11.5" width="5" height="5" rx="1.4"/>',
    chevron: '<path d="M6 8l4 4 4-4"/>',
  };

  function icon(name, size = 16) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.6');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = ICONS[name]; // our own constant markup, never data
    return svg;
  }

  function node(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function button(cls, label, iconName) {
    const b = node('button', cls);
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    if (iconName) b.append(icon(iconName));
    return b;
  }

  // The pane. send: the window's socket; returns { onEvent(ev) -> bool, unmount() }.
  function mount(container, { send }) {
    const state = {
      devices: null, // null until the first list arrives
      udid: '',
      booting: '',
      status: null,
      frame: null, // { width, height }
      family: 'iPhone',
      times: [],
      touching: null, // the pointer id of the finger that's down
      pinch: false,
      keys: new Set(),
      moveQueued: null,
      lastBox: '',
      closed: false,
    };

    const panel = node('div', 'sim-panel');
    const bar = node('div', 'sim-bar');
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Simulator controls');
    const pick = node('button', 'sim-pick');
    pick.type = 'button';
    pick.setAttribute('aria-haspopup', 'menu');
    const pickName = node('span', 'sim-pick-name', 'Choose a simulator');
    pickName.setAttribute('data-no-i18n', '');
    const pickOs = node('span', 'sim-pick-os');
    pickOs.setAttribute('data-no-i18n', '');
    pick.append(node('span', 'sim-live-dot'), pickName, pickOs, icon('chevron', 12));
    const actions = node('div', 'sim-actions');
    const homeBtn = button('sim-act', 'Home', 'home');
    const lockBtn = button('sim-act', 'Lock', 'lock');
    const leftBtn = button('sim-act', 'Rotate left', 'left');
    const rightBtn = button('sim-act', 'Rotate right', 'right');
    const shotBtn = button('sim-act', 'Screenshot', 'shot');
    const linkBtn = button('sim-act', 'Open a link', 'link');
    const appsBtn = button('sim-act', 'Apps', 'apps');
    actions.append(homeBtn, lockBtn, node('span', 'sim-sep'), leftBtn, rightBtn, node('span', 'sim-sep'), shotBtn, linkBtn, appsBtn);
    bar.append(pick, actions);

    const stage = node('div', 'sim-stage');
    const device = node('div', 'sim-device');
    device.hidden = true;
    const hwLock = button('sim-hw sim-hw-lock', 'Side button');
    const hwUp = button('sim-hw sim-hw-up', 'Volume up');
    const hwDown = button('sim-hw sim-hw-down', 'Volume down');
    const screen = node('div', 'sim-screen');
    screen.tabIndex = 0;
    screen.setAttribute('role', 'application');
    screen.setAttribute('aria-label', 'Simulator screen: click to tap, drag to swipe, type to enter text');
    const img = node('img', 'sim-img');
    img.alt = '';
    img.draggable = false;
    const dotOne = node('span', 'sim-dot');
    const dotTwo = node('span', 'sim-dot');
    dotOne.hidden = dotTwo.hidden = true;
    const veil = node('div', 'sim-veil');
    screen.append(img, dotOne, dotTwo, veil);
    device.append(hwLock, hwUp, hwDown, screen);
    const empty = node('div', 'sim-empty');
    stage.append(device, empty);

    const foot = node('div', 'sim-foot');
    const footState = node('span', 'sim-state');
    const footFps = node('span', 'sim-fps');
    footFps.setAttribute('data-no-i18n', '');
    const footHint = node('span', 'sim-hint', 'Click to tap · drag to swipe · ⌥ drag to pinch · type when focused');
    foot.append(footState, footFps, footHint);

    const pop = node('div', 'sim-pop');
    pop.hidden = true;
    panel.append(bar, stage, foot, pop);
    container.replaceChildren(panel);

    // ── the device list and picker ──

    function current() {
      return (state.devices || []).find((d) => d.udid === state.udid) || null;
    }

    function watch(udid) {
      if (state.udid === udid && state.status && state.status.state !== 'stopped') return;
      releaseInput();
      state.udid = udid;
      state.frame = null;
      state.status = null;
      state.lastBox = '';
      state.times = [];
      img.removeAttribute('src');
      render();
      requestBox(true);
    }

    function openPicker() {
      const list = node('div', 'sim-menu');
      list.setAttribute('role', 'menu');
      const devices = state.devices || [];
      if (!devices.length) list.append(node('p', 'sim-muted', 'No iPhone or iPad simulators. Add one in Xcode.'));
      for (const d of devices.slice(0, 24)) {
        const item = node('button', 'sim-menu-item');
        item.type = 'button';
        item.setAttribute('role', 'menuitem');
        const booted = d.state === 'Booted';
        const dot = node('span', booted ? 'sim-state-dot on' : 'sim-state-dot');
        const name = node('span', 'sim-menu-name', d.name);
        name.setAttribute('data-no-i18n', '');
        const os = node('span', 'sim-menu-os', d.os);
        os.setAttribute('data-no-i18n', '');
        const tag = node('span', 'sim-menu-tag', booted ? (d.udid === state.udid ? 'Showing' : 'Booted') : (state.booting === d.udid ? 'Booting…' : 'Boot'));
        item.append(dot, name, os, tag);
        item.addEventListener('click', () => {
          closePop();
          if (booted) { watch(d.udid); return; }
          state.booting = d.udid;
          send({ type: 'sim_boot', udid: d.udid });
          render();
        });
        list.append(item);
      }
      showPop(list, pick, 'devices');
    }

    function openLink() {
      const form = node('form', 'sim-form');
      const input = node('input', 'sim-field');
      input.type = 'text';
      input.placeholder = 'https://… or myapp://path';
      input.spellcheck = false;
      input.autocapitalize = 'off';
      const go = node('button', 'sim-go', 'Open');
      go.type = 'submit';
      form.append(input, go);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        let url = input.value.trim();
        if (!url) return;
        if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) url = `https://${url}`;
        send({ type: 'sim_open_url', url });
        closePop();
      });
      showPop(form, linkBtn, 'link');
      setTimeout(() => input.focus(), 30);
    }

    function openApps(apps) {
      const list = node('div', 'sim-menu');
      list.setAttribute('role', 'menu');
      if (!apps) list.append(node('p', 'sim-muted', 'Loading apps…'));
      else if (!apps.length) list.append(node('p', 'sim-muted', 'No apps found.'));
      else {
        for (const a of apps) {
          const item = node('button', 'sim-menu-item');
          item.type = 'button';
          item.setAttribute('role', 'menuitem');
          const name = node('span', 'sim-menu-name', a.name);
          name.setAttribute('data-no-i18n', '');
          const id = node('span', 'sim-menu-os', a.bundle);
          id.setAttribute('data-no-i18n', '');
          item.append(node('span', a.user ? 'sim-state-dot on' : 'sim-state-dot'), name, id);
          item.addEventListener('click', () => { send({ type: 'sim_launch', bundle: a.bundle }); closePop(); });
          list.append(item);
        }
      }
      showPop(list, appsBtn, 'apps');
    }

    function showPop(content, anchor, kind) {
      pop.replaceChildren(content);
      pop.dataset.kind = kind;
      pop.hidden = false;
      const box = panel.getBoundingClientRect();
      const a = anchor.getBoundingClientRect();
      pop.style.top = `${a.bottom - box.top + 6}px`;
      const left = Math.min(Math.max(0, a.left - box.left), Math.max(0, box.width - pop.offsetWidth));
      pop.style.left = `${left}px`;
    }

    function closePop() {
      pop.hidden = true;
      pop.replaceChildren();
      pop.dataset.kind = '';
    }

    function onDocDown(e) {
      if (!pop.hidden && !pop.contains(e.target) && !bar.contains(e.target)) closePop();
    }
    document.addEventListener('pointerdown', onDocDown, true);

    const toggle = (kind, open) => () => (!pop.hidden && pop.dataset.kind === kind ? closePop() : open());
    pick.addEventListener('click', toggle('devices', openPicker));
    homeBtn.addEventListener('click', () => send({ type: 'sim_button', name: 'home' }));
    homeBtn.addEventListener('dblclick', () => send({ type: 'sim_button', name: 'app_switcher' }));
    lockBtn.addEventListener('click', () => send({ type: 'sim_button', name: 'lock' }));
    hwLock.addEventListener('click', () => send({ type: 'sim_button', name: 'lock' }));
    hwUp.addEventListener('click', () => send({ type: 'sim_button', name: 'volume_up' }));
    hwDown.addEventListener('click', () => send({ type: 'sim_button', name: 'volume_down' }));
    leftBtn.addEventListener('click', () => send({ type: 'sim_rotate', dir: 'left' }));
    rightBtn.addEventListener('click', () => send({ type: 'sim_rotate', dir: 'right' }));
    shotBtn.addEventListener('click', () => send({ type: 'sim_screenshot' }));
    linkBtn.addEventListener('click', toggle('link', openLink));
    appsBtn.addEventListener('click', () => {
      if (!pop.hidden && pop.dataset.kind === 'apps') { closePop(); return; }
      openApps(null);
      send({ type: 'sim_apps' });
    });

    // ── the picture's size: ask for frames that fill the screen at this display's density ──

    function requestBox(force) {
      if (!state.udid || state.closed) return;
      const box = stage.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.round(Math.max(120, box.width) * dpr);
      const h = Math.round(Math.max(120, box.height) * dpr);
      const key = `${state.udid}:${w}x${h}`;
      if (!force && key === state.lastBox) return;
      state.lastBox = key;
      send({ type: 'sim_stream', udid: state.udid, width: w, height: h });
    }

    function layout() {
      const box = stage.getBoundingClientRect();
      const f = state.frame;
      const fit = f && fitDevice(box.width - 8, box.height - 8, f.width, f.height, state.family);
      if (!fit) return;
      device.style.width = `${fit.width}px`;
      device.style.height = `${fit.height}px`;
      device.style.setProperty('--bezel', `${fit.bezel}px`);
      device.style.setProperty('--radius', `${fit.radius}px`);
      device.classList.toggle('landscape', f.width > f.height);
      // Which way up the device is: its side buttons turn with it.
      for (const o of [2, 3, 4]) device.classList.toggle(`turned-${o}`, f.orientation === o);
      device.classList.toggle('ipad', state.family === 'iPad');
    }

    let resizeTimer = 0;
    const observer = new ResizeObserver(() => {
      layout();
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => requestBox(false), 250);
    });
    observer.observe(stage);

    // ── touches ──

    function live() {
      return Boolean(state.status && state.status.input);
    }

    function showDot(dot, p) {
      dot.hidden = false;
      dot.style.left = `${p.x * 100}%`;
      dot.style.top = `${p.y * 100}%`;
    }

    function touch(phase, p) {
      const msg = { type: 'sim_touch', phase, x: p.x, y: p.y };
      if (state.pinch) {
        const q = mirror(p);
        msg.x2 = q.x;
        msg.y2 = q.y;
        showDot(dotTwo, q);
      }
      showDot(dotOne, p);
      send(msg);
    }

    screen.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !live() || state.touching !== null) return;
      e.preventDefault();
      screen.focus({ preventScroll: true });
      screen.setPointerCapture(e.pointerId);
      state.touching = e.pointerId;
      state.pinch = e.altKey;
      screen.classList.add('touching');
      state.downAt = performance.now();
      touch('down', toFraction(e.clientX, e.clientY, screen.getBoundingClientRect()));
    });
    screen.addEventListener('pointermove', (e) => {
      if (e.pointerId !== state.touching) return;
      // At most one move a frame: the pointer can report far more often than iOS draws.
      const first = state.moveQueued === null;
      state.moveQueued = { x: e.clientX, y: e.clientY };
      if (first) {
        requestAnimationFrame(() => {
          const m = state.moveQueued;
          state.moveQueued = null;
          if (m && state.touching !== null) touch('move', toFraction(m.x, m.y, screen.getBoundingClientRect()));
        });
      }
    });
    // iOS ignores a touch that lifts almost as it lands (a quick trackpad tap): every touch is
    // held at least TOUCH_MIN_MS, as a finger would.
    const TOUCH_MIN_MS = 80;
    const lift = (e) => {
      if (e.pointerId !== state.touching || state.lifting) return;
      state.moveQueued = null;
      state.lifting = true;
      const p = toFraction(e.clientX, e.clientY, screen.getBoundingClientRect());
      const wait = Math.max(0, TOUCH_MIN_MS - (performance.now() - (state.downAt || 0)));
      setTimeout(() => {
        touch('up', p);
        state.touching = null;
        state.lifting = false;
        state.pinch = false;
        screen.classList.remove('touching');
        setTimeout(() => { dotOne.hidden = dotTwo.hidden = true; }, 120);
      }, wait);
    };
    screen.addEventListener('pointerup', lift);
    screen.addEventListener('pointercancel', lift);
    screen.addEventListener('lostpointercapture', lift);
    screen.addEventListener('contextmenu', (e) => e.preventDefault());

    // ── keys: a hardware keyboard on the device while the screen has focus ──

    screen.addEventListener('keydown', (e) => {
      if (!live()) return;
      if (e.metaKey && (e.key === 'v' || e.key === 'V')) return; // the paste event sends the Mac's clipboard
      const usage = keyUsage(e.code);
      if (!usage) return;
      e.preventDefault();
      e.stopPropagation(); // the window's own shortcuts (Esc, ⌘K) stay out of it
      if (e.repeat && state.keys.has(usage)) {
        send({ type: 'sim_key', usage, down: false });
      }
      state.keys.add(usage);
      send({ type: 'sim_key', usage, down: true });
    });
    screen.addEventListener('keyup', (e) => {
      const usage = keyUsage(e.code);
      if (!usage || !state.keys.has(usage)) return;
      e.preventDefault();
      e.stopPropagation();
      state.keys.delete(usage);
      send({ type: 'sim_key', usage, down: false });
    });
    screen.addEventListener('paste', (e) => {
      const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
      if (!text || !live()) return;
      e.preventDefault();
      releaseInput();
      send({ type: 'sim_type', text: text.slice(0, 4000) });
    });
    screen.addEventListener('blur', () => releaseInput());

    function releaseInput() {
      // A key or finger left down on the device would repeat or hold forever.
      for (const usage of state.keys) send({ type: 'sim_key', usage, down: false });
      state.keys.clear();
    }

    // ── what's shown ──

    function setState(text, tone) {
      footState.textContent = text;
      footState.dataset.tone = tone || '';
    }

    function render() {
      const d = current();
      const anyBooted = (state.devices || []).some((x) => x.state === 'Booted');
      pickName.textContent = d ? d.name : state.devices === null ? 'iOS Simulator' : anyBooted ? 'Choose a simulator' : 'No simulator running';
      pickOs.textContent = d ? d.os : '';
      const st = state.status;
      pick.classList.toggle('live', Boolean(st && st.input));
      for (const b of [homeBtn, lockBtn, leftBtn, rightBtn, hwLock, hwUp, hwDown]) b.disabled = !live();
      shotBtn.disabled = linkBtn.disabled = appsBtn.disabled = !state.udid;
      screen.classList.toggle('view-only', Boolean(st) && !st.input);

      if (state.devices === null) {
        device.hidden = true;
        empty.hidden = false;
        empty.replaceChildren(node('p', 'sim-muted', 'Looking for simulators…'));
        setState('', '');
        return;
      }
      if (!state.udid) {
        device.hidden = true;
        empty.hidden = false;
        empty.replaceChildren(emptyState());
        setState('', '');
        return;
      }
      device.hidden = !state.frame;
      empty.hidden = Boolean(state.frame);
      if (!state.frame) {
        empty.replaceChildren(node('div', 'sim-spinner'), node('p', 'sim-muted', 'Starting the live view…'));
      }
      veil.hidden = true;
      if (!st || st.state === 'starting') setState('Connecting…', '');
      else if (st.state === 'live') setState('Live', 'live');
      else if (st.state === 'view-only') setState(st.message || 'View only: input isn’t available.', 'warn');
      else if (st.state === 'error') setState(st.message || 'Something went wrong.', 'warn');
      else if (st.state === 'stopped') { setState('Stopped', ''); veil.hidden = !state.frame; }
      layout();
    }

    function emptyState() {
      const box = node('div', 'sim-empty-card');
      box.append(node('div', 'sim-empty-phone'), node('p', 'sim-empty-title', 'No simulator is running'));
      const devices = (state.devices || []).filter((d) => d.state !== 'Booted').slice(0, 6);
      if (!devices.length) {
        box.append(node('p', 'sim-muted', 'Add an iPhone or iPad simulator in Xcode, then come back.'));
        return box;
      }
      box.append(node('p', 'sim-muted', 'Boot one to see it here:'));
      const ul = node('div', 'sim-boot-list');
      for (const d of devices) {
        const b = node('button', 'sim-boot');
        b.type = 'button';
        const name = node('span', 'sim-menu-name', d.name);
        name.setAttribute('data-no-i18n', '');
        const os = node('span', 'sim-menu-os', d.os);
        os.setAttribute('data-no-i18n', '');
        b.append(name, os, node('span', 'sim-menu-tag', state.booting === d.udid ? 'Booting…' : 'Boot'));
        b.addEventListener('click', () => { state.booting = d.udid; send({ type: 'sim_boot', udid: d.udid }); render(); });
        ul.append(b);
      }
      box.append(ul);
      return box;
    }

    let noticeTimer = 0;
    function notice(text, tone) {
      clearTimeout(noticeTimer);
      footHint.textContent = text;
      footHint.dataset.tone = tone || '';
      noticeTimer = setTimeout(() => {
        footHint.textContent = 'Click to tap · drag to swipe · ⌥ drag to pinch · type when focused';
        footHint.dataset.tone = '';
      }, 4000);
    }

    function onFrame(ev) {
      if (ev.udid !== state.udid) { send({ type: 'sim_ack', seq: ev.seq }); return; }
      const f = state.frame;
      const sized = !f || f.width !== ev.width || f.height !== ev.height || f.orientation !== (ev.orientation || 1);
      state.frame = { width: ev.width, height: ev.height, orientation: ev.orientation || 1 };
      const ack = () => send({ type: 'sim_ack', seq: ev.seq });
      img.onload = ack;
      img.onerror = ack;
      img.src = `data:image/jpeg;base64,${ev.jpeg}`;
      const now = performance.now();
      state.times.push(now);
      if (state.times.length > 90) state.times.splice(0, state.times.length - 90);
      // Written when the count changes, not on every frame (each new text is a layout).
      const rate = `${fps(state.times, now)} fps`;
      if (footFps.textContent !== rate) footFps.textContent = rate;
      if (sized) { render(); requestBox(false); }
    }

    function onEvent(ev) {
      if (state.closed) return false;
      switch (ev.type) {
        case 'sim_list': {
          state.devices = ev.devices || [];
          const booted = state.devices.filter((d) => d.state === 'Booted');
          if (state.booting && booted.some((d) => d.udid === state.booting)) {
            const udid = state.booting;
            state.booting = '';
            watch(udid);
          } else if (!state.udid && booted.length) {
            watch(booted[0].udid);
          } else if (state.udid && !booted.some((d) => d.udid === state.udid)) {
            state.udid = '';
            state.frame = null;
            state.status = null;
            send({ type: 'sim_stream', udid: '' });
          }
          render();
          return true;
        }
        case 'sim_status':
          if (ev.udid !== state.udid) return true;
          state.status = ev;
          if (ev.family) state.family = ev.family;
          render();
          return true;
        case 'sim_frame':
          onFrame(ev);
          return true;
        case 'sim_shot':
          notice(`Saved “${ev.name}” to the Desktop`, 'ok');
          return true;
        case 'sim_apps':
          if (!pop.hidden && pop.dataset.kind === 'apps') openApps(ev.apps || []);
          return true;
        case 'sim_installed':
          notice(`Installed ${ev.name}`, 'ok');
          return true;
        case 'sim_error':
          notice(ev.message || 'That didn’t work on the simulator.', 'warn');
          if (state.booting) { state.booting = ''; render(); }
          return true;
        case 'sim_watch_ended':
          return true;
        default:
          return false;
      }
    }

    function unmount() {
      if (state.closed) return;
      releaseInput();
      state.closed = true;
      observer.disconnect();
      clearTimeout(resizeTimer);
      clearTimeout(noticeTimer);
      document.removeEventListener('pointerdown', onDocDown, true);
      send({ type: 'sim_stream', udid: '' });
      panel.remove();
    }

    render();
    send({ type: 'sim_list' });
    return { el: panel, onEvent, unmount, get udid() { return state.udid; }, get closed() { return state.closed; } };
  }

  const api = { keyUsage, toFraction, mirror, fitDevice, fps, mount, KEY_USAGE };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JarvisSim = api;
})(typeof window === 'object' ? window : globalThis);
