const $ = (id) => document.getElementById(id);

function ago(ms) {
  if (!ms) return '';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m ago` : `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function stamp(ms) {
  if (!ms) return '';
  const t = new Date(ms);
  return `${t.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ` +
    t.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function when(ms) {
  return ms ? `${ago(ms)} · ${stamp(ms)}` : '';
}

function toMs(iso) {
  const t = iso ? Date.parse(iso) : NaN;
  return isNaN(t) ? null : t;
}
