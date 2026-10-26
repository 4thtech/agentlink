// M1-36a-b: the command a user can paste to run AgentLink, for text this package shows (the approval
// page, the owner steps). After the documented install (`npx -y @4thtech-io/agentlink init`) the bare
// `agentlink` is not on the user's PATH, and this package cannot see how the program was started (the
// CLI's `cliPrefix()` can), so it always names the npx form, which works everywhere. A constant: no
// request, stored value or inbound content ever changes it (I-5).
export const CLI_COMMAND = 'npx -y @4thtech-io/agentlink';
