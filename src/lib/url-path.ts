// A single, shared URL-path normalizer, used everywhere this app compares
// or keys by a page's path rather than its full URL (candidate pages may
// come from a source that stores an absolute URL, or one that stores a
// bare path).
export function pathOf(urlOrPath: string): string {
  try {
    return new URL(urlOrPath).pathname;
  } catch {
    return urlOrPath.startsWith("/") ? urlOrPath : `/${urlOrPath}`;
  }
}
