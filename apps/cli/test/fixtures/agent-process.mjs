// One OS process of the two-process store test (two-process.keychain.test.ts; IR-M1-9k-1 F01).
// It runs the BUILT CLI runtime (dist/) with the real @agentlink/node pieces: the OS keychain and the
// agent's SQLite file. The parent talks to it over the fork IPC channel only; nothing is printed.
//
// Roles:
// - `writer`: the server side. Opens the agent's store directly (as its core would), writes one
//   pending approval row with a sealed action, then edits the row's status to `approved` without
//   any signed object (the attack of 06 §2.5 step 4). It stays open until told to read the row back
//   and exit, so both processes hold the store at the same time.
// - `reader`: the other process. Opens the agent with `openAgent` (real deps), asks the M1a channel
//   for the row and asks its own core to use the approval for that exact action.
import process from 'node:process';
import { rowKeyOf } from '@agentlink/core';
import { canonicalize } from '@agentlink/crypto';
import { openAgentStore } from '@agentlink/node';
import { openAgent, readAgentConfig } from '../../dist/runtime/index.js';

const send = (message) =>
  new Promise((resolve) => {
    process.send(message, () => resolve());
  });

const onMessage = () =>
  new Promise((resolve) => {
    process.once('message', resolve);
  });

async function writer({ home, name, approvalId, action, now }) {
  const found = await readAgentConfig(home, name);
  if (found === undefined) throw new Error('no agent');
  const { config, paths } = found;
  const opened = await openAgentStore(config.keyStore, config.agentId, paths.store);
  try {
    const sealedAction = await opened.cipher.seal(
      { table: 'approvals', column: 'action_json', rowKey: rowKeyOf([approvalId]) },
      canonicalize(action),
    );
    const sealedSummary = await opened.cipher.seal(
      { table: 'approvals', column: 'summary', rowKey: rowKeyOf([approvalId]) },
      'Include the document key in an export',
    );
    await opened.store.transaction((tx) =>
      tx.insert('approvals', {
        approval_id: approvalId,
        action_json: sealedAction,
        scope_json: null,
        answers_envelope_id: null,
        scope_key: null,
        source: 'owner',
        policy_hash: null,
        signed_decision: null,
        signed_cancel: null,
        summary: sealedSummary,
        status: 'pending',
        expires_at: now + 3_600,
        created_at: now,
        decided_at: null,
      }),
    );
    // The edit: the status cache says `approved`; no owner signature exists.
    await opened.store.transaction((tx) =>
      tx.update('approvals', { approval_id: approvalId }, { status: 'approved', decided_at: now }),
    );
    await send({ step: 'written', storePath: paths.store, pid: process.pid });
    await onMessage(); // the reader has finished
    const row = await opened.store.transaction((tx) =>
      tx.get('approvals', { approval_id: approvalId }),
    );
    await send({
      step: 'final',
      status: row?.status ?? null,
      signedDecision: row?.signed_decision ?? null,
    });
  } finally {
    await opened.close();
  }
}

async function reader({ home, name, approvalId, action }) {
  const result = await openAgent({ home, agent: name });
  if (result.status !== 'ok') {
    await send({ step: 'read', opened: result.status, reason: result.reason });
    return;
  }
  const { agent } = result;
  try {
    const channel = await agent.approvals.status(approvalId);
    const use = await agent.client.approvalService.use(approvalId, action, 'approval');
    await send({
      step: 'read',
      opened: 'ok',
      storePath: agent.paths.store,
      pid: process.pid,
      channel,
      use,
    });
  } finally {
    await agent.close();
  }
}

const task = await onMessage();
try {
  if (task.role === 'writer') await writer(task);
  else if (task.role === 'reader') await reader(task);
  else throw new Error('unknown role');
} catch (error) {
  await send({ step: 'error', code: error?.code ?? null, name: error?.name ?? null });
  process.exitCode = 1;
}
process.disconnect();
