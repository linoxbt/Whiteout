/**
 * What the sponsor will pay for (spec sections 9, 10 and 12, plus the review fixes). A
 * transaction kind is sponsored only if:
 *  - every MoveCall targets the Whiteout package and an allowed function, or one of the
 *    few framework calls the SDK emits to build a stake coin from the sender's own funds;
 *  - every Whiteout call takes the game object as its first argument, and all of them
 *    touch the same game;
 *  - no command touches the gas coin (it belongs to the sponsor);
 *  - every funds withdrawal draws from the sender's own address balance;
 *  - `coin::send_funds` only returns change to the sender (checked once the sender is
 *    known, see checkRecipients);
 *  - the only other commands are SplitCoins and MergeCoins.
 */
import { bcs } from '@mysten/sui/bcs';
import { fromBase64, normalizeSuiAddress } from '@mysten/sui/utils';
import type { TransactionData } from '@mysten/sui/transactions';
import { SPONSORED_FUNCTIONS } from '@whiteout/core';

/**
 * Framework calls `tx.join` emits through `coinWithBalance({ useGasCoin: false })`
 * (checked against @mysten/sui 2.x, see test "real join transactions"):
 *  - stake 0:                         coin::zero
 *  - stake from owned coins:          [MergeCoins] SplitCoins [coin::destroy_zero]
 *  - stake from the address balance:  coin::redeem_funds [MergeCoins] SplitCoins coin::send_funds(change, sender)
 * Nothing else (in particular no balance:: conversions) is needed to build a stake.
 */
export const FRAMEWORK_CALLS = new Set(['0x2::coin::zero', '0x2::coin::redeem_funds', '0x2::coin::destroy_zero', '0x2::coin::send_funds']);

export type Verdict =
  | {
      ok: true;
      gameId: string;
      calls: string[];
      /** Recipients of `coin::send_funds`, each of which must be the sender. */
      recipients: string[];
    }
  | { ok: false; status: 400 | 403; reason: string };

const FRAMEWORK = normalizeSuiAddress('0x2');

export function checkKind(data: TransactionData, packageId: string): Verdict {
  const pkg = normalizeSuiAddress(packageId);
  const allowed = new Set(SPONSORED_FUNCTIONS.map((f) => `${pkg}::${f}`));
  const calls: string[] = [];
  const recipients: string[] = [];
  let gameId: string | null = null;

  for (const input of data.inputs) {
    const w = (input as { FundsWithdrawal?: { withdrawFrom?: { Sender?: true } } }).FundsWithdrawal;
    if (w && !w.withdrawFrom?.Sender) return deny('a funds withdrawal does not draw from the sender');
  }

  for (const cmd of data.commands) {
    if (usesGasCoin(cmd)) return deny('a command uses the gas coin');
    if (cmd.MoveCall) {
      const { module, function: fun, arguments: args } = cmd.MoveCall;
      const callPkg = normalizeSuiAddress(cmd.MoveCall.package);
      const fn = `${callPkg}::${module}::${fun}`;
      const short = `0x2::${module}::${fun}`;
      if (allowed.has(fn)) {
        calls.push(`${module}::${fun}`);
        const first = args[0];
        const id = first && first.$kind === 'Input' ? objectIdOf(data, first.Input) : null;
        if (!id) return deny(`${module}::${fun} must take the game object as its first argument`);
        if (gameId && gameId !== id) return deny('calls touch more than one game');
        gameId = id;
      } else if (callPkg === FRAMEWORK && FRAMEWORK_CALLS.has(short)) {
        if (short === '0x2::coin::send_funds') {
          const to = args[1];
          const addr = to && to.$kind === 'Input' ? pureAddressOf(data, to.Input) : null;
          if (!addr) return deny('coin::send_funds must send to a literal address');
          recipients.push(addr);
        }
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
  if (!gameId || !calls.some((c) => c.startsWith('game::'))) return deny('no Whiteout call');
  return { ok: true, gameId, calls, recipients };
}

/** Second half of the policy, once Enoki has told us who the sender is. */
export function checkRecipients(v: Extract<Verdict, { ok: true }>, sender: string): Verdict {
  const me = normalizeSuiAddress(sender);
  if (v.recipients.some((r) => r !== me)) return deny('coin::send_funds may only return change to the sender');
  return v;
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

function pureAddressOf(data: TransactionData, index: number): string | null {
  const input = data.inputs[index] as { Pure?: { bytes: string }; UnresolvedPure?: { value: unknown } } | undefined;
  try {
    if (input?.Pure) {
      const raw = fromBase64(input.Pure.bytes);
      if (raw.length !== 32) return null;
      return normalizeSuiAddress(bcs.Address.parse(raw));
    }
    if (input?.UnresolvedPure && typeof input.UnresolvedPure.value === 'string') {
      return normalizeSuiAddress(input.UnresolvedPure.value);
    }
  } catch {
    return null;
  }
  return null;
}
