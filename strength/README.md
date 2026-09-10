# 给 OmbreBrain 换一套像人的遗忘：记忆强度双轨

维护：anko / Rime（tutooth.com）· 2026-09-10 · MIT 授权

## 这个补丁解决什么问题？

[OmbreBrain](https://github.com/p0luz)（下称 OB）会给每段记忆算一个「现在还有多重」的分数，低于阈值就搬进 archive、清掉向量。原版公式是一条固定的指数曲线：

    分数 = 重要度 × 激活次数^0.3 × e^(-0.05 × 天数) × 情绪权重

按默认参数，一段普通记忆 **60 天没被想起就没了**——语义搜索再也搜不到，只剩拿 id 硬翻。

人不是这样忘东西的。你不会因为两个月没想起某件事就把它彻底丢掉；你只是「一时想不起来」，别人一提就全回来了，而且情绪重的、和自己有关的事几乎不会褪。心理学把这两件事分开叫 **存储强度** 和 **提取强度**（Bjork & Bjork，新失用理论）。

这个补丁把 OB 的打分改成这两个数：

| | 含义 | 怎么变 |
|---|---|---|
| **存储强度 S**（1–10） | 这件事在心里有多重 | **只涨不跌**。写入时的重要度是起点，被想起、被改动/追加都往上加（次数每翻一倍加一档，不封顶），当时情绪重涨一点；核心/锚定记忆封顶 10 |
| **提取强度 R**（0–1） | 现在能不能自己浮上来 | **会褪，但一被想起就回满**。半衰期跟着 S 翻倍：S=5 一个月褪一半，S=8 八个月，S≥10 不褪 |

排序分 = S × R × 新鲜度加成 × 紧急加成，量级和原版相当，OB 的浮现排序照用。

**默认不再自动归档**：R 掉到底也只是「不会自己浮上来」，向量留着、搜到就回满。想恢复原版行为，在 config 里把 `decay.archive` 设成 `true` 即可。

## 安装

只改 **1 个文件**（`decay_engine.py`，四处各几行），放 **1 个新文件**（`strength.py`）。有自动安装脚本。

### 第 0 步：确认你要改的代码在哪

OB 支持热更新，真正运行的代码可能在 **数据目录下的 `_app/src/`** 而不是镜像里。先看：

    ls 你的数据目录/_app/src/

有一堆 .py → 改这里；没有这个目录 → 代码在容器里的 `/app/src/`（若源码目录是从宿主机挂载进容器的，直接改宿主机上那份）。

### 第 1 步：跑安装脚本

    python3 install.py --src 上一步的src目录 --dry-run   # 先看会改哪几处
    python3 install.py --src 上一步的src目录             # 真装（自动备份 decay_engine.py）

脚本会：复制 `strength.py` 进 src；在 `decay_engine.py` 扎四针（import、`__init__`、`calculate_score`、归档门），每针带 `[tutooth-strength]` 记号，重复跑会跳过。锚点对不上会直接停手不落盘。只在 **OB 3.2.0** 上试过。

还原：`python3 install.py --src ... --uninstall`。

### 第 2 步：重启 OB 容器

    docker restart 你的容器名

日志里这一行有 `faded` 和 `archive_enabled` 就装对了：

    Decay cycle complete / 衰减周期完成: {'checked': 442, 'archived': 0, 'faded': 17, 'archive_enabled': False, ...}

## 调参（可选）

所有权重在 `strength.py` 顶部的调参面板，也可以在 OB 的 `config.yaml` 里逐项覆盖：

```yaml
strength:
  activation_weight: 0.6      # 激活次数每翻一倍，S +0.6
  edit_weight: 0.6            # 实质改动（正文/感受/为什么留；改标签换夹子不算）次数每翻一倍，S +0.6，不封顶
  mood_weight: 1.5            # 心情幅度满格，S +1.5（见下）
  half_life_base_days: 30     # S = pivot 时的半衰期
  half_life_pivot: 5
  half_life_growth: 2.0       # S 每 +1，半衰期 ×2
  eternal_at: 10              # S ≥ 此值不褪
  resolved_factor: 0.5        # 已处理的记忆半衰期减半
  mood_axis_full: 8           # 轴幅度多少算满格（按你家标签的实际分布定）
decay:
  archive: false              # true 才恢复原版「低分搬进 archive」
  threshold: 0.3              # R 低于它算「正在变淡」（只计数）
```

「心情幅度」读取的是本扩展约定的标签写法：tags 里有 `天气:落雪` / `轴:思念+8` 这种就算，没有就是 0，不影响别人使用。天气除放晴外一律 0.7（盖天气的规则本身就是「某根轴过了线」，下雪和雷暴一样重），轴按幅度除以满格。「实质改动次数」从 OB 3.2 的事件账本 `_ledger/events.jsonl` 数，账本不在就当 0。

## 在容器外单独用

`strength.py` 不依赖 OB 其它代码，可以直接 import 给面板、导出脚本算分（本仓库的 orrery/ 就是这样用的）：

```python
import sys; sys.path.insert(0, "补丁包目录")
from strength import StrengthModel
m = StrengthModel(config_dict, ledger_path="数据目录/_ledger/events.jsonl")
m.strength(bucket_frontmatter_dict, bucket_id)
# → {'storage': 7.3, 'retrieval': 0.91, 'half_life': 147.7, 'days_since': 20.1, 'score': 6.6}
```

## 一句话

记忆只会淡，不会丢。淡了的，一提就回来。
