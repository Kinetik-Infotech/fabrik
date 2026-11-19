#!/usr/bin/env node
// Signs one fabrik upgrade with the upgrade signing key, for the fabrik-upgrade hosted function, which applies only a
// signed file, unchanged. Run on the signer's own computer.
//
//   node scripts/sign-upgrade.mjs <upgrade file> [--key <private key file>] [--out <request file>]
//   node scripts/sign-upgrade.mjs --beside <upgrade file> ... [--key <private key file>]
//   node scripts/sign-upgrade.mjs --new-key [--key <private key file>]
//
// --beside writes each upgrade's signature, in base64, to the .sig file of the same name beside it, as each release
// commits it, so fabrik update applies the upgrade from the installed plugin. A .sig already there is kept unless it no
// longer matches the file.
//
// The private key is read from outside the repository: ~/.config/fabrik/upgrade-signing-key unless --key names
// another file. It must be readable by its owner alone, mode 0600, or the script refuses it. Never commit it.
//
// Signing writes fabrik-upgrade's request as JSON, to --out or to standard output: { series, number, name, sql,
// signature }. series is "fabrik" for a file in upgrades/ and "file_search" for one in file-search-upgrades/, number and
// name come from the file's name, NNNN-<name>.sql, whose first line must name the same upgrade, sql is the file's whole
// text, and signature is the Ed25519 signature over its exact bytes, in base64. An administrator then sends it with
// fabrik upgrade <request file>, which posts it to fabrik-upgrade as the signed-in person.
//
// --new-key makes a new key pair. It writes the private key to the key file, mode 0600, in a folder readable by its
// owner alone, and never replaces a key file already there. It prints the public key, in base64, for
// functions/fabrik-upgrade/upgrade-key.ts.
import process from "node:process";
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_KEY = resolve(homedir(), ".config/fabrik/upgrade-signing-key");
export const USAGE = `Usage: node scripts/sign-upgrade.mjs <upgrade file> [--key <private key file>] [--out <request file>]
       node scripts/sign-upgrade.mjs --beside <upgrade file> ... [--key <private key file>]
       node scripts/sign-upgrade.mjs --new-key [--key <private key file>]`;
const SERIES = { upgrades: "fabrik", "file-search-upgrades": "file_search" };

/** The public key, raw and in base64, as WebCrypto imports it. */
export const publicKeyOf = key => Buffer.from(key.export({ format: "jwk" }).x, "base64url").toString("base64");

/** A new key pair: the private key written to file, mode 0600. Returns the public key in base64. */
export function newKey(file = DEFAULT_KEY) {
  if (existsSync(file)) throw new Error(`${file} is there already. A key file is never replaced.`);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  writeFileSync(file, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600, flag: "wx" });
  try { chmodSync(file, 0o600); } catch {}
  return publicKeyOf(publicKey);
}

/** The private key from file, refused unless only its owner can read it. */
export function readKey(file = DEFAULT_KEY) {
  if (!existsSync(file)) throw new Error(`${file} holds no key. The signing key lives on the signer's computer only.`);
  const mode = statSync(file).mode & 0o777;
  if (process.platform !== "win32" && mode !== 0o600) throw new Error(`${file} has mode ${mode.toString(8)}. Make it readable by you alone first: chmod 600 ${file}`);
  const key = createPrivateKey(readFileSync(file));
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`${file} is not an Ed25519 key.`);
  return key;
}

/** fabrik-upgrade's request for one upgrade file, signed with key. */
export function signUpgrade(path, key) {
  const file = resolve(path);
  const series = SERIES[basename(dirname(file))];
  if (!series) throw new Error(`${path} is not in an upgrades/ or file-search-upgrades/ folder.`);
  const named = /^([0-9]{4})-([a-z0-9][a-z0-9-]*)\.sql$/.exec(basename(file));
  if (!named) throw new Error(`${basename(file)} is not named NNNN-<name>.sql.`);
  const bytes = readFileSync(file);
  // The function reads the text as UTF-8, so the bytes must be UTF-8 for the signature to cover them exactly.
  const sql = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (Buffer.compare(Buffer.from(sql, "utf8"), bytes) !== 0) throw new Error(`${path} does not read back as the same UTF-8 bytes.`);
  const id = `${named[1]}-${named[2]}`;
  const first = /^-- ([0-9]{4}-[a-z0-9-]+)(?::|\s*$)/.exec(sql.split("\n", 1)[0]);
  if (first?.[1] !== id) throw new Error(`${path}'s first line must name the upgrade, as "-- ${id}".`);
  return { series, number: named[1], name: named[2], sql, signature: sign(null, bytes, key).toString("base64") };
}

function options(argv) {
  const out = { files: [] };
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i];
    if (word === "--new-key") out.newKey = true;
    else if (word === "--beside") out.beside = true;
    else if (word === "--key" || word === "--out") {
      if (argv[i + 1] === undefined) throw new Error(`${word} needs a value.`);
      out[word.slice(2)] = argv[++i];
    } else if (word.startsWith("--")) throw new Error(`${word} is not an option.`);
    else out.files.push(word);
  }
  return out;
}

export function main(argv, { say = line => process.stdout.write(`${line}\n`), fail = line => process.stderr.write(`${line}\n`) } = {}) {
  let o;
  try { o = options(argv); } catch (err) { fail(`${err.message}\n${USAGE}`); return 2; }
  try {
    const keyFile = resolve(o.key ?? DEFAULT_KEY);
    if (o.newKey) {
      if (o.files.length || o.out) throw new Error(USAGE);
      const pub = newKey(keyFile);
      fail(`The private key is in ${keyFile}, readable by you alone. Never commit it.`);
      say(pub);
      return 0;
    }
    if (o.beside) {
      if (!o.files.length || o.out) throw new Error(USAGE);
      const key = readKey(keyFile);
      for (const file of o.files) {
        const signed = signUpgrade(file, key);
        const sig = resolve(file).replace(/\.sql$/, ".sig");
        if (existsSync(sig) && readFileSync(sig, "utf8").trim() === signed.signature) { fail(`${basename(sig)} is already there.`); continue; }
        writeFileSync(sig, `${signed.signature}\n`);
        fail(`Signed ${basename(file)} into ${basename(sig)}.`);
      }
      return 0;
    }
    if (o.files.length !== 1) throw new Error(USAGE);
    const request = JSON.stringify(signUpgrade(o.files[0], readKey(keyFile))) + "\n";
    if (o.out) { writeFileSync(o.out, request, { flag: "wx" }); fail(`Signed ${basename(o.files[0])} into ${resolve(o.out)}.`); }
    else process.stdout.write(request);
    return 0;
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
