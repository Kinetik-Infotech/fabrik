// chat-page's wait for the chat's own address: it takes the address from Cloudflare's DNS, never this computer's, so a
// deleted record the computer still remembers can't hold it up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { cloudflareAddress, reachWith } from "../cli/chat-domain.mjs";

const answer = body => async () => ({ json: async () => body });

test("Cloudflare's DNS answer gives the first IPv4 address, past a CNAME, and null for no answer or a failure", async () => {
  assert.equal(await cloudflareAddress("chat.example.com", answer({ Answer: [
    { name: "chat.example.com", type: 5, data: "x.pages.dev." }, { name: "x.pages.dev", type: 1, data: "104.21.22.247" }] })), "104.21.22.247");
  assert.equal(await cloudflareAddress("chat.example.com", answer({ Status: 3 })), null);
  assert.equal(await cloudflareAddress("chat.example.com", async () => { throw new Error("offline"); }), null);
});

test("the wait connects to the address Cloudflare gives, under the host's own name, and needs a page", async () => {
  const seen = [];
  const server = createServer((req, res) => { seen.push(req.headers.host); res.statusCode = req.headers.host.startsWith("ok.") ? 200 : 522; res.end(); });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  try {
    const reach = reachWith({ address: async () => "127.0.0.1", request, port });
    assert.equal(await reach("ok.example.com"), true);
    assert.equal(await reach("down.example.com"), false);
    assert.deepEqual(seen, [`ok.example.com:${port}`, `down.example.com:${port}`]);
    assert.equal(await reachWith({ address: async () => null, request, port })("ok.example.com"), false);
  } finally { server.close(); }
});
