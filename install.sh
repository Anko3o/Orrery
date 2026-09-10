#!/bin/bash
# OmbreBrain Mods · 一键安装（前后端整套）
# 用法：
#   bash install.sh --src /path/to/ob/src [--web /path/to/static/site/orrery] [--dry-run]
# 做的事（按顺序，任一步失败即停）：
#   1. strength/   记忆强度双轨 → 扎进 decay_engine.py
#   2. settings/   设置接口     → 扎进 web/buckets.py
#   3. orrery/     记忆天仪     → 复制到 --web 指定的静态目录（不给 --web 就跳过）
#   4. 提示你改 orrery/orrery-export.py 的 PROFILES 并加一条定时任务
# originals/（原文备份）是可选的，锚点分布在两个文件里，按 originals/README.md 手动扎针。
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC=""; WEB=""; DRY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --src) SRC="$2"; shift 2;;
    --web) WEB="$2"; shift 2;;
    --dry-run) DRY="--dry-run"; shift;;
    *) echo "不认识的参数: $1"; exit 1;;
  esac
done
[ -n "$SRC" ] || { echo "要 --src /path/to/ob/src（里面有 decay_engine.py 和 web/buckets.py）"; exit 1; }
[ -f "$SRC/decay_engine.py" ] && [ -f "$SRC/web/buckets.py" ] || { echo "$SRC 里没找到 decay_engine.py / web/buckets.py"; exit 1; }

echo "== 1/4 strength（记忆强度双轨）"
python3 "$HERE/strength/install.py" --src "$SRC" $DRY
echo "== 2/4 settings（设置接口）"
python3 "$HERE/settings/install.py" --src "$SRC" $DRY
if [ -n "$WEB" ]; then
  echo "== 3/4 orrery（记忆天仪）→ $WEB"
  if [ -z "$DRY" ]; then
    mkdir -p "$WEB/data"
    cp "$HERE"/orrery/{index.html,app.js,styles.css,spine.js,spine.css,edit.js,motion.css} "$WEB/"
    echo "  ✓ 页面已复制；data/ 由导出脚本填"
  else
    echo "  dry-run：会把 orrery/ 的 7 个文件复制到 $WEB/"
  fi
else
  echo "== 3/4 orrery：没给 --web，跳过（页面在 $HERE/orrery/，自己放到静态站即可）"
fi
echo "== 4/4 收尾"
cat <<TXT
  - 重启 OB 容器让 1、2 生效：docker restart <容器名>
  - 打开 $HERE/orrery/orrery-export.py，把 PROFILES 里的 buckets / output 改成你的路径
  - 定时导出（每 15 分钟一次即可）：
      */15 * * * * python3 $HERE/orrery/orrery-export.py --brain rime >/dev/null 2>&1
  - 想让天仪能编辑桶、拧设置：按 orrery/README.md 配一条 /ob-api/rime/ 反代
  - 可选：originals/（原文备份）按 originals/README.md 手动扎两针
TXT
echo "装完了。"
