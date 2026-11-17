# Deploying Whiteout

Everything below runs from the repo root. Set the host key once (a `suiprivkey…` string; on Mainnet use a hardware-backed key for publishing):

```
export WHITEOUT_HOST_KEY=suiprivkey...
alias whiteout='node packages/cli/bin/whiteout.mjs'
pnpm install
```

## 1. Publish the package

```
sui client publish move/whiteout --with-unpublished-dependencies --gas-budget 500000000
whiteout -n testnet admin record --digest <publish digest>
```

`admin record` writes the package ID, the UpgradeCap and `Cap<DEALER>` into `deploy/testnet.json`.

## 2. Build the dealer for this package

```
whiteout -n testnet pin-dealer          # writes enclave/whiteout-dealer/src/nautilus-server/config/testnet.json
cd enclave/whiteout-dealer && make NETWORK=testnet   # reproducible StageX build -> out/nitro.eif, out/nitro.pcrs
```

The config holds the package ID, the Seal key-server object IDs, their public keys and the threshold. It is compiled into the binary, so it is covered by the PCRs (MD16). Commit it and tag the release; the tag is what the Verify page links to (`dealerSourceUrl` in the deploy file).

## 3. Register the enclave

On an EC2 instance with Nitro Enclaves (the template's `configure_enclave.sh` sets one up), run the image, then:

```
whiteout -n testnet admin enclave-config --pcrs enclave/whiteout-dealer/out/nitro.pcrs
whiteout -n testnet admin register --url http://<instance>:3000
```

Debug builds have all-zero PCRs; `enclave-config` refuses them. Restrict the instance's security group to the host's IP (spec section 12).

## 4. Make the package immutable (MD6)

```
whiteout -n mainnet admin make-immutable --yes-i-understand
```

Irreversible. `whiteout create` on Mainnet refuses to run while a recorded UpgradeCap exists.

## 5. Sponsor service

Environment: `NETWORK`, `PACKAGE_ID`, `ENOKI_PRIVATE_KEY`, `REDIS_URL` + `REDIS_TOKEN` (Upstash REST), `ALLOWED_ORIGINS`.

- Vercel: deploy `packages/sponsor` (it has `api/index.ts` and `vercel.json`).
- Anywhere with Node: `pnpm --filter @whiteout/sponsor start` (port 8787).

In the Enoki portal: enable sponsorship for the network, set the gas budget cap to 0.05 SUI, add the web domain as an allowed origin, and enable Google as the zkLogin provider with the production redirect URL. Put the public API key, Google client ID and sponsor URL in `deploy/<network>.json` (`enokiPublicKey`, `googleClientId`, `sponsorUrl`).

## 6. Web client

```
pnpm --filter @whiteout/web build        # VITE_NETWORK=mainnet for Mainnet
```

Serve `packages/web/dist` from any static host (Vercel, Netlify).

## Running a hunt

```
whiteout create --well <well-fund address> --stake 0 --players 64 --duration 2h --window 300s
whiteout deposit-prize --game <game> --prize <object id>
whiteout deal --game <game> --enclave-url http://<instance>:3000      # or --ceremony for a zero-stake, host-dealt hunt
# T-0:
whiteout open --game <game>
whiteout status --game <game> --watch --auto-freeze
# after the end:
whiteout finalize --game <game>        # only if nobody found the relic
whiteout reclaim --game <game>         # likewise
whiteout thaw --game <game>
```

`deal` saves the checked deal to `.whiteout/<game>/deal.json` (ciphertext only, safe to keep) and uploads the Quilt; the hunt stays in LOBBY until `open`. Mainnet has no public Walrus publisher: pass `--publisher` pointing at your own publisher or an upload relay.

### Live-hunt checklist (spec section 21)

- T−72 h: load test passed; Seal tier confirmed; well-fund address confirmed in writing (Q1).
- T−24 h: `create`, `deposit-prize`, start the enclave, `deal`, stop the enclave. Post the lobby link.
- T−0: `open`; post the Verify link; `status --watch --auto-freeze` running.
- End: `finalize` if needed, `thaw`, post the thaw file and the payout transaction.
