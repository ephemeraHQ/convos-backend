import cors from "cors";
import express, { type Request, type Response } from "express";
import helmet from "helmet";
import { errorMiddleware } from "./middleware/error";
import { jsonMiddleware } from "./middleware/json";
import { logMiddleware } from "./middleware/log";

const app = express();
app.use(cors());
app.use(helmet());
app.use(jsonMiddleware);

const port = process.env.PORT || 4000;

// log all requests in dev mode
app.use(logMiddleware);

// handle errors
app.use(errorMiddleware);

// GET /healthcheck - Healthcheck endpoint
app.get("/healthcheck", (_req: Request, res: Response): void => {
  res.status(200).send("OK");
});

const server = app.listen(port, () => {
  console.log(`Convos API service is running on port ${port}`);
});

process.on("SIGTERM", () => {
  console.log("SIGTERM signal received: closing Convos API service");
  server.close(() => {
    console.log("Convos API service closed");
  });
});
