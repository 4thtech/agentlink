// M1-36e: the command a user can paste, for the fixed tool texts (nextStep and hints). tools/ may
// not import the runtime (06 §1), so it cannot see how AgentLink was started; the npx form works
// after the documented install and after a global one. A constant: nothing from a request, a stored
// value or inbound content ever changes it (I-5).
export const NPX_COMMAND = 'npx -y @4thtech-io/agentlink';
