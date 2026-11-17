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
  const digest = sponsored ? await runSponsored(transaction, wallet, sender) : await runDirect(transaction);
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

async function runSponsored(transaction: Transaction, wallet: UiWallet, sender: string): Promise<string> {
  const session = await getSession(wallet);
  if (!session?.jwt) throw new TxError('Your Google session expired. Please log in again.', null, 401);
  const kind = await transaction.build({ client: suiClient, onlyTransactionKind: true });
  const sponsored = await withRetry(
    async () => {
      const r = await fetch(`${config.sponsorUrl}/sponsor`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'zklogin-jwt': session.jwt! },
        body: JSON.stringify({ txKindBytes: toBase64(kind) }),
      });
      const body = (await r.json().catch(() => ({}))) as { bytes?: string; digest?: string; error?: string };
      if (r.status === 502) throw new Error(body.error ?? 'gas service error');
      if (!r.ok) throw Object.assign(new TxError(body.error ?? `sponsor ${r.status}`, null, r.status), { fatal: true });
      return body as { bytes: string; digest: string };
    },
    { tries: 4, retryIf: (e) => !(e as { fatal?: boolean }).fatal },
  );
  const { signature } = await dAppKit.signTransaction({ transaction: sponsored.bytes });
  const exec = await withRetry(async () => {
    const r = await fetch(`${config.sponsorUrl}/sponsor/${sponsored.digest}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signature }),
    });
    if (!r.ok) throw new Error(`gas service ${r.status}`);
    return (await r.json()) as { digest: string };
  });
  void sender;
  return exec.digest;
}
