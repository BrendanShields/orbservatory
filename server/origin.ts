const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isLoopbackBind(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname);
}

function hostname(value: string): string | undefined {
  try {
    return new URL(`http://${value}`).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return undefined;
  }
}

export function allowedHost(header: string | undefined, port: number): boolean {
  if (!header) return false;
  const url = (() => {
    try {
      return new URL(`http://${header}`);
    } catch {
      return undefined;
    }
  })();
  if (!url) return false;
  if ((url.port || '80') !== String(port)) return false;
  return LOOPBACK_HOSTS.has(url.hostname.replace(/^\[|\]$/g, ''));
}

export function allowedOrigin(header: string | undefined, port: number): boolean {
  if (!header) return true;
  let url: URL;
  try {
    url = new URL(header);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if ((url.port || '80') !== String(port)) return false;
  const host = hostname(url.host);
  return !!host && LOOPBACK_HOSTS.has(host);
}
