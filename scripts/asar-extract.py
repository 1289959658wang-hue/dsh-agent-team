#!/usr/bin/env python3
"""Extract files from an Electron .asar archive (read-only, offline).

Why this exists
---------------
The desktop DSH app ships its sources inside ``C:\\Software\\DSH\\resources\\app.asar``.
Neither the file tools nor plain ``node`` can read inside it (the asar virtual
filesystem is an Electron patch of ``fs``).  The handover referenced the npm
install (0.2.0-rc.2) for source checks, but the running desktop app is a
different, newer version -- so reading the real sources means reading asar.

Usage
-----
    python scripts/asar-extract.py list  <asar> [prefix]
    python scripts/asar-extract.py cat   <asar> <path-in-asar>
    python scripts/asar-extract.py x     <asar> <path-in-asar> <out-file>
    python scripts/asar-extract.py tree  <asar> <path-in-asar> [prefix]

The asar layout: 8-byte pickle header (uint32 4, uint32 header_payload_size),
then a uint32-pickled JSON string, then file data starting at 8+header_payload_size.
"""
import json
import struct
import sys
from pathlib import Path


def read_header(asar_path):
    with open(asar_path, "rb") as fh:
        first = fh.read(16)
        if len(first) < 16:
            raise SystemExit("not an asar file (too short)")
        _four, header_payload_size = struct.unpack("<II", first[:8])
        _size_again, json_size = struct.unpack("<II", first[8:16])
        if header_payload_size <= 0 or json_size <= 0:
            raise SystemExit("not an asar file (bad header)")
        raw = fh.read(json_size)
    header = json.loads(raw.decode("utf-8"))
    base = 8 + header_payload_size
    return header, base


def entries(header):
    """Yield (path, meta) for every file entry."""

    def walk(node, prefix):
        for name, info in (node.get("files") or {}).items():
            path = f"{prefix}/{name}" if prefix else name
            if "files" in info:
                yield from walk(info, path)
            else:
                yield path, info

    yield from walk(header, "")


def get(header, base, target, asar_path):
    node = header
    parts = [p for p in target.replace("\\", "/").split("/") if p]
    for part in parts:
        node = (node.get("files") or {}).get(part)
        if node is None:
            raise SystemExit(f"not found in asar: {target}")
    if "files" in node:
        raise SystemExit(f"is a directory: {target}")
    if node.get("unpacked"):
        raise SystemExit(
            f"{target} is stored unpacked; read it from "
            f"{Path(asar_path).with_suffix('.asar.unpacked')}"
        )
    offset = int(node["offset"])
    size = int(node["size"])
    with open(asar_path, "rb") as fh:
        fh.seek(base + offset)
        return fh.read(size)


def main(argv):
    if len(argv) < 3:
        raise SystemExit(__doc__)
    cmd, asar_path = argv[1], argv[2]
    header, base = read_header(asar_path)

    if cmd == "list":
        prefix = argv[3] if len(argv) > 3 else ""
        hits = [p for p, _ in entries(header) if p.startswith(prefix)]
        for path in sorted(hits):
            print(path)
        return 0

    if cmd == "tree":
        # directory names only, for a quick survey
        prefix = argv[3] if len(argv) > 3 else ""
        depth_filter = argv[4] if len(argv) > 4 else ""
        seen = set()
        for path, _ in entries(header):
            if not path.startswith(prefix):
                continue
            parts = path.split("/")
            for i in range(1, len(parts)):
                d = "/".join(parts[:i])
                if d not in seen and (not depth_filter or d.count("/") < int(depth_filter)):
                    seen.add(d)
        for d in sorted(seen):
            print(d + "/")
        return 0

    if cmd == "cat":
        data = get(header, base, argv[3], asar_path)
        sys.stdout.write(data.decode("utf-8", "replace"))
        return 0

    if cmd == "x":
        if len(argv) < 5:
            raise SystemExit("usage: x <asar> <path-in-asar> <out-file>")
        data = get(header, base, argv[3], asar_path)
        out = Path(argv[4])
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(data)
        print(f"{len(data)} bytes -> {out}")
        return 0

    raise SystemExit(f"unknown command: {cmd}")


if __name__ == "__main__":
    sys.exit(main(sys.argv))
