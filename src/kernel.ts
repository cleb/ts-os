// TS-DOS: a tiny MS-DOS-compatible kernel written in TypeScript.
//
// The bootloader (boot.asm) loads this kernel at 0000:1000 and stashes the
// boot drive number at byte 0x04FF before far-jumping here. From that point
// on, all DOS-like behavior - finding a COM file on FAT12, building the PSP,
// dispatching INT 20h / INT 21h - is implemented in TypeScript using small
// Perry primitives that expose what TypeScript cannot otherwise express:
// memory peek/poke, segment-aware far peek/poke, BIOS interrupt calls, IVT
// installation, BIOS disk reads, and the final far-jump to launch the user
// program.
//
// The only assembly in this file is the two IRET trampolines for INT 20h /
// INT 21h. Those exist because TypeScript has no way to express "save the
// caller's regs, switch DS to the kernel, call a TS dispatcher, restore the
// regs (possibly modified by the dispatcher), then IRET back to the caller."
// Everything else, including the AH=00/01/02/08/09/4Ch INT 21h services, is
// real TypeScript.

// === Memory layout ===
// 0x0000 - 0x03FF : real-mode IVT
// 0x0400 - 0x04FE : BIOS data area
// 0x04FF          : boot drive byte (stashed by boot.asm before the far-jump)
// 0x0500 - 0x06FF : ISR scratch (saved user registers, name patterns)
// 0x0700 - 0x07FF : kernel scratch (exit code, flags)
// 0x0800 - 0x0FFF : kernel stack (grows down from 0x1000)
// 0x1000 - 0x7FFF : kernel image (TS-compiled binary) + Perry data slots
// 0x8000 - 0x9FFF : FAT12 root-directory buffer
// 0x2000:0x0000   : user program PSP
// 0x2000:0x0100   : user program code (.COM)
const DRIVE_BYTE_ADDR = 0x04ff;

// Slots where the INT 21h asm trampoline stashes the user's registers so the
// TypeScript dispatcher can read/write them.
const USER_AX = 0x0500;
const USER_BX = 0x0502;
const USER_CX = 0x0504;
const USER_DX = 0x0506;
const USER_SI = 0x0508;
const USER_DI = 0x050a;
const USER_BP = 0x050c;
const USER_DS = 0x050e;
const USER_ES = 0x0510;

const EXIT_CODE_ADDR = 0x0700;

// FAT12 layout for a 1.44MB floppy with our boot sector.
const ROOT_LBA = 19;
const ROOT_BUF_SECTORS = 14;
const ROOT_BUF = 0x8000;
const DATA_LBA_MINUS_TWO = 31;

// Program load segment / offset (classic MS-DOS COM layout: PSP at :0000,
// program code at :0100, single 64K segment).
const PROG_SEG = 0x2000;
const PROG_OFF = 0x0100;

// Fixed scratch addresses for poked-in byte patterns the kernel needs.
const HELLO_NAME_ADDR = 0x0600;

// === BIOS wrappers ===

