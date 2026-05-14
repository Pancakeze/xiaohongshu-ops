from __future__ import annotations

import argparse
from pathlib import Path

from app.playwright_google.runner import run_gemini_image_turn


def main() -> int:
    parser = argparse.ArgumentParser(description="Run Gemini web image generation via Playwright")
    parser.add_argument("--prompt", required=True, help="Prompt text")
    parser.add_argument("--user-data-dir", required=True, help="Chrome profile dir (ignored when using --cdp-url; still used as a writable scratch path)")
    parser.add_argument(
        "--cdp-url",
        default=None,
        help="Connect to an already-running Chrome via CDP (e.g. http://127.0.0.1:9222). Login in that Chrome window first.",
    )
    parser.add_argument("--output-dir", required=True, help="Directory to save downloaded images")
    parser.add_argument("--headless", action="store_true", help="Run headless (debugging is harder)")
    parser.add_argument("--min-images", type=int, default=1, help="Minimum images to wait for")
    args = parser.parse_args()

    images, _ = run_gemini_image_turn(
        prompt=args.prompt,
        user_data_dir=Path(args.user_data_dir),
        output_dir=Path(args.output_dir),
        headless=args.headless,
        min_images=args.min_images,
        cdp_url=(args.cdp_url.strip() if args.cdp_url else None),
    )
    for img in images:
        print(str(img.local_path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

