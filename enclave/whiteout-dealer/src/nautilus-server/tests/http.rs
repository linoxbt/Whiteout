//! The /deal HTTP surface: strictly increasing deal_ts, bounded
//! concurrency and body size, strict input validation, CORS and the request id.

use std::sync::Arc;

use axum::body::{to_bytes, Body};
use axum::http::{header, Method, Request, StatusCode};
use axum::Router;
use fastcrypto::ed25519::{Ed25519KeyPair, Ed25519PublicKey, Ed25519Signature};
use fastcrypto::traits::{KeyPair, ToFromBytes, VerifyingKey};
use nautilus_server::app::config::DealerConfig;
use nautilus_server::app::deal::deal_message;
use nautilus_server::{router, AppState};
use rand::rngs::StdRng;
use rand::SeedableRng;
use serde_json::Value;
use tower::ServiceExt;

fn state(limit: usize) -> Arc<AppState> {
    let kp = Ed25519KeyPair::generate(&mut StdRng::seed_from_u64(7));
    Arc::new(AppState::with_limit(kp, DealerConfig::pinned().unwrap(), limit))
}

fn game(n: u8) -> String {
    format!("0x{}", hex::encode([n; 32]))
}

async fn call(app: &Router, req: Request<Body>) -> (StatusCode, axum::http::HeaderMap, Value) {
    let res = app.clone().oneshot(req).await.unwrap();
    let (parts, body) = res.into_parts();
    let bytes = to_bytes(body, usize::MAX).await.unwrap();
    let json = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (parts.status, parts.headers, json)
}

fn post_deal(body: impl Into<String>) -> Request<Body> {
    Request::post("/deal")
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ORIGIN, "https://console.example")
        .body(Body::from(body.into()))
        .unwrap()
}

