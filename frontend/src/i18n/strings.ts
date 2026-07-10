// Bilingual UI string table.
//
// English is the canonical shape — `Strings = typeof en`. Chinese must
// satisfy the same shape, so adding a new key in `en` causes a TS error
// in `zh` until it's translated. Functions (e.g., diary unread label)
// are allowed and must keep the same signature in both languages.
//
// Layout: nested by feature area (header, dashboard, chat, diary,
// settings, common). Keep keys descriptive; access is direct object
// drilldown via `useT()`, e.g., `t.header.nav.dashboard`. No flat
// "header.nav.dashboard" string lookups — those defeat type-safety.
//
// Phase A: only `header` and `common` are populated. Later phases add
// chat / diary / settings sections. Until then, components outside
// Header keep their hardcoded English literals — this is intentional,
// not a bug; translating them lazily as we touch each surface.

export const en = {
  common: {
    loading: 'Loading…',
    save: 'Save',
    cancel: 'Cancel',
    delete: 'Delete',
    confirm: 'Confirm',
  },
  header: {
    nav: {
      dashboard: 'Dashboard',
      chat: 'Agent Chat',
      call: 'Call',
      diary: 'Diary',
      settings: 'Settings',
    },
    status: {
      serial: 'Serial',
      ble: 'BLE',
      audio: 'Audio',
      disconnected: 'Disconnected',
      active: 'Active',
      inactive: 'Inactive',
      recording: 'Recording',
      channels: 'channels',
    },
    demoBadge: 'DEMO',
    demoBadgeTitle: 'Demo entry — data wiring unchanged for now',
    logoAria: 'i-Thread Lab — Imperial Hamlyn Centre (opens in a new tab)',
    logoTitle: 'Open i-Thread Lab homepage at imperial.ac.uk in a new tab',
    settingsAria: 'Open settings',
    diaryUnreadAria: (n: number) =>
      `${n} unread diary ${n === 1 ? 'entry' : 'entries'}`,
    languageToggleAria: 'Switch language',
    languageToggleTitle: (next: 'en' | 'zh'): string =>
      next === 'zh' ? 'Switch to Chinese (中文)' : 'Switch to English',
  },
  settings: {
    back: 'Back',
    title: 'Settings',
    tabs: {
      extensions: 'Extensions',
      diary: 'Diary',
      appearance: 'Appearance',
      about: 'About',
    },
    extensions: {
      heading: 'Extensions',
      // The dev-facing description here mentions a literal pip command
      // that should NOT be translated. Embed a placeholder `{cmd}` and
      // let the component splice in the <code> element.
      descriptionBefore: 'Install extra backend capabilities. Extensions install into the Python environment that runs the backend (',
      descriptionAfter: ').',
      refresh: '↻ Refresh',
      refreshing: 'Refreshing…',
      loadFailed: 'Failed to load extensions',
      backendHint: 'Is the Python backend running at',
      empty: 'No extensions registered.',
      // Per-card (ExtensionCard) strings.
      card: {
        statusInstalling: 'Installing…',
        statusNotInstalled: 'Not installed',
        statusError: 'Error',
        statusEnabled: 'Enabled',
        statusDisabled: 'Disabled',
        idLabel: 'id:',
        installedAt: (when: string): string => `installed ${when}`,
        lastError: 'Last error:',
        install: 'Install',
        enable: 'Enable',
        disable: 'Disable',
        uninstall: 'Uninstall',
        progressLabel: 'Progress',
        installCompleteOk: '✓ Install complete.',
        installFailed: (err: string): string => `✗ Install failed: ${err}`,
        unknownError: 'unknown error',
        // Window prompts / alerts.
        confirmUninstall: (name: string): string =>
          `Uninstall ${name}?\nThe Python package stays cached; only the state flag is cleared.`,
        installFailedToStart: (err: string): string =>
          `Install failed to start: ${err}`,
        enableFailed: (err: string): string => `Enable failed: ${err}`,
        disableFailed: (err: string): string => `Disable failed: ${err}`,
        uninstallFailed: (err: string): string => `Uninstall failed: ${err}`,
      },
    },
    // Per-extension display overrides keyed by ext.id. The ExtensionCard
    // looks up `t.settings.extensionMeta[ext.id]` and uses translated
    // name/description when present, falling back to the backend-supplied
    // English values otherwise. Add an entry here whenever a new
    // extension ships in the registry.
    extensionMeta: {
      'whisper-local': {
        name: 'Whisper (Local)',
        description:
          "Offline speech-to-text using faster-whisper. Once installed, the chat page's microphone gains an ESP32 option that transcribes UDP audio on the backend (no cloud APIs, no data leaves the host).",
      },
    } as Record<string, { name?: string; description?: string }>,
    appearance: {
      colorPreset: 'Color preset',
      colorPresetDesc:
        'Each preset has a paired light + dark variant — switch between them with the mode picker below or the sun/moon button in the header.',
      mode: 'Mode',
      modeDesc:
        'Choose which side of the current preset to render. "System" follows your OS preference.',
      modes: { light: 'Light', dark: 'Dark', system: 'System' },
      currentlyRendering: 'Currently rendering:',
      fromOsPreference: ' (from OS preference)',
      activeBadge: 'Active',
    },
    about: {
      heading: 'About',
      tagline:
        'AinOne Dashboard — integrated real-time sensor UI, recording library, and AI chat interface powered by a self-built agent backend.',
      // Stack list — surface labels are translated; URLs / package
      // names stay literal.
      frontendLabel: 'Frontend',
      pythonBackendLabel: 'Python backend',
      pythonBackendDesc:
        'sensor / audio / recording pipelines + extensions',
      nodeBackendLabel: 'Node backend',
      nodeBackendDesc: 'Agent gateway + embedded terminal',
    },
  },
  diary: {
    page: {
      heading: 'Diary',
      anthropicNative: 'Anthropic native',
      providerBadgeTitle: (env_source: string): string =>
        `Diary is locked to your main chat's provider (${env_source}). Switch by editing ~/.claude/settings.json.`,
      tagline:
        'Casual observations the AI agent leaves about your recent recordings. Generated by AI · not medical advice.',
      agentPickerTitle: 'Which agent runs when you click Generate now',
      settings: 'Settings',
      cancel: 'Cancel ✕',
      cancelTitle: 'Kill the spawned claude process',
      generateNow: 'Generate now',
      writing: 'writing…',
      dismiss: 'Dismiss',
      loading: 'Loading…',
      emptyTitle: '📓 Diary not running yet',
      // The empty-state body has an inline <strong> — keep the surrounding
      // copy here as plain segments and let the component compose them.
      emptyBefore:
        'The AI agent can leave you a short note about patterns it spots in your recent recordings. Press ',
      emptyAction: 'Generate now',
      emptyAfter:
        ' above to try it — typically ~500–2,000 tokens per run depending on the model.',
      confirmDelete: (title: string): string =>
        `Delete diary entry "${title}"?`,
    },
    entryCard: {
      trigger: { manual: 'manual', daily: 'daily', event: 'event' },
      delayed: 'delayed',
      newBadge: 'new',
      reply: 'Reply',
      read: 'Read',
      markRead: 'Mark read',
      delete: 'Delete',
      tokensTooltip: 'Tokens consumed (input + output)',
      deleteEnabledTitle: 'Delete this entry permanently',
      deleteDisabledTitle: 'Mark the entry as read first',
      refs: 'refs:',
    },
    settingsPanel: {
      heading: 'Diary',
      tagline:
        'AI-generated observations on your recent recordings, posted on a schedule. Generated by AI · not medical advice.',
      loadingConfig: 'Loading config…',
      enableLabel: 'Enable diary',
      enableHint: '(master switch — turns the daily schedule on/off)',
      dailyHeading: 'Daily observation',
      fieldTime: 'Time',
      fieldAgent: 'Agent',
      fieldDailyQuota: 'Daily quota',
      lastRun: (date: string, entry_id: string): string =>
        `Last run: ${date} (entry ${entry_id})`,
      notificationsHeading: 'Notifications',
      browserNotifications: 'Browser notifications',
      quietHours: 'Quiet hours',
      agentsHeading: 'Agents',
      newAgent: '+ New',
      loadingAgents: 'Loading…',
      edit: 'Edit',
      test: 'Test',
      delete: 'Delete',
      confirmDeleteAgent: (id: string): string => `Delete agent ${id}?`,
      scheduleClearPrompt: (id: string): string =>
        `${id} is set as the daily/weekly schedule agent. Clear those references AND delete? (this also disables the daily cron)`,
      secretsHeading: 'Secrets',
      hide: 'Hide',
      showManage: 'Show / manage',
      secretsDescriptionBefore:
        'a stash of API keys your agents reference by name (e.g. ',
      secretsDescriptionMid1: ') instead of embedding the literal value in ',
      secretsDescriptionMid2: '. The ',
      secretsDescriptionStrong:
        " agent editor's simple mode auto-creates one secret per provider",
      secretsDescriptionMid3:
        " when you paste an API key, so you usually don't need to touch this section. Open it only to share a key across multiple agents, rotate a key, or audit what's stored. Stored locally in ",
      secretsDescriptionAfter: ' (gitignored).',
      secretsWhatThisIs: 'What this is:',
      secretsEmptyCollapsed:
        'None saved yet. Adding an agent in simple mode will create one automatically.',
      secretsEmpty: 'No secrets saved.',
      refCount: (n: number): string => `(${n} ref${n === 1 ? '' : 's'})`,
      confirmDeleteSecret: (name: string): string => `Delete secret ${name}?`,
      fieldName: 'Name',
      fieldValue: 'Value',
      revealHide: 'hide',
      revealShow: 'show',
      saveSecret: 'Save secret',
      // Toast messages
      toastNotifUnsupported: 'Browser does not support notifications',
      toastNotifDenied: 'Notification permission denied',
      toastSaved: (id: string): string => `Saved ${id}`,
      toastDeleted: (id: string): string => `Deleted ${id}`,
      toastDeletedClearedSchedule: (id: string): string =>
        `Deleted ${id} (cleared schedule)`,
      toastTestOk: (id: string, ms: number): string =>
        `${id}: ✓ OK · ${ms} ms`,
      toastTestFail: (id: string, err: string): string => `${id}: ✗ ${err}`,
    },
  },
  dashboard: {
    footer: {
      version: 'AinOne Dashboard v1.0',
      wsConnected: 'WebSocket: ● Connected',
      wsDisconnected: 'WebSocket: ○ Disconnected',
    },
    grid: {
      waiting: 'Waiting for sensor data...',
      waitingHint: 'Connect via Serial or BLE to receive data',
    },
    connectionPanel: {
      serialTitle: 'Serial Port',
      bleTitle: 'BLE',
      audioTitle: 'Audio (UDP)',
      connectedDot: '● Connected',
      disconnectedDot: '○ Disconnected',
      portLabel: 'Port',
      bleNamePlaceholder: 'ESP32-S3-MultiSensor',
      bleNameTitle: 'BLE advertised name to scan for',
      audioPortTitle: 'UDP port the ESP32 sends audio frames to (1 – 65535)',
      audioPortPlaceholder: '8888',
      // Action labels — passed through labelFor() in ConnectionPanel.
      btn: {
        connect: 'Connect',
        disconnect: 'Disconnect',
        connecting: 'Connecting…',
        disconnecting: 'Disconnecting…',
        scan: 'Scan',
        start: 'Start',
        stop: 'Stop',
        starting: 'Starting…',
        stopping: 'Stopping…',
      },
    },
    recording: {
      title: 'Recording',
      durationLabel: 'Duration (seconds)',
      durationTitle: (min: number, max: number): string =>
        `Any value from ${min} to ${max} seconds`,
      durationError: (min: number, max: number): string =>
        `Enter a duration between ${min} and ${max} seconds.`,
      includeAudio: 'Include audio',
      start: 'Start Recording',
      starting: 'Starting…',
      stop: 'Stop Recording',
      stopping: 'Stopping…',
      elapsed: 'elapsed',
      total: 'total',
      startFailed: 'Failed to start',
    },
    audioMeter: {
      title: 'Audio',
    },
    display: {
      title: 'Display Settings',
      points: 'Waveform Points:',
      cardsPerRow: 'Cards Per Row:',
      cardSize: 'Card Size:',
      wheelZoomStep: 'Wheel Zoom Step:',
      hintScroll: ' inside a chart → zoom Y-axis',
      hintScrollVerb: 'Scroll',
      hintDoubleClick: ' chart → reset zoom',
      hintDoubleClickVerb: 'Double-click',
    },
    replay: {
      title: 'CSV Replay',
      pickPlaceholder: 'Pick a recording…',
      noRecordings: 'No recordings yet.',
      loading: 'Loading…',
      errorPrefix: 'Error: ',
      play: '▶ Play',
      pause: '❚❚ Pause',
      restart: '↺ Restart',
      stop: 'Stop',
      speed: 'Speed',
      duration: (sec: number): string => `${sec.toFixed(1)}s`,
      progress: (cur: number, total: number): string =>
        `${cur.toFixed(1)} / ${total.toFixed(1)}s`,
      clipLabel: 'Clip export',
      clipReset: 'Reset',
      markIn: 'Mark start',
      markInSet: (sec: string): string => `Start: ${sec}s`,
      markInTitle: 'Set the clip start to the current playhead',
      markOut: 'Mark end',
      markOutSet: (sec: string): string => `End: ${sec}s`,
      markOutTitle: 'Set the clip end to the current playhead',
      exportClip: 'Export clip as CSV',
    },
  },
  chat: {
    input: {
      placeholder:
        'Type your message to the agent... (`/` for commands, drag a recording to attach)',
    },
    loadingConversation: 'Loading conversation…',
    thinking: 'Agent is thinking...',
    empty: {
      title: 'Start a conversation',
      body:
        'Send a message to the agent. You can ask questions, analyze recordings, or get help with your ESP32 sensor project.',
    },
    diaryCard: {
      label: 'Diary context',
      consumed: 'in conversation',
      pending: 'will be loaded on send',
      dismissTitle: 'Hide this card (the agent still has the context)',
      dismissAria: 'Dismiss diary context card',
    },
    rightPanel: {
      show: 'Show right panel',
      hide: 'Hide right panel',
    },
    errors: {
      label: 'Error',
      sendFailed: 'Failed to send message',
    },
  },
  call: {
    title: 'Voice Call',
    closeAria: 'End call and return',
    state: {
      idle: 'READY',
      listening: 'LISTENING',
      thinking: 'THINKING',
      speaking: 'SPEAKING',
    },
    sourceLabel: 'Source',
    sourceEsp32: 'ESP32',
    sourceMic: 'Mic',
    triggerLabel: 'Mode',
    triggerPtt: 'Push to Talk',
    triggerVad: 'Auto Detect',
    holdToTalk: 'Hold to talk',
    releaseToSend: 'Release to send',
    transcriptPlaceholder: 'Start with saying hi!',
    backToChat: 'Back to chat',
    micUnavailable: 'Microphone unavailable',
    waitingAudio: 'Waiting for audio…',
    sendToClaude: 'Send to AI',
    transcribing: 'Transcribing…',
    transcribeError: (err: string): string => `Transcription failed: ${err}`,
    holdHint: 'Hold space or the mic button to talk',
    vadHint: 'Just start talking — silence ends your turn',
    langLabel: 'Voice',
    langTitle: 'Transcription language',
    thinkingCaption: 'AI is thinking…',
    readingData: 'Reading data',
    readingDataDone: 'Consulted',
    ttsOnTitle: 'Voice replies on — click to mute',
    ttsOffTitle: 'Voice replies off — click to read AI replies aloud',
    replyError: (err: string): string => `Reply failed: ${err}`,
  },
};

