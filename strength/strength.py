"""
========================================
strength.py — 记忆强度双轨（存储强度 / 提取强度）
========================================
出品：安可 & 小雾/Rime（tutooth.com）· 2026-09-10 · MIT

这个模块回答一个问题：一段记忆「现在还有多重」？

OmbreBrain 原本的答案是一条固定的指数曲线：
    Score = importance × activation^0.3 × e^(-λ·days) × emotion
普通记忆 60 天没被想起就掉到阈值以下，被搬进 archive、向量清掉——等于真的没了。
人不是这样忘东西的。心理学（Bjork & Bjork 的「新失用理论」）把记忆分成两个量：

  * 存储强度 Storage strength ——「这件事在你心里有多重」。只涨不跌。
    被想起、被改动/追加都往上加（次数每翻一倍加一档，不封顶），当时情绪重涨一点。核心准则封顶。
  * 提取强度 Retrieval strength ——「现在能不能自己想起来」。会掉，
    但一被提醒就回满；掉到零也只是「想不起来」，不是「没了」。
    掉的速度取决于存储强度：重要的事褪得慢，最重要的不褪。

本模块只做纯计算，不读写桶、不调 LLM、不联网。
唯一的外部输入是 OB 的事件账本 `_ledger/events.jsonl`（用来数「被实质改过几次」），
读不到就当 0，不抛错。

对外暴露：
    StrengthModel(config, ledger_path="")
        .storage_strength(meta, bucket_id="")   → 1–10
        .half_life_days(storage, meta=None)      → 天数，inf = 不褪
        .retrieval_strength(meta, storage=None)  → 0–1
        .score(meta, bucket_id="")               → 排序分（S × R × 新鲜度 × 紧急）
        .strength(meta, bucket_id="")            → 上面几样打包成 dict
        .archive_enabled                         → 是否还允许老式自动归档（默认 False）
    mood_amplitude(meta) → 0–1，从 tags 里的 `天气:` / `轴:` 读心情幅度
========================================
"""
from __future__ import annotations

import json
import math
import os
import re
from datetime import date, datetime

# ============================================================
# 调参面板 —— 全部可被 config.yaml 的 `strength:` 段逐项覆盖
#   strength:
#     activation_weight: 0.6
#     edit_weight: 0.6
#     mood_weight: 1.5
#     half_life_base_days: 30
#     half_life_pivot: 5
#     half_life_growth: 2.0
#     eternal_at: 10
#     resolved_factor: 0.5
#     mood_axis_full: 8         # 轴幅度多少算「满格」（按自家标签的实际分布定）
#   decay:
#     archive: false        # true 才恢复老式「低分搬进 archive」
#     threshold: 0.3        # 提取强度低于它算「正在变淡」（只计数，不搬）
# ============================================================
STRENGTH_MIN, STRENGTH_MAX = 1.0, 10.0
DEFAULT_ACTIVATION_WEIGHT = 0.6   # 激活次数每翻一倍 +0.6（log2(1+count)）
DEFAULT_EDIT_WEIGHT = 0.6         # 实质改动（正文/感受/标签/重要度/领域）每翻一倍 +0.6（log2(1+次数)，不封顶：
                                  #   安可 9-10「说不定有人就喜欢一两年内不停追加」——追加得越久爬得越高，直到 10）
DEFAULT_MOOD_WEIGHT = 1.5         # 心情幅度满格 +1.5
DEFAULT_HALF_LIFE_BASE_DAYS = 30.0  # 存储强度 = pivot 时的半衰期
DEFAULT_HALF_LIFE_PIVOT = 5.0
DEFAULT_HALF_LIFE_GROWTH = 2.0    # 存储强度每 +1，半衰期 × growth（5→30d, 8→240d, 9→480d）
DEFAULT_ETERNAL_AT = 10.0         # 存储强度 ≥ 此值不褪
DEFAULT_RESOLVED_FACTOR = 0.5     # resolved → 半衰期减半；resolved+digested 再减半
DEFAULT_ARCHIVE_ENABLED = False   # 默认不自动归档：记忆只淡不丢
DEFAULT_IMPORTANCE = 5
DEFAULT_AROUSAL = 0.3
DEFAULT_DAYS_FALLBACK = 30.0      # 时间字段坏掉时按「一个月没动」算
# 新鲜度加成（沿用 OB 原有口径）：刚存入 ×2，36 小时半衰，三天后 ≈ ×1
FRESHNESS_HALF_LIFE_HRS = 36.0
FRESHNESS_AMPLITUDE = 1.0
# 紧急加成（沿用 OB 原有口径）：唤醒度高且未处理 → ×1.5
AROUSAL_URGENCY_THRESHOLD = 0.7
URGENCY_BOOST = 1.5
# 实质改动才算「被改过」：正文 / 感受 / 为什么留。改标签、换夹子、调重要度是整理不是回忆
# （9-08 那次 45 个夹子并成 8 个，一口气给 329 只桶改了 domain，那不能算每只桶都被想起过一遍）
EDIT_FIELDS = ("content", "meaning", "why_remembered")

