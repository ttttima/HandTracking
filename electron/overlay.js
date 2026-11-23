'use strict';
const CIRC = 2 * Math.PI * 14;
const badge = document.getElementById('badge');
const fill = document.getElementById('fill');
const title = document.getElementById('title');
const detail = document.getElementById('detail');

window.hgBadge.onState((s) => {
  if (s.show) {
    title.textContent = s.title;
    detail.textContent = s.detail;
    badge.dataset.tone = s.tone;
    badge.dataset.hand = s.hand;
    const status = s.tone === 'on' || s.tone === 'off';
    const ring = s.progress >= 0 || status;
    badge.classList.toggle('no-ring', !ring);
    fill.style.strokeDashoffset = String(CIRC * (1 - (s.progress >= 0 ? s.progress : status ? 1 : 0)));
  }
  badge.classList.toggle('show', s.show);
});
