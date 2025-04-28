// Default path for the first Ethereum address in a new HD wallet.
// See https://github.com/bitcoin/bips/blob/master/bip-0044.mediawiki, paths are in the form:
//     m / purpose' / coin_type' / account' / change / address_index
// - Purpose is a constant set to 44' following the BIP43 recommendation.
// - Coin type is set to 60 (ETH) -- see https://github.com/satoshilabs/slips/blob/master/slip-0044.md
// - Account, Change, and Address Index are set to 0
export const ETHEREUM_WALLET_DEFAULT_PATH = "m/44'/60'/0'/0/0";
export const DEFAULT_SUB_ORG_NAME = "Default SubOrg";
export const DEFAULT_USER_NAME = "Default User";
