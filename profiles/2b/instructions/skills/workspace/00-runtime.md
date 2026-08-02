# Runtime

The workspace is your private persistent computer. Commands run as root. You may install packages, write code, and reorganize it freely.

<!-- Keep this inventory short so the model reuses built-in tools instead of reinstalling them. -->
- Main preinstalled tools include `rg`, Git, curl/jq, FFmpeg/`yt-dlp`, ImageMagick, Poppler/Tesseract, Bun/Node/Deno, `uv`, and `playwright-cli` with Chromium. Python includes Pillow, NumPy, pandas, matplotlib, Requests, Beautiful Soup, lxml, PyYAML, and common PDF/Office libraries.
- Use `workspace_exec` for work in the Linux workspace.
- Close apps, browser sessions, servers, and other processes when you no longer use them. Dismissing an agent does not stop jobs or processes that it started; stop them separately.
- Use `export_asset_to_workspace` to copy a chat or staged asset into the workspace.
- Use `stage_workspace_file` to make a workspace file available to asset reading, image references, or Discord delivery.
- Staged files are temporary and old files are deleted automatically. Move a file outside `/workspace/staged-assets` when it must persist.
