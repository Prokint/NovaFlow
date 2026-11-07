/**
 * dsh-douyin-comments 的「客户端半身」。
 *
 * 为什么需要它：宿主侧的 `export const Config`（见 ../index.js）只让设置**数据**存在，
 * 不会自己长出入口。设置 → 插件 里那一行要有「配置」按钮，必须由客户端插件注册
 * `plugins.row.config`（key = `<包名>#<cordis.patch.yml 里 insert 的 id>`）。
 * 同一个页面也挂在 `plugins.bundle.config`（key = 包名）上，对齐 DSH 文档里
 * 「bundle 自己的配置放 plugins.bundle.config / plugins.row.config」的说法。
 *
 * 打包格式：DSH 的客户端 bundle 不是 ESM，而是 classic script + 模块表:
 *   window.__ModuleLoader__.load({ id: <包名>, factory: (require) => module.exports })
 * 只有 react / react-dom / @deepseek-ai/cordis / dsh-client-store / dsh-client-ui-slots /
 * dsh-client-ui-primitives / dsh-client-ui-dockkit 这些平台种子模块能 require。
 * 取值/落盘走 configForms 服务（由 @deepseek-ai/dsh-client-ui-settings 提供）：
 *   ctx.configForms.get(ns) → { getSnapshot(), subscribe(), set(field, value), mutate(ops, rev) }
 */

