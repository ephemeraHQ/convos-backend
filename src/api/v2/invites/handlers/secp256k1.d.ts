declare module "secp256k1" {
  export function ecdsaRecover(
    signature: Uint8Array,
    recoveryId: number,
    messageHash: Uint8Array,
    compressed: boolean,
  ): Uint8Array;
}
