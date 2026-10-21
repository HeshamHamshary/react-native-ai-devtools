import { memo, type ReactNode } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import type { Palette } from './theme';

const monoFamily = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

/** Inline: `code`, **bold**, *italic*. */
function inline(text: string, p: Palette, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-${i++}`;
    if (tok.startsWith('`')) {
      out.push(
        <Text key={key} style={[styles.inlineCode, { backgroundColor: p.code, color: p.text }]}>
          {tok.slice(1, -1)}
        </Text>,
      );
    } else if (tok.startsWith('**')) {
      out.push(
        <Text key={key} style={styles.bold}>
          {tok.slice(2, -2)}
        </Text>,
      );
    } else {
      out.push(
        <Text key={key} style={styles.italic}>
          {tok.slice(1, -1)}
        </Text>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** A deliberately small Markdown renderer: fences, headings, bullets, inline styles. */
export const Markdown = memo(function Markdown({ text, palette: p }: { text: string; palette: Palette }) {
  const blocks: ReactNode[] = [];
  const lines = text.split('\n');
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trimStart().startsWith('```')) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trimStart().startsWith('```')) code.push(lines[i++]!);
      i++;
      blocks.push(
        <View key={k++} style={[styles.codeBlock, { backgroundColor: p.code, borderColor: p.border }]}>
          <Text selectable style={[styles.codeText, { color: p.text }]}>
            {code.join('\n')}
          </Text>
        </View>,
      );
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push(
        <Text key={k++} style={[styles.heading, { color: p.text }]}>
          {inline(heading[2]!, p, `h${k}`)}
        </Text>,
      );
      i++;
      continue;
    }
    const bullet = /^(\s*)([-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      const marker = /\d/.test(bullet[2]!) ? bullet[2]! : '•';
      blocks.push(
        <View key={k++} style={[styles.bulletRow, { paddingLeft: Math.min(bullet[1]!.length, 6) * 4 }]}>
          <Text style={[styles.body, { color: p.muted, width: marker.length > 1 ? 22 : 14 }]}>{marker}</Text>
          <Text selectable style={[styles.body, styles.flex, { color: p.text }]}>
            {inline(bullet[3]!, p, `b${k}`)}
          </Text>
        </View>,
      );
      i++;
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [line];
    i++;
    while (i < lines.length && lines[i]!.trim() && !/^(\s*([-*•]|\d+[.)])\s|#{1,4}\s|\s*```)/.test(lines[i]!)) para.push(lines[i++]!);
    blocks.push(
      <Text key={k++} selectable style={[styles.body, { color: p.text }]}>
        {inline(para.join('\n'), p, `p${k}`)}
      </Text>,
    );
  }
  return <View style={styles.container}>{blocks}</View>;
});

const styles = StyleSheet.create({
  container: { gap: 6 },
  body: { fontSize: 15, lineHeight: 21 },
  flex: { flex: 1 },
  bold: { fontWeight: '700' },
  italic: { fontStyle: 'italic' },
  heading: { fontSize: 16, fontWeight: '700', marginTop: 2 },
  bulletRow: { flexDirection: 'row' },
  inlineCode: { fontFamily: monoFamily, fontSize: 13 },
  codeBlock: { borderRadius: 8, padding: 10, borderWidth: StyleSheet.hairlineWidth },
  codeText: { fontFamily: monoFamily, fontSize: 12, lineHeight: 17 },
});
