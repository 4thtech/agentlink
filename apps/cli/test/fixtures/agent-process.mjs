// One OS process of the two-process store test (two-process.keychain.test.ts; IR-M1-9k-1 F01).
// It runs the BUILT CLI runtime (dist/) with the real @4thtech-io/node pieces: the OS keychain and the
// agent's SQLite file. The parent talks to it over the fork IPC channel only; nothing is printed.
//
// Roles:
// - `cli`: the owner's CLI process (D-73 (3)). It opens the agent with `openAgent`, applies an
//   owner-signed `approval.decide` for the second request through its own core client (as
//   `agentlink approve <id>` will), and, as a same-user tamper, edits the first request's status
//   column to `approved` with no signed object, through a direct handle on the same store file. It
//   stays open until told to read both rows back.
// - `server`: the MCP-side process. It opens the same agent with `openAgent`, asks the M1a channel
//   about both requests and asks its own core to use each one for its exact action.
import process from 'node:process';
import { openAgentStore } from '@4thtech-io/node';
import { openAgent, readAgentConfig } from '../../dist/runtime/index.js';

const send = (message) =>
  new Promise((resolve) => {
    process.send(message, () => resolve());
  });

const onMessage = () =>
  new Promise((resolve) => {
    process.once('message', resolve);
  });

const rowOf = (store, approvalId) =>
  store.transaction((tx) => {
    const row = tx.get('approvals', { approval_id: approvalId });
    return row === undefined
      ? null
      : { status: row.status, signedDecision: row.signed_decision !== null };
  });

async function cli({ home, name, edited, decided }) {
  const result = await openAgent({ home, agent: name });
  if (result.status !== 'ok') throw Object.assign(new Error('not opened'), { code: result.reason });
  const { agent } = result;
  const found = await readAgentConfig(home, name);
  const raw = await openAgentStore(found.config.keyStore, found.config.agentId, found.paths.store);
  try {
    const applied = await agent.client.ownerActions.apply(decided.signedText);
    // The tamper: the status cache says `approved`; no owner signature exists for this row.
    await raw.store.transaction((tx) =>
      tx.update(
        'approvals',
        { approval_id: edited.approvalId },
        { status: 'approved', decided_at: Math.floor(Date.now() / 1000) },
      ),
    );
    await send({ step: 'prepared', pid: process.pid, storePath: agent.paths.store, applied });
    await onMessage(); // the server has finished
    await send({
      step: 'final',
      edited: await rowOf(raw.store, edited.approvalId),
      decided: await rowOf(raw.store, decided.approvalId),
    });
  } finally {
    await raw.close();
    await agent.close();
  }
}

async function server({ home, name, edited, decided }) {
  const result = await openAgent({ home, agent: name });
  if (result.status !== 'ok') throw Object.assign(new Error('not opened'), { code: result.reason });
  const { agent } = result;
  try {
    const editedChannel = await agent.approvals.status(edited.approvalId);
    const editedUse = await agent.client.approvalService.use(
      edited.approvalId,
      edited.action,
      'approval',
    );
    const decidedChannel = await agent.approvals.status(decided.approvalId);
    const decidedUse = await agent.client.approvalService.use(
      decided.approvalId,
      decided.action,
      'approval',
    );
    await send({
      step: 'used',
      pid: process.pid,
      storePath: agent.paths.store,
      editedChannel,
      editedUse,
      decidedChannel,
      decidedUse,
    });
  } finally {
    await agent.close();
  }
}

const task = await onMessage();
try {
  if (task.role === 'cli') await cli(task);
  else if (task.role === 'server') await server(task);
  else throw new Error('unknown role');
} catch (error) {
  await send({ step: 'error', code: error?.code ?? null, name: error?.name ?? null });
  process.exitCode = 1;
}
process.disconnect();