async fn deal(app: &Router, game_id: &str) -> (StatusCode, Value) {
    let (s, _, v) = call(app, post_deal(format!(r#"{{"game_id":"{game_id}"}}"#))).await;
    (s, v)
}

#[tokio::test]
async fn rapid_deals_never_share_a_deal_ts() {
    let app = router(state(4));
    let mut last = 0u64;
    for n in 1..=3u8 {
        let (s, v) = deal(&app, &game(n)).await;
        assert_eq!(s, StatusCode::OK, "{v}");
        let ts = v["deal_ts"].as_u64().unwrap();
        assert!(ts > last, "deal_ts {ts} does not follow {last}");
        last = ts;
        // The deal signature binds the deal_ts that was returned.
        let pk = Ed25519PublicKey::from_bytes(&hex::decode(v["dealer_pk"].as_str().unwrap()).unwrap()).unwrap();
        let ct_hash = hex::decode(v["ct_hash"].as_str().unwrap()).unwrap();
        let sig = Ed25519Signature::from_bytes(&hex::decode(v["deal_sig"].as_str().unwrap()).unwrap()).unwrap();
        pk.verify(&deal_message([n; 32], ts, &ct_hash, 1), &sig).unwrap();
    }
}

#[tokio::test]
async fn concurrent_deals_get_distinct_deal_ts() {
    let app = router(state(4));
    let calls = (10..14u8).map(|n| {
        let app = app.clone();
        tokio::spawn(async move { deal(&app, &game(n)).await })
    });
    let mut ts = vec![];
    for c in calls {
        let (s, v) = c.await.unwrap();
        assert_eq!(s, StatusCode::OK, "{v}");
        ts.push(v["deal_ts"].as_u64().unwrap());
    }
    ts.sort_unstable();
    ts.dedup();
    assert_eq!(ts.len(), 4, "two deals shared a deal_ts");
}

/// No per-game refusal (it would let anyone grief a public LOBBY game): a second
/// deal for the same game succeeds, but with a different deal_ts, so its kind
/// signatures cannot be mixed with the first deal's.
#[tokio::test]
async fn two_deals_for_one_game_both_succeed_with_different_deal_ts() {
    let app = router(state(4));
    let (s1, v1) = deal(&app, &game(0x21)).await;
    let (s2, v2) = deal(&app, &game(0x21)).await;
    assert_eq!((s1, s2), (StatusCode::OK, StatusCode::OK), "{v1} {v2}");
    let (t1, t2) = (v1["deal_ts"].as_u64().unwrap(), v2["deal_ts"].as_u64().unwrap());
    assert!(t2 > t1, "deal_ts {t2} does not follow {t1}");
    // Each deal signature binds its own deal_ts.
    for v in [&v1, &v2] {
        let pk = Ed25519PublicKey::from_bytes(&hex::decode(v["dealer_pk"].as_str().unwrap()).unwrap()).unwrap();
        let ct_hash = hex::decode(v["ct_hash"].as_str().unwrap()).unwrap();
        let sig = Ed25519Signature::from_bytes(&hex::decode(v["deal_sig"].as_str().unwrap()).unwrap()).unwrap();
        pk.verify(&deal_message([0x21; 32], v["deal_ts"].as_u64().unwrap(), &ct_hash, 1), &sig).unwrap();
    }
}

#[tokio::test]
async fn a_saturated_dealer_answers_503() {
    // No free deal slot: the request is refused at once instead of queueing work.
    let app = router(state(0));
    let (s, h, v) = call(&app, post_deal(format!(r#"{{"game_id":"{}"}}"#, game(0x41)))).await;
    assert_eq!(s, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(h[header::RETRY_AFTER], "1");
    assert!(v["error"].as_str().unwrap().contains("busy"), "{v}");
    assert_eq!(h[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
}

#[tokio::test]
async fn bodies_are_size_limited_and_strictly_validated() {
    let app = router(state(4));
    let big = format!(r#"{{"game_id":"{}","pad":"{}"}}"#, game(1), "x".repeat(4096));
    let (s, _, v) = call(&app, post_deal(big)).await;
    assert_eq!(s, StatusCode::PAYLOAD_TOO_LARGE, "{v}");
    assert!(v["error"].is_string());

    for relics in [0, 4] {
        let (s, _, v) = call(&app, post_deal(format!(r#"{{"game_id":"{}","relics":{relics}}}"#, game(2)))).await;
        assert_eq!(s, StatusCode::BAD_REQUEST, "relics {relics}: {v}");
    }
    for bad in [
        r#"{"game_id":"0x1234"}"#.to_string(),
        format!(r#"{{"game_id":" {}"}}"#, game(2)),
        format!(r#"{{"game_id":"0X{}"}}"#, hex::encode([2u8; 32])),
        format!(r#"{{"game_id":"+{}"}}"#, &hex::encode([2u8; 32])[1..]),
        format!(r#"{{"game_id":"0x{}"}}"#, "00".repeat(32)),
    ] {
        let (s, _, v) = call(&app, post_deal(bad.clone())).await;
        assert_eq!(s, StatusCode::BAD_REQUEST, "{bad}: {v}");
    }
    for bad in [
        format!(r#"{{"game_id":"{}","relics":300}}"#, game(2)),
        format!(r#"{{"game_id":"{}","relics":-1}}"#, game(2)),
        format!(r#"{{"game_id":"{}","package_id":"0x1"}}"#, game(2)),
        r#"{}"#.to_string(),
    ] {
        let (s, _, v) = call(&app, post_deal(bad.clone())).await;
        assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY, "{bad}: {v}");
        assert!(v["error"].is_string(), "errors are JSON");
    }
    let no_type = Request::post("/deal").body(Body::from(format!(r#"{{"game_id":"{}"}}"#, game(2)))).unwrap();
    assert_eq!(call(&app, no_type).await.0, StatusCode::UNSUPPORTED_MEDIA_TYPE);
}

#[tokio::test]
async fn browsers_can_call_deal_cross_origin() {
    let app = router(state(4));
    let preflight = Request::builder()
        .method(Method::OPTIONS)
        .uri("/deal")
        .header(header::ORIGIN, "https://console.example")
        .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
        .header(header::ACCESS_CONTROL_REQUEST_HEADERS, "content-type")
        .body(Body::empty())
        .unwrap();
    let (s, h, _) = call(&app, preflight).await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    assert_eq!(h[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
    assert!(h[header::ACCESS_CONTROL_ALLOW_METHODS].to_str().unwrap().contains("POST"));
    assert!(h[header::ACCESS_CONTROL_ALLOW_HEADERS].to_str().unwrap().contains("content-type"));
    assert!(h.get(header::ACCESS_CONTROL_ALLOW_CREDENTIALS).is_none());

    // The actual POST (and its errors) can be read by the page too.
    let (s, h, _) = call(&app, post_deal(format!(r#"{{"game_id":"{}"}}"#, game(0x51)))).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(h[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
    let (s, h, _) = call(&app, post_deal(r#"{"game_id":"0x12"}"#)).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert_eq!(h[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
}

#[tokio::test]
async fn every_response_carries_a_request_id() {
    let app = router(state(4));
    let (_, a, _) = call(&app, Request::get("/health_check").body(Body::empty()).unwrap()).await;
    let (_, b, _) = call(&app, Request::get("/health_check").body(Body::empty()).unwrap()).await;
    let (ida, idb) = (a["x-request-id"].to_str().unwrap(), b["x-request-id"].to_str().unwrap());
    assert_eq!(ida.len(), 16);
    assert_ne!(ida, idb);
    let (_, c, _) = call(&app, Request::get("/nope").body(Body::empty()).unwrap()).await;
    assert!(c.contains_key("x-request-id"));
}
