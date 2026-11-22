#!/usr/bin/env node
// Minimal local receiver for Cookie Transfer.
//   node receiver.mjs [port] [outfile]
// Prints a one-time token; paste it into the extension popup. Binds to 127.0.0.1 only.
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";

const port = Number(process.argv[2] || 8765);
const outfile = process.argv[3] || "received-cookies.json";
const token = crypto.randomBytes(16).toString("hex");

const server = http.createServer((req, res) => {
  const cors = {
    "Access-Control-Allow-Origin": req.headers.origin || "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (req.method === "OPTIONS") return res.writeHead(204, cors).end();
  if (req.method !== "POST" || req.url !== "/cookies") return res.writeHead(404, cors).end();

  const given = Buffer.from(req.headers.authorization || "");
  const want = Buffer.from(`Bearer ${token}`);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    return res.writeHead(401, cors).end();
  }

  let body = "";
  req.on("data", (d) => { body += d; if (body.length > 50e6) req.destroy(); });
  req.on("end", () => {
    try {
      const data = JSON.parse(body);
      // Replace this with your own handling (e.g. load into Electron's session.cookies).
      fs.writeFileSync(outfile, JSON.stringify(data, null, 2), { mode: 0o600 });
      console.log(`Received ${data.cookies?.length ?? 0} cookies -> ${outfile}`);
      res.writeHead(200, cors).end("ok");
    } catch {
      res.writeHead(400, cors).end();
    }
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Listening on http://127.0.0.1:${port}/cookies`);
  console.log(`Token: ${token}`);
});
