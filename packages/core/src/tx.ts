/**
 * Transaction builders for every Whiteout Move function (spec section 13). The web
 * client, host CLI, sponsor allowlist and tests all build calls here, so they can
 * never disagree on argument order.
 */
import { Transaction, coinWithBalance, type TransactionArgument } from '@mysten/sui/transactions';
import { TileKind, type DirectionValue } from './constants.js';

const enc = new TextEncoder();

/** Every function the sponsor may pay for (spec section 10, sponsorship rules). */
export const SPONSORED_FUNCTIONS = [
  'game::join',
  'game::join_gated',
  'game::step',
  'game::resolve',
  'game::resolve_fatal',
  'game::claim_relic',
  'game::freeze_overdue',
  'game::finalize_unclaimed',
  'game::withdraw_stake',
  'game::blizzard',
] as const;

export interface Ctx {
  packageId: string;
  /** Coin type T of Game<T>. */
  coinType: string;
}

function target(c: Ctx, fn: string) {
  return `${c.packageId}::game::${fn}` as const;
}

// === Host ===

export function createLobby(
  c: Ctx,
  p: {
    entryStake: bigint;
    maxPlayers: number;
    durationMs: number;
    resolveWindowMs: number;
    wellFund: string;
    host: string;
  },
  tx = new Transaction(),
) {
  const cap = tx.moveCall({
    target: target(c, 'create_lobby'),
    typeArguments: [c.coinType],
    arguments: [
      tx.pure.u64(p.entryStake),
      tx.pure.u16(p.maxPlayers),
      tx.pure.u64(p.durationMs),
      tx.pure.u64(p.resolveWindowMs),
      tx.pure.address(p.wellFund),
    ],
  });
  tx.transferObjects([cap], p.host);
  return tx;
}

/**
 * Phase 2: a ranked lobby. `potShares` are basis points per rank (sum 10 000), one
 * per relic; `blizzardEveryMs`/`blizzardMs` are 0 for no blizzards. The optional
 * allowlist gates the game in the same transaction.
 */
export function createRankedLobby(
  c: Ctx,
  p: {
    entryStake: bigint;
    maxPlayers: number;
    durationMs: number;
    resolveWindowMs: number;
    wellFund: string;
    host: string;
    relics: number;
    potShares: number[];
    blizzardEveryMs: number;
    blizzardMs: number;
  },
  tx = new Transaction(),
) {
  const cap = tx.moveCall({
    target: target(c, 'create_ranked_lobby'),
    typeArguments: [c.coinType],
    arguments: [
      tx.pure.u64(p.entryStake),
      tx.pure.u16(p.maxPlayers),
      tx.pure.u64(p.durationMs),
      tx.pure.u64(p.resolveWindowMs),
      tx.pure.address(p.wellFund),
      tx.pure.u8(p.relics),
      tx.pure.vector('u16', p.potShares),
      tx.pure.u64(p.blizzardEveryMs),
      tx.pure.u64(p.blizzardMs),
    ],
  });
  tx.transferObjects([cap], p.host);
  return tx;
}

/** Phase 2: gate a LOBBY game behind an allowlist. */
export function setAllowlist(c: Ctx, p: { gameId: string; capId: string; listId: string }, tx = new Transaction()) {
  tx.moveCall({
    target: target(c, 'set_allowlist'),
    typeArguments: [c.coinType],
    arguments: [tx.object(p.gameId), tx.object(p.capId), tx.object(p.listId)],
  });
  return tx;
}

// === Phase 2: allowlists ===

export function createAllowlist(c: Pick<Ctx, 'packageId'>, p: { name: string; owner: string }, tx = new Transaction()) {
  const cap = tx.moveCall({
    target: `${c.packageId}::allowlist::create`,
    arguments: [tx.pure.string(p.name)],
  });
  tx.transferObjects([cap], p.owner);
  return tx;
}

