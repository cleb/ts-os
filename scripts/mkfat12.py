#!/usr/bin/env python3
import math
import pathlib
import struct
import sys

BYTES_PER_SECTOR = 512
SECTORS = 2880
RESERVED_SECTORS = 1
FATS = 2
SECTORS_PER_FAT = 9
ROOT_ENTRIES = 224
ROOT_SECTORS = 14
FAT_START = RESERVED_SECTORS * BYTES_PER_SECTOR
ROOT_START = (RESERVED_SECTORS + FATS * SECTORS_PER_FAT) * BYTES_PER_SECTOR
DATA_START = (RESERVED_SECTORS + FATS * SECTORS_PER_FAT + ROOT_SECTORS) * BYTES_PER_SECTOR
MEDIA = 0xF0


def set_fat12_entry(fat: bytearray, cluster: int, value: int) -> None:
    offset = cluster + cluster // 2
    value &= 0xFFF
    if cluster & 1:
        fat[offset] = (fat[offset] & 0x0F) | ((value << 4) & 0xF0)
        fat[offset + 1] = (value >> 4) & 0xFF
    else:
        fat[offset] = value & 0xFF
        fat[offset + 1] = (fat[offset + 1] & 0xF0) | ((value >> 8) & 0x0F)


def main() -> int:
    if len(sys.argv) != 4:
        print("usage: mkfat12.py IMAGE BOOT.BIN KERNEL.BIN", file=sys.stderr)
        return 2

    image_path = pathlib.Path(sys.argv[1])
    boot_path = pathlib.Path(sys.argv[2])
    kernel_path = pathlib.Path(sys.argv[3])

    boot = boot_path.read_bytes()
    if len(boot) != BYTES_PER_SECTOR:
        raise SystemExit(f"{boot_path} must be exactly 512 bytes")
    if boot[510:512] != b"\x55\xaa":
        raise SystemExit(f"{boot_path} is missing the boot signature")

    kernel = kernel_path.read_bytes()
    clusters = max(1, math.ceil(len(kernel) / BYTES_PER_SECTOR))
    if clusters > 2847:
        raise SystemExit("kernel is too large for this FAT12 image")

    image = bytearray(SECTORS * BYTES_PER_SECTOR)
    image[:BYTES_PER_SECTOR] = boot

    fat = bytearray(SECTORS_PER_FAT * BYTES_PER_SECTOR)
    fat[0:3] = bytes([MEDIA, 0xFF, 0xFF])
    for cluster in range(2, 2 + clusters):
        next_cluster = 0xFFF if cluster == 1 + clusters else cluster + 1
        set_fat12_entry(fat, cluster, next_cluster)

    for fat_index in range(FATS):
        start = FAT_START + fat_index * len(fat)
        image[start:start + len(fat)] = fat

    entry = bytearray(32)
    entry[0:11] = b"KERNEL  BIN"
    entry[11] = 0x20
    struct.pack_into("<H", entry, 26, 2)
    struct.pack_into("<I", entry, 28, len(kernel))
    image[ROOT_START:ROOT_START + 32] = entry

    kernel_area = kernel.ljust(clusters * BYTES_PER_SECTOR, b"\0")
    image[DATA_START:DATA_START + len(kernel_area)] = kernel_area

    image_path.parent.mkdir(parents=True, exist_ok=True)
    image_path.write_bytes(image)
    print(f"wrote {image_path} with {kernel_path.name} ({len(kernel)} bytes, {clusters} cluster(s))")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

