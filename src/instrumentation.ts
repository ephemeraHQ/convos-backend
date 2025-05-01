import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { PrismaInstrumentation } from "@prisma/instrumentation";

// Use the default config for the OTLP trace exporter
// This will connect to localhost:4317
const traceExporter = new OTLPTraceExporter();

// Initialize the NodeSDK
const sdk = new NodeSDK({
  serviceName: "convos-backend",
  traceExporter,
  spanProcessors: [
    // Use a batch processor in production to avoid overloading the collector
    process.env.NODE_ENV === "production"
      ? new BatchSpanProcessor(traceExporter)
      : new SimpleSpanProcessor(traceExporter),
  ],
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: "convos-backend",
  }),
  instrumentations: [
    // HttpInstrumentation is required before Express
    new HttpInstrumentation(),
    // Auto instrument Express
    new ExpressInstrumentation(),
    // Auto instrument Prisma
    new PrismaInstrumentation({
      middleware: false,
    }),
  ],
});

// Start the SDK
sdk.start();

// Handle graceful shutdown
process.on("SIGTERM", () => {
  // Try to shutdown the SDK cleanly and export the last traces
  sdk
    .shutdown()
    .then(() => {
      console.log("Tracing shut down successfully");
    })
    .catch((e: unknown) => {
      console.error("Error shutting down tracing", e);
    })
    .finally(() => process.exit(0));
});