/** Adds or removes members, in batches of at most 1 000 per call. */
/** Addresses per allowlist call, and calls per transaction (128 KiB transaction limit). */
export const ALLOWLIST_CALL_BATCH = 400;
export const ALLOWLIST_TX_BATCH = 2000;

export function editAllowlist(
  c: Pick<Ctx, 'packageId'>,
  p: { listId: string; capId: string; add?: string[]; remove?: string[] },
  tx = new Transaction(),
) {
  for (const [fn, list] of [['add', p.add ?? []], ['remove', p.remove ?? []]] as const) {
    // 400 addresses (12.8 KB) per call stays under Sui's 16 KiB limit for one pure argument.
    for (let i = 0; i < list.length; i += ALLOWLIST_CALL_BATCH) {
      tx.moveCall({
        target: `${c.packageId}::allowlist::${fn}`,
        arguments: [tx.object(p.listId), tx.object(p.capId), tx.pure.vector('address', list.slice(i, i + ALLOWLIST_CALL_BATCH))],
      });
    }
  }
  return tx;
}

export function depositPrize(
  c: Ctx,
  p: { gameId: string; capId: string; prizeId: string; prizeType: string },
  tx = new Transaction(),
) {
  tx.moveCall({
    target: target(c, 'deposit_prize'),
    typeArguments: [c.coinType, p.prizeType],
    arguments: [tx.object(p.gameId), tx.object(p.capId), tx.object(p.prizeId)],
  });
  return tx;
}

export function cancel(
  c: Ctx,
  p: { gameId: string; capId: string; prizeType: string | null; host: string },
  tx = new Transaction(),
) {
  if (p.prizeType) {
    const prize = tx.moveCall({
      target: target(c, 'cancel'),
      typeArguments: [c.coinType, p.prizeType],
      arguments: [tx.object(p.gameId), tx.object(p.capId)],
    });
    tx.transferObjects([prize], p.host);
  } else {
    tx.moveCall({
      target: target(c, 'cancel_empty'),
      typeArguments: [c.coinType],
      arguments: [tx.object(p.gameId), tx.object(p.capId)],
    });
  }
  return tx;
}

/** The registry and pinned config an enclave deal must cite; throws if not deployed. */
export function dealerObjects(cfg: { dealerRegistryId?: string; enclaveConfigId: string }) {
  if (!cfg.dealerRegistryId || !cfg.enclaveConfigId) {
    throw new Error('No dealer enclave is registered on this network yet (dealerRegistryId / enclaveConfigId missing).');
  }
  return { registryId: cfg.dealerRegistryId, configId: cfg.enclaveConfigId };
}

export function sealDealEnclave(
  c: Ctx,
  p: {
    gameId: string;
    capId: string;
    /** The shared DealerRegistry and its pinned EnclaveConfig<DEALER>. */
    registryId: string;
    configId: string;
    enclaveId: string;
    dealTs: bigint;
    ctHash: Uint8Array;
    quiltId: string;
    dealSig: Uint8Array;
  },
  tx = new Transaction(),
) {
  tx.moveCall({
    target: target(c, 'seal_deal_enclave'),
    typeArguments: [c.coinType],
    arguments: [
      tx.object(p.gameId),
      tx.object(p.capId),
      tx.object(p.registryId),
      tx.object(p.configId),
      tx.object(p.enclaveId),
      tx.pure.u64(p.dealTs),
      tx.pure.vector('u8', p.ctHash),
      tx.pure.vector('u8', enc.encode(p.quiltId)),
      tx.pure.vector('u8', p.dealSig),
      tx.object.clock(),
    ],
  });
  return tx;
}

