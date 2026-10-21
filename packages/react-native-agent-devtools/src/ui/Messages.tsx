import { memo, useState } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import type { ChatMessage } from '../runtime/Runtime';
import { Markdown } from './Markdown';
import { mono, radius, type Palette } from './theme';

/** Tool names without the `mobile_` prefix read better on a phone. */
const toolLabel = (name: string) => name.replace(/^mobile_/, '').replace(/_/g, ' ');

function ToolRow({ m, p }: { m: ChatMessage; p: Palette }) {
  const t = m.tool!;
  const [open, setOpen] = useState(false);
  const running = t.phase === 'start';
  const failed = t.ok === false;
  return (
    <View style={[styles.tool, { borderColor: failed ? p.error : p.border, backgroundColor: p.surface }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${t.summary ?? t.name}${running ? ', running' : failed ? ', failed' : ', done'}`}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((v) => !v)}
        style={styles.toolHead}
      >
        {running ? (
          <ActivityIndicator size="small" color={p.accent} style={styles.toolIcon} />
        ) : (
          <Text style={[styles.toolIcon, styles.toolGlyph, { color: failed ? p.error : p.ok }]}>{failed ? '✕' : '✓'}</Text>
        )}
        <Text numberOfLines={1} style={[styles.toolText, { color: p.text }]}>
          {t.summary ?? toolLabel(t.name)}
        </Text>
        {t.durationMs !== undefined ? <Text style={[styles.toolMs, { color: p.muted }]}>{t.durationMs < 1000 ? `${t.durationMs} ms` : `${(t.durationMs / 1000).toFixed(1)} s`}</Text> : null}
        <Text style={[styles.chevron, { color: p.muted }]}>{open ? '▾' : '▸'}</Text>
      </Pressable>
      {m.image ? (
        <Image
          accessibilityLabel="Screenshot taken by the agent"
          source={{ uri: m.image.uri }}
          resizeMode="contain"
          style={[styles.shot, open ? styles.shotOpen : styles.shotThumb, { aspectRatio: m.image.width / Math.max(1, m.image.height), borderColor: p.border }]}
        />
      ) : null}
      {open ? (
        <View style={[styles.toolDetail, { borderColor: p.border }]}>
          <Text style={[styles.detailMeta, { color: p.muted }]}>
            {t.name}
            {t.durationMs !== undefined ? ` · ${t.durationMs} ms` : ''}
            {running ? ' · running' : failed ? ' · failed' : ' · ok'}
          </Text>
          {t.detail ? (
            <Text selectable style={[styles.detailText, { color: p.text, backgroundColor: p.code }]}>
              {t.detail.slice(0, 1_200)}
            </Text>
          ) : (
            <Text style={[styles.detailMeta, { color: p.muted }]}>{running ? 'Waiting for the result…' : 'No text output.'}</Text>
          )}
        </View>
      ) : null}
    </View>
  );
}

export const Message = memo(function Message({ m, p }: { m: ChatMessage; p: Palette }) {
  if (m.role === 'tool' && m.tool) return <ToolRow m={m} p={p} />;
  if (m.role === 'user') {
    return (
      <View style={styles.userWrap}>
        {m.attachment ? (
          <View style={[styles.attachment, { borderColor: p.accent }]}>
            <Text numberOfLines={1} style={[styles.attachmentText, { color: p.accent }]}>
              ⌖ {m.attachment}
            </Text>
          </View>
        ) : null}
        <View style={[styles.userBubble, { backgroundColor: p.userBubble }]}>
          <Text selectable style={[styles.body, { color: p.text }]}>
            {m.text}
          </Text>
        </View>
      </View>
    );
  }
  if (m.role === 'error') {
    return (
      <View style={[styles.notice, { borderColor: p.error }]}>
        <Text style={[styles.noticeText, { color: p.error }]}>{m.text}</Text>
      </View>
    );
  }
  if (m.role === 'system') {
    const warn = m.level === 'warning';
    return (
      <View style={[styles.notice, { borderColor: warn ? p.warn : p.border, backgroundColor: p.surface }]}>
        <Text style={[styles.noticeText, { color: warn ? p.warn : p.muted }]}>{m.text}</Text>
      </View>
    );
  }
  return (
    <View style={styles.assistant}>
      <Markdown text={m.text} palette={p} />
    </View>
  );
});

const styles = StyleSheet.create({
  body: { fontSize: 15, lineHeight: 21 },
  userWrap: { alignSelf: 'flex-end', maxWidth: '88%', alignItems: 'flex-end', gap: 4 },
  userBubble: { borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8 },
  attachment: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3, maxWidth: '100%' },
  attachmentText: { fontSize: 12, fontWeight: '600' },
  assistant: { alignSelf: 'stretch' },
  notice: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.sm, paddingHorizontal: 10, paddingVertical: 7 },
  noticeText: { fontSize: 13, lineHeight: 18 },
  tool: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.sm, overflow: 'hidden' },
  toolHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, paddingVertical: 7 },
  toolIcon: { width: 16 },
  toolGlyph: { fontSize: 13, fontWeight: '700', textAlign: 'center' },
  toolText: { flex: 1, fontSize: 13 },
  toolMs: { fontSize: 11.5, fontVariant: ['tabular-nums'] },
  chevron: { fontSize: 11, width: 10, textAlign: 'center' },
  shot: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, marginHorizontal: 10, marginBottom: 10 },
  shotThumb: { width: '38%' },
  shotOpen: { width: undefined, alignSelf: 'stretch' },
  toolDetail: { borderTopWidth: StyleSheet.hairlineWidth, padding: 10, gap: 6 },
  detailMeta: { fontSize: 11.5 },
  detailText: { fontFamily: mono, fontSize: 11, lineHeight: 15, padding: 8, borderRadius: 6 },
});
