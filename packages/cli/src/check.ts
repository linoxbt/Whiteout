/**
 * Deployment verification (spec section 19, last row): run on a second machine.
 * Rebuilt PCRs match the on-chain config, the UpgradeCaps are gone, the deploy file's
 * IDs exist with the right types, and the dealer build config pins this package and
 * the configured key servers with their on-chain public keys.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EnclaveBcs, EnclaveConfigBcs, makeSealClient, sameId, toHex } from '@whiteout/core';
import { parsePcrs } from './admin.js';
import { REPO_ROOT, type Env } from './env.js';

export interface Check {
  name: string;
  ok: boolean | 'warn';
  detail: string;
}

export interface DealerFileConfig {
  network: string;
  package_id: string;
  threshold: number;
  key_servers: Array<{ object_id: string; public_key: string; weight: number }>;
}

/** Compares the dealer build config with the network config and the key servers' on-chain keys. */
export function checkDealerConfig(
  file: DealerFileConfig,
  expected: { packageId: string; threshold: number; servers: Array<{ objectId: string; weight: number }> },
  onChainKeys: Map<string, string>,
): Check[] {
  const out: Check[] = [];
  out.push({ name: 'Dealer config pins this package', ok: sameId(file.package_id, expected.packageId), detail: file.package_id });
  out.push({ name: 'Dealer config threshold', ok: file.threshold === expected.threshold, detail: `${file.threshold} (expected ${expected.threshold})` });
  const ids = (xs: Array<{ id: string; w: number }>) => xs.map((x) => `${x.id.toLowerCase()}:${x.w}`).sort().join(',');
  out.push({
    name: 'Dealer config key servers',
    ok: ids(file.key_servers.map((k) => ({ id: k.object_id, w: k.weight }))) === ids(expected.servers.map((s) => ({ id: s.objectId, w: s.weight }))),
    detail: file.key_servers.map((k) => k.object_id.slice(0, 10)).join(', '),
  });
  for (const k of file.key_servers) {
    const chain = onChainKeys.get(k.object_id.toLowerCase());
    out.push({
      name: `Public key of ${k.object_id.slice(0, 10)}… matches chain`,
      ok: !!chain && chain === k.public_key.replace(/^0x/, '').toLowerCase(),
      detail: chain ? 'compared' : 'key server not found on chain',
    });
  }
  return out;
}

export function comparePcrs(onChain: string[], rebuilt: string[]): Check {
  const same = onChain.length === 3 && onChain.every((p, i) => p.toLowerCase() === rebuilt[i]?.toLowerCase());
  return { name: 'Rebuilt PCRs match EnclaveConfig', ok: same, detail: same ? 'PCR0-2 identical' : 'PCRs differ' };
}

export async function checkDeployment(e: Env, opts: { pcrs?: string }): Promise<Check[]> {
  const out: Check[] = [];
  const pkg = e.cfg.packageId;
  const get = async (id: string) => {
    try {
      return (await e.client.core.getObject({ objectId: id, include: { content: true } })).object;
    } catch {
      return null;
    }
  };

  const p = await get(pkg);
  out.push({ name: 'Package exists', ok: !!p, detail: pkg });

  const caps = e.deploy.upgradeCapIds ?? [];
  if (!caps.length) out.push({ name: 'UpgradeCaps recorded', ok: 'warn', detail: 'none recorded in the deploy file' });
  else {
    const alive = (await Promise.all(caps.map(get))).filter(Boolean).length;
    out.push({
      name: 'Package is immutable (UpgradeCaps destroyed)',
      ok: alive === 0 ? true : e.cfg.network === 'mainnet' ? false : 'warn',
      detail: alive ? `${alive} UpgradeCap(s) still exist` : 'all destroyed',
    });
  }

  let configVersion: bigint | null = null;
  if (e.cfg.enclaveConfigId) {
    const c = await get(e.cfg.enclaveConfigId);
    const typeOk = !!c && c.type.includes('::enclave::EnclaveConfig<') && c.type.includes('::dealer::DEALER');
    out.push({ name: 'EnclaveConfig<DEALER> exists', ok: typeOk, detail: c?.type ?? 'missing' });
    if (c && typeOk) {
      const cfg = EnclaveConfigBcs.parse(c.content);
      configVersion = BigInt(cfg.version);
      const onChain = cfg.pcrs.map((x) => toHex(Uint8Array.from(x)));
      out.push({ name: 'PCRs are from a release build', ok: !onChain.every((x) => /^0+$/.test(x)), detail: 'debug builds give all-zero PCRs' });
      if (opts.pcrs) out.push(comparePcrs(onChain, parsePcrs(readFileSync(opts.pcrs, 'utf8'))));
      else out.push({ name: 'Rebuilt PCRs compared', ok: 'warn', detail: 'pass --pcrs out/nitro.pcrs from your own build' });
    }
  } else out.push({ name: 'EnclaveConfig recorded', ok: 'warn', detail: 'enclaveConfigId not set' });

  if (e.deploy.dealerEnclaveId) {
    const en = await get(e.deploy.dealerEnclaveId);
    const ok = !!en && en.type.includes('::enclave::Enclave<') && en.type.includes('::dealer::DEALER');
    out.push({ name: 'Enclave<DEALER> exists', ok, detail: en?.type ?? 'missing' });
    if (en && ok && configVersion !== null) {
      const v = BigInt(EnclaveBcs.parse(en.content).config_version);
      out.push({ name: 'Enclave registered against the current PCRs', ok: v === configVersion, detail: `enclave v${v}, config v${configVersion}` });
    }
  } else out.push({ name: 'Enclave recorded', ok: 'warn', detail: 'dealerEnclaveId not set' });

  const dealerPath = join(REPO_ROOT, 'enclave/whiteout-dealer/src/nautilus-server/config', `${e.cfg.network}.json`);
  const file = JSON.parse(readFileSync(dealerPath, 'utf8')) as DealerFileConfig;
  const servers = await makeSealClient(e.client, e.cfg).getKeyServers().catch(() => new Map());
  const keys = new Map([...servers.values()].map((k) => [k.objectId.toLowerCase(), toHex(k.pk)]));
  out.push(...checkDealerConfig(file, { packageId: pkg, threshold: e.cfg.sealThreshold, servers: e.cfg.sealServers }, keys));
  return out;
}

export function printChecks(checks: Check[]): boolean {
  for (const c of checks) console.log(`${c.ok === true ? '✓' : c.ok === 'warn' ? '!' : '✗'} ${c.name}: ${c.detail}`);
  const failed = checks.filter((c) => c.ok === false).length;
  console.log(failed ? `\n${failed} check(s) failed.` : '\nAll required checks passed.');
  return failed === 0;
}
