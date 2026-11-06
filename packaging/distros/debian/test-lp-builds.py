#!/usr/bin/env python3
"""Test Launchpad build verdicts with a recorded response and a curl stand-in.

The fixture is chan 0.124.0-1~noble1, sourcepub/18924332, read anonymously
from https://api.launchpad.net/1.0/ with ws.op=getBuilds on 2026-11-06.
No server or network request runs in this suite.
"""

from __future__ import annotations

import copy
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "lp-builds.sh"
API = "https://api.launchpad.net/1.0"
ARCHIVE = f"{API}/~fiorix/+archive/ubuntu/chan"
PUBLICATION = f"{ARCHIVE}/+sourcepub/18924332"
VERSION = "0.124.0-1~noble1"
FIXTURE = json.loads((HERE / "lp-builds-fixture.json").read_text())
SOURCES = {"start": 0, "total_size": 1, "entries": [{
    "source_package_name": "chan", "source_package_version": VERSION,
    "distro_series_link": f"{API}/ubuntu/noble", "status": "Published", "self_link": PUBLICATION,
}]}
STUB = '''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
root = Path(os.environ["LP_TEST_DIR"])
count = root / "count"
index = int(count.read_text()) if count.exists() else 0
requests = json.loads((root / "requests.json").read_text())
if index >= len(requests):
    sys.exit("unexpected extra API call")
request = requests[index]
if sys.argv[1:] != request["args"]:
    sys.exit(f"unexpected curl args: {sys.argv[1:]!r}; expected {request['args']!r}")
count.write_text(str(index + 1))
print(request["response"])
sys.exit(request.get("status", 0))
'''


def request(url: str, response: object, *query: str, status: int = 0) -> dict:
    args = ["-fsS", "--max-time", "30", "-G", url]
    for parameter in query:
        args.extend(["--data-urlencode", parameter])
    return {"args": args, "response": json.dumps(response), "status": status}


def source_request(response: object = SOURCES) -> dict:
    return request(ARCHIVE, response, "ws.op=getPublishedSources", "source_name=chan",
                   f"version={VERSION}", "exact_match=true")


def build_request(response: object) -> dict:
    return request(PUBLICATION, response, "ws.op=getBuilds")


