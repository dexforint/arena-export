from __future__ import annotations

import argparse
import difflib
import re
import sys
from dataclasses import dataclass
from itertools import zip_longest
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


MAX_DIFF_LINES = 200
DIFF_CONTEXT_LINES = 3


@dataclass
class FileComparison:
    name: str
    exported_path: Path
    expected_path: Path
    status: str
    similarity: float
    exported_chars: int
    expected_chars: int
    exported_lines: int
    expected_lines: int
    first_diff_line_number: int | None
    first_exported_line: str | None
    first_expected_line: str | None
    diff_text: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Сравнение двух папок с Markdown-файлами."
    )
    parser.add_argument(
        "exported_dir",
        type=Path,
        help="Путь к папке с экспортом",
    )
    parser.add_argument(
        "expected_dir",
        type=Path,
        help="Путь к папке с действительными сообщениями",
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="Путь для сохранения отчёта в UTF-8",
    )
    return parser.parse_args()


def validate_directory(path: Path, title: str) -> Path:
    if not path.exists():
        raise FileNotFoundError(f"{title}: путь не существует: {path}")
    if not path.is_dir():
        raise NotADirectoryError(f"{title}: это не папка: {path}")
    return path.resolve()


def natural_sort_key(value: str) -> list[object]:
    parts = re.split(r"(\d+)", value.lower())
    result: list[object] = []

    for part in parts:
        if part.isdigit():
            result.append(int(part))
        else:
            result.append(part)

    return result


def collect_markdown_files(root: Path) -> dict[str, Path]:
    files: dict[str, Path] = {}

    for path in root.rglob("*"):
        if not path.is_file():
            continue
        if path.suffix.lower() != ".md":
            continue

        relative_name = path.relative_to(root).as_posix()
        if relative_name in files:
            raise ValueError(f"Найден дублирующийся относительный путь: {relative_name}")

        files[relative_name] = path

    return files


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def normalize_text_for_loose_compare(text: str) -> str:
    normalized = (
        text.replace("\ufeff", "")
        .replace("\r\n", "\n")
        .replace("\r", "\n")
        .replace("\u00A0", " ")
    )

    lines = [line.rstrip(" \t") for line in normalized.split("\n")]

    while lines and lines[-1] == "":
        lines.pop()

    return "\n".join(lines)


def line_count(text: str) -> int:
    if not text:
        return 0
    return len(text.replace("\r\n", "\n").replace("\r", "\n").split("\n"))


def find_first_difference(
    expected_text: str,
    exported_text: str,
) -> tuple[int | None, str | None, str | None]:
    expected_lines = expected_text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    exported_lines = exported_text.replace("\r\n", "\n").replace("\r", "\n").split("\n")

    for index, (expected_line, exported_line) in enumerate(
        zip_longest(expected_lines, exported_lines, fillvalue=None),
        start=1,
    ):
        if expected_line != exported_line:
            return index, exported_line, expected_line

    return None, None, None


def build_diff_text(
    file_name: str,
    expected_text: str,
    exported_text: str,
    max_lines: int = MAX_DIFF_LINES,
    context_lines: int = DIFF_CONTEXT_LINES,
) -> str:
    expected_lines = expected_text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    exported_lines = exported_text.replace("\r\n", "\n").replace("\r", "\n").split("\n")

    diff_lines = list(
        difflib.unified_diff(
            expected_lines,
            exported_lines,
            fromfile=f"expected/{file_name}",
            tofile=f"exported/{file_name}",
            lineterm="",
            n=context_lines,
        )
    )

    if not diff_lines:
        return "diff пустой; различие, скорее всего, только в пробелах или окончаниях строк"

    if len(diff_lines) > max_lines:
        remaining = len(diff_lines) - max_lines
        diff_lines = diff_lines[:max_lines]
        diff_lines.append(f"... diff обрезан, скрыто строк: {remaining}")

    return "\n".join(diff_lines)


def preview_line(text: str | None, max_length: int = 180) -> str:
    if text is None:
        return "<строка отсутствует>"

    prepared = text.replace("\t", "\\t")
    if len(prepared) > max_length:
        return prepared[: max_length - 3] + "..."

    return prepared

