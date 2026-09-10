# 记忆天仪 · Memory Orrery

出品：anko & Rime（tutooth.com）· 2026-08-11 起 · MIT 授权

## 这是什么

把 OB 里所有记忆桶画成一座会转的星图，纯静态页（一个 canvas，零依赖，不装 three）。

- **轨道**＝按向量相似度聚出来的团（k-means，团数随桶数长），团中心钉住，新桶只归队，攒够了自动立新团
- 一颗星＝一只桶：**角度**＝和谁像（团内向量投影），**带内半径**＝什么时候（老的靠里），**高度**＝现在多重（存储强度，2·5D 里浮起/沉下），**大小**＝写入时的重要度，**颜色**＝当时的心情（`天气:` / `轴:` 标签），**亮度**＝提取强度，变淡的画成点线圆
- 重要度 7 以上长出电子、9 两颗、锚定的是原子；拉远只画核，凑近才长细节
- 向量最像的两只之间一根「星间细丝」
- 右侧书脊抽屉：记忆桶 / 锚点 / 日记 / 信件 / 找一找 / 话题（需要块库后端，没有就报「没应答」）/ 设置（需要 [settings/](../settings/)）
- 卡片上能编辑、遗忘、删除桶（经 OB 接口，要 OB 密码）

## 装起来（三步）

**1. 导出数据**。`orrery-export.py` 把 OB 的桶头抽成天仪读的 json（不含桶正文以外的东西，不出你的服务器）。打开它把 `PROFILES` 里的路径改成你的，然后：

    python3 orrery-export.py --brain rime      # 每 15 分钟跑一次（cron / systemd timer 随意）

它会 import 同仓库的 `strength/`（存储/提取强度）；第一次跑会在你的 OB 数据目录下建 `_orrery/clusters.json` 钉住轨道团，之后只归队。改团名：`--rename "旧名=新名"`；推倒重来：`--recut`。

**2. 放页面**。把这个文件夹整个放到你的静态站上（比如 `/preview/memory-orrery/`），json 输出到它下面的 `data/`。

**3. 接 OB**（可选，不接也能看，只是不能编辑桶、拧设置）。页面用同源路径 `/ob-api/rime/…` 找 OB，你的反代要把它转到 OB 并把 cookie 的 Path 改窄。Caddy 写法：

    handle_path /ob-api/rime/* {
        reverse_proxy 127.0.0.1:18002 {
            header_up Host 127.0.0.1:18002
            header_up X-Forwarded-Proto https
            header_down Set-Cookie "Path=/(;|$)" "Path=/ob-api/rime${1}"
        }
    }

只有一座 OB 的话，`index.html` 右上角的 RESIDENT 切换（RIME / FEYLOR）可以删掉。

## 参数都在哪

- 轨道倾角、带宽、高度系数、细丝阈值：`app.js` 开头的常量与 `build()`，每处都有注释说它管什么
- 团数、新团门槛：`orrery-export.py` 顶部 `POOL_THR / POOL_MIN / NEW_MIN / NEW_COHESION`
- `?depth=1` 直接进 2·5D，`?classic=1` 看旧排法（按编号排队），`?prof=1` 看每层耗时
