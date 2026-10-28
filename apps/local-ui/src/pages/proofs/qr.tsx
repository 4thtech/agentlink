// A QR code as an inline SVG (M1-11c-a4c, Add credits). The modules come from qrcode-generator
// (MIT, no dependencies; justified in the PR) and are drawn as React <rect> elements: no innerHTML,
// no data URL, no canvas, so nothing the server sent is ever parsed as markup. Error correction M,
// a 4-module quiet zone, dark modules on a light square in both themes (scanners need the contrast).
import qrcode from 'qrcode-generator';
import { useMemo, type ReactElement } from 'react';

const QUIET = 4;

export interface QrCodeProps {
  /** The text to encode (here: the agent's address, already checked by the caller). */
  readonly value: string;
  /** The accessible name. Never the encoded value when that is a secret (b11 §21.6). */
  readonly label: string;
  /**
   * Mirror the value into `data-value` (Add credits: a public receiving address, read by tests).
   * Off by default: an invite link must never sit in an attribute (UX2-d2, b11 §21.5).
   */
  readonly exposeValue?: boolean;
  /** An extra class for the page's own sizing. */
  readonly className?: string;
}

export function QrCode({
  value,
  label,
  exposeValue = false,
  className,
}: QrCodeProps): ReactElement {
  const cells = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    const n = qr.getModuleCount();
    const dark: { x: number; y: number }[] = [];
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) if (qr.isDark(y, x)) dark.push({ x, y });
    }
    return { n, dark };
  }, [value]);
  const size = cells.n + QUIET * 2;
  return (
    <svg
      className={className === undefined ? 'pf-qr' : `pf-qr ${className}`}
      role="img"
      aria-label={label}
      data-value={exposeValue ? value : undefined}
      viewBox={`0 0 ${String(size)} ${String(size)}`}
      shapeRendering="crispEdges"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect className="pf-qr-bg" x={0} y={0} width={size} height={size} />
      {cells.dark.map(({ x, y }) => (
        <rect
          key={`${String(x)}-${String(y)}`}
          className="pf-qr-dot"
          x={x + QUIET}
          y={y + QUIET}
          width={1}
          height={1}
        />
      ))}
    </svg>
  );
}