# 心情幅度：tags 里的 `天气:落雪` / `轴:思念+8`（tutooth 家的心情标签；没这些标签就是 0，不影响别人）
# 天气是「某根轴过了 0.5 就按它的天」盖上去的，所以下雪和雷暴一样重，只有放晴是「什么都没过线」：
MOOD_WEATHER_AMP = {
    "放晴": 0.3, "晴": 0.3, "晴天": 0.3, "clear": 0.3,
}
MOOD_WEATHER_DEFAULT = 0.7        # 其它任何天气（落雪/彩虹/落雨/冰雹/雷暴）一律 0.7
# 轴幅度多少算满格：安可 9-10「我们家自己都从来没打到过满格」——按实际写过的分布定，
# 44 条轴标签幅度 2–10、前两成 ≥8，所以 8 满格、4 半格（config strength.mood_axis_full 可改）
MOOD_AXIS_FULL = 8.0
_TAG_WEATHER_RE = re.compile(r"^\s*天气[:：]\s*(.+?)\s*$")
_TAG_AXIS_RE = re.compile(r"^\s*轴[:：]\s*([^+\-0-9]+?)\s*([+\-]?\d+(?:\.\d+)?)?\s*$")


# ------------------------------------------------------------
# 小工具（自带一份，不依赖 OB 的 utils，方便在容器外单独用）
# ------------------------------------------------------------
def _parse_bool(value, default=False) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    s = str(value).strip().lower()
    if s in ("1", "true", "yes", "on", "y"):
        return True
    if s in ("0", "false", "no", "off", "n", ""):
        return False
    return default


def _parse_dt(value) -> datetime:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, date):
        parsed = datetime.combine(value, datetime.min.time())
    else:
        raw = str(value or "").strip()
        if not raw:
            raise ValueError("empty datetime")
        if raw[-1:].lower() == "z":
            raw = raw[:-1] + "+00:00"
        parsed = datetime.fromisoformat(raw)
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone().replace(tzinfo=None)
    return parsed


def days_since_active(meta: dict, fallback_days: float = DEFAULT_DAYS_FALLBACK) -> float:
    """距上次被想起的天数（last_active，缺了用 created）。坏数据 → fallback。"""
    if not isinstance(meta, dict):
        return fallback_days
    raw = meta.get("last_active") or meta.get("created") or ""
    try:
        return max(0.0, (datetime.now() - _parse_dt(raw)).total_seconds() / 86400.0)
    except (ValueError, TypeError):
        return float(fallback_days)


def mood_amplitude(meta: dict, axis_full: float = MOOD_AXIS_FULL) -> float:
    """从 tags 里读心情幅度（0–1）：天气按表给，轴按 |Δ|/满格，取大；没写 → 0。"""
    tags = (meta or {}).get("tags") or []
    if isinstance(tags, str):
        tags = [tags]
    amp = 0.0
    for t in tags:
        t = str(t)
        m = _TAG_WEATHER_RE.match(t)
        if m:
            amp = max(amp, MOOD_WEATHER_AMP.get(m.group(1).strip(), MOOD_WEATHER_DEFAULT))
            continue
        m = _TAG_AXIS_RE.match(t)
        if m and m.group(2):
            try:
                amp = max(amp, min(1.0, abs(float(m.group(2))) / max(0.1, axis_full)))
            except ValueError:
                pass
    return amp


def freshness_bonus(days: float) -> float:
    """刚存进来的记忆有一阵「印象很新」：×2 起步，三天后归 1。"""
    return 1.0 + FRESHNESS_AMPLITUDE * math.exp(-(days * 24.0) / FRESHNESS_HALF_LIFE_HRS)


class EditLedger:
    """数每只桶被实质改过几次。整份账本读进内存，按文件 mtime/size 缓存。"""

    def __init__(self, path: str = ""):
        self.path = path or ""
        self._counts: dict[str, int] = {}
        self._stamp: tuple = ()

    def count(self, bucket_id: str) -> int:
        path = self.path
        if not path or not os.path.exists(path):
            return 0
        try:
            st = os.stat(path)
            stamp = (st.st_mtime_ns, st.st_size)
            if stamp != self._stamp:
                counts: dict[str, int] = {}
                with open(path, encoding="utf-8") as f:
                    for line in f:
                        try:
                            ev = json.loads(line)
                        except ValueError:
                            continue
                        if ev.get("event_type") != "TraceUpdated":
                            continue
                        payload = ev.get("payload") or {}
                        changed = str(payload.get("changed_fields") or "")
                        if not any(k in changed for k in EDIT_FIELDS):
                            continue
                        tid = str(ev.get("trace_id") or payload.get("id") or "")
                        if tid:
                            counts[tid] = counts.get(tid, 0) + 1
                self._counts, self._stamp = counts, stamp
        except OSError:
            return 0
        return self._counts.get(str(bucket_id), 0)


