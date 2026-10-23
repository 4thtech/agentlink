// Page copy, externalized (11 §5.4) and in the 11 §5 vocabulary. Functional and unstyled until
// DESIGN-D1 lands (M1-19). None of these strings is built from the invite.
export const strings = {
  states: {
    none: 'Open the link someone sent you to connect your AI with theirs. This page only shows how to install AgentLink.',
    loading: 'Checking the invite in your browser…',
    expired: 'This invite has expired. Ask the person who sent it for a new one.',
    damaged:
      'This invite is damaged or not supported, so there is nothing to show. Ask the person who sent it for a new one.',
    oversized:
      'This invite is too large to be real, so there is nothing to show. Ask the person who sent it for a new one.',
    ready:
      'Someone invited you to connect with your AI. Check the details below, then copy the text further down into your AI.',
  },
  inviter: {
    label: 'Self-declared',
    expiryPrefix: '',
    expirySuffix: ' UTC',
  },
  prompt: {
    copied: 'Copied.',
    copyFailed: 'Copy did not work. Select the text above and copy it.',
  },
} as const;
