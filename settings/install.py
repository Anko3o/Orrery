#!/usr/bin/env python3
"""把「设置 API」(/api/settings/surfacing) 装进 OmbreBrain 3.2.0 的 web/buckets.py。
出品：anko & Rime（tutooth.com）· MIT
用法：
    python3 install.py --src /path/to/ob/src            # 安装（先自动备份 web/buckets.py）
    python3 install.py --src /path/to/ob/src --dry-run
    python3 install.py --src /path/to/ob/src --uninstall
做的事：把 settings_block.py 里那段端点代码，插到 web/buckets.py 里 human 设置端点的前面
（锚点：`# ---- iter 2.0: /api/settings/human`），带 `[tutooth-settings]` 记号，重复运行跳过。
前置：先装好本仓库的 strength/（端点热重建的是它的 StrengthModel）。
"""
import argparse, os, shutil, sys, ast
HERE = os.path.dirname(os.path.abspath(__file__))
MARK = "[tutooth-settings]"
ANCHOR = "    # ---- iter 2.0: /api/settings/human"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True); ap.add_argument("--dry-run", action="store_true"); ap.add_argument("--uninstall", action="store_true")
    a = ap.parse_args()
    target = os.path.join(a.src, "web", "buckets.py"); backup = target + ".bak-before-settings"
    if not os.path.exists(target): sys.exit(f"没找到 {target}")
    if a.uninstall:
        if not os.path.exists(backup): sys.exit("没有备份可还原")
        shutil.copy2(backup, target); print("已还原"); return
    text = open(target, encoding="utf-8").read().replace("\r\n", "\n")
    if MARK in text: print("已经装过了，跳过"); return
    if text.count(ANCHOR) != 1: sys.exit("锚点不是正好 1 处，你的 buckets.py 可能不是 3.2.0")
    block = open(os.path.join(HERE, "settings_block.py"), encoding="utf-8").read()
    block = block.replace("# ---- 9-10 tutooth：/api/settings/surfacing", f"# ---- {MARK} /api/settings/surfacing", 1)
    new = text.replace(ANCHOR, block + ANCHOR, 1)
    ast.parse(new)
    print("  ✓ 端点插入 web/buckets.py")
    if a.dry_run: print("dry-run，未落盘"); return
    if not os.path.exists(backup): shutil.copy2(target, backup); print(f"  备份 → {backup}")
    open(target, "w", encoding="utf-8").write(new)
    print("装好了。重启 OB 容器生效；登录后 GET /api/settings/surfacing 能看到三组设置就对了。")

if __name__ == "__main__":
    main()
