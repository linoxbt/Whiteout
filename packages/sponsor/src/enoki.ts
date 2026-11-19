/** Enoki's HTTP API with the private key (spec section 12), with errors sorted for the app. */
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { ABORTS, type AbortInfo } from '@whiteout/core';

export interface Enoki {
  /** Resolves the zkLogin address for a JWT (Enoki GET /v1/zklogin). */
  address(jwt: string): Promise<string>;
  sponsor(p: { network: string; kindBytes: string; sender: string; jwt: string; targets: string[] }): Promise<{ bytes: string; digest: string }>;
  execute(digest: string, signature: string): Promise<{ digest: string }>;
}

export interface MoveAbortDetails {
  code: number;
  /** Package of the aborting module, when Enoki's message names it. */
  package?: string;
  module?: string;
  function?: string;
  /** True when the abort comes from the Whiteout package (then name/message/action are set). */
  whiteout: boolean;
  name?: string;
  message: string;
  action?: AbortInfo['action'];
}

/**
 * `invalid_jwt`: Enoki refused the token (401 to the client).
 * `move_abort`: the dry run aborted in Move (422, do not retry).
 * `upstream`: anything else: outage, timeout, 5xx, rate limit, configuration (502).
 * `detail` is the raw Enoki text: log it, never send it to the client.
 */
export class EnokiError extends Error {
  override name = 'EnokiError';
  constructor(
    readonly kind: 'invalid_jwt' | 'move_abort' | 'upstream',
    readonly status: number | null,
    readonly detail: string,
    readonly abort?: MoveAbortDetails,
  ) {
    super(`Enoki ${kind}${status ? ` ${status}` : ''}`);
  }
}

/**
 * Finds a Move abort in an Enoki / full-node error message, e.g.
 * `MoveAbort(MoveLocation { module: ModuleId { address: 77.., name: Identifier("game") }, function: 5,
 *  instruction: 21, function_name: Some("step") }, 10) in command 0`.
 */
export function parseMoveAbort(text: string, packageId: string): MoveAbortDetails | null {
  const i = text.search(/MoveAbort/i);
  if (i < 0) return null;
  const t = text.slice(i, i + 2000);
  const code =
    /\}\s*,\s*(\d+)\s*\)/.exec(t)?.[1] ?? /abort_?code\W+(\d+)/i.exec(t)?.[1] ?? /,\s*(\d+)\)/.exec(t)?.[1];
  if (code === undefined) return null;
  const addr = /address:\s*(?:0x)?([0-9a-fA-F]{1,64})\b/.exec(t)?.[1];
  const module = /name:\s*Identifier\(\\?"(\w+)\\?"\)/.exec(t)?.[1] ?? /module\W+(\w+)/i.exec(t)?.[1];
  const fn = /function_name:\s*Some\(\\?"(\w+)\\?"\)/.exec(t)?.[1];
  const pkg = addr ? normalizeSuiAddress(addr) : undefined;
  const n = Number(code);
  const whiteout = !!pkg && pkg === normalizeSuiAddress(packageId);
  const info = whiteout ? ABORTS[n] : undefined;
  return {
    code: n,
    ...(pkg ? { package: pkg } : {}),
    ...(module ? { module } : {}),
    ...(fn ? { function: fn } : {}),
    whiteout,
    ...(info ? { name: info.name, action: info.action } : {}),
    message: info?.message ?? `The transaction would fail${module ? ` in ${module}${fn ? `::${fn}` : ''}` : ''} (abort code ${n}).`,
  };
}

/** Enoki refuses our own key (not the player's token): an operator problem, not a 401 for the player. */
const KEY_PROBLEM = /api[ _-]?key|private key|unauthori[sz]ed app|invalid key/i;

export function enokiHttp(
  privateKey: string,
  opts: { base?: string; packageId: string; timeoutMs?: number; fetch?: typeof fetch },
): Enoki {
  const base = opts.base ?? 'https://api.enoki.mystenlabs.com/v1';
  async function call<T>(path: string, init: RequestInit, classify: (status: number, text: string) => EnokiError, jwt?: string): Promise<T> {
    let r: Response;
    try {
      r = await (opts.fetch ?? fetch)(`${base}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${privateKey}`,
          'content-type': 'application/json',
          ...(jwt ? { 'zklogin-jwt': jwt } : {}),
        },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      });
    } catch (e) {
      throw new EnokiError('upstream', null, `fetch failed: ${(e as Error).message}`);
    }
    const text = await r.text().catch(() => '');
    if (!r.ok) throw classify(r.status, text);
    try {
      return (JSON.parse(text) as { data: T }).data;
    } catch {
      throw new EnokiError('upstream', r.status, `malformed reply: ${text.slice(0, 200)}`);
    }
  }
  const txError = (status: number, text: string) => {
    const abort = parseMoveAbort(text, opts.packageId);
    return abort ? new EnokiError('move_abort', status, text, abort) : new EnokiError('upstream', status, text);
  };
  return {
    address: async (jwt) =>
      (
        await call<{ address: string }>(
          '/zklogin',
          { method: 'GET' },
          (status, text) =>
            status >= 400 && status < 500 && status !== 429 && !KEY_PROBLEM.test(text)
              ? new EnokiError('invalid_jwt', status, text)
              : new EnokiError('upstream', status, text),
          jwt,
        )
      ).address,
    sponsor: (p) =>
      call<{ bytes: string; digest: string }>(
        '/transaction-blocks/sponsor',
        {
          method: 'POST',
          body: JSON.stringify({
            network: p.network,
            transactionBlockKindBytes: p.kindBytes,
            sender: p.sender,
            allowedMoveCallTargets: p.targets,
          }),
        },
        txError,
        p.jwt,
      ),
    execute: (digest, signature) =>
      call<{ digest: string }>(
        `/transaction-blocks/sponsor/${encodeURIComponent(digest)}`,
        { method: 'POST', body: JSON.stringify({ signature }) },
        txError,
      ),
  };
}