def normalize_markdown_semantic(text: str) -> str:
    import re

    text = (
        text.replace("\ufeff", "")
        .replace("\r\n", "\n")
        .replace("\r", "\n")
        .replace("\u00A0", " ")
    )

    def same_url_link(match: re.Match[str]) -> str:
        label = match.group(1).strip()
        href = match.group(2).strip()
        if label.rstrip("/") == href.rstrip("/"):
            return href
        return match.group(0)

    text = re.sub(
        r"\[([^\]\n]+)\]\((https?://[^\s)]+)\)",
        same_url_link,
        text,
    )

    text = re.sub(r"\\([\[\].])", r"\1", text)
    text = re.sub(r"(?m)^([ \t]*\d+)\\\.(?=[ \t])", r"\1.", text)
    text = re.sub(r"(?m)^(#+[ \t]+\d+)\\\.(?=[ \t])", r"\1.", text)
    text = re.sub(r"(?m)^([ \t]*\d+\.)[ \t]+", r"\1 ", text)
    text = re.sub(r"(?m)^[ \t]*[-*+][ \t]+", "- ", text)

    def normalize_fence(match: re.Match[str]) -> str:
        fence = match.group(1)
        lang = (match.group(2) or "").strip().lower()

        aliases = {
            "plaintext": "",
            "text": "",
            "txt": "",
            "javascript": "js",
            "js": "js",
            "typescript": "ts",
            "ts": "ts",
            "python": "py",
            "py": "py",
        }

        lang = aliases.get(lang, lang)
        return fence if not lang else f"{fence}{lang}"

    text = re.sub(r"(?m)^(```+)\s*([A-Za-z0-9_#+-]+)?\s*$", normalize_fence, text)

    lines = text.split("\n")
    normalized_lines: list[str] = []
    in_fence = False
    blank_run = 0

    for line in lines:
        stripped = line.rstrip()

        if re.match(r"^\s*```+", stripped):
            in_fence = not in_fence
            blank_run = 0
            normalized_lines.append(stripped)
            continue

        if in_fence:
            normalized_lines.append(line.rstrip("\n\r"))
            continue

        if re.match(r"^\s*(at\s+\S|await in |[A-Za-z_]\w*\s+@ )", stripped):
            stripped = stripped.lstrip()

        if stripped == "":
            blank_run += 1
            if blank_run <= 1:
                normalized_lines.append("")
        else:
            blank_run = 0
            normalized_lines.append(stripped)

    while normalized_lines and normalized_lines[-1] == "":
        normalized_lines.pop()

    return "\n".join(normalized_lines)

def compare_file(
    name: str,
    exported_path: Path,
    expected_path: Path,
) -> FileComparison:
    exported_text = read_text(exported_path)
    expected_text = read_text(expected_path)

    if exported_text == expected_text:
        status = "exact"
    elif normalize_text_for_loose_compare(exported_text) == normalize_text_for_loose_compare(expected_text):
        status = "normalized_match"
    elif normalize_markdown_semantic(exported_text) == normalize_markdown_semantic(expected_text):
        status = "semantic_match"
    else:
        status = "different"

    similarity = difflib.SequenceMatcher(None, expected_text, exported_text).ratio()
    first_diff_line_number, first_exported_line, first_expected_line = find_first_difference(
        expected_text,
        exported_text,
    )

    diff_text = ""
    if status != "exact":
        diff_text = build_diff_text(name, expected_text, exported_text)

    return FileComparison(
        name=name,
        exported_path=exported_path,
        expected_path=expected_path,
        status=status,
        similarity=similarity,
        exported_chars=len(exported_text),
        expected_chars=len(expected_text),
        exported_lines=line_count(exported_text),
        expected_lines=line_count(expected_text),
        first_diff_line_number=first_diff_line_number,
        first_exported_line=first_exported_line,
        first_expected_line=first_expected_line,
        diff_text=diff_text,
    )


