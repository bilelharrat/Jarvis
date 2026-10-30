// The front page's films, lead capture forms, exit-intent bar, structured data, and conversion telemetry.
// 1. Films: each plays, muted, while it is on screen, and pauses when it leaves. Each has a pause button;
//    only the Voice/Tutor film has sound and a sound button. Without this script the browser's own controls show.
// 2. Lead capture (form[data-lead-form]) + exit-intent drawer (#exit-lead): posts to POST /api/leads with
//    UTM parameters and audience segmentation for Klaviyo welcome flows.
// 3. Conversion telemetry: records CTA clicks (sign-in, downloads, case study, Edu pilot) to POST /api/stats/event.
(() => {
  'use strict';

  const isLocalStatic =
    location.hostname === 'localhost' ||
    location.hostname === '127.0.0.1' ||
    location.hostname === '[::1]';

  const sendEvent = (event, detail) => {
    if (isLocalStatic) return;
    try {
      const payload = JSON.stringify({ event, page: location.pathname, detail: detail || '' });
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/stats/event', new Blob([payload], { type: 'application/json' }));
      } else {
        fetch('/api/stats/event', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: payload,
          keepalive: true,
        }).catch(() => {});
      }
    } catch {
      // never block UI
    }
  };

  // ── 1. Walkthrough films ──
  const films = [...document.querySelectorAll('video.fv')];
  if (films.length && 'IntersectionObserver' in window) {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

    function sync(v) {
      const box = v.closest('.fvid'), pp = box.querySelector('.fpp'), snd = box.querySelector('.fsnd');
      pp.dataset.state = v.paused ? 'paused' : 'playing';
      pp.setAttribute('aria-label', v.paused ? 'Play' : 'Pause');
      if (!snd) return;
      snd.setAttribute('aria-pressed', String(!v.muted));
      snd.setAttribute('aria-label', v.muted ? 'Turn sound on' : 'Turn sound off');
    }
    function hush(except) { for (const v of films) if (v !== except && !v.muted) v.muted = true; }

    for (const v of films) {
      const box = v.closest('.fvid'), ctl = box.querySelector('.fctl'), pp = box.querySelector('.fpp'), snd = box.querySelector('.fsnd');
      v.controls = false; ctl.hidden = false;
      pp.addEventListener('click', () => { if (v.paused) { v.dataset.hold = ''; v.play().catch(() => {}); } else { v.dataset.hold = '1'; v.pause(); } });
      v.addEventListener('click', () => pp.click());
      if (snd) snd.addEventListener('click', () => {
        v.muted = !v.muted;
        if (!v.muted) { hush(v); if (v.paused) { v.dataset.hold = ''; v.play().catch(() => {}); } }
      });
      for (const ev of ['play', 'pause', 'volumechange']) v.addEventListener(ev, () => sync(v));
      sync(v);
    }

    const seen = new IntersectionObserver((es) => {
      for (const e of es) {
        const v = e.target;
        if (e.isIntersecting) { if (!reduce && v.dataset.hold !== '1') v.play().catch(() => {}); }
        else { v.pause(); v.muted = true; }
      }
    }, { threshold: 0.6 });
    for (const v of films) seen.observe(v);
    document.addEventListener('visibilitychange', () => { if (document.hidden) for (const v of films) v.pause(); });
  }

  // ── 2. Lead capture forms (email + optional SMS + audience segmentation) ──
  const params = new URLSearchParams(location.search);
  const utm = {
    utm_source: params.get('utm_source') || '',
    utm_medium: params.get('utm_medium') || '',
    utm_campaign: params.get('utm_campaign') || '',
  };

  const markSubscribed = () => {
    try { sessionStorage.setItem('eden_lead_done', '1'); } catch {}
    const exitBar = document.getElementById('exit-lead');
    if (exitBar) exitBar.hidden = true;
  };

  if (params.get('subscribed') === '1') {
    markSubscribed();
    for (const status of document.querySelectorAll('[data-lead-status]')) {
      status.hidden = false;
      status.dataset.kind = 'ok';
      status.textContent = 'You are on the list. Check your inbox for the welcome brief.';
    }
  }

  for (const form of document.querySelectorAll('form[data-lead-form]')) {
    const sourceInput = form.querySelector('input[name="source_page"]');
    if (sourceInput) sourceInput.value = location.pathname;
    for (const [k, v] of Object.entries(utm)) {
      const hidden = form.querySelector(`input[name="${k}"]`);
      if (hidden && v) hidden.value = v;
    }

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const status = form.querySelector('[data-lead-status]');
      const submitBtn = form.querySelector('button[type="submit"]');
      const fd = new FormData(form);
      const payload = {
        email: String(fd.get('email') || '').trim(),
        phone: String(fd.get('phone') || '').trim(),
        consent_sms: Boolean(fd.get('phone') && String(fd.get('phone')).trim()),
        audience: String(fd.get('audience') || form.dataset.audience || 'power-user').trim(),
        organization: String(fd.get('organization') || '').trim(),
        website_url: String(fd.get('website_url') || ''),
        source_page: location.pathname,
        ...utm,
      };
      if (submitBtn) submitBtn.disabled = true;
      if (status) {
        status.hidden = false;
        status.dataset.kind = 'wait';
        status.textContent = 'Saving…';
      }
      try {
        const res = await fetch('/api/leads', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (status) {
            status.dataset.kind = 'err';
            status.textContent = out.message || 'Please check your email or phone number and try again.';
          }
          if (submitBtn) submitBtn.disabled = false;
          return;
        }
        markSubscribed();
        sendEvent('lead_submit', payload.audience);
        form.reset();
        if (status) {
          status.dataset.kind = 'ok';
          status.textContent =
            payload.audience === 'educator'
              ? 'Received. Check your inbox for the educator pilot guide and syllabus setup steps.'
              : payload.audience === 'api'
              ? 'Received. Check your inbox for the VC memo hallucination case study and API onboarding notes.'
              : 'You’re in. Check your inbox for the EVES 432-question benchmark brief and Model Router guide.';
        }
      } catch {
        if (status) {
          status.dataset.kind = 'err';
          status.textContent = 'Connection error. Please try again.';
        }
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  }

  // ── 3. Exit-intent / scroll lead capture bar (#exit-lead) ──
  const exitBar = document.getElementById('exit-lead');
  if (exitBar) {
    let shown = false;
    try {
      shown = sessionStorage.getItem('eden_lead_done') === '1' || sessionStorage.getItem('eden_exit_dismissed') === '1';
    } catch {}

    const showExitBar = (reason) => {
      if (shown) return;
      shown = true;
      exitBar.hidden = false;
      sendEvent('exit_intent_shown', reason);
    };

    const dismissExitBar = () => {
      exitBar.hidden = true;
      try { sessionStorage.setItem('eden_exit_dismissed', '1'); } catch {}
      sendEvent('exit_intent_dismissed', location.pathname);
    };

    for (const btn of document.querySelectorAll('[data-close-lead]')) {
      btn.addEventListener('click', dismissExitBar);
    }
    for (const btn of document.querySelectorAll('[data-open-lead]')) {
      btn.addEventListener('click', () => {
        exitBar.hidden = false;
        const emailInput = exitBar.querySelector('input[type="email"]');
        if (emailInput) emailInput.focus();
      });
    }
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !exitBar.hidden) dismissExitBar();
    });

    const loadedAt = Date.now();
    document.addEventListener('mouseout', (e) => {
      if (shown) return;
      if (Date.now() - loadedAt < 8000) return;
      if (!e.relatedTarget && e.clientY <= 6) showExitBar('mouse_exit');
    });

    let maxScroll = 0;
    window.addEventListener(
      'scroll',
      () => {
        if (shown) return;
        const doc = document.documentElement;
        const scrollable = doc.scrollHeight - doc.clientHeight;
        if (scrollable <= 400) return;
        const ratio = window.scrollY / scrollable;
        if (ratio > maxScroll) maxScroll = ratio;
        else if (maxScroll > 0.65 && ratio < maxScroll - 0.15) showExitBar('scroll_up');
      },
      { passive: true },
    );
  }

  // ── 4. Conversion CTA telemetry ──
  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (href.startsWith('/signin') || href.includes('/signin?')) {
      sendEvent(href.includes('edu') ? 'cta_edu_pilot' : 'cta_signin', href);
    } else if (href === '/download/mac' || href === '/eden-code/download' || href === '/jarvis/download') {
      sendEvent('cta_download_mac', href);
    } else if (href.includes('/windows')) {
      sendEvent('cta_download_windows', href);
    } else if (href.includes('/guides')) {
      sendEvent('cta_case_study', href);
    } else if (href.includes('#api') || href.includes('Eden%20Router%20API')) {
      sendEvent('cta_router_api', href);
    }
  });
})();
