from __future__ import annotations

import json
import sys
from pathlib import Path

# Apply limits before importing parsers/native libraries. macOS does not
# reliably enforce RLIMIT_AS; its wall-clock/output limits still apply.
import resource

resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
resource.setrlimit(resource.RLIMIT_CPU, (90, 90))
resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
if sys.platform.startswith("linux"):
    resource.setrlimit(resource.RLIMIT_AS, (1610612736, 1610612736))

from markitdown import MarkItDown


MAX_MARKDOWN_BYTES = 8 * 1024 * 1024
MAX_TITLE_CHARACTERS = 500


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: worker.py <document>", file=sys.stderr)
        return 2

    source = Path(sys.argv[1])
    try:
        result = MarkItDown(enable_plugins=False).convert_local(source)
        markdown = result.markdown
        if not isinstance(markdown, str):
            raise RuntimeError("MarkItDown returned a non-text result")
        if len(markdown.encode("utf-8")) > MAX_MARKDOWN_BYTES:
            raise RuntimeError("converted Markdown exceeds the 8 MiB limit")
        title = result.title if isinstance(result.title, str) else None
        if title is not None:
            title = title.strip()[:MAX_TITLE_CHARACTERS] or None
        sys.stdout.write(json.dumps({
            "version": 1,
            "engine": "markitdown",
            "title": title,
            "markdown": markdown,
        }, ensure_ascii=False))
        return 0
    except Exception as error:  # MarkItDown normalizes format-specific errors poorly.
        message = str(error).replace("\n", " ").replace("\r", " ")[:1000]
        print(f"{type(error).__name__}: {message}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
