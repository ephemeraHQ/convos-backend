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
    public readonly accountId: string,
    public readonly currentBalance: bigint,
    public readonly attemptedDelta: bigint,
    public readonly minBalance: bigint,
  ) {
    super(
      402,
      `Insufficient balance for account ${accountId}: current=${currentBalance}, delta=${attemptedDelta}, floor=${minBalance}`,
      {
        accountId,
        currentBalance: currentBalance.toString(),
        attemptedDelta: attemptedDelta.toString(),
        minBalance: minBalance.toString(),
      },
    );
    this.name = "InsufficientBalanceError";
    Object.setPrototypeOf(this, InsufficientBalanceError.prototype);
  }
}

export class IdempotencyMismatchError extends AppError {
  constructor(
    public readonly idempotencyKey: string,
    public readonly field: string,
    public readonly priorValue: unknown,
    public readonly attemptedValue: unknown,
  ) {
    super(
      409,
      `Idempotency key "${idempotencyKey}" already used; field "${field}" differs (prior=${String(priorValue)}, attempted=${String(attemptedValue)})`,
      {
        idempotencyKey,
        field,
        priorValue: String(priorValue),
        attemptedValue: String(attemptedValue),
      },
    );
    this.name = "IdempotencyMismatchError";
    Object.setPrototypeOf(this, IdempotencyMismatchError.prototype);
  }
}
