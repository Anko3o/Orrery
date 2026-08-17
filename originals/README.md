# OB 原文永存补丁 · 三针教程
> 出品：兔牙家（安可 & 小雾/Rime · tutooth.com）· 2026-08-17
> 效果：OB 的脱水/合并照常省 token，但任何将被 LLM 搅碎的原文，都会先原样存进
> `buckets/_originals/` 档案馆（append-only，永不参与合并与遗忘）。

## 0. 先找到「真身」（最重要的一步，我们拜了三炮蜡像才发现）

OB 有热更新机制：如果你的数据卷里存在 `buckets/_app/src/`，**容器实际运行的是那份代码**，
镜像里的 /app/src 只是引导壳。判断方法：

    ls <你的buckets目录>/_app/src/  # 存在 → 改这里；不存在 → 改镜像里的 /app/src

改错地方的症状：改完毫无效果、也不报错。动手前备份整个 src 目录：

    cp -a <buckets>/_app/src <安全的地方>/src-backup

## 1. 放入侧车模块

把本包里的 `originals.py` 拷进 src 根目录（和 bucket_manager.py 同级）。
它只做一件事：append-only 写档案，写失败不打断主流程，key 过 basename 防路径穿越。

## 2. 三针

### 针一 · grow 的日记原稿（tools/grow/core.py）
找到 `batch_id = f"g_{uuid.uuid4().hex[:12]}"`，在它**之后**插：

    # 原文永存：digest 拆条是 LLM 转写，整篇日记原稿先入侧车（键=batch_id）
    try:
        from originals import append_original
        _ok = append_original(rt.bucket_mgr.base_dir, batch_id, "grow日记原稿", content)
        rt.logger.info(f"原文侧车: batch {batch_id} 入档={_ok}")
    except Exception as _oe:
        rt.logger.error(f"原文侧车写入失败（照常拆条）: {_oe}")

### 针二 · grow 合并前抢救（tools/_common.py）
找到 LLM 压缩合并那行（2.8.x 长这样：`merged = await rt.dehydrator.merge(snapshot_content, content)`；
老版本变量名可能是 `bucket["content"]`，桶 id 变量对应换成 `bucket["id"]`）。在它**之前**插：

    # 原文永存：有损重写之前，旧正文快照 + 新进原文先入侧车
    try:
        from originals import append_original
        append_original(rt.bucket_mgr.base_dir, candidate_id,
                        "merge前旧正文", snapshot_content)
        append_original(rt.bucket_mgr.base_dir, candidate_id,
                        "merge新进内容", content,
                        note=grow_batch_id or source_tool or "")
    except Exception as _oe:
        rt.logger.error(f"原文侧车写入失败（照常合并）: {_oe}")

### 针三 · 导入合并前抢救（import_memory.py，可选但推荐）
找到 `merged = await self.dehydrator.merge(candidate_content, content)`，在它**之前**插：

    try:
        from originals import append_original
        append_original(self.bucket_mgr.base_dir, candidate_id,
                        "import-merge前旧正文", candidate_content)
        append_original(self.bucket_mgr.base_dir, candidate_id,
                        "import-merge新进内容", content)
    except Exception as _oe:
        logger.error(f"原文侧车写入失败（照常合并）: {_oe}")

## 3. 重启并验证

    python3 -m py_compile 改过的每个文件   # 语法保险
    docker restart <你的OB容器>
    # 用 MCP 发一条 30 字以上的 grow 测试日记，然后：
    ls <buckets>/_originals/            # 应出现 g_xxxx.md，内容是你日记的原样

日志里应有一行 `原文侧车: batch g_xxxx 入档=True`。没有 → 回到第 0 步，你八成改了蜡像。

## 4. 之后

- 档案格式：每条 `## 时间 · 来源` + 原文，纯 Markdown，Obsidian 直接可读。
- 想在前端翻原文：你的展示层按「桶 id」或桶元数据里的 `grow_batch_id` 去
  `_originals/<key>.md` 取即可（我们家是天仪列表+卡片里加了「展开原文」按钮）。
- 回滚：把备份的 src 拷回去重启，`_originals/` 里已存的档案不受影响。

## 授权

`originals.py` 与本教程：MIT License © 2026 Anko & Rime (tutooth.com)。
随便用、随便改、随便再分发，保留这行署名就行。教程中的插入点描述基于 OmbreBrain
2.8.x 的公开结构，未包含上游源码。玩得开心，别让任何人的原话死掉。🌫️🐰