export type Strings = typeof en;

export const zh: Strings = {
  common: {
    loading: '加载中…',
    save: '保存',
    cancel: '取消',
    delete: '删除',
    confirm: '确认',
  },
  header: {
    nav: {
      dashboard: '仪表盘',
      chat: 'Agent 聊天',
      call: '通话',
      diary: '日记',
      settings: '设置',
    },
    status: {
      serial: '串口',
      ble: '蓝牙',
      audio: '音频',
      disconnected: '未连接',
      active: '已激活',
      inactive: '未激活',
      recording: '录制中',
      channels: '通道',
    },
    demoBadge: '演示',
    demoBadgeTitle: '演示入口 — 数据链路暂未改动',
    logoAria: 'i-Thread Lab — 帝国理工 Hamlyn 中心（新标签页打开）',
    logoTitle: '在新标签页打开 i-Thread Lab 主页（imperial.ac.uk）',
    settingsAria: '打开设置',
    diaryUnreadAria: (n: number) => `${n} 条未读日记`,
    languageToggleAria: '切换语言',
    languageToggleTitle: (next: 'en' | 'zh'): string =>
      next === 'zh' ? '切换到中文' : '切换到英文 (English)',
  },
  settings: {
    back: '返回',
    title: '设置',
    tabs: {
      extensions: '扩展',
      diary: '日记',
      appearance: '外观',
      about: '关于',
    },
    extensions: {
      heading: '扩展',
      descriptionBefore: '安装额外的后端能力。扩展会被装入运行后端的 Python 环境（',
      descriptionAfter: '）。',
      refresh: '↻ 刷新',
      refreshing: '刷新中…',
      loadFailed: '加载扩展失败',
      backendHint: 'Python 后端是否运行在',
      empty: '暂无注册的扩展。',
      card: {
        statusInstalling: '安装中…',
        statusNotInstalled: '未安装',
        statusError: '错误',
        statusEnabled: '已启用',
        statusDisabled: '已停用',
        idLabel: 'id：',
        installedAt: (when: string): string => `安装于 ${when}`,
        lastError: '最近一次错误：',
        install: '安装',
        enable: '启用',
        disable: '停用',
        uninstall: '卸载',
        progressLabel: '进度',
        installCompleteOk: '✓ 安装完成。',
        installFailed: (err: string): string => `✗ 安装失败：${err}`,
        unknownError: '未知错误',
        confirmUninstall: (name: string): string =>
          `卸载 ${name}？\nPython 包仍保留在缓存中；只是清除启用标志。`,
        installFailedToStart: (err: string): string => `安装未能启动：${err}`,
        enableFailed: (err: string): string => `启用失败：${err}`,
        disableFailed: (err: string): string => `停用失败：${err}`,
        uninstallFailed: (err: string): string => `卸载失败：${err}`,
      },
    },
    extensionMeta: {
      'whisper-local': {
        name: 'Whisper（本地）',
        description:
          '基于 faster-whisper 的离线语音转文字。安装后，聊天页的麦克风会多出一个 ESP32 选项，由后端转录 UDP 音频流（不调用云端 API，数据不出本机）。',
      },
    } as Record<string, { name?: string; description?: string }>,
    appearance: {
      colorPreset: '配色方案',
      colorPresetDesc:
        '每个方案都有配对的浅色 + 深色变体——通过下方的模式选择器或顶栏的日/月按钮切换。',
      mode: '模式',
      modeDesc:
        '选择当前方案的浅色或深色变体。"跟随系统"会沿用操作系统的偏好。',
      modes: { light: '浅色', dark: '深色', system: '跟随系统' },
      currentlyRendering: '当前渲染：',
      fromOsPreference: '（来自系统偏好）',
      activeBadge: '已选中',
    },
    about: {
      heading: '关于',
      tagline:
        'AinOne Dashboard — 集成实时传感器界面、录制库与基于自研 Agent 后端的 AI 聊天。',
      frontendLabel: '前端',
      pythonBackendLabel: 'Python 后端',
      pythonBackendDesc: '传感器 / 音频 / 录制管线 + 扩展',
      nodeBackendLabel: 'Node 后端',
      nodeBackendDesc: 'Agent 网关 + 内嵌终端',
    },
  },
  diary: {
    page: {
      heading: '日记',
      anthropicNative: 'Anthropic 原生',
      providerBadgeTitle: (env_source: string): string =>
        `日记已锁定到主聊天的提供商（${env_source}）。如需切换，请编辑 ~/.claude/settings.json。`,
      tagline: 'AI 对你近期录音的随手观察。AI 生成 · 不构成医疗建议。',
      agentPickerTitle: '点击「立即生成」时使用哪个 agent',
      settings: '设置',
      cancel: '取消 ✕',
      cancelTitle: '终止已启动的 claude 进程',
      generateNow: '立即生成',
      writing: '正在写入…',
      dismiss: '关闭',
      loading: '加载中…',
      emptyTitle: '📓 日记还没开始运行',
      emptyBefore:
        'AI 可以为你近期的录音留一段简短的观察。点击上方的 ',
      emptyAction: '立即生成',
      emptyAfter: ' 试一下——根据所选模型，每次大约消耗 500–2,000 tokens。',
      confirmDelete: (title: string): string => `删除日记条目「${title}」？`,
    },
    entryCard: {
      trigger: { manual: '手动', daily: '每日', event: '事件' },
      delayed: '延后',
      newBadge: '新',
      reply: '回复',
      read: '已读',
      markRead: '标为已读',
      delete: '删除',
      tokensTooltip: '消耗的 tokens（输入 + 输出）',
      deleteEnabledTitle: '永久删除这条记录',
      deleteDisabledTitle: '请先标为已读',
      refs: '参考：',
    },
    settingsPanel: {
      heading: '日记',
      tagline: '按计划生成的 AI 观察记录，关于你近期的录音。AI 生成 · 不构成医疗建议。',
      loadingConfig: '加载配置…',
      enableLabel: '启用日记',
      enableHint: '（总开关——控制每日计划是否运行）',
      dailyHeading: '每日观察',
      fieldTime: '时间',
      fieldAgent: 'Agent',
      fieldDailyQuota: '每日配额',
      lastRun: (date: string, entry_id: string): string =>
        `上次运行：${date}（条目 ${entry_id}）`,
      notificationsHeading: '通知',
      browserNotifications: '浏览器通知',
      quietHours: '免打扰时段',
      agentsHeading: 'Agent',
      newAgent: '+ 新建',
      loadingAgents: '加载中…',
      edit: '编辑',
      test: '测试',
      delete: '删除',
      confirmDeleteAgent: (id: string): string => `删除 agent ${id}？`,
      scheduleClearPrompt: (id: string): string =>
        `${id} 已被设为每日/每周计划的 agent。是否清除这些引用并一并删除？（同时会停用每日计划）`,
      secretsHeading: 'Secret',
      hide: '隐藏',
      showManage: '显示 / 管理',
      secretsDescriptionBefore:
        '一组 API key 的存储区，agent 通过名字引用（例如 ',
      secretsDescriptionMid1: '）而不是把字面值嵌入到 ',
      secretsDescriptionMid2: '。',
      secretsDescriptionStrong: ' Agent 编辑器的「简单模式」会按提供商自动创建对应的 secret',
      secretsDescriptionMid3:
        '，所以一般无需手动管理。仅在你想跨多个 agent 共用一个 key、轮换 key 或审计存储时再展开。本地存储在 ',
      secretsDescriptionAfter: '（已加入 gitignore）。',
      secretsWhatThisIs: '这是什么：',
      secretsEmptyCollapsed: '尚未保存。在简单模式新建 agent 时会自动创建。',
      secretsEmpty: '尚未保存任何 secret。',
      refCount: (n: number): string => `（${n} 处引用）`,
      confirmDeleteSecret: (name: string): string => `删除 secret ${name}？`,
      fieldName: '名称',
      fieldValue: '值',
      revealHide: '隐藏',
      revealShow: '显示',
      saveSecret: '保存 secret',
      toastNotifUnsupported: '浏览器不支持通知',
      toastNotifDenied: '通知权限被拒绝',
      toastSaved: (id: string): string => `已保存 ${id}`,
      toastDeleted: (id: string): string => `已删除 ${id}`,
      toastDeletedClearedSchedule: (id: string): string =>
        `已删除 ${id}（已清除计划引用）`,
      toastTestOk: (id: string, ms: number): string =>
        `${id}：✓ OK · ${ms} ms`,
      toastTestFail: (id: string, err: string): string => `${id}：✗ ${err}`,
    },
  },
  dashboard: {
    footer: {
      version: 'AinOne Dashboard v1.0',
      wsConnected: 'WebSocket：● 已连接',
      wsDisconnected: 'WebSocket：○ 未连接',
    },
    grid: {
      waiting: '等待传感器数据…',
      waitingHint: '通过串口或蓝牙连接以接收数据',
    },
    connectionPanel: {
      serialTitle: '串口',
      bleTitle: '蓝牙',
      audioTitle: '音频（UDP）',
      connectedDot: '● 已连接',
      disconnectedDot: '○ 未连接',
      portLabel: '端口',
      bleNamePlaceholder: 'ESP32-S3-MultiSensor',
      bleNameTitle: '要扫描的蓝牙广播名称',
      audioPortTitle: 'ESP32 发送音频帧的 UDP 端口（1 – 65535）',
      audioPortPlaceholder: '8888',
      btn: {
        connect: '连接',
        disconnect: '断开',
        connecting: '连接中…',
        disconnecting: '断开中…',
        scan: '扫描',
        start: '开始',
        stop: '停止',
        starting: '启动中…',
        stopping: '停止中…',
      },
    },
    recording: {
      title: '录制',
      durationLabel: '时长（秒）',
      durationTitle: (min: number, max: number): string =>
        `任意 ${min} 到 ${max} 秒之间的值`,
      durationError: (min: number, max: number): string =>
        `请输入 ${min} 到 ${max} 秒之间的时长。`,
      includeAudio: '包含音频',
      start: '开始录制',
      starting: '启动中…',
      stop: '停止录制',
      stopping: '停止中…',
      elapsed: '已用',
      total: '总长',
      startFailed: '启动失败',
    },
    audioMeter: {
      title: '音频',
    },
    display: {
      title: '显示设置',
      points: '波形点数：',
      cardsPerRow: '每行卡片：',
      cardSize: '卡片尺寸：',
      wheelZoomStep: '滚轮缩放步长：',
      hintScroll: '在图表内 → Y 轴缩放',
      hintScrollVerb: '滚动',
      hintDoubleClick: '图表 → 重置缩放',
      hintDoubleClickVerb: '双击',
    },
    replay: {
      title: 'CSV 回放',
      pickPlaceholder: '选择一段录音…',
      noRecordings: '还没有录音。',
      loading: '加载中…',
      errorPrefix: '错误：',
      play: '▶ 播放',
      pause: '❚❚ 暂停',
      restart: '↺ 重播',
      stop: '停止',
      speed: '速度',
      duration: (sec: number): string => `${sec.toFixed(1)}s`,
      progress: (cur: number, total: number): string =>
        `${cur.toFixed(1)} / ${total.toFixed(1)}s`,
      clipLabel: '截取片段',
      clipReset: '重置',
      markIn: '标记起点',
      markInSet: (sec: string): string => `起点：${sec}s`,
      markInTitle: '将片段起点设为当前播放位置',
      markOut: '标记终点',
      markOutSet: (sec: string): string => `终点：${sec}s`,
      markOutTitle: '将片段终点设为当前播放位置',
      exportClip: '导出片段为 CSV',
    },
  },
  chat: {
    input: {
      placeholder: '向 Agent 发送消息…（输入 ` / ` 看命令；拖入录音可附加）',
    },
    loadingConversation: '加载对话中…',
    thinking: 'Agent 思考中…',
    empty: {
      title: '开始一段对话',
      body: '向 Agent 发送消息。你可以提问、分析录音数据，或在 ESP32 传感器项目上寻求帮助。',
    },
    diaryCard: {
      label: '日记上下文',
      consumed: '已进入对话',
      pending: '发送时一并加载',
      dismissTitle: '隐藏此卡片（Agent 仍保有上下文）',
      dismissAria: '关闭日记上下文卡片',
    },
    rightPanel: {
      show: '展开右侧面板',
      hide: '收起右侧面板',
    },
    errors: {
      label: '错误',
      sendFailed: '消息发送失败',
    },
  },
  call: {
    title: '语音通话',
    closeAria: '结束通话并返回',
    state: {
      idle: '待命',
      listening: '聆听中',
      thinking: '思考中',
      speaking: '回应中',
    },
    sourceLabel: '来源',
    sourceEsp32: 'ESP32',
    sourceMic: '麦克风',
    triggerLabel: '模式',
    triggerPtt: '按住说话',
    triggerVad: '自动检测',
    holdToTalk: '按住开始说话',
    releaseToSend: '松开即发送',
    transcriptPlaceholder: '先打个招呼吧！',
    backToChat: '回到聊天',
    micUnavailable: '麦克风不可用',
    waitingAudio: '等待音频信号…',
    sendToClaude: '发送给 AI',
    transcribing: '转写中…',
    transcribeError: (err: string): string => `转写失败：${err}`,
    holdHint: '按住空格或麦克风按钮说话',
    vadHint: '直接开口说话——停顿即可发送',
    langLabel: '语言',
    langTitle: '转写语言',
    thinkingCaption: 'AI 思考中…',
    readingData: '读取数据',
    readingDataDone: '已读取',
    ttsOnTitle: '语音播报已开启 — 点击关闭',
    ttsOffTitle: '语音播报已关闭 — 点击让 AI 朗读回复',
    replyError: (err: string): string => `回复失败：${err}`,
  },
};
