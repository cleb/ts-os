// TS-DOS: a tiny MS-DOS-compatible kernel written in TypeScript.
//
// The bootloader (boot.asm) loads this kernel at 0000:1000 and stashes the
// boot drive number at byte 0x04FF before far-jumping here. From that point
// on, all DOS-like behavior — finding a COM file on FAT12, building the PSP,
// dispatching INT 20h / INT 21h, exec'ing a child process and returning to
// its parent — is implemented in TypeScript using small Perry primitives
// that expose what TypeScript cannot otherwise express: memory peek/poke,
// segment-aware far byte peek/poke, BIOS interrupt calls, IVT
// installation, BIOS disk reads, and the final far-jump to launch a program.
//
// The only assembly in this file is the two IRET trampolines for INT 20h /
// INT 21h plus three short context-switch blocks for boot-launch / exec /
// exit-to-parent. Those exist because TypeScript has no way to express
// "atomically switch SS:SP/DS/ES/CS:IP without touching kernel data in
// between". Everything else — the AH=00/01/02/08/09/4Bh/4Ch INT 21h services,
// FAT12 directory scan, PSP construction, IVT install — is real TypeScript.

// === Memory layout ===
// 0x0000 - 0x03FF : real-mode IVT
// 0x0400 - 0x04FE : BIOS data area
// 0x04FF          : boot drive byte (stashed by boot.asm before the far-jump)
// 0x0500 - 0x051F : ISR scratch (saved user registers including SS:SP)
// 0x0700 - 0x07FF : kernel scratch (exit code, parent-state save area, name)
// 0x0800 - 0x0FFF : kernel stack (grows down from 0x1000)
// 0x1000 - 0x7FFF : kernel image (TS-compiled binary) + Perry data slots
// 0x8000 - 0x9FFF : FAT12 root-directory buffer
// 0x2000:0x0000   : "current" user program PSP (the shell, COMMAND.COM)
// 0x2000:0x0100   : "current" user program code (.COM)
// 0x3000:0x0000   : child program PSP (spawned by COMMAND.COM via INT 21h AH=4Bh)
// 0x3000:0x0100   : child program code

const DRIVE_BYTE_ADDR = 0x04ff;

// Slots where the INT 21h asm trampoline stashes the user's registers so
// the TypeScript dispatcher can read/write them.
const USER_AX = 0x0500;
const USER_BX = 0x0502;
const USER_CX = 0x0504;
const USER_DX = 0x0506;
const USER_SI = 0x0508;
const USER_DI = 0x050a;
const USER_BP = 0x050c;
const USER_DS = 0x050e;
const USER_ES = 0x0510;
// SS:SP captured at the moment of INT 21h, with SP pointing at the IRET
// frame the CPU pushed on the user's stack (3 words: IP, CS, FLAGS).
const USER_SS = 0x0512;
const USER_SP = 0x0514;

const EXIT_CODE_ADDR = 0x0700;

// Caller-supplied Disk Transfer Area (DOS AH=1Ah/AH=4Eh/AH=4Fh). The
// kernel writes file metadata to whatever DTA the most recent AH=1Ah
// pointed at.
const DTA_SEG_ADDR = 0x0710;
const DTA_OFF_ADDR = 0x0712;
// Root-directory cursor used by AH=4Eh / AH=4Fh between calls.
const SEARCH_CURSOR_ADDR = 0x0714;

// When an INT 21h AH=4Bh handler launches a child process it copies the
// caller's saved SS/SP/DS/ES here. When the child later issues AH=4Ch we
// atomically restore these and IRET, landing the parent back on the
// instruction right after its `int 0x21`. PARENT_SS == 0 means "no parent
// process is waiting" — exit then halts the machine instead.
const PARENT_SS = 0x0720;
const PARENT_SP = 0x0722;
const PARENT_DS = 0x0724;
const PARENT_ES = 0x0726;

// FAT12 layout for a 1.44MB floppy with our boot sector.
const ROOT_LBA = 19;
const ROOT_BUF_SECTORS = 14;
const ROOT_BUF = 0x8000;
const DATA_LBA_MINUS_TWO = 31;

// Program load segment / offset (classic MS-DOS COM layout: PSP at :0000,
// program code at :0100, single 64K segment).
const SHELL_SEG = 0x2000;
const CHILD_SEG = 0x3000;
const PROG_OFF = 0x0100;

