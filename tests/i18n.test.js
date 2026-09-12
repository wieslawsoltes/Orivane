import test from 'node:test';
import assert from 'node:assert/strict';
import { zhCN } from '../public/i18n-translations.js';

test('Simplified Chinese catalog contains reviewed core interface labels', () => {
    assert.ok(Object.keys(zhCN).length >= 850);
    assert.equal(zhCN.Workspace, '工作区');
    assert.equal(zhCN.Share, '分享');
    assert.equal(zhCN.Templates, '模板');
    assert.equal(zhCN['AI assistant'], 'AI 助手');
    assert.equal(zhCN.Diagnostics, '诊断');
});

test('Simplified Chinese catalog has no empty keys or values', () => {
    for (const [source, translation] of Object.entries(zhCN)) {
        assert.ok(source.trim(), 'source label must not be empty');
        assert.ok(translation.trim(), `translation for ${source} must not be empty`);
    }
});