class LaunchpadBuildTests(unittest.TestCase):
    def run_reader(self, requests: list[dict], expected: int, stdout: str | None = None,
                   arguments: list[str] | None = None) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "curl").write_text(STUB)
            (root / "curl").chmod(0o755)
            (root / "requests.json").write_text(json.dumps(requests))
            env = {**os.environ, "PATH": f"{root}{os.pathsep}{os.environ['PATH']}",
                   "LP_TEST_DIR": directory, "LP_API_BASE": "https://api.launchpad.net", "PPA": "ppa:fiorix/chan"}
            result = subprocess.run(["bash", str(SCRIPT), *(arguments if arguments is not None else ["chan", VERSION, "noble"])],
                                    text=True, capture_output=True, env=env, timeout=10)
            self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
            if stdout is not None:
                self.assertEqual(result.stdout, stdout)
            calls = int((root / "count").read_text()) if (root / "count").exists() else 0
            self.assertEqual(calls, len(requests), result.stderr)
            return result

    def test_recorded_failed_builds(self) -> None:
        self.run_reader([source_request(), build_request(FIXTURE)], 1, "amd64 Failed to build\narm64 Failed to build\n")

    def test_all_successful(self) -> None:
        builds = copy.deepcopy(FIXTURE)
        for build in builds["entries"]:
            build["buildstate"] = "Successfully built"
        self.run_reader([source_request(), build_request(builds)], 0,
                        "amd64 Successfully built\narm64 Successfully built\n",
                        ["--verbose", "chan", VERSION, "noble"])

    def test_pending_and_failed_precedence(self) -> None:
        for state in ("Needs building", "Currently building", "Dependency wait", "Uploading build", "Cancelling build", "Gathering build output"):
            with self.subTest(state=state):
                builds = copy.deepcopy(FIXTURE)
                builds["entries"][0]["buildstate"] = "Successfully built"
                builds["entries"][1]["buildstate"] = state
                self.run_reader([source_request(), build_request(builds)], 3)
                builds["entries"][0]["buildstate"] = "Failed to build"
                self.run_reader([source_request(), build_request(builds)], 1)

    def test_other_terminal_failures(self) -> None:
        for state in ("Failed to upload", "Cancelled build", "Chroot problem", "Build for superseded Source"):
            with self.subTest(state=state):
                builds = copy.deepcopy(FIXTURE)
                for build in builds["entries"]:
                    build["buildstate"] = state
                self.run_reader([source_request(), build_request(builds)], 1)

    def test_missing_publication_and_empty_builds(self) -> None:
        empty = {"start": 0, "total_size": 0, "entries": []}
        self.run_reader([source_request(empty)], 1, f"no publication: chan {VERSION} noble\n")
        self.run_reader([source_request(), build_request(empty)], 3, "")
        sources = copy.deepcopy(SOURCES)
        sources["entries"][0]["distro_series_link"] = f"{API}/ubuntu/resolute"
        self.run_reader([source_request(sources)], 1)

    def test_malformed_and_unknown_shapes(self) -> None:
        for response in (None, {}, {"entries": []}, "garbage"):
            with self.subTest(response=response):
                self.run_reader([source_request(response)], 2)
        broken = source_request()
        broken["response"] = "not JSON"
        self.run_reader([broken], 2)
        self.run_reader([source_request(), build_request({})], 2)
        sources = copy.deepcopy(SOURCES)
        sources["entries"][0]["status"] = "Unknown"
        self.run_reader([source_request(sources)], 2)
        builds = copy.deepcopy(FIXTURE)
        builds["entries"][0]["buildstate"] = "Unknown"
        self.run_reader([source_request(), build_request(builds)], 2)
        builds = copy.deepcopy(FIXTURE)
        del builds["entries"][0]["arch_tag"]
        self.run_reader([source_request(), build_request(builds)], 2)
        builds = copy.deepcopy(FIXTURE)
        builds["entries"][0]["source_package_version"] = "0.116.0-1~noble1"
        self.run_reader([source_request(), build_request(builds)], 2)

    def test_network_and_usage_errors(self) -> None:
        broken = source_request()
        broken["status"] = 22
        self.run_reader([broken], 2)
        self.run_reader([], 2, arguments=[])

    def test_source_and_build_pagination_reaches_later_failure(self) -> None:
        sources = copy.deepcopy(SOURCES)
        sources["entries"].insert(0, {**sources["entries"][0], "distro_series_link": f"{API}/ubuntu/resolute"})
        first = {"start": 0, "total_size": 2, "entries": sources["entries"][:1], "next_collection_link": f"{ARCHIVE}?page=2"}
        last = {"start": 1, "total_size": 2, "entries": sources["entries"][1:]}
        builds = copy.deepcopy(FIXTURE)
        builds["entries"][0]["buildstate"] = "Successfully built"
        page1 = {"start": 0, "total_size": 2, "entries": builds["entries"][:1], "next_collection_link": f"{PUBLICATION}?page=2"}
        page2 = {"start": 1, "total_size": 2, "entries": builds["entries"][1:]}
        self.run_reader([source_request(first), request(f"{ARCHIVE}?page=2", last), build_request(page1),
                         request(f"{PUBLICATION}?page=2", page2)], 1,
                        "amd64 Successfully built\narm64 Failed to build\n")

    def test_truncated_or_foreign_pagination_refuses(self) -> None:
        builds = copy.deepcopy(FIXTURE)
        builds["entries"] = builds["entries"][:1]
        self.run_reader([source_request(), build_request(builds)], 2)
        builds["next_collection_link"] = "https://example.org/page2"
        self.run_reader([source_request(), build_request(builds)], 2)


if __name__ == "__main__":
    unittest.main()
