# ts-os

A tiny x86/FAT12 boot experiment with a TypeScript DOS-like kernel compiled by
Perry.

The boot sector is a minimal FAT12 loader. It expects a 1.44 MB FAT12 floppy
image, searches the root directory for `DOSKRNL.BIN`, loads the file from
contiguous data sectors, and jumps to it at `0000:1000`.

`src/kernel.ts` is compiled with Perry's `x86-freestanding` raw 16-bit path. It
installs a small DOS interrupt layer, creates a PSP, loads `COMMAND.COM` at
`2000:0100`, and runs it. `src/command.ts` is compiled to `COMMAND.COM`; it is a
pure TypeScript shell that imports `ts-os` and calls typed helpers rather than
raw x86 primitives. The helpers compile to `int 21h`, and the kernel owns the
low-level FAT12, readline, `dir`, `cd`, and program-loading logic. `HELLO.COM`
is a real `.COM` program that uses classic MS-DOS interrupts instead of BIOS
calls.

This is a first compatibility milestone, not full MS-DOS. Supported services:

- `int 20h`: terminate program.
- `int 21h AH=00h`: terminate program.
- `int 21h AH=01h`: read character with echo.
- `int 21h AH=02h`: write character in `DL`.
- `int 21h AH=08h`: read character without echo.
- `int 21h AH=09h`: write `$`-terminated string at `DS:DX`.
- `int 21h AH=0Ah`: buffered line input.
- `int 21h AH=1Ah`: set DTA (used by FindFirst/FindNext).
- `int 21h AH=40h`: write to handle (handles 1/2 → console).
- `int 21h AH=4Bh`: load and execute a `.COM` child program.
- `int 21h AH=4Ch`: terminate with return code.
- `int 21h AH=4Eh` / `4Fh`: FindFirst / FindNext on the FAT12 root.

## Build

From this repo:

```sh
./scripts/build.sh
```

By default the script uses Perry from `../../3rdparty/perry/target/release/perry`.
Override it with:

```sh
PERRY=/path/to/perry ./scripts/build.sh
```

## Run

```sh
qemu-system-i386 -drive file=build/ts-os.img,format=raw,if=floppy
```

For a non-graphical smoke test:

```sh
qemu-system-i386 -display curses -drive file=build/ts-os.img,format=raw,if=floppy
```

## Layout

- `src/boot.asm` - 512-byte FAT12 boot sector.
- `src/kernel.ts` - TypeScript DOS-like kernel compiled into `DOSKRNL.BIN`.
- `src/command.ts` - pure TypeScript `COMMAND.COM` shell.
- `src/hello_com.asm` - simple MS-DOS-style `.COM` test program.
- `scripts/mkfat12.py` - Creates a FAT12 image and writes root files.
- `scripts/build.sh` - Builds the boot sector, payload, and floppy image.

The loaders intentionally stay simple: files are written contiguously by the
image builder, and the kernel assumes the `.COM` program fits in one segment.
