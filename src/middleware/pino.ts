import pinoHttp from "pino-http";
import logger from "@/utils/logger";

export const pinoMiddleware = pinoHttp({
  logger,
  redact: {
    paths: ["req.headers", "res.headers"],
    remove: true,
  },
  customProps: function (req) {
    return {
      pathname: req.url?.split("?")[0] || "",
    };
  },
});
