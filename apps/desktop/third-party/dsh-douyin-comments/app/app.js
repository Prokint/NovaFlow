/* 抖音评论采集 · DSH 内嵌控制台（无构建、无外部依赖） */
(function () {
  "use strict";

  var API_BASE = new URL("../api/", location.href);
  var $ = function (id) { return document.getElementById(id); };

  // v0.5.62：跟随 DSH 主题（由 client.js 通过 ?theme=dark|light 传进来；独立打开时用系统偏好）。
  (function initTheme() {
    var asked = "";
    try { asked = new URLSearchParams(location.search).get("theme") || ""; } catch (e) { /* ignore */ }
    var dark = asked ? asked === "dark" : !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  })();

  var state = {
    jobId: "",
    timer: 0,
    lastLogs: "",
    toastTimer: 0,
    exportsTimer: 0,
  };

  function api(path, options) {
    var opts = options || {};
    var headers = Object.assign({}, opts.headers || {});
    if (opts.body && !headers["content-type"]) headers["content-type"] = "application/json";
    return fetch(new URL(path, API_BASE), Object.assign({}, opts, { headers: headers }))
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
    $("total").textContent = counts.total ? String(counts.total) : "—";
    $("elapsed").textContent = job ? fmtDuration(job.elapsedMs) : "0s";

    // v0.5.62：进度算法修正。
    // 旧版用 topSeen / max，而 max 默认 80000（目标上限），实际采 200 条时也只有 0%，
    // 看起来像卡住。改为：优先用页面回报的 total（unique/total 才是真实进度）；
    // 没有 total 时，只有当用户把目标设得不大（≤5000）才用 topSeen/max，否则走不确定态。
    var max = job && job.options ? Number(job.options.max) || 0 : 0;
    var total = counts.total || 0;
    var ratio = 0;
    if (total > 0) ratio = Math.min(1, count / total);
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
      head.textContent =
        "采集完成：" + r.count + " 条" +
        (r.title ? "（" + r.title + "）" : "") +
        " · 视频 " + (r.videoId || "—") +
        " · 用时 " + (r.durationSec ? r.durationSec + "s" : "—") +
        " · 顶层 " + (r.lanes || job.options.lanes || "—") + " 路";
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
      var addLink = function (label, href, blank) {
        var a = document.createElement("a");
        a.textContent = label;
        a.href = href;
        if (blank) { a.target = "_blank"; a.rel = "noopener"; }
        actions.appendChild(a);
      };
      if (r.csvPath) addLink("下载 CSV", downloadUrl(r.csvPath));
      if (r.jsonPath) addLink("下载 JSON", downloadUrl(r.jsonPath));
      if (r.htmlPath) addLink("打开词云 HTML", downloadUrl(r.htmlPath, true), true);
      if (actions.childNodes.length) body.appendChild(actions);

      if (r.sample && r.sample.length) {
        var sample = document.createElement("div");
        sample.className = "path";
        sample.textContent = "样本：" + r.sample.slice(0, 5).join(" / ");
        body.appendChild(sample);
      }
      if (r.csvPath) body.appendChild(addText("div", "path", "CSV：" + r.csvPath));
      if (r.jsonPath) body.appendChild(addText("div", "path", "JSON：" + r.jsonPath));
      if (r.htmlPath) body.appendChild(addText("div", "path", "词云：" + r.htmlPath));
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
    if (!url) {
      toast("请先粘贴抖音视频链接", true);
      $("url").focus();
      return;
    }
    var max = Number($("max").value);
    var lanes = Number($("lanes").value);
    var timeoutMin = Number($("timeout").value);
    var waitLogin = Number($("waitLogin").value);
    var body = {
      url: url,
      replies: $("replies").checked,
      clearBefore: $("clearBefore").checked,
      cloud: $("cloud").checked,
    };
    if (max > 0) body.max = max;
    if (lanes > 0) body.lanes = lanes;
    if (timeoutMin > 0) body.timeoutMs = Math.round(timeoutMin * 60000);
    if (Number.isFinite(waitLogin) && waitLogin >= 0) body.waitLoginSec = waitLogin;

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
          box.appendChild(addText("div", "empty", "还没有导出文件。完成一次采集后会出现在这里。"));
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
        box.appendChild(addText("div", "empty", "读取导出记录失败：" + err.message));
      });
  }

  function loadConfig() {
    api("config")
      .then(function (data) {
        var d = (data && data.defaults) || {};
        $("max").value = d.max || 80000;
        $("lanes").value = String(d.lanes || 3);
        $("timeout").value = Math.max(1, Math.round((Number(d.timeoutMs) || 1800000) / 60000));
        $("waitLogin").value = d.waitLoginSec == null ? 180 : d.waitLoginSec;
        $("clearBefore").checked = d.clearBefore === true;
        $("version").textContent = "v" + (data.version || "—");
        $("outDir").textContent = "输出：" + (data.outDir || "—");
      })
      .catch(function (err) {
        toast("读取配置失败（使用默认值）：" + err.message, true);
        $("max").value = 80000;
        $("lanes").value = "3";
        $("timeout").value = 30;
        $("waitLogin").value = 180;
      });
  }

  function bind() {
    $("start").addEventListener("click", startCollection);
    $("cancel").addEventListener("click", cancelCollection);
    $("refreshExports").addEventListener("click", refreshExports);
    $("url").addEventListener("keydown", function (event) {
      if (event.key === "Enter") startCollection();
    });
  }

  bind();
  loadConfig();
  refreshExports();
})();
