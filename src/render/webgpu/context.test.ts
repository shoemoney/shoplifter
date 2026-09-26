import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeWebGpuSupport } from './context.js';

const stubGlobals = (overrides: { gpu?: unknown; secure?: boolean }): void => {
  vi.stubGlobal('navigator', overrides.gpu === undefined ? {} : { gpu: overrides.gpu });
  vi.stubGlobal('isSecureContext', overrides.secure ?? true);
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('probeWebGpuSupport', () => {
  it('reports no-navigator-gpu when the browser lacks WebGPU', () => {
    stubGlobals({});
    const probe = probeWebGpuSupport();
    expect(probe.supported).toBe(false);
    expect(probe.reason).toBe('no-navigator-gpu');
    expect(probe.detail).toBeTruthy();
  });

  it('reports insecure-context on plain http', () => {
    stubGlobals({ gpu: {}, secure: false });
    const probe = probeWebGpuSupport();
    expect(probe.supported).toBe(false);
    expect(probe.reason).toBe('insecure-context');
  });

  it('passes when navigator.gpu exists in a secure context', () => {
    stubGlobals({ gpu: {}, secure: true });
    expect(probeWebGpuSupport()).toEqual({ supported: true });
  });

  it('treats a falsy navigator.gpu as unsupported', () => {
    vi.stubGlobal('navigator', { gpu: undefined });
    vi.stubGlobal('isSecureContext', true);
    expect(probeWebGpuSupport().reason).toBe('no-navigator-gpu');
  });
});
