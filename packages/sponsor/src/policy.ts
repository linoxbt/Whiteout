/**
 * What the sponsor will pay for (spec sections 9, 10 and 12, plus the review fix that
 * forbids the gas coin). A transaction kind is sponsored only if:
 *  - every MoveCall targets the Whiteout package and an allowed function, or one of a
 *    few framework calls that build a stake coin from the sender's own funds;
 *  - no command touches the gas coin (it belongs to the sponsor);
 *  - no funds withdrawal draws from the sponsor;
 *  - the only other commands are SplitCoins and MergeCoins.
 */
import { normalizeSuiAddress } from '@mysten/sui/utils';
import type { TransactionData } from '@mysten/sui/transactions';
import { SPONSORED_FUNCTIONS } from '@whiteout/core';

/** Framework calls the SDK emits when it builds a coin from the sender's balance. */
export const FRAMEWORK_CALLS = new Set([
  '0x2::coin::zero',
  '0x2::coin::redeem_funds',
  '0x2::balance::redeem_funds',
  '0x2::coin::into_balance',
  '0x2::coin::from_balance',
  '0x2::coin::destroy_zero',
  '0x2::coin::send_funds',
]);

export type Verdict =
  | { ok: true; gameId: string | null; calls: string[] }
  | { ok: false; status: 400 | 403; reason: string };

export function checkKind(data: TransactionData, packageId: string): Verdict {
  const pkg = normalizeSuiAddress(packageId);
  const allowed = new Set(SPONSORED_FUNCTIONS.map((f) => `${pkg}::${f}`));
  const calls: string[] = [];
  let gameId: string | null = null;

  for (const input of data.inputs) {
    const w = (input as { FundsWithdrawal?: { withdrawFrom?: { Sponsor?: true } } }).FundsWithdrawal;
    if (w?.withdrawFrom?.Sponsor) return deny('a funds withdrawal draws from the sponsor');
  }

  for (const cmd of data.commands) {
    if (usesGasCoin(cmd)) return deny('a command uses the gas coin');
    if (cmd.MoveCall) {
      const fn = `${normalizeSuiAddress(cmd.MoveCall.package)}::${cmd.MoveCall.module}::${cmd.MoveCall.function}`;
      const short = `0x2::${cmd.MoveCall.module}::${cmd.MoveCall.function}`;
      if (allowed.has(fn)) {
        calls.push(`${cmd.MoveCall.module}::${cmd.MoveCall.function}`);
        const first = cmd.MoveCall.arguments[0];
        const id = first && 'Input' in first ? objectIdOf(data, first.Input) : null;
        if (id) {
          if (gameId && gameId !== id) return deny('calls touch more than one game');
          gameId = id;
        }
      } else if (normalizeSuiAddress(cmd.MoveCall.package) === normalizeSuiAddress('0x2') && FRAMEWORK_CALLS.has(short)) {
        calls.push(short);
      } else {
        return deny(`call to ${fn} is not sponsored`);
      }
    } else if (cmd.SplitCoins || cmd.MergeCoins) {
      // allowed: building the stake from the sender's own coins
    } else {
      return deny(`${cmd.$kind} commands are not sponsored`);
    }
  }
  if (!calls.some((c) => c.startsWith('game::'))) return deny('no Whiteout call');
  return { ok: true, gameId, calls };
}

function deny(reason: string): Verdict {
  return { ok: false, status: 403, reason };
}

function usesGasCoin(cmd: unknown): boolean {
  return JSON.stringify(cmd, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)).includes('"GasCoin"');
}

function objectIdOf(data: TransactionData, index: number): string | null {
  const input = data.inputs[index] as
    | {
        Object?: { SharedObject?: { objectId: string }; ImmOrOwnedObject?: { objectId: string } };
        UnresolvedObject?: { objectId: string };
      }
    | undefined;
  const id =
    input?.Object?.SharedObject?.objectId ?? input?.Object?.ImmOrOwnedObject?.objectId ?? input?.UnresolvedObject?.objectId;
  return id ? normalizeSuiAddress(id) : null;
}
