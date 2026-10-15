"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const readline = require("node:readline");
const mongoose = require("mongoose");

const FORMAT = "racs-reset-recovery-v2";
const MAX_EXPANDED_BYTES = 1024 * 1024 * 1024;
const MAX_COMPRESSED_BYTES = 256 * 1024 * 1024;
const MAX_LINE_BYTES = 128 * 1024 * 1024;
const serialize = value => mongoose.mongo.BSON.EJSON.stringify(value, null, 2, { relaxed: false });
const compact = value => mongoose.mongo.BSON.EJSON.stringify(value, null, 0, { relaxed: false });
const deserialize = value => mongoose.mongo.BSON.EJSON.parse(value, { relaxed: false });

function* snapshotSections(snapshot) {
  for (const [name, value] of Object.entries(snapshot)) {
    if (name === "remove") {
      for (const [collection, rows] of Object.entries(value)) yield { path: ["remove", collection], rows };
    } else {
      if (!Array.isArray(value)) throw Error("Unsupported recovery snapshot section.");
      yield { path: [name], rows: value };
    }
  }
}

function digest(snapshot) {
  const hash = crypto.createHash("sha256");
  for (const section of snapshotSections(snapshot)) {
    hash.update(compact({ path: section.path, count: section.rows.length }) + "\n");
    for (const row of section.rows) hash.update(compact(row) + "\n");
  }
  return hash.digest("hex");
}

const legacyDigest = value => crypto.createHash("sha256").update(serialize(value)).digest("hex");
const snapshotDigest = (snapshot, version = 1) => version === 2 ? digest(snapshot) : legacyDigest(snapshot);

async function fileDigest(file) {
  const hash = crypto.createHash("sha256");
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}

function privateDirectory(directory) {
  const root = path.resolve(directory);
  const exposed = [path.resolve(__dirname, "../public"), path.resolve(__dirname, "../../public"), path.resolve(__dirname, "../uploads")];
  const normalize = value => process.platform === "win32" ? value.toLowerCase() : value;
  const forbidden = value => exposed.some(parent => normalize(value) === normalize(parent) || normalize(value).startsWith(normalize(parent) + path.sep));
  if (forbidden(root)) throw Error("Recovery backups must be stored outside public/upload directories.");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (forbidden(fs.realpathSync(root))) throw Error("Recovery backups must not resolve into public/upload directories.");
  return root;
}

function recoveryLimits() {
  let total = 0, line = 0;
  return new Transform({ transform(bytes, encoding, callback) {
    total += bytes.length;
    for (let offset = 0; offset < bytes.length;) {
      const end = bytes.indexOf(10, offset);
      const length = (end < 0 ? bytes.length : end) - offset;
      line += length;
      if (line > MAX_LINE_BYTES) return callback(Error("A recovery document exceeds the supported size. No database changes made."));
      if (end < 0) break;
      line = 0; offset = end + 1;
    }
    if (total > MAX_EXPANDED_BYTES) return callback(Error("The recovery data exceeds the 1 GiB supported limit. No database changes made."));
    callback(null, bytes);
  } });
}

async function writeResetBackup(artifact, directory = path.resolve(__dirname, "../../temp"), { namePrefix = "booking-order-reset" } = {}) {
  if (!["booking-order-reset", "paid-payroll-reset", "expense-reset"].includes(namePrefix)) throw Error("Unsupported recovery backup name prefix.");
  const root = privateDirectory(directory);
  const file = path.join(root, `${namePrefix}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.ejson.gz`);
  const temporary = file + ".part", sidecar = file + ".sha256";
  const owned = new Set();
  const { original, seed, ...metadata } = artifact;
  const originalSnapshotHash = digest(original);
  const header = { kind: "header", format: FORMAT, metadata: { ...metadata, snapshotDigestVersion: 2, originalSnapshotHash } };
  let expandedBytes = 0, documents = 0, sections = 0;
  const sectionSizes = [];
  function* lines() {
    yield Buffer.from(compact(header) + "\n");
    for (const [group, entries] of [["original", snapshotSections(original)], ["seed", Object.entries(seed).map(([name, rows]) => ({ path: [name], rows }))]]) {
      for (const section of entries) {
        sections++;
        yield Buffer.from(compact({ kind: "section", group, path: section.path, count: section.rows.length }) + "\n");
        let bytes = 0;
        for (const value of section.rows) {
          documents++;
          const line = Buffer.from(compact({ kind: "document", value }) + "\n");
          bytes += line.length;
          yield line;
        }
        sectionSizes.push({ section: [group, ...section.path].join("."), records: section.rows.length, bytes });
      }
    }
    yield Buffer.from(compact({ kind: "end", sections, documents }) + "\n");
  }
  const count = new Transform({ transform(bytes, encoding, callback) { expandedBytes += bytes.length; callback(null, bytes); } });
  let compressedBytes = 0;
  const boundCompressed = new Transform({ transform(bytes, encoding, callback) {
    compressedBytes += bytes.length;
    if (compressedBytes > MAX_COMPRESSED_BYTES) return callback(Error("The compressed recovery file exceeds 256 MiB. No database changes made."));
    callback(null, bytes);
  } });
  try {
    const output = fs.createWriteStream(temporary, { flags: "wx", mode: 0o600 });
    output.once("open", () => owned.add(temporary));
    await pipeline(Readable.from(lines(), { objectMode: false, highWaterMark: 64 * 1024 }), recoveryLimits(), count, zlib.createGzip(), boundCompressed,
      output);
    const backupSha256 = await fileDigest(temporary);
    const handle = await fs.promises.open(temporary, "r+");
    try { await handle.sync(); } finally { await handle.close(); }
    const finalHandle = await fs.promises.open(file, "wx", 0o600);
    owned.add(file); await finalHandle.close();
    await fs.promises.rename(temporary, file);
    const checksumHandle = await fs.promises.open(sidecar, "wx", 0o600);
    owned.add(sidecar);
    try { await checksumHandle.writeFile(backupSha256 + "\n"); await checksumHandle.sync(); }
    finally { await checksumHandle.close(); }
    // Decode and verify every original record without retaining a second copy of
    // large evidence images while the source snapshot is already in memory.
    await readResetBackup(file, { omitOriginal: true });
    const download = `/admin/maintenance/data-reset-backups/${path.basename(file)}`;
    return { backup: file, backupSha256, backupDownloadPath: download, checksumDownloadPath: download + ".sha256",
      backupFormat: FORMAT, compressedBytes, expandedBytes, documents, recoveryVerified: true,
      largestSections: sectionSizes.sort((a, b) => b.bytes - a.bytes).slice(0, 3) };
  } catch (error) {
    for (const candidate of owned) {
      if (path.dirname(candidate) !== root) throw Error("Invalid recovery cleanup path.");
      await fs.promises.unlink(candidate).catch(failure => { if (failure.code !== "ENOENT") throw failure; });
    }
    throw error;
  }
}

