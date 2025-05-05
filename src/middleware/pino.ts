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
    // https://docs.datadoghq.com/opentelemetry/correlate/logs_and_traces/?tab=nodejs
    const ddSpanId = BigInt(`0x${spanId}`).toString();
    return { pathname, "dd.trace_id": traceId, "dd.span_id": ddSpanId }; // adds to every log
  },
});
