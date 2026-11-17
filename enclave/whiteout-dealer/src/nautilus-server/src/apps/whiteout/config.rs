//! Configuration compiled into the binary and therefore covered by the PCRs (MD16):
//! network, Whiteout package ID, Seal key-server object IDs, their public keys and
//! weights, and the threshold. Nothing here can be changed by a request.

use anyhow::{anyhow, bail, Context, Result};
use fastcrypto::groups::bls12381::G2Element;
use fastcrypto::serde_helpers::ToFromByteArray;
use serde::Deserialize;
use sui_sdk_types::Address;

#[cfg(all(feature = "testnet", not(feature = "mainnet")))]
const RAW: &str = include_str!("../../../config/testnet.json");
#[cfg(feature = "mainnet")]
const RAW: &str = include_str!("../../../config/mainnet.json");
#[cfg(not(any(feature = "testnet", feature = "mainnet")))]
compile_error!("enable exactly one of the `testnet` or `mainnet` features");

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RawConfig {
    pub network: String,
    pub package_id: String,
    pub threshold: u8,
    pub key_servers: Vec<RawKeyServer>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RawKeyServer {
    pub object_id: String,
    /// BLS12-381 G2 public key, 96 bytes hex.
    pub public_key: String,
    pub weight: u8,
}

#[derive(Clone, Debug)]
pub struct DealerConfig {
    pub network: String,
    pub package_id: Address,
    pub threshold: u8,
    /// One entry per share: a server with weight w appears w times.
    pub servers: Vec<Address>,
    pub public_keys: Vec<G2Element>,
}

impl DealerConfig {
    pub fn pinned() -> Result<Self> {
        Self::parse(RAW)
    }

    pub fn parse(raw: &str) -> Result<Self> {
        let c: RawConfig = serde_json::from_str(raw).context("dealer config")?;
        let package_id = parse_address(&c.package_id)?;
        let mut servers = vec![];
        let mut public_keys = vec![];
        for ks in &c.key_servers {
            let id = parse_address(&ks.object_id)?;
            let bytes = hex::decode(ks.public_key.trim_start_matches("0x"))?;
            let arr: [u8; 96] = bytes.try_into().map_err(|_| anyhow!("public key must be 96 bytes"))?;
            let pk = G2Element::from_byte_array(&arr).map_err(|_| anyhow!("invalid G2 public key"))?;
            for _ in 0..ks.weight {
                servers.push(id);
                public_keys.push(pk);
            }
        }
        if servers.is_empty() {
            bail!("no key servers configured");
        }
        if c.threshold == 0 || c.threshold as usize > servers.len() {
            bail!("threshold {} is out of range", c.threshold);
        }
        Ok(Self { network: c.network, package_id, threshold: c.threshold, servers, public_keys })
    }
}

pub fn parse_address(s: &str) -> Result<Address> {
    let hex = s.trim_start_matches("0x");
    let padded = format!("{hex:0>64}");
    let bytes = hex::decode(padded)?;
    let arr: [u8; 32] = bytes.try_into().map_err(|_| anyhow!("address must be 32 bytes"))?;
    Ok(Address::new(arr))
}
