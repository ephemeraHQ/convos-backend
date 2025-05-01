import pino, { type LoggerOptions } from "pino";

export const pinoConfig: LoggerOptions = {
  level: process.env.LOG_LEVEL || "info",
  transport:
    process.env.LOG_FORMAT === "json"
      ? undefined
      : {
          target: "pino-pretty",
        },
};

export default pino(pinoConfig);