// 11-byte FAT 8.3 name buffer used both by boot (to find COMMAND.COM) and
// by the AH=4Bh handler (to find the child).
const NAME_ADDR = 0x0600;

// === BIOS wrappers ===

function serialInit(): void {
  x86OutB(0x03f9, 0x00);
  x86OutB(0x03fb, 0x80);
  x86OutB(0x03f8, 0x03);
  x86OutB(0x03f9, 0x00);
  x86OutB(0x03fb, 0x03);
  x86OutB(0x03fa, 0xc7);
  x86OutB(0x03fc, 0x0b);
}

function bdaPutChar(ch: number): void {
  x86OutB(0x03f8, ch & 0xff);
  x86Interrupt(0x10, 0x0e00 | (ch & 0xff), 0x0007, 0, 0, 0, 0);
}

function bdaGetKey(): number {
  // INT 16h AH=00h: blocks until key pressed; returns AH=scan, AL=ascii.
  return x86Interrupt(0x16, 0x0000, 0, 0, 0, 0, 0) & 0xff;
}

function putString(addr: number): void {
  let i = 0;
  while (i < 512) {
    const ch = x86PeekByte(addr + i);
    if (ch == 0) return;
    bdaPutChar(ch);
    i = i + 1;
  }
}

function putCr(): void {
  bdaPutChar(0x0d);
  bdaPutChar(0x0a);
}

function isSpace(ch: number): number {
  if (ch == 0x20) return 1;
  if (ch == 0x09) return 1;
  return 0;
}

// === FAT12 helpers ===

function readSector(lba: number, destSeg: number, destOff: number): void {
  const drive = x86PeekByte(DRIVE_BYTE_ADDR);
  // LBA -> CHS for a 1.44 MB FAT12 floppy (geometry: 2 heads, 18 sectors per
  // track, 80 cylinders). All real-mode INT 13h disk reads are expressed in
  // this 1-based sector / 0-based head / 0-based cylinder triple.
  const sec = (lba % 18) + 1;
  const headCyl = (lba / 18) | 0;
  const head = headCyl % 2;
  const cyl = (headCyl / 2) | 0;
  // INT 13h AH=02h, AL=sector-count, CH=cyl[7:0], CL=sec[5:0] | (cyl[9:8]<<6),
  // DH=head, DL=drive, ES:BX -> destination buffer.
  const ax = 0x0200 | 1;
  const cx = ((cyl & 0xff) << 8) | (sec & 0x3f);
  const dx = ((head & 0xff) << 8) | (drive & 0xff);
  x86Interrupt(0x13, ax, destOff, cx, dx, 0, 0, destSeg);
}

function readSectors(startLba: number, count: number, destSeg: number, destOff: number): void {
  let i = 0;
  while (i < count) {
    readSector(startLba + i, destSeg, destOff + i * 512);
    i = i + 1;
  }
}

function nameMatches(entryAddr: number, nameAddr: number): number {
  let i = 0;
  while (i < 11) {
    if (x86PeekByte(entryAddr + i) != x86PeekByte(nameAddr + i)) return 0;
    i = i + 1;
  }
  return 1;
}

// Returns the address of the 32-byte root-directory entry for the named file,
// or 0 if not found.
function findFile(rootAddr: number, nameAddr: number): number {
  let i = 0;
  while (i < 224) {
    const entry = rootAddr + i * 32;
    const first = x86PeekByte(entry);
    if (first == 0) return 0;
    if (first != 0xe5) {
      if (nameMatches(entry, nameAddr) != 0) return entry;
    }
    i = i + 1;
  }
  return 0;
}

// === Filename parsing ===
//
// Reads an ASCIIZ filename from `srcSeg:srcOff` (the user's DS:DX for
// AH=4Bh), uppercases it, and stores the 11-byte FAT 8.3 form at
// NAME_ADDR. Returns 1 on success, 0 if the input doesn't look like an 8.3
// name we can load (empty, stem too long, ext too long).

function upperByte(ch: number): number {
  if (ch >= 97) {
    if (ch <= 122) return ch - 32;
  }
  return ch;
}

