import type {PlatformIcon} from './presence';
// Inline vectors use the theme's text/status colors and load no image resources.
const paths:Record<PlatformIcon,string>={
  desktop:'<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>',
  mobile:'<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 5h4m-3 14h2"/>',
  web:'<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a18 18 0 0 0 0 18 18 18 0 0 0 0-18Z"/>',
  vr:'<path d="M5 6h14a3 3 0 0 1 3 3v7a2 2 0 0 1-2 2h-4l-4-3-4 3H4a2 2 0 0 1-2-2V9a3 3 0 0 1 3-3Z"/><circle cx="7" cy="11" r="2"/><circle cx="17" cy="11" r="2"/>',
  console:'<path d="M7 6h10a4 4 0 0 1 4 3l2 9a2 2 0 0 1-3 2l-4-4H8l-4 4a2 2 0 0 1-3-2l2-9a4 4 0 0 1 4-3Z"/><path d="M7 9v5m-2.5-2.5h5M16 10h.01M19 13h.01"/>',
  other:'<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M9 10a3 3 0 0 1 6 0c0 2-3 2-3 4m0 3h.01"/>',
};
export function platformIcon(icon:PlatformIcon):string {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[icon]}</svg>`;
}
