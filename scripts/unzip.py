#!/usr/bin/env python3
"""解压 GitHub codeload 归档，并在最后一行打印源码根目录路径。

用法: unzip.py <archive.zip> <destination>
GitHub 归档通常带一层 `<repo>-<tag>/` 目录，这里自动剥掉，方便同步脚本定位。
带 Zip Slip 防护，避免恶意归档写出目标目录。
"""
import os
import sys
import zipfile


def main() -> int:
    archive, destination = sys.argv[1], sys.argv[2]
    os.makedirs(destination, exist_ok=True)
    with zipfile.ZipFile(archive) as zf:
        for name in zf.namelist():
            parts = name.replace("\\", "/").split("/")
            if name.startswith("/") or ".." in parts or (len(parts) > 1 and parts[0] and ":" in parts[0]):
                raise SystemExit(f"unsafe archive entry: {name}")
        zf.extractall(destination)

    entries = [e for e in os.listdir(destination) if not e.startswith(".")]
    root = destination
    if len(entries) == 1 and os.path.isdir(os.path.join(destination, entries[0])):
        root = os.path.join(destination, entries[0])
    print(root)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
