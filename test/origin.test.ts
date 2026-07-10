import { describe, expect, test } from 'bun:test';
import { allowedHost, allowedOrigin, isLoopbackBind } from '../server/origin';

const PORT = 8787;

describe('allowedHost', () => {
  test('accepts loopback hosts on the bound port', () => {
    expect(allowedHost('127.0.0.1:8787', PORT)).toBe(true);
    expect(allowedHost('localhost:8787', PORT)).toBe(true);
    expect(allowedHost('[::1]:8787', PORT)).toBe(true);
  });

  test('rejects rebound domains, wrong ports and missing headers', () => {
    expect(allowedHost('evil.example.com:8787', PORT)).toBe(false);
    expect(allowedHost('localhost:9999', PORT)).toBe(false);
    expect(allowedHost(undefined, PORT)).toBe(false);
    expect(allowedHost('', PORT)).toBe(false);
  });
});

describe('allowedOrigin', () => {
  test('accepts loopback origins on the bound port', () => {
    expect(allowedOrigin('http://localhost:8787', PORT)).toBe(true);
    expect(allowedOrigin('http://127.0.0.1:8787', PORT)).toBe(true);
  });

  test('absent origin is allowed (non-browser clients)', () => {
    expect(allowedOrigin(undefined, PORT)).toBe(true);
  });

  test('rejects cross-origin websites and null origins', () => {
    expect(allowedOrigin('https://evil.example.com', PORT)).toBe(false);
    expect(allowedOrigin('http://evil.example.com:8787', PORT)).toBe(false);
    expect(allowedOrigin('http://localhost:9999', PORT)).toBe(false);
    expect(allowedOrigin('null', PORT)).toBe(false);
  });
});

describe('isLoopbackBind', () => {
  test('guards loopback binds, skips explicit wide binds', () => {
    expect(isLoopbackBind('127.0.0.1')).toBe(true);
    expect(isLoopbackBind('0.0.0.0')).toBe(false);
  });
});
