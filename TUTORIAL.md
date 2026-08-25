# 给 OmbreBrain 加一个「原文备份」功能

出品：安可 & 小雾/Rime（tutooth.com）· 2026-08-17 · MIT 授权

## 这个补丁解决什么问题？

[OmbreBrain](https://github.com/p0luz)（下称 OB）是一个 AI 长期记忆系统。它为了省 token，会用 LLM 把你写进去的内容**压缩成摘要**，新旧记忆还会被**合并**在一起。好处是省钱，坏处是——**原话没了**。压缩和合并都是有损的，压完只剩一段转述，你想找回「当时到底是怎么写的」，找不回来了。

这个补丁的做法很简单：**在 OB 动手压缩/合并之前，先把原文原样抄一份存到旁边**，存进一个只增不改的备份目录。摘要照样压、token 照样省，但原文永远有一份留底。之后你可以在任何界面把它翻出来看。

存档目录长这样（在 OB 的数据目录里）：

    你的数据目录/_originals/<记忆id>.md

每个文件是纯 Markdown，随便用文本编辑器或 Obsidian 打开就能读。

---

## 安装步骤

补丁一共要改 **3 个文件、各加几行**，再放 1 个新文件。不难，跟着做即可。

### 第 0 步（最关键）：确认你要改的代码在哪

OB 有个容易踩的坑：它支持「热更新」，**真正运行的代码可能不在 Docker 镜像里，而在你的数据目录下的 `_app/src/`**。如果你改了镜像里的代码却没生效、又不报错，就是踩了这个坑。

先检查一下：

    ls 你的数据目录/_app/src/

- **列出一堆 .py 文件** → 你要改的就是这里（`你的数据目录/_app/src/`）。
- **没有这个目录** → 你的代码在 Docker 镜像里，路径是 `/app/src/`。

（我们第一次做的时候，就是改错了地方，白忙一场才发现的。所以这步放最前面。）

**动手前先备份**，出问题能一键还原：

    cp -a 上一步确认的src目录 ~/ob-src-backup

### 第 1 步：放入备份模块

把本文件夹里的 `originals.py` 复制到上面那个 src 目录里（跟 `bucket_manager.py` 放在一起）。

这个文件就是干「把原文抄一份存起来」这件事的，只增不改、写失败也不会影响 OB 正常运行。

### 第 2 步：在 3 个地方插入备份调用

OB 里会「弄丢原文」的操作有三处，我们在每一处动手之前都插一段备份代码。**每段都是 try/except 包起来的，就算备份失败也不会影响 OB 本身。**

#### 位置 A：整理日记时（文件 `tools/grow/core.py`）

搜索这一行：

    batch_id = f"g_{uuid.uuid4().hex[:12]}"

在它**下面**加：

    # 备份原文：日记会被 LLM 拆分改写，这里先把整篇原文存下来
    try:
        from originals import append_original
        _ok = append_original(rt.bucket_mgr.base_dir, batch_id, "日记原文", content)
        rt.logger.info(f"原文备份: {batch_id} ok={_ok}")
    except Exception as _oe:
        rt.logger.error(f"原文备份失败（不影响正常运行）: {_oe}")

#### 位置 B：合并记忆时（文件 `tools/_common.py`）

搜索这一行（不同版本可能略有出入，核心是那句 `dehydrator.merge`）：

    merged = await rt.dehydrator.merge(snapshot_content, content)

在它**上面**加：

    # 备份原文：合并会用 LLM 把新旧内容揉在一起，这里先把两边原文都存下来
    try:
        from originals import append_original
        append_original(rt.bucket_mgr.base_dir, candidate_id, "合并前的旧内容", snapshot_content)
        append_original(rt.bucket_mgr.base_dir, candidate_id, "合并进来的新内容", content)
    except Exception as _oe:
        rt.logger.error(f"原文备份失败（不影响正常运行）: {_oe}")

> 如果你的 OB 版本较老，那行里的变量名可能是 `bucket["content"]` 和 `bucket["id"]`，
> 把上面代码里的 `snapshot_content` 换成 `bucket["content"]`、`candidate_id` 换成 `bucket["id"]` 即可。

#### 位置 C：导入外部记忆时（文件 `import_memory.py`，可选；**3.2.0 起不需要**）

如果你不用「导入」功能，或者你的 OB 是 3.2.0 及以上（见下方「版本适配情况」），这步可以跳过。搜索：

    merged = await self.dehydrator.merge(candidate_content, content)

在它**上面**加：

    try:
        from originals import append_original
        append_original(self.bucket_mgr.base_dir, candidate_id, "导入·合并前的旧内容", candidate_content)
        append_original(self.bucket_mgr.base_dir, candidate_id, "导入·合并进来的新内容", content)
    except Exception as _oe:
        logger.error(f"原文备份失败（不影响正常运行）: {_oe}")

### 第 3 步：重启并测试

    # 先检查有没有改出语法错误（对每个改过的文件跑一遍）
    python3 -m py_compile tools/grow/core.py tools/_common.py import_memory.py originals.py

    # 重启 OB
    docker restart 你的OB容器名

    # 往 OB 里写一条 30 字以上的日记（通过它的 MCP 工具），然后看备份目录：
    ls 你的数据目录/_originals/

如果出现了 `g_xxxxx.md` 文件、里面是你刚写的日记原文，**就成功了**。OB 的日志里也会有一行 `原文备份: g_xxxxx ok=True`。

如果备份目录一直是空的、日志也没那行 → 多半是第 0 步改错了地方，回去重新确认。

---

## 版本适配情况

| OB 版本 | 要插入的位置 | 实测 |
|---------|--------------|------|
| 2.8.x | A + B + C（三处） | ✅ 2026-08-17，生产使用中 |
| 3.2.0 | **只要 A + B（两处）** | ✅ 2026-08-25，影子实例通过 |

3.2.0 的两点差异：

1. **位置 C 不用做了**：3.2 的导入引擎官方改成「只新建、不合并」（`import_memory.py` 文件头自己写着「不调用 dehydrator.merge」），不再有丢原文的合并路径，自然也没有地方可插。第 3 步的语法检查命令里把 `import_memory.py` 去掉即可。
2. **位置 A 的锚点行在 3.2 里出现两次**：`batch_id = f"g_{uuid.uuid4().hex[:12]}"` 既在日记拆分主路径（`grow_core` 函数）里，也在新增的逐字路径里。**只改第一处**（`grow_core` 里的那个）；第二处所在的路径本来就逐字保存原文，不需要备份。

另外确认过：3.2 里 `hold`、短内容 grow、`grow(items=...)` 逐字路径全部是原样拼接（`raw_merge=True`），都不丢原文，无需插桩。位置 B 的代码在 3.2 源码上原样可用（教程里的变量名 `snapshot_content` / `candidate_id` 就是 3.2 的写法；更老版本按位置 B 下方的注记替换变量名）。

## 常见问题

**Q：这会让 OB 变慢或变贵吗？**
不会。备份只是往硬盘写一个文本文件，不调用任何 LLM，不产生 token 消耗。摘要压缩照旧。

**Q：备份文件会不会越堆越多、越占越大？**
只存文本，一条记忆通常几 KB。它只增不删——这正是「永久备份」的意义。真嫌多可以自己定期清理 `_originals/`，不影响 OB。

**Q：怎么在界面里看这些原文？**
你的前端按记忆 id（或记忆信息里的 `grow_batch_id`）去 `_originals/<id>.md` 读取即可。我们自己的做法是在记忆可视化页面上加了个「展开原文」按钮。

**Q：想撤掉这个补丁？**
把第 0 步备份的 src 目录复制回去、重启即可。已经存下来的 `_originals/` 备份文件不受影响，可以保留。

---

## 授权

`originals.py` 与本教程采用 **MIT License** © 2026 Anko & Rime (tutooth.com)。
随便用、随便改、随便再分发，保留这行署名即可。本教程只描述在哪里插入代码，不包含 OmbreBrain 的源码。

用得开心 —— 别让任何人的原话消失。🌫️🐰
