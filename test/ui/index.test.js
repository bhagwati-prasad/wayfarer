import { describe, it, expect } from 'vitest';
import { createUI } from '../../src/ui/index.js';
import { UnsupportedError } from '../../src/errors/index.js';

describe('ui/index.js placeholder', () => {
  it('exports createUI, which throws UnsupportedError{feature:"ui"} until the builders exist', () => {
    expect(typeof createUI).toBe('function');
    let caught;
    try {
      createUI({}, {});
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnsupportedError);
    expect(caught.feature).toBe('ui');
    expect(caught.code).toBe('UNSUPPORTED');
  });
});
