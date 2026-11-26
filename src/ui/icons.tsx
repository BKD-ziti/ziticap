import type { JSX, SVGAttributes } from 'preact';

type P = SVGAttributes<SVGSVGElement> & { size?: number };

const make = (paths: JSX.Element) =>
  function Icon({ size = 20, ...rest }: P) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={2} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" {...rest}>
        {paths}
      </svg>
    );
  };

export const IPlay = make(<path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none" />);
export const IPause = make(<><rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" /><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" /></>);
export const IBack = make(<path d="M15 18l-6-6 6-6" />);
export const IUndo = make(<><path d="M9 14L4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 010 11H11" /></>);
export const IRedo = make(<><path d="M15 14l5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 000 11H13" /></>);
export const ISettings = make(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" /></>);
export const IUpload = make(<><path d="M12 16V4" /><path d="M7 9l5-5 5 5" /><path d="M5 20h14" /></>);
export const IDownload = make(<><path d="M12 4v12" /><path d="M7 11l5 5 5-5" /><path d="M5 20h14" /></>);
export const IShare = make(<><path d="M12 15V3" /><path d="M8 7l4-4 4 4" /><path d="M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7" /></>);
export const IScissors = make(<><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M20 4L8.12 15.88M14.47 14.48L20 20M8.12 8.12L12 12" /></>);
export const IMerge = make(<><path d="M8 4v5a4 4 0 004 4h0a4 4 0 014 4v3" /><path d="M16 4v5a4 4 0 01-4 4" /><path d="M13 17l3 3 3-3" /></>);
export const ITrash = make(<><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M6 6l1 14h10l1-14" /></>);
export const IPlus = make(<><path d="M12 5v14" /><path d="M5 12h14" /></>);
export const ISearch = make(<><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></>);
export const IWand = make(<><path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8L19 13M17.8 6.2L19 5M3 21l9-9M12.2 6.2L11 5" /></>);
export const IText = make(<><path d="M4 7V4h16v3" /><path d="M9 20h6" /><path d="M12 4v16" /></>);
export const IPalette = make(<><circle cx="13.5" cy="6.5" r="1.5" /><circle cx="17.5" cy="10.5" r="1.5" /><circle cx="8.5" cy="7.5" r="1.5" /><circle cx="6.5" cy="12.5" r="1.5" /><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.5-.67 1.5-1.5 0-.42-.15-.78-.4-1.06-.24-.27-.39-.63-.39-1.04 0-.83.67-1.5 1.5-1.5H16a6 6 0 006-6c0-4.96-4.5-8.9-10-8.9z" /></>);
export const IExport = make(<><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><path d="M17 8l-5-5-5 5" /><path d="M12 3v12" /></>);
export const IMinus = make(<path d="M5 12h14" />);
export const IClose = make(<><path d="M18 6L6 18" /><path d="M6 6l12 12" /></>);
export const IMic = make(<><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0014 0" /><path d="M12 17v5" /></>);
export const IFile = make(<><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><path d="M14 2v6h6" /></>);
export const IClock = make(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>);
export const ICheck = make(<path d="M5 12l5 5L20 7" />);
export const IStepBack = make(<><path d="M11 17l-5-5 5-5" /><path d="M18 17l-5-5 5-5" /></>);
export const IStepFwd = make(<><path d="M13 17l5-5-5-5" /><path d="M6 17l5-5-5-5" /></>);
export const IZoomIn = make(<><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3M11 8v6M8 11h6" /></>);
export const IZoomOut = make(<><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3M8 11h6" /></>);
export const ILock = make(<><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 018 0v4" /></>);
export const IZap = make(<path d="M13 2L4 14h7l-1 8 9-12h-7z" />);
export const ISpeed = make(<><path d="M12 14l4-4" /><path d="M3.3 19a10 10 0 1117.4 0" /></>);
