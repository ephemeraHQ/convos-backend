import { context as otelContext, trace } from "@opentelemetry/api";
import pinoHttp from "pino-http";
import logger from "@/utils/logger";

export const pinoMiddleware = pinoHttp({
  logger,
  redact: {
    paths: ["req.headers", "res.headers"],
    remove: true,
  },
  customProps: function (req) {
    const pathname = req.url?.split("?")[0] || "";

    const span = trace.getSpan(otelContext.active());
    if (!span) {
      return { pathname };
    }

    const { traceId, spanId } = span.spanContext();
    return { pathname, trace_id: traceId, span_id: spanId }; // adds to every log
  },
});
