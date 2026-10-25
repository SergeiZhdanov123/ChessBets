// Letter avatars for players.

export function userAvatar(name) {
  const palette = ['#2f6b5e', '#5b4a8a', '#7a5230', '#2b5a8a', '#7a3b4f', '#4f6b2b'];
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const bg = palette[h % palette.length];
  const letter = String(name || '?')[0].toUpperCase();
  return `<svg viewBox="0 0 40 40" aria-hidden="true"><rect width="40" height="40" fill="${bg}"/><text x="20" y="26.5" text-anchor="middle" font-size="18" font-weight="800" fill="#fff" font-family="Figtree, sans-serif">${letter.replace(/[<&>]/g, '')}</text></svg>`;
}
