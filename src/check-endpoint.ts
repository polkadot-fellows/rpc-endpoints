import WebSocket from 'ws';

interface DnsResponse {
  // the DNS response code, 3 being NXDOMAIN (the domain doesn't exist)
  Status: number;
}

interface RpcResponse {
  error?: { message: string };
  id: number;
  result?: unknown;
}

// Endpoints are retried before being reported
const ATTEMPTS = 3;
const RETRY_DELAY = 5_000;
const TIMEOUT = 5_000;
const DNS_TIMEOUT = 2_000;

// Connect the same way a dapp does from a browser. Some providers reject
// non-browser clients, e.g. the Node.js built-in WebSocket sends 'User-Agent: node'
const HEADERS = {
  Origin: 'https://polkadot.js.org',
  'User-Agent': 'Mozilla/5.0 (polkadot-fellows/rpc-endpoints check)'
};

function getErrorReason(error: Error & { code?: string }): string {
  // e.g. 'CERT_HAS_EXPIRED (certificate has expired)'
  return `${String(error.code)}: ${error.message}`;
}

/**
 * Fetches & parses a json response, returning null if the request failed or timed out
 */
async function fetchJson<T>(url: string, timeout = DNS_TIMEOUT): Promise<T | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });

    return (await response.json()) as T;
  } catch (error) {
    console.error(error);

    return null;
  }
}

/**
 * Connects to the endpoint and checks that it returns a finalized head
 */
export function checkEndpoint(rpc: string): Promise<void> {
  return new Promise((resolve, reject): void => {
    const websocket = new WebSocket(rpc, { handshakeTimeout: TIMEOUT, headers: HEADERS });
    const timerId = setTimeout(() => done(new Error('Connection timeout')), TIMEOUT);

    function done(error?: Error): void {
      clearTimeout(timerId);
      websocket.removeAllListeners();
      // terminate() can still emit an error (while connecting), which would otherwise be thrown
      websocket.on('error', () => undefined);
      websocket.terminate();

      error ? reject(error) : resolve();
    }

    websocket.on('unexpected-response', (_, { statusCode, statusMessage }) =>
      done(new Error(`Unexpected response. code: '${statusCode}' reason: '${statusMessage}'`))
    );

    websocket.on('error', (error) => done(new Error(getErrorReason(error))));

    websocket.on('close', (code, reason) =>
      done(new Error(`Disconnected. code: '${code}' reason: '${reason.toString()}'`))
    );

    websocket.on('open', (): void => {
      websocket.send(JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'chain_getFinalizedHead', params: [] }));
    });

    websocket.on('message', (data): void => {
      let response: RpcResponse;

      try {
        response = JSON.parse((data as Buffer).toString('utf8')) as RpcResponse;
      } catch {
        done(new Error('Invalid JSON response'));

        return;
      }

      if (response.error) {
        done(new Error(`RPC error: ${response.error.message}`));

        return;
      }

      typeof response.result === 'string' && response.result.startsWith('0x')
        ? done()
        : done(new Error('Invalid/non-hex finalized head response'));
    });
  });
}

/**
 * Checks the endpoint, retrying a few times before failing (with the last error)
 */
export async function checkEndpointWithRetries(rpc: string): Promise<void> {
  const { hostname } = new URL(rpc);

  // fail fast if the dns doesn't exist
  const dns = await fetchJson<DnsResponse>(`https://dns.google/resolve?name=${hostname}`);

  // only fail on a negative answer, a null here means the lookup itself failed/timed out
  if (dns?.Status === 3) {
    throw new Error(`No DNS entry for ${hostname}`);
  }

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    if (attempt > 1) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
    }

    try {
      await checkEndpoint(rpc);

      return;
    } catch (error) {
      lastError = error as Error;
    }
  }

  throw lastError;
}
