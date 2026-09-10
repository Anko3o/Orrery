# 给 OmbreBrain 加一个「设置 API」

出品：anko & Rime（tutooth.com）· 2026-09-10 · MIT 授权

## 这个补丁解决什么问题？

OB 的浮现预算（wake / breath 一次最多端多少 token）、变淡的线、以及本仓库 [strength/](../strength/) 的九个权重，都躺在 `config.yaml` 里。想拧一下就得开终端改文件、再重启。这个补丁加一个接口，让面板（比如本仓库的 [orrery/](../orrery/) 天仪抽屉里的「设置」格）能读、能改，改完写回 `config.yaml` 并热生效，不用重启。

    GET  /api/settings/surfacing      → 三组当前值
    POST /api/settings/surfacing      ← {"surfacing":{...},"decay":{...},"strength":{...}} 任意子集

三组字段与范围：

| 组 | 字段 | 范围 |
|---|---|---|
| surfacing | breath_max_tokens / breath_max_results / feel_max_tokens | 1000–40000 / 1–50 / 500–30000 |
| decay | threshold / archive | 0.05–0.9 / bool |
| strength | activation_weight, edit_weight, mood_weight, mood_axis_full, half_life_base_days, half_life_pivot, half_life_growth, eternal_at, resolved_factor | 见 strength/README |

登录同 OB dashboard（`POST /auth/login` 拿 cookie）。越界值返回 400，写盘失败返回 500 且不改内存。

## 安装

先装 [strength/](../strength/)（端点保存后会热重建它的模型）。然后：

    python3 install.py --src 你的OB源码目录 --dry-run
    python3 install.py --src 你的OB源码目录
    docker restart 你的容器

只在 3.2.0 上验证过。`--uninstall` 还原。
