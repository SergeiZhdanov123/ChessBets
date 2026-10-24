// Illustrated busts for the house bots. Flat shapes, no faces: a likeness
// of style (hair, clothes, colour), not a portrait.

const LOOKS = {
  hikaru: { bg: '#29475c', ring: '#335a74', skin: '#e3b088', skinShade: '#c99572', hair: '#15171c', style: 'short', top: 'hoodie', cloth: '#1d5596', clothShade: '#174679' },
  magnus: { bg: '#3a4f66', ring: '#46607b', skin: '#efc3a0', skinShade: '#d6a682', hair: '#7d522f', style: 'swept', top: 'blazer', cloth: '#1d2838', clothShade: '#151e2b', shirt: '#eef1f5' },
  kasparov: { bg: '#4b3a33', ring: '#5b473e', skin: '#d6a47c', skinShade: '#bb8862', hair: '#2f2622', grey: '#6b625c', style: 'curly', top: 'suit', cloth: '#22262d', clothShade: '#1a1d23', shirt: '#e9ecf0', tie: '#7c1f2c' },
};

function hair(l) {
  if (l.style === 'short') {
    return `<path fill="${l.hair}" d="M33.5 44c-1.6-11 3.2-21 16.6-21.5 13.6-.4 18.5 9.3 16.6 21.4-1.4-4.5-3.4-8.6-6.7-10.4-4.3 2.4-12.6 2.8-19.8.9-3.3 2.1-5.6 5.5-6.7 9.6Z"/>
            <path fill="${l.hair}" d="M40.6 33.8c3.2-4.2 9.1-5.4 13.7-4.6-3.1 1.6-5.6 3.7-6.6 6.3Z" opacity=".9"/>`;
  }
  if (l.style === 'swept') {
    return `<path fill="${l.hair}" d="M33.6 45.5c-2.4-12.6 4.3-23.2 17.3-23.4 11.7-.2 18.2 7.6 16.1 21.6-1-4.1-2.6-7.4-4.9-9.4-6.4 3.1-15.5 2.7-21.5-.6-3.4 2.6-5.6 6.7-7 11.8Z"/>
            <path fill="${l.hair}" d="M38.6 33.2c6.6-6.9 18.7-7.8 26.8-1.5-8.4-2.1-16.6-.6-23.2 3.9Z"/>`;
  }
  // curly, greying at the temples
  const curls = [[37, 36, 5.2], [42, 29.5, 5.8], [49, 26.5, 6.2], [56.5, 27.5, 6], [62.5, 32, 5.4], [65.2, 39, 4.4]];
  return `<g fill="${l.hair}">${curls.map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}"/>`).join('')}</g>
          <path fill="${l.hair}" d="M35 41c2-7 8-11 15-11.4 7.4-.3 13 3.3 15.5 10.4-4.9-3.4-10.4-4.9-15.7-4.7-5.4.1-10.6 2-14.8 5.7Z"/>`;
}

function torso(l) {
  const body = `<path fill="${l.cloth}" d="M10 112c0-24 15.6-38.5 40-38.5S90 88 90 112Z"/>`;
  if (l.top === 'hoodie') {
    return `${body}
      <path fill="${l.clothShade}" d="M34.5 75.6c3.2 6.8 9 10.2 15.5 10.2s12.3-3.4 15.5-10.2c-4.5-1.4-9.8-2.1-15.5-2.1s-11 .7-15.5 2.1Z"/>
      <path stroke="#e9eef3" stroke-width="1.4" stroke-linecap="round" d="M45.5 85.5v9M54.5 85.5v9" fill="none" opacity=".8"/>`;
  }
  const v = `<path fill="${l.shirt}" d="M41.6 74.5 50 92l8.4-17.5c-2.7-.6-5.5-1-8.4-1s-5.7.4-8.4 1Z"/>`;
  const lapels = `<path fill="${l.clothShade}" d="M41.6 74.5 50 92l-4.6 16H36l-2.4-26.6ZM58.4 74.5 50 92l4.6 16H64l2.4-26.6Z" opacity=".9"/>`;
  const tie = l.tie ? `<path fill="${l.tie}" d="M48.2 79.5h3.6l1.6 14.5L50 98.5 46.6 94Z"/><path fill="${l.tie}" d="M47.6 77h4.8l-.6 3h-3.6Z" opacity=".85"/>` : '';
  return `${body}${v}${tie}${lapels}`;
}

export function botAvatar(id, { wide = false } = {}) {
  const l = LOOKS[id] || LOOKS.magnus;
  const vb = wide ? '-35 -6 170 118' : '0 0 100 100';
  return `<svg viewBox="${vb}" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <rect x="-40" y="-10" width="180" height="130" fill="${l.bg}"/>
    <circle cx="50" cy="${wide ? 62 : 58}" r="${wide ? 50 : 40}" fill="${l.ring}"/>
    <g transform="translate(0 ${wide ? 4 : 0})">
      ${torso(l)}
      <path fill="${l.skinShade}" d="M43.5 58h13v16.5c-2 1.6-4.2 2.4-6.5 2.4s-4.5-.8-6.5-2.4Z"/>
      <ellipse cx="34.6" cy="47" rx="3.1" ry="4.6" fill="${l.skinShade}"/>
      <ellipse cx="65.4" cy="47" rx="3.1" ry="4.6" fill="${l.skinShade}"/>
      <path fill="${l.skin}" d="M50 25c9.4 0 16 6.6 16 17.4 0 11.8-7.4 21.2-16 21.2s-16-9.4-16-21.2C34 31.6 40.6 25 50 25Z"/>
      ${hair(l)}
    </g>
  </svg>`;
}

export function userAvatar(name) {
  const palette = ['#2f6b5e', '#5b4a8a', '#7a5230', '#2b5a8a', '#7a3b4f', '#4f6b2b'];
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const bg = palette[h % palette.length];
  const letter = String(name || '?')[0].toUpperCase();
  return `<svg viewBox="0 0 40 40" aria-hidden="true"><rect width="40" height="40" fill="${bg}"/><text x="20" y="26.5" text-anchor="middle" font-size="18" font-weight="800" fill="#fff" font-family="Figtree, sans-serif">${letter.replace(/[<&>]/g, '')}</text></svg>`;
}
