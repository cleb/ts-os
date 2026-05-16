#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BUILD="$ROOT/build"
PERRY=${PERRY:-"$ROOT/../../3rdparty/perry/target/debug/perry"}

mkdir -p "$BUILD"

nasm -f bin "$ROOT/src/boot.asm" -o "$BUILD/boot.bin"
"$PERRY" compile "$ROOT/src/kernel.ts" --target x86-freestanding -o "$BUILD/kernel.com"
cp "$BUILD/kernel.com" "$BUILD/KERNEL.BIN"
python3 "$ROOT/scripts/mkfat12.py" "$BUILD/ts-os.img" "$BUILD/boot.bin" "$BUILD/KERNEL.BIN"

echo "boot sector: $(wc -c < "$BUILD/boot.bin") bytes"
echo "kernel:      $(wc -c < "$BUILD/KERNEL.BIN") bytes"
echo "image:       $BUILD/ts-os.img"