function fillNameSpaces(): void {
  let i = 0;
  while (i < 11) {
    x86PokeByte(NAME_ADDR + i, 0x20);
    i = i + 1;
  }
}

function parseFatName(srcSeg: number, srcOff: number): number {
  fillNameSpaces();
  let s = 0;
  let stem = 0;
  let ext = 0;
  let sawDot = 0;
  while (1 != 0) {
    const ch = x86PeekFar(srcSeg, srcOff + s);
    if (ch == 0) break;
    if (isSpace(ch) != 0) break;
    if (ch == 0x2e) {
      if (sawDot != 0) return 0;
      sawDot = 1;
      s = s + 1;
      continue;
    }
    if (sawDot == 0) {
      if (stem >= 8) return 0;
      x86PokeByte(NAME_ADDR + stem, upperByte(ch));
      stem = stem + 1;
    } else {
      if (ext >= 3) return 0;
      x86PokeByte(NAME_ADDR + 8 + ext, upperByte(ch));
      ext = ext + 1;
    }
    s = s + 1;
  }
  if (stem == 0) return 0;
  if (sawDot == 0) {
    x86PokeByte(NAME_ADDR + 8, 0x43);  // C
    x86PokeByte(NAME_ADDR + 9, 0x4f);  // O
    x86PokeByte(NAME_ADDR + 10, 0x4d); // M
  }
  return 1;
}

// === PSP construction ===

function setupPsp(seg: number): void {
  // INT 20h opcode at offset 0 — the classic CP/M-style exit shortcut: a COM
  // program that simply `ret`s lands on this instruction and terminates.
  x86PokeFar(seg, 0x0000, 0xcd);
  x86PokeFar(seg, 0x0001, 0x20);
  // End-of-allocation pointer at offset 2 (single 64K segment for COMs).
  let i = 0;
  while (i < 2) {
    x86PokeFar(seg, 0x0002 + i, 0xff);
    i = i + 1;
  }
  // Command line length byte at offset 0x80 = 0 (no args passed).
  x86PokeFar(seg, 0x0080, 0);
  x86PokeFar(seg, 0x0081, 0x0d);
}

function tsosReadBufferedLine(): void {
  const ds = x86PeekWord(USER_DS);
  const dx = x86PeekWord(USER_DX);
  const max = x86PeekFar(ds, dx);
  let i = 0;
  while (i < max) {
    const ch = bdaGetKey();
    if (ch == 0x0d) {
      putCr();
      x86PokeFar(ds, dx + 1, i);
      x86PokeFar(ds, dx + 2 + i, 0x0d);
      return;
    }
    if (ch == 0x08) {
      if (i > 0) {
        i = i - 1;
        bdaPutChar(0x08);
        bdaPutChar(0x20);
        bdaPutChar(0x08);
      }
      continue;
    }
    if (ch < 0x20) continue;
    if (ch > 0x7e) continue;
    x86PokeFar(ds, dx + 2 + i, ch);
    bdaPutChar(ch);
    i = i + 1;
  }
  x86PokeFar(ds, dx + 1, i);
}

// === DOS write-to-handle (INT 21h AH=40h) ===
//
// BX = handle (1 = stdout, 2 = stderr), CX = byte count, DS:DX = buffer.
// We treat handle 1 or 2 as the console; the rest are unsupported because
// TS-DOS has no file system writes.
function dispatchWriteHandle(): void {
  const handle = x86PeekWord(USER_BX);
  const count = x86PeekWord(USER_CX);
  if (handle != 1) {
    if (handle != 2) {
      x86PokeWord(USER_AX, 0);
      return;
    }
  }
  const ds = x86PeekWord(USER_DS);
  const dx = x86PeekWord(USER_DX);
  let i = 0;
  while (i < count) {
    bdaPutChar(x86PeekFar(ds, dx + i));
    i = i + 1;
  }
  x86PokeWord(USER_AX, count);
}

// === DOS Set-DTA / FindFirst / FindNext (INT 21h AH=1Ah/4Eh/4Fh) ===
//
// Set-DTA just records the caller's DS:DX in kernel scratch. FindFirst
// resets the root-directory cursor and falls through to the common
// FindNext routine, which scans the root for the next live entry,
// writes the standard 0x15/0x16/0x18/0x1A/0x1E metadata into the DTA,
// and returns AX=0. When no more entries match, FindNext writes a NUL
// to DTA+0x1E (the filename slot) so callers can detect end-of-search
// by the empty name string, and returns AX=0x12 (DOS error
// "no more files").

