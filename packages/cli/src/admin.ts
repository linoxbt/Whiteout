/**
 * Deployment steps after `sui client publish` (spec section 13, deployment order):
 *   1. admin record          read the publish transaction into deploy/<network>.json
 *   2. pin-dealer, then build the enclave (make NETWORK=...) to get out/nitro.pcrs
 *   3. admin enclave-config  create and pin the one EnclaveConfig<DEALER> with the release PCRs
 *   4. admin register        register the running enclave from its attestation
 *   5. admin make-immutable  destroy the UpgradeCap (MD6)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { Command } from 'commander';
import { Transaction } from '@mysten/sui/transactions';
import { fromHex } from '@whiteout/core';
import { checkDeployment, printChecks } from './check.js';
import { exec, loadEnv, type GlobalOpts } from './env.js';

type Deploy = Record<string, unknown> & { upgradeCapIds?: string[]; upgradeCapDestroyDigests?: string[] };

export function registerAdmin(program: Command) {
  const admin = program.command('admin').description('Deployment steps for the package owner');
  const env = () => loadEnv(program.opts<GlobalOpts>(), true, true);
  const update = (path: string, patch: Partial<Deploy>) => {
    const cur = JSON.parse(readFileSync(path, 'utf8')) as Deploy;
    writeFileSync(path, `${JSON.stringify({ ...cur, ...patch }, null, 2)}\n`);
  };

  /** Reads a publish transaction's effects into the deploy file. */
  async function record(digest: string) {
    const e = env();
    const res = await e.client.core.getTransaction({ digest, include: { effects: true, objectTypes: true } });
    const t = res.Transaction ?? res.FailedTransaction!;
    const changes = t.effects!.changedObjects;
    const packageId = changes.find((c) => c.outputState === 'PackageWrite')?.objectId;
    const typeOf = (id: string) => t.objectTypes?.[id] ?? '';
    const caps = changes.filter((c) => c.idOperation === 'Created' && /^0x0*2::package::UpgradeCap$/.test(typeOf(c.objectId))).map((c) => c.objectId);
    // Cap<DEALER> lives inside the shared DealerRegistry, which pins the one dealer config.
    const registry = changes.find((c) => c.idOperation === 'Created' && /::dealer::DealerRegistry$/.test(typeOf(c.objectId)))?.objectId;
    if (!packageId) throw new Error('No package was published in that transaction.');
    update(e.deployPath, {
      packageId,
      enclavePackageId: packageId,
      upgradeCapIds: caps,
      dealerRegistryId: registry ?? '',
      enclaveConfigId: '',
      dealerEnclaveId: '',
      publishDigest: digest,
    });
    console.log(`Package ${packageId}\nUpgradeCap ${caps.join(', ')}\nDealerRegistry ${registry}\nSaved to ${e.deployPath}`);
    console.log(`\nNext: whiteout -n ${e.cfg.network} pin-dealer, then build the enclave and run admin enclave-config`);
  }

  admin
    .command('publish')
    .description('Publish the package from compiled bytecode (CI artifact whiteout-bytecode-<network>) and record it')
    .requiredOption('--bytecode <file>', 'output of sui move build --dump-bytecode-as-base64 --with-unpublished-dependencies')
    .action(async (o) => {
      const e = env();
      const build = JSON.parse(readFileSync(o.bytecode, 'utf8')) as { modules: string[]; dependencies: string[] };
      const t = new Transaction();
      const [cap] = t.publish({ modules: build.modules, dependencies: build.dependencies });
      t.transferObjects([cap!], e.address);
      const r = await exec(e, t);
      console.log(`Published in ${r.digest}`);
      await record(r.digest);
    });

  admin
    .command('record')
    .description('Record the package ID, UpgradeCap and Cap<DEALER> from a publish transaction')
    .requiredOption('--digest <digest>', 'digest of the publish transaction')
    .action(async (o) => record(o.digest));

  admin
    .command('enclave-config')
    .description('Create EnclaveConfig<DEALER> holding the release PCRs (from out/nitro.pcrs)')
    .option('--pcrs <file>', 'nitro.pcrs file from the enclave build', '../../enclave/whiteout-dealer/out/nitro.pcrs')
    .option('--pcr0 <hex>')
    .option('--pcr1 <hex>')
    .option('--pcr2 <hex>')
    .option('--name <name>', 'config name', 'whiteout dealer')
    .action(async (o) => {
      const e = env();
      const deploy = e.deploy as Deploy;
      const pcrs = o.pcr0 ? [o.pcr0, o.pcr1, o.pcr2] : parsePcrs(readFileSync(o.pcrs, 'utf8'));
      if (pcrs.some((p: string) => /^0+$/.test(p))) throw new Error('All-zero PCRs come from a debug build. Use a release build (spec section 21).');
      const registryId = deploy.dealerRegistryId ? String(deploy.dealerRegistryId) : "";
      if (!registryId) throw new Error('dealerRegistryId missing: publish the package with `admin publish` first.');
      // 1. The registry creates the one config (shared, so its ID is known after this tx).
      const t = new Transaction();
      t.moveCall({
        target: `${e.cfg.packageId}::dealer::create_config`,
        arguments: [
          t.object(registryId),
          t.pure.string(o.name),
          ...pcrs.map((p: string) => t.pure.vector('u8', fromHex(p))),
        ],
      });
      const r = await exec(e, t);
      const id = r.created.find((c) => c.type.includes('::enclave::EnclaveConfig<'))!.id;
      // 2. Pin it: from now on game::seal_deal_enclave accepts only enclaves registered against it.
      const p = new Transaction();
      p.moveCall({ target: `${e.cfg.packageId}::dealer::pin_config`, arguments: [p.object(registryId), p.object(id)] });
      const r2 = await exec(e, p);
      update(e.deployPath, { enclaveConfigId: id });
      console.log(`EnclaveConfig ${id} pinned (digests ${r.digest}, ${r2.digest})`);
    });

  admin
    .command('register')
    .description("Register a running enclave from its attestation (the template's register_enclave.sh)")
    .requiredOption('--url <url>', 'enclave base URL, e.g. http://<ec2-ip>:3000')
    .action(async (o) => {
      const e = env();
      const att = (await (await fetch(`${o.url.replace(/\/$/, '')}/get_attestation`)).json()) as { attestation?: string; error?: string };
      if (!att.attestation) throw new Error(att.error ?? 'no attestation');
      const t = new Transaction();
      const doc = t.moveCall({
        target: '0x2::nitro_attestation::load_nitro_attestation',
        arguments: [t.pure.vector('u8', fromHex(att.attestation)), t.object.clock()],
      });
      t.moveCall({
        target: `${e.cfg.enclavePackageId}::enclave::register_enclave`,
        typeArguments: [`${e.cfg.packageId}::dealer::DEALER`],
        arguments: [t.object(e.cfg.enclaveConfigId), doc],
      });
      const r = await exec(e, t);
      const id = r.created.find((c) => c.type.includes('::enclave::Enclave<'))!.id;
      update(e.deployPath, { dealerEnclaveId: id });
      console.log(`Enclave<DEALER> ${id} (digest ${r.digest})`);
    });

  admin
    .command('check-deployment')
    .description('Verify a deployment from a second machine (spec section 19): PCRs, immutability, IDs, dealer config')
    .option('--pcrs <file>', 'nitro.pcrs from your own rebuild, to compare with the chain')
    .action(async (o) => {
      const e = loadEnv(program.opts<GlobalOpts>(), false);
      if (!printChecks(await checkDeployment(e, { pcrs: o.pcrs }))) process.exitCode = 1;
    });

  admin
    .command('make-immutable')
    .description('Destroy every recorded UpgradeCap (MD6). Irreversible.')
    .requiredOption('--yes-i-understand', 'confirm: the package can never be changed again')
    .action(async () => {
      const e = env();
      const caps = (e.deploy as Deploy).upgradeCapIds ?? [];
      if (!caps.length) throw new Error('No UpgradeCap recorded. Run admin record first.');
      const digests: string[] = [];
      for (const cap of caps) {
        const t = new Transaction();
        t.moveCall({ target: '0x2::package::make_immutable', arguments: [t.object(cap)] });
        digests.push((await exec(e, t)).digest);
      }
      update(e.deployPath, { upgradeCapDestroyDigests: digests });
      console.log(`Immutable. Destroy digests: ${digests.join(', ')}`);
    });
}

/** Reads PCR0-2 from eif_build's nitro.pcrs output ("<hex> PCR0" lines, or JSON). */
export function parsePcrs(text: string): string[] {
  try {
    const j = JSON.parse(text) as Record<string, string>;
    return [j.PCR0!, j.PCR1!, j.PCR2!];
  } catch {
    const out: string[] = [];
    for (const line of text.split('\n')) {
      const m = line.match(/([0-9a-f]{96})\s+PCR(\d)/i) ?? line.match(/PCR(\d)\s*[:=]?\s*([0-9a-f]{96})/i);
      if (!m) continue;
      const [hex, n] = m[1]!.length === 96 ? [m[1]!, m[2]!] : [m[2]!, m[1]!];
      out[Number(n)] = hex.toLowerCase();
    }
    if (out.length < 3 || !out[0] || !out[1] || !out[2]) throw new Error('could not read PCR0-PCR2');
    return out.slice(0, 3);
  }
}
