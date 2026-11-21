"""Load the plugin directory as the package ``botkins_import_plugin``, as the Hermes loader does."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

PACKAGE = "botkins_clone_plugin"
_ROOT = Path(__file__).resolve().parents[1]
sys.path[:] = [p for p in sys.path if Path(p or ".").resolve() != _ROOT]

if PACKAGE not in sys.modules:
    spec = importlib.util.spec_from_file_location(
        PACKAGE, _ROOT / "__init__.py", submodule_search_locations=[str(_ROOT)])
    module = importlib.util.module_from_spec(spec)
    sys.modules[PACKAGE] = module
    spec.loader.exec_module(module)
