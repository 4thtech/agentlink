/** One third-party package inside the embedded local app. */
export interface BundledPackage {
  readonly name: string;
  readonly from: string;
  readonly license: string;
  readonly copyright?: string;
}
export const BUNDLED: readonly BundledPackage[];
/** The Markdown text of THIRD-PARTY-NOTICES.md. Throws on a missing package or a licence change. */
export function thirdPartyNotices(root?: string): string;
