/**
 * Runs a transaction for the connected player. zkLogin (Enoki) players go through the
 * sponsor service, so they need no SUI for gas (FR22); wallet players sign and pay.
 */
import type { UiWallet } from '@mysten/dapp-kit-react';
import { getSession, isEnokiWallet } from '@mysten/enoki';
import type { Transaction } from '@mysten/sui/transactions';
import { toBase64 } from '@mysten/sui/utils';
import { parseAbort, withRetry, type AbortInfo } from '@whiteout/core';
import { config, suiClient } from '../config';
import { dAppKit } from '../dappkit';

export class TxError extends Error {
  constructor(
    message: string,
    readonly abort: AbortInfo | null,
    readonly status?: number,
  ) {
    super(message);
  }
}

export async function run(transaction: Transaction, wallet: UiWallet | null, sender: string): Promise<string> {
  transaction.setSenderIfNotSet(sender);
  const sponsored = wallet && isEnokiWallet(wallet) && config.sponsorUrl;
  const digest = sponsored ? await runSponsored(transaction, wallet) : await runDirect(transaction);
  const res = await suiClient.core.waitForTransaction({ digest, include: { effects: true } });
  const t = res.Transaction ?? res.FailedTransaction!;
  if (!t.status.success) {
    const abort = parseAbort(t.status.error, config.packageId);
    throw new TxError(abort?.message ?? t.status.error.message, abort);
  }
  return digest;
}

async function runDirect(transaction: Transaction): Promise<string> {
  try {
    const r = await dAppKit.signAndExecuteTransaction({ transaction });
    const t = r.Transaction ?? r.FailedTransaction!;
    return t.digest;
  } catch (e) {
    const abort = parseAbort(e, config.packageId);
    throw new TxError(abort?.message ?? (e as Error).message, abort);
  }
}

/** The sponsor's error body (see packages/sponsor/src/app.ts for the status contract). */
interface SponsorError {
  error?: string;
  code?: string;
  abort?: AbortInfo & Record<string, unknown>;
}

const SPONSOR_TIMEOUT_MS = 20_000;

/** Turns a sponsor reply into a TxError; `retry` marks the ones worth another try. */
function sponsorError(status: number, body: SponsorError): TxError & { retry: boolean } {
  const err = new TxError(body.abort?.message ?? body.error ?? `gas service ${status}`, body.abort ?? null, status) as TxError & { retry: boolean };
  // 502 (Enoki or node trouble), 503 store_unavailable and 409 (execute in progress)
  // are transient; everything else (401, 403, 404, 422 aborts, 429 quota) is final.
  err.retry = status === 502 || status === 409 || (status === 503 && body.code === 'store_unavailable');
  return err;
}

async function post(url: string, init: RequestInit): Promise<{ status: number; body: SponsorError & Record<string, unknown> }> {
  const r = await fetch(url, { ...init, method: 'POST', signal: AbortSignal.timeout(SPONSOR_TIMEOUT_MS) });
  const body = (await r.json().catch(() => ({}))) as SponsorError & Record<string, unknown>;
  return { status: r.status, body };
}

async function runSponsored(transaction: Transaction, wallet: UiWallet): Promise<string> {
  const session = await getSession(wallet);
  if (!session?.jwt) throw new TxError('Your Google session expired. Please log in again.', null, 401);
  const kind = await transaction.build({ client: suiClient, onlyTransactionKind: true });
  const retryIf = (e: unknown) => (e as { retry?: boolean }).retry !== false;
  const sponsored = await withRetry(
    async () => {
      const { status, body } = await post(`${config.sponsorUrl}/sponsor`, {
        headers: { 'content-type': 'application/json', 'zklogin-jwt': session.jwt! },
        body: JSON.stringify({ txKindBytes: toBase64(kind) }),
      });
      if (status !== 200) throw sponsorError(status, body);
      return body as unknown as { bytes: string; digest: string };
    },
    { tries: 4, retryIf },
  );
  const { signature } = await dAppKit.signTransaction({ transaction: sponsored.bytes });
  const exec = await withRetry(
    async () => {
      const { status, body } = await post(`${config.sponsorUrl}/sponsor/${sponsored.digest}`, {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ signature }),
      });
      if (status !== 200) throw sponsorError(status, body);
      return body as unknown as { digest: string };
    },
    { tries: 4, retryIf },
  );
  return exec.digest;
}
