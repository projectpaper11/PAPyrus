// Background image (Rider: Appearance → Background Image): a picture laid over the editor (or the
// whole window) at low opacity. It sits above the code with pointer-events off, the way Rider
// paints it, so every panel keeps its own background color and nothing needs to turn transparent.

const FILL = {
  cover: { size: 'cover', repeat: 'no-repeat' },
  contain: { size: 'contain', repeat: 'no-repeat' },
  center: { size: 'auto', repeat: 'no-repeat' },
  tile: { size: 'auto', repeat: 'repeat' },
  stretch: { size: '100% 100%', repeat: 'no-repeat' },
};

export const FILL_OPTIONS = [['cover', '꽉 채우기 (잘릴 수 있음)'], ['contain', '전체 보이기'], ['center', '원래 크기'], ['tile', '바둑판식'], ['stretch', '늘이기']];
export const ANCHOR_OPTIONS = [
  ['center', '가운데'], ['top', '위'], ['bottom', '아래'], ['left', '왼쪽'], ['right', '오른쪽'],
  ['top left', '왼쪽 위'], ['top right', '오른쪽 위'], ['bottom left', '왼쪽 아래'], ['bottom right', '오른쪽 아래'],
];

/** C:\a b\c#.png -> file:///C:/a%20b/c%23.png */
export function fileUrl(p) {
  const parts = String(p).replace(/\\/g, '/').split('/');
  return 'file:///' + parts.map((s, i) => (i === 0 && /^[A-Za-z]:$/.test(s) ? s : encodeURIComponent(s))).join('/').replace(/^file:\/\/\/\//, 'file:///');
}

export function applyBackground(settings) {
  const img = settings['appearance.backgroundImage'];
  const on = !!img && settings['appearance.backgroundEnabled'] !== false;
  let art = document.getElementById('bg-art');
  if (!on) {
    if (art) art.remove();
    return;
  }
  const host = document.getElementById(settings['appearance.backgroundTarget'] === 'all' ? 'body' : 'editor-area');
  if (!host) return;
  if (!art) {
    art = document.createElement('div');
    art.id = 'bg-art';
  }
  if (art.parentElement !== host) host.append(art);
  const fill = FILL[settings['appearance.backgroundFill']] || FILL.cover;
  const url = `url("${fileUrl(img)}")`;
  if (art.dataset.url !== url) {
    art.style.backgroundImage = url;
    art.dataset.url = url;
  }
  art.style.backgroundSize = fill.size;
  art.style.backgroundRepeat = fill.repeat;
  art.style.backgroundPosition = settings['appearance.backgroundAnchor'] || 'center';
  setBackgroundOpacity(settings['appearance.backgroundOpacity']);
}

/** Live while the slider moves (saved on release). */
export function setBackgroundOpacity(percent) {
  const art = document.getElementById('bg-art');
  const n = Number(percent);
  if (art) art.style.opacity = String(Math.max(0, Math.min(100, Number.isFinite(n) ? n : 15)) / 100);
}