function bdaPutChar(ch: number): void {
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

// === PSP construction ===

function setupPsp(seg: number): void {
  // INT 20h opcode at offset 0 - the classic CP/M-style exit shortcut: a COM
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

// === INT 21h dispatcher ===
//
// The asm IRET trampoline (below) stores all caller-visible registers into
// the USER_* slots, calls dispatchInt21, then reloads them. So the dispatcher
// reads inputs and writes outputs through x86PeekWord / x86PokeWord on those
// slots.

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
  // Unsupported - print a complaint and terminate.
  putString(x86Cstr("\r\nUnsupported INT 21h service.\r\n"));
  terminateProgram(0xff);
}

function dispatchInt20(): void {
  terminateProgram(0);
}

function terminateProgram(code: number): void {
  x86PokeByte(EXIT_CODE_ADDR, code & 0xff);
  putString(x86Cstr("\r\n[TS-DOS] program terminated.\r\n"));
  halt();
}

// === Low-level kernel choreography ===
//
// These wrap the narrow x86 primitives so the boot/main code stays readable.

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

// Launching a user program is a primitive (x86LaunchProgram) rather than a
// TypeScript wrapper: as soon as DS changes to the user segment, every
// kernel local-variable access reads the wrong memory. The cli/segments/
// SS:SP/sti/retf sequence has to be atomic, so we let the compiler emit
// it as a single primitive.

// === Asm IRET trampolines ===
//
// These are the only inline asm in the kernel. They cannot be written in
// TypeScript because:
//   1. The CPU enters them with the caller's segments + flags pushed, and
//      they must end with IRET (which TypeScript has no equivalent for).
//   2. They have to switch DS to the kernel's data segment (0) before
//      accessing kernel globals, then restore the caller's DS before IRET.
//
// They save the caller's regs to fixed addresses, call a TS dispatcher, then
// restore the regs from those addresses (the dispatcher may have edited them
// to return values to the caller). The dispatcher is called as a normal C-style
// near-call, so it can use the caller's stack freely. x86Trampoline emits these
// in a dedicated section after the init code and TS functions, so they're only
// ever reached via INT (not by fallthrough from init).

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
call __perry_fn_dispatchInt20
mov bx, [0x0502]
mov cx, [0x0504]
mov dx, [0x0506]
mov si, [0x0508]
mov di, [0x050a]
mov bp, [0x050c]
mov ax, [0x0510]
mov es, ax
mov ax, [0x050e]
mov ds, ax
mov ax, [0x0500]
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
call __perry_fn_dispatchInt21
mov bx, [0x0502]
mov cx, [0x0504]
mov dx, [0x0506]
mov si, [0x0508]
mov di, [0x050a]
mov bp, [0x050c]
mov ax, [0x0510]
mov es, ax
mov ax, [0x050e]
mov ds, ax
mov ax, [0x0500]
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

putString(x86Cstr("TS-DOS TypeScript kernel: INT 20h/21h ready.\r\n"));

// Pre-populate the 11-byte FAT name "HELLO   COM" at HELLO_NAME_ADDR so the
// FAT12 directory-scan loop can compare 11 bytes at a time without ever
// needing to materialize a string literal in registers.
x86PokeByte(HELLO_NAME_ADDR + 0, 0x48); // H
x86PokeByte(HELLO_NAME_ADDR + 1, 0x45); // E
x86PokeByte(HELLO_NAME_ADDR + 2, 0x4c); // L
x86PokeByte(HELLO_NAME_ADDR + 3, 0x4c); // L
x86PokeByte(HELLO_NAME_ADDR + 4, 0x4f); // O
x86PokeByte(HELLO_NAME_ADDR + 5, 0x20); // ' '
x86PokeByte(HELLO_NAME_ADDR + 6, 0x20);
x86PokeByte(HELLO_NAME_ADDR + 7, 0x20);
x86PokeByte(HELLO_NAME_ADDR + 8, 0x43); // C
x86PokeByte(HELLO_NAME_ADDR + 9, 0x4f); // O
x86PokeByte(HELLO_NAME_ADDR + 10, 0x4d); // M

// Read the FAT12 root directory into our buffer.
readSectors(ROOT_LBA, ROOT_BUF_SECTORS, 0, ROOT_BUF);

const entry = findFile(ROOT_BUF, HELLO_NAME_ADDR);
if (entry == 0) {
  putString(x86Cstr("HELLO.COM not found on disk.\r\n"));
  halt();
}

// Read file size (4 bytes little-endian at offset 28) and first cluster (16-bit
// at offset 26).
const sizeLo = x86PeekWord(entry + 28);
const firstCluster = x86PeekWord(entry + 26);
const numSectors = (sizeLo + 511) >>> 9;
const lba = DATA_LBA_MINUS_TWO + firstCluster;
readSectors(lba, numSectors, PROG_SEG, PROG_OFF);

setupPsp(PROG_SEG);

putString(x86Cstr("Launching HELLO.COM.\r\n"));

x86LaunchProgram(PROG_SEG, PROG_OFF);
