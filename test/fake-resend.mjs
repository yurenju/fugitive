// A stand-in for Resend's HTTP API in the end-to-end tests: logs "<to> <code>" for every email, one per line.
// Usage: node test/fake-resend.mjs <port> <log file>
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const [port, log] = process.argv.slice(2);
createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const mail = JSON.parse(body);
    appendFileSync(log, `${mail.to[0]} ${/\d{6}/.exec(mail.subject)[0]}\n`);
    res.writeHead(200, { "Content-Type": "application/json" }).end('{"id":"fake"}');
  });
}).listen(Number(port), "127.0.0.1");
