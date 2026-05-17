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


def fat_name(name: str) -> bytes:
    upper = name.upper()
    if "." in upper:
        stem, ext = upper.split(".", 1)
    else:
        stem, ext = upper, ""
    if not stem or len(stem) > 8 or len(ext) > 3:
        raise SystemExit(f"invalid FAT 8.3 file name: {name}")
    return stem.ljust(8).encode("ascii") + ext.ljust(3).encode("ascii")


def main() -> int:
    if len(sys.argv) < 4:
        print("usage: mkfat12.py IMAGE BOOT.BIN NAME=FILE ...", file=sys.stderr)
        return 2

    image_path = pathlib.Path(sys.argv[1])
    boot_path = pathlib.Path(sys.argv[2])
    file_specs = []
    for spec in sys.argv[3:]:
        if "=" not in spec:
            raise SystemExit(f"file spec must be NAME=PATH: {spec}")
        name, path = spec.split("=", 1)
        file_specs.append((fat_name(name), pathlib.Path(path), name.upper()))

    boot = boot_path.read_bytes()
    if len(boot) != BYTES_PER_SECTOR:
        raise SystemExit(f"{boot_path} must be exactly 512 bytes")
    if boot[510:512] != b"\x55\xaa":
        raise SystemExit(f"{boot_path} is missing the boot signature")

    image = bytearray(SECTORS * BYTES_PER_SECTOR)
    image[:BYTES_PER_SECTOR] = boot

    fat = bytearray(SECTORS_PER_FAT * BYTES_PER_SECTOR)
    fat[0:3] = bytes([MEDIA, 0xFF, 0xFF])

    root_offset = ROOT_START
    next_cluster = 2
    for fat_entry_name, path, display_name in file_specs:
        data = path.read_bytes()
        clusters = max(1, math.ceil(len(data) / BYTES_PER_SECTOR))
        if next_cluster + clusters > 2849:
            raise SystemExit("files are too large for this FAT12 image")

        first_cluster = next_cluster
        for cluster in range(first_cluster, first_cluster + clusters):
            value = 0xFFF if cluster == first_cluster + clusters - 1 else cluster + 1
            set_fat12_entry(fat, cluster, value)

        entry = bytearray(32)
        entry[0:11] = fat_entry_name
        entry[11] = 0x20
        struct.pack_into("<H", entry, 26, first_cluster)
        struct.pack_into("<I", entry, 28, len(data))
        image[root_offset:root_offset + 32] = entry
        root_offset += 32

        data_start = DATA_START + (first_cluster - 2) * BYTES_PER_SECTOR
        file_area = data.ljust(clusters * BYTES_PER_SECTOR, b"\0")
        image[data_start:data_start + len(file_area)] = file_area
        print(f"added {display_name} ({len(data)} bytes, {clusters} cluster(s))")
        next_cluster += clusters

    for fat_index in range(FATS):
        start = FAT_START + fat_index * len(fat)
        image[start:start + len(fat)] = fat

    image_path.parent.mkdir(parents=True, exist_ok=True)
    image_path.write_bytes(image)
    print(f"wrote {image_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
