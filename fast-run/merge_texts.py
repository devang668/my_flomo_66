from __future__ import annotations

from pathlib import Path

ROOT_DIR = Path(r"D:\okx\data\1\抖音")
OUTPUT_FILE = Path(r"D:\okx\data\o\merged_output.md")
TEXT_SUFFIXES: frozenset[str] = frozenset({".txt"})
ENCODING = "utf-8"
MAX_HEADING_LEVEL = 6

def make_heading(level: int, title: str) -> str:
    level = max(1, min(MAX_HEADING_LEVEL, level))
    return f"{'#' * level} {title}\n\n"


def iter_children(directory: Path) -> tuple[list[Path], list[Path]]:
    files: list[Path] = []
    dirs: list[Path] = []
    for entry in directory.iterdir():
        if entry.is_file():
            files.append(entry)
        elif entry.is_dir():
            dirs.append(entry)
    files.sort()
    dirs.sort()
    return files, dirs


def write_directory(directory: Path, depth: int, out_file) -> None:
    heading_level = min(MAX_HEADING_LEVEL, depth + 2)
    out_file.write(make_heading(heading_level, directory.name))

    files, dirs = iter_children(directory)
    file_heading_level = min(MAX_HEADING_LEVEL, heading_level + 1)
    for file_path in files:
        if file_path.suffix.lower() not in TEXT_SUFFIXES:
            continue
        out_file.write(make_heading(file_heading_level, file_path.stem))
        content = file_path.read_text(encoding=ENCODING, errors="replace")
        if not content.endswith("\n"):
            content += "\n"
        out_file.write(content + "\n")

    for subdir in dirs:
        write_directory(subdir, depth + 1, out_file)


def merge_texts() -> None:
    if not ROOT_DIR.is_dir():
        raise NotADirectoryError(f"{ROOT_DIR} 不是有效的目录")

    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)

    with OUTPUT_FILE.open("w", encoding=ENCODING, newline="\n") as out_file:
        write_directory(ROOT_DIR, depth=0, out_file=out_file)


if __name__ == "__main__":
    merge_texts()
