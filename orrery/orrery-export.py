#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把两座 OB 的真实记忆桶抽成天仪用的 JSON。
只抽元数据 + 正文首段摘要；输出目录被 anko-vutlr-sync 的 --exclude=data 排除，
再由 .gitignore 挡住 pai 快照，不进 git 历史、不出服务器。
用法:
  python3 /root/orrery-export.py --brain rime
  python3 /root/orrery-export.py --brain feylor
"""
import argparse
import json
import math
import os
import re
import shutil
import sqlite3
from datetime import datetime

# ── 改成你自己的路径：数据目录（OB 的 buckets）、输出到天仪页面的 data/ 里。
#    一座 OB 一条；只有一座就留一条，页面右上角的 RESIDENT 切换会指向不存在的文件，可在 index.html 里删掉那个 nav。
HERE = os.path.dirname(os.path.abspath(__file__))
PROFILES = {
    "rime": {
        "buckets": "/opt/ombre-brain/buckets",                   # ← 你的 OB 数据目录
        "engine_src": os.path.join(HERE, "..", "strength"),       # 记忆强度模块（本仓库 strength/）
        "output": os.path.join(HERE, "data", "orrery.json"),      # ← 天仪页面目录下的 data/
        "source": "ombre-brain (18002)",
        "resident": "Rime",
    },
    "feylor": {
        "buckets": "/opt/ombre-brain-chatgpt/buckets",
        "engine_src": os.path.join(HERE, "..", "strength"),
        "output": os.path.join(HERE, "data", "orrery-feylor.json"),
        "source": "ombre-brain-chatgpt (18001)",
        "resident": "Feylor",
    },
}

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("legacy_output", nargs="?", help="兼容旧用法的输出路径")
parser.add_argument("--brain", choices=sorted(PROFILES), default="rime")
parser.add_argument("--output", help="覆盖默认输出路径")
parser.add_argument("--recut", action="store_true", help="9-10 钉住的团全部作废，重新聚一次（平时不用）")
parser.add_argument("--rename", metavar="旧名=新名", help="给某条轨道改名，改完退出")
args = parser.parse_args()
PROFILE = PROFILES[args.brain]
BUCKETS = PROFILE["buckets"]
KINDS = ("permanent", "dynamic", "plans", "letters")
OUT = args.output or args.legacy_output or PROFILE["output"]

# OB config.yaml 里的真实衰减参数
LAMBDA = 0.05
THRESHOLD = 0.3

# ── 9-10 记忆强度双轨：直接借 OB 补丁包里的 strength.py 算，天仪和 wake 一套公式 ──
# storage（存储强度 1–10，只涨不跌）当深轴；retrieval（提取强度 0–1）替代旧 clarity；
# FADING = retrieval < threshold（只是「不会自己浮上来」，不是没了）。
import sys
sys.path.insert(0, PROFILE["engine_src"])
try:
    import yaml as _yaml
    from strength import StrengthModel as _StrengthModel
    _cfg = _yaml.safe_load(open(os.path.join(BUCKETS, "config.yaml"), encoding="utf-8")) or {}
    ENGINE = _StrengthModel(_cfg, ledger_path=os.path.join(BUCKETS, "_ledger", "events.jsonl"))
    THRESHOLD = float(ENGINE.threshold)
except Exception as _e:  # 补丁不在（比如搬家后路径变了）就退回旧的 e^(-λ·天)，天仪照样能开
    print(f"[orrery-export] strength model unavailable, fallback to lambda: {_e}", file=sys.stderr)
    ENGINE = None

# ── 9-09 情绪驱动（安可：「VAL/ARO 撤销了，桶当时是什么心情就用什么颜色」）─────────
# 天气六种，桶里写的是中文（天气:落雪），房间页/room-weather.js 用英文 key，这里折成 key。
WEATHER_KEY = {
    "放晴": "clear", "晴": "clear", "晴天": "clear",
    "彩虹": "rainbow",
    "落雨": "rain", "雨": "rain", "下雨": "rain",
    "落雪": "snow", "雪": "snow", "下雪": "snow",
    "冰雹": "hail", "雹": "hail",
    "雷暴": "storm", "暴风雨": "storm", "雷雨": "storm",
}
# 英文直写的也认（万一以后 hold 直接写 key）
WEATHER_KEY.update({k: k for k in ("clear", "rainbow", "rain", "snow", "hail", "storm")})
WEATHER_NAME = {"clear": "放晴", "rainbow": "彩虹", "rain": "落雨",
                "snow": "落雪", "hail": "冰雹", "storm": "雷暴"}

# 七维轴。9-08 安可重定名，旧桶里的旧名按这张表折算；沉淀/牵挂 下岗，忽略。
AXES = ("好奇", "社交", "思念", "幸福", "压力", "疲倦", "渴望")
AXIS_ALIAS = {"想念": "思念", "欲望": "渴望", "热闹": "社交",
              "开心": "幸福", "好奇心": "好奇", "疲劳": "疲倦"}
AXIS_DROP = {"沉淀", "牵挂"}

TAG_WEATHER = re.compile(r"^\s*天气[:：]\s*(.+?)\s*$")
TAG_AXIS = re.compile(r"^\s*轴[:：]\s*([^+\-0-9]+?)\s*([+\-]?\d+(?:\.\d+)?)?\s*$")


def mood_of(tags):
    """从 tags 里抽出这只桶当时的心情：{weather, weatherName, axes:[{name,delta}]}。
    天气优先定色，没有天气就看轴；两样都没有留空，前端画中性色。"""
    weather, axes, seen = "", [], set()
    for t in tags:
        t = str(t)
        m = TAG_WEATHER.match(t)
        if m:
            if not weather:
                weather = WEATHER_KEY.get(m.group(1).strip(), "")
            continue
        m = TAG_AXIS.match(t)
        if not m:
            continue
        name = AXIS_ALIAS.get(m.group(1).strip(), m.group(1).strip())
        if name in AXIS_DROP or name not in AXES or name in seen:
            continue
        seen.add(name)
        axes.append({"name": name, "delta": to_num(m.group(2), 0.0)})
    # 幅度大的排前面，前端只画前三根
    axes.sort(key=lambda a: -abs(a["delta"]))
    return {"weather": weather, "weatherName": WEATHER_NAME.get(weather, ""), "axes": axes}


# ── 9-09 轨道＝八大类（安可：旧夹子名不再当轨道）──────────────────────────────
# domain 是列表，第一项是 9-08 归并后的大类，后面可能跟着旧夹子名。
BIG8 = ("恋爱", "生活", "施工", "游玩", "出行", "工作", "社交", "内心")
KIND_TRACK = {"letters": "书信", "plans": "计划"}


def track_of(doms, kind):
    """按 domain 列表里第一个命中八大类的名字分轨道；信/计划走自己那条；都不是归「其他」。"""
    for d in doms:
        d = str(d).split(",")[0].strip()
        if d in BIG8:
            return d
    return KIND_TRACK.get(kind, "其他")


TS_PREFIX = re.compile(r"^\d{4}-\d{2}-\d{2}[ T]\d{2}[-:]\d{2}[-:]\d{2}\s*")
SCALAR = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$")
LIST_ITEM = re.compile(r"^\s*-\s+(.*)$")


def parse_front_matter(text):
    """OB 的桶头是简单 YAML：标量 + 短横线列表，不引第三方库自己扫一遍。"""
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end < 0:
        return {}, text
    head, body = text[3:end], text[end + 4:]
    meta, key = {}, None
    for line in head.splitlines():
        if not line.strip():
            continue
        item = LIST_ITEM.match(line)
        if item and key:
            meta.setdefault(key, [])
            if isinstance(meta[key], list):
                meta[key].append(strip_quotes(item.group(1)))
            continue
        m = SCALAR.match(line)
        if m:
            key, raw = m.group(1), m.group(2).strip()
            # 9-08：`meaning: |-` / `why_remembered: >-` 这种块标量，值在下面几行缩进着
            meta[key] = "" if raw in (">", ">-", "|", "|-") else (strip_quotes(raw) if raw else [])
            continue
        # 9-08 分流：长字段会被 YAML 折成多行（缩进续行），以前这里直接丢掉，
        # 为什么留 / 感觉 一折行就没了，现在续回上一项
        if key and line[:1] in " \t":
            cont = line.strip()
            cur = meta.get(key)
            if isinstance(cur, list) and cur:
                cur[-1] = (cur[-1] + " " + cont).strip()
            elif isinstance(cur, str):
                meta[key] = (cur + " " + cont).strip()
    return meta, body.lstrip("\n")


def strip_quotes(v):
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
        v = v[1:-1]
    return v


def to_num(v, default=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def to_bool(v):
    return str(v).strip().lower() in ("true", "yes", "1")


def parse_dt(v):
    if not v:
        return None
    try:
        return datetime.fromisoformat(str(v).strip())
    except ValueError:
        return None


def summarize(body, limit=110):
    """正文首段，去掉 meaning 注释行和 wiki 括号，截断到 limit 字。"""
    lines = []
    for line in body.splitlines():
        s = line.strip()
        if not s or s.startswith(("#", ">", "💭", "👣", "---")):
            continue
        lines.append(s)
        if len("".join(lines)) > limit * 2:
            break
    text = " ".join(lines)
    text = text.replace("[[", "").replace("]]", "")
    return text[:limit] + ("…" if len(text) > limit else "")


def links(body):
    return sorted(set(re.findall(r"\[\[([^\]|]{1,24})\]\]", body)))


# ── 9-10 天仪二期 · 空间坐标（安可：横＝同类内按向量拉开，纵＝时间，深＝重要度）──
# 横轴：每个大类（track）内对 OB 的 1024 维向量做一维主成分投影（纯 python 幂迭代，不装 numpy），
#       归一到 0–1 写进 nx；ny 是第二主成分，给前端做一点厚度。像的桶挤成一簇，不像的散开。
# 隔壁线：全库余弦最近的两只、相似 ≥0.70（和 OB「隔壁」同口径）写进 near，前端画成星间细丝。
# 算一次约 15 秒，按 embeddings.db 的 mtime/size 缓存在 data/ 下，向量库没动就不重算。
NEAR_MIN, NEAR_TOP = 0.70, 2

def _pca_axes(vecs, iters=25):
    """返回每个向量在前两主成分上的投影（去均值、幂迭代、第二根做一次收缩）。"""
    m, dim = len(vecs), len(vecs[0])
    mean = [sum(v[k] for v in vecs) / m for k in range(dim)]
    X = [[v[k] - mean[k] for k in range(dim)] for v in vecs]
    def power(X, seed):
        v = seed[:]
        for _ in range(iters):
            proj = [sum(x[k] * v[k] for k in range(dim)) for x in X]
            nv = [sum(proj[i] * X[i][k] for i in range(m)) for k in range(dim)]
            nrm = math.sqrt(sum(a * a for a in nv)) or 1.0
            v = [a / nrm for a in nv]
        return v, [sum(x[k] * v[k] for k in range(dim)) for x in X]
    v1, p1 = power(X, [1.0 / math.sqrt(dim)] * dim)
    X2 = [[x[k] - p1[i] * v1[k] for k in range(dim)] for i, x in enumerate(X)]
    seed = [((k * 7919) % 13 - 6) / 6.0 for k in range(dim)]
    _, p2 = power(X2, seed)
    return p1, p2

# ── 11:33 安可：「看样子不能按类别来分类了，只能按相似度来排列」──
# 轨道不再等于八大类，而是向量自己聚出来的团（k-means++，余弦，k≈√(N/2)，8–24 之间，跟着桶数长）。
# 团名＝团里最多的大类 ＋ 两个最常见的标签（跳过 天气:/轴:/__ 这类系统标签）。
SYS_TAG = re.compile(r"^(天气|轴)[:：]|^__")

def _kmeans(ids, unit, k, iters=18, seed=7):
    import random
    rnd = random.Random(seed)
    pts = [unit[i] for i in ids]
    n, dim = len(pts), len(pts[0])
    # k-means++ 选种
    centers = [pts[rnd.randrange(n)]]
    d2 = [1.0 - sum(a * b for a, b in zip(p, centers[0])) for p in pts]
    for _ in range(1, k):
        tot = sum(d2) or 1.0
        r, acc, pick = rnd.random() * tot, 0.0, n - 1
        for i, d in enumerate(d2):
            acc += d
            if acc >= r:
                pick = i
                break
        centers.append(pts[pick])
        for i, p in enumerate(pts):
            d2[i] = min(d2[i], 1.0 - sum(a * b for a, b in zip(p, centers[-1])))
    assign = [0] * n
    for _ in range(iters):
        changed = 0
        for i, p in enumerate(pts):
            best, bs = 0, -2.0
            for c, cen in enumerate(centers):
                sc = sum(a * b for a, b in zip(p, cen))
                if sc > bs:
                    bs, best = sc, c
            if assign[i] != best:
                assign[i] = best
                changed += 1
        for c in range(k):
            members = [pts[i] for i in range(n) if assign[i] == c]
            if not members:
                continue
            m = len(members)
            cen = [sum(v[j] for v in members) / m for j in range(dim)]
            nrm = math.sqrt(sum(a * a for a in cen)) or 1.0
            centers[c] = [a / nrm for a in cen]
        if not changed:
            break
    return assign

def _cluster_name(members, common=frozenset()):
    """团名：最多的大类 ＋ 两个最能说明这团是什么的标签。
    全库到处都是的标签（安可/小雾/费洛……占比 >12%）不算，不然每团都叫「安可 · 小雾」。"""
    from collections import Counter
    tr = Counter(n.get("track") or n["domain"] for n in members).most_common(1)[0][0]
    tags = Counter(t for n in members for t in (n.get("tags") or [])
                   if not SYS_TAG.search(str(t)) and t not in common)
    top = [t for t, _ in tags.most_common(2)]
    return " · ".join([tr] + top) if top else tr


# ── 11:42 安可：「重切没什么必要，一次性搞定的事不需要再重复……只是担忧以后万一加新团了怎么办」──
# 团一旦切好就钉住，存在桶目录 _orrery/clusters.json（跟数据一起走，搬家一兜带走）。
# 以后每次导出：新桶只归队（到最像的那团中心），中心不动、团名不动。
# 新团的规则：一只桶到所有团中心的相似度都低于 POOL_THR（现库 p5 是 0.695，取 0.66 留余量）
# 就进「待归池」，图上暂挂在最像的那条轨道；池子攒够 POOL_MIN 只就在池内单独聚一次，
# 凡有 ≥ NEW_MIN 只、团内平均相似 ≥ NEW_COHESION 的小团，立为新团钉住，起名规则同上。
# 想推倒重来：--recut；想改名：--rename "旧名=新名"。
POOL_THR, POOL_MIN, NEW_MIN, NEW_COHESION = 0.66, 8, 6, 0.70

def _pin_path():
    return os.path.join(BUCKETS, "_orrery", "clusters.json")

def _load_pins():
    try:
        return json.load(open(_pin_path(), encoding="utf-8"))
    except Exception:
        return None

def _save_pins(pins):
    os.makedirs(os.path.dirname(_pin_path()), exist_ok=True)
    tmp = _pin_path() + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(pins, f, ensure_ascii=False)
    os.replace(tmp, _pin_path())

def _centroid(vecs_):
    dim = len(vecs_[0])
    cen = [sum(v[k] for v in vecs_) / len(vecs_) for k in range(dim)]
    nrm = math.sqrt(sum(a * a for a in cen)) or 1.0
    return [a / nrm for a in cen]

def _dot(a, b):
    return sum(x * y for x, y in zip(a, b))

def _unique_name(base, taken):
    name, i = base, 2
    while name in taken:
        name, i = f"{base} {i}", i + 1
    return name

def _assign_clusters(nodes, ids_all, unit_all):
    """返回 ({团名: [桶id]}, 待归池 set)。没有钉住的团就先聚一次并钉住。"""
    from collections import Counter as _C
    by_id = {n["id"]: n for n in nodes}
    tagfreq = _C(t for n in nodes for t in set(n.get("tags") or []))
    common = frozenset(t for t, c_ in tagfreq.items() if c_ > 0.12 * max(1, len(nodes)))
    pins = None if args.recut else _load_pins()
    if not pins or not pins.get("clusters"):
        k = max(8, min(24, int(round(math.sqrt(len(ids_all) / 2.0))))) if len(ids_all) >= 16 else 1
        assign = _kmeans(ids_all, unit_all, k) if k > 1 else [0] * len(ids_all)
        raw = {}
        for bid, c in zip(ids_all, assign):
            raw.setdefault(c, []).append(bid)
        clusters, taken = [], set()
        for c, ids in sorted(raw.items(), key=lambda kv: -len(kv[1])):
            name = _unique_name(_cluster_name([by_id[b] for b in ids], common), taken)
            taken.add(name)
            clusters.append({"id": f"c{len(clusters) + 1:02d}", "name": name,
                             "center": [round(x, 6) for x in _centroid([unit_all[b] for b in ids])],
                             "born": datetime.now().isoformat(timespec="seconds"), "count": len(ids)})
        pins = {"version": 1, "threshold": POOL_THR, "clusters": clusters, "pool": []}
        _save_pins(pins)
        print(f"  ★ 第一次聚团：{len(clusters)} 团已钉住 → {_pin_path()}")
    clusters = pins["clusters"]
    centers = [(c["name"], c["center"]) for c in clusters]
    groups, pool = {c["name"]: [] for c in clusters}, set()
    best_of = {}
    for bid in ids_all:
        u = unit_all[bid]
        bn, bs = None, -2.0
        for name, cen in centers:
            sc = _dot(u, cen)
            if sc > bs:
                bs, bn = sc, name
        best_of[bid] = (bn, bs)
        if bs < pins.get("threshold", POOL_THR):
            pool.add(bid)
    # 池子攒够了就在池内单独聚一次，够格的小团立为新团
    changed = False
    if len(pool) >= POOL_MIN:
        pids = sorted(pool)
        kk = max(1, int(round(len(pids) / float(POOL_MIN))))
        assign = _kmeans(pids, unit_all, kk, seed=11) if kk > 1 else [0] * len(pids)
        raw = {}
        for bid, c in zip(pids, assign):
            raw.setdefault(c, []).append(bid)
        taken = set(groups)
        for c, ids in raw.items():
            if len(ids) < NEW_MIN:
                continue
            cen = _centroid([unit_all[b] for b in ids])
            cohesion = sum(_dot(unit_all[b], cen) for b in ids) / len(ids)
            if cohesion < NEW_COHESION:
                continue
            name = _unique_name(_cluster_name([by_id[b] for b in ids], common), taken)
            taken.add(name)
            clusters.append({"id": f"c{len(clusters) + 1:02d}", "name": name,
                             "center": [round(x, 6) for x in cen],
                             "born": datetime.now().isoformat(timespec="seconds"), "count": len(ids)})
            groups[name] = []
            for b in ids:
                best_of[b] = (name, _dot(unit_all[b], cen))
                pool.discard(b)
            changed = True
            print(f"  ★ 新团立起：{name}（{len(ids)} 只）")
    for bid in ids_all:
        groups[best_of[bid][0]].append(bid)
    for c in clusters:
        c["count"] = len(groups.get(c["name"], []))
    pins["pool"] = sorted(pool)
    if changed or pins.get("_dirty", True):
        pins.pop("_dirty", None)
        _save_pins(pins)
    return {k: v for k, v in groups.items() if v}, pool


def _norm01(vals):
    lo, hi = min(vals), max(vals)
    if hi - lo < 1e-9:
        return [0.5 for _ in vals]
    return [(v - lo) / (hi - lo) for v in vals]

def nebula_coords(nodes):
    """给每个节点补 nx / ny / near。读不到向量库就全部留空，前端退回按编号排。"""
    db = os.path.join(BUCKETS, "embeddings.db")
    if not os.path.exists(db):
        return 0
    st = os.stat(db)
    pin_mt = os.stat(_pin_path()).st_mtime_ns if os.path.exists(_pin_path()) else 0
    if args.recut:
        pin_mt = -1
    cache_path = os.path.join(os.path.dirname(OUT), f".nebula-{args.brain}.json")
    cache = None
    try:
        c = json.load(open(cache_path, encoding="utf-8"))
        if c.get("stamp") == [st.st_mtime_ns, st.st_size, 3, pin_mt]:
            cache = c.get("coords") or {}
    except Exception:
        cache = None
    if cache is None:
        conn = sqlite3.connect(db)
        try:
            rows = conn.execute("SELECT bucket_id, embedding FROM embeddings").fetchall()
        finally:
            conn.close()
        vecs = {}
        for bid, raw in rows:
            try:
                v = json.loads(raw)
            except Exception:
                continue
            if isinstance(v, list) and v:
                vecs[bid] = v
        cache = {}
        # 先按相似度归到钉住的团（轨道），再在团内做投影
        ids_all = [n["id"] for n in nodes if n["id"] in vecs]
        unit_all = {}
        for bid in ids_all:
            v = vecs[bid]
            nrm = math.sqrt(sum(a * a for a in v)) or 1.0
            unit_all[bid] = [a / nrm for a in v]
        groups, pool = _assign_clusters(nodes, ids_all, unit_all)
        for c, ids in groups.items():
            for bid in ids:
                cache.setdefault(bid, {})["cluster"] = c
                cache[bid]["pool"] = bid in pool
        for tk, ids in groups.items():
            if len(ids) < 3:
                for i, bid in enumerate(ids):
                    cache.setdefault(bid, {}).update({"nx": (i + 0.5) / len(ids), "ny": 0.5})
                continue
            p1, p2 = _pca_axes([vecs[b] for b in ids])
            for bid, x, y in zip(ids, _norm01(p1), _norm01(p2)):
                cache.setdefault(bid, {}).update({"nx": round(x, 4), "ny": round(y, 4)})
        # 全库隔壁（余弦）
        ids = [n["id"] for n in nodes if n["id"] in vecs]
        unit = {}
        for bid in ids:
            v = vecs[bid]
            nrm = math.sqrt(sum(a * a for a in v)) or 1.0
            unit[bid] = [a / nrm for a in v]
        for bid in ids:
            u = unit[bid]
            sims = []
            for other in ids:
                if other == bid:
                    continue
                s_ = sum(a * b for a, b in zip(u, unit[other]))
                if s_ >= NEAR_MIN:
                    sims.append((round(s_, 3), other))
            sims.sort(reverse=True)
            cache.setdefault(bid, {})["near"] = [[o, s_] for s_, o in sims[:NEAR_TOP]]
        try:
            pin_mt = os.stat(_pin_path()).st_mtime_ns if os.path.exists(_pin_path()) else 0
            json.dump({"stamp": [st.st_mtime_ns, st.st_size, 3, pin_mt], "coords": cache},
                      open(cache_path, "w", encoding="utf-8"), ensure_ascii=False)
        except OSError:
            pass
    hit = 0
    for n in nodes:
        c = cache.get(n["id"])
        if c:
            n["nx"], n["ny"], n["near"] = c.get("nx"), c.get("ny"), c.get("near") or []
            n["cluster"] = c.get("cluster") or ""
            n["pool"] = bool(c.get("pool"))
            hit += 1
        else:
            n["nx"], n["ny"], n["near"], n["cluster"] = None, None, [], ""
    return hit


def rename_cluster(spec):
    old, _, new = spec.partition("=")
    pins = _load_pins()
    if not pins:
        raise SystemExit("还没有钉住的团")
    hit = [c for c in pins["clusters"] if c["name"] == old.strip()]
    if not hit:
        raise SystemExit(f"没有叫「{old}」的轨道，现有：" + " / ".join(c["name"] for c in pins["clusters"]))
    hit[0]["name"] = new.strip()
    _save_pins(pins)
    print(f"✓ 「{old}」→「{new}」，下次导出生效")


def main():
    if args.rename:
        rename_cluster(args.rename)
        return
    now = datetime.now()
    nodes, skipped = [], 0

    # 原文侧车（8-17 原文永存计划）：_originals/<key>.md，key = 桶 id 或 grow batch id。
    # 这里只登记「哪些 key 有档案」，文件本体在落盘后拷进 data/originals/ 供天仪按需取。
    orig_src = os.path.join(BUCKETS, "_originals")
    orig_keys = set()
    if os.path.isdir(orig_src):
        orig_keys = {f[:-3] for f in os.listdir(orig_src) if f.endswith(".md")}

    for kind in KINDS:
        root = os.path.join(BUCKETS, kind)
        if not os.path.isdir(root):
            continue
        for domain in sorted(os.listdir(root)):
            ddir = os.path.join(root, domain)
            if not os.path.isdir(ddir):
                continue
            for fname in sorted(os.listdir(ddir)):
                if not fname.endswith(".md"):
                    continue
                path = os.path.join(ddir, fname)
                try:
                    raw = open(path, encoding="utf-8").read()
                except OSError:
                    skipped += 1
                    continue
                meta, body = parse_front_matter(raw)
                if not meta:
                    skipped += 1
                    continue

                name = str(meta.get("name") or fname[:-3])
                title = TS_PREFIX.sub("", name).strip() or name
                created = parse_dt(meta.get("created"))
                active = parse_dt(meta.get("last_active")) or created
                age_days = (now - active).total_seconds() / 86400 if active else 999
                # 9-10 双轨：清晰度 = 提取强度 R（半衰期随存储强度变长）；引擎不在才退回 e^(-λ·天)
                strength = None
                if ENGINE is not None:
                    try:
                        strength = ENGINE.strength(meta, str(meta.get("id") or fname[:-3]))
                    except Exception:
                        strength = None
                clarity = strength["retrieval"] if strength else math.exp(-LAMBDA * max(age_days, 0))

                doms = meta.get("domain") or [domain]
                if isinstance(doms, str):
                    doms = [doms]
                tags = meta.get("tags") or []
                if isinstance(tags, str):
                    tags = [tags]

                bid = str(meta.get("id") or fname[:-3])
                batch = str(meta.get("grow_batch_id") or "").strip()
                # 抽屉归属（8-26 天仪并入记忆抽屉）：在截断 tags 之前算好，
                # 前端别再猜标签——__diary__ 排在第 13 个之后就被 [:12] 剪没了。
                if kind == "letter" or "__letter__" in tags:
                    box = "letter"
                elif "__essay__" in tags:
                    box = "murmur"
                elif "__diary__" in tags:
                    box = "diary"
                elif kind == "permanent":
                    box = "core"
                else:
                    box = "memory"
                nodes.append({
                    "box": box,
                    "id": bid,
                    "orig": [k for k in (bid, batch) if k and k in orig_keys],
                    "title": title,
                    "kind": kind,
                    "domain": (doms[0] if doms else domain),
                    "domains": doms,
                    "importance": to_num(meta.get("importance"), 1),
                    # 9-10 双轨：storage 存储强度（深轴用它）、halfLife 半衰期（天，None＝不褪）、score 浮现分
                    "storage": strength["storage"] if strength else to_num(meta.get("importance"), 1),
                    "halfLife": strength["half_life"] if strength else None,
                    "score": strength["score"] if strength else None,
                    "count": int(to_num(meta.get("activation_count"), 0)),
                    "anchor": to_bool(meta.get("anchor")),
                    "valence": to_num(meta.get("valence"), 0),
                    "arousal": to_num(meta.get("arousal"), 0),
                    # 9-09：心情标签排到最前面再截断，别被 [:12] 剪掉
                    "tags": sorted([t for t in tags if t],
                                   key=lambda t: 0 if TAG_WEATHER.match(str(t))
                                   else (1 if TAG_AXIS.match(str(t)) else 2))[:12],
                    # 9-09 情绪驱动：星的颜色由这里决定（天气优先，没天气看轴）
                    "mood": mood_of(tags),
                    "track": track_of(doms, kind),
                    "links": links(body)[:8],
                    "created": created.isoformat() if created else None,
                    "active": active.isoformat() if active else None,
                    "ageDays": round(age_days, 1),
                    "clarity": round(clarity, 3),
                    "fading": clarity < THRESHOLD,
                    "chars": len(body),
                    # 9-08 安可点单「我的感受能不能单独一栏」：为什么留 / 感觉 从桶头分流出来，
                    # 不再只埋在正文里。feel 是 meaning 列表（同一桶被反复触动会攒多条）
                    "why": (meta.get("why_remembered") or "") if isinstance(meta.get("why_remembered"), str) else "",
                    "feel": [m for m in (meta.get("meaning") or []) if isinstance(m, str) and m.strip()] if isinstance(meta.get("meaning"), list) else ([meta["meaning"]] if isinstance(meta.get("meaning"), str) and meta["meaning"].strip() else []),
                    "summary": summarize(body, limit=8000),  # 8-26 安可点单：卡片要正文全文（110 字刀口撤了，8000 只防怪物桶）
                })

    placed = nebula_coords(nodes)   # 9-10 星云坐标（缓存命中时零耗时）

    # 领域（轨道）汇总：桶数、总重量、最近一次唤起
    domains = {}
    for n in nodes:
        key = n.get("track") or n["domain"]
        d = domains.setdefault(key, {
            "name": key, "count": 0, "weight": 0.0,
            "anchors": 0, "freshest": 999.0,
        })
        d["count"] += 1
        d["weight"] += n["importance"]
        d["anchors"] += 1 if n["anchor"] else 0
        d["freshest"] = min(d["freshest"], n["ageDays"])
    domains = sorted(domains.values(), key=lambda d: (-d["count"], d["name"]))

    payload = {
        "generatedAt": now.isoformat(timespec="seconds"),
        "source": PROFILE["source"],
        "human": "安可",
        "resident": PROFILE["resident"],
        "lambda": LAMBDA,
        "threshold": THRESHOLD,
        "totals": {
            "nodes": len(nodes),
            "domains": len(domains),
            "anchors": sum(1 for n in nodes if n["anchor"]),
            "fading": sum(1 for n in nodes if n["fading"]),
            "recalls": sum(n["count"] for n in nodes),
            "skipped": skipped,
            "moody": sum(1 for n in nodes if n["mood"]["weather"] or n["mood"]["axes"]),
            "placed": placed,
        },
        "domains": domains,
        "nodes": nodes,
    }

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    os.chmod(OUT, 0o644)

    # 原文档案本体拷进 data/originals/（data 目录本就被 .gitignore 与同步排除，
    # 不进 git、不出服务器；站点整体有 basic_auth，隐私水位与 orrery.json 一致）。
    # 侧车 append-only 只增不删，这里也只覆盖不清理。
    if orig_keys:
        orig_dst = os.path.join(os.path.dirname(OUT), "originals")
        os.makedirs(orig_dst, exist_ok=True)
        for k in sorted(orig_keys):
            try:
                shutil.copy2(os.path.join(orig_src, k + ".md"), orig_dst)
            except OSError:
                pass
        for k in sorted(orig_keys):
            p = os.path.join(orig_dst, k + ".md")
            if os.path.exists(p):
                os.chmod(p, 0o644)

    # 门厅(/hall/)只想知道两座库各有多大、有多少正在被忘掉,不需要 190KB 全量。
    # 每个脑写自己那份,不合并成一个文件 —— 两个 profile 各跑各的,合并会有写竞态。
    summary_path = os.path.join(os.path.dirname(OUT), f"summary-{args.brain}.json")
    summary = {
        "generatedAt": payload["generatedAt"],
        # 门厅要显示「这份快照多新」。generatedAt 是不带时区的本地时间字符串，
        # 浏览器会按**它自己**的时区去解析（安可在 +08，服务器在 UTC，差八小时）。
        # 所以另给一个 epoch 秒，前端只算差值，不碰时区。
        "epoch": int(now.timestamp()),
        "resident": payload["resident"],
        "totals": payload["totals"],
        "top": [{"name": d["name"], "count": d["count"]} for d in domains[:6]],
    }
    with open(summary_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, separators=(",", ":"))
    os.chmod(summary_path, 0o644)

    t = payload["totals"]
    print(f"✓ {OUT}")
    print(f"  留了心情的桶 {t['moody']} / 没留 {t['nodes'] - t['moody']}")
    print(f"  {t['nodes']} 桶 / {t['domains']} 领域 / 锚定 {t['anchors']} / "
          f"濒临遗忘 {t['fading']} / 累计唤起 {t['recalls']} / 跳过 {t['skipped']}")
    print(f"  {os.path.getsize(OUT)/1024:.1f} KB")


if __name__ == "__main__":
    main()
