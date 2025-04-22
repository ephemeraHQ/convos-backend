export class AppError extends Error {
  constructor(
    public statusCode: number,
    public message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, message, details);
    this.name = "ValidationError";
  }
}

export const logError = (error: unknown, context?: Record<string, unknown>) => {
  const errorLog = {
    timestamp: new Date().toISOString(),
    name: error instanceof Error ? error.name : "UnknownError",
    message:
      error instanceof Error ? error.message : "An unknown error occurred",
    stack: error instanceof Error ? error.stack : undefined,
    details:
      error instanceof AppError
        ? error.details
        : error instanceof Error
          ? Object.getOwnPropertyNames(error).reduce<Record<string, unknown>>(
              (acc, key) => {
                // @ts-expect-error - dynamic properties access
                acc[key] = error[key];
                return acc;
              },
              {},
            )
          : { rawError: String(error) },
    context,
  };

  console.error("\n=============== ERROR LOG ===============");
  console.error(
    `[${errorLog.timestamp}] ${errorLog.name}: ${errorLog.message}`,
  );

  if (errorLog.stack) {
    console.error("\n--- Stack Trace ---");
    console.error(errorLog.stack);
  }

  if (errorLog.details && Object.keys(errorLog.details).length > 0) {
    console.error("\n--- Error Details ---");
    console.error(JSON.stringify(errorLog.details, null, 2));
  }

  if (context && Object.keys(context).length > 0) {
    console.error("\n--- Request Context ---");
    console.error(JSON.stringify(context, null, 2));
  }
  console.error("==========================================\n");

  return errorLog;
};
