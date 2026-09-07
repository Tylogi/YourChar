/** Conversation-scoped paging/search state. Never persisted, including private/incognito searches. */
export const historyScript = String.raw`
    let messageHistory = null;
    let historySearchSerial = 0;
    let historySearchController = null;
    let historyPageController = null;
    let historyImageObserver = null;
    let historyScrollTimer = null;
    let historyScrollArmed = false;
    let historySearchNext = null;
    let historySearchTerm = "";
    const HISTORY_PAGE_SIZE = 40;
    const HISTORY_WINDOW_SIZE = 160;

    function historyScopeKey() {
      return [state.conversationSpaceEpoch, state.conversationViewEpoch, state.conversationSpace,
        state.activeConversationKind, state.activeWorldId || state.activeGroupId || state.activeSessionId, state.selectedCharacterId].join(":");
    }
    function resetMessageHistory() {
      historyPageController?.abort();
      historyImageObserver?.disconnect();
      clearTimeout(historyScrollTimer);
      historyScrollArmed = false;
      closeHistorySearch();
      document.getElementById("historySearchInput").value = "";
      document.getElementById("historySearchResults").replaceChildren();
      document.getElementById("historySearchStatus").textContent = "搜索当前会话的全部文字记录";
      document.getElementById("historySearchMoreBtn").hidden = true;
      historySearchTerm = "";
      historySearchNext = null;
      messageHistory = { key: historyScopeKey(), raw: [], initialized: false, loading: false, focus: "", revision: 0,
        page: { first: null, last: null, hasEarlier: false, hasLater: false } };
      updateHistoryChrome();
    }
    function ensureMessageHistory() {
      if (!messageHistory || messageHistory.key !== historyScopeKey()) resetMessageHistory();
      return messageHistory;
    }
    function historyMessageId(message) {
      return String(message.entryId || message.worldMessageId || message.groupMessageId || message.id ||
        message.localId || message.interactionEventId || message.episodeId || "");
    }
    function historyRawId(message) { return String(message.entryId || message.id || ""); }
    function historyMessageAttribute(message) {
      const id = historyMessageId(message);
      return id ? ' data-history-id="' + escapeHtml(id) + '"' : '';
    }
    function historyMessageHtml(message, index) {
      return renderStandardMessage(message, index).replace(/^<div\b/, '<div' + historyMessageAttribute(message));
    }
    function historyBaseUrl() {
      if (state.activeConversationKind === "world" && state.activeWorldId) return "/api/v1/worlds/" + encodeURIComponent(state.activeWorldId) + "/conversation/messages";
      if (state.activeConversationKind === "group" && state.activeGroupId) return "/api/v1/group-chats/" + encodeURIComponent(state.activeGroupId) + "/messages";
      if (!state.activeSessionId || state.sessionDraft) return "";
      return "/api/v1/sessions/" + encodeURIComponent(state.activeSessionId) + "/messages";
    }
    function historyUrl(parameters = {}, search = false) {
      const base = historyBaseUrl();
      if (!base) return "";
      const url = new URL(base + (search ? "/search" : ""), location.origin);
      if (!search) url.searchParams.set("paged", "1");
      url.searchParams.set("limit", String(search ? 20 : HISTORY_PAGE_SIZE));
      for (const [key, value] of Object.entries(parameters)) if (value) url.searchParams.set(key, String(value));
      return state.activeConversationKind === "direct"
        ? withConversationSpace(url.pathname + url.search, state.conversationSpace, state.selectedCharacterId)
        : url.pathname + url.search;
    }
    function acceptHistoryPage(body, mode = "refresh") {
      const history = ensureMessageHistory();
      const incoming = Array.isArray(body) ? body : Array.isArray(body.messages) ? body.messages : [];
      const page = body.page || { first: historyRawId(incoming[0] || {}) || null, last: historyRawId(incoming.at(-1) || {}) || null, hasEarlier: false, hasLater: false };
      const wasLegacy = history.legacy;
      history.legacy = Array.isArray(body);
      if (!history.initialized || wasLegacy || history.legacy || mode === "around" || mode === "latest" || (mode === "refresh" && !incoming.length)) {
        history.raw = incoming; history.page = { ...page }; history.initialized = true;
      } else {
        const replacements = new Map(incoming.map(message => [historyRawId(message), message]));
        const existing = new Set(history.raw.map(historyRawId));
        history.raw = history.raw.map(message => replacements.get(historyRawId(message)) || message);
        if (mode === "before") {
          history.raw = [...incoming.filter(message => !existing.has(historyRawId(message))), ...history.raw];
          history.page.hasEarlier = page.hasEarlier;
        } else if (mode === "after") {
          history.raw.push(...incoming.filter(message => !existing.has(historyRawId(message))));
          history.page.hasLater = page.hasLater;
        } else if (!history.page.hasLater) {
          // A missed burst may exceed one page. Never fabricate a gap in the loaded timeline.
          if (history.raw.length && incoming.length && !incoming.some(message => existing.has(historyRawId(message)))) {
            history.page.hasLater = true;
          } else {
            history.raw.push(...incoming.filter(message => !existing.has(historyRawId(message))));
            // Retractions/edits invalidate an old tail, but not previously loaded older pages.
            const overlap = history.raw.findIndex(message => historyRawId(message) === page.first);
            if (overlap >= 0 && incoming.length) history.raw = [...history.raw.slice(0, overlap), ...incoming];
          }
        }
      }
      if (history.raw.length > HISTORY_WINDOW_SIZE) {
        if (mode === "before") { history.raw = history.raw.slice(0, HISTORY_WINDOW_SIZE); history.page.hasLater = true; }
        else { history.raw = history.raw.slice(-HISTORY_WINDOW_SIZE); history.page.hasEarlier = true; }
      }
      history.page.first = historyRawId(history.raw[0] || {}) || null;
      history.page.last = historyRawId(history.raw.at(-1) || {}) || null;
      updateHistoryChrome();
      return history.raw;
    }
    function normalizeHistoryMessages(raw) {
      if (state.activeConversationKind === "world") return raw.map(normalizeWorldMessage).filter(Boolean);
      if (state.activeConversationKind === "group") return raw.map(normalizeGroupMessage).filter(Boolean);
      const stored = mergeToolResultsIntoMessages(dedupeSystemEvents(raw.map(normalizeStoredMessage).filter(Boolean)));
      if (incognitoConversationIsActive()) for (const message of stored) message.attachments = [];
      return stored;
    }
    function historyScopedEvents(events) {
      const history = ensureMessageHistory();
      if (!history.raw.length) return events;
      const timestamp = message => new Date(message.timestamp || message.createdAt || 0).getTime();
      const from = history.page.hasEarlier ? timestamp(history.raw[0]) : -Infinity;
      const to = history.page.hasLater ? timestamp(history.raw.at(-1)) : Infinity;
      const ids = new Set(history.raw.map(historyRawId));
      return events.filter(event => {
        if (ids.has(historyMessageId(event))) return true;
        const at = new Date(event.appliedAt || event.createdAt || event.timestampMs || 0).getTime(); return at >= from && at <= to;
      });
    }
    function historyControls(position) {
      const history = ensureMessageHistory();
      const earlier = position === "before";
      if (!(earlier ? history.page.hasEarlier : history.page.hasLater)) return "";
      return '<div class="history-load-row" data-history-block="' + position + '"><button type="button" class="secondary" data-history-load="' + position + '"' + (history.loading ? ' disabled' : '') + '>' +
        (history.loading ? '正在加载…' : earlier ? '加载更早记录' : '加载后续记录') + '</button></div>';
    }
    function updateHistoryChrome() {
      const button = document.getElementById("historySearchBtn");
      button.disabled = !historyBaseUrl() || state.uiMode !== "normal" || state.conversationViewLoading;
      document.getElementById("historyPositionBar").hidden = !messageHistory?.page.hasLater;
    }
    function captureHistoryAnchor() {
      const top = nodes.messages.getBoundingClientRect().top;
      const entry = [...nodes.messages.querySelectorAll("[data-history-id]")].find(el => el.getBoundingClientRect().bottom > top + 8);
      return entry ? { id: entry.dataset.historyId, offset: entry.getBoundingClientRect().top - top } : null;
    }
    function restoreHistoryAnchor(anchor) {
      if (!anchor) return false;
      const entry = nodes.messages.querySelector('[data-history-id="' + CSS.escape(anchor.id) + '"]');
      if (!entry) return false;
      nodes.messages.scrollTop += entry.getBoundingClientRect().top - nodes.messages.getBoundingClientRect().top - anchor.offset;
      return true;
    }
    function patchHistoryMessages(html) {
      const template = document.createElement("template"); template.innerHTML = html;
      const key = (el, index) => el.dataset.historyId || el.dataset.historyBlock || "row:" + index;
      const old = new Map([...nodes.messages.children].map((el, index) => [key(el, index), el]));
      const children = [...template.content.children].map((el, index) => {
        const previous = old.get(key(el, index)); const signature = el.outerHTML;
        if (previous?._historyMarkup === signature) return previous;
        el._historyMarkup = signature; return el;
      });
      // Keep unchanged nodes in place: image requests, disclosure state and focus survive a new token.
      children.forEach((el, index) => { if (nodes.messages.children[index] !== el) nodes.messages.insertBefore(el, nodes.messages.children[index] || null); });
      while (nodes.messages.children.length > children.length) nodes.messages.lastElementChild.remove();
    }
    function observeHistoryImages() {
      historyImageObserver?.disconnect();
      const images = nodes.messages.querySelectorAll("img[data-history-src]:not([src])");
      const load = image => { if (nodes.messages.contains(image)) { image.decoding = "async"; image.src = image.dataset.historySrc; } };
      if (!("IntersectionObserver" in window)) { images.forEach(load); return; }
      historyImageObserver = new IntersectionObserver(entries => {
        for (const entry of entries) if (entry.isIntersecting) { load(entry.target); historyImageObserver.unobserve(entry.target); }
      }, { root: nodes.messages, rootMargin: "240px 0px" });
      images.forEach(image => historyImageObserver.observe(image));
    }
    async function loadHistoryPage(mode, target) {
      const history = ensureMessageHistory();
      if (history.loading || !historyBaseUrl()) return false;
      const cursor = mode === "before" ? history.page.first : mode === "after" ? history.page.last : target;
      const anchor = captureHistoryAnchor();
      const key = history.key; const revision = ++history.revision;
      history.loading = true;
      historyScrollArmed = false;
      clearTimeout(historyScrollTimer);
      historyPageController?.abort(); historyPageController = new AbortController();
      renderMessages({ preserveScroll: true, forceAnchor: true });
      try {
        const response = await fetch(historyUrl(mode === "latest" ? {} : { [mode]: cursor }), { signal: historyPageController.signal });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "加载历史记录失败");
        if (historyScopeKey() !== key || messageHistory !== history || revision !== history.revision) return false;
        acceptHistoryPage(body, mode);
        history.loading = false; history.focus = mode === "around" ? target : "";
        state.messages = normalizeHistoryMessages(history.raw);
        if (state.activeConversationKind === "direct") state.messages = annotateProactiveMessages(mergeCharacterCollaborations(
          mergeInteractionEvents(mergePrivateInboxMessages(state.messages, historyScopedEvents(state.privateInboxMessages || [])), historyScopedEvents(state.interactionEvents || [])),
          historyScopedEvents(visibleCharacterCollaborations())
        ), state.activeProactiveMessages || []);
        renderMessages({ preserveScroll: mode !== "latest", forceAnchor: mode !== "latest", anchor });
        if (mode === "around") {
          const found = nodes.messages.querySelector('[data-history-id="' + CSS.escape(target) + '"]');
          if (found) { found.scrollIntoView({ block: "center" }); found.classList.add("history-focus"); found.tabIndex = -1; found.focus({ preventScroll: true }); observeHistoryImages(); }
          else setStatus("消息已载入，但该记录没有可显示的正文", true);
        }
        return true;
      } catch (error) {
        if (error.name !== "AbortError" && historyScopeKey() === key) setStatus(error.message || "加载历史记录失败，可重试", true);
        return false;
      } finally {
        if (messageHistory === history) { history.loading = false; updateHistoryChrome();
          nodes.messages.querySelectorAll("[data-history-load]").forEach(button => { button.disabled = false; button.textContent = button.dataset.historyLoad === "before" ? "加载更早记录" : "加载后续记录"; }); }
      }
    }
    function closeHistorySearch() {
      ++historySearchSerial; historySearchController?.abort();
      const dialog = document.getElementById("historySearchDialog");
      if (dialog.open) dialog.close();
    }
    function openHistorySearch() {
      ensureMessageHistory();
      if (!historyBaseUrl()) return;
      const dialog = document.getElementById("historySearchDialog");
      document.getElementById("historySearchTitle").textContent = "搜索聊天记录 · " + (document.getElementById("conversationCharacter").textContent || "当前会话");
      if (!dialog.open) dialog.showModal();
      document.getElementById("historySearchInput").focus();
    }
    function highlightHistorySnippet(text) {
      const at = text.toLowerCase().indexOf(historySearchTerm.toLowerCase());
      if (at < 0) return escapeHtml(text);
      return escapeHtml(text.slice(0, at)) + '<mark>' + escapeHtml(text.slice(at, at + historySearchTerm.length)) + '</mark>' + escapeHtml(text.slice(at + historySearchTerm.length));
    }
    async function searchMessageHistory(more = false) {
      const query = document.getElementById("historySearchInput").value.trim();
      if (!query) return;
      const key = historyScopeKey(); const serial = ++historySearchSerial;
      historySearchController?.abort(); historySearchController = new AbortController();
      const status = document.getElementById("historySearchStatus"); status.textContent = "正在搜索…";
      if (!more || query !== historySearchTerm) { more = false; historySearchNext = null; document.getElementById("historySearchResults").replaceChildren(); }
      historySearchTerm = query;
      document.getElementById("historySearchMoreBtn").disabled = true;
      try {
        const response = await fetch(historyUrl({ q: query, before: more ? historySearchNext : null }, true), { signal: historySearchController.signal });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "搜索失败");
        if (serial !== historySearchSerial || key !== historyScopeKey()) return;
        const results = body.results || [];
        historySearchNext = body.next || null;
        document.getElementById("historySearchResults").insertAdjacentHTML("beforeend", results.map(result => {
          const name = ["user"].includes(result.role) ? "你" : result.role === "director" ? "旁白" : state.characters.find(character => character.id === result.senderId)?.name || (result.role === "assistant" ? document.getElementById("conversationCharacter").textContent : "会话记录");
          return '<button class="history-search-result" type="button" data-history-result="' + escapeHtml(result.id) + '"><span>' + escapeHtml(name + ' · ' + new Date(result.timestamp).toLocaleString("zh-CN")) + '</span><p>' + highlightHistorySnippet(String(result.snippet || "")) + '</p></button>';
        }).join(""));
        const count = document.getElementById("historySearchResults").children.length;
        status.textContent = count ? "已显示 " + count + " 条结果，点击定位原消息" : "没有找到匹配的聊天记录";
        document.getElementById("historySearchMoreBtn").hidden = !historySearchNext;
      } catch (error) {
        if (serial === historySearchSerial && error.name !== "AbortError") status.textContent = error.message || "搜索失败，请重试";
      } finally { if (serial === historySearchSerial) document.getElementById("historySearchMoreBtn").disabled = false; }
    }
    document.getElementById("historySearchBtn").addEventListener("click", openHistorySearch);
    document.getElementById("closeHistorySearchBtn").addEventListener("click", closeHistorySearch);
    document.getElementById("historySearchDialog").addEventListener("cancel", closeHistorySearch);
    document.getElementById("historySearchForm").addEventListener("submit", event => { event.preventDefault(); void searchMessageHistory(); });
    document.getElementById("historySearchMoreBtn").addEventListener("click", () => void searchMessageHistory(true));
    document.getElementById("historyLatestBtn").addEventListener("click", () => void loadHistoryPage("latest"));
    document.getElementById("historySearchResults").addEventListener("click", event => {
      const button = event.target.closest("[data-history-result]"); if (!button) return;
      closeHistorySearch(); void loadHistoryPage("around", button.dataset.historyResult);
    });
    nodes.messages.addEventListener("click", event => {
      const button = event.target.closest("[data-history-load]"); if (button) void loadHistoryPage(button.dataset.historyLoad);
    });
    nodes.messages.addEventListener("wheel", event => {
      if (event.deltaY < 0) historyScrollArmed = true;
      if (event.deltaY < 0 && nodes.messages.scrollTop < 100 && messageHistory?.page.hasEarlier && !messageHistory.loading) {
        clearTimeout(historyScrollTimer); historyScrollTimer = setTimeout(() => void loadHistoryPage("before"), 120);
      }
    }, { passive: true });
    nodes.messages.addEventListener("pointerdown", () => { historyScrollArmed = true; }, { passive: true });
    nodes.messages.addEventListener("scroll", () => {
      if (!historyScrollArmed || nodes.messages.scrollTop >= 72 || !messageHistory?.page.hasEarlier || messageHistory.loading) return;
      clearTimeout(historyScrollTimer);
      historyScrollTimer = setTimeout(() => { historyScrollArmed = false; void loadHistoryPage("before"); }, 120);
    }, { passive: true });
    let historyTouchY = null;
    nodes.messages.addEventListener("touchstart", event => { historyTouchY = event.touches[0]?.clientY; historyScrollArmed = true; }, { passive: true });
    nodes.messages.addEventListener("touchend", event => {
      if (historyTouchY !== null && event.changedTouches[0]?.clientY > historyTouchY + 30 && nodes.messages.scrollTop < 100 && messageHistory?.page.hasEarlier) void loadHistoryPage("before");
      historyTouchY = null;
    }, { passive: true });
    document.addEventListener("keydown", event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f" && state.uiMode === "normal" && !document.querySelector("dialog[open]") && historyBaseUrl()) { event.preventDefault(); openHistorySearch(); }
    });
`;