window.__ModuleLoader__.load({
  id: 'dsh-douyin-comments',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');
    var h = React.createElement;

    /** 与 cordis.patch.yml 里 `- id:` 一致，也是宿主设置里的 namespace（= Config 的归属） */
    var NS = 'douyin-comments';
    var PACKAGE = 'dsh-douyin-comments';
    /** 这一行在设置 → 插件 里的 key：<包名>#<row id> */
    var ROW_KEY = PACKAGE + '#' + NS;

    /** 宿主的 Config（index.js）里有哪些字段，这里就画哪些；min/max/默认值必须与那边逐项一致 */
    var FIELDS = [
      { key: 'max', label: '目标条数 max', kind: 'number', min: 1, max: 1000000, step: 1, suffix: '条',
        hint: '一级评论到量就停顶层扫描，二级回复仍补完。默认 80000' },
      { key: 'lanes', label: '顶层路数 lanes', kind: 'number', min: 1, max: 8, step: 1, suffix: '路',
        hint: '错峰多路（每路错开 200ms）；1 = 单路。扩展发现两路拿到同一页会自动降回单路。默认 3' },
      { key: 'timeoutMs', label: '总超时 timeoutMs', kind: 'number', min: 60000, max: 14400000, step: 60000, suffix: 'ms',
        hint: '默认 1800000（30 分钟）' },
      { key: 'waitLoginSec', label: '等扫码 waitLoginSec', kind: 'number', min: 0, max: 1800, step: 10, suffix: '秒',
        hint: '没登录时保持窗口等扫码的秒数；0 = 不等。默认 180' },
      { key: 'clearBefore', label: '每次先清空 clearBefore', kind: 'boolean',
        hint: '关（默认）= 保留扩展的断点续采，结束时按 cid 差集只交付本轮新采的' },
      { key: 'replyLanes', label: '二级回复并发 replyLanes', kind: 'number', min: 1, max: 8, step: 1, suffix: '路',
        hint: '撞限流时扩展会自动降 1 路。默认 4' },
      { key: 'replyGlobalGapMs', label: '回复全局限速 replyGlobalGapMs', kind: 'number', min: 0, max: 2000, step: 50, suffix: 'ms',
        hint: '回复请求跨线程的最小间隔；0 = 用扩展内置 250ms。默认 0' },
      { key: 'replyThrottleSec', label: '回复限流等待 replyThrottleSec', kind: 'number', min: 10, max: 600, step: 5, suffix: '秒',
        hint: '回复被拒时本轮总共最多等多久（分波重试）；10 = 老行为「十秒不行就收尾」。默认 120' },
      { key: 'replyNoProgressSec', label: '回复无进展收工 replyNoProgressSec', kind: 'number', min: 60, max: 7200, step: 60, suffix: '秒',
        hint: '二级回复阶段多久没有新数据就收工。默认 900' },
      { key: 'replyWarmupSec', label: '二级回复预热 replyWarmupSec', kind: 'number', min: 0, max: 600, step: 1, suffix: '秒',
        hint: '顶层采完后先静默几秒再补二级回复（刚扫完列表就打回复接口容易被拒）；0 = 不预热。默认 10' },
      { key: 'failSnapshot', label: '失败现场快照 failSnapshot', kind: 'boolean', def: true,
        hint: '失败或没采完时存截图 + 页面 HTML + 状态 JSON + 日志副本。默认开' },
      { key: 'keepSnapshots', label: '快照保留份数 keepSnapshots', kind: 'number', min: 1, max: 500, step: 1, suffix: '份',
        hint: '更旧的自动删掉。默认 20' },
    ];

    var rowStyle = { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 0', flexWrap: 'wrap' };
    var labelStyle = { fontSize: '13px', minWidth: '212px', color: 'var(--dsw-alias-label-primary, inherit)' };
    var hintStyle = { fontSize: '12px', color: 'var(--dsw-alias-label-caption, #8a8a8a)' };
    var inputStyle = { width: '110px', fontSize: '13px', padding: '3px 6px' };

    /** 订阅 configForms 的控制器快照（不依赖 React 18 的 useSyncExternalStore） */
    function useSnapshot(controller) {
      var pair = React.useState(function () { return controller.getSnapshot(); });
      var snapshot = pair[0];
      var setSnapshot = pair[1];
      React.useEffect(function () {
        function onChange() { setSnapshot(controller.getSnapshot()); }
        onChange();
        return controller.subscribe(onChange);
      }, [controller]);
      return snapshot;
    }

    /** 宿主 describe() 里现成的 namespace：优先精确匹配，其次唯一的 douyin* 候选，最后才用默认值 */
    function pickNamespace(ctx) {
      try {
        var view = ctx.configForms.describe().getSnapshot().view;
        var names = ((view && view.namespaces) || []).map(function (row) { return row.ns; });
        if (names.indexOf(NS) !== -1) return NS;
        var fuzzy = names.filter(function (n) { return /douyin/i.test(n); });
        if (fuzzy.length === 1) return fuzzy[0];
      } catch (e) { /* 拿不到镜像就用默认 namespace */ }
      return NS;
    }

    function summaryText(value) {
      if (!value || value.lanes === undefined) return '抖音评论采集（点「配置」改 max / 路数）';
      var minutes = Math.round((Number(value.timeoutMs) || 0) / 60000);
      return 'max ' + value.max + ' 条 · 顶层 ' + value.lanes + ' 路 · 超时 ' + minutes + ' 分钟'
        + ' · 等扫码 ' + value.waitLoginSec + ' 秒'
        + ' · 回复并发 ' + value.replyLanes
        + ' · 回复限流 ' + value.replyThrottleSec + ' 秒';
    }

    function makePage(ctx) {
      var controllers = new Map();
      function controllerFor(ns) {
        var found = controllers.get(ns);
        if (found === undefined) { found = ctx.configForms.get(ns); controllers.set(ns, found); }
        return found;
      }

      function Field(props) {
        var field = props.field;
        var value = props.value;
        var disabled = props.disabled;
        var commit = props.commit;
        var pair = React.useState(value);
        var draft = pair[0];
        var setDraft = pair[1];
        React.useEffect(function () { setDraft(value); }, [value]);

        if (field.kind === 'boolean') {
          return h('label', { style: rowStyle }, [
            h('input', {
              key: 'input', type: 'checkbox',
              // 没存过值时按宿主 Config 的默认值显示（failSnapshot 默认开）
              checked: draft === undefined || draft === null ? field.def === true : draft === true,
              disabled: disabled,
              onChange: function (e) { setDraft(e.target.checked); commit(field.key, e.target.checked); },
            }),
            h('span', { key: 'label', style: { fontSize: '13px' } }, field.label),
            h('span', { key: 'hint', style: hintStyle }, field.hint || ''),
          ]);
        }
        var finish = function () {
          var n = Number(draft);
          if (!isFinite(n)) { setDraft(value); return; }
          n = Math.min(field.max, Math.max(field.min, n));
          setDraft(n);
          if (n !== Number(value)) commit(field.key, n);
        };
        return h('label', { style: rowStyle }, [
          h('span', { key: 'label', style: labelStyle }, field.label),
          h('input', {
            key: 'input', type: 'number', value: draft === undefined || draft === null ? '' : draft,
            min: field.min, max: field.max, step: field.step, disabled: disabled, style: inputStyle,
            onChange: function (e) { setDraft(e.target.value); },
            onBlur: finish,
            onKeyDown: function (e) { if (e.key === 'Enter') e.currentTarget.blur(); },
          }),
          field.suffix ? h('span', { key: 'suffix', style: hintStyle }, field.suffix) : null,
          h('span', { key: 'hint', style: hintStyle }, field.hint || ''),
        ]);
      }

      return function DouyinConfigPage(props) {
        var view = (props && props.view) || 'page';
        var ns = pickNamespace(ctx);
        var snapshot = useSnapshot(controllerFor(ns));
        var settled = React.useState('');
        var status = settled[0];
        var setStatus = settled[1];
        var value = (snapshot && snapshot.value) || {};

        if (view === 'summary') {
          return h('span', { style: hintStyle }, summaryText(snapshot && snapshot.value));
        }

        var commit = function (key, next) {
          setStatus('保存中…');
          Promise.resolve(controllerFor(ns).set(key, next)).then(function (ok) {
            setStatus(ok ? '已保存，立即生效' : '保存失败：宿主拒绝了这次修改');
          }, function (err) {
            setStatus('保存失败：' + String((err && err.message) || err));
          });
        };

        var state = (snapshot && snapshot.status) || 'loading';
        var disabled = state !== 'ready' || snapshot.writable === false;
        var head = h('div', { key: 'head', style: { marginBottom: '4px' } }, [
          h('div', { key: 't', style: { fontSize: '14px', fontWeight: 500 } }, '抖音评论采集'),
          h('div', { key: 'd', style: hintStyle },
            '改完立即生效（不用重启）；工具调用里的参数只覆盖那一次，不会写回这里。'),
          h('div', { key: 's', style: Object.assign({}, hintStyle, { minHeight: '18px' }) },
            state === 'loading' ? '正在读取设置…'
              : state !== 'ready' ? '这台机器上没找到这个插件的设置（namespace=' + ns + '）'
              : disabled ? '当前是只读：设置由 profile 配置文件统管'
              : status),
        ]);
        var rows = FIELDS.map(function (field) {
          return h(Field, { key: field.key, field: field, value: value[field.key], disabled: disabled, commit: commit });
        });
        return h('div', { style: { padding: '4px 0' } }, [head].concat(rows));
      };
    }

    /** 抖音采集控制台（静态页面由服务端 webServer 托管，这里只负责 iframe 嵌入） */
    var CONSOLE_ID = 'douyin-comments-console';
    var CONSOLE_PATH = '/plugins/dsh-douyin-comments/app';

    /** v0.5.62：把 DSH 当前主题传给 iframe，避免深色界面里嵌一块白板。 */
    function dshTheme() {
      try {
        var root = document.documentElement;
        var attr = root.getAttribute('data-theme') || root.getAttribute('theme') || '';
        if (/dark/i.test(attr)) return 'dark';
        if (/light/i.test(attr)) return 'light';
        var cls = String(root.className || '');
        if (/dark/i.test(cls)) return 'dark';
        if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
      } catch (e) { /* 忽略：退回浅色 */ }
      return 'light';
    }

    /** v0.8.1：右侧面板与两个 iframe 共用的一套色板（跟网页里的 design tokens 对齐） */
    function dshPalette(theme) {
      if (theme === 'dark') {
        return {
          bg: '#0b0b0c',
          surface: '#131315',
          surface2: '#17171a',
          line: '#27272b',
          ink: '#f4f4f5',
          muted: '#a3a3a8',
          accent: '#e0a94a',
        };
      }
      return {
        bg: '#f5f6f8',
        surface: '#ffffff',
        surface2: '#f7f9fb',
        line: '#e3e7ee',
        ink: '#12161d',
        muted: '#6b7280',
        accent: '#b45309',
      };
    }

    /** DSH 主题变化（设置里切换 / 跟随系统变化）时让面板重渲染 */
    function useDshTheme() {
      var pair = React.useState(dshTheme());
      var setTheme = pair[1];
      React.useEffect(function () {
        var sync = function () { setTheme(dshTheme()); };
        var media = null;
        try {
          media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
        } catch (e) { media = null; }
        var onMedia = function () { sync(); };
        if (media) {
          if (media.addEventListener) media.addEventListener('change', onMedia);
          else if (media.addListener) media.addListener(onMedia);
        }
        var observer = null;
        try {
          observer = new MutationObserver(sync);
          observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['data-theme', 'theme', 'class'],
          });
        } catch (e) { observer = null; }
        window.addEventListener('focus', sync);
        sync();
        return function () {
          if (media) {
            if (media.removeEventListener) media.removeEventListener('change', onMedia);
            else if (media.removeListener) media.removeListener(onMedia);
          }
          if (observer) { try { observer.disconnect(); } catch (e) { /* 忽略 */ } }
          window.removeEventListener('focus', sync);
        };
      }, []);
      return pair[0];
    }

    function ConsolePage() {
      var theme = useDshTheme();
      var p = dshPalette(theme);
      return h('iframe', {
        src: CONSOLE_PATH + '/?embed=1&theme=' + theme,
        title: '抖音评论采集',
        allow: 'clipboard-read; clipboard-write',
        style: {
          display: 'block',
          width: '100%',
          height: '100%',
          minHeight: 0,
          flex: 1,
          border: 0,
          background: p.bg,
          colorScheme: theme,
        },
      });
    }

    function ConsoleIcon() {
      return h(
        'svg',
        {
          width: 20,
          height: 20,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M4 5.5h16v11H9l-5 4v-15z' }),
        h('path', { d: 'M8 9h8M8 12.5h5' }),
      );
    }

    /** ---- v0.6.0：评论词云（原 dsh-comment-viewer 合并进来） ----------------------------
     * 「整合到一块」：只保留一个入口 / 一个右侧面板，面板内部用两个小 tab 切换
     * 「采集」与「评论词云」。采集完成后自动切到词云子页并展开面板：
     * 客户端每 3 秒轮询 /viewer/api/latest，发现「最新导出」换了新的文件路径，就
     * setPanelMode('viewer') + bumpViewerGeneration()（词云 iframe 因为 src 带 gen 而重载，
     * 并带 latest=1 载入刚采的那份）+ ctx.sidebarRight.openTab() 把面板展开。
     */
    var VIEWER_PATH = '/plugins/dsh-douyin-comments/viewer';
    var VIEWER_POLL_MS = 3000;

    var viewerGeneration = 0;
    try {
      // 计数持久化：gen 在「刷新页面/重启 DSH」后必须继续递增，否则词云页那边
      // localStorage 里的 cw.latestGen 会误判成「同一个 gen」，采集完就不会自动换成最新导出。
      viewerGeneration = Number(localStorage.getItem('cw.viewerGen')) || 0;
    } catch (e) { viewerGeneration = 0; }
    var viewerSubscribers = new Set();
    function bumpViewerGeneration() {
      viewerGeneration += 1;
      try { localStorage.setItem('cw.viewerGen', String(viewerGeneration)); } catch (e) { /* 隐私模式：仅本次会话有效 */ }
      viewerSubscribers.forEach(function (fn) {
        try { fn(viewerGeneration); } catch (e) { /* 单个订阅出错不影响其它 */ }
      });
    }
    function useViewerGeneration() {
      var pair = React.useState(viewerGeneration);
      var setGen = pair[1];
      React.useEffect(function () {
        var fn = function (g) { setGen(g); };
        viewerSubscribers.add(fn);
        setGen(viewerGeneration);
        return function () { viewerSubscribers.delete(fn); };
      }, []);
      return pair[0];
    }

    function ViewerPage() {
      var gen = useViewerGeneration();
      var theme = useDshTheme();
      var p = dshPalette(theme);
      return h('iframe', {
        src: VIEWER_PATH + '/?embed=1&latest=1&gen=' + gen + '&theme=' + theme,
        title: '评论词云',
        allow: 'clipboard-read; clipboard-write',
        style: {
          display: 'block',
          width: '100%',
          height: '100%',
          minHeight: 0,
          flex: 1,
          border: 0,
          background: p.bg,
          colorScheme: theme,
        },
      });
    }

    /** 面板子页状态：console = 采集控制台，viewer = 评论词云（同一面板内切换） */
    var panelMode = 'console';
    var panelModeSubscribers = new Set();
    function setPanelMode(mode) {
      if (mode !== 'console' && mode !== 'viewer') return;
      if (mode === panelMode) return;
      panelMode = mode;
      panelModeSubscribers.forEach(function (fn) {
        try { fn(panelMode); } catch (e) { /* 单个订阅出错不影响其它 */ }
      });
    }
    function usePanelMode() {
      var pair = React.useState(panelMode);
      var setMode = pair[1];
      React.useEffect(function () {
        var fn = function (m) { setMode(m); };
        panelModeSubscribers.add(fn);
        setMode(panelMode);
        return function () { panelModeSubscribers.delete(fn); };
      }, []);
      return pair[0];
    }

    /** v0.8.1：面板顶部子页 tab —— 下划线式（激活 = 2px 琥珀线 + ink 文字），不再用色块 */
    function panelTabStyle(active, p) {
      return {
        appearance: 'none',
        border: 0,
        borderBottom: '2px solid ' + (active ? p.accent : 'transparent'),
        background: 'transparent',
        color: active ? p.ink : p.muted,
        font: 'inherit',
        fontSize: '12.5px',
        fontWeight: active ? 600 : 500,
        lineHeight: 1,
        padding: '9px 10px 7px',
        marginBottom: '-1px',
        cursor: 'pointer',
        transition: 'color .15s ease, border-color .15s ease',
      };
    }

    /** 合并后的唯一面板：顶部「采集 / 评论词云」两个 tab，下面两个 iframe 交替显示。 */
    function DouyinPanel() {
      var mode = usePanelMode();
      var theme = useDshTheme();
      var p = dshPalette(theme);
      var paneStyle = function (active) {
        return { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, display: active ? 'block' : 'none' };
      };
      return h('div', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          minHeight: 0,
          background: p.bg,
          colorScheme: theme,
        },
      }, [
        h('div', {
          key: 'bar',
          style: {
            display: 'flex',
            alignItems: 'stretch',
            gap: '2px',
            padding: '0 10px',
            flex: '0 0 auto',
            background: p.surface,
            borderBottom: '1px solid ' + p.line,
          },
        }, [
          h('button', {
            key: 'console',
            type: 'button',
            onClick: function () { setPanelMode('console'); },
            style: panelTabStyle(mode === 'console', p),
          }, '采集'),
          h('button', {
            key: 'viewer',
            type: 'button',
            onClick: function () { setPanelMode('viewer'); },
            style: panelTabStyle(mode === 'viewer', p),
          }, '评论词云'),
        ]),
        h('div', { key: 'body', style: { position: 'relative', flex: 1, minHeight: 0, background: p.bg } }, [
          h('div', { key: 'console-pane', style: paneStyle(mode === 'console') }, h(ConsolePage, { key: 'console' })),
          h('div', { key: 'viewer-pane', style: paneStyle(mode === 'viewer') }, h(ViewerPage, { key: 'viewer' })),
        ]),
      ]);
    }

    function ViewerIcon() {
      return h(
        'svg',
        {
          width: 20,
          height: 20,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('circle', { cx: 8, cy: 9, r: 3.4 }),
        h('circle', { cx: 15.5, cy: 7.5, r: 2.4 }),
        h('circle', { cx: 12.5, cy: 14.5, r: 4.2 }),
        h('circle', { cx: 18, cy: 15, r: 1.8 }),
      );
    }

    /** 展开右侧栏的「抖音评论」面板（拿不到导航控制器就静默降级：左侧入口仍然能手动打开） */
    function openPanelTab(ctx) {
      var nav = null;
      try { nav = ctx.sidebarRight; } catch (e) { nav = null; }
      if (!nav && typeof ctx.get === 'function') {
        try { nav = ctx.get('sidebarRight'); } catch (e2) { nav = null; }
      }
      if (nav && typeof nav.openTab === 'function') {
        try { nav.openTab(CONSOLE_ID, { revealIfOpened: true }); return true; } catch (e3) {
          try { console.warn('[douyin] 打开面板失败：' + ((e3 && e3.message) || e3)); } catch (e4) { /* ignore */ }
        }
      }
      return false;
    }

    function startViewerWatcher(ctx) {
      var lastPath = null;
      var primed = false;
      var stopped = false;
      function poll() {
        if (stopped) return;
        fetch(VIEWER_PATH + '/api/latest', { cache: 'no-store' }).then(function (r) {
          return r.ok ? r.json() : null;
        }).then(function (data) {
          var file = data && data.file;
          if (!file || !file.path) return;
          if (!primed) { primed = true; lastPath = String(file.path); return; }
          if (String(file.path) === lastPath) return;
          lastPath = String(file.path);
          setPanelMode('viewer');
          bumpViewerGeneration();
          openPanelTab(ctx);
        }).catch(function () { /* 服务端还没挂上 / 网络抖动：下一轮再试 */ });
      }
      poll();
      var timer = setInterval(poll, VIEWER_POLL_MS);
      // 后台标签页的定时器会被浏览器节流（可能拖到 1 分钟一次）：回到页面时补一次
      try { document.addEventListener('visibilitychange', poll); } catch (e) { /* ignore */ }
      try { window.addEventListener('focus', poll); } catch (e2) { /* ignore */ }
      if (typeof ctx.effect === 'function') {
        ctx.effect(function () {
          return function () {
            stopped = true;
            clearInterval(timer);
            try { document.removeEventListener('visibilitychange', poll); } catch (e) { /* ignore */ }
            try { window.removeEventListener('focus', poll); } catch (e2) { /* ignore */ }
          };
        });
      }
    }

    exports.name = PACKAGE;
    /** 只用 slots；configForms / sidebarRightTabs 用嵌套 inject 拿，缺了也不至于让整个插件不挂载 */
    exports.inject = ['slots'];
    exports.apply = function apply(ctx) {
      ctx.inject(['configForms'], function (scoped) {
        var Page = makePage(scoped);
        scoped.slots.inject('plugins.row.config', function () {
          return scoped.slots.register({ name: 'plugins.row.config', key: ROW_KEY }, Page);
        });
        scoped.slots.inject('plugins.bundle.config', function () {
          return scoped.slots.register({ name: 'plugins.bundle.config', key: PACKAGE }, Page);
        });
      });

      // 主区域 + 侧栏入口：和 dsh-comment-viewer 同一个 slot 模式。
      //
      // v0.5.63 修复「装好了但界面上什么都没变」：原来把 `sidebar.panellist`（左侧那条
      // 「抖音采集」）注册在 `ctx.inject(['sidebarRightTabs'])` 的回调**里面**。不同 DSH 版本的
      // sidebarRightTabs 注册协议并不相同（老版本是 guide 面板，新版本是资源预览类型
      // `{id, kind, patterns, priority, canOpen, title}`），一旦 `register` 抛错，整个回调中断，
      // 后面那条左侧入口就永远注册不上 —— 表现就是「服务端挂载成功、界面上什么都没有」。
      // 现在左侧入口独立注册（只依赖 slots），右侧标签尽力而为、失败不影响入口。
      ctx.slots.inject('main', function () {
        return ctx.slots.register({ name: 'main', key: CONSOLE_ID }, DouyinPanel);
      });
      ctx.slots.inject('sidebar.right.pane.tab', function () {
        return ctx.slots.register({ name: 'sidebar.right.pane.tab', key: CONSOLE_ID }, DouyinPanel);
      });
      ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register(
          { name: 'sidebar.panellist', id: CONSOLE_ID, order: 23, label: function () { return '抖音评论'; } },
          ConsoleIcon,
        );
      });
      // 右侧栏 tab 类型：注册失败只影响「采集完自动展开」，左侧入口照样能点（DSH 各版本协议不同）
      try {
        ctx.inject(['sidebarRightTabs'], function (scoped) {
          try {
            scoped.sidebarRightTabs.register({
              id: CONSOLE_ID,
              kind: CONSOLE_ID,
              title: function () { return '抖音评论'; },
              keepMounted: true,
              guide: [
                {
                  id: CONSOLE_ID,
                  order: 23,
                  title: function () { return '抖音评论'; },
                  description: function () { return '采集 + 交互词云 + 评论表（采集完成自动切到词云）'; },
                  icon: ConsoleIcon,
                },
              ],
            });
          } catch (e3) { /* 同名 id 已注册：忽略 */ }
        });
      } catch (e4) { /* sidebarRightTabs 服务不可用 */ }
      // 采集完成检测（工具调用与控制台两条路径都会落盘新 JSON，这里只看磁盘上最新那份）
      startViewerWatcher(ctx);
    };
    return module.exports;
  },
});
