//! Dealer tests (spec section 19, "Enclave" and "Signature" rows).

use fastcrypto::ed25519::{Ed25519KeyPair, Ed25519PrivateKey, Ed25519PublicKey, Ed25519Signature};
use fastcrypto::traits::{KeyPair, ToFromBytes, VerifyingKey};
use nautilus_server::app::config::{parse_address, DealerConfig};
use nautilus_server::app::deal::*;
use nautilus_server::app::map::*;
use nautilus_server::app::{parse_game_id, parse_relics, DealRequest};
use rand::rngs::StdRng;
use rand::SeedableRng;
use seal_crypto::ibe;
use seal_crypto::{create_full_id, seal_decrypt, EncryptedObject, IBEPublicKeys, IBEUserSecretKeys};
use std::collections::HashMap;

fn fixtures() -> String {
    let p = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../move/whiteout/tests/fixtures.move");
    std::fs::read_to_string(p).expect("move fixtures")
}

fn hex_const(src: &str, name: &str) -> Vec<u8> {
    let tag = format!("const {name}: vector<u8> = x\"");
    let start = src.find(&tag).unwrap() + tag.len();
    let end = start + src[start..].find('"').unwrap();
    hex::decode(&src[start..end]).unwrap()
}

fn addr_const(src: &str, name: &str) -> [u8; 32] {
    let tag = format!("const {name}: address = @0x");
    let start = src.find(&tag).unwrap() + tag.len();
    let end = start + src[start..].find(';').unwrap();
    hex::decode(&src[start..end]).unwrap().try_into().unwrap()
}

fn fixture_key() -> Ed25519KeyPair {
    Ed25519KeyPair::from(Ed25519PrivateKey::from_bytes(&[0x2a; 32]).unwrap())
}

/// Spec section 19: 10,000 generated maps all satisfy the map rules.
#[test]
fn maps_are_valid_and_solvable() {
    for seed in 0..10_000u64 {
        let map = generate(&mut StdRng::seed_from_u64(seed), 1).expect("solvable");
        assert!(validate(&map, 1).is_empty(), "seed {seed}: {:?}", validate(&map, 1));
    }
}

#[test]
fn clues_follow_the_spec() {
    assert_eq!(warmth(0, 0, &[(0, 2)]), 5);
    assert_eq!(warmth(0, 0, &[(0, 4)]), 4);
    assert_eq!(warmth(0, 0, &[(0, 7)]), 3);
    assert_eq!(warmth(0, 0, &[(0, 11)]), 2);
    assert_eq!(warmth(0, 0, &[(0, 16)]), 1);
    assert_eq!(warmth(0, 0, &[(0, 17)]), 0);
    // Phase 2: the nearest relic sets the warmth.
    assert_eq!(warmth(0, 0, &[(0, 20), (1, 2)]), 5);
    let mut map = [SNOW; TILES];
    map[idx(1, 1)] = CREVASSE;
    map[idx(2, 2)] = CREVASSE;
    assert_eq!(hazards(&map, 1, 2), 2);
    assert_eq!(hazards(&map, 1, 1), 1);
}

/// Ed25519 is deterministic: identical signatures prove byte-identical messages
/// across Rust, TypeScript, Python and Move.
#[test]
fn kind_messages_match_the_move_fixtures() {
    let src = fixtures();
    let game = addr_const(&src, "GAME_ID");
    let deal_ts: u64 = src.split("const DEAL_TS: u64 = ").nth(1).unwrap().split(';').next().unwrap().parse().unwrap();
    let kinds = hex_const(&src, "KINDS");
    let sigs = hex_const(&src, "SIGS");
    let kp = fixture_key();
    assert_eq!(kp.public().as_bytes(), hex_const(&src, "DEALER_PK").as_slice());
    for i in 0..TILES {
        let (x, y) = ((i % GRID) as u8, (i / GRID) as u8);
        let sig = sign(&kp, &kind_message(game, deal_ts, x, y, kinds[i]));
        assert_eq!(sig, sigs[i * 64..i * 64 + 64], "tile ({x}, {y})");
    }
    let ct_hash = hex_const(&src, "CT_HASH");
    assert_eq!(sign(&kp, &deal_message(game, deal_ts, &ct_hash, 1)), hex_const(&src, "DEAL_SIG"));
    // Phase 2: the deal signature commits to the relic count.
    assert_eq!(sign(&kp, &deal_message(game, deal_ts, &ct_hash, 2)), hex_const(&src, "DEAL_SIG_2_RELICS"));
    assert_eq!(sign(&kp, &deal_message(game, deal_ts, &ct_hash, 3)), hex_const(&src, "DEAL_SIG_3_RELICS"));
}

