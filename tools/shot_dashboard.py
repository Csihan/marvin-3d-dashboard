#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
shot_dashboard.py:MARVIN 3D Dashboard README 截图生成脚本。

@file    shot_dashboard.py
@brief   无头 Chrome 打开 dashboard dev server,按 1280x720 截图保存到 docs/screenshot-dashboard.png
@author  Csihan
@date    2026-09-08

为什么用脚本而不是浏览器工具:内嵌浏览器视口锁定 340px 且 WebGL canvas 不跟随
CDP 视口覆盖,截出的图布局错乱;无头 Chrome 独立进程没有该问题。
前置条件:dev server 已运行(npm run dev -- --port 5199)。
用法:python shot_dashboard.py [url] [输出路径]
"""

import os
import sys
import time

from playwright.sync_api import sync_playwright

# 默认参数:本地 dev server 与仓库内截图落点(默认相对仓库根 docs/ 下,
# 也可用命令行参数覆盖:url 与输出路径)
URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:5199/"
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "docs", "screenshot-dashboard.png")


def main() -> int:
    """无头浏览器截图主流程:起浏览器 → 设视口 → 等渲染 → 落图。"""
    with sync_playwright() as p:
        # deviceScaleFactor=2 让截图 retina 清晰度,README 显示更锐利
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1280, "height": 720}, device_scale_factor=2)
        page.goto(URL, wait_until="networkidle")
        # 等 3D 场景首帧与 HUD 布局稳定(URDF 加载 + 星空渐入)
        time.sleep(4)
        page.screenshot(path=OUT, type="png")
        browser.close()
    print(f"saved: {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
