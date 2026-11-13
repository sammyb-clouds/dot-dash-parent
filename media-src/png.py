"""PNG in/out for build.py -- the stdlib reader/writer screen.py already has.

build.py has always done `import png` and called png.load(); this module was
not committed with it on 2026-11-05, so the generator could not be rerun.
It adds nothing: it re-exports screen.py's functions under the names
build.py uses, so there is one PNG decoder in this folder, not two.
"""
from screen import load_png as load, save_png as save   # noqa: F401
