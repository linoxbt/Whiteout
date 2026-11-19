/**
 * Is this object ID really a `Game<T>` of the Whiteout package? Read once from a full
 * node and cached: an object's type never changes, so positive answers are kept until
 * evicted; negative answers expire after a minute (a game created a moment ago appears).
 */
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { makeClient } from '@whiteout/core';

/** The full node could not be asked. The app answers 502 (sponsor) or 503 (beacon). */
export class UpstreamError extends Error {
  override name = 'UpstreamError';
}

export interface GameRegistry {
  /** Throws UpstreamError when the full node cannot be reached. */
  isGame(objectId: string): Promise<boolean>;
}

/** Returns the object's Move type, or null when it does not exist. Throws when the node cannot answer. */
export type TypeLookup = (objectId: string) => Promise<string | null>;

export class CachedGameRegistry implements GameRegistry {
  #cache = new Map<string, { ok: boolean; exp: number }>();
  #inflight = new Map<string, Promise<boolean>>();
  readonly #prefix: string;

  constructor(
    private lookup: TypeLookup,
    packageId: string,
    private opts: { max?: number; negativeTtlMs?: number; now?: () => number } = {},
  ) {
    this.#prefix = `${normalizeSuiAddress(packageId)}::game::Game<`;
  }

  async isGame(objectId: string): Promise<boolean> {
    const id = normalizeSuiAddress(objectId);
    const now = (this.opts.now ?? Date.now)();
    const hit = this.#cache.get(id);
    if (hit && hit.exp > now) return hit.ok;
    const pending = this.#inflight.get(id);
    if (pending) return pending;
    const p = (async () => {
      let type: string | null;
      try {
        type = await this.lookup(id);
      } catch (e) {
        throw new UpstreamError(`full node: ${(e as Error).message}`);
      }
      const ok = !!type && this.#matches(type);
      this.#remember(id, ok, ok ? Number.POSITIVE_INFINITY : now + (this.opts.negativeTtlMs ?? 60_000));
      return ok;
    })();
    this.#inflight.set(id, p);
    try {
      return await p;
    } finally {
      this.#inflight.delete(id);
    }
  }

  #matches(type: string): boolean {
    // Normalize the package address in the type string (full nodes may shorten it).
    const m = /^(0x[0-9a-fA-F]{1,64})(::game::Game<.+>)$/.exec(type.trim());
    return !!m && `${normalizeSuiAddress(m[1]!)}${m[2]}`.startsWith(this.#prefix);
  }

  #remember(id: string, ok: boolean, exp: number) {
    const max = this.opts.max ?? 10_000;
    if (this.#cache.size >= max) {
      // Drop the oldest entry (Map keeps insertion order).
      const first = this.#cache.keys().next();
      if (!first.done) this.#cache.delete(first.value);
    }
    this.#cache.set(id, { ok, exp });
  }
}

/** Type lookup through the same gRPC client the rest of the repo uses. */
export function fullnodeTypeLookup(network: string, rpcUrl: string): TypeLookup {
  const client = makeClient({ network: network as 'testnet', rpcUrl });
  return async (objectId) => {
    const { objects } = await client.core.getObjects({ objectIds: [objectId] });
    const o = objects[0];
    if (!o || o instanceof Error) return null;
    return o.type;
  };
}
