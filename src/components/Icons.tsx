// MyEditor's own icon set: simple 20x20 strokes, drawn for this app.
import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;
const base = (props: P) => ({
  width: 18,
  height: 18,
  viewBox: '0 0 20 20',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  ...props,
});

export const Logo = (props: P) => (
  <svg width={26} height={26} viewBox="0 0 26 26" aria-hidden {...props}>
    <rect x="1" y="1" width="24" height="24" rx="7" fill="var(--accent)" />
    <rect x="5" y="8" width="9" height="4" rx="2" fill="var(--bg)" />
    <rect x="11" y="14" width="10" height="4" rx="2" fill="var(--bg)" opacity="0.75" />
    <rect x="12.4" y="5" width="1.6" height="16" rx="0.8" fill="var(--bg)" />
  </svg>
);

export const IconPlay = (p: P) => (
  <svg {...base(p)}>
    <path d="M6 4.5v11l9-5.5z" fill="currentColor" stroke="none" />
  </svg>
);
export const IconPause = (p: P) => (
  <svg {...base(p)}>
    <rect x="5" y="4.5" width="3.2" height="11" rx="1" fill="currentColor" stroke="none" />
    <rect x="11.8" y="4.5" width="3.2" height="11" rx="1" fill="currentColor" stroke="none" />
  </svg>
);
export const IconToStart = (p: P) => (
  <svg {...base(p)}>
    <path d="M5 4.5v11M15 5l-7 5 7 5z" />
  </svg>
);
export const IconCut = (p: P) => (
  <svg {...base(p)}>
    <path d="M10 2.5v15" strokeDasharray="2 2" />
    <path d="M6.5 6 10 10l3.5-4M6.5 14 10 10l3.5 4" />
  </svg>
);
export const IconTrash = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 6h12M8 6V4h4v2M5.5 6l.8 10h7.4l.8-10" />
  </svg>
);
export const IconDetach = (p: P) => (
  <svg {...base(p)}>
    <rect x="3" y="3" width="14" height="5.5" rx="1.5" />
    <path d="M4.5 15h1.2l1-2 1.6 4 1.6-5 1.4 3h4.2" />
  </svg>
);
export const IconLink = (p: P) => (
  <svg {...base(p)}>
    <path d="M8.5 11.5 11.5 8.5M7 9.5l-1.8 1.8a2.5 2.5 0 0 0 3.5 3.5L10.5 13M13 10.5l1.8-1.8a2.5 2.5 0 0 0-3.5-3.5L9.5 7" />
  </svg>
);
export const IconMix = (p: P) => (
  <svg {...base(p)}>
    <path d="M3 15 17 5M3 5h4l6 10h4" />
  </svg>
);
export const IconUndo = (p: P) => (
  <svg {...base(p)}>
    <path d="M7 5 3.5 8.5 7 12M4 8.5h7.5a4.5 4.5 0 0 1 0 9H9" />
  </svg>
);
export const IconRedo = (p: P) => (
  <svg {...base(p)}>
    <path d="m13 5 3.5 3.5L13 12M16 8.5H8.5a4.5 4.5 0 0 0 0 9H11" />
  </svg>
);
export const IconOpen = (p: P) => (
  <svg {...base(p)}>
    <path d="M2.5 15.5v-10a1 1 0 0 1 1-1h4l1.5 2h7a1 1 0 0 1 1 1v1.5M2.5 15.5l2.2-6h13l-2.2 6z" />
  </svg>
);
export const IconSave = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 3.5h9.5l3 3V16a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5Z" />
    <path d="M6.5 3.5V7h6V3.5M6.5 16.5v-5h7v5" />
  </svg>
);
export const IconExport = (p: P) => (
  <svg {...base(p)}>
    <path d="M10 12.5V3M6.5 6.5 10 3l3.5 3.5M4 11v5h12v-5" />
  </svg>
);
export const IconImport = (p: P) => (
  <svg {...base(p)}>
    <path d="M10 3v9.5M6.5 9 10 12.5 13.5 9M4 13v3h12v-3" />
  </svg>
);
export const IconFilm = (p: P) => (
  <svg {...base(p)}>
    <rect x="3" y="4" width="14" height="12" rx="2" />
    <path d="M7 4v12M13 4v12M3 8h4M3 12h4M13 8h4M13 12h4" />
  </svg>
);
export const IconWave = (p: P) => (
  <svg {...base(p)}>
    <path d="M3 10h1.5M6 7v6M9 4.5v11M12 7.5v5M15 6v8M17 10h0" />
  </svg>
);
export const IconZoomIn = (p: P) => (
  <svg {...base(p)}>
    <circle cx="8.5" cy="8.5" r="5" />
    <path d="m12.5 12.5 4 4M6.5 8.5h4M8.5 6.5v4" />
  </svg>
);
export const IconZoomOut = (p: P) => (
  <svg {...base(p)}>
    <circle cx="8.5" cy="8.5" r="5" />
    <path d="m12.5 12.5 4 4M6.5 8.5h4" />
  </svg>
);
export const IconMarkIn = (p: P) => (
  <svg {...base(p)}>
    <path d="M7 3.5h-2v13h2M9 10h7" />
  </svg>
);
export const IconMarkOut = (p: P) => (
  <svg {...base(p)}>
    <path d="M13 3.5h2v13h-2M4 10h7" />
  </svg>
);
export const IconClose = (p: P) => (
  <svg {...base(p)}>
    <path d="m5 5 10 10M15 5 5 15" />
  </svg>
);
export const IconKeyboard = (p: P) => (
  <svg {...base(p)}>
    <rect x="2.5" y="5" width="15" height="10" rx="2" />
    <path d="M5.5 8h.01M8.5 8h.01M11.5 8h.01M14.5 8h.01M6.5 12h7" />
  </svg>
);
export const IconMagnet = (p: P) => (
  <svg {...base(p)}>
    <path d="M5 3.5v6.5a5 5 0 0 0 10 0V3.5h-3.2V10a1.8 1.8 0 0 1-3.6 0V3.5z" />
    <path d="M5 6.5h3.2M11.8 6.5H15" />
  </svg>
);
export const IconPlus = (p: P) => (
  <svg {...base(p)}>
    <path d="M10 4v12M4 10h12" />
  </svg>
);
export const IconUnlink = (p: P) => (
  <svg {...base(p)}>
    <path d="M7 9.5l-1.8 1.8a2.5 2.5 0 0 0 3.5 3.5L10.5 13M13 10.5l1.8-1.8a2.5 2.5 0 0 0-3.5-3.5L9.5 7M4 4l2 2M16 16l-2-2" />
  </svg>
);
export const IconSpeaker = (p: P) => (
  <svg {...base(p)}>
    <path d="M3.5 8v4h3l4 3.5v-11l-4 3.5z" />
    <path d="M13.5 7.5a3.5 3.5 0 0 1 0 5M15.5 5.5a6.3 6.3 0 0 1 0 9" />
  </svg>
);
export const IconLock = (p: P) => (
  <svg {...base(p)}>
    <rect x="4.5" y="9" width="11" height="8" rx="1.5" />
    <path d="M7 9V6.5a3 3 0 0 1 6 0V9" />
  </svg>
);
export const IconUnlock = (p: P) => (
  <svg {...base(p)}>
    <rect x="4.5" y="9" width="11" height="8" rx="1.5" />
    <path d="M7 9V6.5a3 3 0 0 1 5.8-1" />
  </svg>
);
export const IconEye = (p: P) => (
  <svg {...base(p)}>
    <path d="M2.5 10s2.8-5 7.5-5 7.5 5 7.5 5-2.8 5-7.5 5-7.5-5-7.5-5z" />
    <circle cx="10" cy="10" r="2.2" />
  </svg>
);
export const IconEyeOff = (p: P) => (
  <svg {...base(p)}>
    <path d="M4.5 6.6C3.2 8 2.5 10 2.5 10s2.8 5 7.5 5c1.3 0 2.5-.4 3.5-1M8 5.3c.6-.2 1.3-.3 2-.3 4.7 0 7.5 5 7.5 5s-.6 1.1-1.7 2.3M3.5 3.5l13 13" />
  </svg>
);
export const IconSpeakerOff = (p: P) => (
  <svg {...base(p)}>
    <path d="M3.5 8v4h3l4 3.5v-11l-4 3.5z" />
    <path d="m13.5 8 4 4M17.5 8l-4 4" />
  </svg>
);
export const IconGroup = (p: P) => (
  <svg {...base(p)}>
    <rect x="2.5" y="4" width="8" height="5" rx="1.2" />
    <rect x="9.5" y="11" width="8" height="5" rx="1.2" />
    <path d="M6.5 9v4.5h3M13.5 11V6.5h-3" strokeDasharray="1.6 1.6" />
  </svg>
);
export const IconCompound = (p: P) => (
  <svg {...base(p)}>
    <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
    <path d="M5 7.5h6M5 10h9M5 12.5h4" />
  </svg>
);
export const IconBack = (p: P) => (
  <svg {...base(p)}>
    <path d="M11.5 4.5 6 10l5.5 5.5" />
  </svg>
);
export const IconSparkle = (p: P) => (
  <svg {...base(p)}>
    <path d="M9 3.5l1.4 3.8 3.8 1.4-3.8 1.4L9 13.9l-1.4-3.8-3.8-1.4 3.8-1.4z" />
    <path d="M15 12.5l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z" />
  </svg>
);
export const IconCompare = (p: P) => (
  <svg {...base(p)}>
    <rect x="2.5" y="4.5" width="15" height="11" rx="2" />
    <path d="M10 2.5v15" />
    <path d="M6 10h-1.5M15.5 10H14" />
  </svg>
);
export const IconMove = (p: P) => (
  <svg {...base(p)}>
    <path d="M10 2.5v15M2.5 10h15" />
    <path d="M8 4.5l2-2 2 2M8 15.5l2 2 2-2M4.5 8l-2 2 2 2M15.5 8l2 2-2 2" />
  </svg>
);
export const IconCrop = (p: P) => (
  <svg {...base(p)}>
    <path d="M5.5 2.5v12h12" />
    <path d="M2.5 5.5h12v12" />
  </svg>
);
