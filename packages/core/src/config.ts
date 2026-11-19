/** Per-network configuration (spec section 17). Deployment IDs live in deploy/<network>.json. */

export interface SealServer {
  objectId: string;
  weight: number;
  /** Required for committee-mode servers, whose requests go through an aggregator. */
  aggregatorUrl?: string;
  apiKeyName?: string;
  apiKey?: string;
}

export interface NetworkConfig {
  network: 'testnet' | 'mainnet' | 'devnet' | 'localnet';
  /** gRPC full node URL. */
  rpcUrl: string;
  packageId: string;
  enclavePackageId: string;
  /** EnclaveConfig<DEALER> object ID; used by the Verify page to show the expected PCRs. */
  enclaveConfigId: string;
  /** Shared DealerRegistry: holds Cap<DEALER> and pins the one dealer config. */
  dealerRegistryId?: string;
  sealServers: SealServer[];
  sealThreshold: number;
  walrusAggregators: string[];
  /** Testnet only: Mainnet has no public publisher (uploads go through the SDK or relay). */
  walrusPublisher?: string;
  walrusUploadRelay?: string;
  sponsorUrl?: string;
  enokiPublicKey?: string;
  googleClientId?: string;
  /** Source tag of the dealer build whose PCRs are registered. */
  dealerSourceUrl?: string;
}

export const DEFAULTS: Record<'testnet' | 'mainnet', Omit<NetworkConfig, 'packageId' | 'enclavePackageId' | 'enclaveConfigId'>> = {
  testnet: {
    network: 'testnet',
    rpcUrl: 'https://fullnode.testnet.sui.io:443',
    // Mysten's open-mode testnet key servers. Replace with the servers chosen for the
    // hunt; the dealer build pins the same list (MD16).
    sealServers: [
      { objectId: '0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75', weight: 1 },
      { objectId: '0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8', weight: 1 },
    ],
    sealThreshold: 1,
    walrusAggregators: [
      'https://aggregator.walrus-testnet.walrus.space',
      'https://wal-aggregator-testnet.staketab.org',
      'https://walrus-testnet-aggregator.nodes.guru',
    ],
    walrusPublisher: 'https://publisher.walrus-testnet.walrus.space',
  },
  mainnet: {
    network: 'mainnet',
    rpcUrl: 'https://fullnode.mainnet.sui.io:443',
    sealServers: [], // Q2: providers, threshold and tier are chosen before Mainnet.
    sealThreshold: 2,
    walrusAggregators: ['https://aggregator.walrus-mainnet.walrus.space'],
    walrusUploadRelay: 'https://upload-relay.mainnet.walrus.space',
  },
};

/** Merges a deploy/<network>.json file over the defaults. */
export function loadConfig(network: 'testnet' | 'mainnet', deploy: Partial<NetworkConfig>): NetworkConfig {
  const cfg = { ...DEFAULTS[network], packageId: '', enclavePackageId: '', enclaveConfigId: '', ...deploy };
  return cfg as NetworkConfig;
}
