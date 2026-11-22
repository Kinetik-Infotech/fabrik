// Starts the plugin's server as Claude does, over stdio, and calls it.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "mcp", "server.mjs");

export function startServer(env) {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map();
  const lines = [];
  let stderr = "";
  let buffer = "";
  let next = 1;
  child.stderr.on("data", c => { stderr += c; });
  child.stdout.on("data", c => {
    buffer += c;
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      lines.push(line);
      const msg = JSON.parse(line);
      waiting.get(msg.id)?.(msg);
      waiting.delete(msg.id);
    }
  });
  const request = (method, params) => new Promise(resolve => {
    const id = next++;
    waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const tool = async (name, args = {}) => {
    const { result, error } = await request("tools/call", { name, arguments: args });
    if (error) throw new Error(error.message);
    return { text: result.content.map(c => c.text).join("\n"), isError: !!result.isError };
  };
  const stop = () => new Promise(r => { child.on("exit", r); child.stdin.end(); });
  return { request, tool, stop, lines, stderr: () => stderr };
}