function dispatchSetDta(): void {
  x86PokeWord(DTA_SEG_ADDR, x86PeekWord(USER_DS));
  x86PokeWord(DTA_OFF_ADDR, x86PeekWord(USER_DX));
}

function copyEntryToDta(entry: number): void {
  const dtaSeg = x86PeekWord(DTA_SEG_ADDR);
  const dtaOff = x86PeekWord(DTA_OFF_ADDR);
  // Attribute byte (entry+11 → DTA+0x15).
  x86PokeFar(dtaSeg, dtaOff + 0x15, x86PeekByte(entry + 11));
  // Time (entry+22..23 → DTA+0x16..17) and date (entry+24..25 → DTA+0x18..19).
  let k = 0;
  while (k < 4) {
    x86PokeFar(dtaSeg, dtaOff + 0x16 + k, x86PeekByte(entry + 22 + k));
    k = k + 1;
  }
  // 32-bit file size (entry+28..31 → DTA+0x1A..1D).
  k = 0;
  while (k < 4) {
    x86PokeFar(dtaSeg, dtaOff + 0x1a + k, x86PeekByte(entry + 28 + k));
    k = k + 1;
  }
  // ASCIIZ name in 8.3 form, trailing spaces trimmed.
  let dst = 0;
  let i = 0;
  while (i < 8) {
    const ch = x86PeekByte(entry + i);
    if (ch == 0x20) break;
    x86PokeFar(dtaSeg, dtaOff + 0x1e + dst, ch);
    dst = dst + 1;
    i = i + 1;
  }
  if (x86PeekByte(entry + 8) != 0x20) {
    x86PokeFar(dtaSeg, dtaOff + 0x1e + dst, 0x2e);
    dst = dst + 1;
    i = 0;
    while (i < 3) {
      const ch = x86PeekByte(entry + 8 + i);
      if (ch == 0x20) break;
      x86PokeFar(dtaSeg, dtaOff + 0x1e + dst, ch);
      dst = dst + 1;
      i = i + 1;
    }
  }
  x86PokeFar(dtaSeg, dtaOff + 0x1e + dst, 0);
}

function continueSearch(): void {
  let i = x86PeekWord(SEARCH_CURSOR_ADDR);
  while (i < 224) {
    const entry = ROOT_BUF + i * 32;
    const first = x86PeekByte(entry);
    if (first == 0) break;
    if (first != 0xe5) {
      const attr = x86PeekByte(entry + 11);
      const isVolume = attr & 0x08;
      if (isVolume == 0) {
        copyEntryToDta(entry);
        x86PokeWord(SEARCH_CURSOR_ADDR, i + 1);
        x86PokeWord(USER_AX, 0);
        return;
      }
    }
    i = i + 1;
  }
  // No (more) matches: empty filename + DOS error 0x12 ("no more files").
  const dtaSeg = x86PeekWord(DTA_SEG_ADDR);
  const dtaOff = x86PeekWord(DTA_OFF_ADDR);
  x86PokeFar(dtaSeg, dtaOff + 0x1e, 0);
  x86PokeWord(USER_AX, 0x12);
}

function dispatchFindFirst(): void {
  // Pattern at DS:DX is ignored — TS-DOS treats every call as "*.*".
  readSectors(ROOT_LBA, ROOT_BUF_SECTORS, 0, ROOT_BUF);
  x86PokeWord(SEARCH_CURSOR_ADDR, 0);
  continueSearch();
}

// === INT 21h dispatcher ===
//
// The asm IRET trampoline (below) stores all caller-visible registers
// (including SS:SP) into the USER_* slots, then calls dispatchInt21. The
// dispatcher reads inputs and writes outputs through x86PeekWord /
// x86PokeWord on those slots. Most services return normally and the
// trampoline reloads the (possibly edited) regs and IRETs. AH=4Bh and
// AH=4Ch never return through the trampoline — they switch CS:IP / SS:SP
// to a different process directly.

