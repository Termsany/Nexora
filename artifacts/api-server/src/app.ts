import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { attachTenantContext } from "./tenancy/context";
import { requestId } from "./security/request-id";
import { csrfProtection } from "./security/csrf";
import { validateSecurityConfiguration } from "./security/config";

const app: Express = express();
validateSecurityConfiguration();

// The session cookie is only trustworthy if the proxy that terminates TLS is
// trusted for req.ip and req.secure; nginx is the only ingress in this
// deployment.
app.set("trust proxy", 1);

app.use(requestId);
app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
app.use(cors({
  origin: allowedOrigins.length ? allowedOrigins : false,
  // Session cookies are only sent cross-origin for the configured origins.
  credentials: true,
}));
app.use(express.json({ limit: "4mb", verify: (req, _res, buf) => { (req as typeof req & { rawBody?: Buffer }).rawBody = Buffer.from(buf); } }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Establishes req.tenant for any request that carries a valid credential.
// Routes then declare their own requirements; nothing is authorized by default.
app.use("/api", attachTenantContext);
app.use("/api", csrfProtection);
app.use("/api", router);

export default app;
