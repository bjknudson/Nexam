# Third-party licenses

Nexam itself is licensed under the GNU General Public License v3.0 or
later — see [LICENSE](LICENSE). This file documents the licenses of
the open-source components it's built on.

## Why GPL-3.0-or-later

Every dependency across Nexam's three toolchains — Python, npm, and
Cargo — uses a permissive license (MIT, Apache-2.0, BSD, ISC, Zlib,
0BSD, Unlicense, Unicode-3.0) or a weak/file-level copyleft license
that is explicitly compatible with combination into a GPL-licensed
work (MPL-2.0, Boost-1.0). None of them require or forbid any
particular license for Nexam itself, so GPL-3.0-or-later was chosen
deliberately: it's a share-alike license, meaning anyone who
distributes a modified version of Nexam has to pass the same
freedoms — including source access — on to their users.

The one build-time exception is [PyInstaller](https://pyinstaller.org),
which is GPLv2-licensed but ships with an explicit bootloader
exception: compiled programs produced with it (including the
`nexam-backend` binary bundled into Nexam's releases) may be
distributed under any license, GPL or not. That exception is what
makes it possible to freeze the backend at all without it dictating
Nexam's license. See PyInstaller's `COPYING.txt` /
[license FAQ](https://pyinstaller.org/en/stable/license.html) for the
exact text.

## Backend (Python) — frozen into the packaged app

Collected from the active virtualenv with `pip-licenses`, filtered to
what `requirements.txt` (and its `uvicorn[standard]` extras) actually
pulls in and PyInstaller freezes into `nexam-backend`:

| Package | License |
| --- | --- |
| fastapi | MIT |
| starlette | BSD-3-Clause |
| pydantic | MIT |
| pydantic_core | MIT |
| annotated-types | MIT |
| typing-inspection | MIT |
| typing_extensions | PSF-2.0 |
| uvicorn | BSD-3-Clause |
| click | BSD-3-Clause |
| h11 | MIT |
| httptools | MIT |
| websockets | BSD-3-Clause |
| watchfiles | MIT |
| uvloop | Apache-2.0 / MIT |
| python-dotenv | BSD-3-Clause |
| PyYAML | MIT |
| anyio | MIT |
| idna | BSD-3-Clause |
| packaging | Apache-2.0 OR BSD-2-Clause |
| python-multipart | Apache-2.0 |

Development-only tooling (`requirements-dev.txt`; not distributed in
any release build): pytest, httpx, httpcore, certifi, pluggy,
iniconfig, Pygments (test runner and its own deps), plus PyInstaller
and pyinstaller-hooks-contrib, altgraph, and macholib (the freezer
itself — see the bootloader exception above).

## Frontend (npm) — bundled into the app's UI

Collected with `license-checker --production` against
`app/frontend/package.json`:

| Package | License |
| --- | --- |
| react | MIT |
| react-dom | MIT |
| react-katex | MIT |
| katex | MIT |
| @tauri-apps/api | Apache-2.0 OR MIT |
| (transitive: scheduler, prop-types, react-is, object-assign, loose-envify, js-tokens) | MIT |

## Desktop shell (Rust / Cargo, `src-tauri`)

Collected with `cargo metadata` against the full resolved dependency
graph (550 crates, direct + transitive, including Tauri itself and
everything it pulls in):

| License | Crate count |
| --- | --- |
| MIT OR Apache-2.0 (and equivalent orderings/separators) | ~460 |
| Unicode-3.0 | 18 |
| MPL-2.0 | 7 |
| Unlicense OR MIT | 4 |
| BSD-3-Clause | 3 |
| ISC | 3 |
| Zlib | 2 |
| Apache-2.0 | 2 |
| MIT OR Apache-2.0 OR LGPL-2.1-or-later | 2 |
| 0BSD OR MIT OR Apache-2.0 | 1 |
| BSD-3-Clause AND MIT | 1 |
| CC0-1.0 OR MIT-0 OR Apache-2.0 | 1 |
| Apache-2.0 OR BSL-1.0 | 1 |
| CDLA-Permissive-2.0 | 1 |

Direct dependencies from `src-tauri/Cargo.toml`: `tauri`, `serde`,
`serde_json` (MIT OR Apache-2.0), `anyhow` (MIT OR Apache-2.0), `rfd`
(MIT), `reqwest` (MIT OR Apache-2.0), `tauri-build` (build-dependency,
MIT OR Apache-2.0).

The complete, ungrouped list of all 550 crates with their individual
licenses is in
[contributor/rust-dependency-licenses.txt](contributor/rust-dependency-licenses.txt),
generated with:

```bash
cargo metadata --format-version 1 --manifest-path src-tauri/Cargo.toml
```

## Fonts

KaTeX bundles the KaTeX fonts (derived from Computer Modern / STIX/
Latin Modern) under its own MIT license, included above.