/// Clue signatures are verified by clients, not Move, so the Move fixtures do not
/// cover them. These bytes and this signature were produced independently by
/// packages/core (`clueMessage`, @mysten/sui BCS + @noble/curves ed25519) for the
/// same inputs; Ed25519 is deterministic, so any layout drift breaks this test.
#[test]
fn clue_messages_match_fixed_bytes() {
    let game: [u8; 32] = hex::decode("f57edaced7d8e5adc8d6479322b6aa55d8d3aa3dece552c7a2def6ee30c94e32").unwrap().try_into().unwrap();
    let msg = clue_message(game, 1_765_000_000_000, 5, 17, RELIC, 5, 2);
    let expected = hex::decode(concat!(
        "03",                                                               // intent TILE_CLUE
        "00b232f29a010000",                                                 // deal_ts u64 LE
        "f57edaced7d8e5adc8d6479322b6aa55d8d3aa3dece552c7a2def6ee30c94e32", // game_id
        "05", "11", "04", "05", "02",                                       // x, y, kind, warmth, hazards
    ))
    .unwrap();
    assert_eq!(msg, expected);
    assert_eq!(
        hex::encode(sign(&fixture_key(), &msg)),
        "b838780825e12beb913639ba1f8214de141c9d33c4fa6b04af5884ee2504c0352f41e3a85b87f1cbd38960ef996c56fc147539f660eb490048246dc9c455ce0f"
    );
    // The kind message is the same prefix with intent 2 and no warmth or hazards.
    let mut kind = expected[..expected.len() - 2].to_vec();
    kind[0] = INTENT_TILE_KIND;
    assert_eq!(kind_message(game, 1_765_000_000_000, 5, 17, RELIC), kind);
}

fn test_servers(n: usize) -> (DealerConfig, Vec<(sui_sdk_types::Address, ibe::MasterKey)>) {
    let mut rng = StdRng::seed_from_u64(9);
    let mut servers = vec![];
    let mut pks = vec![];
    let mut keys = vec![];
    for i in 0..n {
        let (sk, pk) = ibe::generate_key_pair(&mut rng);
        let id = parse_address(&format!("0x{:064x}", i + 1)).unwrap();
        servers.push(id);
        pks.push(pk);
        keys.push((id, sk));
    }
    let cfg = DealerConfig {
        network: "test".into(),
        package_id: parse_address("0x77").unwrap(),
        threshold: 2,
        servers,
        public_keys: pks,
    };
    (cfg, keys)
}

#[test]
fn a_deal_encrypts_every_tile_to_the_pinned_servers_and_decrypts() {
    let (cfg, keys) = test_servers(3);
    let kp = fixture_key();
    let game = [0xab; 32];
    let map = generate(&mut StdRng::seed_from_u64(1), 1).unwrap();
    let d = deal(&cfg, &map, game, 42, &kp).unwrap();
    assert_eq!(d.tiles.len(), TILES);

    let cts: Vec<Vec<u8>> = d.tiles.iter().map(|t| t.2.clone()).collect();
    assert_eq!(ct_hash(&cts), d.ct_hash);
    let pk = Ed25519PublicKey::from_bytes(&d.dealer_pk).unwrap();
    pk.verify(&deal_message(game, 42, &d.ct_hash, d.relics), &Ed25519Signature::from_bytes(&d.deal_sig).unwrap()).unwrap();

    // Every ciphertext has the same size (R8) and names exactly the pinned servers.
    let sizes: std::collections::HashSet<usize> = cts.iter().map(|c| c.len()).collect();
    assert_eq!(sizes.len(), 1, "ciphertext sizes leak tile kinds");

    for &(x, y, ref ct) in d.tiles.iter().step_by(37) {
        let obj: EncryptedObject = bcs::from_bytes(ct).unwrap();
        assert_eq!(obj.package_id, cfg.package_id);
        assert_eq!(obj.id, identity(game, x, y));
        assert_eq!(obj.threshold, 2);
        assert_eq!(obj.services.iter().map(|s| s.0).collect::<Vec<_>>(), cfg.servers);

        // Two of three key servers release their keys: the tile decrypts.
        let full_id = create_full_id(&cfg.package_id.into_inner(), &obj.id);
        let usks: HashMap<_, _> = keys.iter().take(2).map(|(id, sk)| (*id, ibe::extract(sk, &full_id))).collect();
        let plain = seal_decrypt(
            &obj,
            &IBEUserSecretKeys::BonehFranklinBLS12381(usks),
            Some(&IBEPublicKeys::BonehFranklinBLS12381(cfg.public_keys.clone())),
        )
        .unwrap();
        assert_eq!(plain.len(), TILE_PLAINTEXT_LEN);
        let kind = map[idx(x as usize, y as usize)];
        assert_eq!(&plain[..2], &[1, kind]);
        // kind_sig sits after version, kind, warmth, hazards and the ULEB length 64.
        assert_eq!(plain[4], 64);
        let sig = Ed25519Signature::from_bytes(&plain[5..69]).unwrap();
        pk.verify(&kind_message(game, 42, x, y, kind), &sig).unwrap();
    }
}

