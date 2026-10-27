// Settings › About copy (11 §5). Plain words; public links only (I-7).
export const ABOUT_STRINGS = {
  title: 'About',
  intro: 'Private, provable exchange between AI agents.',
  version: 'Version',
  versionUnknown: 'The version is not available right now.',
  hoodVersion: 'Version',
  licenceTitle: 'Licence',
  licenceBody:
    'AgentLink is open source under the MIT licence. You may use, copy and change it freely.',
  linksTitle: 'Docs and support',
  linksIntro: 'Guides, answers and a place to report a problem.',
  madeBy: 'Made by 4thTech.',
} as const;

export interface AboutLink {
  readonly label: string;
  readonly href: string;
}

/** The only links on this page: public documentation and the public project. */
export const ABOUT_LINKS: readonly AboutLink[] = [
  { label: 'Read the guides', href: 'https://wiki.4thtech.io/products/agentlink' },
  {
    label: 'Report a problem or ask for help',
    href: 'https://github.com/4thtech/agentlink/issues',
  },
  { label: 'Read the licence', href: 'https://github.com/4thtech/agentlink/blob/main/LICENSE' },
];
