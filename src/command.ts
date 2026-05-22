// COMMAND.COM — TS-DOS's user-mode shell.
//
// Pure TypeScript on top of standard MS-DOS-style INT 21h services
// (AH=02h, 09h, 0Ah, 1Ah, 39h, 3Bh, 3Ch, 3Dh, 3Eh, 3Fh, 40h, 47h,
// 4Bh, 4Ch, 4Eh, 4Fh) exposed by the `ts-os` module. There is no
// custom kernel call for command parsing — the shell loops over
// FindFirst/FindNext to do `dir`, calls MkDir/ChDir/GetCwd for
// directory navigation, and chains Open/Read/Write/Close for `copy`.

import * as tsos from "ts-os";

// Right-aligned 16-bit decimal print. Iterative so we don't recurse
// through the backend's globally-allocated parameter slots (the x86
// raw target does not yet stack-allocate locals/params, so recursion
// would overwrite `n` and `width` from the inner call). Caps digits at
// 5 — 16-bit unsigned numbers never exceed 65535, and multiplying past
// 10000 in our signed 16-bit divisor would wrap to a negative value
// that breaks the divisor>0 print loop.
function printDec(n: number, width: number): void {
  let divisor = 1;
  let digits = 1;
  while (digits < 5) {
    const next = divisor * 10;
    if (next > n) break;
    divisor = next;
    digits = digits + 1;
  }
  let pad = width - digits;
  while (pad > 0) {
    tsos.printChar(0x20);
    pad = pad - 1;
  }
  while (divisor > 0) {
    const d = (n / divisor) | 0;
    tsos.printChar((d % 10) + 0x30);
    divisor = (divisor / 10) | 0;
  }
}

function isSpace(ch: number): number {
  if (ch == 0x20) return 1;
  if (ch == 0x09) return 1;
  return 0;
}

// Find the first space in `line`, terminate the line there, and return
// the offset of the next non-space character. Used to split "cd FOO"
// or "copy SRC DST" into command + argument(s) operating directly on
// the readLine buffer.
function splitArg(line: string): number {
  let i = 0;
  while (1 != 0) {
    const ch = tsos.bufByte(line, i);
    if (ch == 0) return i;
    if (isSpace(ch) != 0) {
      tsos.bufSetByte(line, i, 0);
      i = i + 1;
      while (1 != 0) {
        const c2 = tsos.bufByte(line, i);
        if (c2 == 0) return i;
        if (isSpace(c2) == 0) return i;
        i = i + 1;
      }
    }
    i = i + 1;
  }
  return i;
}

function showPrompt(): void {
  tsos.print("A:\\");
  tsos.print(tsos.cwd());
  tsos.print(">");
}

function cmdDir(): void {
  tsos.print(" Directory of A:\\");
  tsos.print(tsos.cwd());
  tsos.print("\r\n\r\n");
  let count = 0;
  let total = 0;
  let name = tsos.findFirst("*.*");
  while (name != "") {
    const size = tsos.findSize();
    tsos.print(name);
    tsos.print("  ");
    printDec(size, 8);
    tsos.print("\r\n");
    count = count + 1;
    total = total + size;
    name = tsos.findNext();
  }
  tsos.print("\r\n");
  printDec(count, 8);
  tsos.print(" file(s)  ");
  printDec(total, 8);
  tsos.print(" bytes\r\n");
}

function cmdMkdir(path: string): void {
  if (path == "") {
    tsos.print("Usage: mkdir <name>\r\n");
    return;
  }
  const err = tsos.mkdir(path);
  if (err != 0) tsos.print("mkdir failed.\r\n");
}

function cmdCd(path: string): void {
  if (path == "") {
    // Standard DOS: bare `cd` prints the current directory.
    tsos.print("A:\\");
    tsos.print(tsos.cwd());
    tsos.print("\r\n");
    return;
  }
  const err = tsos.chdir(path);
  if (err != 0) tsos.print("cd: no such directory.\r\n");
}

function cmdCopy(rest: string): void {
  // Split "<src> <dst>" by finding the first space inside `rest`.
  let i = 0;
  while (1 != 0) {
    const ch = tsos.bufByte(rest, i);
    if (ch == 0) break;
    if (isSpace(ch) != 0) break;
    i = i + 1;
  }
  if (tsos.bufByte(rest, i) == 0) {
    tsos.print("Usage: copy <src> <dst>\r\n");
    return;
  }
  tsos.bufSetByte(rest, i, 0);
  i = i + 1;
  while (isSpace(tsos.bufByte(rest, i)) != 0) i = i + 1;
  const dst = tsos.bufSlice(rest, i);
  const src = rest;
  if (dst == "") {
    tsos.print("Usage: copy <src> <dst>\r\n");
    return;
  }
  const srcH = tsos.openRead(src);
  if (srcH == 0) {
    tsos.print("copy: cannot open source.\r\n");
    return;
  }
  const dstH = tsos.openWrite(dst);
  if (dstH == 0) {
    tsos.close(srcH);
    tsos.print("copy: cannot create destination.\r\n");
    return;
  }
  let total = 0;
  while (1 != 0) {
    const n = tsos.readToBuf(srcH, 512);
    if (n == 0) break;
    const w = tsos.writeFromBuf(dstH, n);
    if (w == 0) break;
    total = total + w;
    if (w < n) break;
  }
  tsos.close(srcH);
  tsos.close(dstH);
  tsos.print("        1 file(s) copied (");
  printDec(total, 1);
  tsos.print(" bytes)\r\n");
}

tsos.print("TS-DOS COMMAND.COM v0.3 (TypeScript shell)\r\n");
tsos.print("Built-ins: dir, cd, mkdir, copy, exit.\r\n");
tsos.print("Anything else is exec'd as <name>.COM.\r\n\r\n");

while (1 != 0) {
  showPrompt();
  const line = tsos.readLine();
  if (line == "") continue;

  // splitArg trims `line` at the first whitespace and returns the
  // offset of the first non-space arg character (or end-of-string).
  const argStart = splitArg(line);
  const arg = tsos.bufSlice(line, argStart);

  if (line == "dir") {
    cmdDir();
    continue;
  }
  if (line == "cd") {
    cmdCd(arg);
    continue;
  }
  if (line == "mkdir") {
    cmdMkdir(arg);
    continue;
  }
  if (line == "md") {
    cmdMkdir(arg);
    continue;
  }
  if (line == "copy") {
    cmdCopy(arg);
    continue;
  }
  if (line == "exit") {
    tsos.exit(0);
    continue;
  }

  // Unknown command: try to exec it directly. If arg is non-empty it
  // was the trailing whitespace + args; we don't yet pass args
  // through to children, so it's discarded.
  tsos.exec(line);
}