#[test]
fn one_key_server_alone_cannot_decrypt() {
    let (cfg, keys) = test_servers(3);
    let d = deal(&cfg, &generate(&mut StdRng::seed_from_u64(2), 1).unwrap(), [1; 32], 1, &fixture_key()).unwrap();
    let obj: EncryptedObject = bcs::from_bytes(&d.tiles[0].2).unwrap();
    let full_id = create_full_id(&cfg.package_id.into_inner(), &obj.id);
    let usks: HashMap<_, _> = keys.iter().take(1).map(|(id, sk)| (*id, ibe::extract(sk, &full_id))).collect();
    assert!(seal_decrypt(&obj, &IBEUserSecretKeys::BonehFranklinBLS12381(usks), None).is_err());
}

#[test]
fn every_plaintext_is_exactly_160_bytes() {
    let kp = fixture_key();
    for seed in 0..20 {
        let map = generate(&mut StdRng::seed_from_u64(seed), 1).unwrap();
        for t in sign_tiles(&map, [seed as u8; 32], seed, &kp) {
            assert_eq!(t.plaintext.len(), TILE_PLAINTEXT_LEN);
        }
    }
}

#[test]
fn requests_cannot_change_the_pinned_config() {
    // AC25: any field other than game_id is rejected.
    let extra = r#"{"game_id":"0x0101010101010101010101010101010101010101010101010101010101010101","key_servers":[]}"#;
    assert!(serde_json::from_str::<DealRequest>(extra).is_err());
    let ok = r#"{"game_id":"0x0101010101010101010101010101010101010101010101010101010101010101"}"#;
    assert!(serde_json::from_str::<DealRequest>(ok).is_ok());
    assert!(parse_game_id("0x1234").is_err());
    assert!(parse_game_id(&"zz".repeat(32)).is_err());
    assert_eq!(parse_game_id(&"01".repeat(32)).unwrap(), [1; 32]);
    assert!(parse_game_id(&"00".repeat(32)).is_err());
    assert!(parse_game_id(&format!(" {}", "01".repeat(32))).is_err());
    assert!(parse_relics(0).is_err() && parse_relics(4).is_err());
    assert_eq!(parse_relics(3).unwrap(), 3);
}

#[test]
fn the_pinned_config_parses() {
    let cfg = DealerConfig::pinned().unwrap();
    assert!(!cfg.servers.is_empty());
    assert!(cfg.threshold as usize <= cfg.servers.len());
    assert_eq!(cfg.network, nautilus_server::app::config::NETWORK);
}

const PK: &str = "a040b5548bb0428fba159895c07080cbfdc76ef01bb88ca2ced5c85b07782e09970a1f5684e2a0dd3d3e31beb6cbd7ea02c49a3794b26c6d3d9ffdc99e4984cc981d0d72e933c2af3309216bf7011e9e82c7b68276882f18ba0ea7f45a7721db";

fn cfg_json(package: &str, threshold: u8, servers: &[(&str, u8)]) -> String {
    let ks: Vec<String> =
        servers.iter().map(|(id, w)| format!(r#"{{"object_id":"{id}","public_key":"{PK}","weight":{w}}}"#)).collect();
    format!(r#"{{"network":"mainnet","package_id":"{package}","threshold":{threshold},"key_servers":[{}]}}"#, ks.join(","))
}

/// Item MD16: an unpinned (mainnet) config must stop the dealer from starting.
#[test]
fn incomplete_configs_are_refused() {
    let mainnet = include_str!("../config/mainnet.json");
    assert!(DealerConfig::parse(mainnet).is_err(), "the unpinned mainnet config must not parse");
    let ok = cfg_json("0x77", 2, &[("0x1", 1), ("0x2", 1)]);
    assert!(DealerConfig::parse(&ok).is_ok());
    for (why, bad) in [
        ("package 0x0", cfg_json("0x0", 1, &[("0x1", 1)])),
        ("package all zeros", cfg_json(&format!("0x{}", "0".repeat(64)), 1, &[("0x1", 1)])),
        ("no key servers", cfg_json("0x77", 1, &[])),
        ("threshold 0", cfg_json("0x77", 0, &[("0x1", 1)])),
        ("threshold above shares", cfg_json("0x77", 3, &[("0x1", 1), ("0x2", 1)])),
        ("duplicate server", cfg_json("0x77", 2, &[("0x1", 1), ("0x1", 1)])),
        ("weight 0", cfg_json("0x77", 1, &[("0x1", 1), ("0x2", 0)])),
        ("over 255 shares", cfg_json("0x77", 1, &[("0x1", 200), ("0x2", 100)])),
        ("address too long", cfg_json(&format!("0x1{}", "0".repeat(64)), 1, &[("0x1", 1)])),
        ("empty address", cfg_json("0x", 1, &[("0x1", 1)])),
    ] {
        assert!(DealerConfig::parse(&bad).is_err(), "{why} was accepted");
    }
}

#[test]
fn ranked_maps_place_relics_apart_and_reachable() {
    for relics in [2usize, 3] {
        for seed in 0..60u64 {
            let map = generate(&mut StdRng::seed_from_u64(seed), relics).expect("solvable");
            assert!(validate(&map, relics).is_empty(), "relics {relics} seed {seed}: {:?}", validate(&map, relics));
        }
    }
    assert!(generate(&mut StdRng::seed_from_u64(1), 4).is_none());
}
