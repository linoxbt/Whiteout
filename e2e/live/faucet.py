#!/usr/bin/env python3
"""Requests test SUI from the Sui faucet (proof-of-work protocol v1).

  pip install argon2-cffi
  python3 e2e/live/faucet.py <recipient> [--network testnet|devnet] [--out proof.json]

Spec: https://faucet.sui.io/pow-spec/pow-spec.md. Fetches a challenge, grinds
Argon2d nonces on every CPU until the first 8 output bytes (big-endian) fall below
the threshold, then submits. Funds arrive in the recipient's address balance.
The proof and response are saved so an uncertain outcome can be checked without
requesting again (the spec asks clients not to re-grind after a lost response).
"""
import argparse
import json
import multiprocessing as mp
import sys
import time
import urllib.parse
import urllib.request

from argon2.low_level import Type, hash_secret_raw

SALT = b"sui-faucet-pow-1"
FAUCETS = {"testnet": "https://faucet.testnet.sui.io", "devnet": "https://faucet.devnet.sui.io"}

# Conformance vector (pow-vectors.json, case "randomness present").
VECTOR = (
    "sui-faucet-pow/1\n8wWZfv1HjQxjB5ncmC9CQqqRqUMBiEZXnc5FhS9zRe1v\n1713342\n"
    "GzBdc9tbUe3s2PK1iVJcyQBj5TvdX7bJiAHWbhBDYiYb\n"
    "mJ4ZqDXQasy17GTiGfp0/OYAGCR+7reLM5+Gb39YtoAIaPuh1wj+z5J7po+eSze3\n"
    "0x949cd75a2485cc18b8258634ffd9b849a687e2e2a0b4c2444a21f007fc79adc4\n"
    "0x1111111111111111111111111111111111111111111111111111111111111111\n0"
)
VECTOR_HASH = "31f6ec0e9169705f6105219eebbbc77420f1d9273d407db5df17b4d090afb92d"


def argon(preimage: str) -> bytes:
    return hash_secret_raw(preimage.encode(), SALT, time_cost=1, memory_cost=8192, parallelism=1, hash_len=32, type=Type.D)


def norm(addr: str) -> str:
    h = addr.lower().removeprefix("0x")
    if not h or len(h) > 64 or any(c not in "0123456789abcdef" for c in h):
        raise SystemExit(f"not a Sui address: {addr}")
    return "0x" + h.rjust(64, "0")


def grind(args):
    prefix, threshold, start, step, stop = args
    n = start
    while not stop.is_set():
        out = argon(prefix + str(n))
        if int.from_bytes(out[:8], "big") < threshold:
            stop.set()
            return n, out.hex()
        n += step
    return None


def http(url: str, body: dict | None = None) -> dict:
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body else None, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return {"httpStatus": e.code, **json.loads(e.read() or b"{}")}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("recipient")
    p.add_argument("--network", default="testnet", choices=FAUCETS)
    p.add_argument("--out", default="faucet-proof.json")
    a = p.parse_args()
    if argon(VECTOR).hex() != VECTOR_HASH:
        raise SystemExit("Argon2d does not match the spec's test vector; refusing to submit.")
    base = FAUCETS[a.network]
    recipient = norm(a.recipient)
    ch = http(f"{base}/v3/challenge?" + urllib.parse.urlencode({"recipient": recipient}))
    if ch.get("version") != 1 or ch.get("algorithm") != "argon2d" or ch.get("memorySize") != 8192 or ch.get("salt") != SALT.decode():
        raise SystemExit(f"unexpected challenge: {json.dumps(ch)[:300]}")
    if ch.get("network") != a.network or ch.get("recipient") != recipient:
        raise SystemExit("challenge is for another network or recipient")
    prefix = "\n".join([ch["domain"], ch["chainId"], ch["checkpointSeq"], ch["checkpointDigest"], ch["randomBytes"], norm(ch["faucetAddress"]), recipient, ""])
    threshold = int(ch["threshold"])
    workers = mp.cpu_count()
    print(f"challenge: difficulty {ch['difficulty']}, window {ch['windowSeconds']} s, {int(ch['amountMist']) / 1e9} SUI; grinding on {workers} cores")
    t0 = time.time()
    with mp.Manager() as m:
        stop = m.Event()
        with mp.Pool(workers) as pool:
            found = next(r for r in pool.imap_unordered(grind, [(prefix, threshold, i, workers, stop) for i in range(workers)]) if r)
    nonce, hash_hex = found
    proof = {"recipient": recipient, "checkpointSeq": ch["checkpointSeq"], "nonce": str(nonce), "hashHex": hash_hex}
    print(f"solved in {time.time() - t0:.1f} s (nonce {nonce})")
    res = http(f"{base}/v3/gas", proof)
    with open(a.out, "w") as f:
        json.dump({"challenge": ch, "proof": proof, "response": res}, f, indent=2)
    print(json.dumps(res))
    sys.exit(0 if res.get("status") == "success" else 1)


if __name__ == "__main__":
    main()
