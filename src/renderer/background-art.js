// Background image (Rider: Appearance → Background Image): a picture laid over the editor (or the
// whole window) at low opacity. It sits above the code with pointer-events off, the way Rider
// paints it, so every panel keeps its own background color and nothing needs to turn transparent.
//
// Size and position are worked out in pixels from the picture's own size, so it can be zoomed
// (appearance.backgroundScale) and moved to any spot (appearance.backgroundAnchor "x% y%": that
// point of the picture sits on the same point of the area). The settings preview drags / zooms it.

export const FILL_OPTIONS = [['cover', '꽉 채우기 (잘릴 수 있음)'], ['contain', '전체 보이기'], ['center', '원래 크기'], ['tile', '바둑판식'], ['stretch', '늘이기']];

const KEYWORDS = { left: 0, top: 0, center: 50, right: 100, bottom: 100 };

/** "30% 70%" / "top left" / "center" -> { x, y } in percent (0..100). */
export function parseAnchor(s) {
  const parts = String(s || 'center').trim().split(/\s+/);
  let x = 50;
  let y = 50;
  const pct = parts.map((p) => (p.endsWith('%') ? parseFloat(p) : null));
  if (pct.length >= 2 && pct[0] != null && pct[1] != null) return { x: clamp(pct[0]), y: clamp(pct[1]) };
  for (const p of parts) {
    if (p === 'left' || p === 'right') x = KEYWORDS[p];
    else if (p === 'top' || p === 'bottom') y = KEYWORDS[p];
  }
  return { x, y };
}

export const anchorText = ({ x, y }) => `${Math.round(clamp(x) * 10) / 10}% ${Math.round(clamp(y) * 10) / 10}%`;
const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : 50));

/** The picture's size in an area of box size: { w, h, repeat } (px). */
export function layout(fill, img, box, scale = 1) {
  const s = Math.max(0.1, scale || 1);
  switch (fill) {
    case 'contain': { const k = Math.min(box.w / img.w, box.h / img.h) * s; return { w: img.w * k, h: img.h * k, repeat: 'no-repeat' }; }
    case 'center': return { w: img.w * s, h: img.h * s, repeat: 'no-repeat' };
    case 'tile': return { w: img.w * s, h: img.h * s, repeat: 'repeat' };
    case 'stretch': return { w: box.w * s, h: box.h * s, repeat: 'no-repeat' };
    default: { const k = Math.max(box.w / img.w, box.h / img.h) * s; return { w: img.w * k, h: img.h * k, repeat: 'no-repeat' }; }
  }
}

const sizes = new Map(); // url -> Promise<{ w, h }>
export function imageSize(url) {
  if (!sizes.has(url)) {
    sizes.set(url, new Promise((resolve) => {
      const im = new Image();
      im.onload = () => resolve({ w: im.naturalWidth || 1, h: im.naturalHeight || 1 });
      im.onerror = () => resolve(null);
      im.src = url;
    }));
  }
  return sizes.get(url);
}

/** C:\a b\c#.png -> file:///C:/a%20b/c%23.png */
export function fileUrl(p) {
  const parts = String(p).replace(/\\/g, '/').split('/');
  return 'file:///' + parts.map((s, i) => (i === 0 && /^[A-Za-z]:$/.test(s) ? s : encodeURIComponent(s))).join('/').replace(/^file:\/\/\/\//, 'file:///');
}

/** Paints `el` with the picture as the settings say, for an area of el's own size. */
export async function paint(el, settings, box) {
  const url = fileUrl(settings['appearance.backgroundImage']);
  const css = `url("${url}")`;
  if (el.dataset.url !== css) { el.style.backgroundImage = css; el.dataset.url = css; }
  const img = await imageSize(url);
  const b = box || { w: el.clientWidth, h: el.clientHeight };
  if (!img || !b.w || !b.h) return null;
  const scale = (Number(settings['appearance.backgroundScale']) || 100) / 100;
  const l = layout(settings['appearance.backgroundFill'], img, b, scale);
  el.style.backgroundSize = `${l.w}px ${l.h}px`;
  el.style.backgroundRepeat = l.repeat;
  el.style.backgroundPosition = anchorText(parseAnchor(settings['appearance.backgroundAnchor']));
  return { img, box: b, size: l };
}

let current = null; // the settings last applied (the resize observer repaints with them)
let observer = null;

export function applyBackground(settings) {
  current = settings;
  const on = !!settings['appearance.backgroundImage'] && settings['appearance.backgroundEnabled'] !== false;
  let art = document.getElementById('bg-art');
  if (!on) {
    if (art) art.remove();
    if (observer) { observer.disconnect(); observer = null; }
    return;
  }
  const host = document.getElementById(settings['appearance.backgroundTarget'] === 'all' ? 'body' : 'editor-area');
  if (!host) return;
  if (!art) {
    art = document.createElement('div');
    art.id = 'bg-art';
  }
  if (art.parentElement !== host) {
    host.append(art);
    if (observer) observer.disconnect();
    observer = new ResizeObserver(() => { if (current) paint(art, current); });
    observer.observe(host);
  }
  setBackgroundOpacity(settings['appearance.backgroundOpacity']);
  paint(art, settings);
}

/** Size of the area the picture covers now (the preview copies its shape). */
export function backgroundArea(settings) {
  const host = document.getElementById(settings['appearance.backgroundTarget'] === 'all' ? 'body' : 'editor-area');
  return host ? { w: host.clientWidth, h: host.clientHeight } : { w: 1600, h: 900 };
}

/** Live while the slider moves (saved on release). */
export function setBackgroundOpacity(percent) {
  const art = document.getElementById('bg-art');
  const n = Number(percent);
  if (art) art.style.opacity = String(Math.max(0, Math.min(100, Number.isFinite(n) ? n : 15)) / 100);
}
