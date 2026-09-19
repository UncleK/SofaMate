# ScreenMate 0.1 · 发布包契约

2026-09-18 增补：manifest 可声明 startPoints，并要求 random-start capability。每项绑定 edgeId、实际首帧 poster 文件、mediaHash、trimFingerprint、approvedBy、approvedAt。随机开始只从这份明确批准的列表选择；不使用固定入口海报假装任意视频的首帧。开始后立刻恢复原有后继白名单约束，startPoints 不允许运行中的任意跳边。未声明此能力的旧包沿用原入口。默认会话用新的随机种子，测试可显式传入种子复现；后继按合格边的 weight 抽取，继续遵守冷却。下载商品/授权契约在 [CLIENT_DISTRIBUTION.md](CLIENT_DISTRIBUTION.md)，不把支付信息混入视频拓扑。

发布契约以 [types.ts](../src/core/types.ts)、[语义校验](../src/core/validate.ts) 和 [实际文件加载器](../src/main/pack-loader.ts) 为准。ScenePack_Codex_Kit 中的计划 schema 服务于制作阶段；播放器不把 scene.plan.json 当成发布包。

播放器不认识客厅、P 编号、薯片或人物身份。snapshot 是普通 JSON 对象，只在当前边实际末帧呈现并完成交接后提交。第二工程场景采用完全不同的节点、边和快照字段。

## 目录与版本

发布目录包含 manifest.json、graph.json、joins.json、provenance.json、checksums.json 和 media/。检查和覆盖除 checksums.json 自身以外的全部文件。每个媒体引用包含相对 path、sha256、bytes；不能用文件名代替当前内容哈希。

manifest.schemaVersion 为1.0，packVersion 是三段数字版本，minRuntimeVersion 不高于当前运行时。已安装版本不可覆盖；新版本用新目录安装，再由用户显式加载。加载失败保留诊断，未校验内容不会上全屏。

当前只接受解包目录，归档直接拒绝。限制4096个文件、总计8GiB、单文件512MiB、目录深度小于12；总量上限为4K完整主题增加，下载器与文件加载器共用同一常量。路径不能包含盘符、UNC、URL、Windows保留名、冒号、越界段；目录中的符号链接、junction和hardlink均拒绝。

## 媒体

|字段/能力|当前实现|
|---|---|
|canvas|width、height、fpsNumerator、fpsDenominator；所有正式视频共用同一画布与CFR时基|
|opaque-video|完整场景审片；decodedWidth等于canvas.width|
|packed-rgb-alpha|左半RGB、右半灰度alpha，单一H.264 MP4；decodedWidth等于canvas.width×2|
|displayMode|opaque使用scene-preview；packed可使用overlay-stage；fit仅支持contain|
|entryPoster|PNG，宽高等于逻辑canvas；透明PNG可用于覆盖入口|
|ambientAudio|可选WAV/Ogg文件描述；隐藏/暂停时停止，默认音量0；制作构建目前不自动添加背景音|
|transition|cut时blendFrames=0；opaque视频可显式声明smooth-crossfade能力，并在已批准join中设置正整数blendFrames，时长最多0.5秒且不超过任一视频一半长度；入口仍为cut，micro-blend与其他效果拒绝|

MP4必须是自包含、非fragmented、avc1 H.264，具有固定样本时长。运行时从实际容器检查宽高、帧数、帧率及外部数据引用；解码失败仍会暂停并隐藏，容器头检查不代替完整解码和人工审片。

packed合成按两个半区分别钳制采样边界，再输出premultiplied alpha。离线准备matte后可用制作CLI的media pack-alpha命令打包；它不生成或批准抠像。

## 图和接缝

节点包含id、label、anchorVersion、anchorImageHash、snapshot。边包含from/to、video描述、实际解码信息、半开区间[inFrame,outFrameExclusive)、实际时长、两端锚点版本、weight、cooldownSec、cooldownGroup、initialDelaySec和requiredCapabilities。

joins.json只含approved记录；入口incomingEdgeId为__entry__。每条join绑定两端实际媒体/入口海报哈希、两端trim指纹、锚点版本、审核者与审核证据。两个入边即便落在同一节点，也不能共享未经批准的后继。

smooth-crossfade采用固定smoothstep曲线，两段实际视频同时播放并对音量做同权重交接；当前B为24fps下10帧。后段已在重叠中消费的开头不重复播放，调度时扣除这段重叠。暂停/恢复作用于两个视频。仅在opaque视频层上进行，不修改原始像素、不新增后继；未声明此能力的旧包仍走原cut路径。4K媒体避免向不可见canvas每帧重复上传，工程像素审计模式仍可启用。

所有发布节点、边和incoming状态必须从入口可达、可返回入口并具有继续路径。每个可达状态必须有不受初始延迟或冷却阻断的安全出口。调度使用实际完成时长、确定性随机和声明的权重；在预选下一边时也计入当前边即将生效的冷却。

## 最小制作方式

通过制作工作区批准单边、锚点和接缝，再执行pack build。构建器会重新验证正式文件并只输出批准子图。原始take、设计图、提示词、候选帧和未审条目保留在工作区，不需要手写发布JSON。

可以运行npm run fixtures生成两个明确标记的工程包作为格式参考；其synthetic test harness审核只适用于工程媒体，不能拿来批准人物素材。
