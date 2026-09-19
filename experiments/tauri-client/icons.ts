const paths = {
  home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z"/>',
  library:
    '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m3 16 5-5 4 4 3-3 6 6"/><circle cx="16" cy="8" r="1"/>',
  market:
    '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  hide: '<path d="M3 4h18v13H3zM8 21h8m-4-4v4M7 10h10"/>',
  wallpaper:
    '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m3 15.5 5.5-5.5 6 6m-2.5-2.5 3-3 6 6"/><circle cx="16" cy="8" r="1"/>',
  desktop: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>',
  chevron: '<path d="m7 10 5 5 5-5"/>',
  exit: '<path d="m16 8 4 4-4 4m4-4H9M12 4H4v16h8"/>',
  play: '<path d="m8 4 12 8-12 8Z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="1"/>',
  volume: '<path d="M11 4 6 8H3v8h3l5 4zM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
  share: '<path d="M12 15V3m-4 4 4-4 4 4M5 12v8h14v-8"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
};
export const icon = (name: keyof typeof paths) =>
  `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
