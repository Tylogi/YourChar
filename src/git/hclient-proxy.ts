import { connect } from "node:net";

const [portText, host, targetPortText] = process.argv.slice(2);
const proxyPort = Number(portText);
const targetPort = Number(targetPortText);

if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535 ||
    !host || /[\r\n\u0000]/u.test(host) ||
    !Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
  process.stderr.write("usage: hclient-proxy <local-proxy-port> <host> <port>\n");
  process.exit(2);
}

const socket = connect({ host: "127.0.0.1", port: proxyPort });
let header = Buffer.alloc(0);
let connected = false;

socket.setTimeout(20_000, () => socket.destroy(new Error("proxy connection timed out")));
socket.once("connect", () => {
  socket.write(`CONNECT ${host}:${targetPort} HTTP/1.1\r\nHost: ${host}:${targetPort}\r\nProxy-Connection: Keep-Alive\r\n\r\n`);
});
socket.on("data", (chunk: Buffer) => {
  if (connected) return;
  header = Buffer.concat([header, chunk]);
  if (header.length > 16 * 1024) socket.destroy(new Error("proxy response headers too large"));
  const end = header.indexOf("\r\n\r\n");
  if (end < 0) return;
  const statusLine = header.subarray(0, header.indexOf("\r\n")).toString("ascii");
  if (!/^HTTP\/1\.[01] 2\d\d\b/u.test(statusLine)) {
    socket.destroy(new Error(`proxy CONNECT failed: ${statusLine}`));
    return;
  }
  connected = true;
  socket.setTimeout(0);
  const remainder = header.subarray(end + 4);
  if (remainder.length) process.stdout.write(remainder);
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
  process.stdin.resume();
});
socket.once("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
socket.once("close", () => {
  if (!connected) process.exitCode = 1;
});
