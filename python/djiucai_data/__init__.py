"""韭菜军团 Python 数据子进程包（dsh-jiucai-legion，技术设计 §6）。

职责（需求 #22–#25 / #32–#42 / #45–#47）：
- 指数日线 / 交易日历 / 市场宽度 / 情绪热度双源 / 新闻双源 / 资金面
- 分级降级与 degraded 标注、本地全量缓存、Asia/Shanghai 时区
- 行式 JSON 协议子进程（protocol / cli），供 TS 宿主经 SubprocessPort 拉起

按需导入（akshare 导入较慢，本包 ``__init__`` 不做重导入）::

    from djiucai_data import protocol          # 协议层
    from djiucai_data.snapshot import get_snapshot
"""

from ._common import SHANGHAI_TZ, fmt_ts, now_sh, today_sh

__version__ = "0.1.0"

__all__ = [
    "__version__",
    "SHANGHAI_TZ",
    "fmt_ts",
    "now_sh",
    "today_sh",
]
