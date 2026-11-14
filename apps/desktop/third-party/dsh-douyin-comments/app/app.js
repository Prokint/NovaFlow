/* 抖音评论采集 · DSH 内嵌控制台（无构建、无外部依赖） */
(function () {
  "use strict";

  var API_BASE = new URL("../api/", location.href);
  // v0.8.3：收藏客户接口挂在词云那侧的 prefix 下（/plugins/<包名>/viewer/api/...）。
  var FAV_API_BASE = new URL("../viewer/api/", location.href);
  var $ = function (id) { return document.getElementById(id); };

  // v0.9.10：去掉深 / 浅主题切换，固定白色（浅色）主题。
  (function fixedTheme() {
    document.documentElement.setAttribute("data-theme", "light");
    // 同步浏览器地址栏 / 移动端状态栏底色
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", "#f5f6f8");
  })();

  var state = {
    jobId: "",
    timer: 0,
    lastLogs: "",
    toastTimer: 0,
    exportsTimer: 0,
  };

  function requestJson(base, path, options) {
    var opts = options || {};
    var headers = Object.assign({}, opts.headers || {});
    if (opts.body && !headers["content-type"]) headers["content-type"] = "application/json";
    return fetch(new URL(path, base), Object.assign({}, opts, { headers: headers }))
      .then(function (res) {
        return res.text().then(function (text) {
          var data = null;
          try { data = text ? JSON.parse(text) : null; } catch (e) { /* non-json */ }
          if (!res.ok || (data && data.ok === false)) {
            var msg = (data && (data.error || data.message)) || text || ("HTTP " + res.status);
            var err = new Error(String(msg).slice(0, 800));
            err.status = res.status;
            throw err;
          }
          return data;
        });
      });
  }

  function api(path, options) {
    return requestJson(API_BASE, path, options);
  }

  function favApi(path, options) {
    return requestJson(FAV_API_BASE, path, options);
  }

  function toast(message, isError) {
    var el = $("toast");
    el.textContent = String(message || "");
    el.classList.remove("hidden");
    el.style.borderColor = isError ? "#fecaca" : "#e2e6ec";
    el.style.color = isError ? "#b91c1c" : "#1f2937";
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(function () { el.classList.add("hidden"); }, 5000);
  }

  function fmtBytes(n) {
    var size = Number(n) || 0;
    if (size < 1024) return size + " B";
    if (size < 1024 * 1024) return (size / 1024).toFixed(1) + " KB";
    return (size / 1024 / 1024).toFixed(1) + " MB";
  }

  function fmtTime(iso) {
    var d = iso ? new Date(iso) : null;
    if (!d || isNaN(d.getTime())) return "";
    var pad = function (n) { return String(n).padStart(2, "0"); };
    return (d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  function fmtDuration(ms) {
    var sec = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    if (sec < 60) return sec + "s";
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    if (m < 60) return m + "m " + s + "s";
    return Math.floor(m / 60) + "h " + (m % 60) + "m";
  }

  /** 长路径只留最后两段，完整路径放进 title（避免顶栏一行被撑很长）。 */
  function shortPath(value) {
    var text = String(value || "").trim();
    if (!text) return "—";
    var parts = text.split(/[\\/]+/).filter(Boolean);
    if (parts.length <= 2) return parts.join("\\");
    return "…\\" + parts.slice(-2).join("\\");
  }

  function phaseLabel(phase) {
    var map = {
      starting: "启动中",
      collecting: "采集中",
      replies: "补采回复",
      "waiting-sign": "等签名",
      "waiting-login": "等登录",
      "need-login": "需要登录",
      paused: "已暂停",
      done: "已完成",
      error: "失败",
      cancelled: "已取消",
      idle: "空闲",
    };
    return map[phase] || phase || "—";
  }

  function badgeClass(job) {
    if (!job || job.state === "idle") return "idle";
    if (job.state === "error" || job.state === "cancelled") return "failed";
    if (job.state === "done") return "done";
    if (job.needLogin || job.phase === "waiting-login" || job.phase === "need-login" || job.phase === "paused") return "waiting";
    return "running";
  }

  /** 任务结论优先于扩展内部 phase：成功完成后不要还显示「已暂停」。 */
  function jobBadge(job) {
    if (!job) return ["空闲", "idle"];
    if (job.state === "done") return ["已完成", "done"];
    if (job.state === "cancelled") return ["已取消", "failed"];
    if (job.state === "error") return ["失败", "failed"];
    if (job.needLogin) return ["等待登录", "waiting"];
    if (!job.phase || job.phase === "starting" || job.phase === "idle") return ["启动中", "waiting"];
    if (job.phase === "collecting") return ["采集中", "running"];
    if (job.phase === "replies") return ["补采回复", "running"];
    if (job.phase === "waiting-sign") return ["等签名", "waiting"];
    if (job.phase === "paused") return ["已暂停", "waiting"];
    return [phaseLabel(job.phase), "running"];
  }

  function setBadge(el, label, cls) {
    el.textContent = label;
    el.className = "badge " + (cls || "idle");
  }

  function downloadUrl(filePath, inline) {
    return new URL(
      "download?path=" + encodeURIComponent(String(filePath || "")) + (inline ? "&inline=1" : ""),
      API_BASE,
    ).href;
  }

  function renderLogs(job) {
    var el = $("log");
    var text = job && job.logs && job.logs.length ? job.logs.join("\n") : "—";
    if (text === state.lastLogs) return;
    var nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    state.lastLogs = text;
    el.textContent = text;
    $("logCount").textContent = job && job.logs ? job.logs.length + " 行" : "";
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }

  function renderStats(job) {
    var counts = (job && job.counts) || {};
    var result = (job && job.result) || null;
    var count = counts.unique || (result && result.count) || 0;
    $("count").textContent = String(count);
    $("saved").textContent = String(counts.savedCount || 0);
    $("elapsed").textContent = job ? fmtDuration(job.elapsedMs) : "0s";
    // v0.9.0：关键词模式把「服务端 total」这一格改成视频进度（第 n 条 / 共 m 条）
    if (counts.keyword) {
      $("total").textContent = counts.videoTotal
        ? (counts.videoIndex || 0) + "/" + counts.videoTotal + " 条视频"
        : "—";
    } else {
      $("total").textContent = counts.total ? String(counts.total) : "—";
    }

    // v0.5.62：进度算法修正。
    // 旧版用 topSeen / max，而 max 默认 80000（目标上限），实际采 200 条时也只有 0%，
    // 看起来像卡住。改为：优先用页面回报的 total（unique/total 才是真实进度）；
    // 没有 total 时，只有当用户把目标设得不大（≤5000）才用 topSeen/max，否则走不确定态。
    var max = job && job.options ? Number(job.options.max) || 0 : 0;
    var total = counts.total || 0;
    var ratio = 0;
    if (counts.keyword && counts.videoTotal > 0) {
      // 关键词模式：整体进度 = 已经处理到第几条视频（每条视频内部的进度用「已采」那一格看）
      ratio = Math.min(1, (counts.videoIndex || 0) / counts.videoTotal);
    } else if (total > 0) ratio = Math.min(1, count / total);
    else if (max > 0 && max <= 5000 && counts.topSeen > 0) ratio = Math.min(1, counts.topSeen / max);
    var bar = $("bar");
    if (job && job.done) {
      bar.classList.remove("indeterminate");
      bar.style.width = "100%";
    } else if (job && ratio > 0) {
      bar.classList.remove("indeterminate");
      bar.style.width = Math.max(2, Math.round(ratio * 100)) + "%";
    } else {
      bar.classList.add("indeterminate");
      bar.style.width = "";
    }
  }

  function clearNode(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function addText(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = text == null ? "" : String(text);
    return node;
  }

  function renderResult(job) {
    var box = $("result");
    var body = $("resultBody");
    if (!job || !job.done) {
      box.classList.add("hidden");
      clearNode(body);
      return;
    }
    box.classList.remove("hidden");
    clearNode(body);

    var r = job.result;
    var head = document.createElement("div");
    head.className = "result-summary";
    if (r && r.ok) {
      if (r.keyword) {
        head.textContent =
          "关键词「" + r.keyword + "」：采了 " + (r.videoCount || 0) + " 条视频，共 " + (r.count || 0) + " 条评论" +
          (r.account ? "（账号：" + r.account + "）" : "") +
          " · 用时 " + (r.durationSec ? r.durationSec + "s" : "—");
      } else {
        head.textContent =
          "采集完成：" + r.count + " 条" +
          (r.title ? "（" + r.title + "）" : "") +
          (r.account ? "（账号：" + r.account + "）" : "") +
          " · 视频 " + (r.videoId || "—") +
          " · 用时 " + (r.durationSec ? r.durationSec + "s" : "—") +
          " · 顶层 " + (r.lanes || job.options.lanes || "—") + " 路";
      }
    } else if (job.state === "cancelled") {
      head.textContent = "采集已取消。已采到的部分会按采集核心的逻辑尽量落盘。";
    } else {
      head.textContent = "采集未成功：" + ((r && r.error) || job.error || "未知原因");
      head.classList.add("error-text");
    }
    body.appendChild(head);

    if (r && r.ok) {
      var actions = document.createElement("div");
      actions.className = "result-actions";
      var addLink = function (label, href, blank, title) {
        var a = document.createElement("a");
        a.textContent = label;
        a.href = href;
        if (title) a.title = title;
        if (blank) { a.target = "_blank"; a.rel = "noopener"; }
        actions.appendChild(a);
      };
      if (r.csvPath) addLink("下载 CSV", downloadUrl(r.csvPath), false, r.csvPath);
      if (r.jsonPath) addLink("下载 JSON", downloadUrl(r.jsonPath), false, r.jsonPath);
      if (r.videoListPath) addLink("下载视频清单 CSV", downloadUrl(r.videoListPath), false, r.videoListPath);
      if (r.htmlPath) addLink("打开词云 HTML", downloadUrl(r.htmlPath, true), true, r.htmlPath);
      if (actions.childNodes.length) body.appendChild(actions);

      if (r.keyword && r.videos && r.videos.length) {
        var vbox = document.createElement("div");
        vbox.className = "path";
        r.videos.forEach(function (s) {
          vbox.appendChild(addText("div", "path", String(s)));
        });
        body.appendChild(vbox);
      }

      if (r.sample && r.sample.length) {
        var sample = document.createElement("div");
        sample.className = "path";
        sample.textContent = "样本：" + r.sample.slice(0, 5).join(" / ");
        body.appendChild(sample);
      }
    }

    if (r && r.logPath) body.appendChild(addText("div", "path", "运行日志：" + r.logPath));
    if (r && r.snapshotDir) body.appendChild(addText("div", "path", "失败现场：" + r.snapshotDir));
  }

  function renderJob(job) {
    var badge = jobBadge(job);
    setBadge($("badge"), badge[0], badge[1]);
    renderStats(job);
    renderLogs(job);

    var hint = $("loginHint");
    if (!job.done && (job.needLogin || job.phase === "waiting-login" || job.phase === "need-login")) {
      hint.classList.remove("hidden");
    } else {
      hint.classList.add("hidden");
    }

    var line;
    if (job.state === "done") {
      line = "已完成";
      if (job.result && job.result.count) line += " · " + job.result.count + " 条";
      line += " · 可以下载结果了";
    } else if (job.state === "error") {
      line = "失败：" + (job.error || "查看日志或失败现场");
    } else if (job.state === "cancelled") {
      line = "已取消";
    } else {
      line = badge[0];
      if (job.needLogin) line += " · 等待你在浏览器窗口登录 / 验证";
      else if (job.counts && job.counts.note) line += " · " + job.counts.note;
      else if (badge[0] === "启动中") line += " · 正在启动浏览器…";
      else line += " · 正在采集，请稍候";
    }
    $("statusLine").textContent = line;

    renderResult(job);
    $("start").disabled = !job.done;
    $("cancel").disabled = job.done;
  }

  function stopPolling() {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = 0;
    }
  }

  function poll() {
    if (!state.jobId) return;
    api("jobs/" + encodeURIComponent(state.jobId))
      .then(function (data) {
        if (!data || !data.job) return;
        renderJob(data.job);
        if (data.job.done) {
          stopPolling();
          refreshExports();
        }
      })
      .catch(function (err) {
        stopPolling();
        $("statusLine").textContent = "读取任务状态失败：" + err.message;
        $("start").disabled = false;
        $("cancel").disabled = true;
        toast("读取任务状态失败：" + err.message, true);
      });
  }

  function startCollection() {
    var url = $("url").value.trim();
    var keyword = $("keyword") ? $("keyword").value.trim() : "";
    if (!url && !keyword) {
      toast("请填视频链接，或填关键词做搜索采集", true);
      $("url").focus();
      return;
    }
    var account = $("account") ? $("account").value : "";
    var body = {};
    if (keyword) {
      // v0.9.0：关键词模式 —— 先搜视频，再逐条采评论（草稿参数透传，筛选值由后端归一化）
      body.keyword = keyword;
      body.videoCount = Number($("videoCount").value) || 0;
      body.sortType = $("sortType").value;
      body.publishTime = $("publishTime").value;
      body.duration = $("duration").value;
      body.contentType = $("contentType").value;
    } else {
      body.url = url;
    }
    if (account) {
      body.account = account;
      try { localStorage.setItem("douyin.account.v1", account); } catch (e) { /* ignore */ }
    }
    stopPolling();
    state.jobId = "";
    state.lastLogs = "";
    $("log").textContent = "启动中…";
    $("logCount").textContent = "";
    $("result").classList.add("hidden");
    $("start").disabled = true;
    $("cancel").disabled = false;
    setBadge($("badge"), "启动中", "waiting");
    $("statusLine").textContent = "正在创建任务…";

    api("jobs", { method: "POST", body: JSON.stringify(body) })
      .then(function (data) {
        if (!data || !data.job) throw new Error("服务端没有返回任务");
        state.jobId = data.job.id;
        renderJob(data.job);
        state.timer = setInterval(poll, 1000);
        window.setTimeout(poll, 250);
      })
      .catch(function (err) {
        $("start").disabled = false;
        $("cancel").disabled = true;
        setBadge($("badge"), "失败", "failed");
        $("statusLine").textContent = "启动失败：" + err.message;
        toast("启动失败：" + err.message, true);
      });
  }

  function cancelCollection() {
    if (!state.jobId) return;
    $("cancel").disabled = true;
    api("jobs/" + encodeURIComponent(state.jobId) + "/cancel", { method: "POST" })
      .then(function () {
        $("statusLine").textContent = "已请求取消，等采集核心收尾…";
        toast("已请求取消");
        poll();
      })
      .catch(function (err) {
        $("cancel").disabled = false;
        toast("取消失败：" + err.message, true);
      });
  }

  function refreshExports() {
    api("exports")
      .then(function (data) {
        var box = $("exports");
        clearNode(box);
        var files = (data && data.files) || [];
        if (!files.length) {
          box.appendChild(addText("div", "empty", "还没有导出文件"));
          return;
        }
        files.forEach(function (file) {
          var row = document.createElement("div");
          row.className = "export-row";
          var left = document.createElement("div");
          left.style.minWidth = "0";
          left.appendChild(addText("div", "export-name", file.name));
          left.appendChild(addText("div", "export-meta", fmtBytes(file.size) + " · " + fmtTime(file.mtime)));
          row.appendChild(left);
          var a = document.createElement("a");
          a.textContent = "下载";
          a.href = downloadUrl(file.path);
          row.appendChild(a);
          box.appendChild(row);
        });
      })
      .catch(function (err) {
        var box = $("exports");
        clearNode(box);
        var row = addText("div", "empty", "读取导出记录失败，点「刷新」重试");
        row.title = err.message;
        box.appendChild(row);
      });
  }

  // v0.9.27：页面自更新 —— 后端插件版本变了（DSH 重启 / 插件更新到新版）就自动刷新页面，
  // 不用每次手动 Ctrl+R。每 15s 探一次 /api/health，版本不一致就自动 reload。
  var pagePluginVersion = "";
  function watchPluginVersion() {
    if (watchPluginVersion.timer) return;
    watchPluginVersion.timer = setInterval(function () {
      api("health").then(function (data) {
        if (!data || !data.version) return;
        if (pagePluginVersion && data.version !== pagePluginVersion) {
          toast("插件已更新到 v" + data.version + "，正在自动刷新页面…");
          setTimeout(function () { location.reload(); }, 600);
        }
      }).catch(function () { /* 窗口关闭 / 网络抖动：忽略，下次再探 */ });
    }, 15000);
  }

  function loadConfig() {
    api("config")
      .then(function (data) {
        var d = (data && data.defaults) || {};
        // v0.9.10：目标条数 / 顶层路数 / 总超时 / 等扫码 / 补采回复等高级参数不再展示，一律走后端默认值。
        // 关键词模式的默认视频条数
        if ($("videoCount")) $("videoCount").value = Math.max(1, Math.min(100, Number(d.keywordVideoCount) || 10));
        $("version").textContent = "v" + (data.version || "—");
        pagePluginVersion = data.version || pagePluginVersion;
        var out = $("outDir");
        out.textContent = data.outDir ? "输出：" + shortPath(data.outDir) : "";
        out.title = data.outDir || "";
      })
      .catch(function (err) {
        toast("读取配置失败（使用默认值）：" + err.message, true);
      });
  }

  function loadAccounts() {
    var select = $("account");
    var hint = $("accountHint");
    var saved = "";
    try { saved = localStorage.getItem("douyin.account.v1") || ""; } catch (e) { saved = ""; }
    api("accounts")
      .then(function (data) {
        clearNode(select);
        select.appendChild(optionItem("", "不指定（用本插件自己的登录态）"));
        var list = (data && data.accounts) || [];
        var accountHints = {};   // v0.8.0：抖店卖家号通常没有 douyin.com 登录，选中时提示一下
        list.forEach(function (a) {
          var label = a.name + "（" + a.platformLabel + " " + a.accountTypeLabel + "，" + (a.backendLabel || a.backend) + "）";
          var opt = optionItem(a.id, label);
          if (!a.readable) opt.disabled = true;
          if (a.hint) accountHints[a.id] = a.hint;
          select.appendChild(opt);
        });
        if (saved) {
          var found = false;
          for (var i = 0; i < select.options.length; i++) if (select.options[i].value === saved) found = true;
          if (found) select.value = saved;
        }
        var showAccountHint = function () {
          var picked = accountHints[select.value];
          if (picked) {
            hint.hidden = false;
            hint.textContent = "这个抖店号还需要在 douyin.com 登录过";
            hint.title = picked;
          } else if (!list.length) {
            hint.hidden = false;
            hint.textContent = "shop-accounts 里没有抖音账号，可先用本插件登录态";
            hint.title = "在 shop-accounts 里加一个抖音账号并登录后，就能在这里选它来采集";
          } else {
            hint.hidden = true;
            hint.textContent = "";
            hint.title = "";
          }
        };
        if (!select.dataset.hintBound) {
          select.dataset.hintBound = "1";
          select.addEventListener("change", showAccountHint);
        }
        if (data && data.ok === false) {
          hint.hidden = false;
          hint.textContent = "shop-accounts 未就绪";
          hint.title = String((data && data.error) || "");
        } else {
          showAccountHint();
        }
      })
      .catch(function (err) {
        hint.hidden = false;
        hint.textContent = "读取 shop-accounts 失败";
        hint.title = err.message;
      });
  }

  function optionItem(value, label) {
    var opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    return opt;
  }

  /* ===================== v0.8.3：收藏客户（采集页也能看 / 管） =====================
   * 数据由服务端管理（`$DSH_HOME/douyin-collector/favorites.json`，按账号隔离；见词云那侧
   * 的 `/viewer/api/favorites`）。这里只做「列表 / 搜索 / 移除 / 导出 CSV」——收藏动作仍然在
   * 评论词云的评论表 ★ 上完成，采集页负责汇总查看与清理。
   */
  var favState = { list: [], loaded: false, failed: false, error: "", region: "" };

  function fmtStamp(ms) {
    var d = new Date(Number(ms) || 0);
    if (!d || isNaN(d.getTime())) return "";
    var pad = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  function initialsOf(name) {
    var text = String(name || "").trim();
    if (!text) return "★";
    return text.slice(0, 2);
  }

  function favProfileHref(user) {
    if (!user) return "";
    if (user.profileUrl) return String(user.profileUrl);
    if (user.secUid) return "https://www.douyin.com/user/" + encodeURIComponent(user.secUid);
    if (user.uniqueId) return "https://www.douyin.com/user/" + encodeURIComponent(user.uniqueId);
    return "";
  }

  function favRegionOf(user) {
    return String((user && user.region) || "").trim() || "未知属地";
  }

  function favMatches(user, keyword) {
    if (!keyword) return true;
    var hay = [
      user.nickname,
      user.uniqueId,
      user.uid,
      user.region,
      user.note,
      (user.tags || []).join(" "),
    ].join(" ").toLowerCase();
    return hay.indexOf(keyword) >= 0;
  }

  /** v0.8.5：当前搜索 + 属地筛选后的收藏客户列表。 */
  function favFiltered() {
    var keyword = "";
    var search = $("favSearch");
    if (search) keyword = String(search.value || "").trim().toLowerCase();
    var region = String(favState.region || "").trim();
    return (favState.list || []).filter(function (user) {
      if (region && favRegionOf(user) !== region) return false;
      return favMatches(user, keyword);
    });
  }

  /** v0.8.5：属地下拉：只列收藏里出现过的属地，按人数降序；保留当前选择。 */
  function fillFavRegion() {
    var select = $("favRegion");
    if (!select) return;
    var counts = new Map();
    (favState.list || []).forEach(function (user) {
      var region = favRegionOf(user);
      counts.set(region, (counts.get(region) || 0) + 1);
    });
    var picked = String(favState.region || "");
    var rows = Array.from(counts.entries()).sort(function (a, b) { return b[1] - a[1] || a[0].localeCompare(b[0], "zh"); });
    clearNode(select);
    var all = document.createElement("option");
    all.value = "";
    all.textContent = "全部属地";
    select.appendChild(all);
    rows.forEach(function (row) {
      var opt = document.createElement("option");
      opt.value = row[0];
      opt.textContent = row[0] + "（" + row[1] + "）";
      select.appendChild(opt);
    });
    if (picked && !counts.has(picked)) picked = "";
    favState.region = picked;
    select.value = picked;
    select.disabled = !rows.length;
  }

  function renderFavorites() {
    var box = $("favs");
    if (!box) return;
    clearNode(box);

    var all = favState.list || [];
    var shown = favFiltered();
    var filtering = !!(String(favState.region || "").trim()) || (function () {
      var search = $("favSearch");
      return !!(search && String(search.value || "").trim());
    })();

    var countEl = $("favCount");
    if (countEl) {
      countEl.textContent = filtering ? shown.length + " / " + all.length + " 位" : all.length + " 位";
      countEl.className = "badge " + (all.length ? "done" : "idle");
    }

    if (favState.failed) {
      var failedRow = addText("div", "empty", "读取失败，点「刷新」重试");
      if (favState.error) failedRow.title = favState.error;
      box.appendChild(failedRow);
      return;
    }
    if (!all.length) {
      box.appendChild(addText("div", "empty", favState.loaded ? "还没有收藏的客户" : "加载中…"));
      return;
    }
    if (!shown.length) {
      box.appendChild(addText("div", "empty", "没有符合筛选条件的收藏客户"));
      return;
    }

    shown.forEach(function (user) {
      var row = document.createElement("div");
      row.className = "fav-row";

      var avatar = document.createElement("span");
      avatar.className = "fav-avatar";
      avatar.textContent = initialsOf(user.nickname);
      // v0.9.10：收藏记录带 avatar 时显示真实头像（服务端会从最近导出数据里给老收藏补头像）
      if (user.avatar) {
        var avatarImg = new Image();
        avatarImg.className = "fav-avatar-img";
        avatarImg.loading = "lazy";
        avatarImg.referrerPolicy = "no-referrer";
        avatarImg.alt = "";
        avatarImg.src = String(user.avatar);
        avatarImg.addEventListener("error", function () { avatarImg.remove(); });
        avatar.appendChild(avatarImg);
      }
      row.appendChild(avatar);

      var main = document.createElement("div");
      main.className = "fav-main";
      var nameLine = document.createElement("div");
      nameLine.className = "fav-name-line";
      nameLine.appendChild(addText("span", "fav-name", user.nickname || "（无昵称）"));
      if (user.uniqueId) nameLine.appendChild(addText("span", "fav-uid", "抖音号 " + user.uniqueId));
      else if (user.uid) nameLine.appendChild(addText("span", "fav-uid", "uid " + user.uid));
      main.appendChild(nameLine);

      var metaParts = [];
      if (user.region) metaParts.push(user.region);
      if (user.savedAt) metaParts.push("收藏于 " + fmtStamp(user.savedAt));
      if (user.note) metaParts.push(user.note);
      if (user.tags && user.tags.length) metaParts.push(user.tags.join(" / "));
      main.appendChild(addText("div", "fav-meta", metaParts.join(" · ") || "—"));
      row.appendChild(main);

      var actions = document.createElement("div");
      actions.className = "fav-actions";
      var href = favProfileHref(user);
      if (href) {
        var link = document.createElement("a");
        link.className = "btn small ghost";
        link.textContent = "主页";
        link.href = href;
        link.target = "_blank";
        link.rel = "noopener";
        actions.appendChild(link);
      }
      var remove = document.createElement("button");
      remove.type = "button";
      remove.className = "btn small ghost danger";
      remove.textContent = "移除";
      remove.addEventListener("click", function () { removeFavorite(user); });
      actions.appendChild(remove);
      row.appendChild(actions);

      box.appendChild(row);
    });
  }

  function loadFavorites() {
    favApi("favorites")
      .then(function (data) {
        favState.list = (data && data.favorites) || [];
        favState.loaded = true;
        favState.failed = false;
        favState.error = "";
        var searchEl = $("favSearch");
        if (searchEl) searchEl.title = data && data.file ? "收藏文件：" + data.file : "";
        fillFavRegion();
        renderFavorites();
      })
      .catch(function (err) {
        favState.loaded = true;
        favState.failed = true;
        favState.error = err.message;
        fillFavRegion();
        renderFavorites();
        toast("读取收藏客户失败：" + err.message, true);
      });
  }

  function removeFavorite(user) {
    if (!user || !user.uid) return;
    favApi("favorites/remove", { method: "POST", body: JSON.stringify({ uid: user.uid }) })
      .then(function () {
        favState.list = (favState.list || []).filter(function (item) { return item.uid !== user.uid; });
        fillFavRegion();
        renderFavorites();
        toast("已取消收藏「" + (user.nickname || user.uid) + "」");
      })
      .catch(function (err) {
        toast("取消收藏失败：" + err.message, true);
      });
  }

  function exportFavoritesCsv() {
    var list = favFiltered();
    if (!list.length) {
      toast(favState.list && favState.list.length ? "当前筛选没有收藏客户可导出" : "还没有收藏的客户可导出", true);
      return;
    }
    var quote = function (value) {
      var text = String(value == null ? "" : value);
      return '"' + text.replace(/"/g, '""') + '"';
    };
    var header = ["昵称", "抖音号", "uid", "sec_uid", "属地", "标签", "首次收藏", "最近收藏", "备注", "主页"];
    var rows = list.map(function (user) {
      return [
        user.nickname || "",
        user.uniqueId || "",
        user.uid || "",
        user.secUid || "",
        user.region || "",
        (user.tags || []).join(" / "),
        fmtStamp(user.firstSavedAt),
        fmtStamp(user.savedAt),
        user.note || "",
        favProfileHref(user),
      ].map(quote).join(",");
    });
    var csv = "\ufeff" + header.map(quote).join(",") + "\r\n" + rows.join("\r\n") + "\r\n";
    var blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var d = new Date();
    var pad = function (n) { return String(n).padStart(2, "0"); };
    var stamp = "" + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + "-" + pad(d.getHours()) + pad(d.getMinutes());
    var a = document.createElement("a");
    a.href = url;
    a.download = "收藏客户-" + stamp + ".csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
    toast("已导出 " + list.length + " 位收藏客户");
  }

  // v0.9.23：本机抖音账号资质（采集页直接展示；只读识别，不发送任何内容）
  var ACCT_LABELS = {
    enterprise: "蓝V企业号",
    personal: "个人账号",
    unverified: "白号（新号）",
  };
  var ACCT_RISK = {
    enterprise: "风险档位较低：评论 200-300 条 / 站内信 80 条 / 每小时打招呼 ≤ 30 次（运营经验值，非官方额度）",
    personal: "个人账号口径：评论 ≤ 200 条 / 站内信 ≤ 30 条 / 每小时打招呼 ≤ 5 次；遇验证或频繁提示立即停",
    unverified: "白号（注册不足 1 个月的新号）：不建议站内信（建议 0 条），评论 ≤ 50 条；新号更容易触发验证，遇验证或频繁提示立即停",
  };

  function fmtAcctTime(value) {
    if (!value) return "";
    var d = new Date(value);
    if (isNaN(d.getTime())) return "";
    return "上次识别 " + fmtTime(d.toISOString());
  }

  function renderAccountProfile(entry) {
    var card = $("acctCard");
    if (!card) return;
    var type = String((entry && entry.accountType) || "");
    var label = ACCT_LABELS[type] || "";
    var typeEl = $("acctType");
    typeEl.textContent = label || "未检测";
    typeEl.className = "acct-type" + (type ? " " + type : "");
    card.dataset.state = type || "empty";
    $("acctNick").textContent = (entry && entry.nickname) ? entry.nickname : "还没识别过本机抖音账号";
    var meta = $("acctMeta");
    if (entry && type) {
      meta.hidden = false;
      $("acctUid").textContent = String(entry.uid || "—");
      $("acctUnique").textContent = String(entry.uniqueId || "—");
      $("acctFans").textContent = String(Number(entry.followers) || 0);
      $("acctWorks").textContent = String(Number(entry.awemeCount) || 0);
    } else {
      meta.hidden = true;
    }
    $("acctHint").textContent = type && ACCT_RISK[type] ? ACCT_RISK[type] : "还没识别过：点右侧按钮读取当前浏览器里登录的抖音账号资料。";
    var foot = $("acctChecked");
    var stamp = fmtAcctTime(entry && entry.checkedAt ? entry.checkedAt : Date.parse(entry && entry.checkedAtMs || ""));
    if (stamp) { foot.hidden = false; foot.textContent = stamp + " · 只读，不发送任何内容"; }
    else foot.hidden = true;
    // v0.9.24：话术库跟着账号类型走（白号只给公开评论话术）
    var nextType = type || "";
    if (scriptState.accountType !== nextType) {
      scriptState.accountType = nextType;
      if ($("scriptList")) loadScripts();
    }
  }

  function loadAccountProfile() {
    if (!$("acctCard")) return;
    var account = $("account") ? $("account").value || "" : "";
    var query = account ? "?account=" + encodeURIComponent(account) : "";
    api("account" + query)
      .then(function (data) {
        if (!data || data.ok === false) return;
        renderAccountProfile(data.entry || null);
      })
      .catch(function () { /* 拿不到就保持未检测状态 */ });
  }

  function refreshAccountProfile() {
    var button = $("acctRefresh");
    if (!button || button.disabled) return;
    var previous = button.textContent;
    button.disabled = true;
    button.textContent = "识别中…（可能要扫码）";
    var account = $("account") ? $("account").value || "" : "";
    api("account/refresh", { method: "POST", body: JSON.stringify({ account: account }) })
      .then(function (data) {
        if (!data || !data.entry) throw new Error("没拿到账号资料");
        renderAccountProfile(data.entry);
        toast("已识别：" + (ACCT_LABELS[data.entry.accountType] || "账号"));
      })
      .catch(function (err) { toast("识别失败：" + err.message, true); })
      .then(function () {
        button.disabled = false;
        button.textContent = previous;
      });
  }

  // v0.9.24：获客话术库（纯文案资产，插件不发送任何内容；只做浏览 / 复制 / 随机轮换）
  var scriptState = {
    scene: "",
    accountType: "",
    libraryVersion: "",
    scenes: [],
    allowedScenes: [],
    rules: [],
    list: [],
    picked: null,
    avoid: [],
  };

  function scriptUsageToday() {
    try {
      var raw = JSON.parse(localStorage.getItem("cw.scriptUsage") || "{}");
      var today = new Date().toISOString().slice(0, 10);
      if (raw.date !== today) return 0;
      return Number(raw.count) || 0;
    } catch (e) { return 0; }
  }

  function bumpScriptUsage() {
    var today = new Date().toISOString().slice(0, 10);
    var count = scriptUsageToday() + 1;
    try { localStorage.setItem("cw.scriptUsage", JSON.stringify({ date: today, count: count })); } catch (e) { /* ignore */ }
    var el = $("scriptUsage");
    if (el) el.textContent = "今日已复制 " + count + " 条";
  }

  function copyText(text) {
    var task = navigator.clipboard && navigator.clipboard.writeText
      ? navigator.clipboard.writeText(text)
      : Promise.reject(new Error("no clipboard"));
    return task.catch(function () {
      return new Promise(function (resolve, reject) {
        try {
          var ta = document.createElement("textarea");
          ta.value = text;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          var ok = document.execCommand("copy");
          document.body.removeChild(ta);
          ok ? resolve() : reject(new Error("copy failed"));
        } catch (err) { reject(err); }
      });
    });
  }

  function scriptSceneLabel(scene) {
    var hit = (scriptState.scenes || []).filter(function (s) { return s.id === scene; })[0];
    return hit ? hit.label : scene;
  }

  function renderScriptTabs() {
    var wrap = $("scriptSceneTabs");
    if (!wrap) return;
    clearNode(wrap);
    var items = [{ id: "", label: "全部" }].concat((scriptState.scenes || []).filter(function (s) {
      // v0.9.24：白号只允许公开评论，私信/追问 tab 直接不显示，避免点了空列表
      if (!scriptState.allowedScenes || !scriptState.allowedScenes.length) return true;
      return scriptState.allowedScenes.indexOf(s.id) > -1;
    }));
    items.forEach(function (item) {
      var active = (scriptState.scene || "") === item.id;
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn small script-tab" + (active ? " active" : "");
      btn.textContent = item.label;
      btn.addEventListener("click", function () {
        scriptState.scene = item.id;
        renderScriptTabs();
        loadScripts();
      });
      wrap.appendChild(btn);
    });
  }

  function renderScriptRules() {
    var box = $("scriptRuleBox");
    if (!box) return;
    clearNode(box);
    var rules = scriptState.rules || [];
    if (!rules.length) return;
    var title = document.createElement("div");
    title.className = "script-rules-title";
    title.textContent = "使用规则（避免验证 / 封禁）";
    box.appendChild(title);
    rules.forEach(function (text) {
      var row = document.createElement("div");
      row.className = "script-rule";
      row.textContent = "· " + text;
      box.appendChild(row);
    });
  }

  function makeCopyButton(text) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn small";
    btn.textContent = "复制";
    btn.addEventListener("click", function () {
      copyText(text).then(function () {
        bumpScriptUsage();
        toast("已复制，去抖音手动发送（插件不会自动发）");
      }).catch(function (err) { toast("复制失败：" + err.message, true); });
    });
    return btn;
  }

  function renderScriptPick() {
    var box = $("scriptPick");
    if (!box) return;
    var pick = scriptState.picked;
    if (!pick) { box.classList.add("hidden"); return; }
    box.classList.remove("hidden");
    clearNode(box);
    var head = document.createElement("div");
    head.className = "script-pick-head";
    var tag = document.createElement("span");
    tag.className = "script-tag";
    tag.textContent = scriptSceneLabel(pick.scene) + " · " + (pick.title || "");
    head.appendChild(tag);
    head.appendChild(makeCopyButton(pick.text));
    box.appendChild(head);
    var body = document.createElement("div");
    body.className = "script-pick-text";
    body.textContent = pick.text;
    box.appendChild(body);
    var note = document.createElement("div");
    note.className = "script-pick-note";
    note.textContent = "复制后把 {…} 里的变量换成真实内容再发；同一句别连续用。";
    box.appendChild(note);
  }

  function renderScriptList() {
    var list = $("scriptList");
    if (!list) return;
    clearNode(list);
    var meta = $("scriptMeta");
    if (meta) {
      var libVer = scriptState.libraryVersion || "0.9.27";
      meta.textContent = (scriptState.list || []).length + " 条 · 库 " + libVer;
    }
    var items = scriptState.list || [];
    if (!items.length) {
      var empty = document.createElement("div");
      empty.className = "script-empty";
      empty.textContent = scriptState.accountType === "unverified"
        ? "当前账号是白号（注册不足 1 个月的新号），只建议公开评论；私信内容不展示。"
        : "这个场景下没有可用话术。";
      list.appendChild(empty);
      return;
    }
    items.forEach(function (item) {
      var row = document.createElement("div");
      row.className = "script-item";
      var main = document.createElement("div");
      main.className = "script-main";
      var top = document.createElement("div");
      top.className = "script-item-top";
      var tag = document.createElement("span");
      tag.className = "script-tag";
      tag.textContent = scriptSceneLabel(item.scene) + " · " + (item.title || "");
      top.appendChild(tag);
      main.appendChild(top);
      var text = document.createElement("div");
      text.className = "script-text";
      text.textContent = item.text;
      main.appendChild(text);
      row.appendChild(main);
      row.appendChild(makeCopyButton(item.text));
      list.appendChild(row);
    });
  }

  function loadScripts() {
    if (!$("scriptList")) return;
    var query = [];
    if (scriptState.scene) query.push("scene=" + encodeURIComponent(scriptState.scene));
    if (scriptState.accountType) query.push("accountType=" + encodeURIComponent(scriptState.accountType));
    var path = "scripts" + (query.length ? "?" + query.join("&") : "");
    api(path).then(function (data) {
      if (!data || data.ok === false) return;
      scriptState.libraryVersion = data.libraryVersion || scriptState.libraryVersion;
      scriptState.scenes = data.scenes || scriptState.scenes;
      scriptState.allowedScenes = data.allowedScenes || scriptState.allowedScenes;
      scriptState.rules = data.rules || scriptState.rules;
      if (scriptState.scene && scriptState.allowedScenes.length
        && scriptState.allowedScenes.indexOf(scriptState.scene) === -1) {
        scriptState.scene = "";
      }
      scriptState.list = data.scripts || [];
      renderScriptTabs();
      renderScriptRules();
      renderScriptList();
      renderSendQuota(data.quota, data.recentSends);
      var hint = $("scriptHint");
      if (hint) {
        var typeLabel = ACCT_LABELS[scriptState.accountType] || "";
        hint.textContent = typeLabel
          ? "已按「" + typeLabel + "」筛选：只显示这类账号能用的场景。话术由你自己复制、自己发，插件不发送任何内容。"
          : "话术由你自己复制、自己发，插件不发送任何内容。同一句别连续用，尽量轮换。";
      }
    }).catch(function (err) {
      var list = $("scriptList");
      if (!list) return;
      clearNode(list);
      var empty = document.createElement("div");
      empty.className = "script-empty";
      var message = String(err && err.message || err || "");
      // v0.9.27：还在跑旧 console.mjs 时后端没有 /api/scripts，会报「接口不存在」——给出明确的下一步
      empty.textContent = message.indexOf("接口不存在") > -1
        ? "话术库接口还没生效：这是旧的后端模块缓存，需要重启 DSH Desktop（右键托盘图标 →「Restart DSH Desktop」）后再回到本页。"
        : "话术库读取失败：" + message;
      list.appendChild(empty);
    });
  }

  var SEND_SCENE_LABELS = { comment: "评论", dm: "私信打招呼", outreach: "主动获客", followup: "追问" };
  function formatShortTime(iso) {
    var d = new Date(String(iso || ""));
    if (isNaN(d.getTime())) return String(iso || "—");
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    return pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  // v0.9.37：把「今天/本小时发了多少条 + 最近发了谁」显示在话术卡里（数据来自本机 outreach-log.json）
  function renderSendQuota(quota, recent) {
    var line = $("sendQuotaLine");
    var box = $("sendRecent");
    if (!line || !box) return;
    if (!quota) {
      line.textContent = "发送记录：暂时读不到（后端还没加载新版 console.mjs？）";
      return;
    }
    var limits = quota.limits || {};
    var used = quota.used || {};
    line.textContent = quota.accountTypeLabel + "：今天私信 " + (used.dmToday || 0) + "/" + (limits.dmPerDay || 0)
      + " 条 · 本小时私信 " + (used.dmThisHour || 0) + "/" + (limits.dmPerHour || 0)
      + " 条 · 今天评论 " + (used.commentToday || 0) + "/" + (limits.commentPerDay || 0)
      + " 条 · 今天关注 " + (used.followsToday || 0) + " 个";
    clearNode(box);
    var list = Array.isArray(recent) ? recent : [];
    if (!list.length) {
      box.textContent = "还没有发送记录（本机 outreach-log.json 为空）";
      return;
    }
    var head = document.createElement("div");
    head.className = "send-recent-item send-recent-head";
    head.textContent = "时间 · 场景 · 话术 · 目标 · 关注";
    box.appendChild(head);
    list.forEach(function (entry) {
      var row = document.createElement("div");
      row.className = "send-recent-item";
      row.textContent = formatShortTime(entry.at)
        + " · " + (SEND_SCENE_LABELS[entry.scene] || entry.scene || "—")
        + " · " + (entry.scriptId || "—")
        + " · " + (entry.target || "—")
        + (entry.followed ? " · 已关注" : "");
      box.appendChild(row);
    });
  }

  function randomScript() {
    var button = $("scriptRandom");
    if (button && button.disabled) return;
    if (button) { button.disabled = true; button.textContent = "挑一条…"; }
    api("scripts/pick", {
      method: "POST",
      body: JSON.stringify({
        scene: scriptState.scene,
        accountType: scriptState.accountType,
        avoidIds: scriptState.avoid,
      }),
    }).then(function (data) {
      if (!data || !data.script) throw new Error("没拿到话术");
      scriptState.picked = data.script;
      scriptState.avoid = [data.script.id].concat(scriptState.avoid).slice(0, 8);
      renderScriptPick();
    }).catch(function (err) {
      toast("随机话术失败：" + err.message, true);
    }).then(function () {
      if (button) { button.disabled = false; button.textContent = "随机一条"; }
    });
  }

  function bind() {
    $("start").addEventListener("click", startCollection);
    $("cancel").addEventListener("click", cancelCollection);
    $("refreshExports").addEventListener("click", refreshExports);
    if ($("acctRefresh")) $("acctRefresh").addEventListener("click", refreshAccountProfile);
    $("refreshFavs").addEventListener("click", loadFavorites);
    $("exportFavs").addEventListener("click", exportFavoritesCsv);
    $("favSearch").addEventListener("input", renderFavorites);
    $("favRegion").addEventListener("change", function () {
      favState.region = $("favRegion").value || "";
      renderFavorites();
    });
    $("url").addEventListener("keydown", function (event) {
      if (event.key === "Enter") startCollection();
    });
    // v0.9.14：粘贴分享文案 / v.douyin.com 短链时自动还原成作品页链接（失败就保留原文，提交时后端还会再解析一次）
    // v0.9.16：多条链接（逗号 / 空格 / 换行分隔）保留原文，只提示「识别到 N 条」，提交时由后端拆成数组逐条采集
    var resolveUrlField = function () {
      var input = $("url");
      var raw = input.value.trim();
      if (!raw || !/https?:\/\//.test(raw)) return;
      // 已经是标准作品页直链（可能带查询参数）就不用再解析；带整段分享文案的会走解析器抽链接
      if (/^https?:\/\/(?:www\.)?douyin\.com\/(?:video|note)\/\d{15,25}\/?(?:[?#][^\s]*)?$/.test(raw)) return;
      api("resolve", { method: "POST", body: JSON.stringify({ text: raw }) })
        .then(function (data) {
          if (!data) return;
          if (Number(data.count) > 1) {
            toast("识别到 " + data.count + " 条链接，将逐条采集");
            return;
          }
          if (data.url) {
            input.value = data.url;
            toast("已识别视频 " + (data.videoId || ""));
          }
        })
        .catch(function (err) { toast("链接解析失败：" + err.message, true); });
    };
    $("url").addEventListener("paste", function () { setTimeout(resolveUrlField, 80); });
    $("url").addEventListener("blur", resolveUrlField);
    // v0.9.0：关键词模式 —— 填了关键词才显示条数/筛选行
    // v0.9.10：高级参数（总超时等）不再展示，默认值由后端决定
    var syncKeywordUi = function () {
      var on = !!($("keyword") && $("keyword").value.trim());
      var row1 = $("keywordRow1");
      var row2 = $("keywordRow2");
      if (row1) row1.hidden = !on;
      if (row2) row2.hidden = !on;
    };
    if ($("keyword")) {
      $("keyword").addEventListener("input", syncKeywordUi);
      $("keyword").addEventListener("keydown", function (event) {
        if (event.key === "Enter") startCollection();
      });
    }
    if ($("account")) {
      $("account").addEventListener("change", function () { loadAccountProfile(); });
    }
    // v0.9.24：话术库随机挑一条（纯复制辅助，不发送）
    if ($("scriptRandom")) {
      $("scriptRandom").addEventListener("click", randomScript);
    }
    var usage = $("scriptUsage");
    if (usage) usage.textContent = "今日已复制 " + scriptUsageToday() + " 条";
    syncKeywordUi();
  }

  // v0.9.38：?view=outreach → 获客工作台
  // 同一个页面，隐藏「新建采集 / 采集状态 / 导出记录」三块，只留「我的抖音账号 / 收藏客户 / 话术库 + 发送记录」。
  // 这样 NovaFlow 付费版可以继续不展示采集页（同事的设计），同时保留获客要用的页面功能。
  function applyPageMode() {
    var params = new URLSearchParams(location.search);
    var mode = params.get("view") || "";
    if (mode !== "outreach") return;
    document.body.classList.add("outreach-mode");
    var title = $("pageTitle");
    if (title) title.textContent = "获客工作台";
    document.title = "获客工作台";
    var outDir = $("outDir");
    if (outDir) outDir.hidden = true;
  }

  applyPageMode();
  bind();
  loadConfig();
  loadAccounts();
  loadAccountProfile();
  loadScripts();
  refreshExports();
  loadFavorites();
  watchPluginVersion();
})();
