import { createServer } from "node:http";
import app from "./app";
import { logger } from "./lib/logger";
import { attachRemoteDesktopGateway } from "./remote-desktop/gateway";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// The Remote Desktop gateway needs the raw HTTP server to answer `upgrade`,
// so the server is created explicitly rather than by app.listen(). Express
// keeps handling every ordinary request exactly as before.
const server = createServer(app);
const remoteDesktop = attachRemoteDesktopGateway(server);

server.on("error", (err) => {
  logger.error({ err }, "Error listening on port");
  process.exit(1);
});

server.listen(port, () => {
  logger.info({ port }, "Server listening");
});

// A restart must not leave sessions believing they are live; the gateway
// closes its bridges and the maintenance sweep reaps the database rows.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    remoteDesktop.close();
    server.close(() => process.exit(0));
  });
}
