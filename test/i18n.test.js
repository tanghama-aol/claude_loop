const test = require("node:test");
const assert = require("node:assert/strict");

const {
    STORAGE_KEY,
    createI18n,
    normalizeLanguage,
    translate,
} = require("../public/i18n");

test("normalizeLanguage supports Chinese and English locale variants", () => {
    assert.equal(normalizeLanguage("en-US"), "en");
    assert.equal(normalizeLanguage("en-GB"), "en");
    assert.equal(normalizeLanguage("zh-TW"), "zh-CN");
    assert.equal(normalizeLanguage(""), "zh-CN");
});

test("translate interpolates values and falls back to the translation key", () => {
    assert.equal(translate("en", "task.count.other", { count: 3 }), "3 tasks");
    assert.equal(translate("zh-CN", "toast.pingComplete", { success: 2, total: 3 }), "Ping 完成：2/3 成功");
    assert.equal(translate("zh-CN", "ping.column.firstOutput"), "首字时延");
    assert.equal(translate("en", "ping.column.outputTokens"), "output tokens");
    assert.equal(translate("zh-CN", "dashboard.openProject", { name: "示例项目" }), "进入项目：示例项目");
    assert.equal(translate("en", "dashboard.openCard", { name: "Profiles" }), "Open Profiles");
    assert.equal(translate("en", "missing.key"), "missing.key");
});

test("createI18n restores and persists the selected language", () => {
    const values = new Map([[STORAGE_KEY, "en-US"]]);
    const storage = {
        getItem(key) {
            return values.get(key) || null;
        },
        setItem(key, value) {
            values.set(key, value);
        },
    };
    const i18n = createI18n({ storage, navigatorLanguage: "zh-CN" });

    assert.equal(i18n.getLanguage(), "en");
    assert.equal(i18n.getLocale(), "en-US");
    assert.equal(i18n.count("task.count", 1), "1 task");
    assert.equal(i18n.count("task.count", 2), "2 tasks");

    i18n.setLanguage("zh-Hans");
    assert.equal(i18n.getLanguage(), "zh-CN");
    assert.equal(values.get(STORAGE_KEY), "zh-CN");
});

test("apply translates text, placeholders, aria labels, and document language", () => {
    const textNode = { dataset: { i18n: "common.refresh" }, textContent: "" };
    const placeholderNode = { dataset: { i18nPlaceholder: "task.titlePlaceholder" }, placeholder: "" };
    const ariaNode = {
        dataset: { i18nAriaLabel: "language.select" },
        attributes: {},
        setAttribute(name, value) {
            this.attributes[name] = value;
        },
    };
    const titleNode = { dataset: { i18nTitle: "common.refresh" }, title: "" };
    const nodes = {
        "[data-i18n]": [textNode],
        "[data-i18n-placeholder]": [placeholderNode],
        "[data-i18n-aria-label]": [ariaNode],
        "[data-i18n-title]": [titleNode],
    };
    const documentRef = {
        documentElement: { lang: "" },
        querySelectorAll(selector) {
            return nodes[selector] || [];
        },
    };
    const i18n = createI18n({ navigatorLanguage: "en-US", documentRef });

    i18n.apply();

    assert.equal(documentRef.documentElement.lang, "en");
    assert.equal(textNode.textContent, "Refresh");
    assert.equal(placeholderNode.placeholder, "P3-stroke-order-scoring");
    assert.equal(ariaNode.attributes["aria-label"], "Select interface language");
    assert.equal(titleNode.title, "Refresh");
});
