// M2-3a: the cloud agent's ApprovalChannel seam (03 §3 "Channels per packaging"). M2-3a has no owner
// pages, so this channel only accepts a request and reports it `pending`: it never decides and never
// hands back a signed object, so it grants nothing (I-4). M2-3f-2 replaces it with the channel that
// returns the `https://<host>/approve/<id>` page URL and the owner's signed object.
import type {
  ApprovalChannel,
  ApprovalChannelStatus,
  ApprovalRequest,
  ApprovalTicket,
} from '@4thtech-io/core';

export class PendingApprovalChannel implements ApprovalChannel {
  request(request: ApprovalRequest): Promise<ApprovalTicket> {
    return Promise.resolve({ approvalId: request.approvalId });
  }

  status(): Promise<ApprovalChannelStatus> {
    return Promise.resolve({ state: 'pending' });
  }
}
