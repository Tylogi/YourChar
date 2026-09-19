export const usageCss = `
.usage-shell { display: grid; gap: 14px; min-width: 0; }
.usage-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
.usage-card { border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; display: grid; gap: 4px; background: var(--panel); }
.usage-card-label { font-size: 12px; color: var(--muted); }
.usage-card strong { font-size: 20px; font-variant-numeric: tabular-nums; }
.usage-card small { font-size: 12px; color: var(--muted); }
.usage-month-field { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--muted); }
.usage-budget, .usage-models, .usage-prices { border: 1px solid var(--line); border-radius: 12px; padding: 12px; display: grid; gap: 10px; min-width: 0; }
.usage-budget-head { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: space-between; }
.usage-budget-head h3, .usage-models h3, .usage-prices h3 { margin: 0; font-size: 15px; }
.usage-budget-settings { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; font-size: 13px; color: var(--muted); }
.usage-budget-settings input[type="number"] { width: 110px; }
.usage-budget-bar { height: 8px; border-radius: 999px; background: rgba(0, 0, 0, 0.08); overflow: hidden; }
.usage-budget-bar span { display: block; height: 100%; width: 0; background: var(--primary); transition: width .2s ease; }
.usage-budget-bar span.warn { background: #d97706; }
.usage-budget-bar span.over { background: #dc2626; }
.usage-budget-text { margin: 0; font-size: 13px; color: var(--muted); }
.usage-budget-text.warn { color: #b45309; font-weight: 600; }
.usage-budget-text.over { color: #dc2626; font-weight: 600; }
.usage-table { display: grid; gap: 4px; font-size: 13px; overflow-x: auto; }
.usage-table-row { display: grid; grid-template-columns: minmax(140px, 1.5fr) 56px repeat(4, minmax(72px, 1fr)) minmax(110px, 1.1fr) 80px; gap: 8px; border-top: 1px solid var(--line); padding: 6px 0; align-items: baseline; min-width: 660px; }
.usage-table-row.head { border-top: 0; color: var(--muted); font-size: 12px; }
.usage-table-row span { font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.usage-table-empty { font-size: 13px; color: var(--muted); }
.usage-price-form { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; font-size: 13px; color: var(--muted); }
.usage-price-form label { display: flex; align-items: center; gap: 6px; }
.usage-price-form input[type="number"] { width: 90px; }
.usage-price-model { font-size: 13px; color: var(--text); }
`;

export const usagePanelHtml = `
      <section id="usagePanel" class="management-panel" hidden>
        <div class="usage-shell">
          <div class="schedule-head">
            <div>
              <h3>用量与花费</h3>
              <div id="usageScopeSummary" class="schedule-scope-summary">本月真实模型调用的 token 与花费（输入 / 输出 / 缓存读 / 缓存写，不含思考 token；模型没返回用量就不记录）</div>
            </div>
            <div class="schedule-toolbar">
              <label class="usage-month-field">月份<input id="usageMonthInput" type="month" /></label>
              <button id="usageRefreshBtn" class="secondary" type="button"><i data-lucide="refresh-cw" aria-hidden="true"></i><span>刷新</span></button>
              <span id="usageState" class="muted"></span>
            </div>
          </div>
          <div class="usage-cards">
            <div class="usage-card"><span class="usage-card-label">本月花费</span><strong id="usageCost">¥0</strong><small id="usageCostHint"></small></div>
            <div class="usage-card"><span class="usage-card-label">调用次数</span><strong id="usageCalls">0</strong></div>
            <div class="usage-card"><span class="usage-card-label">输入 token</span><strong id="usageInput">0</strong></div>
            <div class="usage-card"><span class="usage-card-label">输出 token</span><strong id="usageOutput">0</strong></div>
            <div class="usage-card"><span class="usage-card-label">缓存读</span><strong id="usageCacheRead">0</strong></div>
            <div class="usage-card"><span class="usage-card-label">缓存写</span><strong id="usageCacheWrite">0</strong></div>
          </div>
          <section class="usage-budget" aria-label="月预算上限">
            <div class="usage-budget-head">
              <h3>月预算上限</h3>
              <div class="usage-budget-settings">
                <label>每月上限 <input id="usageBudgetInput" type="number" min="0" step="1" placeholder="不限制" /> 元</label>
                <button id="usageBudgetSaveBtn" class="secondary" type="button">保存预算</button>
                <span id="usageBudgetState" class="muted"></span>
              </div>
            </div>
            <div class="usage-budget-bar"><span id="usageBudgetFill"></span></div>
            <p id="usageBudgetText" class="usage-budget-text">未设置月预算上限</p>
          </section>
          <section class="usage-models" aria-label="按 provider / 模型统计">
            <div class="schedule-head"><h3>按 provider / 模型统计</h3><span id="usagePricingHint" class="muted"></span></div>
            <div id="usageModelTable" class="usage-table"></div>
          </section>
          <section class="usage-prices" aria-label="单价设置">
            <div class="schedule-head">
              <h3>单价设置</h3>
              <span class="muted">单位：元 / 百万 token。配好模型 API 后自动带出当前模型单价，可在此覆盖。</span>
            </div>
            <div class="usage-price-form">
              <span id="usagePriceModel" class="usage-price-model"></span>
              <label>输入<input id="usagePriceInput" type="number" min="0" step="0.01" /></label>
              <label>输出<input id="usagePriceOutput" type="number" min="0" step="0.01" /></label>
              <label>缓存读<input id="usagePriceCacheRead" type="number" min="0" step="0.01" /></label>
              <label>缓存写<input id="usagePriceCacheWrite" type="number" min="0" step="0.01" /></label>
              <button id="usagePriceSaveBtn" class="secondary" type="button">保存当前模型单价</button>
              <span id="usagePriceState" class="muted"></span>
            </div>
          </section>
        </div>
      </section>`;