def build_report(
    exported_root: Path,
    expected_root: Path,
    exported_files: dict[str, Path],
    expected_files: dict[str, Path],
    comparisons: list[FileComparison],
    missing_in_export: list[str],
    extra_in_export: list[str],
) -> str:
    exact_matches = [item for item in comparisons if item.status == "exact"]
    normalized_matches = [item for item in comparisons if item.status == "normalized_match"]
    different_files = [item for item in comparisons if item.status == "different"]
    semantic_matches = [item for item in comparisons if item.status == "semantic_match"]

    lines: list[str] = []

    lines.append("=== СРАВНЕНИЕ ПАПОК ===")
    lines.append(f"Экспорт:   {exported_root}")
    lines.append(f"Эталон:    {expected_root}")
    lines.append("")

    lines.append("=== СВОДКА ===")
    lines.append(f"Markdown-файлов в экспорте:        {len(exported_files)}")
    lines.append(f"Markdown-файлов в эталоне:         {len(expected_files)}")
    lines.append(f"Общих файлов по имени:             {len(comparisons)}")
    lines.append(f"Совпали полностью:                 {len(exact_matches)}")
    lines.append(f"Совпали после нормализации:        {len(normalized_matches)}")
    lines.append(f"Совпали по смыслу после markdown-нормализации: {len(semantic_matches)}")
    lines.append(f"Реально различаются:               {len(different_files)}")
    lines.append(f"Отсутствуют в экспорте:            {len(missing_in_export)}")
    lines.append(f"Лишние в экспорте:                 {len(extra_in_export)}")
    lines.append("")

    if missing_in_export:
        lines.append("=== ОТСУТСТВУЮТ В ЭКСПОРТЕ ===")
        for name in missing_in_export:
            lines.append(name)
        lines.append("")

    if extra_in_export:
        lines.append("=== ЛИШНИЕ В ЭКСПОРТЕ ===")
        for name in extra_in_export:
            lines.append(name)
        lines.append("")

    if normalized_matches:
        lines.append("=== СОВПАЛИ ПО СУТИ, НО ОТЛИЧАЮТСЯ ФОРМАТИРОВАНИЕМ ===")
        for item in normalized_matches:
            lines.append(
                f"{item.name} | similarity={item.similarity:.2%} | "
                f"exported {item.exported_lines} lines / {item.exported_chars} chars | "
                f"expected {item.expected_lines} lines / {item.expected_chars} chars"
            )
        lines.append("")

    if semantic_matches:
        lines.append("=== СОВПАЛИ ПО СМЫСЛУ, НО ОТЛИЧАЮТСЯ СТИЛЕМ MARKDOWN ===")
        for item in semantic_matches:
            lines.append(
                f"{item.name} | similarity={item.similarity:.2%} | "
                f"exported {item.exported_lines} lines / {item.exported_chars} chars | "
                f"expected {item.expected_lines} lines / {item.expected_chars} chars"
            )
        lines.append("")

    if different_files:
        lines.append("=== ПОДРОБНЫЕ РАЗЛИЧИЯ ===")
        for item in different_files:
            lines.append(f"[{item.name}]")
            lines.append(f"similarity: {item.similarity:.2%}")
            lines.append(
                f"exported: {item.exported_lines} lines, {item.exported_chars} chars"
            )
            lines.append(
                f"expected: {item.expected_lines} lines, {item.expected_chars} chars"
            )

            if item.first_diff_line_number is not None:
                lines.append(f"first differing line: {item.first_diff_line_number}")
                lines.append(f"exported: {preview_line(item.first_exported_line)}")
                lines.append(f"expected: {preview_line(item.first_expected_line)}")

            lines.append("")
            lines.append(item.diff_text)
            lines.append("")
    else:
        lines.append("=== ПОДРОБНЫЕ РАЗЛИЧИЯ ===")
        lines.append("Содержательные различия не найдены.")
        lines.append("")

    return "\n".join(lines)


def determine_exit_code(
    missing_in_export: list[str],
    extra_in_export: list[str],
    comparisons: list[FileComparison],
) -> int:
    if missing_in_export or extra_in_export:
        return 2

    if any(item.status == "different" for item in comparisons):
        return 2

    if any(item.status == "normalized_match" for item in comparisons):
        return 1
    
    if any(item.status == "semantic_match" for item in comparisons):
        return 1

    return 0
    


def main() -> int:
    try:
        args = parse_args()

        exported_root = validate_directory(args.exported_dir, "Папка с экспортом")
        expected_root = validate_directory(args.expected_dir, "Папка с действительными сообщениями")

        exported_files = collect_markdown_files(exported_root)
        expected_files = collect_markdown_files(expected_root)

        exported_names = set(exported_files)
        expected_names = set(expected_files)

        missing_in_export = sorted(expected_names - exported_names, key=natural_sort_key)
        extra_in_export = sorted(exported_names - expected_names, key=natural_sort_key)
        common_names = sorted(exported_names & expected_names, key=natural_sort_key)

        comparisons = [
            compare_file(name, exported_files[name], expected_files[name])
            for name in common_names
        ]

        report = build_report(
            exported_root=exported_root,
            expected_root=expected_root,
            exported_files=exported_files,
            expected_files=expected_files,
            comparisons=comparisons,
            missing_in_export=missing_in_export,
            extra_in_export=extra_in_export,
        )

        if args.output:
            args.output.write_text(report, encoding="utf-8", newline="\n")
            print(f"Отчёт сохранён: {args.output}", file=sys.stderr)
        else:
            print(report)

        return determine_exit_code(missing_in_export, extra_in_export, comparisons)

    except Exception as error:
        print(f"Ошибка: {error}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())