'use strict';
/**
 * MCP resource / prompt 的展示归一（D3-02，2026-11-23）
 *
 * 为什么单独一层：同一份 resources/read 结果既要给模型工具看，也要给诊断/未来 UI
 * 看。文本化规则写两遍，迟早一处把 base64 全量吐给模型、另一处只报 mimeType。
 * 这里只做确定性转换，不做缓存：资源可能随时变，缓存会让模型读到旧内容。
 */
function safeText(v) { return v == null ? '' : String(v); }

function summarizeResources(resources, templates) {
  const lines = [];
  for (const r of resources || []) {
    if (!r) continue;
    lines.push('- ' + safeText(r.uri) + (r.name ? ' · ' + safeText(r.name) : '') + (r.mimeType ? ' · ' + safeText(r.mimeType) : ''));
  }
  for (const t of templates || []) {
    if (!t) continue;
    lines.push('- ' + safeText(t.uriTemplate) + (t.name ? ' · ' + safeText(t.name) + '（模板）' : '（模板）'));
  }
  return { text: lines.join('\n'), count: (resources || []).length, templateCount: (templates || []).length };
}

function contentText(result) {
  const contents = (result && result.contents) || [];
  const text = contents.map((c) => {
    if (!c) return '';
    if (c.text != null) return safeText(c.text);
    if (c.blob != null) return '[base64 ' + safeText(c.mimeType) + ']';
    return '';
  }).filter(Boolean).join('\n');
  return { contents, text };
}

function promptText(result) {
  const messages = (result && result.messages) || [];
  const text = messages.map((m) => {
    const c = m && m.content;
    if (!c) return '';
    if (c.type === 'text') return safeText(c.text);
    if (c.type === 'image') return '[图片 ' + safeText(c.mimeType) + ']';
    if (c.type === 'resource') {
      const r = c.resource || {};
      return r.text == null ? '[资源 ' + safeText(r.uri) + ']' : safeText(r.text);
    }
    return '';
  }).filter(Boolean).join('\n\n');
  return { messages, text, description: (result && result.description) || '' };
}

module.exports = { summarizeResources, contentText, promptText };
