import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View, type GestureResponderEvent } from 'react-native';
import type { Runtime, Selection } from '../runtime/Runtime';
import { selectionTitle } from '../runtime/Runtime';
import { useStore } from '../utils/Store';
import { mono, radius, type Palette } from './theme';

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

interface Props {
  runtime: Runtime;
  palette: Palette;
  insets: { top: number; bottom: number };
  /** Open the chat with the selection attached and a suggested question. */
  onAsk: (question?: string) => void;
}

const QUESTIONS = ["Why doesn't this work?", 'Why is this misaligned?', 'Where is this in the code?'];

/**
 * Inspect mode: the next tap picks the element a real finger would hit (native
 * hit-test), instead of operating the app. The pick is highlighted and described.
 */
export function InspectLayer({ runtime, palette: p, insets, onAsk }: Props) {
  const inspecting = useStore(runtime.store, (s) => s.inspecting);
  const selection = useStore(runtime.store, (s) => s.selection);
  const [capturing, setCapturing] = useState(true);
  const [busy, setBusy] = useState(false);

  const pick = async (e: GestureResponderEvent) => {
    const { pageX, pageY } = e.nativeEvent;
    // Let touches through before hit-testing, or the hit-test finds this layer.
    setCapturing(false);
    setBusy(true);
    await nextFrame();
    await nextFrame();
    try {
      await runtime.pickAt(pageX, pageY);
    } finally {
      setBusy(false);
      setCapturing(true);
      runtime.stopInspect();
    }
  };

  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      {selection?.details.bounds ? <Highlight selection={selection} p={p} /> : null}
      {inspecting ? (
        <>
          <Pressable
            accessibilityLabel="Tap an element to inspect it"
            pointerEvents={capturing ? 'auto' : 'none'}
            onPress={pick}
            style={[StyleSheet.absoluteFill, { backgroundColor: p.accentFill }]}
          />
          <View style={[styles.banner, { top: insets.top + 8, backgroundColor: p.bg, borderColor: p.border }]}>
            {busy ? <ActivityIndicator size="small" color={p.accent} /> : <Text style={[styles.bannerGlyph, { color: p.accent }]}>⌖</Text>}
            <Text style={[styles.bannerText, { color: p.text }]}>{busy ? 'Inspecting…' : 'Tap any element to inspect it'}</Text>
            <Pressable accessibilityRole="button" hitSlop={10} onPress={() => runtime.stopInspect()}>
              <Text style={[styles.link, { color: p.accent }]}>Cancel</Text>
            </Pressable>
          </View>
        </>
      ) : selection ? (
        <SelectionCard runtime={runtime} selection={selection} p={p} bottom={insets.bottom} onAsk={onAsk} />
      ) : null}
    </View>
  );
}

function Highlight({ selection, p }: { selection: Selection; p: Palette }) {
  const b = selection.details.bounds!;
  return (
    <View pointerEvents="none" style={[styles.highlight, { left: b.x, top: b.y, width: Math.max(2, b.width), height: Math.max(2, b.height), borderColor: p.accent, backgroundColor: p.accentFill }]}>
      <View style={[styles.tag, b.y > 24 ? styles.tagAbove : styles.tagBelow, { backgroundColor: p.accent }]}>
        <Text numberOfLines={1} style={[styles.tagText, { color: p.accentText }]}>
          {selection.details.source?.element ?? selection.details.component ?? selection.details.host.type} · {b.width}×{b.height}
        </Text>
      </View>
    </View>
  );
}

