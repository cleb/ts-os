// COMMAND.COM — TS-DOS's user-mode shell.
//
// Pure TypeScript on top of standard MS-DOS-style INT 21h services
// (AH=02h, 09h, 0Ah, 1Ah, 40h, 4Bh, 4Ch, 4Eh, 4Fh) exposed by the
// `ts-os` module. There is no custom kernel call for `dir`, `cd`, or
// command parsing — the shell loops over FindFirst/FindNext, formats
// output with standard write/printChar, and uses normal TypeScript
// string comparisons against the line that `readLine` returns.

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

function isCdLine(line: string): number {
  if (line == "cd") return 1;
  if (line == "cd ") return 1;
  if (line == "cd \\") return 1;
  if (line == "cd /") return 1;
  return 0;
}

tsos.print("TS-DOS COMMAND.COM v0.2 (TypeScript shell)\r\n");
tsos.print("Built-ins: dir, cd, exit. Anything else is exec'd as A:\\<name>.COM.\r\n\r\n");

while (1 != 0) {
  tsos.print("A:\\>");
  const line = tsos.readLine();
  if (line == "") continue;

  if (line == "dir") {
    tsos.print(" Directory of A:\\\r\n\r\n");
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
    continue;
  }

  if (isCdLine(line) != 0) {
    // TS-DOS has no subdirectories: every cd is to the root.
    tsos.print("A:\\\r\n");
    continue;
  }

  if (line == "exit") {
    tsos.exit(0);
    continue;
  }

  tsos.exec(line);
}
