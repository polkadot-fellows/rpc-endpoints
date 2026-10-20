import WebSocket from 'ws';
import { z } from 'zod';

interface DnsResponse {
  // the DNS response code, 3 being NXDOMAIN (the domain doesn't exist)
  Status: number;
}

/**
 * Makes a server-controlled value safe to log and to put in the (markdown) report, by keeping
 * only plain characters (no mentions, links, html or table breaks) and capping the length
 */
function sanitize(value: unknown, maxLength = 200): string {
  const text = String(value)
    .replace(/[^\w .,:;'"()/=+-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

/**
 * An (untrusted) JSON-RPC response. The error message is sanitized, while the result is left
 * as unknown, to be validated by the caller
 */
const RpcResponse = z
  .object({
    error: z.object({ message: z.unknown().transform((message) => sanitize(message)) }).optional(),
    id: z.number(),
    result: z.unknown().optional()
  })
  .refine(({ error, result }) => error !== undefined || result !== undefined);

/**
 * The result of rpc_methods
 */
const RpcMethods = z.object({ methods: z.array(z.string()) });

/**
 * The result of system_localListenAddresses
 */
const ListenAddresses = z.array(z.string());

// Endpoints are retried before being reported
const ATTEMPTS = 3;
const RETRY_DELAY = 5_000;
const TIMEOUT = 5_000;
const DNS_TIMEOUT = 2_000;

// The endpoints are untrusted, so cap what they can send (a response is a few KB)
const MAX_RESPONSE_SIZE = 1024 * 1024;

// Connect the same way a dapp does from a browser. Some providers reject
// non-browser clients, e.g. the Node.js built-in WebSocket sends 'User-Agent: node'
const HEADERS = {
  Origin: 'https://polkadot.js.org',
  'User-Agent': 'Mozilla/5.0 (polkadot-fellows/rpc-endpoints check)'
};

function getErrorReason(error: Error & { code?: string }): string {
  // e.g. 'CERT_HAS_EXPIRED (certificate has expired)'
  return `${String(error.code)}: ${sanitize(error.message)}`;
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
 * A minimal JSON-RPC client over a single websocket connection. The server is untrusted, so
 * nothing it sends can throw, it fails the pending calls instead (as does any connection issue)
 */
class RpcClient {
  readonly #websocket: WebSocket;
  readonly #timerId: NodeJS.Timeout;
  readonly #opened = Promise.withResolvers<void>();
  readonly #pending = new Map<number, PromiseWithResolvers<unknown>>();
  #error: Error | undefined;
  #nextId = 1;

  constructor(rpc: string) {
    // connecting & all the calls have to complete within the timeout
    this.#timerId = setTimeout(() => this.#fail(new Error('Connection timeout')), TIMEOUT);
    // nobody awaits the connection if it fails before the first call
    this.#opened.promise.catch(() => undefined);

    this.#websocket = new WebSocket(rpc, {
      handshakeTimeout: TIMEOUT,
      headers: HEADERS,
      maxPayload: MAX_RESPONSE_SIZE
    });

    this.#websocket.on('unexpected-response', (_, { statusCode, statusMessage }) =>
      this.#fail(new Error(`Unexpected response. code: '${statusCode}' reason: '${sanitize(statusMessage)}'`))
    );

    this.#websocket.on('error', (error) => this.#fail(new Error(getErrorReason(error))));

    this.#websocket.on('close', (code, reason) =>
      this.#fail(new Error(`Disconnected. code: '${code}' reason: '${sanitize(reason)}'`))
    );

    this.#websocket.on('open', () => this.#opened.resolve());

    this.#websocket.on('message', (data): void => {
      // a throw inside a listener isn't caught by the promises and would crash the whole run
      try {
        this.#onMessage(String(data));
      } catch {
        this.#fail(new Error('Invalid response'));
      }
    });
  }

  /**
   * Calls the method, resolving with its (unvalidated) result
   */
  async call(method: string, params: unknown[] = []): Promise<unknown> {
    await this.#opened.promise;

    if (this.#error) {
      throw this.#error;
    }

    const id = this.#nextId++;
    const pending = Promise.withResolvers<unknown>();

    this.#pending.set(id, pending);
    this.#websocket.send(JSON.stringify({ id, jsonrpc: '2.0', method, params }));

    return pending.promise;
  }

  close(): void {
    clearTimeout(this.#timerId);
    this.#websocket.removeAllListeners();
    // terminate() can still emit an error (while connecting), which would otherwise be thrown
    this.#websocket.on('error', () => undefined);
    this.#websocket.terminate();
  }

  #onMessage(data: string): void {
    let json: unknown;

    try {
      json = JSON.parse(data);
    } catch {
      this.#fail(new Error('Invalid JSON response'));
      return;
    }

    const response = RpcResponse.safeParse(json);
    if (!response.success) {
      this.#fail(new Error('Invalid JSON-RPC response'));
      return;
    }
    const { error, id, result } = response.data;

    const pending = this.#pending.get(id);
    if (!pending) {
      return;
    }
    this.#pending.delete(id);

    if (error) {
      pending.reject(new Error(`RPC error: ${error.message}`));
      return;
    }
    pending.resolve(result);
  }

  #fail(error: Error): void {
    if (this.#error) {
      return;
    }

    this.#error = error;
    this.close();
    this.#opened.reject(error);

    for (const { reject } of this.#pending.values()) {
      reject(error);
    }
    this.#pending.clear();
  }
}

/**
 * Connects to the endpoint and checks that it exposes the required RPC methods
 */
export async function checkEndpoint(rpc: string, requiredMethods: string[]): Promise<void> {
  const client = new RpcClient(rpc);

  try {
    const rpcMethods = RpcMethods.safeParse(await client.call('rpc_methods'));
    if (!rpcMethods.success) {
      throw new Error('Invalid rpc_methods response');
    }

    const missingRpcMethods = requiredMethods.filter((method) => !rpcMethods.data.methods.includes(method));
    if (missingRpcMethods.length) {
      throw new Error(`Missing RPC methods: ${missingRpcMethods.join(', ')}`);
    }

    const listenAddresses = ListenAddresses.safeParse(await client.call('system_localListenAddresses'));
    if (!listenAddresses.success) {
      throw new Error('Invalid system_localListenAddresses response');
    }
  } finally {
    client.close();
  }
}

/**
 * Checks the endpoint, retrying a few times before failing (with the last error)
 */
export async function checkEndpointWithRetries(rpc: string, requiredMethods: string[]): Promise<void> {
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
      await checkEndpoint(rpc, requiredMethods);

      return;
    } catch (error) {
      lastError = error as Error;
    }
  }

  throw lastError;
}
