import cors from "cors";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const port = process.env.PORT || 4000;
const environment = process.env.ENV || "dev";

// Log all requests in dev mode
app.use((req: Request, res: Response, next: NextFunction) => {
  if (environment === "dev") {
    console.log(
      `[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`,
    );
  }
  next();
});

// Handle all errors
app.use(
  (err: Error, _req: Request, res: Response, _next: NextFunction): void => {
    console.error(err);
    res.status(500).json({
      error: {
        name: err.name,
        type: typeof err,
        message: err.message,
      },
    });
  },
);

app.get("/", (_req: Request, res: Response): void => {
  res.send("Hello, world!");
});

app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});
