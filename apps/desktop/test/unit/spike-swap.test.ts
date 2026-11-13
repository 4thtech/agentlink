// UPD-S1 SPIKE ONLY (never merged): the URL rule of the test-only swap, and that a release bundle
// never carries the spike (the define folds it away; checked by grepping dist-release in the run sheet).
import { describe, expect, it } from 'vitest';
import { SPIKE_APP, spikeUrlAllowed } from '../../src/main/spike-swap.js';

describe('UPD-S1 spike swap', () => {
  it('downloads only from https or the loopback test server', () => {
    expect(spikeUrlAllowed('https://github.com/4thtech/agentlink/releases/download/x/a.zip')).toBe(
      true,
    );
    expect(spikeUrlAllowed('http://127.0.0.1:8765/AgentLink-next.zip')).toBe(true);
    for (const bad of [
      'http://localhost:8765/a.zip',
      'http://192.168.1.2/a.zip',
      'file:///tmp/a.zip',
      'https://u:p@example.com/a.zip',
      'not a url',
    ]) {
      expect(spikeUrlAllowed(bad), bad).toBe(false);
    }
  });

  it('swaps only the fixed /Applications bundle', () => {
    expect(SPIKE_APP).toBe('/Applications/AgentLink.app');
  });
});
