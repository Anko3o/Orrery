    # ---- 9-10 tutooth：/api/settings/surfacing — 浮现预算 / 遗忘线 / 记忆强度权重 ----
    # 安可：「开窗 breath 总是上限，但没有面板可以控制这些」。天仪书脊抽屉「设置」格读写这里。
    # GET 返回三组当前值；POST 校验后写回 config.yaml（原子），再热更新内存 config 与衰减引擎的强度模型。
    SURFACING_FIELDS = {
        "surfacing": {"breath_max_tokens": (int, 1000, 40000), "breath_max_results": (int, 1, 50),
                      "feel_max_tokens": (int, 500, 30000)},
        "decay": {"threshold": (float, 0.05, 0.9), "archive": (bool, None, None)},
        "strength": {"activation_weight": (float, 0.0, 3.0), "edit_weight": (float, 0.0, 3.0),
                     "mood_weight": (float, 0.0, 4.0), "mood_axis_full": (float, 2.0, 20.0),
                     "half_life_base_days": (float, 3.0, 365.0), "half_life_pivot": (float, 1.0, 10.0),
                     "half_life_growth": (float, 1.0, 4.0), "eternal_at": (float, 6.0, 11.0),
                     "resolved_factor": (float, 0.1, 1.0)},
    }

    def _surfacing_snapshot() -> dict:
        out = {}
        de = getattr(sh, "decay_engine", None)
        sm = getattr(de, "strength_model", None)
        for group, fields in SURFACING_FIELDS.items():
            live = sh.config.get(group)
            if not isinstance(live, dict):
                live = {}
            out[group] = {}
            for key, (typ, lo, hi) in fields.items():
                v = live.get(key)
                if v is None and sm is not None and group == "strength":
                    # 没写进 config 的，用引擎正在用的默认值回显
                    attr = {"activation_weight": "w_activation", "edit_weight": "w_edit", "mood_weight": "w_mood",
                            "mood_axis_full": "mood_axis_full", "half_life_base_days": "half_life_base",
                            "half_life_pivot": "half_life_pivot", "half_life_growth": "half_life_growth",
                            "eternal_at": "eternal_at", "resolved_factor": "resolved_factor"}.get(key)
                    v = getattr(sm, attr, None) if attr else None
                if v is None and group == "decay":
                    v = {"threshold": getattr(de, "threshold", 0.3), "archive": getattr(de, "archive_enabled", False)}.get(key)
                if typ is bool:
                    out[group][key] = parse_bool(v, default=False)
                elif v is not None:
                    try:
                        out[group][key] = typ(v)
                    except (TypeError, ValueError):
                        out[group][key] = None
                else:
                    out[group][key] = None
        return out

    @mcp.custom_route("/api/settings/surfacing", methods=["GET", "POST"])
    async def api_settings_surfacing(request: Request) -> Response:
        """Get / update surfacing budget, fading threshold and strength weights (tutooth 9-10)."""
        from starlette.responses import JSONResponse
        err = sh._require_auth(request)
        if err:
            return err
        if request.method == "GET":
            return JSONResponse({"ok": True, **_surfacing_snapshot()})
        try:
            body = await sh._read_json_object(request)
        except Exception:
            return JSONResponse({"error": "invalid JSON body"}, status_code=400)
        candidate: dict = {}
        for group, fields in SURFACING_FIELDS.items():
            incoming = body.get(group)
            if not isinstance(incoming, dict):
                continue
            for key, (typ, lo, hi) in fields.items():
                if key not in incoming:
                    continue
                raw = incoming[key]
                try:
                    if typ is bool:
                        val = parse_bool(raw, default=False)
                    else:
                        if isinstance(raw, bool):
                            raise ValueError(f"{group}.{key} must be a number")
                        val = typ(raw)
                        if typ is float and not math.isfinite(val):
                            raise ValueError(f"{group}.{key} must be finite")
                        if not (lo <= val <= hi):
                            return JSONResponse({"error": f"{group}.{key} must be in [{lo},{hi}]"}, status_code=400)
                except (TypeError, ValueError, OverflowError) as e:
                    return JSONResponse({"error": f"invalid field: {e}"}, status_code=400)
                candidate.setdefault(group, {})[key] = val
        if not candidate:
            return JSONResponse({"error": "nothing to update"}, status_code=400)
        with sampling_commit_lock:
            def _mutate(save_config: dict) -> None:
                for group, kv in candidate.items():
                    sec = save_config.setdefault(group, {})
                    if not isinstance(sec, dict):
                        sec = {}
                        save_config[group] = sec
                    sec.update(kv)
            try:
                atomic_update_config_yaml(_mutate)
            except Exception as e:
                return JSONResponse({"error": f"设置写入磁盘失败，未保存：{e}"}, status_code=500)
            # 磁盘落地了才发布到运行态（保留原字典对象，浮现逻辑持有它的引用）
            for group, kv in candidate.items():
                sec = sh.config.get(group)
                if not isinstance(sec, dict):
                    sec = {}
                    sh.config[group] = sec
                sec.update(kv)
            # 衰减引擎：阈值 / 归档开关 / 强度模型热重建
            de = getattr(sh, "decay_engine", None)
            if de is not None:
                try:
                    from strength import StrengthModel
                    old = getattr(de, "strength_model", None)
                    de.strength_model = StrengthModel(sh.config, ledger_path=getattr(getattr(old, "ledger", None), "path", ""))
                    de.archive_enabled = de.strength_model.archive_enabled
                    de.threshold = float(sh.config.get("decay", {}).get("threshold", de.threshold))
                except Exception as e:
                    return JSONResponse({"error": f"已写盘，但引擎热更新失败：{e}"}, status_code=500)
        return JSONResponse({"ok": True, **_surfacing_snapshot()})


