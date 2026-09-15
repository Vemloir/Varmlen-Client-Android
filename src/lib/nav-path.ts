import { page } from "$app/state";

/**
 * The path the app is actually running on.
 *
 * Tauri serves the bundle from `tauri://localhost` -- no trailing slash -- and
 * WebKitGTK reports that origin as an empty pathname. Nothing in the tab strip is
 * an empty string, so before the first navigation every comparison fails at once:
 * no tab is marked as the current one, and a swipe cannot find the page it is
 * standing on, which reads as "the first tab cannot be swiped until some other tab
 * has been opened by hand". Measured in the installed build, not guessed: the
 * gesture handler logged `path=` with nothing after the equals sign.
 */
export function navPathFrom(pathname: string): string {
  if (pathname === "" || pathname === "index.html" || pathname === "/index.html") {
    return "/";
  }
  return pathname;
}

/** The same, read from the router. Reactive: `page` is a live proxy. */
export function navPath(): string {
  return navPathFrom(page.url.pathname);
}