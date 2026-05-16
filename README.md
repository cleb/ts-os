# ts-os

A tiny x86/FAT12 boot experiment with a TypeScript payload compiled by Perry.

The boot sector is a minimal FAT12 loader. It expects a 1.44 MB FAT12 floppy
image, searches the root directory for `KERNEL.BIN`, loads the file from
contiguous data sectors, and jumps to it at `0000:1000`.

`src/kernel.ts` is compiled with Perry's `x86-freestanding` raw 16-bit path and
uses BIOS interrupts to print a message, wait for a key, and reboot.

## Build

From this repo:

```sh
./scripts/build.sh
```

By default the script uses Perry from `../../3rdparty/perry/target/debug/perry`.
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
- `src/kernel.ts` - TypeScript payload compiled into `KERNEL.BIN`.
- `scripts/mkfat12.py` - Creates a FAT12 image and writes `KERNEL.BIN`.
- `scripts/build.sh` - Builds the boot sector, payload, and floppy image.

The first version intentionally keeps the loader simple: `KERNEL.BIN` must fit
in conventional memory at `0000:1000` and is written contiguously by the image
builder.