async function readResetBackup(file, { omitOriginal = false } = {}) {
  const stat = await fs.promises.stat(file);
  if (!stat.isFile() || stat.size > MAX_COMPRESSED_BYTES) throw Error("The recovery file exceeds the supported size.");
  const actual = await fileDigest(file), expected = (await fs.promises.readFile(file + ".sha256", "utf8")).trim();
  if (actual !== expected) throw Error("The recovery backup checksum does not match. No database changes made.");
  if (!file.endsWith(".gz")) {
    if (stat.size > 64 * 1024 * 1024) throw Error("Legacy uncompressed recovery files are limited to 64 MiB. Prepare a compressed recovery file.");
    const artifact = deserialize(await fs.promises.readFile(file, "utf8"));
    return { artifact, backupSha256: actual };
  }
  const input = fs.createReadStream(file), gunzip = zlib.createGunzip(), bounded = recoveryLimits();
  const completion = pipeline(input, gunzip, bounded);
  // Attach rejection handling immediately; the awaited completion below remains
  // authoritative, including gzip CRC/truncation errors after the last line.
  completion.catch(() => {});
  const reader = readline.createInterface({ input: bounded, crlfDelay: Infinity });
  let artifact, section, remaining = 0, documents = 0, sections = 0, ended = false;
  const seen = new Set(), hash = crypto.createHash("sha256");
  try {
    for await (const line of reader) {
      if (!line || ended) throw Error("Unexpected content in the recovery file.");
      const row = deserialize(line);
      if (!artifact) {
        if (row.kind !== "header" || row.format !== FORMAT || Number(row.metadata?.snapshotDigestVersion) !== 2) throw Error("Unsupported recovery file format.");
        artifact = { ...row.metadata, ...(omitOriginal ? {} : { original: {} }), seed: {} };
      } else if (row.kind === "section") {
        if (remaining || !["original", "seed"].includes(row.group) || !Array.isArray(row.path)
          || row.path.length < 1 || row.path.length > 2 || row.path.some(key => !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key) || ["__proto__", "constructor", "prototype"].includes(key))) throw Error("Invalid recovery section.");
        if (row.path.length === 2 && (row.group !== "original" || row.path[0] !== "remove")) throw Error("Invalid recovery section path.");
        const key = [row.group, ...row.path].join(".");
        if (seen.has(key)) throw Error("Duplicate recovery section.");
        remaining = Number(row.count);
        if (!Number.isInteger(remaining) || remaining < 0 || remaining > 50000) throw Error("Invalid recovery record count.");
        seen.add(key); sections++;
        section = { group: row.group, path: row.path };
        if (row.group === "original") hash.update(compact({ path: row.path, count: remaining }) + "\n");
        if (row.group !== "original" || !omitOriginal) {
          const group = artifact[row.group];
          if (row.path.length === 2) { group.remove ||= {}; group.remove[row.path[1]] = []; }
          else group[row.path[0]] = [];
        }
      } else if (row.kind === "document") {
        if (!section || remaining < 1 || !row.value || typeof row.value !== "object") throw Error("Unexpected recovery document.");
        if (section.group === "original") hash.update(compact(row.value) + "\n");
        if (section.group !== "original" || !omitOriginal) {
          const target = section.path.length === 2 ? artifact[section.group].remove[section.path[1]] : artifact[section.group][section.path[0]];
          target.push(row.value);
        }
        remaining--; documents++;
      } else if (row.kind === "end") {
        if (remaining || Number(row.sections) !== sections || Number(row.documents) !== documents) throw Error("Incomplete recovery file.");
        ended = true;
      } else throw Error("Unexpected recovery record.");
    }
    await completion;
    if (!ended || !artifact || hash.digest("hex") !== artifact.originalSnapshotHash) throw Error("Recovery snapshot verification failed. No database changes made.");
    return { artifact, backupSha256: actual };
  } finally { reader.close(); input.destroy(); gunzip.destroy(); bounded.destroy(); await completion.catch(() => {}); }
}

module.exports = { FORMAT, MAX_EXPANDED_BYTES, serialize, deserialize, digest, snapshotDigest, writeResetBackup, readResetBackup };
