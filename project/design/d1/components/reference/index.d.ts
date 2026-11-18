import type * as React from 'react';

/** Name rule (handoff 5.3): alias → restricted quoted name → "Contact <fingerprint>". */
export interface ContactNameInput { alias?: string; name?: string; fingerprint?: string }
export type IdentityKind = 'selfdeclared' | 'checked' | 'registered' | 'verified' | 'domain-warning';
export type Status = 'sent' | 'received' | 'delivered' | 'opened' | 'accepted' | 'rejected' | 'recording' | 'recorded' | 'needs-approval' | 'approved' | 'denied' | 'expired' | 'needs-setup' | 'needs-credits' | 'failed' | 'online' | 'last-seen' | 'paused' | 'offline';
export type ApprovalState = 'pending' | 'waiting' | 'approved' | 'denied' | 'expired' | 'failed' | 'decided-elsewhere';

export interface MarkProps { size?: number; mono?: boolean; title?: string; className?: string }
export interface WordmarkProps { height?: number; productName?: string; className?: string }
export interface LockupProps { size?: number; layout?: 'horizontal' | 'stacked'; endorsed?: boolean; mono?: boolean; productName?: string; className?: string }
export interface IconProps { name: string; size?: number; strokeWidth?: number; label?: string; className?: string }
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md' | 'lg'; icon?: string; iconRight?: string; kbd?: string; block?: boolean }
export interface KbdProps { children: React.ReactNode }
export interface TextFieldProps extends React.InputHTMLAttributes<HTMLInputElement> { label?: string; hint?: string; error?: string; mono?: boolean; prefix?: string }
export interface SwitchProps { label: string; description?: string; checked?: boolean; defaultChecked?: boolean; disabled?: boolean; onChange?: (on: boolean) => void }
export interface SegmentedProps { label: string; options: { value: string; label: string; hint?: string }[]; value?: string; defaultValue?: string; onChange?: (v: string) => void }
export interface StatusChipProps { status: Status; detail?: string; children?: React.ReactNode; className?: string }
export interface IdentityLabelProps { kind: IdentityKind; domain?: string; punycode?: string; date?: string; className?: string }
export interface FingerprintProps { value: string; prefix?: string; className?: string }
export interface ContactNameProps extends ContactNameInput { label?: IdentityKind; domain?: string; showLabel?: boolean; className?: string }
export interface SafetyCodeProps { code: string; contactName?: string; state?: 'unchecked' | 'matched' | 'mismatch' | 'changed'; onMatch?: () => void; onMismatch?: () => void }
export interface ContactCardProps extends ContactNameInput { label?: IdentityKind; domain?: string; agent?: string; aiApp?: string; status?: Status; statusDetail?: string; state?: 'blocked' | 'revoked' | 'paused'; actions?: React.ReactNode }
export interface UntrustedContentProps { from?: string; unknown?: boolean; fingerprint?: string; kind?: 'message' | 'request' | 'note' | 'offer' | 'terms' | 'delivery'; fileName?: string; children?: string; className?: string }
export interface ApprovalCardProps { type: 'new-contact' | 'proof' | 'file-over-limit' | 'document-key'; agent: string; time?: string; expires?: string; headline: string; who?: React.ReactNode; what?: React.ReactNode; cost?: React.ReactNode; why?: React.ReactNode; consequence?: React.ReactNode; details?: React.ReactNode; state?: ApprovalState; method?: string; onApprove?: () => void; onDeny?: () => void; children?: React.ReactNode }
export interface TermsDiffRow { field: string; old: string | null; new: string | null; proposerWords?: boolean }
export interface TermsDiffProps { rows: TermsDiffRow[]; oldLabel?: string; newLabel?: string }
export interface CommitmentCardProps { mode?: 'accept' | 'reject'; headline: string; who: React.ReactNode; proposer?: string; subject?: string; diff?: TermsDiffProps; validUntil?: string; scope?: React.ReactNode; consequence?: React.ReactNode; cost?: string; autoNote?: string; warning?: React.ReactNode; fingerprint?: string; state?: ApprovalState; method?: string; onApprove?: () => void; onCancel?: () => void }
export interface ProofBadgeProps { state?: 'recording' | 'recorded' | 'failed' | 'waiting'; time?: string }
export interface ReceiptStep { key: 'recorded' | 'delivered' | 'opened' | 'accepted' | 'rejected' | 'received' | 'sent'; label?: string; time?: string; done?: boolean; free?: boolean }
export interface ReceiptTimelineProps { steps: ReceiptStep[] }
export interface CostChipProps { amount?: string; free?: boolean; source?: string; split?: string }
export interface CreditsMeterProps { balance: string; proofsLeft: number; spentToday: number; budget: number; state?: 'low' | 'empty' | 'reached'; test?: boolean }
export interface FileCardProps { name: string; size: string; expiry?: string; from?: string; integrity?: 'ok' | 'failed'; proof?: ProofBadgeProps['state']; proofTime?: string; status?: Status; action?: React.ReactNode }
export interface CopyPromptProps { prompt?: string; command?: string; title?: string; note?: string; size?: 'default' | 'hero' }
export interface SecretDisplayProps { label?: string; value: string; explain?: string }
export interface BannerProps { tone?: 'info' | 'success' | 'warning' | 'danger' | 'neutral' | 'offline' | 'proof'; title?: string; icon?: string; action?: React.ReactNode; compact?: boolean; children?: React.ReactNode }
export interface ToastProps { tone?: 'info' | 'success' | 'warning' | 'danger' | 'neutral' | 'proof'; icon?: string; action?: string; children?: React.ReactNode }
export interface EmptyStateProps { title: string; prompt?: string; icon?: string; action?: React.ReactNode }
export interface NavItem { icon: string; label: string; count?: number; active?: boolean }
export interface AppShellProps { os?: 'macos' | 'windows' | 'linux'; title?: string; agent?: string; nav?: NavItem[]; connection?: 'connected' | 'offline' | 'paused'; statusItems?: string[]; version?: string; height?: number | string; children?: React.ReactNode; className?: string }
export interface TrayMenuProps { os?: 'macos' | 'windows' | 'linux'; status?: 'connected' | 'paused' | 'offline'; approvals?: number; updateReady?: string }

