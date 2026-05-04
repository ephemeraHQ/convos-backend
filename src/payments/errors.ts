export class GrantKindNotFoundError extends Error {
  constructor(kind: string) {
    super(`Grant kind "${kind}" not found or inactive`);
    this.name = "GrantKindNotFoundError";
    Object.setPrototypeOf(this, GrantKindNotFoundError.prototype);
  }
}

export class InsufficientBalanceError extends Error {
  constructor(
    public readonly inboxId: string,
    public readonly currentBalance: bigint,
    public readonly attemptedDelta: number,
    public readonly minBalance: bigint,
  ) {
    super(
      `Insufficient balance for inbox ${inboxId}: current=${currentBalance}, delta=${attemptedDelta}, floor=${minBalance}`,
    );
    this.name = "InsufficientBalanceError";
    Object.setPrototypeOf(this, InsufficientBalanceError.prototype);
  }
}
