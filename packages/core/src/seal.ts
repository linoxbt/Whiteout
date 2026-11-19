/** Seal client helpers: encryption for the dealer, batched key fetch and decrypt for players. */
import { EncryptedObject, SealClient, SessionKey, type SealCompatibleClient } from '@mysten/seal';
import { Transaction } from '@mysten/sui/transactions';
import type { NetworkConfig } from './config.js';
import { sleep } from './errors.js';
import { encodeIdentity, identityHex } from './identity.js';
import { decodeTilePlaintext, verifyClueSig, verifyKindSig, type Tile } from './messages.js';
import * as tx from './tx.js';

export { SealClient, SessionKey };

export function makeSealClient(suiClient: SealCompatibleClient, cfg: NetworkConfig): SealClient {
  return new SealClient({
    suiClient,
    serverConfigs: cfg.sealServers.map((s) => ({ ...s })),
    verifyKeyServers: true,
  });
}

/** Encryptor for `deal()`: Seal-encrypts one tile under identity game_id ‖ x ‖ y. */
export function sealEncryptor(seal: SealClient, packageId: string, threshold: number) {
  return async (idHex: string, plaintext: Uint8Array) => {
    const { encryptedObject } = await seal.encrypt({ threshold, packageId, id: idHex, data: plaintext });
    return encryptedObject;
  };
}

/** The key-server object IDs a ciphertext was encrypted to (Verify page, AC25). */
export function ciphertextServers(ct: Uint8Array): { ids: string[]; threshold: number; id: string; packageId: string } {
  const o = EncryptedObject.parse(ct);
  // packageId names the package whose seal_approve guards the key: it must be ours,
  // or key servers would follow another package's policy.
  return { ids: o.services.map(([id]) => id), threshold: o.threshold, id: o.id, packageId: o.packageId };
}

export const SESSION_TTL_MIN = 30;

/**
 * Decrypts and verifies the tiles a player may read. One `fetchKeys` call covers all
 * of them (NFR3). Policy denials right after a step are retried 6 x 1 s, as Seal
 * documents them as a normal effect of state lag (spec section 12).
 */
export async function decryptTiles(opts: {
  seal: SealClient;
  suiClient: SealCompatibleClient;
  ctx: tx.Ctx;
  gameId: string;
  /** Omit for the thaw (no Explorer needed). */
  explorerId?: string;
  dealerPk: Uint8Array;
  dealTs: bigint;
  threshold: number;
  sessionKey: SessionKey;
  tiles: Array<{ x: number; y: number; ct: Uint8Array }>;
  retries?: number;
}): Promise<Array<{ tile: Tile; verified: boolean; kindOk: boolean; clueOk: boolean }>> {
  const { seal, ctx, gameId, explorerId, tiles } = opts;
  const identities = tiles.map((t) => encodeIdentity(gameId, t.x, t.y));
  const t = new Transaction();
  if (explorerId) tx.sealApprove(ctx, { gameId, explorerId, identities }, t);
  else tx.sealApproveThaw(ctx, { gameId, identities }, t);
  const txBytes = await t.build({ client: opts.suiClient as never, onlyTransactionKind: true });
  const ids = tiles.map((x) => identityHex(gameId, x.x, x.y));

  const tries = opts.retries ?? 6;
  for (let i = 0; ; i++) {
    try {
      await seal.fetchKeys({ ids, txBytes, sessionKey: opts.sessionKey, threshold: opts.threshold });
      break;
    } catch (e) {
      const name = (e as Error).name ?? '';
      const retryable = /NoAccess|InvalidParameter|TooManyFailed|Timeout|fetch/i.test(name + (e as Error).message);
      if (!retryable || i >= tries - 1) throw e;
      await sleep(1000);
    }
  }
  const out: Array<{ tile: Tile; verified: boolean; kindOk: boolean; clueOk: boolean }> = [];
  for (const c of tiles) {
    const pt = await seal.decrypt({ data: c.ct, sessionKey: opts.sessionKey, txBytes });
    const tile = decodeTilePlaintext(c.x, c.y, Uint8Array.from(pt));
    // Kept apart (spec F6): a valid kind signature still lets the player resolve the
    // tile on-chain even if its clue fails, so a bad clue can never freeze them.
    const kindOk = verifyKindSig(opts.dealerPk, gameId, opts.dealTs, tile);
    const clueOk = verifyClueSig(opts.dealerPk, gameId, opts.dealTs, tile);
    out.push({ tile, verified: kindOk && clueOk, kindOk, clueOk });
  }
  return out;
}
