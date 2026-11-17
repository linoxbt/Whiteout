/**
 * The Seal reading session (spec section 11): one signature lets this device read the
 * player's tiles for 30 minutes. Kept in IndexedDB so a reload does not ask again.
 * A thief who copied it could read only what the player can read anyway (spec section 9).
 */
import { SessionKey, type ExportedSessionKey } from '@mysten/seal';
import { SESSION_TTL_MIN } from '@whiteout/core';
import { config, suiClient } from '../config';
import { dAppKit } from '../dappkit';
import { kvGet, kvSet } from './store';

const key = (address: string) => `session:${config.packageId}:${address.toLowerCase()}`;
/** Treat a session as expired a minute early, so a reveal never starts on a dying key. */
const MARGIN_MS = 60_000;

const live = new Map<string, SessionKey>();

export function expiresAt(e: ExportedSessionKey): number {
  return e.creationTimeMs + e.ttlMin * 60_000;
}

/** A still-valid session for this address, from memory or IndexedDB, or null. */
export async function loadSession(address: string): Promise<SessionKey | null> {
  const mem = live.get(address);
  if (mem && !mem.isExpired()) return mem;
  const saved = await kvGet<ExportedSessionKey>(key(address));
  if (!saved || !saved.personalMessageSignature || expiresAt(saved) - MARGIN_MS < Date.now()) return null;
  try {
    const sk = SessionKey.import(saved, suiClient);
    if (sk.isExpired()) return null;
    live.set(address, sk);
    return sk;
  } catch {
    return null;
  }
}

/** Whether this device has held a session for the address before (re-prompts are silent). */
export async function hadSession(address: string): Promise<boolean> {
  return !!(await kvGet<ExportedSessionKey>(key(address)));
}

/** Asks the wallet for the one signature, then stores the session. */
export async function createSession(address: string): Promise<SessionKey> {
  const sk = await SessionKey.create({ address, packageId: config.packageId, ttlMin: SESSION_TTL_MIN, suiClient });
  const { signature } = await dAppKit.signPersonalMessage({ message: sk.getPersonalMessage() });
  await sk.setPersonalMessageSignature(signature);
  live.set(address, sk);
  await kvSet(key(address), sk.export());
  return sk;
}
