//! Dealer tests (spec section 19, "Enclave" and "Signature" rows).

use fastcrypto::ed25519::{Ed25519KeyPair, Ed25519PrivateKey, Ed25519PublicKey, Ed25519Signature};
use fastcrypto::traits::{KeyPair, ToFromBytes, VerifyingKey};
use nautilus_server::app::config::{parse_address, DealerConfig};
use nautilus_server::app::deal::*;
use nautilus_server::app::map::*;
use nautilus_server::app::{parse_game_id, DealRequest};
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

#[test]
fn maps_are_valid_and_solvable() {
    for seed in 0..300u64 {
        let map = generate(&mut StdRng::seed_from_u64(seed)).expect("solvable");
        assert!(validate(&map).is_empty(), "seed {seed}: {:?}", validate(&map));
    }
}

#[test]
fn clues_follow_the_spec() {
    assert_eq!(warmth(0, 0, (0, 2)), 5);
    assert_eq!(warmth(0, 0, (0, 4)), 4);
    assert_eq!(warmth(0, 0, (0, 7)), 3);
    assert_eq!(warmth(0, 0, (0, 11)), 2);
    assert_eq!(warmth(0, 0, (0, 16)), 1);
    assert_eq!(warmth(0, 0, (0, 17)), 0);
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
    assert_eq!(sign(&kp, &deal_message(game, deal_ts, &ct_hash)), hex_const(&src, "DEAL_SIG"));
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
    let map = generate(&mut StdRng::seed_from_u64(1)).unwrap();
    let d = deal(&cfg, &map, game, 42, &kp).unwrap();
    assert_eq!(d.tiles.len(), TILES);

    let cts: Vec<Vec<u8>> = d.tiles.iter().map(|t| t.2.clone()).collect();
    assert_eq!(ct_hash(&cts), d.ct_hash);
    let pk = Ed25519PublicKey::from_bytes(&d.dealer_pk).unwrap();
    pk.verify(&deal_message(game, 42, &d.ct_hash), &Ed25519Signature::from_bytes(&d.deal_sig).unwrap()).unwrap();

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
    let d = deal(&cfg, &generate(&mut StdRng::seed_from_u64(2)).unwrap(), [1; 32], 1, &fixture_key()).unwrap();
    let obj: EncryptedObject = bcs::from_bytes(&d.tiles[0].2).unwrap();
    let full_id = create_full_id(&cfg.package_id.into_inner(), &obj.id);
    let usks: HashMap<_, _> = keys.iter().take(1).map(|(id, sk)| (*id, ibe::extract(sk, &full_id))).collect();
    assert!(seal_decrypt(&obj, &IBEUserSecretKeys::BonehFranklinBLS12381(usks), None).is_err());
}

#[test]
fn every_plaintext_is_exactly_160_bytes() {
    let kp = fixture_key();
    for seed in 0..20 {
        let map = generate(&mut StdRng::seed_from_u64(seed)).unwrap();
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
}

#[test]
fn the_pinned_config_parses() {
    let cfg = DealerConfig::pinned().unwrap();
    assert!(!cfg.servers.is_empty());
    assert!(cfg.threshold as usize <= cfg.servers.len());
}
