#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BUILD="$ROOT/build"
PERRY=${PERRY:-"$ROOT/../../3rdparty/perry/target/release/perry"}

mkdir -p "$BUILD"

nasm -f bin "$ROOT/src/boot.asm" -o "$BUILD/boot.bin"
"$PERRY" compile "$ROOT/src/kernel.ts" --target x86-freestanding -o "$BUILD/DOSKRNL.BIN"
"$PERRY" compile "$ROOT/src/command.ts" --target x86-freestanding -o "$BUILD/COMMAND.COM"
nasm -f bin "$ROOT/src/hello_com.asm" -o "$BUILD/HELLO.COM"
python3 "$ROOT/scripts/mkfat12.py" "$BUILD/ts-os.img" "$BUILD/boot.bin" \
    DOSKRNL.BIN="$BUILD/DOSKRNL.BIN" \
    COMMAND.COM="$BUILD/COMMAND.COM" \
    HELLO.COM="$BUILD/HELLO.COM"

echo "boot sector: $(wc -c < "$BUILD/boot.bin") bytes"
echo "kernel:      $(wc -c < "$BUILD/DOSKRNL.BIN") bytes"
echo "command.com: $(wc -c < "$BUILD/COMMAND.COM") bytes"
echo "hello.com:   $(wc -c < "$BUILD/HELLO.COM") bytes"
echo "image:       $BUILD/ts-os.img"