function SelectionCard({ runtime, selection, p, bottom, onAsk }: { runtime: Runtime; selection: Selection; p: Palette; bottom: number; onAsk: Props['onAsk'] }) {
  const [details, setDetails] = useState(false);
  const d = selection.details;
  const problems = d.findings.filter((f) => f.severity !== 'info');
  const notes = d.findings.filter((f) => f.severity === 'info');
  return (
    <View style={[styles.card, { bottom: bottom + 10, backgroundColor: p.bg, borderColor: p.border }]}>
      <View style={styles.cardHead}>
        <Text numberOfLines={1} style={[styles.cardTitle, { color: p.text }]}>
          {selectionTitle(d)}
        </Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Clear selection" hitSlop={10} onPress={() => runtime.clearSelection()}>
          <Text style={[styles.close, { color: p.muted }]}>✕</Text>
        </Pressable>
      </View>
      <Text numberOfLines={2} style={[styles.meta, { color: p.muted }]}>
        {selection.resolving
          ? 'Finding the source location…'
          : d.source
            ? `${d.source.file.split('/').slice(-3).join('/')}:${d.source.line}${d.source.inComponent ? ` in ${d.source.inComponent}` : ''}`
            : `Source unavailable: ${d.sourceNote ?? 'not mapped'}`}
      </Text>
      {problems.slice(0, 3).map((f) => (
        <Text key={f.code + f.message} numberOfLines={3} style={[styles.finding, { color: f.severity === 'error' ? p.error : p.warn }]}>
          ● {f.message}
        </Text>
      ))}
      {!problems.length ? (
        <Text style={[styles.finding, { color: p.ok }]}>
          ● No problems found by static checks{notes.length ? ` (${notes.length} note${notes.length > 1 ? 's' : ''})` : ''}
        </Text>
      ) : null}
      {details ? (
        <ScrollView style={[styles.details, { backgroundColor: p.code }]} nestedScrollEnabled>
          <Text selectable style={[styles.detailsText, { color: p.text }]}>
            {selection.text}
          </Text>
        </ScrollView>
      ) : null}
      <View style={styles.chips}>
        {QUESTIONS.map((q) => (
          <Pressable key={q} accessibilityRole="button" onPress={() => onAsk(q)} style={[styles.chip, { borderColor: p.border }]}>
            <Text style={[styles.chipText, { color: p.text }]}>{q}</Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.actions}>
        <Action label="Ask about it" p={p} primary onPress={() => onAsk()} />
        <Action label="Parent" p={p} onPress={() => void runtime.selectParent()} />
        <Action label={details ? 'Less' : 'Details'} p={p} onPress={() => setDetails((v) => !v)} />
        <Action label="Pick again" p={p} onPress={() => runtime.startInspect()} />
      </View>
    </View>
  );
}

function Action({ label, onPress, p, primary }: { label: string; onPress: () => void; p: Palette; primary?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.action, primary ? { backgroundColor: p.accent, borderColor: p.accent } : { borderColor: p.border }, { opacity: pressed ? 0.8 : 1 }]}
    >
      <Text style={[styles.actionText, { color: primary ? p.accentText : p.text }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 8,
  },
  bannerGlyph: { fontSize: 16, fontWeight: '700' },
  bannerText: { fontSize: 13.5, fontWeight: '600' },
  link: { fontSize: 13.5, fontWeight: '700' },
  highlight: { position: 'absolute', borderWidth: 2, borderRadius: 4 },
  tag: { position: 'absolute', left: -2, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2, maxWidth: 260 },
  tagAbove: { bottom: '100%', marginBottom: 2 },
  tagBelow: { top: '100%', marginTop: 2 },
  tagText: { fontSize: 11, fontWeight: '700' },
  card: {
    position: 'absolute',
    left: 10,
    right: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.lg,
    padding: 14,
    gap: 6,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 4 },
    elevation: 14,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardTitle: { flex: 1, fontSize: 15, fontWeight: '700' },
  close: { fontSize: 15 },
  meta: { fontSize: 12.5, fontFamily: mono },
  finding: { fontSize: 13, lineHeight: 18 },
  details: { maxHeight: 220, borderRadius: radius.sm, padding: 8 },
  detailsText: { fontFamily: mono, fontSize: 11, lineHeight: 15 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
  chip: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5 },
  chipText: { fontSize: 12.5 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 6 },
  action: { flex: 1, alignItems: 'center', borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingVertical: 9 },
  actionText: { fontSize: 13, fontWeight: '600' },
});
