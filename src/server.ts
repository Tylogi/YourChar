import { createHttpServer } from "./http/router.js";

const port = Number(process.env.PORT ?? 8765);
const host = process.env.HOST ?? "127.0.0.1";

const server = createHttpServer();
server.listen(port, host, () => {
  console.log(`RP Agent listening on http://${host}:${port}`);
});
