// Mach-O files, found by their first bytes, and the macOS each needs (its load commands'
// LC_BUILD_VERSION minos, as `otool -l` shows it). Only the headers are read, so walking a
// whole app bundle takes seconds.
'use strict';

const fs = require('fs');
const path = require('path');

const MH_MAGIC_64 = 0xfeedfacf;
const MH_MAGIC = 0xfeedface;
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const LC_BUILD_VERSION = 0x32;
const LC_VERSION_MIN_MACOSX = 0x24;
const PLATFORM_MACOS = 1;
const CPU_TYPE_ARM64 = 0x0100000c;
const CPU_TYPE_X86_64 = 0x01000007;
const MH_EXECUTE = 0x2;

// A Java class file starts with CAFEBABE too; its next word is a version (45 and up) where
// a universal binary's is its count of architectures (a handful).
const MAX_FAT_ARCHS = 30;

function read(fd, offset, length) {
  const buf = Buffer.alloc(length);
  const got = fs.readSync(fd, buf, 0, length, offset);
  return got === length ? buf : buf.subarray(0, got);
}

// 'thin', 'fat' or null (not a Mach-O), from a file's first eight bytes.
function kindOf(head) {
  if (!head || head.length < 8) return null;
  const le = head.readUInt32LE(0);
  if (le === MH_MAGIC_64 || le === MH_MAGIC) return 'thin';
  const be = head.readUInt32BE(0);
  if (be === FAT_MAGIC || be === FAT_MAGIC_64) {
    const count = head.readUInt32BE(4);
    return count > 0 && count <= MAX_FAT_ARCHS ? 'fat' : null;
  }
  return null;
}

function isMachO(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    return kindOf(read(fd, 0, 8)) !== null;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// "14.0" from LC_BUILD_VERSION's packed xxxx.yy.zz (a patch level only when there is one).
function unpackVersion(v) {
  const major = v >>> 16;
  const minor = (v >>> 8) & 0xff;
  const patch = v & 0xff;
  return patch ? `${major}.${minor}.${patch}` : `${major}.${minor}`;
}

function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

function maxVersion(versions) {
  return versions.filter(Boolean).reduce((a, b) => (a === null || compareVersions(b, a) > 0 ? b : a), null);
}

// One architecture slice at `offset`: its CPU, file type and the macOS versions it asks for.
function slice(fd, offset) {
  const header = read(fd, offset, 32);
  if (header.length < 28) return null;
  const magic = header.readUInt32LE(0);
  if (magic !== MH_MAGIC_64 && magic !== MH_MAGIC) return null;
  const is64 = magic === MH_MAGIC_64;
  const cputype = header.readUInt32LE(4);
  const filetype = header.readUInt32LE(12);
  const ncmds = header.readUInt32LE(16);
  const sizeofcmds = header.readUInt32LE(20);
  const cmds = read(fd, offset + (is64 ? 32 : 28), sizeofcmds);
  const minos = [];
  let at = 0;
  for (let i = 0; i < ncmds && at + 8 <= cmds.length; i += 1) {
    const cmd = cmds.readUInt32LE(at);
    const size = cmds.readUInt32LE(at + 4);
    if (size < 8) break;
    if (cmd === LC_BUILD_VERSION && at + 12 <= cmds.length) {
      if (cmds.readUInt32LE(at + 8) === PLATFORM_MACOS) minos.push(unpackVersion(cmds.readUInt32LE(at + 12)));
    } else if (cmd === LC_VERSION_MIN_MACOSX && at + 12 <= cmds.length) {
      minos.push(unpackVersion(cmds.readUInt32LE(at + 8)));
    }
    at += size;
  }
  const arch = cputype === CPU_TYPE_ARM64 ? 'arm64' : cputype === CPU_TYPE_X86_64 ? 'x86_64' : `cpu${cputype}`;
  return { arch, executable: filetype === MH_EXECUTE, minos: maxVersion(minos) };
}

// {kind, slices: [{arch, executable, minos}]} for a Mach-O file, else null.
function inspect(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = read(fd, 0, 8);
    const kind = kindOf(head);
    if (!kind) return null;
    if (kind === 'thin') {
      const one = slice(fd, 0);
      return one ? { kind, slices: [one] } : null;
    }
    const wide = head.readUInt32BE(0) === FAT_MAGIC_64;
    const count = head.readUInt32BE(4);
    const table = read(fd, 8, count * (wide ? 32 : 20));
    const slices = [];
    for (let i = 0; i < count; i += 1) {
      const at = i * (wide ? 32 : 20);
      if (at + (wide ? 32 : 20) > table.length) break;
      const offset = wide ? Number(table.readBigUInt64BE(at + 8)) : table.readUInt32BE(at + 8);
      const one = slice(fd, offset);
      if (one) slices.push(one);
    }
    return { kind, slices };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// The macOS an Apple-silicon Mac needs to run it: its arm64 slice's minos.
function arm64Minos(info) {
  if (!info) return null;
  const arm = info.slices.filter((s) => s.arch === 'arm64');
  return maxVersion((arm.length ? arm : info.slices).map((s) => s.minos));
}

// Every regular file under root (symlinks aren't followed: what they point at inside the
// bundle is walked where it really is).
function walkFiles(root, out = []) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

// Every Mach-O under root, with what each needs.
function scan(root) {
  const found = [];
  for (const file of walkFiles(root)) {
    const info = inspect(file);
    if (info) found.push({ file, info, minos: arm64Minos(info) });
  }
  return found;
}

module.exports = {
  kindOf, isMachO, inspect, arm64Minos, scan, walkFiles, unpackVersion, compareVersions, maxVersion,
};