function dispatchInt21(): void {
  const ax = x86PeekWord(USER_AX);
  const ah = (ax >>> 8) & 0xff;
  if (ah == 0x4c) {
    terminateProgram(ax & 0xff);
    return;
  }
  if (ah == 0x00) {
    terminateProgram(0);
    return;
  }
  if (ah == 0x4b) {
    execChild();
    return;
  }
  if (ah == 0x0a) {
    tsosReadBufferedLine();
    return;
  }
  if (ah == 0x1a) {
    dispatchSetDta();
    return;
  }
  if (ah == 0x40) {
    dispatchWriteHandle();
    return;
  }
  if (ah == 0x4e) {
    dispatchFindFirst();
    return;
  }
  if (ah == 0x4f) {
    continueSearch();
    return;
  }
  if (ah == 0x02) {
    const dx = x86PeekWord(USER_DX);
    bdaPutChar(dx & 0xff);
    return;
  }
  if (ah == 0x09) {
    // Write $-terminated string at user's DS:DX.
    const ds = x86PeekWord(USER_DS);
    const dx = x86PeekWord(USER_DX);
    let i = 0;
    while (i < 4096) {
      const ch = x86PeekFar(ds, dx + i);
      if (ch == 0x24) return;
      bdaPutChar(ch);
      i = i + 1;
    }
    return;
  }
  if (ah == 0x01) {
    const ch = bdaGetKey();
    bdaPutChar(ch);
    x86PokeWord(USER_AX, (ax & 0xff00) | (ch & 0xff));
    return;
  }
  if (ah == 0x08) {
    const ch = bdaGetKey();
    x86PokeWord(USER_AX, (ax & 0xff00) | (ch & 0xff));
    return;
  }
  // Unsupported — print a complaint and terminate.
  putString(x86Cstr("\r\nUnsupported INT 21h service.\r\n"));
  terminateProgram(0xff);
}

function dispatchInt20(): void {
  terminateProgram(0);
}

// === Exec (INT 21h AH=4Bh) ===
//
// Parent calls with AL=0 (load-and-execute), DS:DX → ASCIIZ child filename,
// ES:BX → param block (ignored — we don't pass env/cmdline yet). We:
//   1. Snapshot parent's SS/SP/DS/ES into PARENT_*.
//   2. Parse the filename to 8.3 form in NAME_ADDR.
//   3. Re-read the FAT12 root, find the entry, load the child to
//      CHILD_SEG:PROG_OFF and build its PSP at CHILD_SEG:0.
//   4. Atomically switch SS to CHILD_SEG, SP to 0xFFFE, push CHILD_SEG and
//      PROG_OFF for retf, and jump.
// We never return through the INT 21h trampoline — control reaches the
// child's first instruction directly.

function snapshotParent(): void {
  x86PokeWord(PARENT_SS, x86PeekWord(USER_SS));
  x86PokeWord(PARENT_SP, x86PeekWord(USER_SP));
  x86PokeWord(PARENT_DS, x86PeekWord(USER_DS));
  x86PokeWord(PARENT_ES, x86PeekWord(USER_ES));
}

function launchChildFromName(): void {
  readSectors(ROOT_LBA, ROOT_BUF_SECTORS, 0, ROOT_BUF);
  const entry = findFile(ROOT_BUF, NAME_ADDR);
  if (entry == 0) {
    putString(x86Cstr("File not found.\r\n"));
    x86PokeWord(PARENT_SS, 0);
    return;
  }
  const sizeLo = x86PeekWord(entry + 28);
  const firstCluster = x86PeekWord(entry + 26);
  const numSectors = (sizeLo + 511) >>> 9;
  const lba = DATA_LBA_MINUS_TWO + firstCluster;
  readSectors(lba, numSectors, CHILD_SEG, PROG_OFF);
  setupPsp(CHILD_SEG);

  // Step 4: context switch into child. Same shape as the boot launcher
  // below, but jumping to CHILD_SEG instead of SHELL_SEG.
  x86Asm(`
    cli
    mov ax, 0x3000
    mov ds, ax
    mov es, ax
    mov ss, ax
    mov sp, 0xfffe
    push ax
    mov ax, 0x0100
    push ax
    sti
    retf
  `);
}

