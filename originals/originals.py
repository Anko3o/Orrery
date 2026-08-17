"""
========================================
originals.py — 原文侧车（兔牙家魔改 8-17「原文永存计划」，非上游文件）
========================================

立场：任何会**有损重写**桶正文的路径，动笔之前必须先把将被搅碎的东西
原样送进侧车。侧车是档案馆，不是工作台——append-only，永不参与
合并、脱水、遗忘，也不进检索评分。

落盘位置（在 buckets 数据目录内，跟着数据卷走，升级镜像不丢）：
    <buckets>/_originals/<bucket_id>.md     每桶一档：历次被搅碎前的正文快照
    <buckets>/_originals/<grow_batch_id>.md grow 整篇日记原稿（g_ 前缀天然区分）

格式：纯 Markdown，每条一段——
    ## <本地ISO时间> · <来源>[ · <备注>]
    <原文原样>

边界（学上游 dehydrator 的规矩写明白）：
- 只追加，不读取、不修改、不删除（读取归展示层：orrery-export / 天仪）
- 写失败不打断主流程——存档器不能反过来弄死记忆写入，但必须大声记日志
"""

import os
from datetime import datetime, timezone

DIRNAME = "_originals"


def _archive_dir(base_dir: str) -> str:
    d = os.path.join(base_dir, DIRNAME)
    os.makedirs(d, exist_ok=True)
    return d


def append_original(base_dir: str, key: str, source: str, text: str, note: str = "") -> bool:
    """append-only 存一条原文。key = bucket_id 或 grow_batch_id。

    返回是否真的写了（空文本/写失败返回 False，失败由调用方记日志）。
    key 过 basename 清洗，防止拼出目录外路径。
    """
    text = (text or "").strip()
    if not text:
        return False
    key = os.path.basename(key.strip())
    if not key:
        return False
    ts = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
    head = f"## {ts} · {source}" + (f" · {note}" if note else "")
    path = os.path.join(_archive_dir(base_dir), f"{key}.md")
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(head + "\n\n" + text + "\n\n")
    return True