export function sealDealCeremony(
  c: Ctx,
  p: { gameId: string; capId: string; dealerPk: Uint8Array; dealTs: bigint; ctHash: Uint8Array; quiltId: string },
  tx = new Transaction(),
) {
  tx.moveCall({
    target: target(c, 'seal_deal_ceremony'),
    typeArguments: [c.coinType],
    arguments: [
      tx.object(p.gameId),
      tx.object(p.capId),
      tx.pure.vector('u8', p.dealerPk),
      tx.pure.u64(p.dealTs),
      tx.pure.vector('u8', p.ctHash),
      tx.pure.vector('u8', enc.encode(p.quiltId)),
      tx.object.clock(),
    ],
  });
  return tx;
}

export function reclaimPrize(
  c: Ctx,
  p: { gameId: string; capId: string; prizeType: string; host: string },
  tx = new Transaction(),
) {
  const prize = tx.moveCall({
    target: target(c, 'reclaim_prize'),
    typeArguments: [c.coinType, p.prizeType],
    arguments: [tx.object(p.gameId), tx.object(p.capId)],
  });
  tx.transferObjects([prize], p.host);
  return tx;
}

export function publishThaw(c: Ctx, p: { gameId: string; capId: string; blobId: string }, tx = new Transaction()) {
  tx.moveCall({
    target: target(c, 'publish_thaw'),
    typeArguments: [c.coinType],
    arguments: [tx.object(p.gameId), tx.object(p.capId), tx.pure.vector('u8', enc.encode(p.blobId)), tx.object.clock()],
  });
  return tx;
}

// === Players ===

/**
 * Join with the exact stake. The stake coin is split from the player's own coins and
 * never from the gas coin, so a sponsored join cannot spend the sponsor's gas.
 */
export function join(
  c: Ctx,
  p: {
    gameId: string;
    stake: bigint;
    column: number;
    allowlistId?: string | null;
    /** False when the player pays their own gas: a SUI stake may then come from the gas coin too. */
    sponsored?: boolean;
  },
  tx = new Transaction(),
) {
  const useGasCoin = p.sponsored === false && /::sui::SUI$/.test(c.coinType);
  const stake: TransactionArgument =
    p.stake === 0n
      ? tx.moveCall({ target: '0x2::coin::zero', typeArguments: [c.coinType] })
      : tx.add(coinWithBalance({ type: c.coinType, balance: p.stake, useGasCoin }));
  if (p.allowlistId) {
    // Phase 2: a gated game takes its allowlist.
    tx.moveCall({
      target: target(c, 'join_gated'),
      typeArguments: [c.coinType],
      arguments: [tx.object(p.gameId), tx.object(p.allowlistId), stake, tx.pure.u8(p.column), tx.object.clock()],
    });
  } else {
    tx.moveCall({
      target: target(c, 'join'),
      typeArguments: [c.coinType],
      arguments: [tx.object(p.gameId), stake, tx.pure.u8(p.column), tx.object.clock()],
    });
  }
  return tx;
}

/** Phase 2: start a due blizzard (anyone may). */
export function blizzard(c: Ctx, p: { gameId: string }, tx = new Transaction()) {
  tx.moveCall({
    target: target(c, 'blizzard'),
    typeArguments: [c.coinType],
    arguments: [tx.object(p.gameId), tx.object.random(), tx.object.clock()],
  });
  return tx;
}

export function step(
  c: Ctx,
  p: { gameId: string; explorerId: string; dir: DirectionValue },
  tx = new Transaction(),
) {
  tx.moveCall({
    target: target(c, 'step'),
    typeArguments: [c.coinType],
    arguments: [tx.object(p.gameId), tx.object(p.explorerId), tx.pure.u8(p.dir), tx.object.clock()],
  });
  return tx;
}

/**
 * Resolves the pending tile with whichever call its kind needs: `resolve`,
 * `resolve_fatal` (crevasse, no rope) or `claim_relic` (relic, hunt live).
 */
