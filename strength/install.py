#!/usr/bin/env python3
"""
把「记忆强度双轨」装进 OmbreBrain 3.2.0 的 decay_engine.py。
出品：安可 & 小雾/Rime（tutooth.com）· MIT

用法：
    python3 install.py --src /path/to/ob/src            # 安装（先自动备份 decay_engine.py）
    python3 install.py --src /path/to/ob/src --dry-run  # 只看会改哪几处，不落盘
    python3 install.py --src /path/to/ob/src --uninstall # 用备份还原

做的事：
  1. 把同目录的 strength.py 复制进 src/（跟 decay_engine.py 放一起）
  2. 在 decay_engine.py 上扎四针（每针都带 `[tutooth-strength]` 记号，重复运行会跳过）：
     A. import 里加一行 `from strength import StrengthModel`
     B. DecayEngine.__init__ 末尾挂上 self.strength_model / self.archive_enabled
     C. calculate_score() 里 dynamic 桶的打分换成 S × R × 新鲜度 × 紧急
        （permanent / feel / plan / letter 的固定分照旧）
     D. run_decay_cycle() 里「低于阈值 → 归档」改成「只计数 faded；decay.archive=true 才归档」
  不动别的文件，不动数据。
"""
import argparse
import os
import shutil
import sys

MARK = "[tutooth-strength]"
HERE = os.path.dirname(os.path.abspath(__file__))

NEEDLES = [
    # A. import
    ("A import",
     "from utils import parse_bool, parse_iso_datetime\n",
     "from utils import parse_bool, parse_iso_datetime\n"
     f"from strength import StrengthModel  # {MARK}\n"),
    # B. __init__
    ("B __init__",
     "        self.bucket_mgr = bucket_mgr\n",
     "        self.bucket_mgr = bucket_mgr\n"
     f"        # {MARK} 记忆强度双轨：存储强度只涨、提取强度会褪；默认不再自动归档\n"
     "        _base_dir = getattr(bucket_mgr, \"base_dir\", None) or config.get(\"buckets_dir\") or \"\"\n"
     "        self.strength_model = StrengthModel(\n"
     "            config, ledger_path=os.path.join(_base_dir, \"_ledger\", \"events.jsonl\") if _base_dir else \"\")\n"
     "        self.archive_enabled = self.strength_model.archive_enabled\n"),
    # C. calculate_score：从 importance 解析到 return，整段换掉
    ("C calculate_score",
     None,  # 特殊处理：按起止锚点切
     None),
    # D. 归档门
    ("D archive gate",
     "            if score < self.threshold:\n"
     "                try:\n"
     "                    success = await self.bucket_mgr.archive(bucket[\"id\"])\n",
     f"            # {MARK} 提取强度低于阈值只计数，不搬走；decay.archive=true 才走老式归档\n"
     "            if self.strength_model.retrieval_strength(meta) < self.threshold:\n"
     "                faded += 1\n"
     "            if self.archive_enabled and score < self.threshold:\n"
     "                try:\n"
     "                    success = await self.bucket_mgr.archive(bucket[\"id\"])\n"),
    ("D faded counter",
     "        demoted_orphans = 0\n        for bucket in buckets:\n",
     f"        demoted_orphans = 0\n        faded = 0  # {MARK}\n        for bucket in buckets:\n"),
    ("D result",
     "            \"archived\": archived,\n",
     f"            \"archived\": archived,\n            \"faded\": faded,  # {MARK}\n"
     "            \"archive_enabled\": self.archive_enabled,\n"),
]

C_START = "        try:\n            importance = max(1, min(10, int(metadata.get(\"importance\", _DEFAULT_IMPORTANCE))))"
C_END = "        return round(base_score * resolved_factor * urgency_boost, 4)"
C_NEW = (f"        # {MARK} S × R × 新鲜度 × 紧急（旧公式见 strength.py 头注释）\n"
         "        return self.strength_model.score(metadata, str(metadata.get(\"id\") or \"\"))")


def patch(text: str, dry: bool) -> str:
    if MARK in text:
        print("已经装过了（找到记号），跳过扎针。")
        return text
    text = text.replace("\r\n", "\n")
    if "import os\n" not in text.split("class DecayEngine")[0]:
        text = text.replace("import math\n", "import math\nimport os\n", 1)
    for name, old, new in NEEDLES:
        if old is None:
            a, b = text.find(C_START), text.find(C_END)
            if a < 0 or b < 0:
                sys.exit(f"针 {name} 找不到锚点，你的 decay_engine.py 版本可能不是 3.2.0")
            text = text[:a] + C_NEW + text[b + len(C_END):]
            print(f"  ✓ {name}")
            continue
        if text.count(old) != 1:
            sys.exit(f"针 {name} 锚点出现 {text.count(old)} 次（要求正好 1 次），停手。")
        text = text.replace(old, new, 1)
        print(f"  ✓ {name}")
    return text


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="OB 源码目录（里面有 decay_engine.py）")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--uninstall", action="store_true")
    a = ap.parse_args()
    target = os.path.join(a.src, "decay_engine.py")
    backup = target + ".bak-before-strength"
    if not os.path.exists(target):
        sys.exit(f"没找到 {target}")
    if a.uninstall:
        if not os.path.exists(backup):
            sys.exit("没有备份可还原")
        shutil.copy2(backup, target)
        print("已还原 decay_engine.py（strength.py 留着不碍事，想删自己删）")
        return
    text = open(target, encoding="utf-8").read()
    new = patch(text, a.dry_run)
    if a.dry_run:
        print("dry-run，未落盘。")
        return
    if new != text:
        if not os.path.exists(backup):
            shutil.copy2(target, backup)
            print(f"  备份 → {backup}")
        open(target, "w", encoding="utf-8").write(new)
    shutil.copy2(os.path.join(HERE, "strength.py"), os.path.join(a.src, "strength.py"))
    print("  ✓ strength.py 已放入 src")
    import ast
    ast.parse(new)
    print("装好了。重启 OB 容器生效；日志里看 `Decay cycle complete` 那行有 faded / archive_enabled 就对了。")


if __name__ == "__main__":
    main()
