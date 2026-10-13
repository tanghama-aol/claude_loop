### [x] 1. 自动ping这个可以指定哪些profile自动ping，没有指定的不进行自动ping

### [x] 2. 运行界面将当前已启动的任务按tab页列出来，可以切换不同任务
  - 状态：FINISHED
  - 完成标准：运行页顶部列出所有已启动任务（Agent 运行中、空闲等待、目录队列等待、已预约、等待重试）的 tab，点击可切换任务并同步刷新运行控制、目标文件与日志；没有已启动任务时 tab 条隐藏。
  - 详细方案：`public/index.html` 在运行视图顶部增加 `#runtimeTabsBar` / `#runtimeTabs`（role=tablist）；`public/app.js` 新增 `taskIsStarted()` 过滤已启动任务、`renderRuntimeTabs()` 按签名去重渲染（轮询无变化时不重建 DOM）、`selectRuntimeTask()` 统一 tab 点击与「任务」下拉框的切换逻辑；`public/styles.css` 增加 tab 样式并按运行态着色，窄屏下改为纵向排列；`public/i18n.js` 增加 `runtime.tabsLabel` / `runtime.tabsSwitch` 中英文文案；README 补充说明。
  - 开发步骤：
    - [x] 1. 增加 tab 条标记与样式，按运行态着色并适配窄屏。
    - [x] 2. 实现已启动任务过滤、tab 渲染与点击切换，并与任务下拉框共用切换逻辑。
    - [x] 3. 补充前端切片测试（过滤、渲染、XSS 转义、轮询不重建）与 i18n 用例。
    - [x] 4. 用真实服务与无头 Chrome 验收 tab 切换、动态更新与隐藏，更新 README。
  - 执行记录：`npm run check` 通过；`npm test` 共 114 项，112 项通过、2 项按平台跳过、0 项失败；`git diff --check` 通过。无头 Chrome 验收：两个已启动任务（运行中 / 目录队列等待）以 tab 列出，点击后任务下拉框、目标文件路径、副标题与日志同步切换；停止全部任务后 tab 条自动隐藏；1440×900 与 375×812 视口截图正常。

GGGG全部完成GGGGGGGG全部完成GGGG