export function resolveTile(
  c: Ctx,
  p: {
    gameId: string;
    explorerId: string;
    kind: number;
    kindSig: Uint8Array;
    ropes: number;
    huntLive: boolean;
    /** Prize type of the next rank (the one this claim would take). */
    prizeType: string | null;
    /** Phase 2: someone already claimed this relic, so it resolves as ground. */
    relicClaimed?: boolean;
  },
  tx = new Transaction(),
) {
  const sig = () => tx.pure.vector('u8', p.kindSig);
  if (p.kind === TileKind.CREVASSE && p.ropes === 0) {
    tx.moveCall({
      target: target(c, 'resolve_fatal'),
      typeArguments: [c.coinType],
      arguments: [tx.object(p.gameId), tx.object(p.explorerId), sig(), tx.object.clock()],
    });
  } else if (p.kind === TileKind.RELIC && p.huntLive && !p.relicClaimed) {
    if (!p.prizeType) throw new Error('prize type unknown');
    tx.moveCall({
      target: target(c, 'claim_relic'),
      typeArguments: [c.coinType, p.prizeType],
      arguments: [tx.object(p.gameId), tx.object(p.explorerId), sig(), tx.object.clock()],
    });
  } else {
    tx.moveCall({
      target: target(c, 'resolve'),
      typeArguments: [c.coinType],
      arguments: [tx.object(p.gameId), tx.object(p.explorerId), tx.pure.u8(p.kind), sig(), tx.object.clock()],
    });
  }
  return tx;
}

/** Whether a resolve of this kind can share a transaction with the next step. */
export function canBatchWithStep(kind: number, ropes: number, huntLive: boolean, relicClaimed = false): boolean {
  if (kind === TileKind.CREVASSE && ropes === 0) return false;
  if (kind === TileKind.RELIC && huntLive && !relicClaimed) return false;
  return true;
}

export function freezeOverdue(c: Ctx, p: { gameId: string; explorerId: string }, tx = new Transaction()) {
  tx.moveCall({
    target: target(c, 'freeze_overdue'),
    typeArguments: [c.coinType],
    arguments: [tx.object(p.gameId), tx.object(p.explorerId), tx.object.clock()],
  });
  return tx;
}

export function finalizeUnclaimed(c: Ctx, p: { gameId: string }, tx = new Transaction()) {
  tx.moveCall({
    target: target(c, 'finalize_unclaimed'),
    typeArguments: [c.coinType],
    arguments: [tx.object(p.gameId), tx.object.clock()],
  });
  return tx;
}

export function withdrawStake(c: Ctx, p: { gameId: string; explorerId: string }, tx = new Transaction()) {
  tx.moveCall({
    target: target(c, 'withdraw_stake'),
    typeArguments: [c.coinType],
    arguments: [tx.object(p.gameId), tx.object(p.explorerId), tx.object.clock()],
  });
  return tx;
}

// === Seal policy ===

/**
 * A transaction kind calling `seal_approve` once per tile, for `fetchKeys`.
 * Every call targets the same package, as Seal requires.
 */
export function sealApprove(
  c: Ctx,
  p: { gameId: string; explorerId: string; identities: Uint8Array[] },
  tx = new Transaction(),
) {
  for (const id of p.identities) {
    tx.moveCall({
      target: `${c.packageId}::policy::seal_approve`,
      typeArguments: [c.coinType],
      arguments: [tx.pure.vector('u8', id), tx.object(p.gameId), tx.object(p.explorerId), tx.object.clock()],
    });
  }
  return tx;
}

/** The thaw: any tile of an ended game, no Explorer needed. */
export function sealApproveThaw(c: Ctx, p: { gameId: string; identities: Uint8Array[] }, tx = new Transaction()) {
  for (const id of p.identities) {
    tx.moveCall({
      target: `${c.packageId}::policy::seal_approve_thaw`,
      typeArguments: [c.coinType],
      arguments: [tx.pure.vector('u8', id), tx.object(p.gameId), tx.object.clock()],
    });
  }
  return tx;
}
