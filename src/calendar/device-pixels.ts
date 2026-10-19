/**
 * Lengths in whole device pixels, as CSS variables on a window's body: `--ct-2px` and `--ct-3px` are 2 and 3 CSS
 * pixels rounded down to whole device pixels (at least one). At 125 % (Windows scaling, Obsidian's zoom) 2px is 2.5
 * device pixels: a dotted line drew its dots 2 or 3 pixels long and a bar 2 or 3 wide, depending on where each fell
 * (2026-10-20). The calendar's bars and dots are sized with these, so they all come out the same. Follows the ratio
 * as it changes (zoom, another screen); returns what stops following it.
 */
export function wholeDevicePixels(win: Window): () => void {
  let media: MediaQueryList | null = null;
  const apply = (): void => {
    const ratio = win.devicePixelRatio || 1;
    const whole = (px: number) => `${Math.max(1, Math.floor(px * ratio)) / ratio}px`;
    win.document.body.style.setProperty("--ct-2px", whole(2));
    win.document.body.style.setProperty("--ct-3px", whole(3));
    media?.removeEventListener("change", apply);
    media = win.matchMedia(`(resolution: ${ratio}dppx)`);
    media.addEventListener("change", apply);
  };
  apply();
  return () => media?.removeEventListener("change", apply);
}
