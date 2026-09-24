// ==UserScript==
// @name         ChatGPT Sidebar Organizer（简体中文）
// @namespace    local.lex.chatgpt-organizer
// @version      2.2.0
// @description  使用本地分区、状态标签、搜索、筛选和自定义排序整理 ChatGPT 会话。
// @author       Lex + Codex
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const APP_ID = 'cso-root';
  const STORAGE_KEY = 'chatgpt-sidebar-organizer.v1';
  const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
  const MAX_SECTIONS = 500;
  const MAX_CHATS = 20_000;
  if (document.getElementById(APP_ID)) return;
  const STATUS = {
    none: { label: '未设置', color: '#8b8b8b' },
    active: { label: 'Active', color: '#3b82f6' },
    reference: { label: 'Reference', color: '#8b5cf6' },
    backlog: { label: 'Backlog', color: '#6b7280' },
  };
  const SECTION_COLORS = [
    '#10A37F', '#3B82F6', '#6366F1', '#8B5CF6',
    '#EC4899', '#F43F5E', '#F97316', '#F59E0B',
    '#84CC16', '#10B981', '#06B6D4', '#64748B',
  ];
  const LEGACY_PRESET_IDS = new Set(['research', 'papers', 'coding', 'career', 'languages', 'life', 'travel']);

  const defaultState = () => ({
    version: 3,
    sections: [],
    chats: {},
    ui: {
      open: true,
      quick: 'all',
      query: '',
      section: 'all',
      status: 'all',
      type: 'all',
      sort: 'custom',
      windowX: null,
      windowY: 82,
      pendingNewChat: null,
      pendingOpenChat: null,
    },
  });

  let state = loadState();
  let lastUrl = location.href;
  let renderQueued = false;
  let scanTimer = null;
  let searchRenderTimer = null;
  let titleRefreshTimer = null;
  let fullScanRunning = false;
  let pendingOpenTimer = null;
  let nativeActionKey = null;
  let nativeActionStartedAt = 0;
  let pendingNativeDelete = null;
  let draggedChatKey = null;
  let draggedSectionId = null;
  let panelDrag = null;
  let storageWarningShown = false;

  function loadState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (!parsed || typeof parsed !== 'object') return defaultState();
      return normalizeState(parsed);
    } catch (_) {
      return defaultState();
    }
  }

  function normalizeState(parsed) {
      const base = defaultState();
      const rawChats = parsed.chats && typeof parsed.chats === 'object' && !Array.isArray(parsed.chats)
        ? parsed.chats
        : {};
      const rawUi = parsed.ui && typeof parsed.ui === 'object' && !Array.isArray(parsed.ui)
        ? parsed.ui
        : {};
      const merged = {
        ...base,
        ...parsed,
        version: 3,
        sections: Array.isArray(parsed.sections) ? parsed.sections : [],
        chats: rawChats,
        ui: { ...base.ui, ...rawUi },
      };

      // Keep legacy preset sections only when the user has already assigned
      // chats to them. Empty presets disappear; new installations start empty.
      const assignedSections = new Set(Object.values(rawChats).map(chat => chat?.sectionId).filter(Boolean));
      if ((parsed.version || 1) < 2) {
        merged.sections = merged.sections.filter(section =>
          !LEGACY_PRESET_IDS.has(section?.id) || assignedSections.has(section.id)
        );
      }
      const seenSectionIds = new Set();
      merged.sections = merged.sections
        .filter(section => section && section.id && section.name)
        .slice(0, MAX_SECTIONS)
        .map(section => ({
          id: String(section.id).slice(0, 100),
          name: String(section.name).trim().slice(0, 40),
          color: /^#[0-9a-f]{6}$/i.test(section.color) ? section.color : '#10a37f',
          collapsed: Boolean(section.collapsed),
        }))
        .filter(section => section.id && section.name && !seenSectionIds.has(section.id) && seenSectionIds.add(section.id))
        .map((section, order) => ({ ...section, order }));

      delete merged.ui.star;
      if (merged.ui.quick === 'starred') merged.ui.quick = 'all';
      if (!['all', 'unsectioned'].includes(merged.ui.quick)) merged.ui.quick = 'all';
      const sectionIds = new Set(merged.sections.map(section => section.id));
      const normalizedChats = {};
      Object.values(rawChats).slice(0, MAX_CHATS).forEach(rawChat => {
        if (!rawChat || typeof rawChat !== 'object' || Array.isArray(rawChat) || !rawChat.url) return;
        const url = canonicalUrl(rawChat.url);
        const key = chatKey(url);
        if (!key || isNonConversationTitle(rawChat.title)) return;
        const cleanedTitle = cleanNativeAnchorTitle(rawChat.title);
        const status = rawChat.status === 'hidden' ? 'backlog' : rawChat.status;
        const inProject = typeof rawChat.inProject === 'boolean' ? rawChat.inProject : isProjectUrl(url);
        let type = ['chat', 'work', 'gpt', 'project'].includes(rawChat.type) ? rawChat.type : inferType(url);
        if (inProject) type = 'project';
        else if (type === 'project') type = inferType(url);
        const chat = {
          key,
          title: cleanedTitle && !isPlaceholderTitle(cleanedTitle) ? cleanedTitle.slice(0, 240) : '正在获取标题…',
          url,
          sectionId: rawChat.sectionId && sectionIds.has(String(rawChat.sectionId)) ? String(rawChat.sectionId) : '',
          status: STATUS[status] ? status : 'none',
          type,
          inProject,
          createdAt: Number.isFinite(rawChat.createdAt) && rawChat.createdAt > 0 ? rawChat.createdAt : Date.now(),
          lastSeen: Number.isFinite(rawChat.lastSeen) && rawChat.lastSeen > 0 ? rawChat.lastSeen : Date.now(),
          manualOrder: Number.isFinite(rawChat.manualOrder) ? rawChat.manualOrder : null,
        };
        const previous = normalizedChats[key];
        if (!previous || chat.lastSeen >= previous.lastSeen) normalizedChats[key] = chat;
      });
      merged.chats = normalizedChats;
      const chatsBySection = new Map();
      Object.values(merged.chats).forEach(chat => {
        const sectionId = chat.sectionId || '';
        if (!chatsBySection.has(sectionId)) chatsBySection.set(sectionId, []);
        chatsBySection.get(sectionId).push(chat);
      });
      chatsBySection.forEach(chats => {
        chats.sort((a, b) => {
          const aHasOrder = Number.isFinite(a.manualOrder);
          const bHasOrder = Number.isFinite(b.manualOrder);
          if (aHasOrder && bHasOrder) return a.manualOrder - b.manualOrder;
          if (aHasOrder) return -1;
          if (bHasOrder) return 1;
          return (b.lastSeen || 0) - (a.lastSeen || 0);
        });
        chats.forEach((chat, index) => { chat.manualOrder = index * 10; });
      });
      if (!['all', 'unsectioned', ...sectionIds].includes(merged.ui.section)) merged.ui.section = 'all';
      if (merged.ui.status !== 'all' && !STATUS[merged.ui.status]) merged.ui.status = 'all';
      if (!['all', 'chat', 'work', 'gpt'].includes(merged.ui.type)) merged.ui.type = 'all';
      if (merged.ui.sort === 'created-desc') merged.ui.sort = 'custom';
      if (!['custom', 'recent', 'oldest', 'title'].includes(merged.ui.sort)) merged.ui.sort = 'custom';
      if (!Number.isFinite(merged.ui.windowX)) merged.ui.windowX = null;
      if (!Number.isFinite(merged.ui.windowY)) merged.ui.windowY = 82;
      const pending = merged.ui.pendingNewChat;
      if (!pending || !sectionIds.has(pending.sectionId) ||
          !Number.isFinite(pending.startedAt) || Date.now() - pending.startedAt > 30 * 60 * 1000) {
        merged.ui.pendingNewChat = null;
      }
      const pendingOpen = merged.ui.pendingOpenChat;
      if (!pendingOpen || !merged.chats[pendingOpen.key] ||
          !Number.isFinite(pendingOpen.startedAt) || Date.now() - pendingOpen.startedAt > 2 * 60 * 1000) {
        merged.ui.pendingOpenChat = null;
      }
      merged.ui.query = typeof merged.ui.query === 'string' ? merged.ui.query.slice(0, 500) : '';
      merged.ui.open = Boolean(merged.ui.open);
      return merged;
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch (error) {
      console.warn('[ChatGPT Sidebar Organizer] 无法保存本地数据。', error);
      if (!storageWarningShown) {
        storageWarningShown = true;
        setTimeout(() => toast('无法保存 Organizer 数据。浏览器存储空间可能已满或不可用。'), 0);
      }
      return false;
    }
  }

  function removeChatFromOrganizer(key, message = '') {
    if (!key || !state.chats[key]) return false;
    delete state.chats[key];
    if (state.ui.pendingOpenChat?.key === key) state.ui.pendingOpenChat = null;
    saveState();
    queueRender();
    if (message) toast(message);
    return true;
  }

  function esc(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function slug() {
    return `section-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  }

  function nextSectionName() {
    const existing = new Set(state.sections.map(section => section.name.trim().toLocaleLowerCase()));
    if (!existing.has('新分区')) return '新分区';
    let number = 2;
    while (existing.has(`新分区 ${number}`.toLocaleLowerCase())) number += 1;
    return `新分区 ${number}`;
  }

  function nextManualOrder(sectionId = '', atStart = false, excludingKey = '') {
    let edge = atStart ? Infinity : -Infinity;
    for (const chat of Object.values(state.chats)) {
      if (chat.key === excludingKey || (chat.sectionId || '') !== sectionId || !Number.isFinite(chat.manualOrder)) continue;
      edge = atStart ? Math.min(edge, chat.manualOrder) : Math.max(edge, chat.manualOrder);
    }
    if (!Number.isFinite(edge)) return 0;
    return atStart ? edge - 10 : edge + 10;
  }

  function createSection(name, color = '#10a37f') {
    const cleanName = String(name || '').trim();
    if (!cleanName) return { section: null, error: '请输入分区名称' };
    const duplicate = state.sections.find(section =>
      section.name.trim().toLocaleLowerCase() === cleanName.toLocaleLowerCase()
    );
    if (duplicate) return { section: duplicate, error: '已经存在同名分区' };
    const maxOrder = Math.max(-1, ...state.sections.map(section => section.order));
    const section = {
      id: slug(),
      name: cleanName,
      color: /^#[0-9a-f]{6}$/i.test(color) ? color : '#10a37f',
      order: maxOrder + 1,
      collapsed: false,
    };
    state.sections.push(section);
    saveState();
    return { section, error: '' };
  }

  function colorPaletteHtml() {
    return `<div class="cso-color-palette" aria-label="预设分区颜色">
      ${SECTION_COLORS.map(color => `<button type="button" data-preset-color="${color}" style="--swatch:${color}" title="${color}" aria-label="选择颜色 ${color}"></button>`).join('')}
    </div>`;
  }

  function canonicalUrl(raw = location.href) {
    try {
      const url = new URL(raw, location.origin);
      return `${url.origin}${url.pathname.replace(/\/$/, '') || '/'}`;
    } catch (_) {
      return raw;
    }
  }

  function isPlausibleConversationId(value) {
    return typeof value === 'string' && value.length >= 16 && /^[a-z0-9_-]+$/i.test(value);
  }

  function isNonConversationTitle(value) {
    return /^(?:开启|打开|啟用|開啟).*(?:桌面应用|桌面應用|桌面程式)|^open\s+(?:the\s+)?desktop\s+app/i.test(String(value || '').trim());
  }

  function isProjectUrl(raw = location.href) {
    try {
      const url = new URL(raw, location.origin);
      const path = url.pathname;
      return /\/g\/g-p-[^/]+\/(?:c\/|project(?:\/|$))/i.test(path) ||
        /\/projects?\/[^/]+\/(?:c|conversation)\//i.test(path) ||
        url.searchParams.has('project_id') || url.searchParams.has('projectId');
    } catch (_) {
      return false;
    }
  }

  function chatKey(raw = location.href) {
    const url = canonicalUrl(raw);
    try {
      const path = new URL(url).pathname;
      const match = path.match(/\/(?:c|conversation)\/([^/?#]+)/);
      if (match && isPlausibleConversationId(match[1])) return `chat:${match[1]}`;
      const codex = path.match(/\/(?:codex|tasks?)\/([^/?#]+)/);
      if (codex && isPlausibleConversationId(codex[1])) return `work:${codex[1]}`;
      return null;
    } catch (_) {
      return null;
    }
  }

  function inferType(raw = location.href) {
    const path = new URL(raw, location.origin).pathname;
    if (isProjectUrl(raw)) return 'project';
    if (/\/(?:codex|tasks?)(?:\/|$)/.test(path)) return 'work';
    if (/\/g\//.test(path)) return 'gpt';
    return 'chat';
  }

  function cleanTitle(value) {
    return String(value || '')
      .replace(/\s*[|–—-]\s*ChatGPT\s*$/i, '')
      .replace(/^ChatGPT\s*[|–—-]\s*/i, '')
      .trim();
  }

  function isPlaceholderTitle(value) {
    return /^(?:ChatGPT|Untitled(?: chat)?|New chat|Fetching title…?|新聊天|新对话|新對話|正在获取标题…?)$/i.test(cleanTitle(value));
  }

  function cleanNativeAnchorTitle(value) {
    return cleanTitle(value)
      .replace(/\s*(?:Options|More|更多|选项|選項|•••|⋯)\s*$/i, '')
      .replace(/\s*[,，·|]\s*(?:工作|Work)\s*$/i, '')
      .replace(/\s*(?:Options|More|更多|选项|選項|•••|⋯)\s*$/i, '')
      .trim();
  }

  function pageShowsMissingConversation() {
    const pattern = /unable to load (?:this )?(?:chat|conversation)|(?:chat|conversation) (?:was )?not found|无法加载(?:此|该)?(?:\s*ChatGPT\s*)?(?:对话|会话)|找不到(?:此|该)?(?:对话|会话)|(?:对话|会话)(?:已被删除|不存在)|無法載入.*(?:對話|聊天)|找不到.*(?:對話|聊天)|(?:對話|聊天)不存在/i;
    const candidates = document.querySelectorAll('[role="alert"], [role="status"], [data-testid*="error" i], main');
    return [...candidates].some(element => {
      const text = cleanTitle(element.textContent).replace(/\s+/g, ' ').trim();
      return text.length > 0 && text.length < 600 && pattern.test(text);
    });
  }

  function clearPendingOpen() {
    if (!state.ui.pendingOpenChat) return;
    state.ui.pendingOpenChat = null;
    saveState();
  }

  function schedulePendingOpenVerification(delay = 1200) {
    clearTimeout(pendingOpenTimer);
    if (!state.ui.pendingOpenChat) return;
    pendingOpenTimer = setTimeout(() => {
      const pending = state.ui.pendingOpenChat;
      if (!pending || !state.chats[pending.key]) {
        clearPendingOpen();
        return;
      }
      const elapsed = Date.now() - pending.startedAt;
      const current = chatKey();
      const missing = pageShowsMissingConversation();
      const redirectedAway = elapsed >= 3200 && current !== pending.key;
      if (missing || redirectedAway) {
        removeChatFromOrganizer(pending.key, '该会话已不存在，已从 Organizer 移除。');
        return;
      }
      if (elapsed >= 8000) {
        clearPendingOpen();
        return;
      }
      schedulePendingOpenVerification(1000);
    }, delay);
  }

  function beginOpenChatVerification(key) {
    if (!key || !state.chats[key]) return;
    state.ui.pendingOpenChat = { key, startedAt: Date.now() };
    saveState();
    schedulePendingOpenVerification();
  }

  function findConversationAnchorNear(element) {
    let node = element;
    for (let depth = 0; node && depth < 9; depth += 1, node = node.parentElement) {
      const ownAnchor = node.matches?.('a[href]') ? node : null;
      if (ownAnchor && chatKey(ownAnchor.href)) return ownAnchor;
      const childAnchor = node.querySelector?.('a[href*="/c/"], a[href*="/conversation/"], a[href*="/codex/"]');
      if (childAnchor && chatKey(childAnchor.href)) return childAnchor;
    }
    return null;
  }

  function installNativeDeleteSync() {
    const deletePattern = /^(?:delete|remove)(?:\s+(?:chat|conversation))?$|^(?:删除|刪除|移除)(?:对话|對話|会话|會話|聊天)?$|^(?:supprimer|löschen|eliminar)(?:\s+.+)?$/i;
    const cancelPattern = /^(?:cancel|取消|annuler|abbrechen|cancelar)$/i;
    document.addEventListener('click', event => {
      const organizer = document.getElementById(APP_ID);
      if (organizer?.contains(event.target)) return;
      const control = event.target.closest?.('button, [role="button"], [role="menuitem"]');
      if (!control) return;

      const labels = [
        control.getAttribute('aria-label'),
        control.getAttribute('title'),
        control.textContent,
      ].filter(Boolean).map(value => cleanTitle(value).replace(/\s+/g, ' ').trim());
      const nearbyAnchor = findConversationAnchorNear(control);
      if (nearbyAnchor) {
        nativeActionKey = chatKey(nearbyAnchor.href);
        nativeActionStartedAt = Date.now();
      } else if (labels.some(label => /(?:more|options|menu|更多|选项|選項|菜单|選單)/i.test(label))) {
        nativeActionKey = chatKey();
        nativeActionStartedAt = Date.now();
      }
      const inDialog = Boolean(control.closest('[role="dialog"], [role="alertdialog"], [aria-modal="true"]'));
      if (inDialog && labels.some(label => cancelPattern.test(label))) {
        pendingNativeDelete = null;
        return;
      }
      if (!labels.some(label => deletePattern.test(label))) return;

      if (!inDialog) {
        const key = Date.now() - nativeActionStartedAt < 15_000 ? nativeActionKey : chatKey();
        pendingNativeDelete = null;
        if (key && state.chats[key]) pendingNativeDelete = { key, startedAt: Date.now() };
        return;
      }

      if (!pendingNativeDelete || Date.now() - pendingNativeDelete.startedAt > 30_000) return;
      const key = pendingNativeDelete.key;
      pendingNativeDelete = null;
      setTimeout(() => removeChatFromOrganizer(key, '已同步移除删除的会话。'), 800);
    }, true);
  }

  function currentTitle() {
    const key = chatKey();
    if (key) {
      const matchingAnchor = nativeChatAnchors().find(anchor => chatKey(anchor.href) === key);
      const sidebarTitle = matchingAnchor ? anchorTitle(matchingAnchor) : '';
      if (sidebarTitle && !isPlaceholderTitle(sidebarTitle)) return sidebarTitle;
    }
    const selectors = [
      '[data-testid="conversation-title"]',
      'header [aria-label*="conversation title" i]',
    ];
    for (const selector of selectors) {
      const text = cleanTitle(document.querySelector(selector)?.textContent);
      if (text && text.length < 180 && !isPlaceholderTitle(text)) return text;
    }
    const title = cleanTitle(document.title);
    if (title && title.length < 240 && !isPlaceholderTitle(title)) return title;
    return key && state.chats[key]?.title && !isPlaceholderTitle(state.chats[key].title)
      ? state.chats[key].title
      : '';
  }

  function upsertChat(rawUrl, title, options = {}) {
    const key = chatKey(rawUrl);
    if (!key) return false;
    const existing = state.chats[key] || { key };
    const wasNew = !state.chats[key];
    const previousTitle = existing.title;
    const previousUrl = existing.url;
    const previousProjectState = Boolean(existing.inProject);
    const nextTitle = cleanTitle(title);
    const fallbackTitle = existing.title && !isPlaceholderTitle(existing.title) ? existing.title : '正在获取标题…';
    const now = Date.now();
    Object.assign(existing, {
      key,
      title: nextTitle && !isPlaceholderTitle(nextTitle) ? nextTitle : fallbackTitle,
      url: canonicalUrl(rawUrl),
      sectionId: existing.sectionId || '',
      status: STATUS[existing.status] ? existing.status : 'none',
      type: existing.type || inferType(rawUrl),
      inProject: typeof options.projectState === 'boolean' ? options.projectState : isProjectUrl(rawUrl),
      createdAt: existing.createdAt || now,
      lastSeen: options.touch ? now : (existing.lastSeen || now),
      manualOrder: Number.isFinite(existing.manualOrder)
        ? existing.manualOrder
        : nextManualOrder(existing.sectionId || '', false, key),
    });
    state.chats[key] = existing;
    if (existing.inProject) existing.type = 'project';
    else if (existing.type === 'project') existing.type = inferType(rawUrl);
    return wasNew || previousTitle !== existing.title || previousUrl !== existing.url || previousProjectState !== existing.inProject;
  }

  function nativeChatAnchors(root = document) {
    const selector = root === document ? 'nav a[href], aside a[href]' : 'a[href]';
    let anchors = [...root.querySelectorAll(selector)].filter(anchor =>
      !anchor.closest(`#${APP_ID}`) && Boolean(chatKey(anchor.href))
    );
    if (root === document && !anchors.length) {
      anchors = [...document.querySelectorAll('a[href*="/c/"],a[href*="/conversation/"],a[href*="/codex/"]')]
        .filter(anchor => !anchor.closest(`#${APP_ID}`) && Boolean(chatKey(anchor.href)));
    }
    return anchors;
  }

  function anchorTitle(anchor) {
    const candidates = [
      anchor.getAttribute('aria-label'),
      anchor.getAttribute('title'),
      anchor.querySelector('[data-testid*="title"]')?.textContent,
      anchor.textContent,
    ];
    for (const candidate of candidates) {
      const title = cleanNativeAnchorTitle(candidate);
      if (title && title.length <= 240 && !isPlaceholderTitle(title) && !isNonConversationTitle(title)) return title;
    }
    return '';
  }

  function harvestNativeChats({ includeCurrent = true, persist = true } = {}) {
    let changed = false;
    let harvested = 0;
    let added = 0;
    const anchorsByKey = new Map();
    nativeChatAnchors().forEach(anchor => {
      const key = chatKey(anchor.href);
      const title = anchorTitle(anchor);
      if (!key || !title) return;
      harvested += 1;
      if (!anchorsByKey.has(key)) anchorsByKey.set(key, []);
      anchorsByKey.get(key).push({ anchor, title });
    });
    anchorsByKey.forEach(items => {
      // If ChatGPT temporarily renders both the previous plain URL and the new
      // project URL, project membership wins until the project URL disappears.
      const selected = items.find(item => isProjectUrl(item.anchor.href)) || items[0];
      const projectState = items.some(item => isProjectUrl(item.anchor.href));
      const key = chatKey(selected.anchor.href);
      if (key && !state.chats[key]) added += 1;
      changed = upsertChat(selected.anchor.href, selected.title, { projectState }) || changed;
    });
    if (includeCurrent && chatKey()) {
      const key = chatKey();
      if (key && !state.chats[key]) added += 1;
      changed = upsertChat(location.href, currentTitle(), { projectState: isProjectUrl(location.href) }) || changed;
    }
    if (changed && persist) saveState();
    return { changed, harvested, added };
  }

  function scanNativeChats() {
    if (fullScanRunning) return;
    const { changed } = harvestNativeChats();
    if (changed) queueRender();
  }

  function scheduleScan() {
    if (fullScanRunning) return;
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanNativeChats, 450);
  }

  function findHistoryScroller() {
    const anchors = nativeChatAnchors();
    const candidates = new Set();
    for (const anchor of anchors) {
      let element = anchor.parentElement;
      while (element && element !== document.body) {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        if (/(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 20 && rect.left < 520) {
          candidates.add(element);
        }
        element = element.parentElement;
      }
    }
    if (!candidates.size) {
      document.querySelectorAll('nav *, aside *').forEach(element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        if (rect.width > 160 && rect.width < 520 && rect.height > 180 && rect.left < 520 &&
            /(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 20) {
          candidates.add(element);
        }
      });
    }
    return [...candidates]
      .map(element => ({ element, score: nativeChatAnchors(element).length * 100000 + element.scrollHeight }))
      .sort((a, b) => b.score - a.score)[0]?.element || null;
  }

  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

  function cookieValue(name) {
    const prefix = `${encodeURIComponent(name)}=`;
    const item = document.cookie.split(';').map(value => value.trim()).find(value => value.startsWith(prefix));
    if (!item) return '';
    try { return decodeURIComponent(item.slice(prefix.length)); } catch (_) { return item.slice(prefix.length); }
  }

  function conversationIdFromKey(key) {
    const match = String(key || '').match(/^chat:(.+)$/);
    return match && isPlausibleConversationId(match[1]) ? match[1] : null;
  }

  async function sessionAccessToken() {
    try {
      const response = await fetch('/api/auth/session', { credentials: 'include', cache: 'no-store' });
      if (!response.ok) return '';
      const session = await response.json();
      return typeof session?.accessToken === 'string' ? session.accessToken : '';
    } catch (_) {
      return '';
    }
  }

  function apiHeaders(accessToken = '') {
    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'OAI-Language': document.documentElement.lang || navigator.language || 'en-US',
    };
    const deviceId = cookieValue('oai-did');
    const accountId = cookieValue('_account');
    if (deviceId) headers['OAI-Device-Id'] = deviceId;
    if (accountId && accountId !== 'personal') headers['ChatGPT-Account-ID'] = accountId;
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    return headers;
  }

  async function chatApiFetch(path, method, body) {
    const request = token => fetch(path, {
      method,
      credentials: 'include',
      headers: apiHeaders(token),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let response = await request('');
    if (response.status === 401 || response.status === 403) {
      const token = await sessionAccessToken();
      if (token) response = await request(token);
    }
    return response;
  }

  async function responseError(response) {
    try {
      const data = await response.clone().json();
      const message = data?.detail || data?.message || data?.error?.message || data?.error;
      if (typeof message === 'string' && message.trim()) return message.trim();
    } catch (_) {}
    if (response.status === 401 || response.status === 403) return '登录状态或账号权限验证失败，请刷新 ChatGPT 后重试。';
    if (response.status === 429) return '请求过于频繁，请稍后再试。';
    return `ChatGPT 请求失败（HTTP ${response.status}）。`;
  }

  async function mutateConversation(key, kind, title = '') {
    const id = conversationIdFromKey(key);
    if (!id) throw new Error('目前只能直接操作普通 ChatGPT 会话，暂不支持 Work/Codex 项目。');
    const encodedId = encodeURIComponent(id);
    const modern = kind === 'rename'
      ? { path: `/backend-api/conversation/id/${encodedId}/rename`, method: 'POST', body: { title } }
      : { path: `/backend-api/conversation/id/${encodedId}`, method: 'DELETE' };
    const legacy = kind === 'rename'
      ? { path: `/backend-api/conversation/${encodedId}`, method: 'PATCH', body: { title } }
      : { path: `/backend-api/conversation/${encodedId}`, method: 'PATCH', body: { is_visible: false } };

    let response = await chatApiFetch(modern.path, modern.method, modern.body);
    if ([400, 403, 404, 405, 422, 501].includes(response.status)) {
      response = await chatApiFetch(legacy.path, legacy.method, legacy.body);
    }
    if (kind === 'delete' && response.status === 404) return { alreadyMissing: true };
    if (!response.ok) throw new Error(await responseError(response));
    return { alreadyMissing: false };
  }

  async function renameChatOnChatGPT(key, title, button) {
    const originalLabel = button?.textContent || '重命名';
    if (button) { button.disabled = true; button.textContent = '重命名中…'; }
    try {
      await mutateConversation(key, 'rename', title);
      const chat = state.chats[key];
      if (chat) {
        chat.title = title;
        chat.lastSeen = Date.now();
        saveState();
      }
      closeModal();
      queueRender();
      toast('已重命名 ChatGPT 会话。');
    } catch (error) {
      if (button) { button.disabled = false; button.textContent = originalLabel; }
      toast(error?.message || '重命名失败。');
    }
  }

  function openRenameChat(key) {
    const chat = state.chats[key];
    if (!chat) return;
    const layer = openModal('重命名 ChatGPT 会话',
      `<label class="cso-field">新标题<input name="native-title" value="${esc(chat.title)}" maxlength="128"></label>
       <div class="cso-note">将直接修改 ChatGPT 中保存的会话标题，不需要该会话出现在原生侧栏中。</div>`,
      '<button data-rename-native class="cso-primary">重命名</button><button data-modal-close>取消</button>');
    const input = layer.querySelector('[name="native-title"]');
    input.select();
    layer.querySelector('[data-rename-native]').addEventListener('click', () => {
      const title = input.value.trim();
      if (!title) {
        input.setCustomValidity('请输入标题');
        input.reportValidity();
        return;
      }
      renameChatOnChatGPT(key, title, layer.querySelector('[data-rename-native]'));
    });
  }

  function openDeleteChat(key) {
    const chat = state.chats[key];
    if (!chat) return;
    const layer = openModal('删除 ChatGPT 会话',
      `<div>确定要删除“${esc(chat.title)}”吗？</div>
       <div class="cso-note">这会从 ChatGPT 账号中删除该会话，而不只是移除 Organizer 记录。此操作无法撤销。</div>`,
      '<button data-delete-native class="cso-danger">删除会话</button><button data-modal-close>取消</button>');
    const button = layer.querySelector('[data-delete-native]');
    button.addEventListener('click', async () => {
      const originalLabel = button.textContent;
      button.disabled = true;
      button.textContent = '删除中…';
      try {
        await mutateConversation(key, 'delete');
        removeChatFromOrganizer(key);
        closeModal();
        toast('已删除会话并从 Organizer 移除。');
      } catch (error) {
        button.disabled = false;
        button.textContent = originalLabel;
        toast(error?.message || '删除失败。');
      }
    });
  }

  async function scanAllHistory() {
    if (fullScanRunning) return;
    fullScanRunning = true;
    clearTimeout(scanTimer);
    scanTimer = null;
    const root = document.getElementById(APP_ID);
    const button = root?.querySelector('[data-action="scan"]');
    const originalLabel = button?.textContent || '重新索引';
    if (button) {
      button.disabled = true;
      button.textContent = '寻找历史列表…';
    }
    const before = Object.keys(state.chats).length;
    let currentCount = before;
    let changed = false;
    let scroller = null;
    let originalTop = 0;
    try {
      const initial = harvestNativeChats({ persist: false });
      changed = initial.changed;
      currentCount += initial.added;
      scroller = findHistoryScroller();
      if (!scroller) {
        toast('未找到可滚动的原生历史列表；已索引当前页面可见会话。');
        return;
      }

      originalTop = scroller.scrollTop;
      let stagnantAtBottom = 0;
      let previousCount = currentCount;
      let previousHeight = scroller.scrollHeight;
      scroller.scrollTop = 0;
      await wait(350);

      for (let step = 0; step < 180; step += 1) {
        if (!scroller.isConnected) throw new Error('扫描过程中原生历史列表发生了变化。');
        const result = harvestNativeChats({ includeCurrent: false, persist: false });
        changed = result.changed || changed;
        currentCount += result.added;
        if (button) button.textContent = `索引中… ${currentCount}`;

        const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        const atBottom = scroller.scrollTop >= maxTop - 4;
        if (atBottom) {
          await wait(650);
          const bottomResult = harvestNativeChats({ includeCurrent: false, persist: false });
          changed = bottomResult.changed || changed;
          currentCount += bottomResult.added;
          const newHeight = scroller.scrollHeight;
          stagnantAtBottom = currentCount === previousCount && newHeight === previousHeight
            ? stagnantAtBottom + 1
            : 0;
          previousCount = currentCount;
          previousHeight = newHeight;
          if (stagnantAtBottom >= 4) break;
        } else {
          stagnantAtBottom = 0;
          scroller.scrollTop = Math.min(maxTop, scroller.scrollTop + Math.max(180, scroller.clientHeight * 0.72));
        }
        await wait(240);
      }

      scroller.scrollTop = Math.min(originalTop, Math.max(0, scroller.scrollHeight - scroller.clientHeight));
      const finalResult = harvestNativeChats({ persist: false });
      changed = finalResult.changed || changed;
      currentCount += finalResult.added;
      const added = currentCount - before;
      toast(added > 0 ? `索引完成：新增 ${added} 个会话。` : '索引完成：没有发现新的会话。');
    } catch (error) {
      console.warn('[ChatGPT Sidebar Organizer] 重新索引提前停止。', error);
      toast(error?.message || '页面发生意外变化，重新索引已停止。');
    } finally {
      if (scroller?.isConnected) {
        scroller.scrollTop = Math.min(originalTop, Math.max(0, scroller.scrollHeight - scroller.clientHeight));
      }
      if (changed) saveState();
      if (changed) queueRender();
      if (button) { button.disabled = false; button.textContent = originalLabel; }
      fullScanRunning = false;
      scheduleScan();
    }
  }

  function ensureCurrentChat() {
    const key = chatKey();
    if (!key) return null;
    upsertChat(location.href, currentTitle(), { touch: true, projectState: isProjectUrl(location.href) });
    const pending = state.ui.pendingNewChat;
    const chat = state.chats[key];
    if (pending && key !== pending.previousKey && !chat.inProject &&
        getSection(pending.sectionId) && chat.createdAt >= pending.startedAt - 5000) {
      chat.sectionId = pending.sectionId;
      chat.manualOrder = nextManualOrder(pending.sectionId, false, key);
      const sectionName = getSection(pending.sectionId).name;
      state.ui.pendingNewChat = null;
      setTimeout(() => toast(`新会话已加入“${sectionName}”。`), 100);
    }
    saveState();
    return key;
  }

  function startNewChatInSection(sectionId) {
    const section = getSection(sectionId);
    if (!section) {
      toast('这个分区已不存在。');
      return;
    }
    state.ui.pendingNewChat = {
      sectionId,
      startedAt: Date.now(),
      previousKey: chatKey(),
    };
    saveState();
    window.location.assign(`${location.origin}/`);
  }

  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      render();
    });
  }

  function visibleChats() {
    const query = state.ui.query.trim().toLocaleLowerCase();
    let chats = Object.values(state.chats).filter(chat => {
      if (chat.inProject) return false;
      if (query && !chat.title.toLocaleLowerCase().includes(query)) return false;
      if (state.ui.section === 'unsectioned' && chat.sectionId) return false;
      if (!['all', 'unsectioned'].includes(state.ui.section) && chat.sectionId !== state.ui.section) return false;
      if (state.ui.status === 'none' && chat.status !== 'none') return false;
      if (!['all', 'none'].includes(state.ui.status) && chat.status !== state.ui.status) return false;
      if (state.ui.type !== 'all' && chat.type !== state.ui.type) return false;
      if (state.ui.quick === 'unsectioned' && chat.sectionId) return false;
      return true;
    });
    chats.sort((a, b) => {
      if (state.ui.sort === 'custom') return (a.manualOrder || 0) - (b.manualOrder || 0);
      if (state.ui.sort === 'title') return a.title.localeCompare(b.title);
      if (state.ui.sort === 'oldest') return a.lastSeen - b.lastSeen;
      return b.lastSeen - a.lastSeen;
    });
    return chats;
  }

  function getSection(id) {
    return state.sections.find(section => section.id === id);
  }

  function sectionOptions(selected = '') {
    return [
      `<option value="" ${selected === '' ? 'selected' : ''}>未分区</option>`,
      ...[...state.sections]
        .sort((a, b) => a.order - b.order)
        .map(s => `<option value="${esc(s.id)}" ${selected === s.id ? 'selected' : ''}>${esc(s.name)}</option>`),
    ].join('');
  }

  function chatRow(chat) {
    const status = STATUS[chat.status] || STATUS.none;
    const statusPill = chat.status !== 'none'
      ? `<span class="cso-status" style="--status:${status.color}">${esc(status.label)}</span>`
      : '';
    const typePill = chat.type === 'work' ? '<span class="cso-type-tag">工作</span>' : '';
    return `
      <div class="cso-chat" data-key="${esc(chat.key)}" title="${esc(chat.title)}">
        <span class="cso-drag-handle" draggable="true" aria-label="拖动排序" title="拖动排序">⠿</span>
        <a href="${esc(chat.url)}" data-action="open-chat"><span class="cso-chat-title">${esc(chat.title)}</span>${typePill}${statusPill}</a>
        <button class="cso-row-action cso-rename" data-action="rename-chat" aria-label="重命名 ChatGPT 会话" title="重命名">✎</button>
        <button class="cso-row-action cso-delete" data-action="delete-chat" aria-label="删除 ChatGPT 会话" title="删除">×</button>
        <button class="cso-more" data-action="edit-chat" aria-label="编辑分区和状态" title="编辑分区和状态">•••</button>
      </div>`;
  }

  function groupedChatHtml() {
    const chats = visibleChats();
    const groups = new Map();
    for (const chat of chats) {
      const id = chat.sectionId && getSection(chat.sectionId) ? chat.sectionId : '';
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(chat);
    }
    const ordered = [...state.sections].sort((a, b) => a.order - b.order);
    const parts = [];
    if (!ordered.length && !Object.keys(state.chats).length) {
      return `<div class="cso-empty">
        <strong>还没有分区或已索引会话</strong><br>
        <button data-action="manage-sections" class="cso-inline-action">＋ 新建第一个分区</button>
        <button data-action="scan" class="cso-inline-action">索引原生历史列表</button>
      </div>`;
    }
    for (const section of ordered) {
      const items = groups.get(section.id) || [];
      if (!items.length && (state.ui.query || state.ui.quick !== 'all' || state.ui.section !== 'all' || state.ui.status !== 'all' || state.ui.type !== 'all')) continue;
      parts.push(`
        <section class="cso-section cso-colored-section" data-section="${esc(section.id)}" style="--section:${esc(section.color)}">
          <div class="cso-section-bar">
            <button class="cso-section-head" data-action="toggle-section">
              <span class="cso-chevron">${section.collapsed ? '›' : '⌄'}</span>
              <span class="cso-dot" style="--dot:${esc(section.color)}"></span>
              <span class="cso-section-name">${esc(section.name)}</span><span class="cso-count">${items.length}</span>
            </button>
            <button class="cso-new-chat" data-action="new-chat-in-section" data-section-id="${esc(section.id)}" title="在此分区创建新会话" aria-label="在 ${esc(section.name)} 创建新会话">＋</button>
          </div>
          <div class="cso-section-items" ${section.collapsed ? 'hidden' : ''}>${items.map(chatRow).join('') || '<div class="cso-empty-mini">暂无聊天</div>'}</div>
        </section>`);
    }
    const unsectioned = groups.get('') || [];
    if (unsectioned.length || !chats.length) {
      parts.push(`
        <section class="cso-section cso-unsectioned" data-section="">
          <div class="cso-section-head cso-static"><span class="cso-chevron">•</span><span class="cso-section-name">未分区</span><span class="cso-count">${unsectioned.length}</span></div>
          <div class="cso-section-items">${unsectioned.map(chatRow).join('') || '<div class="cso-empty">没有符合筛选条件的聊天</div>'}</div>
        </section>`);
    }
    return parts.join('');
  }

  function clearDropMarkers(root) {
    root.querySelectorAll('.is-drop-before,.is-drop-after,.is-dragging').forEach(row => {
      row.classList.remove('is-drop-before', 'is-drop-after', 'is-dragging');
    });
  }

  function seedManualOrderFromCurrentView(root) {
    root.querySelectorAll('.cso-section').forEach(sectionElement => {
      const sectionId = sectionElement.dataset.section || '';
      const visibleKeys = [...sectionElement.querySelectorAll('.cso-chat[data-key]')]
        .map(row => row.dataset.key)
        .filter(key => state.chats[key]);
      const visibleSet = new Set(visibleKeys);
      const remainingKeys = Object.values(state.chats)
        .filter(chat => (chat.sectionId || '') === sectionId && !visibleSet.has(chat.key))
        .sort((a, b) => (a.manualOrder || 0) - (b.manualOrder || 0))
        .map(chat => chat.key);
      [...visibleKeys, ...remainingKeys].forEach((key, index) => {
        state.chats[key].manualOrder = index * 10;
      });
    });
  }

  function reorderChat(dragKey, targetKey, placeAfter) {
    const dragged = state.chats[dragKey];
    const target = state.chats[targetKey];
    if (!dragged || !target || dragKey === targetKey) return false;
    const sectionId = dragged.sectionId || '';
    if (sectionId !== (target.sectionId || '')) {
      toast('拖动排序只能在同一分区内进行。');
      return false;
    }
    const ordered = Object.values(state.chats)
      .filter(chat => (chat.sectionId || '') === sectionId)
      .sort((a, b) => (a.manualOrder || 0) - (b.manualOrder || 0));
    const from = ordered.findIndex(chat => chat.key === dragKey);
    if (from < 0) return false;
    const [moving] = ordered.splice(from, 1);
    const targetIndex = ordered.findIndex(chat => chat.key === targetKey);
    if (targetIndex < 0) return false;
    ordered.splice(targetIndex + (placeAfter ? 1 : 0), 0, moving);
    ordered.forEach((chat, index) => { chat.manualOrder = index * 10; });
    state.ui.sort = 'custom';
    saveState();
    queueRender();
    return true;
  }

  function clampWindowPosition(root, x, y) {
    const margin = 8;
    const width = root.offsetWidth || Math.min(432, innerWidth - margin * 2);
    const height = root.offsetHeight || 48;
    return {
      x: Math.max(margin, Math.min(x, innerWidth - width - margin)),
      y: Math.max(margin, Math.min(y, innerHeight - Math.min(height, innerHeight - margin * 2) - margin)),
    };
  }

  function applyWindowPosition(root) {
    const defaultX = Math.min(Math.max(280, 12), Math.max(12, innerWidth - (root.offsetWidth || 432) - 12));
    const position = clampWindowPosition(
      root,
      Number.isFinite(state.ui.windowX) ? state.ui.windowX : defaultX,
      Number.isFinite(state.ui.windowY) ? state.ui.windowY : 82,
    );
    root.style.left = `${Math.round(position.x)}px`;
    root.style.top = `${Math.round(position.y)}px`;
  }

  function renderSectionToc(root) {
    const toc = root.querySelector('.cso-section-toc');
    const previousScrollTop = toc.scrollTop;
    const hasUnsectioned = Object.values(state.chats)
      .some(chat => !chat.inProject && !(chat.sectionId && getSection(chat.sectionId)));
    const rows = [...state.sections]
      .sort((a, b) => a.order - b.order)
      .map(section => `<button data-action="jump-section" data-section-id="${esc(section.id)}" title="${esc(section.name)}"><span class="cso-toc-dot" style="--toc:${esc(section.color)}"></span><span>${esc(section.name)}</span></button>`);
    if (hasUnsectioned) {
      rows.push('<button data-action="jump-section" data-section-id="" title="未分区"><span class="cso-toc-dot cso-toc-neutral"></span><span>未分区</span></button>');
    }
    toc.innerHTML = `<div class="cso-toc-title">分区目录</div>${rows.join('') || '<div class="cso-toc-empty">暂无分区</div>'}`;
    toc.scrollTop = previousScrollTop;
  }

  function jumpToSection(root, sectionId) {
    const section = sectionId ? getSection(sectionId) : null;
    if (section?.collapsed) {
      section.collapsed = false;
      saveState();
      render();
    }
    requestAnimationFrame(() => {
      const list = root.querySelector('.cso-list');
      const target = [...list.querySelectorAll('.cso-section')]
        .find(element => (element.dataset.section || '') === (sectionId || ''));
      if (!target) {
        toast('当前筛选条件下没有显示这个分区。');
        return;
      }
      const top = list.scrollTop + target.getBoundingClientRect().top - list.getBoundingClientRect().top - 4;
      list.scrollTo({ top, behavior: 'smooth' });
    });
  }

  function filterActiveCount() {
    return ['section', 'status', 'type'].filter(k => state.ui[k] !== 'all').length;
  }

  function buildRoot() {
    const root = document.createElement('div');
    root.id = APP_ID;
    root.innerHTML = `
      <button class="cso-launch" data-action="toggle-app" aria-label="打开聊天整理器">☰ <span>Organizer</span></button>
      <aside class="cso-panel" aria-label="ChatGPT Sidebar Organizer">
        <div class="cso-header">
          <div class="cso-window-drag" data-window-drag title="拖动窗口"><span class="cso-window-grip">⠿</span><strong>Chat Organizer</strong><span class="cso-total"></span></div>
          <div class="cso-header-actions">
            <button data-action="batch-edit" title="批量整理未分区会话">批量</button>
            <button data-action="expand-all" title="展开所有分区" aria-label="展开所有分区">▾</button>
            <button data-action="collapse-all" title="收起所有分区" aria-label="收起所有分区">▴</button>
            <button data-action="back-to-top" title="回到最上面">↑</button>
            <button data-action="manage-sections" title="管理分区">分区</button>
            <button data-action="settings" title="设置与备份">⚙</button>
            <button data-action="toggle-app" title="收起">×</button>
          </div>
        </div>
        <div class="cso-workspace">
          <nav class="cso-section-toc" aria-label="分区目录"></nav>
          <div class="cso-main-column">
            <div class="cso-current"></div>
            <div class="cso-quickbar">
              <button data-quick="all">全部</button>
              <button data-quick="unsectioned">未分区</button>
            </div>
            <div class="cso-searchline">
              <input class="cso-search" type="search" placeholder="搜索已索引聊天…" autocomplete="off">
              <button data-action="toggle-filters" class="cso-filter-btn">筛选<span class="cso-filter-count"></span></button>
            </div>
            <div class="cso-filters" hidden></div>
            <div class="cso-list"></div>
            <div class="cso-footer"><span>数据仅保存在此浏览器</span><button data-action="scan">重新索引</button></div>
          </div>
        </div>
      </aside>
      <div class="cso-modal-layer" hidden></div>`;
    document.body.appendChild(root);
    bindEvents(root);
    applyWindowPosition(root);
    return root;
  }

  function render() {
    const root = document.getElementById(APP_ID) || buildRoot();
    root.classList.toggle('is-open', state.ui.open);
    const managedCount = Object.values(state.chats).filter(chat => !chat.inProject).length;
    root.querySelector('.cso-total').textContent = ` · ${managedCount}`;
    const input = root.querySelector('.cso-search');
    if (document.activeElement !== input) input.value = state.ui.query;
    root.querySelectorAll('[data-quick]').forEach(button => {
      button.classList.toggle('is-active', button.dataset.quick === state.ui.quick);
    });
    const count = filterActiveCount();
    root.querySelector('.cso-filter-count').textContent = count ? ` ${count}` : '';
    root.querySelector('.cso-list').innerHTML = groupedChatHtml();
    renderSectionToc(root);
    renderFilters(root);
    renderCurrent(root);
    applyWindowPosition(root);
  }

  function renderCurrent(root) {
    const box = root.querySelector('.cso-current');
    const key = chatKey();
    const pending = state.ui.pendingNewChat;
    if (!key && pending && getSection(pending.sectionId)) {
      box.innerHTML = `<span>发送第一条消息后，将自动加入“${esc(getSection(pending.sectionId).name)}”。</span><button class="cso-cancel-pending" data-action="cancel-pending-new-chat">取消</button>`;
      return;
    }
    if (!key || !state.chats[key]) {
      box.innerHTML = '<span>打开一个已保存的会话后即可整理</span>';
      return;
    }
    const chat = state.chats[key];
    if (chat.inProject) {
      box.innerHTML = '<span>当前会话位于专案中，不显示在 Organizer</span>';
      return;
    }
    const section = getSection(chat.sectionId);
    const status = STATUS[chat.status] || STATUS.none;
    box.innerHTML = `
      <div class="cso-current-label">当前聊天</div>
      <button data-action="edit-current" title="设置当前聊天">
        <span>${esc(chat.title)}</span>
        <small>${section ? esc(section.name) : '未分区'} · ${esc(status.label)}${chat.type === 'work' ? ' · 工作' : ''}</small>
      </button>`;
  }

  function renderFilters(root) {
    const filters = root.querySelector('.cso-filters');
    const sectionSignature = state.sections
      .slice()
      .sort((a, b) => a.order - b.order)
      .map(section => `${section.id}:${section.name}`)
      .join('|');
    if (!filters.dataset.ready || filters.dataset.sectionSignature !== sectionSignature) {
      const currentOpen = !filters.hidden;
      filters.innerHTML = `
      <label>分区<select data-filter="section"><option value="all">全部分区</option><option value="unsectioned">未分区</option>${[...state.sections].sort((a,b)=>a.order-b.order).map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select></label>
      <label>状态<select data-filter="status"><option value="all">全部状态</option><option value="none">未设置</option><option value="active">Active</option><option value="reference">Reference</option><option value="backlog">Backlog</option></select></label>
      <label>类型<select data-filter="type"><option value="all">全部</option><option value="chat">Chat</option><option value="work">工作</option><option value="gpt">GPT</option></select></label>
      <label>排序<select data-filter="sort"><option value="custom">自定义拖动排序</option><option value="recent">最近访问</option><option value="oldest">最早访问</option><option value="title">标题 A–Z</option></select></label>
      <button data-action="clear-filters" class="cso-clear">清除筛选</button>`;
      filters.dataset.ready = 'true';
      filters.dataset.sectionSignature = sectionSignature;
      filters.hidden = !currentOpen;
    }
    ['section', 'status', 'type', 'sort'].forEach(name => {
      const select = filters.querySelector(`[data-filter="${name}"]`);
      if (select && document.activeElement !== select) select.value = state.ui[name];
    });
  }

  function bindEvents(root) {
    root.addEventListener('input', event => {
      if (event.target.matches('.cso-search')) {
        state.ui.query = event.target.value;
        clearTimeout(searchRenderTimer);
        searchRenderTimer = setTimeout(() => { saveState(); queueRender(); }, 120);
      }
    });
    root.addEventListener('change', event => {
      const filter = event.target.dataset.filter;
      if (filter) {
        state.ui[filter] = event.target.value;
        saveState();
        queueRender();
      }
    });
    root.addEventListener('click', event => {
      const button = event.target.closest('button, a');
      if (!button) return;
      const quick = button.dataset.quick;
      if (quick) {
        state.ui.quick = quick;
        saveState();
        queueRender();
        return;
      }
      const action = button.dataset.action;
      if (!action) return;
      if (action !== 'open-chat') event.preventDefault();
      const row = button.closest('.cso-chat');
      const key = row?.dataset.key;
      const section = button.closest('.cso-section')?.dataset.section;
      const actions = {
        'toggle-app': () => { state.ui.open = !state.ui.open; saveState(); queueRender(); },
        'toggle-filters': () => { const f = root.querySelector('.cso-filters'); f.hidden = !f.hidden; },
        'clear-filters': () => {
          Object.assign(state.ui, { quick: 'all', query: '', section: 'all', status: 'all', type: 'all', sort: 'custom' });
          saveState(); queueRender();
        },
        'open-chat': () => beginOpenChatVerification(key),
        'rename-chat': () => key && openRenameChat(key),
        'delete-chat': () => key && openDeleteChat(key),
        'edit-chat': () => key && openChatEditor(key),
        'new-chat-in-section': () => startNewChatInSection(button.dataset.sectionId),
        'cancel-pending-new-chat': () => { state.ui.pendingNewChat = null; saveState(); queueRender(); },
        'edit-current': () => {
          const currentKey = ensureCurrentChat();
          if (currentKey) openChatEditor(currentKey);
          else toast('请先打开一个已经保存的 ChatGPT 会话。');
        },
        'toggle-section': () => {
          const item = getSection(section);
          if (item) { item.collapsed = !item.collapsed; saveState(); queueRender(); }
        },
        'jump-section': () => jumpToSection(root, button.dataset.sectionId || ''),
        'expand-all': () => {
          state.sections.forEach(item => { item.collapsed = false; });
          saveState(); queueRender();
        },
        'collapse-all': () => {
          state.sections.forEach(item => { item.collapsed = true; });
          saveState(); queueRender();
        },
        'back-to-top': () => root.querySelector('.cso-list').scrollTo({ top: 0, behavior: 'smooth' }),
        'batch-edit': openBatchEditor,
        'manage-sections': openSectionManager,
        'settings': openSettings,
        'scan': scanAllHistory,
      };
      actions[action]?.();
    });

    root.addEventListener('dragstart', event => {
      const handle = event.target.closest('.cso-drag-handle');
      const row = handle?.closest('.cso-chat');
      if (!row?.dataset.key) return;
      if (state.ui.sort !== 'custom') {
        seedManualOrderFromCurrentView(root);
        state.ui.sort = 'custom';
        saveState();
      }
      draggedChatKey = row.dataset.key;
      row.classList.add('is-dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', draggedChatKey);
    });
    root.addEventListener('dragover', event => {
      if (!draggedChatKey) return;
      const row = event.target.closest('.cso-chat[data-key]');
      if (!row || row.dataset.key === draggedChatKey) return;
      const dragged = state.chats[draggedChatKey];
      const target = state.chats[row.dataset.key];
      if (!dragged || !target || (dragged.sectionId || '') !== (target.sectionId || '')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      root.querySelectorAll('.is-drop-before,.is-drop-after').forEach(item => item.classList.remove('is-drop-before', 'is-drop-after'));
      const rect = row.getBoundingClientRect();
      row.classList.add(event.clientY > rect.top + rect.height / 2 ? 'is-drop-after' : 'is-drop-before');
    });
    root.addEventListener('drop', event => {
      if (!draggedChatKey) return;
      const row = event.target.closest('.cso-chat[data-key]');
      if (!row || row.dataset.key === draggedChatKey) return;
      event.preventDefault();
      reorderChat(draggedChatKey, row.dataset.key, row.classList.contains('is-drop-after'));
      clearDropMarkers(root);
      draggedChatKey = null;
    });
    root.addEventListener('dragend', () => {
      clearDropMarkers(root);
      draggedChatKey = null;
    });

    root.addEventListener('pointerdown', event => {
      const handle = event.target.closest('[data-window-drag]');
      if (!handle || event.button !== 0) return;
      const rect = root.getBoundingClientRect();
      panelDrag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: rect.left,
        originY: rect.top,
      };
      handle.setPointerCapture?.(event.pointerId);
      root.classList.add('is-window-dragging');
      event.preventDefault();
    });
    root.addEventListener('pointermove', event => {
      if (!panelDrag || event.pointerId !== panelDrag.pointerId) return;
      const position = clampWindowPosition(
        root,
        panelDrag.originX + event.clientX - panelDrag.startX,
        panelDrag.originY + event.clientY - panelDrag.startY,
      );
      root.style.left = `${Math.round(position.x)}px`;
      root.style.top = `${Math.round(position.y)}px`;
    });
    root.addEventListener('pointerup', event => {
      if (!panelDrag || event.pointerId !== panelDrag.pointerId) return;
      const rect = root.getBoundingClientRect();
      state.ui.windowX = Math.round(rect.left);
      state.ui.windowY = Math.round(rect.top);
      panelDrag = null;
      root.classList.remove('is-window-dragging');
      saveState();
    });
    root.addEventListener('pointercancel', () => {
      panelDrag = null;
      root.classList.remove('is-window-dragging');
    });
    window.addEventListener('resize', () => applyWindowPosition(root), { passive: true });
  }

  function openModal(title, body, footer = '') {
    const layer = document.querySelector(`#${APP_ID} .cso-modal-layer`);
    layer.hidden = false;
    layer.innerHTML = `
      <div class="cso-modal-backdrop" data-modal-close></div>
      <div class="cso-modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="cso-modal-head"><strong>${esc(title)}</strong><button data-modal-close>×</button></div>
        <div class="cso-modal-body">${body}</div>
        ${footer ? `<div class="cso-modal-footer">${footer}</div>` : ''}
      </div>`;
    layer.querySelectorAll('[data-modal-close]').forEach(el => el.addEventListener('click', closeModal));
    return layer;
  }

  function closeModal() {
    const layer = document.querySelector(`#${APP_ID} .cso-modal-layer`);
    if (!layer) return;
    // Replace the entire event-delegation container. This guarantees that
    // listeners installed by a previous modal cannot accumulate across
    // close/reopen cycles and fire the same action multiple times.
    const cleanLayer = layer.cloneNode(false);
    cleanLayer.hidden = true;
    layer.replaceWith(cleanLayer);
  }

  function openChatEditor(key) {
    const chat = state.chats[key];
    if (!chat) return;
    const layer = openModal('整理聊天', `
      <div class="cso-chat-editor-title"><span>会话名称</span><strong>${esc(chat.title)}</strong></div>
      <div class="cso-field">
        <span>分区</span>
        <div class="cso-section-picker">
          <select name="section">${sectionOptions(chat.sectionId)}</select>
          <button type="button" data-show-inline-section>＋ 新建</button>
        </div>
      </div>
      <div class="cso-inline-section-create" hidden>
        <input name="new-section-name" placeholder="分区名称" maxlength="40">
        <input type="color" name="new-section-color" value="#10a37f" title="自由选择颜色">
        <button type="button" data-create-inline-section>创建并选中</button>
        ${colorPaletteHtml()}
      </div>
      <label class="cso-field">状态（独立标签）<select name="status">
        ${Object.entries(STATUS).map(([id, item]) => `<option value="${id}" ${chat.status === id ? 'selected' : ''}>${esc(item.label)}</option>`).join('')}
      </select></label>
      <div class="cso-note">会话名称始终与 ChatGPT 的真实标题一致。如需改名，请使用聊天行右侧的 ✎。</div>`,
      '<button data-save class="cso-primary">保存</button><button data-remove>从本地索引移除</button>');
    layer.querySelector('[data-save]').addEventListener('click', () => {
      // Re-read from state: a background scan may have refreshed this chat
      // while the editor was open.
      const target = state.chats[key] || chat;
      const selectedSection = layer.querySelector('[name="section"]').value;
      const selectedStatus = layer.querySelector('[name="status"]').value;
      const nextSectionId = selectedSection && getSection(selectedSection) ? selectedSection : '';
      if ((target.sectionId || '') !== nextSectionId) {
        target.manualOrder = nextManualOrder(nextSectionId, false, key);
      }
      target.sectionId = nextSectionId;
      target.status = STATUS[selectedStatus] ? selectedStatus : 'none';
      target.lastSeen = Date.now();
      state.chats[key] = target;
      saveState(); closeModal(); queueRender();
    });
    layer.querySelector('[data-show-inline-section]').addEventListener('click', () => {
      const creator = layer.querySelector('.cso-inline-section-create');
      creator.hidden = !creator.hidden;
      if (!creator.hidden) layer.querySelector('[name="new-section-name"]').focus();
    });
    layer.querySelector('[data-create-inline-section]').addEventListener('click', () => {
      const nameInput = layer.querySelector('[name="new-section-name"]');
      const colorInput = layer.querySelector('[name="new-section-color"]');
      const result = createSection(nameInput.value, colorInput.value);
      if (!result.section) {
        nameInput.setCustomValidity(result.error);
        nameInput.reportValidity();
        return;
      }
      if (result.error) toast(`${result.error}，已选中原有分区。`);
      const select = layer.querySelector('[name="section"]');
      if (![...select.options].some(option => option.value === result.section.id)) {
        select.add(new Option(result.section.name, result.section.id));
      }
      select.value = result.section.id;
      layer.querySelector('.cso-inline-section-create').hidden = true;
      nameInput.value = '';
    });
    layer.querySelectorAll('[data-preset-color]').forEach(button => {
      button.addEventListener('click', () => {
        layer.querySelector('[name="new-section-color"]').value = button.dataset.presetColor;
      });
    });
    layer.querySelector('[data-remove]').addEventListener('click', () => {
      if (!confirm('只从 Organizer 的本地索引移除？这不会删除 ChatGPT 对话。')) return;
      delete state.chats[key]; saveState(); closeModal(); queueRender();
    });
  }

  function openBatchEditor() {
    const chats = Object.values(state.chats)
      .filter(chat => !chat.inProject && !getSection(chat.sectionId))
      .sort((a, b) => a.title.localeCompare(b.title));
    if (!chats.length) {
      toast('没有未分区的会话。');
      return;
    }
    const rows = chats.map(chat => {
      const section = getSection(chat.sectionId);
      const status = STATUS[chat.status] || STATUS.none;
      const meta = `${section ? section.name : '未分区'} · ${status.label}${chat.type === 'work' ? ' · 工作' : ''}`;
      return `<label class="cso-batch-row" data-search="${esc(`${chat.title} ${meta}`.toLocaleLowerCase())}">
        <input type="checkbox" value="${esc(chat.key)}">
        <span><strong>${esc(chat.title)}</strong><small>${esc(meta)}</small></span>
      </label>`;
    }).join('');
    const layer = openModal('批量整理未分区会话', `
      <div class="cso-batch-toolbar">
        <input type="search" name="batch-search" placeholder="搜索会话…" autocomplete="off">
        <button type="button" data-select-visible>选择当前结果</button>
        <button type="button" data-clear-selection>清除</button>
      </div>
      <div class="cso-batch-list">${rows}</div>
      <div class="cso-batch-controls">
        <label class="cso-field">分区<select name="batch-section"><option value="__keep">保持不变</option>${sectionOptions('__keep')}</select></label>
        <label class="cso-field">状态<select name="batch-status"><option value="__keep">保持不变</option>${Object.entries(STATUS).map(([id, item]) => `<option value="${id}">${esc(item.label)}</option>`).join('')}</select></label>
      </div>
      <div class="cso-note"><span data-batch-count>已选择 0 个会话</span>；只修改你指定的项目。</div>`,
      '<button data-apply-batch class="cso-primary">应用</button><button data-modal-close>取消</button>');
    const list = layer.querySelector('.cso-batch-list');
    const updateCount = () => {
      const count = list.querySelectorAll('input:checked').length;
      layer.querySelector('[data-batch-count]').textContent = `已选择 ${count} 个会话`;
    };
    layer.querySelector('[name="batch-search"]').addEventListener('input', event => {
      const query = event.target.value.trim().toLocaleLowerCase();
      list.querySelectorAll('.cso-batch-row').forEach(row => {
        row.hidden = Boolean(query && !row.dataset.search.includes(query));
      });
    });
    list.addEventListener('change', updateCount);
    layer.querySelector('[data-select-visible]').addEventListener('click', () => {
      list.querySelectorAll('.cso-batch-row:not([hidden]) input').forEach(input => { input.checked = true; });
      updateCount();
    });
    layer.querySelector('[data-clear-selection]').addEventListener('click', () => {
      list.querySelectorAll('input').forEach(input => { input.checked = false; });
      updateCount();
    });
    layer.querySelector('[data-apply-batch]').addEventListener('click', () => {
      const keys = [...list.querySelectorAll('input:checked')].map(input => input.value);
      if (!keys.length) {
        toast('请先选择至少一个会话。');
        return;
      }
      const sectionValue = layer.querySelector('[name="batch-section"]').value;
      const statusValue = layer.querySelector('[name="batch-status"]').value;
      if (sectionValue === '__keep' && statusValue === '__keep') {
        toast('请选择要修改的分区或状态。');
        return;
      }
      keys.forEach(key => {
        const chat = state.chats[key];
        if (!chat) return;
        if (sectionValue !== '__keep') {
          const nextSectionId = sectionValue && getSection(sectionValue) ? sectionValue : '';
          if ((chat.sectionId || '') !== nextSectionId) {
            chat.manualOrder = nextManualOrder(nextSectionId, false, key);
            chat.sectionId = nextSectionId;
          }
        }
        if (statusValue !== '__keep' && STATUS[statusValue]) chat.status = statusValue;
      });
      saveState(); closeModal(); queueRender();
      toast(`已更新 ${keys.length} 个会话。`);
    });
  }

  function sectionManagerRows() {
    return [...state.sections].sort((a, b) => a.order - b.order).map(section => `
      <div class="cso-section-edit" data-id="${esc(section.id)}">
        <span class="cso-section-drag" draggable="true" title="拖动排序" aria-label="拖动分区排序">⠿</span>
        <input type="color" name="color" value="${esc(section.color)}" title="颜色">
        <input name="name" value="${esc(section.name)}" maxlength="40">
        <button data-delete-section title="删除">×</button>
      </div>`).join('');
  }

  function openSectionManager() {
    const layer = openModal('管理分区', `
      <div class="cso-section-editor">${sectionManagerRows() || '<div class="cso-empty-mini">尚未创建分区</div>'}</div>
      <button data-add-section class="cso-add">＋ 新建分区</button>
      <div class="cso-manager-section-create" hidden>
        <input name="manager-section-name" placeholder="分区名称" maxlength="40">
        <input type="color" name="manager-section-color" value="#10a37f" title="自由选择颜色">
        <button type="button" data-confirm-add-section>创建</button>
        ${colorPaletteHtml()}
      </div>
      <button data-delete-all-sections class="cso-delete-all" ${state.sections.length ? '' : 'disabled'}>删除所有分区</button>
      <div class="cso-note">删除分区不会删除聊天；其中的聊天会回到“未分区”。</div>`,
      '<button data-save-sections class="cso-primary">完成</button>');
    layer.addEventListener('click', event => {
      const row = event.target.closest('.cso-section-edit');
      const presetColor = event.target.closest('[data-preset-color]');
      if (presetColor) {
        const creator = presetColor.closest('.cso-manager-section-create');
        if (creator) creator.querySelector('[name="manager-section-color"]').value = presetColor.dataset.presetColor;
      } else if (event.target.matches('[data-add-section]')) {
        const creator = layer.querySelector('.cso-manager-section-create');
        creator.hidden = !creator.hidden;
        if (!creator.hidden) {
          const nameInput = layer.querySelector('[name="manager-section-name"]');
          if (!nameInput.value) nameInput.value = nextSectionName();
          nameInput.focus();
        }
      } else if (event.target.matches('[data-confirm-add-section]')) {
        syncSectionInputs(layer);
        const nameInput = layer.querySelector('[name="manager-section-name"]');
        const colorInput = layer.querySelector('[name="manager-section-color"]');
        const result = createSection(nameInput.value, colorInput.value);
        if (result.error) {
          nameInput.setCustomValidity(result.error);
          nameInput.reportValidity();
          return;
        }
        closeModal(); openSectionManager();
      } else if (event.target.matches('[data-delete-section]') && row) {
        const id = row.dataset.id;
        if (!confirm('删除这个分区？其中聊天将变为未分区。')) return;
        state.sections = state.sections.filter(s => s.id !== id);
        Object.values(state.chats).forEach(chat => {
          if (chat.sectionId !== id) return;
          chat.sectionId = '';
          chat.manualOrder = nextManualOrder('', false, chat.key);
        });
        saveState(); closeModal(); openSectionManager();
      } else if (event.target.matches('[data-delete-all-sections]')) {
        if (!confirm('删除所有分区？所有聊天都会回到“未分区”，聊天本身不会被删除。')) return;
        state.sections = [];
        Object.values(state.chats)
          .sort((a, b) => (a.manualOrder || 0) - (b.manualOrder || 0))
          .forEach((chat, index) => { chat.sectionId = ''; chat.manualOrder = index * 10; });
        state.ui.section = 'all';
        saveState(); closeModal(); openSectionManager();
      } else if (event.target.matches('[data-save-sections]')) {
        syncSectionInputs(layer); saveState(); closeModal(); queueRender();
      }
    });
    layer.addEventListener('dragstart', event => {
      const handle = event.target.closest('.cso-section-drag');
      const row = handle?.closest('.cso-section-edit');
      if (!row) return;
      syncSectionInputs(layer);
      draggedSectionId = row.dataset.id;
      row.classList.add('is-dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', draggedSectionId);
    });
    layer.addEventListener('dragover', event => {
      if (!draggedSectionId) return;
      const row = event.target.closest('.cso-section-edit');
      if (!row || row.dataset.id === draggedSectionId) return;
      event.preventDefault();
      layer.querySelectorAll('.is-drop-before,.is-drop-after').forEach(item => item.classList.remove('is-drop-before', 'is-drop-after'));
      const rect = row.getBoundingClientRect();
      row.classList.add(event.clientY > rect.top + rect.height / 2 ? 'is-drop-after' : 'is-drop-before');
    });
    layer.addEventListener('drop', event => {
      if (!draggedSectionId) return;
      const row = event.target.closest('.cso-section-edit');
      if (!row || row.dataset.id === draggedSectionId) return;
      event.preventDefault();
      syncSectionInputs(layer);
      const ordered = [...state.sections].sort((a, b) => a.order - b.order);
      const from = ordered.findIndex(section => section.id === draggedSectionId);
      if (from < 0) return;
      const [moving] = ordered.splice(from, 1);
      const targetIndex = ordered.findIndex(section => section.id === row.dataset.id);
      if (targetIndex < 0) return;
      ordered.splice(targetIndex + (row.classList.contains('is-drop-after') ? 1 : 0), 0, moving);
      ordered.forEach((section, index) => { section.order = index; });
      state.sections = ordered;
      draggedSectionId = null;
      saveState(); closeModal(); openSectionManager(); queueRender();
    });
    layer.addEventListener('dragend', () => {
      clearDropMarkers(layer);
      draggedSectionId = null;
    });
  }

  function syncSectionInputs(layer) {
    layer.querySelectorAll('.cso-section-edit').forEach(row => {
      const section = getSection(row.dataset.id);
      if (!section) return;
      section.name = row.querySelector('[name="name"]').value.trim() || '未命名';
      section.color = row.querySelector('[name="color"]').value;
    });
  }

  function openSettings() {
    const layer = openModal('设置与备份', `
      <div class="cso-settings-grid">
        <button data-export>导出 JSON 备份</button>
        <label class="cso-file-button">导入 JSON<input type="file" accept="application/json,.json" data-import hidden></label>
        <button data-reset class="cso-danger">清空 Organizer 数据</button>
      </div>
      <div class="cso-note">备份包含标题、URL、分区和状态，不包含聊天正文。浏览器清理网站数据前请先导出备份。</div>`);
    layer.querySelector('[data-export]').addEventListener('click', exportData);
    layer.querySelector('[data-import]').addEventListener('change', event => importData(event.target.files[0]));
    layer.querySelector('[data-reset]').addEventListener('click', () => {
      if (!confirm('清空所有本地分区、状态和索引？ChatGPT 对话本身不会受影响。')) return;
      state = defaultState(); saveState(); closeModal(); queueRender();
    });
  }

  function exportData() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `chatgpt-organizer-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function importData(file) {
    if (!file) return;
    try {
      if (file.size > MAX_IMPORT_BYTES) throw new Error('备份文件超过 5 MB 的导入限制。');
      const parsed = JSON.parse(await file.text());
      if (!parsed || typeof parsed !== 'object' || ![1, 2, 3].includes(parsed.version) ||
          !Array.isArray(parsed.sections) || !parsed.chats || typeof parsed.chats !== 'object' || Array.isArray(parsed.chats)) {
        throw new Error('备份格式不正确。');
      }
      if (parsed.sections.length > MAX_SECTIONS || Object.keys(parsed.chats).length > MAX_CHATS) {
        throw new Error(`备份上限为 ${MAX_SECTIONS} 个分区和 ${MAX_CHATS.toLocaleString()} 个会话。`);
      }
      if (!confirm('导入会替换当前 Organizer 数据，是否继续？')) return;
      state = normalizeState(parsed);
      saveState(); closeModal(); queueRender(); toast('导入完成。');
    } catch (error) {
      alert(`导入失败：${error.message}`);
    }
  }

  function toast(message) {
    const old = document.querySelector(`#${APP_ID} .cso-toast`);
    old?.remove();
    const root = document.getElementById(APP_ID);
    if (!root) {
      console.warn('[ChatGPT Sidebar Organizer]', message);
      return;
    }
    const el = document.createElement('div');
    el.className = 'cso-toast';
    el.textContent = message;
    root.appendChild(el);
    setTimeout(() => el.remove(), 2200);
  }

  function installStyles() {
    if (document.getElementById('cso-styles')) return;
    const style = document.createElement('style');
    style.id = 'cso-styles';
    style.textContent = `
      #${APP_ID}{--bg:rgba(249,249,249,.98);--panel:#fff;--text:#202123;--muted:#6b7280;--line:rgba(0,0,0,.11);--hover:rgba(0,0,0,.055);--accent:#10a37f;position:fixed;left:280px;top:82px;width:min(432px,calc(100vw - 16px));z-index:2147482000;color:var(--text);font:13px/1.35 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
      @media(prefers-color-scheme:dark){#${APP_ID}{--bg:rgba(32,33,35,.98);--panel:#2a2b2e;--text:#ececf1;--muted:#a3a3a3;--line:rgba(255,255,255,.12);--hover:rgba(255,255,255,.08)}}
      #${APP_ID} *{box-sizing:border-box}#${APP_ID} button,#${APP_ID} input,#${APP_ID} select{font:inherit;color:inherit}
      #${APP_ID} button{cursor:pointer}#${APP_ID} .cso-launch{display:flex;align-items:center;gap:7px;border:1px solid var(--line);border-radius:10px;background:var(--panel);padding:8px 11px;box-shadow:0 5px 18px rgba(0,0,0,.12)}
      #${APP_ID}.is-open .cso-launch{display:none}#${APP_ID}:not(.is-open) .cso-panel{display:none}
      #${APP_ID} .cso-panel{display:flex;flex-direction:column;max-height:calc(100vh - 16px);border:1px solid var(--line);border-radius:14px;background:var(--bg);box-shadow:0 14px 42px rgba(0,0,0,.22);overflow:hidden;backdrop-filter:blur(18px)}
      #${APP_ID} .cso-header{display:flex;align-items:center;justify-content:space-between;padding:9px 9px 7px 7px}#${APP_ID} .cso-window-drag{display:flex;align-items:center;min-width:0;flex:1;gap:6px;padding:3px 5px;cursor:grab;user-select:none;touch-action:none}#${APP_ID}.is-window-dragging .cso-window-drag{cursor:grabbing}#${APP_ID} .cso-window-grip{color:var(--muted);font-size:15px}#${APP_ID} .cso-total{color:var(--muted);font-weight:400}
      #${APP_ID} .cso-header-actions{display:flex;gap:2px;flex:0 0 auto}#${APP_ID} .cso-header button,#${APP_ID} .cso-footer button{border:0;background:transparent;border-radius:6px;padding:4px 6px}#${APP_ID} .cso-header button:hover,#${APP_ID} .cso-footer button:hover{background:var(--hover)}
      #${APP_ID} button:disabled{cursor:wait;opacity:.6}
      #${APP_ID} .cso-workspace{display:grid;grid-template-columns:88px minmax(0,1fr);min-height:0;flex:1;border-top:1px solid var(--line)}#${APP_ID} .cso-main-column{display:flex;flex-direction:column;min-width:0;min-height:0}#${APP_ID} .cso-section-toc{min-width:0;overflow:auto;border-right:1px solid var(--line);background:color-mix(in srgb,var(--panel),transparent 20%);padding:7px 5px}#${APP_ID} .cso-toc-title{padding:3px 5px 7px;color:var(--muted);font-size:10px;font-weight:700;letter-spacing:.04em}#${APP_ID} .cso-section-toc button{display:grid;grid-template-columns:9px minmax(0,1fr);align-items:center;gap:5px;width:100%;border:0;border-radius:7px;background:transparent;padding:6px 4px;text-align:left}#${APP_ID} .cso-section-toc button:hover{background:var(--hover)}#${APP_ID} .cso-section-toc button>span:nth-child(2){overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}#${APP_ID} .cso-toc-dot{width:8px;height:8px;border-radius:3px;background:var(--toc)}#${APP_ID} .cso-toc-neutral{background:var(--muted)}#${APP_ID} .cso-toc-empty{padding:8px 5px;color:var(--muted);font-size:10px}
      #${APP_ID} .cso-current{margin:8px 9px 7px;padding:7px 8px;border:1px solid var(--line);border-radius:9px;color:var(--muted)}#${APP_ID} .cso-current-label{font-size:10px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:2px}#${APP_ID} .cso-cancel-pending{margin-left:6px;border:0;border-radius:6px;background:var(--hover);padding:3px 6px}
      #${APP_ID} .cso-current>button{display:flex;flex-direction:column;width:100%;text-align:left;border:0;background:transparent;padding:0;overflow:hidden}#${APP_ID} .cso-current>button span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;color:var(--text)}#${APP_ID} .cso-current small{color:var(--muted)}
      #${APP_ID} .cso-quickbar{display:flex;gap:4px;padding:0 9px 7px}#${APP_ID} .cso-quickbar button{flex:1;border:1px solid transparent;border-radius:8px;background:transparent;padding:6px 5px}#${APP_ID} .cso-quickbar button:hover{background:var(--hover)}#${APP_ID} .cso-quickbar .is-active{background:var(--panel);border-color:var(--line);font-weight:600}
      #${APP_ID} .cso-searchline{display:flex;gap:5px;padding:0 9px 8px}#${APP_ID} .cso-search{min-width:0;flex:1;border:1px solid var(--line);border-radius:8px;background:var(--panel);padding:7px 9px;outline:none}#${APP_ID} .cso-search:focus{border-color:var(--accent);box-shadow:0 0 0 2px rgba(16,163,127,.14)}
      #${APP_ID} .cso-filter-btn{border:1px solid var(--line);border-radius:8px;background:var(--panel);padding:6px 8px}#${APP_ID} .cso-filter-count{display:inline-grid;place-items:center;min-width:16px;height:16px;border-radius:99px;background:var(--accent);color:white;font-size:10px}
      #${APP_ID} .cso-filters{display:grid;grid-template-columns:1fr 1fr;gap:6px 8px;padding:8px 10px;border-block:1px solid var(--line);background:var(--panel)}#${APP_ID} .cso-filters label{display:flex;flex-direction:column;gap:2px;color:var(--muted);font-size:11px}#${APP_ID} select,#${APP_ID} .cso-field input{border:1px solid var(--line);border-radius:7px;background:var(--bg);padding:6px}#${APP_ID} .cso-clear{align-self:end;border:0;border-radius:7px;background:var(--hover);padding:7px}
      #${APP_ID} .cso-list{flex:1;overflow:auto;overscroll-behavior:contain;padding:7px;min-height:90px}#${APP_ID} .cso-section{position:relative;margin:0 0 9px;border:1px solid var(--line);border-radius:11px;background:var(--panel);overflow:hidden}#${APP_ID} .cso-colored-section{border-color:color-mix(in srgb,var(--section),transparent 66%);box-shadow:inset 4px 0 0 var(--section)}#${APP_ID} .cso-section-bar{display:grid;grid-template-columns:minmax(0,1fr) 30px;align-items:center;gap:2px;background:linear-gradient(90deg,color-mix(in srgb,var(--section),transparent 84%),transparent 82%);border-bottom:1px solid color-mix(in srgb,var(--section),transparent 82%)}#${APP_ID} .cso-section-head{display:flex;align-items:center;gap:7px;width:100%;min-width:0;border:0;background:transparent;padding:8px 8px 8px 11px;text-align:left;font-weight:700}#${APP_ID} .cso-section-head:hover{background:var(--hover)}#${APP_ID} .cso-section-head.cso-static{cursor:default}#${APP_ID} .cso-section-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;letter-spacing:.01em}#${APP_ID} .cso-new-chat{border:0;border-radius:7px;background:transparent;color:var(--muted);padding:4px;font-size:18px;line-height:1}#${APP_ID} .cso-new-chat:hover{background:var(--hover);color:var(--text)}#${APP_ID} .cso-chevron{width:12px;color:var(--muted)}#${APP_ID} .cso-dot{width:10px;height:10px;border-radius:3px;background:var(--dot);box-shadow:0 0 0 2px color-mix(in srgb,var(--dot),transparent 72%)}#${APP_ID} .cso-count{margin-left:auto;min-width:21px;border-radius:99px;background:var(--hover);padding:1px 6px;text-align:center;color:var(--muted);font-weight:600}#${APP_ID} .cso-unsectioned{border-style:dashed;background:color-mix(in srgb,var(--muted),transparent 96%)}#${APP_ID} .cso-unsectioned>.cso-section-head{padding:8px 10px}
      #${APP_ID} .cso-section-items{padding:3px 4px 5px}#${APP_ID} .cso-chat{position:relative;display:grid;grid-template-columns:22px minmax(0,1fr) 25px 25px 28px;align-items:center;border-radius:8px;min-height:35px}#${APP_ID} .cso-chat:hover{background:var(--hover)}#${APP_ID} .cso-chat>a{display:flex;align-items:center;gap:5px;min-width:0;color:inherit;text-decoration:none;padding:6px 0}#${APP_ID} .cso-chat-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#${APP_ID} .cso-drag-handle{display:grid;place-items:center;align-self:stretch;color:var(--muted);cursor:grab;opacity:.38;user-select:none}#${APP_ID} .cso-drag-handle:active{cursor:grabbing}#${APP_ID} .cso-chat:hover .cso-drag-handle{opacity:1}#${APP_ID} .cso-chat.is-dragging{opacity:.38}#${APP_ID} .cso-chat.is-drop-before::before,#${APP_ID} .cso-chat.is-drop-after::after{content:"";position:absolute;left:5px;right:5px;height:3px;border-radius:3px;background:var(--accent);z-index:2}#${APP_ID} .cso-chat.is-drop-before::before{top:-2px}#${APP_ID} .cso-chat.is-drop-after::after{bottom:-2px}#${APP_ID} .cso-more,#${APP_ID} .cso-row-action{border:0;background:transparent;color:var(--muted);border-radius:6px;padding:4px;opacity:.18}#${APP_ID} .cso-chat:hover .cso-more,#${APP_ID} .cso-chat:hover .cso-row-action{opacity:1}#${APP_ID} .cso-row-action:hover,#${APP_ID} .cso-more:hover{background:var(--panel);color:var(--text)}#${APP_ID} .cso-delete:hover{color:#ef4444}
      #${APP_ID} .cso-status{flex:0 0 auto;border:1px solid color-mix(in srgb,var(--status),transparent 45%);border-radius:99px;color:var(--status);padding:1px 5px;font-size:9px;font-weight:650}#${APP_ID} .cso-type-tag{flex:0 0 auto;border-radius:99px;background:rgba(59,130,246,.11);color:#3b82f6;padding:1px 5px;font-size:9px;font-weight:700}#${APP_ID} .cso-empty,#${APP_ID} .cso-empty-mini{padding:16px 8px;text-align:center;color:var(--muted)}#${APP_ID} .cso-empty-mini{padding:7px;font-size:11px}
      #${APP_ID} .cso-inline-action{display:inline-block;margin:8px 3px 0;border:1px solid var(--line);border-radius:7px;background:var(--panel);padding:6px 8px}
      #${APP_ID} .cso-footer{display:flex;justify-content:space-between;align-items:center;border-top:1px solid var(--line);padding:6px 10px;color:var(--muted);font-size:10px}
      #${APP_ID} .cso-modal-layer{position:fixed;inset:0;z-index:2147483000}#${APP_ID} .cso-modal-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.38)}#${APP_ID} .cso-modal{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(520px,calc(100vw - 28px));max-height:82vh;overflow:auto;border:1px solid var(--line);border-radius:14px;background:var(--panel);box-shadow:0 20px 70px rgba(0,0,0,.32)}
      #${APP_ID} .cso-modal-head,#${APP_ID} .cso-modal-footer{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid var(--line)}#${APP_ID} .cso-modal-head button{border:0;background:transparent;font-size:20px}#${APP_ID} .cso-modal-body{display:grid;gap:11px;padding:14px}#${APP_ID} .cso-modal-footer{justify-content:flex-end;gap:8px;border-top:1px solid var(--line);border-bottom:0}#${APP_ID} .cso-modal-footer button,#${APP_ID} .cso-settings-grid button,#${APP_ID} .cso-file-button{border:1px solid var(--line);border-radius:8px;background:var(--bg);padding:8px 10px;text-align:center}#${APP_ID} .cso-modal-footer .cso-primary{background:var(--accent);color:white;border-color:var(--accent)}
      #${APP_ID} .cso-field{display:flex;flex-direction:column;gap:4px;font-weight:600}#${APP_ID} .cso-chat-editor-title{display:flex;flex-direction:column;gap:4px}#${APP_ID} .cso-chat-editor-title>span{color:var(--muted);font-size:11px}#${APP_ID} .cso-check{display:flex;align-items:center;gap:7px}#${APP_ID} .cso-note{color:var(--muted);font-size:11px;line-height:1.5}#${APP_ID} .cso-section-edit{position:relative;display:grid;grid-template-columns:24px 32px minmax(0,1fr) 30px;align-items:center;gap:5px;margin-bottom:6px}#${APP_ID} .cso-section-drag{display:grid;place-items:center;align-self:stretch;color:var(--muted);cursor:grab;user-select:none}#${APP_ID} .cso-section-edit.is-dragging{opacity:.4}#${APP_ID} .cso-section-edit.is-drop-before::before,#${APP_ID} .cso-section-edit.is-drop-after::after{content:"";position:absolute;left:0;right:0;height:3px;border-radius:3px;background:var(--accent)}#${APP_ID} .cso-section-edit.is-drop-before::before{top:-3px}#${APP_ID} .cso-section-edit.is-drop-after::after{bottom:-3px}#${APP_ID} .cso-section-edit input,#${APP_ID} .cso-section-edit button{min-width:0;border:1px solid var(--line);border-radius:7px;background:var(--bg);padding:6px}#${APP_ID} .cso-section-edit input[type=color]{padding:2px}#${APP_ID} .cso-add{border:1px dashed var(--line);border-radius:8px;background:transparent;padding:8px}#${APP_ID} .cso-settings-grid{display:grid;gap:8px}#${APP_ID} .cso-file-button{cursor:pointer}#${APP_ID} .cso-danger{color:#ef4444!important}
      #${APP_ID} .cso-batch-toolbar{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:6px}#${APP_ID} .cso-batch-toolbar input,#${APP_ID} .cso-batch-toolbar button{min-width:0;border:1px solid var(--line);border-radius:7px;background:var(--bg);padding:7px}#${APP_ID} .cso-batch-list{max-height:38vh;overflow:auto;border:1px solid var(--line);border-radius:9px;padding:4px}#${APP_ID} .cso-batch-row{display:grid;grid-template-columns:22px minmax(0,1fr);align-items:center;gap:5px;border-radius:7px;padding:6px}#${APP_ID} .cso-batch-row:hover{background:var(--hover)}#${APP_ID} .cso-batch-row>span{display:flex;min-width:0;flex-direction:column}#${APP_ID} .cso-batch-row strong,#${APP_ID} .cso-batch-row small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#${APP_ID} .cso-batch-row small{color:var(--muted);font-size:10px}#${APP_ID} .cso-batch-controls{display:grid;grid-template-columns:1fr 1fr;gap:8px}
      #${APP_ID} .cso-section-picker{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px}#${APP_ID} .cso-section-picker button,#${APP_ID} .cso-inline-section-create>button,#${APP_ID} .cso-manager-section-create>button{border:1px solid var(--line);border-radius:7px;background:var(--bg);padding:6px 9px}#${APP_ID} .cso-inline-section-create,#${APP_ID} .cso-manager-section-create{display:grid;grid-template-columns:minmax(0,1fr) 36px auto;gap:6px;padding:9px;border:1px dashed var(--line);border-radius:9px}#${APP_ID} .cso-inline-section-create[hidden],#${APP_ID} .cso-manager-section-create[hidden]{display:none}#${APP_ID} .cso-inline-section-create input,#${APP_ID} .cso-manager-section-create input{min-width:0;border:1px solid var(--line);border-radius:7px;background:var(--bg);padding:6px}#${APP_ID} .cso-inline-section-create input[type=color],#${APP_ID} .cso-manager-section-create input[type=color]{padding:2px}#${APP_ID} .cso-color-palette{grid-column:1/-1;display:grid;grid-template-columns:repeat(12,1fr);gap:5px;padding-top:2px}#${APP_ID} .cso-color-palette button{aspect-ratio:1;border:2px solid color-mix(in srgb,var(--swatch),#000 12%);border-radius:50%;background:var(--swatch);padding:0;min-width:0}#${APP_ID} .cso-color-palette button:hover{transform:scale(1.16);box-shadow:0 0 0 2px var(--panel),0 0 0 4px var(--swatch)}#${APP_ID} .cso-delete-all{border:1px solid rgba(239,68,68,.35);border-radius:8px;background:transparent;color:#ef4444;padding:8px}
      #${APP_ID} .cso-toast{position:fixed;left:18px;bottom:18px;border-radius:9px;background:#111827;color:white;padding:9px 12px;box-shadow:0 8px 30px rgba(0,0,0,.25)}
      @media(max-width:700px){#${APP_ID}{width:calc(100vw - 16px)}#${APP_ID} .cso-panel{max-height:calc(100vh - 16px)}}
    `;
    document.head.appendChild(style);
  }

  function watchNavigation() {
    const observer = new MutationObserver(records => {
      const app = document.getElementById(APP_ID);
      let hasExternalMutation = false;
      let titleChanged = false;
      let touchesSidebar = false;
      for (const record of records) {
        if (app?.contains(record.target)) continue;
        hasExternalMutation = true;
        if (record.target?.nodeName === 'TITLE' || record.target?.parentElement?.nodeName === 'TITLE') {
          titleChanged = true;
        }
        if (!touchesSidebar) {
          if (record.target?.closest?.('nav,aside')) {
            touchesSidebar = true;
          } else {
            for (const node of [...record.addedNodes, ...record.removedNodes]) {
              if (node.nodeType !== Node.ELEMENT_NODE) continue;
              if (node.matches?.('nav,aside') || node.querySelector?.('nav,aside')) {
                touchesSidebar = true;
                break;
              }
            }
          }
        }
        if (titleChanged && touchesSidebar) break;
      }
      if (!hasExternalMutation) return;
      if (titleChanged) {
        clearTimeout(titleRefreshTimer);
        titleRefreshTimer = setTimeout(() => { ensureCurrentChat(); queueRender(); }, 180);
      }
      let navigated = false;
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        navigated = true;
        schedulePendingOpenVerification(700);
        setTimeout(() => { ensureCurrentChat(); queueRender(); }, 650);
      }
      if (navigated || touchesSidebar) scheduleScan();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener('popstate', scheduleScan);
    window.addEventListener('storage', event => {
      if (event.key === STORAGE_KEY) { state = loadState(); queueRender(); }
    });
  }

  installStyles();
  buildRoot();
  installNativeDeleteSync();
  ensureCurrentChat();
  schedulePendingOpenVerification();
  scanNativeChats();
  queueRender();
  watchNavigation();
})();
