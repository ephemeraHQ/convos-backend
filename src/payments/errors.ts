import { AppError } from "@/utils/errors";

export class GrantKindNotFoundError extends AppError {
  constructor(kind: string) {
    super(404, `Grant kind "${kind}" not found or inactive`, { kind });
    this.name = "GrantKindNotFoundError";
    Object.setPrototypeOf(this, GrantKindNotFoundError.prototype);
  }
}

export class InsufficientBalanceError extends AppError {
  constructor(
    public readonly inboxId: string,
    public readonly currentBalance: bigint,
    public readonly attemptedDelta: number,
    public readonly minBalance: bigint,
  ) {
    super(
      402,
      `Insufficient balance for inbox ${inboxId}: current=${currentBalance}, delta=${attemptedDelta}, floor=${minBalance}`,
      { inboxId, currentBalance, attemptedDelta, minBalance },
    );
    this.name = "InsufficientBalanceError";
    Object.setPrototypeOf(this, InsufficientBalanceError.prototype);
  }
}

export class IdempotencyMismatchError extends AppError {
  constructor(
    public readonly idempotencyKey: string,
    public readonly priorDelta: bigint,
    public readonly attemptedDelta: bigint,
  ) {
    super(
      409,
      `Idempotency key "${idempotencyKey}" already used with delta=${priorDelta}, cannot replay with delta=${attemptedDelta}`,
      { idempotencyKey, priorDelta, attemptedDelta },
    );
    this.name = "IdempotencyMismatchError";
    Object.setPrototypeOf(this, IdempotencyMismatchError.prototype);
  }
}