function execChild(): void {
  // Step 1: snapshot parent state.
  snapshotParent();

  // Step 2: parse ASCIIZ filename from DS:DX.
  const argDs = x86PeekWord(USER_DS);
  const argDx = x86PeekWord(USER_DX);
  if (parseFatName(argDs, argDx) == 0) {
    putString(x86Cstr("Bad child filename.\r\n"));
    // Restore: pretend no parent was saved so a follow-up AH=4Ch halts cleanly.
    x86PokeWord(PARENT_SS, 0);
    return;
  }

  // Step 3/4: load and launch.
  launchChildFromName();
}

// === Exit (INT 21h AH=4Ch) / INT 20h ===
//
// terminateProgram is called from both AH=4Ch and AH=00h (INT 21h) and from
// INT 20h. If a parent process is saved, atomically restore its
// SS/SP/DS/ES and IRET — the parent's IRET frame is still sitting at the
// top of its saved stack, so the CPU pops IP/CS/FLAGS and resumes the
// parent right after its `int 0x21` call. If no parent is saved we're the
// boot shell — print a goodbye and halt.

function terminateProgram(code: number): void {
  x86PokeByte(EXIT_CODE_ADDR, code & 0xff);
  if (x86PeekWord(PARENT_SS) != 0) {
    // Clear parent slot so a future nested exec works (and so the parent
    // itself, when it eventually exits, halts cleanly).
    x86Asm(`
      cli
      mov ax, [0x0724]
      mov bx, [0x0726]
      mov cx, [0x0720]
      mov dx, [0x0722]
      mov word ptr [0x0720], 0
      mov ss, cx
      mov sp, dx
      mov ds, ax
      mov es, bx
      xor ax, ax
      iret
    `);
    return;
  }
  putString(x86Cstr("\r\n[TS-DOS] shell terminated.\r\n"));
  halt();
}

// === Low-level kernel choreography ===

function installInterruptStub(intNo: number, stubOffset: number): void {
  // Real-mode IVT: 4 bytes per vector at 0000:(intNo*4) -> offset, then segment.
  // Our stubs live in the kernel segment (0), so the segment word is always 0.
  const vecOff = intNo * 4;
  x86PokeWord(vecOff, stubOffset);
  x86PokeWord(vecOff + 2, 0);
}

function halt(): void {
  // cli + a wait-for-interrupt loop. Because interrupts are disabled, only an
  // NMI can wake the CPU and we'll immediately re-enter hlt anyway.
  x86Cli();
  while (1 != 0) {
    x86Hlt();
  }
}

// === Asm IRET trampolines ===
//
// These plus the boot-launch block at the bottom of main are the only
// inline asm in the kernel. They cannot be written in TypeScript because:
//   1. The CPU enters them with the caller's segments + flags pushed, and
//      they must end with IRET (which TypeScript has no equivalent for).
//   2. They have to switch DS to the kernel's data segment (0) before
//      accessing kernel globals, then restore the caller's DS before IRET.
//
// They save the caller's regs (including SS:SP) to fixed addresses, call a
// TS dispatcher, then restore the regs from those addresses (the
// dispatcher may have edited them to return values to the caller). The
// dispatcher is called as a normal C-style near-call, so it can use the
// caller's stack freely.
//
// SS:SP are captured AFTER the trampoline's `push ds; push ax; pop ax;
// pop ax` dance — that's a net zero, so SP at that point is exactly the
// IRET-frame position (the 3 words FLAGS/CS/IP the CPU pushed).
// dispatchInt21 needs that for AH=4Bh, which copies it into PARENT_SP so
// the child's later AH=4Ch can IRET back to the parent.

x86Trampoline("__int20_stub", `
push ds
push ax
xor ax, ax
mov ds, ax
pop ax
mov [0x0500], ax
pop ax
mov [0x050e], ax
mov [0x0502], bx
mov [0x0504], cx
mov [0x0506], dx
mov [0x0508], si
mov [0x050a], di
mov [0x050c], bp
mov [0x0510], es
mov ax, ss
mov [0x0512], ax
mov ax, sp
mov [0x0514], ax
call __perry_fn_dispatchInt20
mov bx, [0x0502]
mov cx, [0x0504]
mov dx, [0x0506]
mov si, [0x0508]
mov di, [0x050a]
mov bp, [0x050c]
push word ptr [0x0500]
mov ax, [0x0510]
mov es, ax
mov ax, [0x050e]
mov ds, ax
pop ax
iret
`);

