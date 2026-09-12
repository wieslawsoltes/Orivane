import { zhCN } from './i18n-translations.js';

const LANGUAGE_KEY = 'orivane.ui-language';
const TRANSLATABLE_ATTRIBUTES = ['aria-label', 'title', 'placeholder'];
const SKIP_SELECTOR = [
    '[data-no-i18n]', '#text-edit-layer', '#accessible-objects',
    '[contenteditable="true"]', 'input', 'textarea', 'select',
].join(',');

const translations = zhCN;
const translatedValues = new Set(Object.values(translations));
const originalText = new WeakMap();
const originalAttributes = new WeakMap();
const browserLanguage = navigator.language?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
let language = localStorage.getItem(LANGUAGE_KEY) || browserLanguage;
let translating = false;

function skipped(element) {
    return !element || Boolean(element.closest(SKIP_SELECTOR));
}

function preserveWhitespace(source, replacement) {
    const leading = source.match(/^\s*/)?.[0] || '';
    const trailing = source.match(/\s*$/)?.[0] || '';
    return `${leading}${replacement}${trailing}`;
}

function patternedTranslation(text) {
    const shortcut = text.match(/^(.+?)(\s+\([^)]+\))$/);
    if (shortcut && translations[shortcut[1]]) return `${translations[shortcut[1]]}${shortcut[2]}`;
    const patterns = [
        [/^(\d+) objects?$/, '$1 个对象'],
        [/^(\d+) comments?$/, '$1 条评论'],
        [/^(\d+) frames?$/, '$1 个画框'],
        [/^(\d+) members?$/, '$1 名成员'],
        [/^(\d+) participants?$/, '$1 名参与者'],
        [/^(\d+) votes?$/, '$1 票'],
        [/^(\d+) saved in this browser$/, '已在此浏览器保存 $1 个白板'],
        [/^Local board · (.+)$/, '本地白板 · $1'],
    ];
    for (const [pattern, replacement] of patterns) {
        if (pattern.test(text)) return text.replace(pattern, replacement);
    }
    return null;
}

function translateTextNode(node) {
    if (skipped(node.parentElement)) return;
    if (language === 'en') {
        const original = originalText.get(node);
        if (original !== undefined) {
            node.nodeValue = original;
            originalText.delete(node);
        }
        return;
    }
    const source = node.nodeValue || '';
    const text = source.trim();
    if (!text || translatedValues.has(text)) return;
    const translated = translations[text] || patternedTranslation(text);
    if (!translated) return;
    originalText.set(node, source);
    node.nodeValue = preserveWhitespace(source, translated);
}

function translateAttributes(element) {
    if (skipped(element)) return;
    let originals = originalAttributes.get(element);
    if (language === 'en') {
        if (!originals) return;
        for (const [name, value] of originals) element.setAttribute(name, value);
        originalAttributes.delete(element);
        return;
    }
    for (const name of TRANSLATABLE_ATTRIBUTES) {
        if (!element.hasAttribute(name)) continue;
        const value = element.getAttribute(name);
        if (!value || translatedValues.has(value)) continue;
        const translated = translations[value] || patternedTranslation(value);
        if (!translated) continue;
        if (!originals) {
            originals = new Map();
            originalAttributes.set(element, originals);
        }
        originals.set(name, value);
        element.setAttribute(name, translated);
    }
}

function translateTree(root = document.body) {
    translating = true;
    try {
        if (root.nodeType === Node.TEXT_NODE) translateTextNode(root);
        if (root.nodeType === Node.ELEMENT_NODE) translateAttributes(root);
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
            const node = walker.currentNode;
            if (node.nodeType === Node.TEXT_NODE) translateTextNode(node);
            else translateAttributes(node);
        }
        const sourceTitle = document.documentElement.dataset.originalTitle || document.title;
        document.documentElement.dataset.originalTitle = sourceTitle;
        document.title = language === 'zh-CN' ? (translations[sourceTitle] || sourceTitle) : sourceTitle;
        document.documentElement.lang = language;
    } finally {
        translating = false;
    }
}

function updateToggle() {
    const button = document.querySelector('#language-toggle');
    if (!button) return;
    button.textContent = language === 'zh-CN' ? 'EN' : '中文';
    button.title = language === 'zh-CN' ? 'Switch to English' : '切换到中文';
    button.setAttribute('aria-label', button.title);
}

function setLanguage(nextLanguage) {
    language = nextLanguage === 'en' ? 'en' : 'zh-CN';
    localStorage.setItem(LANGUAGE_KEY, language);
    translateTree();
    updateToggle();
    window.dispatchEvent(new CustomEvent('orivane:languagechange', { detail: { language } }));
}

function installToggle() {
    const host = document.querySelector('.collabbar');
    if (!host || document.querySelector('#language-toggle')) return;
    const button = document.createElement('button');
    button.id = 'language-toggle';
    button.className = 'secondary-button locale-toggle';
    button.dataset.noI18n = 'true';
    button.addEventListener('click', () => setLanguage(language === 'zh-CN' ? 'en' : 'zh-CN'));
    host.prepend(button);
    updateToggle();
}

export async function initI18n() {
    installToggle();
    translateTree();
    const observer = new MutationObserver(records => {
        if (translating) return;
        translating = true;
        try {
            for (const record of records) {
                if (record.type === 'characterData') translateTextNode(record.target);
                if (record.type === 'attributes') translateAttributes(record.target);
                for (const node of record.addedNodes || []) translateTree(node);
            }
        } finally {
            translating = false;
        }
    });
    observer.observe(document.body, {
        childList: true, subtree: true, characterData: true, attributes: true,
        attributeFilter: TRANSLATABLE_ATTRIBUTES,
    });
    window.orivaneLanguage = { get: () => language, set: setLanguage };
}