export declare function Mark(p: MarkProps): React.ReactElement;
export declare function Wordmark(p: WordmarkProps): React.ReactElement;
export declare function Lockup(p: LockupProps): React.ReactElement;
export declare function Icon(p: IconProps): React.ReactElement;
export declare function Button(p: ButtonProps): React.ReactElement;
export declare function Kbd(p: KbdProps): React.ReactElement;
export declare function TextField(p: TextFieldProps): React.ReactElement;
export declare function Switch(p: SwitchProps): React.ReactElement;
export declare function Segmented(p: SegmentedProps): React.ReactElement;
export declare function StatusChip(p: StatusChipProps): React.ReactElement;
export declare function IdentityLabel(p: IdentityLabelProps): React.ReactElement;
export declare function Fingerprint(p: FingerprintProps): React.ReactElement;
export declare function ContactName(p: ContactNameProps): React.ReactElement;
export declare function SafetyCode(p: SafetyCodeProps): React.ReactElement;
export declare function ContactCard(p: ContactCardProps): React.ReactElement;
export declare function UntrustedContent(p: UntrustedContentProps): React.ReactElement;
export declare function ApprovalCard(p: ApprovalCardProps): React.ReactElement;
export declare function TermsDiff(p: TermsDiffProps): React.ReactElement;
export declare function CommitmentCard(p: CommitmentCardProps): React.ReactElement;
export declare function ProofBadge(p: ProofBadgeProps): React.ReactElement;
export declare function ReceiptTimeline(p: ReceiptTimelineProps): React.ReactElement;
export declare function CostChip(p: CostChipProps): React.ReactElement;
export declare function CreditsMeter(p: CreditsMeterProps): React.ReactElement;
export declare function FileCard(p: FileCardProps): React.ReactElement;
export declare function CopyPrompt(p: CopyPromptProps): React.ReactElement;
export declare function SecretDisplay(p: SecretDisplayProps): React.ReactElement;
export declare function Banner(p: BannerProps): React.ReactElement;
export declare function Toast(p: ToastProps): React.ReactElement;
export declare function EmptyState(p: EmptyStateProps): React.ReactElement;
export declare function AppShell(p: AppShellProps): React.ReactElement;
export declare function TrayMenu(p: TrayMenuProps): React.ReactElement;
export declare function formatContactName(c: ContactNameInput): { kind: 'alias' | 'restricted' | 'fingerprint'; text: string };

declare global { interface Window { AgentLink: {
  Mark: typeof Mark; Wordmark: typeof Wordmark; Lockup: typeof Lockup; Icon: typeof Icon; Button: typeof Button; Kbd: typeof Kbd; TextField: typeof TextField; Switch: typeof Switch; Segmented: typeof Segmented;
  StatusChip: typeof StatusChip; IdentityLabel: typeof IdentityLabel; Fingerprint: typeof Fingerprint; ContactName: typeof ContactName; SafetyCode: typeof SafetyCode; ContactCard: typeof ContactCard;
  UntrustedContent: typeof UntrustedContent; ApprovalCard: typeof ApprovalCard; TermsDiff: typeof TermsDiff; CommitmentCard: typeof CommitmentCard; ProofBadge: typeof ProofBadge; ReceiptTimeline: typeof ReceiptTimeline;
  CostChip: typeof CostChip; CreditsMeter: typeof CreditsMeter; FileCard: typeof FileCard; CopyPrompt: typeof CopyPrompt; SecretDisplay: typeof SecretDisplay; Banner: typeof Banner; Toast: typeof Toast; EmptyState: typeof EmptyState;
  AppShell: typeof AppShell; TrayMenu: typeof TrayMenu; formatContactName: typeof formatContactName; iconNames: string[] } } }