x86Trampoline("__int21_stub", `
push ds
push ax
xor ax, ax
mov ds, ax
pop ax
mov [0x0500], ax
pop ax
mov [0x050e], ax
mov [0x0502], bx
mov [0x0504], cx
mov [0x0506], dx
mov [0x0508], si
mov [0x050a], di
mov [0x050c], bp
mov [0x0510], es
mov ax, ss
mov [0x0512], ax
mov ax, sp
mov [0x0514], ax
call __perry_fn_dispatchInt21
mov bx, [0x0502]
mov cx, [0x0504]
mov dx, [0x0506]
mov si, [0x0508]
mov di, [0x050a]
mov bp, [0x050c]
push word ptr [0x0500]
mov ax, [0x0510]
mov es, ax
mov ax, [0x050e]
mov ds, ax
pop ax
iret
`);

// === Main entry ===
//
// boot.asm has already set DS=ES=SS=0, SP=0x7C00 and stashed the boot drive
// at 0x04FF. From here on it's regular TypeScript control flow.

// Make sure DS/ES point at the kernel (segment 0).
x86SetSegments(0);

// Install our INT 20h and INT 21h vectors. x86LabelOffset turns a compile-time
// asm label into a runtime number, so the IVT install itself is plain
// TypeScript memory pokes.
installInterruptStub(0x20, x86LabelOffset("__int20_stub"));
installInterruptStub(0x21, x86LabelOffset("__int21_stub"));

// No parent process is waiting for the boot shell.
x86PokeWord(PARENT_SS, 0);

serialInit();
putString(x86Cstr("TS-DOS TypeScript kernel: INT 20h/21h/4Bh/4Ch ready.\r\n"));

// Pre-populate the 11-byte FAT name "COMMAND COM" at NAME_ADDR so the
// FAT12 directory-scan loop can compare 11 bytes at a time without ever
// needing to materialize a string literal in registers.
x86PokeByte(NAME_ADDR + 0, 0x43);  // C
x86PokeByte(NAME_ADDR + 1, 0x4f);  // O
x86PokeByte(NAME_ADDR + 2, 0x4d);  // M
x86PokeByte(NAME_ADDR + 3, 0x4d);  // M
x86PokeByte(NAME_ADDR + 4, 0x41);  // A
x86PokeByte(NAME_ADDR + 5, 0x4e);  // N
x86PokeByte(NAME_ADDR + 6, 0x44);  // D
x86PokeByte(NAME_ADDR + 7, 0x20);  // ' '
x86PokeByte(NAME_ADDR + 8, 0x43);  // C
x86PokeByte(NAME_ADDR + 9, 0x4f);  // O
x86PokeByte(NAME_ADDR + 10, 0x4d); // M

// Read the FAT12 root directory into our buffer.
readSectors(ROOT_LBA, ROOT_BUF_SECTORS, 0, ROOT_BUF);

const entry = findFile(ROOT_BUF, NAME_ADDR);
if (entry == 0) {
  putString(x86Cstr("COMMAND.COM not found on disk.\r\n"));
  halt();
}

// Read file size (4 bytes little-endian at offset 28) and first cluster (16-bit
// at offset 26).
const sizeLo = x86PeekWord(entry + 28);
const firstCluster = x86PeekWord(entry + 26);
const numSectors = (sizeLo + 511) >>> 9;
const lba = DATA_LBA_MINUS_TWO + firstCluster;
readSectors(lba, numSectors, SHELL_SEG, PROG_OFF);

setupPsp(SHELL_SEG);

putString(x86Cstr("Launching COMMAND.COM.\r\n"));

// Atomic context switch into the shell. This is one of two places where
// switching DS makes every subsequent TS local-variable access (DS-relative)
// read the wrong memory, so the whole cli/segments/SS:SP/sti/retf sequence
// has to happen inside a single inline-asm block that touches no kernel
// data between `mov ds` and `retf`. SHELL_SEG / PROG_OFF are hardcoded
// here (0x2000 / 0x0100); they must stay in sync with the consts above.
x86Asm(`
  cli
  mov ax, 0x2000
  mov ds, ax
  mov es, ax
  mov ss, ax
  mov sp, 0xfffe
  push ax
  mov ax, 0x0100
  push ax
  sti
  retf
`);
