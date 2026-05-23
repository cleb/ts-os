// TS-DOS: a tiny MS-DOS-compatible kernel written in TypeScript.
//
// The bootloader (boot.asm) loads this kernel at 0000:1000 and stashes the
// boot drive number at byte 0x04FF before far-jumping here. From that point
// on, all DOS-like behavior — finding a COM file on FAT12, building the PSP,
// dispatching INT 20h / INT 21h, exec'ing a child process and returning to
// its parent — is implemented in TypeScript using small Perry primitives
// (from the `x86bin` module) that expose what TypeScript cannot otherwise
// express: memory peek/poke, segment-aware far byte peek/poke, BIOS
// interrupt calls, IVT installation, BIOS disk reads, and the final
// far-jump to launch a program. The same module is what COMMAND.COM and
// other user-mode programs use indirectly via the `ts-os` syscall module.
//
// The only assembly in this file is the two IRET trampolines for INT 20h /
// INT 21h plus three short context-switch blocks for boot-launch / exec /
// exit-to-parent. Those exist because TypeScript has no way to express
// "atomically switch SS:SP/DS/ES/CS:IP without touching kernel data in
// between". Everything else — the AH=00/01/02/08/09/4Bh/4Ch INT 21h services,
// FAT12 directory scan, PSP construction, IVT install — is real TypeScript.

import * as x86bin from "x86bin";

// === Memory layout ===
// 0x0000 - 0x03FF : real-mode IVT
// 0x0400 - 0x04FE : BIOS data area
// 0x04FF          : boot drive byte (stashed by boot.asm before the far-jump)
// 0x0500 - 0x051F : ISR scratch (saved user registers including SS:SP)
// 0x0700 - 0x07FF : kernel scratch (exit code, parent-state save, DTA ptr,
//                   search cursor)
// 0x0800 - 0x0FFF : kernel stack (grows down from 0x1000)
// 0x1000 - 0x7FFF : kernel image (TS-compiled binary) + Perry data slots
// 0x8000 - 0x9BFF : current-directory cache (14 sectors = 7168 bytes)
// 0xA000 - 0xB1FF : FAT cache (9 sectors = 4608 bytes)
// 0xB200 - 0xB3FF : directory-scan sector buffer
// 0xB400 - 0xB5FF : file-I/O sector buffer
// 0xB600 - 0xB6FF : file-handle table + CWD path + assorted scratch
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
const FAT_LBA = 1;
const FAT2_LBA = 10;
const FAT_SECTORS = 9;
const ROOT_LBA = 19;
const ROOT_BUF_SECTORS = 14;
const DATA_LBA_MINUS_TWO = 31;

// Cached copies + I/O buffers (kernel segment 0).
const DIR_CACHE_BUF = 0x8000;
const FAT_BUF = 0xa000;
const DIR_SCAN_BUF = 0xb200;
const FILE_IO_BUF = 0xb400;

// File-handle table (4 handles × 16 bytes). User-visible handle numbers
// start at 3 (handles 0–2 are reserved for stdin/stdout/stderr).
const HANDLE_TABLE = 0xb600;
const HANDLE_COUNT = 4;
const HANDLE_SIZE = 16;
const FIRST_HANDLE = 3;

// CWD path string (ASCIIZ, max 64 chars, no leading backslash, no drive
// letter — matches the AH=47h return value contract).
const CURRENT_PATH = 0xb650;
const CURRENT_PATH_MAX = 64;
// Cluster number of the directory we treat as cwd. 0 == root dir.
const CURRENT_DIR_CLUSTER = 0xb6a0;

// FAT caching state.
const FAT_LOADED = 0xb6a2;
const FAT_DIRTY = 0xb6a3;

// findEntryByName / findFreeEntry communicate their match position to
// the caller via these slots (so callers can read and rewrite the
// 32-byte dir entry still sitting in DIR_SCAN_BUF).
const FOUND_LBA = 0xb6a4;
const FOUND_INDEX = 0xb6a6;
// walkPath result.
const RESULT_DIR_CLUSTER = 0xb6a8;

// Component scratch used by path parsing (uppercased ASCIIZ, up to 15
// chars plus NUL — long enough for an 8.3 name and "..").
const COMP_BUF = 0xb6b0;
const COMP_BUF_MAX = 16;

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
  x86bin.outB(0x03f9, 0x00);
  x86bin.outB(0x03fb, 0x80);
  x86bin.outB(0x03f8, 0x03);
  x86bin.outB(0x03f9, 0x00);
  x86bin.outB(0x03fb, 0x03);
  x86bin.outB(0x03fa, 0xc7);
  x86bin.outB(0x03fc, 0x0b);
}

function bdaPutChar(ch: number): void {
  x86bin.outB(0x03f8, ch & 0xff);
  x86bin.interrupt(0x10, 0x0e00 | (ch & 0xff), 0x0007, 0, 0, 0, 0);
}

function bdaGetKey(): number {
  // INT 16h AH=00h: blocks until key pressed; returns AH=scan, AL=ascii.
  return x86bin.interrupt(0x16, 0x0000, 0, 0, 0, 0, 0) & 0xff;
}

