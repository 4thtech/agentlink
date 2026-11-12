// Under the hood paths: the home folder reads as `~`, so the account name never shows on a shared
// screen. Text only.
export function tildePath(path: string): string {
  return path
    .replace(/^(?:\/Users|\/home)\/[^/]+(?=\/|$)/, '~')
    .replace(/^[A-Za-z]:\\Users\\[^\\]+/, '~');
}