export const usageScript = String.raw`
    function usageRequest(pathname, options) {
      return fetch(pathname, options).then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (body) {
          if (!response.ok) throw new Error(body.error || ("请求失败 " + response.status));
          return body;
        });
      });
    }

    function formatUsageTokens(value) {
      return Number(value || 0).toLocaleString("zh-CN");
    }

    function formatUsageMoney(value) {
      const amount = Number(value || 0);
      if (!amount) return "¥0";
      if (Math.abs(amount) < 0.01) return "¥" + amount.toFixed(4);
      return "¥" + amount.toFixed(2);
    }

    function formatUsagePrice(price) {
      if (!price) return "未收录";
      return [price.input, price.output, price.cacheRead, price.cacheWrite].join(" / ");
    }

    function usageRow(cells, header) {
      const row = document.createElement("div");
      row.className = header ? "usage-table-row head" : "usage-table-row";
      cells.forEach(function (value) {
        const cell = document.createElement("span");
        cell.textContent = value;
        row.appendChild(cell);
      });
      return row;
    }

    async function loadUsage() {
      if (!nodes.usageState) return;
      nodes.usageState.textContent = "加载中...";
      const month = nodes.usageMonthInput && nodes.usageMonthInput.value ? nodes.usageMonthInput.value : "";
      try {
        const summary = await usageRequest("/api/v1/usage" + (month ? "?month=" + encodeURIComponent(month) : ""));
        state.usageSummary = summary;
        renderUsage(summary);
        nodes.usageState.textContent = "";
      } catch (error) {
        nodes.usageState.textContent = error.message || String(error);
      }
    }

    function renderUsage(summary) {
      if (nodes.usageMonthInput && summary.month) nodes.usageMonthInput.value = summary.month;
      nodes.usageCost.textContent = formatUsageMoney(summary.costYuan);
      nodes.usageCostHint.textContent = summary.unpricedCalls
        ? summary.unpricedCalls + " 次调用缺少单价，未计入花费"
        : (summary.calls ? "按当前单价估算" : "本月还没有模型调用");
      nodes.usageCalls.textContent = formatUsageTokens(summary.calls);
      nodes.usageInput.textContent = formatUsageTokens(summary.bucket.input);
      nodes.usageOutput.textContent = formatUsageTokens(summary.bucket.output);
      nodes.usageCacheRead.textContent = formatUsageTokens(summary.bucket.cacheRead);
      nodes.usageCacheWrite.textContent = formatUsageTokens(summary.bucket.cacheWrite);
      renderUsageBudget(summary.budget);
      renderUsageModels(summary.models);
      renderUsagePriceForm(summary);
    }

    function renderUsageBudget(budget) {
      const fill = nodes.usageBudgetFill;
      const limit = budget.limitYuan;
      if (document.activeElement !== nodes.usageBudgetInput) {
        nodes.usageBudgetInput.value = limit === null ? "" : String(limit);
      }
      if (limit === null) {
        fill.style.width = "0";
        fill.className = "";
        nodes.usageBudgetText.textContent = "未设置月预算上限";
        nodes.usageBudgetText.className = "usage-budget-text";
        return;
      }
      const ratio = budget.ratio === null ? 0 : budget.ratio;
      fill.style.width = Math.min(100, Math.max(0, ratio * 100)) + "%";
      fill.className = budget.exceeded ? "over" : (ratio >= 0.8 ? "warn" : "");
      if (budget.exceeded) {
        nodes.usageBudgetText.textContent = "已超出月预算上限：" + formatUsageMoney(budget.usedYuan) +
          " / " + formatUsageMoney(limit) + "，超出 " + formatUsageMoney(Math.abs(budget.remainingYuan || 0));
        nodes.usageBudgetText.className = "usage-budget-text over";
        return;
      }
      nodes.usageBudgetText.textContent = "已用 " + formatUsageMoney(budget.usedYuan) + " / " +
        formatUsageMoney(limit) + "（" + Math.round(ratio * 100) + "%），剩余 " +
        formatUsageMoney(budget.remainingYuan || 0);
      nodes.usageBudgetText.className = ratio >= 0.8 ? "usage-budget-text warn" : "usage-budget-text";
    }

    function renderUsageModels(models) {
      const table = nodes.usageModelTable;
      table.innerHTML = "";
      if (!models.length) {
        const empty = document.createElement("div");
        empty.className = "usage-table-empty";
        empty.textContent = "本月还没有模型调用。真实调用一次模型后，这里会出现用量。";
        table.appendChild(empty);
        return;
      }
      table.appendChild(usageRow(["provider / 模型", "调用", "输入", "输出", "缓存读", "缓存写", "单价(元/百万)", "花费"], true));
      models.forEach(function (row) {
        table.appendChild(usageRow([
          (row.provider ? row.provider + " / " : "") + row.model,
          formatUsageTokens(row.calls),
          formatUsageTokens(row.input),
          formatUsageTokens(row.output),
          formatUsageTokens(row.cacheRead),
          formatUsageTokens(row.cacheWrite),
          formatUsagePrice(row.price),
          formatUsageMoney(row.costYuan)
        ], false));
      });
    }

    function renderUsagePriceForm(summary) {
      const model = summary.current.model || "";
      nodes.usagePriceModel.textContent = model ? ("当前模型：" + model) : "还没有配置模型";
      if (nodes.usagePriceModel.dataset.model !== model) {
        nodes.usagePriceModel.dataset.model = model;
        const price = summary.current.price;
        nodes.usagePriceInput.value = price ? String(price.input) : "";
        nodes.usagePriceOutput.value = price ? String(price.output) : "";
        nodes.usagePriceCacheRead.value = price ? String(price.cacheRead) : "";
        nodes.usagePriceCacheWrite.value = price ? String(price.cacheWrite) : "";
      }
      nodes.usagePricingHint.textContent = summary.unpricedCalls
        ? summary.unpricedCalls + " 次调用没有单价，未计入花费"
        : "";
    }

    async function saveUsageBudget() {
      const raw = nodes.usageBudgetInput.value.trim();
      nodes.usageBudgetState.textContent = "保存中...";
      try {
        await usageRequest("/api/v1/usage/settings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ monthlyBudgetYuan: raw === "" ? null : Number(raw) })
        });
        nodes.usageBudgetState.textContent = "已保存";
        await loadUsage();
      } catch (error) {
        nodes.usageBudgetState.textContent = error.message || String(error);
      }
    }

    async function saveUsagePrice() {
      const model = nodes.usagePriceModel.dataset.model || "";
      if (!model) {
        nodes.usagePriceState.textContent = "还没有配置模型";
        return;
      }
      const read = function (input) { return Number(input.value === "" ? 0 : input.value); };
      const overrides = Object.assign(
        {},
        state.usageSummary && state.usageSummary.settings ? state.usageSummary.settings.priceOverrides : {}
      );
      overrides[model.toLowerCase()] = {
        input: read(nodes.usagePriceInput),
        output: read(nodes.usagePriceOutput),
        cacheRead: read(nodes.usagePriceCacheRead),
        cacheWrite: read(nodes.usagePriceCacheWrite)
      };
      nodes.usagePriceState.textContent = "保存中...";
      try {
        await usageRequest("/api/v1/usage/settings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ priceOverrides: overrides })
        });
        nodes.usagePriceState.textContent = "已保存";
        await loadUsage();
      } catch (error) {
        nodes.usagePriceState.textContent = error.message || String(error);
      }
    }

    nodes.usageRefreshBtn.addEventListener("click", function () { void loadUsage(); });
    nodes.usageMonthInput.addEventListener("change", function () { void loadUsage(); });
    nodes.usageBudgetSaveBtn.addEventListener("click", function () { void saveUsageBudget(); });
    nodes.usagePriceSaveBtn.addEventListener("click", function () { void saveUsagePrice(); });
`;
