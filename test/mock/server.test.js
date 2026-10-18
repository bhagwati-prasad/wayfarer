import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { createMockServer } from '../../src/mock/server.js';
import { handlers } from '../../src/mock/handlers/index.js';

describe('mock/server.js', () => {
  it('returns a setupServer-style object preloaded with the SDK handlers', () => {
    const server = createMockServer();
    for (const fn of ['listen', 'close', 'use', 'resetHandlers', 'listHandlers']) {
      expect(typeof server[fn], fn).toBe('function');
    }
    expect(server.listHandlers()).toHaveLength(handlers.length);
  });

  it('prepends host handlers so they take precedence, and ignores a non-array', () => {
    const extra = http.get('https://api.ota.com/v1/ping', () => HttpResponse.json({ ok: true }));
    const server = createMockServer([extra]);
    const list = server.listHandlers();
    expect(list).toHaveLength(handlers.length + 1);
    expect(list[0]).toBe(extra);
    expect(createMockServer(/** @type {any} */ ('nope')).listHandlers()).toHaveLength(
      handlers.length
    );
  });
});
