import { afterEach, describe, expect, it, vi } from 'vitest';
import { getConfig } from '../../src/config';

describe('optional server model thinking configuration', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('leaves both parameters absent in the ordinary unconfigured app', () => {
    vi.stubEnv('MODEL_PROVIDER', 'mock');
    vi.stubEnv('MODEL_THINKING', undefined);
    vi.stubEnv('MODEL_VISION_THINKING', undefined);
    expect(getConfig()).toMatchObject({ MODEL_PROVIDER: 'mock' });
    expect(getConfig()).not.toHaveProperty('MODEL_THINKING');
    expect(getConfig()).not.toHaveProperty('MODEL_VISION_THINKING');
  });

  it('validates and keeps text and vision settings independent', () => {
    vi.stubEnv('MODEL_PROVIDER', 'mock');
    vi.stubEnv('MODEL_THINKING', 'enabled');
    vi.stubEnv('MODEL_VISION_THINKING', 'disabled');
    expect(getConfig()).toMatchObject({ MODEL_THINKING: 'enabled', MODEL_VISION_THINKING: 'disabled' });
  });

  it.each(['MODEL_THINKING', 'MODEL_VISION_THINKING'])('rejects unsupported %s values', (name) => {
    vi.stubEnv('MODEL_PROVIDER', 'mock');
    vi.stubEnv('MODEL_THINKING', undefined);
    vi.stubEnv('MODEL_VISION_THINKING', undefined);
    vi.stubEnv(name, 'automatic');
    expect(() => getConfig()).toThrow('配置无效');
  });
});
