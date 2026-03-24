"""
兼容包：将 `import core.xxx` 映射到 `backend/core/xxx`。

部分环境只把项目根加入 sys.path 时，无法把 `backend/core` 当作顶层包 `core` 导入；
本包与 `backend/core` 合并为同一逻辑包，避免 No module named 'core'。
"""

from pkgutil import extend_path

__path__ = extend_path(__path__, __name__)
