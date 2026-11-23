#!/usr/bin/env python3
"""Exercise page assembly without installed terminal packages or a browser."""

from __future__ import annotations

import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


DRIVER = Path(__file__).resolve().parents[1] / "terminal-pixels.py"
SPEC = importlib.util.spec_from_file_location("terminal_pixels", DRIVER)
assert SPEC is not None and SPEC.loader is not None
pixels = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pixels)


class ServeDirectoryTest(unittest.TestCase):
    def test_assembles_with_only_widget_build_outputs(self) -> None:
        # Only the widget build is stubbed. The driver's asset checks, symlinks,
        # font injection and emitted-file checks execute over a real tree.
        with tempfile.TemporaryDirectory() as temp:
            work = Path(temp)
            web = work / "web"
            app = web / "packages/workspace-app"
            (app / "src/fonts").mkdir(parents=True)
            fonts_css = app / "src/fonts.css"
            fonts_css.write_text('@font-face { font-family: "fixture"; }')
            served = work / "served"
            served.mkdir()

            def compile_module(argv: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
                self.assertEqual(argv[0], "node")
                self.assertEqual(argv[1], str(pixels.BUILD_GHOSTTY))
                output = Path(argv[2]) / "ghostty-web.js"
                output.parent.mkdir(parents=True)
                output.write_text("export {};\n")
                return subprocess.CompletedProcess(argv, 0, "", "")

            with (
                patch.object(pixels, "WEB", web),
                patch.object(pixels, "WORKSPACE_APP", app),
                patch.object(pixels, "FONTS_CSS", fonts_css),
                patch.object(pixels.shutil, "which", return_value="node"),
                patch.object(pixels.subprocess, "run", side_effect=compile_module) as builds,
            ):
                pixels.build_serve_dir(served)

            self.assertEqual(builds.call_count, 1)
            self.assertEqual([p.name for p in (served / "vendor").iterdir()], ["ghostty-web-ng"])
            self.assertTrue((served / "harness.mjs").is_symlink())
            self.assertEqual((served / "fonts").resolve(), app / "src/fonts")
            page = (served / "index.html").read_text()
            self.assertIn('@font-face { font-family: "fixture"; }', page)
            self.assertNotIn("<!--CHAN_FONT_FACE-->", page)
            self.assertFalse((served / "product").exists())


if __name__ == "__main__":
    unittest.main()