function putString(addr: number): void {
  let i = 0;
  while (i < 512) {
    const ch = x86bin.peekByte(addr + i);
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
  const drive = x86bin.peekByte(DRIVE_BYTE_ADDR);
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
  x86bin.interrupt(0x13, ax, destOff, cx, dx, 0, 0, destSeg);
}

function readSectors(startLba: number, count: number, destSeg: number, destOff: number): void {
  let i = 0;
  while (i < count) {
    readSector(startLba + i, destSeg, destOff + i * 512);
    i = i + 1;
  }
}

function writeSector(lba: number, srcSeg: number, srcOff: number): void {
  const drive = x86bin.peekByte(DRIVE_BYTE_ADDR);
  const sec = (lba % 18) + 1;
  const headCyl = (lba / 18) | 0;
  const head = headCyl % 2;
  const cyl = (headCyl / 2) | 0;
  // INT 13h AH=03h: write sectors. Same packing as the read path.
  const ax = 0x0300 | 1;
  const cx = ((cyl & 0xff) << 8) | (sec & 0x3f);
  const dx = ((head & 0xff) << 8) | (drive & 0xff);
  x86bin.interrupt(0x13, ax, srcOff, cx, dx, 0, 0, srcSeg);
}

// === FAT cache ===
//
// Lazy-loaded on first use; flushed back to BOTH FAT copies on
// saveFat() so a power-loss leaves the disk consistent enough for
// real DOS to read.

function loadFat(): void {
  if (x86bin.peekByte(FAT_LOADED) != 0) return;
  readSectors(FAT_LBA, FAT_SECTORS, 0, FAT_BUF);
  x86bin.pokeByte(FAT_LOADED, 1);
  x86bin.pokeByte(FAT_DIRTY, 0);
}

function saveFat(): void {
  if (x86bin.peekByte(FAT_DIRTY) == 0) return;
  let i = 0;
  while (i < FAT_SECTORS) {
    writeSector(FAT_LBA + i, 0, FAT_BUF + i * 512);
    writeSector(FAT2_LBA + i, 0, FAT_BUF + i * 512);
    i = i + 1;
  }
  x86bin.pokeByte(FAT_DIRTY, 0);
}

function readFat(cluster: number): number {
  // FAT12 packs 12-bit entries: byte offset = cluster + cluster/2.
  const off = cluster + (cluster >>> 1);
  const lo = x86bin.peekByte(FAT_BUF + off);
  const hi = x86bin.peekByte(FAT_BUF + off + 1);
  const raw = lo | (hi << 8);
  if ((cluster & 1) != 0) return (raw >>> 4) & 0xfff;
  return raw & 0xfff;
}

function writeFatEntry(cluster: number, value: number): void {
  const off = cluster + (cluster >>> 1);
  const lo = x86bin.peekByte(FAT_BUF + off);
  const hi = x86bin.peekByte(FAT_BUF + off + 1);
  if ((cluster & 1) != 0) {
    x86bin.pokeByte(FAT_BUF + off, (lo & 0x0f) | ((value << 4) & 0xf0));
    x86bin.pokeByte(FAT_BUF + off + 1, (value >>> 4) & 0xff);
  } else {
    x86bin.pokeByte(FAT_BUF + off, value & 0xff);
    x86bin.pokeByte(FAT_BUF + off + 1, (hi & 0xf0) | ((value >>> 8) & 0x0f));
  }
  x86bin.pokeByte(FAT_DIRTY, 1);
}

function allocCluster(): number {
  loadFat();
  let c = 2;
  while (c < 2849) {
    if (readFat(c) == 0) {
      writeFatEntry(c, 0xfff);
      return c;
    }
    c = c + 1;
  }
  return 0;
}

// === Directory iteration ===
//
// dirSectorLba(dirCluster, sectorIndex) returns the absolute LBA of
// the Nth 512-byte sector of the named directory. Root (cluster 0)
// occupies the fixed root-dir area; everything else is a cluster
// chain in the data area, with one sector per cluster on this floppy.

function dirSectorLba(dirCluster: number, sectorIndex: number): number {
  if (dirCluster == 0) {
    if (sectorIndex >= ROOT_BUF_SECTORS) return 0;
    return ROOT_LBA + sectorIndex;
  }
  loadFat();
  let cluster = dirCluster;
  let i = 0;
  while (i < sectorIndex) {
    cluster = readFat(cluster);
    if (cluster >= 0xff8) return 0;
    i = i + 1;
  }
  return DATA_LBA_MINUS_TWO + cluster;
}

function dirSectorCount(dirCluster: number): number {
  if (dirCluster == 0) return ROOT_BUF_SECTORS;
  loadFat();
  let cluster = dirCluster;
  let n = 1;
  while (n < 32) {
    const next = readFat(cluster);
    if (next >= 0xff8) break;
    cluster = next;
    n = n + 1;
  }
  return n;
}

// Walks the directory looking for an entry whose 11-byte name matches
// NAME_ADDR. On success returns 1, writes the containing sector's LBA
// to FOUND_LBA and the in-sector entry index (0..15) to FOUND_INDEX,
// and leaves that sector in DIR_SCAN_BUF so callers can either read
// more fields or rewrite the entry. On miss returns 0.
function findEntryByName(dirCluster: number, nameAddr: number): number {
  const count = dirSectorCount(dirCluster);
  let s = 0;
  while (s < count) {
    const lba = dirSectorLba(dirCluster, s);
    if (lba == 0) return 0;
    readSector(lba, 0, DIR_SCAN_BUF);
    let i = 0;
    while (i < 16) {
      const entry = DIR_SCAN_BUF + i * 32;
      const first = x86bin.peekByte(entry);
      if (first == 0) return 0;
      if (first != 0xe5) {
        if (nameMatches(entry, nameAddr) != 0) {
          x86bin.pokeWord(FOUND_LBA, lba);
          x86bin.pokeWord(FOUND_INDEX, i);
          return 1;
        }
      }
      i = i + 1;
    }
    s = s + 1;
  }
  return 0;
}

// Like findEntryByName, but returns the first unused slot (first byte
// 0x00 = never used or 0xE5 = deleted). The containing sector is left
// in DIR_SCAN_BUF so the caller can fill the entry and write back.
function findFreeEntry(dirCluster: number): number {
  const count = dirSectorCount(dirCluster);
  let s = 0;
  while (s < count) {
    const lba = dirSectorLba(dirCluster, s);
    if (lba == 0) return 0;
    readSector(lba, 0, DIR_SCAN_BUF);
    let i = 0;
    while (i < 16) {
      const entry = DIR_SCAN_BUF + i * 32;
      const first = x86bin.peekByte(entry);
      if (first == 0) {
        x86bin.pokeWord(FOUND_LBA, lba);
        x86bin.pokeWord(FOUND_INDEX, i);
        return 1;
      }
      if (first == 0xe5) {
        x86bin.pokeWord(FOUND_LBA, lba);
        x86bin.pokeWord(FOUND_INDEX, i);
        return 1;
      }
      i = i + 1;
    }
    s = s + 1;
  }
  return 0;
}

// Caches the current directory's sectors in DIR_CACHE_BUF so the
// AH=4Eh/AH=4Fh enumeration loop can use the existing entry-index
// cursor regardless of whether the cwd is root or a subdirectory.
function loadCurrentDir(): void {
  const dir = x86bin.peekWord(CURRENT_DIR_CLUSTER);
  if (dir == 0) {
    readSectors(ROOT_LBA, ROOT_BUF_SECTORS, 0, DIR_CACHE_BUF);
    return;
  }
  loadFat();
  let cluster = dir;
  let i = 0;
  while (i < ROOT_BUF_SECTORS) {
    if (cluster >= 0xff8) break;
    readSector(DATA_LBA_MINUS_TWO + cluster, 0, DIR_CACHE_BUF + i * 512);
    cluster = readFat(cluster);
    i = i + 1;
  }
  // Sentinel so continueSearch stops at end of chain.
  if (i < ROOT_BUF_SECTORS) {
    x86bin.pokeByte(DIR_CACHE_BUF + i * 512, 0);
  }
}

// === Path parsing ===

function isPathSep(ch: number): number {
  if (ch == 0x5c) return 1;
  if (ch == 0x2f) return 1;
  return 0;
}

// Read one path component from `srcSeg:srcOff` starting at `pos` into
// COMP_BUF as uppercased ASCIIZ. Returns the new offset, positioned
// at the trailing separator (or the terminating NUL).
function readPathComponent(srcSeg: number, srcOff: number, pos: number): number {
  let i = 0;
  while (i + 1 < COMP_BUF_MAX) {
    const ch = x86bin.peekFar(srcSeg, srcOff + pos);
    if (ch == 0) break;
    if (isPathSep(ch) != 0) break;
    x86bin.pokeByte(COMP_BUF + i, upperByte(ch));
    pos = pos + 1;
    i = i + 1;
  }
  x86bin.pokeByte(COMP_BUF + i, 0);
  return pos;
}

function compIsDot(): number {
  if (x86bin.peekByte(COMP_BUF) != 0x2e) return 0;
  if (x86bin.peekByte(COMP_BUF + 1) != 0) return 0;
  return 1;
}

function compIsDotDot(): number {
  if (x86bin.peekByte(COMP_BUF) != 0x2e) return 0;
  if (x86bin.peekByte(COMP_BUF + 1) != 0x2e) return 0;
  if (x86bin.peekByte(COMP_BUF + 2) != 0) return 0;
  return 1;
}

// Convert COMP_BUF (uppercased "STEM[.EXT]") into the 11-byte FAT 8.3
// form at NAME_ADDR. Returns 1 on success, 0 if the component is
// empty or has a stem/ext that's too long.
function compToFatName(): number {
  fillNameSpaces();
  let s = 0;
  let stem = 0;
  let ext = 0;
  let sawDot = 0;
  while (1 != 0) {
    const ch = x86bin.peekByte(COMP_BUF + s);
    if (ch == 0) break;
    if (ch == 0x2e) {
      if (sawDot != 0) return 0;
      sawDot = 1;
      s = s + 1;
      continue;
    }
    if (sawDot == 0) {
      if (stem >= 8) return 0;
      x86bin.pokeByte(NAME_ADDR + stem, ch);
      stem = stem + 1;
    } else {
      if (ext >= 3) return 0;
      x86bin.pokeByte(NAME_ADDR + 8 + ext, ch);
      ext = ext + 1;
    }
    s = s + 1;
  }
  if (stem == 0) return 0;
  return 1;
}

// === CWD path string maintenance ===
//
// CURRENT_PATH holds the AH=47h-style relative path (no drive letter,
// no leading backslash). Mutated by pathAppend/pathPop as the user
// chdirs into and out of subdirectories.

function pathLen(): number {
  let i = 0;
  while (i < CURRENT_PATH_MAX) {
    if (x86bin.peekByte(CURRENT_PATH + i) == 0) return i;
    i = i + 1;
  }
  return CURRENT_PATH_MAX;
}

function pathReset(): void {
  x86bin.pokeByte(CURRENT_PATH, 0);
}

function pathPopComponent(): void {
  let len = pathLen();
  if (len == 0) return;
  // Trim trailing chars until (and including) the previous backslash.
  while (len > 0) {
    len = len - 1;
    const ch = x86bin.peekByte(CURRENT_PATH + len);
    if (ch == 0x5c) {
      x86bin.pokeByte(CURRENT_PATH + len, 0);
      return;
    }
  }
  pathReset();
}

// Append a component already sitting in COMP_BUF (uppercased ASCIIZ)
// to CURRENT_PATH, inserting a separator if needed. Truncates rather
// than overflowing the 64-byte buffer.
function pathAppendComp(): void {
  let len = pathLen();
  if (len > 0) {
    if (len + 1 >= CURRENT_PATH_MAX) return;
    x86bin.pokeByte(CURRENT_PATH + len, 0x5c);
    len = len + 1;
  }
  let i = 0;
  while (1 != 0) {
    const ch = x86bin.peekByte(COMP_BUF + i);
    if (ch == 0) break;
    if (len + 1 >= CURRENT_PATH_MAX) break;
    x86bin.pokeByte(CURRENT_PATH + len, ch);
    len = len + 1;
    i = i + 1;
  }
  x86bin.pokeByte(CURRENT_PATH + len, 0);
}

// === Path resolution ===
//
// walkPath traverses `srcSeg:srcOff` (ASCIIZ DOS path) one component
// at a time, navigating into subdirectories via the FAT chain.
//
//   updatePath != 0 : the caller is implementing chdir; we mirror the
//                     navigation into CURRENT_PATH (so getCwd reflects
//                     the new dir on success).
//   lastIsLeaf != 0 : stop one component short and leave the trailing
//                     8.3 name in NAME_ADDR. Used by open/create/
//                     mkdir, which need to act on the leaf name in
//                     its parent directory.
//
// Returns 0 on success (writes the resulting directory cluster to
// RESULT_DIR_CLUSTER), 2 on "not found", 3 on bad path syntax.

function walkPath(srcSeg: number, srcOff: number, lastIsLeaf: number, updatePath: number): number {
  let dir = x86bin.peekWord(CURRENT_DIR_CLUSTER);
  let pos = 0;
  // Snapshot CURRENT_PATH so we can roll back on failure when updatePath.
  if (updatePath != 0) {
    if (isPathSep(x86bin.peekFar(srcSeg, srcOff)) != 0) {
      // Caller asked for an absolute path: reset.
      pathReset();
    }
  }
  if (isPathSep(x86bin.peekFar(srcSeg, srcOff)) != 0) {
    dir = 0;
    pos = 1;
  }
  while (1 != 0) {
    while (isPathSep(x86bin.peekFar(srcSeg, srcOff + pos)) != 0) pos = pos + 1;
    if (x86bin.peekFar(srcSeg, srcOff + pos) == 0) {
      if (lastIsLeaf != 0) return 3;
      x86bin.pokeWord(RESULT_DIR_CLUSTER, dir);
      return 0;
    }
    pos = readPathComponent(srcSeg, srcOff, pos);
    let p2 = pos;
    while (isPathSep(x86bin.peekFar(srcSeg, srcOff + p2)) != 0) p2 = p2 + 1;
    let isLast = 0;
    if (x86bin.peekFar(srcSeg, srcOff + p2) == 0) isLast = 1;
    if (lastIsLeaf != 0) {
      if (isLast != 0) {
        if (compToFatName() == 0) return 3;
        x86bin.pokeWord(RESULT_DIR_CLUSTER, dir);
        return 0;
      }
    }
    if (compIsDot() != 0) {
      pos = p2;
      continue;
    }
    if (compIsDotDot() != 0) {
      if (dir != 0) {
        fillNameSpaces();
        x86bin.pokeByte(NAME_ADDR + 0, 0x2e);
        x86bin.pokeByte(NAME_ADDR + 1, 0x2e);
        if (findEntryByName(dir, NAME_ADDR) == 0) return 2;
        const idx = x86bin.peekWord(FOUND_INDEX);
        const entry = DIR_SCAN_BUF + idx * 32;
        dir = x86bin.peekWord(entry + 26);
      }
      if (updatePath != 0) pathPopComponent();
      pos = p2;
      continue;
    }
    if (compToFatName() == 0) return 3;
    if (findEntryByName(dir, NAME_ADDR) == 0) return 2;
    const idx = x86bin.peekWord(FOUND_INDEX);
    const entry = DIR_SCAN_BUF + idx * 32;
    const attr = x86bin.peekByte(entry + 11);
    if ((attr & 0x10) == 0) return 2;
    dir = x86bin.peekWord(entry + 26);
    if (updatePath != 0) pathAppendComp();
    pos = p2;
  }
  return 3;
}

// === MKDIR / CHDIR / GETCWD ===

function dispatchMakeDir(): void {
  const ds = x86bin.peekWord(USER_DS);
  const dx = x86bin.peekWord(USER_DX);
  loadFat();
  const err = walkPath(ds, dx, 1, 0);
  if (err != 0) {
    x86bin.pokeWord(USER_AX, 3);
    return;
  }
  const parent = x86bin.peekWord(RESULT_DIR_CLUSTER);
  if (findEntryByName(parent, NAME_ADDR) != 0) {
    x86bin.pokeWord(USER_AX, 5);
    return;
  }
  if (findFreeEntry(parent) == 0) {
    x86bin.pokeWord(USER_AX, 3);
    return;
  }
  const newCluster = allocCluster();
  if (newCluster == 0) {
    x86bin.pokeWord(USER_AX, 3);
    return;
  }
  // Write the parent's new entry: copy NAME_ADDR into slot, set
  // attribute=0x10 (directory), zero metadata, store first_cluster.
  const dirLba = x86bin.peekWord(FOUND_LBA);
  const dirIdx = x86bin.peekWord(FOUND_INDEX);
  const entry = DIR_SCAN_BUF + dirIdx * 32;
  let i = 0;
  while (i < 11) {
    x86bin.pokeByte(entry + i, x86bin.peekByte(NAME_ADDR + i));
    i = i + 1;
  }
  i = 11;
  while (i < 32) {
    x86bin.pokeByte(entry + i, 0);
    i = i + 1;
  }
  x86bin.pokeByte(entry + 11, 0x10);
  x86bin.pokeByte(entry + 26, newCluster & 0xff);
  x86bin.pokeByte(entry + 27, (newCluster >>> 8) & 0xff);
  writeSector(dirLba, 0, DIR_SCAN_BUF);
  // Initialize the new dir cluster with "." and ".." entries.
  i = 0;
  while (i < 512) {
    x86bin.pokeByte(DIR_SCAN_BUF + i, 0);
    i = i + 1;
  }
  // "."
  x86bin.pokeByte(DIR_SCAN_BUF + 0, 0x2e);
  i = 1;
  while (i < 11) {
    x86bin.pokeByte(DIR_SCAN_BUF + i, 0x20);
    i = i + 1;
  }
  x86bin.pokeByte(DIR_SCAN_BUF + 11, 0x10);
  x86bin.pokeByte(DIR_SCAN_BUF + 26, newCluster & 0xff);
  x86bin.pokeByte(DIR_SCAN_BUF + 27, (newCluster >>> 8) & 0xff);
  // ".."
  x86bin.pokeByte(DIR_SCAN_BUF + 32, 0x2e);
  x86bin.pokeByte(DIR_SCAN_BUF + 33, 0x2e);
  i = 2;
  while (i < 11) {
    x86bin.pokeByte(DIR_SCAN_BUF + 32 + i, 0x20);
    i = i + 1;
  }
  x86bin.pokeByte(DIR_SCAN_BUF + 32 + 11, 0x10);
  x86bin.pokeByte(DIR_SCAN_BUF + 32 + 26, parent & 0xff);
  x86bin.pokeByte(DIR_SCAN_BUF + 32 + 27, (parent >>> 8) & 0xff);
  writeSector(DATA_LBA_MINUS_TWO + newCluster, 0, DIR_SCAN_BUF);
  saveFat();
  x86bin.pokeWord(USER_AX, 0);
}

function dispatchChDir(): void {
  const ds = x86bin.peekWord(USER_DS);
  const dx = x86bin.peekWord(USER_DX);
  // Save current state in case walkPath fails after partially
  // mutating CURRENT_PATH (the per-component pathPopComponent /
  // pathAppendComp).
  let backup = 0;
  let savedDir = x86bin.peekWord(CURRENT_DIR_CLUSTER);
  // We mirror CURRENT_PATH into the dir-scan buffer (transiently —
  // restored before any actual scan happens) so we can revert on
  // error. The path is at most 64 bytes; DIR_SCAN_BUF is 512.
  while (backup < CURRENT_PATH_MAX) {
    x86bin.pokeByte(DIR_SCAN_BUF + backup, x86bin.peekByte(CURRENT_PATH + backup));
    backup = backup + 1;
  }
  loadFat();
  const err = walkPath(ds, dx, 0, 1);
  if (err != 0) {
    // Restore path.
    let j = 0;
    while (j < CURRENT_PATH_MAX) {
      x86bin.pokeByte(CURRENT_PATH + j, x86bin.peekByte(DIR_SCAN_BUF + j));
      j = j + 1;
    }
    x86bin.pokeWord(USER_AX, 3);
    return;
  }
  x86bin.pokeWord(CURRENT_DIR_CLUSTER, x86bin.peekWord(RESULT_DIR_CLUSTER));
  if (savedDir == savedDir) { /* keep param to silence unused */ }
  x86bin.pokeWord(USER_AX, 0);
}

function dispatchGetCwd(): void {
  const ds = x86bin.peekWord(USER_DS);
  const si = x86bin.peekWord(USER_SI);
  let i = 0;
  while (i < CURRENT_PATH_MAX) {
    const ch = x86bin.peekByte(CURRENT_PATH + i);
    x86bin.pokeFar(ds, si + i, ch);
    if (ch == 0) return;
    i = i + 1;
  }
  x86bin.pokeFar(ds, si + CURRENT_PATH_MAX, 0);
}

// === File handles + open/close/read/write ===
//
// Handle layout (16 bytes, base = HANDLE_TABLE + (h - FIRST_HANDLE) * 16):
//   +0  byte  in_use (1 if allocated)
//   +1  byte  dir_entry_idx within dir_sector
//   +2  word  first_cluster
//   +4  word  current_cluster (cluster containing pos's sector)
//   +6  word  pos (bytes; 16-bit — files on this floppy stay <64 KB)
//   +8  word  size (bytes)
//   +10 word  dir_sector_lba (where the dir entry lives, for size flush)
//   +12 word  write_mode (1 if file is open for writing)
//   +14 word  unused

function handleAddr(h: number): number {
  return HANDLE_TABLE + (h - FIRST_HANDLE) * HANDLE_SIZE;
}

function handleInUse(h: number): number {
  if (h < FIRST_HANDLE) return 0;
  if (h >= FIRST_HANDLE + HANDLE_COUNT) return 0;
  return x86bin.peekByte(handleAddr(h));
}

function allocHandle(): number {
  let h = FIRST_HANDLE;
  while (h < FIRST_HANDLE + HANDLE_COUNT) {
    if (x86bin.peekByte(handleAddr(h)) == 0) {
      x86bin.pokeByte(handleAddr(h), 1);
      return h;
    }
    h = h + 1;
  }
  return 0;
}

function freeHandle(h: number): void {
  if (handleInUse(h) == 0) return;
  x86bin.pokeByte(handleAddr(h), 0);
}

function dispatchOpen(): void {
  // AH=3Dh AL=mode (0=read, 1=write, 2=rw — we ignore the distinction).
  // On error we return AX=0; on success AX = handle (>= FIRST_HANDLE).
  // The shell's `if (handle == 0)` check is enough to distinguish them
  // because allocHandle never hands out 0/1/2 (those are reserved for
  // stdin/stdout/stderr).
  const ds = x86bin.peekWord(USER_DS);
  const dx = x86bin.peekWord(USER_DX);
  loadFat();
  const err = walkPath(ds, dx, 1, 0);
  if (err != 0) {
    x86bin.pokeWord(USER_AX, 0);
    return;
  }
  const parent = x86bin.peekWord(RESULT_DIR_CLUSTER);
  if (findEntryByName(parent, NAME_ADDR) == 0) {
    x86bin.pokeWord(USER_AX, 0);
    return;
  }
  const dirLba = x86bin.peekWord(FOUND_LBA);
  const idx = x86bin.peekWord(FOUND_INDEX);
  const entry = DIR_SCAN_BUF + idx * 32;
  const attr = x86bin.peekByte(entry + 11);
  if ((attr & 0x10) != 0) {
    x86bin.pokeWord(USER_AX, 0);
    return;
  }
  const first = x86bin.peekWord(entry + 26);
  const sz = x86bin.peekWord(entry + 28);
  const h = allocHandle();
  if (h == 0) {
    x86bin.pokeWord(USER_AX, 0);
    return;
  }
  const hb = handleAddr(h);
  x86bin.pokeByte(hb + 1, idx);
  x86bin.pokeWord(hb + 2, first);
  x86bin.pokeWord(hb + 4, first);
  x86bin.pokeWord(hb + 6, 0);
  x86bin.pokeWord(hb + 8, sz);
  x86bin.pokeWord(hb + 10, dirLba);
  x86bin.pokeWord(hb + 12, 0);
  x86bin.pokeWord(USER_AX, h);
}

function dispatchCreate(): void {
  // AH=3Ch DS:DX=ASCIIZ name, CX=attribute. Create-or-truncate. Returns
  // AX=0 on error, AX=handle on success — same sentinel convention as
  // dispatchOpen so callers can use a single `if (h == 0)` check.
  const ds = x86bin.peekWord(USER_DS);
  const dx = x86bin.peekWord(USER_DX);
  loadFat();
  const err = walkPath(ds, dx, 1, 0);
  if (err != 0) {
    x86bin.pokeWord(USER_AX, 0);
    return;
  }
  const parent = x86bin.peekWord(RESULT_DIR_CLUSTER);
  let dirLba = 0;
  let idx = 0;
  if (findEntryByName(parent, NAME_ADDR) != 0) {
    // Truncate: free existing cluster chain.
    dirLba = x86bin.peekWord(FOUND_LBA);
    idx = x86bin.peekWord(FOUND_INDEX);
    const entry = DIR_SCAN_BUF + idx * 32;
    let c = x86bin.peekWord(entry + 26);
    while (c >= 2) {
      if (c >= 0xff8) break;
      const next = readFat(c);
      writeFatEntry(c, 0);
      c = next;
    }
    // Re-read sector (writeFatEntry hasn't touched DIR_SCAN_BUF, but
    // be defensive in case findFreeEntry pattern is reused).
    readSector(dirLba, 0, DIR_SCAN_BUF);
  } else {
    if (findFreeEntry(parent) == 0) {
      x86bin.pokeWord(USER_AX, 0);
      return;
    }
    dirLba = x86bin.peekWord(FOUND_LBA);
    idx = x86bin.peekWord(FOUND_INDEX);
  }
  // Fill the entry. The first cluster stays 0 until the first write
  // actually allocates one.
  const entry = DIR_SCAN_BUF + idx * 32;
  let i = 0;
  while (i < 11) {
    x86bin.pokeByte(entry + i, x86bin.peekByte(NAME_ADDR + i));
    i = i + 1;
  }
  i = 11;
  while (i < 32) {
    x86bin.pokeByte(entry + i, 0);
    i = i + 1;
  }
  x86bin.pokeByte(entry + 11, 0x20);
  writeSector(dirLba, 0, DIR_SCAN_BUF);
  saveFat();
  const h = allocHandle();
  if (h == 0) {
    x86bin.pokeWord(USER_AX, 0);
    return;
  }
  const hb = handleAddr(h);
  x86bin.pokeByte(hb + 1, idx);
  x86bin.pokeWord(hb + 2, 0);
  x86bin.pokeWord(hb + 4, 0);
  x86bin.pokeWord(hb + 6, 0);
  x86bin.pokeWord(hb + 8, 0);
  x86bin.pokeWord(hb + 10, dirLba);
  x86bin.pokeWord(hb + 12, 1);
  x86bin.pokeWord(USER_AX, h);
}

function dispatchClose(): void {
  const h = x86bin.peekWord(USER_BX);
  if (handleInUse(h) == 0) {
    x86bin.pokeWord(USER_AX, 6);
    return;
  }
  const hb = handleAddr(h);
  if (x86bin.peekWord(hb + 12) != 0) {
    // Flush size + first cluster into the dir entry.
    const dirLba = x86bin.peekWord(hb + 10);
    const idx = x86bin.peekByte(hb + 1);
    const size = x86bin.peekWord(hb + 8);
    const first = x86bin.peekWord(hb + 2);
    readSector(dirLba, 0, DIR_SCAN_BUF);
    const entry = DIR_SCAN_BUF + idx * 32;
    x86bin.pokeByte(entry + 26, first & 0xff);
    x86bin.pokeByte(entry + 27, (first >>> 8) & 0xff);
    x86bin.pokeByte(entry + 28, size & 0xff);
    x86bin.pokeByte(entry + 29, (size >>> 8) & 0xff);
    x86bin.pokeByte(entry + 30, 0);
    x86bin.pokeByte(entry + 31, 0);
    writeSector(dirLba, 0, DIR_SCAN_BUF);
    saveFat();
  }
  freeHandle(h);
  x86bin.pokeWord(USER_AX, 0);
}

function dispatchReadFile(): void {
  const h = x86bin.peekWord(USER_BX);
  if (handleInUse(h) == 0) {
    x86bin.pokeWord(USER_AX, 6);
    return;
  }
  const hb = handleAddr(h);
  const userDs = x86bin.peekWord(USER_DS);
  const userDx = x86bin.peekWord(USER_DX);
  const req = x86bin.peekWord(USER_CX);
  let pos = x86bin.peekWord(hb + 6);
  const size = x86bin.peekWord(hb + 8);
  let cluster = x86bin.peekWord(hb + 4);
  let read = 0;
  loadFat();
  while (read < req) {
    if (pos >= size) break;
    const offset = pos & 511;
    if (offset == 0) {
      if (cluster < 2) break;
      if (cluster >= 0xff8) break;
      readSector(DATA_LBA_MINUS_TWO + cluster, 0, FILE_IO_BUF);
    }
    const ch = x86bin.peekByte(FILE_IO_BUF + offset);
    x86bin.pokeFar(userDs, userDx + read, ch);
    pos = pos + 1;
    read = read + 1;
    if ((pos & 511) == 0) cluster = readFat(cluster);
  }
  x86bin.pokeWord(hb + 4, cluster);
  x86bin.pokeWord(hb + 6, pos);
  x86bin.pokeWord(USER_AX, read);
}

function dispatchWriteFile(h: number): void {
  const hb = handleAddr(h);
  const userDs = x86bin.peekWord(USER_DS);
  const userDx = x86bin.peekWord(USER_DX);
  const req = x86bin.peekWord(USER_CX);
  let pos = x86bin.peekWord(hb + 6);
  let size = x86bin.peekWord(hb + 8);
  let cluster = x86bin.peekWord(hb + 4);
  let written = 0;
  loadFat();
  while (written < req) {
    const offset = pos & 511;
    if (offset == 0) {
      if (pos >= size) {
        // Allocate a fresh cluster and link it on.
        const newCluster = allocCluster();
        if (newCluster == 0) break;
        const firstCluster = x86bin.peekWord(hb + 2);
        if (firstCluster == 0) {
          x86bin.pokeWord(hb + 2, newCluster);
        } else {
          if (cluster >= 2) {
            if (cluster < 0xff8) writeFatEntry(cluster, newCluster);
          }
        }
        cluster = newCluster;
        // Zero buffer for the fresh sector.
        let j = 0;
        while (j < 512) {
          x86bin.pokeByte(FILE_IO_BUF + j, 0);
          j = j + 1;
        }
      } else {
        readSector(DATA_LBA_MINUS_TWO + cluster, 0, FILE_IO_BUF);
      }
    }
    const ch = x86bin.peekFar(userDs, userDx + written);
    x86bin.pokeByte(FILE_IO_BUF + offset, ch);
    pos = pos + 1;
    written = written + 1;
    if ((pos & 511) == 0) {
      writeSector(DATA_LBA_MINUS_TWO + cluster, 0, FILE_IO_BUF);
      const next = readFat(cluster);
      if (next < 0xff8) cluster = next;
    }
  }
  // Flush partial sector.
  if ((pos & 511) != 0) {
    writeSector(DATA_LBA_MINUS_TWO + cluster, 0, FILE_IO_BUF);
  }
  if (pos > size) size = pos;
  x86bin.pokeWord(hb + 4, cluster);
  x86bin.pokeWord(hb + 6, pos);
  x86bin.pokeWord(hb + 8, size);
  saveFat();
  x86bin.pokeWord(USER_AX, written);
}

function nameMatches(entryAddr: number, nameAddr: number): number {
  let i = 0;
  while (i < 11) {
    if (x86bin.peekByte(entryAddr + i) != x86bin.peekByte(nameAddr + i)) return 0;
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
    const first = x86bin.peekByte(entry);
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
    x86bin.pokeByte(NAME_ADDR + i, 0x20);
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
    const ch = x86bin.peekFar(srcSeg, srcOff + s);
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
      x86bin.pokeByte(NAME_ADDR + stem, upperByte(ch));
      stem = stem + 1;
    } else {
      if (ext >= 3) return 0;
      x86bin.pokeByte(NAME_ADDR + 8 + ext, upperByte(ch));
      ext = ext + 1;
    }
    s = s + 1;
  }
  if (stem == 0) return 0;
  if (sawDot == 0) {
    x86bin.pokeByte(NAME_ADDR + 8, 0x43);  // C
    x86bin.pokeByte(NAME_ADDR + 9, 0x4f);  // O
    x86bin.pokeByte(NAME_ADDR + 10, 0x4d); // M
  }
  return 1;
}