class StrengthModel:
    """存储强度 / 提取强度 计算器。config 是 OB 的整份 config dict（可为空 dict）。"""

    def __init__(self, config: dict | None = None, ledger_path: str = ""):
        config = config or {}
        st = config.get("strength", {}) or {}
        decay_cfg = config.get("decay", {}) or {}
        self.w_activation = float(st.get("activation_weight", DEFAULT_ACTIVATION_WEIGHT))
        self.w_edit = float(st.get("edit_weight", DEFAULT_EDIT_WEIGHT))
        self.w_mood = float(st.get("mood_weight", DEFAULT_MOOD_WEIGHT))
        self.half_life_base = float(st.get("half_life_base_days", DEFAULT_HALF_LIFE_BASE_DAYS))
        self.half_life_pivot = float(st.get("half_life_pivot", DEFAULT_HALF_LIFE_PIVOT))
        self.half_life_growth = float(st.get("half_life_growth", DEFAULT_HALF_LIFE_GROWTH))
        self.eternal_at = float(st.get("eternal_at", DEFAULT_ETERNAL_AT))
        self.resolved_factor = float(st.get("resolved_factor", DEFAULT_RESOLVED_FACTOR))
        self.mood_axis_full = float(st.get("mood_axis_full", MOOD_AXIS_FULL))
        self.threshold = float(decay_cfg.get("threshold", 0.3))
        self.archive_enabled = _parse_bool(decay_cfg.get("archive", DEFAULT_ARCHIVE_ENABLED),
                                           default=DEFAULT_ARCHIVE_ENABLED)
        if not ledger_path:
            base = str(config.get("buckets_dir") or "")
            ledger_path = os.path.join(base, "_ledger", "events.jsonl") if base else ""
        self.ledger = EditLedger(ledger_path)

    # ---- 存储强度 ----
    @staticmethod
    def is_pinned(meta: dict) -> bool:
        return bool(meta.get("type") == "permanent" or meta.get("pinned")
                    or meta.get("protected") or _parse_bool(meta.get("anchor"), default=False))

    def storage_strength(self, meta: dict, bucket_id: str = "") -> float:
        """1–10，只涨不跌。importance 是起点；被想起、被改、心情重都往上加；核心/锚定 = 10。"""
        if not isinstance(meta, dict):
            return STRENGTH_MIN
        if self.is_pinned(meta):
            return STRENGTH_MAX
        try:
            base = max(1.0, min(10.0, float(meta.get("importance", DEFAULT_IMPORTANCE))))
        except (TypeError, ValueError):
            base = float(DEFAULT_IMPORTANCE)
        try:
            count = max(0.0, float(meta.get("activation_count") or 0))
        except (TypeError, ValueError):
            count = 0.0
        edits = self.ledger.count(bucket_id or str(meta.get("id") or ""))
        s = (base
             + self.w_activation * math.log2(1.0 + count)
             + self.w_edit * math.log2(1.0 + edits)
             + self.w_mood * mood_amplitude(meta, self.mood_axis_full))
        return round(max(STRENGTH_MIN, min(STRENGTH_MAX, s)), 3)

    # ---- 提取强度 ----
    def half_life_days(self, storage: float, meta: dict | None = None) -> float:
        """半衰期（天）。存储强度每高一分翻一倍；≥ eternal_at 返回 inf。resolved 减半。"""
        if storage >= self.eternal_at:
            return math.inf
        hl = self.half_life_base * (self.half_life_growth ** (storage - self.half_life_pivot))
        meta = meta or {}
        if meta.get("resolved"):
            hl *= self.resolved_factor
            if meta.get("digested"):
                hl *= self.resolved_factor
        return max(1.0, hl)

    def retrieval_strength(self, meta: dict, storage: float | None = None) -> float:
        """0–1。距上次被想起的天数按半衰期折半。低 ≠ 没了：一被想起（touch）就回满。"""
        if storage is None:
            storage = self.storage_strength(meta)
        hl = self.half_life_days(storage, meta)
        if math.isinf(hl):
            return 1.0
        return round(2.0 ** (-days_since_active(meta) / hl), 4)

    # ---- 排序分（给 wake / breath 浮现排序用）----
    def score(self, meta: dict, bucket_id: str = "") -> float:
        """S × R × 新鲜度 × 紧急。量级与 OB 旧公式相当（≤ 30），直接替换 calculate_score。"""
        storage = self.storage_strength(meta, bucket_id)
        retrieval = self.retrieval_strength(meta, storage)
        days = days_since_active(meta)
        try:
            arousal = max(0.0, min(1.0, float(meta.get("arousal", DEFAULT_AROUSAL))))
        except (TypeError, ValueError):
            arousal = DEFAULT_AROUSAL
        urgent = URGENCY_BOOST if (arousal > AROUSAL_URGENCY_THRESHOLD and not meta.get("resolved")) else 1.0
        return round(storage * retrieval * freshness_bonus(days) * urgent, 4)

    def strength(self, meta: dict, bucket_id: str = "") -> dict:
        """一次算齐，给导出 / 面板用。"""
        s = self.storage_strength(meta, bucket_id)
        hl = self.half_life_days(s, meta)
        return {
            "storage": s,
            "retrieval": self.retrieval_strength(meta, s),
            "half_life": None if math.isinf(hl) else round(hl, 1),
            "days_since": round(days_since_active(meta), 1),
            "score": self.score(meta, bucket_id),
        }