// === PSP construction ===

function setupPsp(seg: number): void {
  // INT 20h opcode at offset 0 — the classic CP/M-style exit shortcut: a COM
  // program that simply `ret`s lands on this instruction and terminates.
  x86bin.pokeFar(seg, 0x0000, 0xcd);
  x86bin.pokeFar(seg, 0x0001, 0x20);
  // End-of-allocation pointer at offset 2 (single 64K segment for COMs).
  let i = 0;
  while (i < 2) {
    x86bin.pokeFar(seg, 0x0002 + i, 0xff);
    i = i + 1;
  }
  // Command line length byte at offset 0x80 = 0 (no args passed).
  x86bin.pokeFar(seg, 0x0080, 0);
  x86bin.pokeFar(seg, 0x0081, 0x0d);
}

function tsosReadBufferedLine(): void {
  const ds = x86bin.peekWord(USER_DS);
  const dx = x86bin.peekWord(USER_DX);
  const max = x86bin.peekFar(ds, dx);
  let i = 0;
  while (i < max) {
    const ch = bdaGetKey();
    if (ch == 0x0d) {
      putCr();
      x86bin.pokeFar(ds, dx + 1, i);
      x86bin.pokeFar(ds, dx + 2 + i, 0x0d);
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
    x86bin.pokeFar(ds, dx + 2 + i, ch);
    bdaPutChar(ch);
    i = i + 1;
  }
  x86bin.pokeFar(ds, dx + 1, i);
}

// === DOS write-to-handle (INT 21h AH=40h) ===
//
// BX = handle (1 = stdout, 2 = stderr), CX = byte count, DS:DX = buffer.
// We treat handle 1 or 2 as the console; the rest are unsupported because
// TS-DOS has no file system writes.
function dispatchWriteHandle(): void {
  const handle = x86bin.peekWord(USER_BX);
  const count = x86bin.peekWord(USER_CX);
  if (handle == 1) {
    const ds = x86bin.peekWord(USER_DS);
    const dx = x86bin.peekWord(USER_DX);
    let i = 0;
    while (i < count) {
      bdaPutChar(x86bin.peekFar(ds, dx + i));
      i = i + 1;
    }
    x86bin.pokeWord(USER_AX, count);
    return;
  }
  if (handle == 2) {
    const ds = x86bin.peekWord(USER_DS);
    const dx = x86bin.peekWord(USER_DX);
    let i = 0;
    while (i < count) {
      bdaPutChar(x86bin.peekFar(ds, dx + i));
      i = i + 1;
    }
    x86bin.pokeWord(USER_AX, count);
    return;
  }
  if (handleInUse(handle) != 0) {
    dispatchWriteFile(handle);
    return;
  }
  x86bin.pokeWord(USER_AX, 6);
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
  x86bin.pokeWord(DTA_SEG_ADDR, x86bin.peekWord(USER_DS));
  x86bin.pokeWord(DTA_OFF_ADDR, x86bin.peekWord(USER_DX));
}

function copyEntryToDta(entry: number): void {
  const dtaSeg = x86bin.peekWord(DTA_SEG_ADDR);
  const dtaOff = x86bin.peekWord(DTA_OFF_ADDR);
  // Attribute byte (entry+11 → DTA+0x15).
  x86bin.pokeFar(dtaSeg, dtaOff + 0x15, x86bin.peekByte(entry + 11));
  // Time (entry+22..23 → DTA+0x16..17) and date (entry+24..25 → DTA+0x18..19).
  let k = 0;
  while (k < 4) {
    x86bin.pokeFar(dtaSeg, dtaOff + 0x16 + k, x86bin.peekByte(entry + 22 + k));
    k = k + 1;
  }
  // 32-bit file size (entry+28..31 → DTA+0x1A..1D).
  k = 0;
  while (k < 4) {
    x86bin.pokeFar(dtaSeg, dtaOff + 0x1a + k, x86bin.peekByte(entry + 28 + k));
    k = k + 1;
  }
  // ASCIIZ name in 8.3 form, trailing spaces trimmed.
  let dst = 0;
  let i = 0;
  while (i < 8) {
    const ch = x86bin.peekByte(entry + i);
    if (ch == 0x20) break;
    x86bin.pokeFar(dtaSeg, dtaOff + 0x1e + dst, ch);
    dst = dst + 1;
    i = i + 1;
  }
  if (x86bin.peekByte(entry + 8) != 0x20) {
    x86bin.pokeFar(dtaSeg, dtaOff + 0x1e + dst, 0x2e);
    dst = dst + 1;
    i = 0;
    while (i < 3) {
      const ch = x86bin.peekByte(entry + 8 + i);
      if (ch == 0x20) break;
      x86bin.pokeFar(dtaSeg, dtaOff + 0x1e + dst, ch);
      dst = dst + 1;
      i = i + 1;
    }
  }
  x86bin.pokeFar(dtaSeg, dtaOff + 0x1e + dst, 0);
}

function continueSearch(): void {
  let i = x86bin.peekWord(SEARCH_CURSOR_ADDR);
  while (i < 224) {
    const entry = DIR_CACHE_BUF + i * 32;
    const first = x86bin.peekByte(entry);
    if (first == 0) break;
    if (first != 0xe5) {
      const attr = x86bin.peekByte(entry + 11);
      const isVolume = attr & 0x08;
      if (isVolume == 0) {
        copyEntryToDta(entry);
        x86bin.pokeWord(SEARCH_CURSOR_ADDR, i + 1);
        x86bin.pokeWord(USER_AX, 0);
        return;
      }
    }
    i = i + 1;
  }
  // No (more) matches: empty filename + DOS error 0x12 ("no more files").
  const dtaSeg = x86bin.peekWord(DTA_SEG_ADDR);
  const dtaOff = x86bin.peekWord(DTA_OFF_ADDR);
  x86bin.pokeFar(dtaSeg, dtaOff + 0x1e, 0);
  x86bin.pokeWord(USER_AX, 0x12);
}

function dispatchFindFirst(): void {
  // Pattern at DS:DX is ignored — TS-DOS treats every call as "*.*".
  loadCurrentDir();
  x86bin.pokeWord(SEARCH_CURSOR_ADDR, 0);
  continueSearch();
}

// === INT 21h dispatcher ===
//
// The asm IRET trampoline (below) stores all caller-visible registers
// (including SS:SP) into the USER_* slots, then calls dispatchInt21. The
// dispatcher reads inputs and writes outputs through x86bin.peekWord /
// x86bin.pokeWord on those slots. Most services return normally and the
// trampoline reloads the (possibly edited) regs and IRETs. AH=4Bh and
// AH=4Ch never return through the trampoline — they switch CS:IP / SS:SP
// to a different process directly.

function dispatchInt21(): void {
  const ax = x86bin.peekWord(USER_AX);
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
  if (ah == 0x39) {
    dispatchMakeDir();
    return;
  }
  if (ah == 0x3b) {
    dispatchChDir();
    return;
  }
  if (ah == 0x47) {
    dispatchGetCwd();
    return;
  }
  if (ah == 0x3c) {
    dispatchCreate();
    return;
  }
  if (ah == 0x3d) {
    dispatchOpen();
    return;
  }
  if (ah == 0x3e) {
    dispatchClose();
    return;
  }
  if (ah == 0x3f) {
    dispatchReadFile();
    return;
  }
  if (ah == 0x30) {
    // Get DOS Version: AL=major, AH=minor, BH=OEM (0xFF=MS-DOS), BL:CX=serial.
    // Report 5.00 — high enough for most 1990s software to enable its
    // modern code paths but low enough that programs don't expect long
    // file names or other 7.x-era features.
    x86bin.pokeWord(USER_AX, 0x0005);
    x86bin.pokeWord(USER_BX, 0xff00);
    x86bin.pokeWord(USER_CX, 0x0000);
    return;
  }
  if (ah == 0x25) {
    // Set Interrupt Vector: AL=int#, DS:DX=handler. Write into the IVT.
    const intNo = ax & 0xff;
    x86bin.pokeWord(intNo * 4, x86bin.peekWord(USER_DX));
    x86bin.pokeWord(intNo * 4 + 2, x86bin.peekWord(USER_DS));
    return;
  }
  if (ah == 0x35) {
    // Get Interrupt Vector: AL=int#. Return ES:BX = handler.
    const intNo = ax & 0xff;
    x86bin.pokeWord(USER_BX, x86bin.peekWord(intNo * 4));
    x86bin.pokeWord(USER_ES, x86bin.peekWord(intNo * 4 + 2));
    return;
  }
  if (ah == 0x2c) {
    // Get System Time: CH=hour, CL=minute, DH=second, DL=hundredths.
    // We don't track a real-time clock; report all zeros so callers
    // that just want a tick see a stable "midnight" value.
    x86bin.pokeWord(USER_CX, 0x0000);
    x86bin.pokeWord(USER_DX, 0x0000);
    return;
  }
  if (ah == 0x2a) {
    // Get System Date: CX=year, DH=month, DL=day, AL=day-of-week.
    // Report 1993-01-01 (a Friday) — close to VLAK's release year so
    // anything that gates content on year-of-build sees a plausible
    // value.
    x86bin.pokeWord(USER_CX, 1993);
    x86bin.pokeWord(USER_DX, 0x0101);
    x86bin.pokeWord(USER_AX, (ax & 0xff00) | 5);
    return;
  }
  if (ah == 0x4a) {
    // Resize Memory Block: BX = new paragraph count. We give every
    // process the entire 64K segment, so just succeed.
    return;
  }
  if (ah == 0x48) {
    // Allocate Memory Block: BX = paragraphs requested. We don't run
    // an allocator; report failure (CF=1, AX=error 8 = insufficient
    // memory, BX=max available paragraphs = 0) by returning AX=8.
    x86bin.pokeWord(USER_AX, 0x0008);
    x86bin.pokeWord(USER_BX, 0x0000);
    return;
  }
  if (ah == 0x06) {
    // Direct Console I/O. DL=0xFF means "read", anything else means
    // "write character DL". The read path is non-blocking and returns
    // ZF=1 if no key is available; we don't expose flags, so we use
    // the simpler convention of always polling and returning AL=0
    // when no key is ready (this matches what callers checking
    // `cmp al, 0` expect).
    const dx = x86bin.peekWord(USER_DX);
    if ((dx & 0xff) == 0xff) {
      // Read: BIOS INT 16h AH=01h "check keystroke" sets ZF if no key
      // pending; AH=00h reads the key.
      const status = x86bin.interrupt(0x16, 0x0100, 0, 0, 0, 0, 0);
      if (status == 0) {
        x86bin.pokeWord(USER_AX, ax & 0xff00);
        return;
      }
      const ch = x86bin.interrupt(0x16, 0x0000, 0, 0, 0, 0, 0) & 0xff;
      x86bin.pokeWord(USER_AX, (ax & 0xff00) | ch);
      return;
    }
    bdaPutChar(dx & 0xff);
    return;
  }
  if (ah == 0x02) {
    const dx = x86bin.peekWord(USER_DX);
    bdaPutChar(dx & 0xff);
    return;
  }
  if (ah == 0x09) {
    // Write $-terminated string at user's DS:DX.
    const ds = x86bin.peekWord(USER_DS);
    const dx = x86bin.peekWord(USER_DX);
    let i = 0;
    while (i < 4096) {
      const ch = x86bin.peekFar(ds, dx + i);
      if (ch == 0x24) return;
      bdaPutChar(ch);
      i = i + 1;
    }
    return;
  }
  if (ah == 0x01) {
    const ch = bdaGetKey();
    bdaPutChar(ch);
    x86bin.pokeWord(USER_AX, (ax & 0xff00) | (ch & 0xff));
    return;
  }
  if (ah == 0x08) {
    const ch = bdaGetKey();
    x86bin.pokeWord(USER_AX, (ax & 0xff00) | (ch & 0xff));
    return;
  }
  // Unsupported — log AH on the console + serial so we know what to
  // add, then terminate. AH is shown as two hex digits.
  putString(x86bin.cstr("\r\nUnsupported INT 21h AH=0x"));
  const ahHi = (ah >>> 4) & 0xf;
  const ahLo = ah & 0xf;
  if (ahHi < 10) bdaPutChar(ahHi + 0x30);
  else bdaPutChar(ahHi - 10 + 0x41);
  if (ahLo < 10) bdaPutChar(ahLo + 0x30);
  else bdaPutChar(ahLo - 10 + 0x41);
  putString(x86bin.cstr("\r\n"));
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
  x86bin.pokeWord(PARENT_SS, x86bin.peekWord(USER_SS));
  x86bin.pokeWord(PARENT_SP, x86bin.peekWord(USER_SP));
  x86bin.pokeWord(PARENT_DS, x86bin.peekWord(USER_DS));
  x86bin.pokeWord(PARENT_ES, x86bin.peekWord(USER_ES));
}

function launchChildFromName(): void {
  loadCurrentDir();
  const entry = findFile(DIR_CACHE_BUF, NAME_ADDR);
  if (entry == 0) {
    putString(x86bin.cstr("File not found.\r\n"));
    x86bin.pokeWord(PARENT_SS, 0);
    return;
  }
  const firstCluster = x86bin.peekWord(entry + 26);
  // Follow the cluster chain in case the COM file isn't contiguous
  // (write+exec workflows can fragment the data area).
  loadFat();
  let cluster = firstCluster;
  let s = 0;
  while (s < 128) {
    if (cluster < 2) break;
    if (cluster >= 0xff8) break;
    readSector(DATA_LBA_MINUS_TWO + cluster, CHILD_SEG, PROG_OFF + s * 512);
    cluster = readFat(cluster);
    s = s + 1;
  }
  setupPsp(CHILD_SEG);

  // Step 4: context switch into child. Same shape as the boot launcher
  // below, but jumping to CHILD_SEG instead of SHELL_SEG.
  x86bin.asm(`
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
  const argDs = x86bin.peekWord(USER_DS);
  const argDx = x86bin.peekWord(USER_DX);
  if (parseFatName(argDs, argDx) == 0) {
    putString(x86bin.cstr("Bad child filename.\r\n"));
    // Restore: pretend no parent was saved so a follow-up AH=4Ch halts cleanly.
    x86bin.pokeWord(PARENT_SS, 0);
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
  x86bin.pokeByte(EXIT_CODE_ADDR, code & 0xff);
  if (x86bin.peekWord(PARENT_SS) != 0) {
    // Clear parent slot so a future nested exec works (and so the parent
    // itself, when it eventually exits, halts cleanly).
    x86bin.asm(`
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
  putString(x86bin.cstr("\r\n[TS-DOS] shell terminated.\r\n"));
  halt();
}

// === Low-level kernel choreography ===

function installInterruptStub(intNo: number, stubOffset: number): void {
  // Real-mode IVT: 4 bytes per vector at 0000:(intNo*4) -> offset, then segment.
  // Our stubs live in the kernel segment (0), so the segment word is always 0.
  const vecOff = intNo * 4;
  x86bin.pokeWord(vecOff, stubOffset);
  x86bin.pokeWord(vecOff + 2, 0);
}

function halt(): void {
  // cli + a wait-for-interrupt loop. Because interrupts are disabled, only an
  // NMI can wake the CPU and we'll immediately re-enter hlt anyway.
  x86bin.cli();
  while (1 != 0) {
    x86bin.hlt();
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

x86bin.trampoline("__int20_stub", `
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

x86bin.trampoline("__int21_stub", `
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
x86bin.setSegments(0);

// Install our INT 20h and INT 21h vectors. x86bin.labelOffset turns a compile-time
// asm label into a runtime number, so the IVT install itself is plain
// TypeScript memory pokes.
installInterruptStub(0x20, x86bin.labelOffset("__int20_stub"));
installInterruptStub(0x21, x86bin.labelOffset("__int21_stub"));

// No parent process is waiting for the boot shell.
x86bin.pokeWord(PARENT_SS, 0);

// Start at the root directory with an empty cwd string. FAT cache is
// loaded lazily on first read/write operation.
x86bin.pokeWord(CURRENT_DIR_CLUSTER, 0);
pathReset();
x86bin.pokeByte(FAT_LOADED, 0);
x86bin.pokeByte(FAT_DIRTY, 0);
// Reset file-handle table.
let __h = 0;
while (__h < HANDLE_COUNT) {
  x86bin.pokeByte(HANDLE_TABLE + __h * HANDLE_SIZE, 0);
  __h = __h + 1;
}

serialInit();
putString(x86bin.cstr("TS-DOS TypeScript kernel: INT 20h/21h/4Bh/4Ch ready.\r\n"));

// Pre-populate the 11-byte FAT name "COMMAND COM" at NAME_ADDR so the
// FAT12 directory-scan loop can compare 11 bytes at a time without ever
// needing to materialize a string literal in registers.
x86bin.pokeByte(NAME_ADDR + 0, 0x43);  // C
x86bin.pokeByte(NAME_ADDR + 1, 0x4f);  // O
x86bin.pokeByte(NAME_ADDR + 2, 0x4d);  // M
x86bin.pokeByte(NAME_ADDR + 3, 0x4d);  // M
x86bin.pokeByte(NAME_ADDR + 4, 0x41);  // A
x86bin.pokeByte(NAME_ADDR + 5, 0x4e);  // N
x86bin.pokeByte(NAME_ADDR + 6, 0x44);  // D
x86bin.pokeByte(NAME_ADDR + 7, 0x20);  // ' '
x86bin.pokeByte(NAME_ADDR + 8, 0x43);  // C
x86bin.pokeByte(NAME_ADDR + 9, 0x4f);  // O
x86bin.pokeByte(NAME_ADDR + 10, 0x4d); // M

// Read the FAT12 root directory into our cache so the boot path can
// find COMMAND.COM.
readSectors(ROOT_LBA, ROOT_BUF_SECTORS, 0, DIR_CACHE_BUF);

const entry = findFile(DIR_CACHE_BUF, NAME_ADDR);
if (entry == 0) {
  putString(x86bin.cstr("COMMAND.COM not found on disk.\r\n"));
  halt();
}

// Read file size (4 bytes little-endian at offset 28) and first cluster (16-bit
// at offset 26).
const sizeLo = x86bin.peekWord(entry + 28);
const firstCluster = x86bin.peekWord(entry + 26);
const numSectors = (sizeLo + 511) >>> 9;
const lba = DATA_LBA_MINUS_TWO + firstCluster;
readSectors(lba, numSectors, SHELL_SEG, PROG_OFF);

setupPsp(SHELL_SEG);

putString(x86bin.cstr("Launching COMMAND.COM.\r\n"));

// Atomic context switch into the shell. This is one of two places where
// switching DS makes every subsequent TS local-variable access (DS-relative)
// read the wrong memory, so the whole cli/segments/SS:SP/sti/retf sequence
// has to happen inside a single inline-asm block that touches no kernel
// data between `mov ds` and `retf`. SHELL_SEG / PROG_OFF are hardcoded
// here (0x2000 / 0x0100); they must stay in sync with the consts above.
x86bin.asm(`
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
